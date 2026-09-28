// reindex-jobs.mjs — observable, deduplicated bulk-reindex jobs (PANT-837).
//
// POST /reindex and POST /events/repo-merged both start a job here instead of
// firing reindex() and forgetting it. A job is keyed by scope: while a scope
// has a running job, a second start for that scope returns the existing job
// (dedup) instead of overlapping two runs over the same collection.
//
// Jobs live in memory only (the last `maxJobs`, running jobs never evicted);
// a restart forgets them, which is fine for this story — callers poll
// GET /reindex/:job_id shortly after starting a run.
//
// Also owns the two pieces of reindex policy the routes enforce:
//   - allowed roots (MNEMOSYNE_REINDEX_ROOTS): `directory` must resolve, after
//     symlinks, to a configured root or somewhere under one -> else 403.
//   - repo -> scope map (MNEMOSYNE_REPO_SCOPES) for the repo-merged event.
//
// Missing collection policy: a job NEVER creates a Qdrant collection. Before
// indexing it runs the read-only collectionExists() check and, if the scope's
// collection isn't there, the job fails with an error naming the collection
// and how to create it (`mnemosyne onboard ... --create`). Creating infra
// from an unauthenticated event route is deliberately out of scope.
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_MAX_JOBS = 50;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// --- allowed roots -----------------------------------------------------------

/**
 * Parses MNEMOSYNE_REINDEX_ROOTS (path.delimiter-separated, like PATH) into
 * absolute paths. Unset/empty -> [cwd], so the old default of "reindex the
 * service's own cwd" keeps working and nothing else does.
 */
export function parseReindexRoots(value, cwd = process.cwd()) {
  const roots = String(value || "")
    .split(path.delimiter)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => path.resolve(r));
  return roots.length ? roots : [path.resolve(cwd)];
}

function isWithin(child, root) {
  const rel = path.relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolves `directory` (default: cwd) and returns its real path if it sits
 * inside one of `roots`. Throws 403 when it doesn't — checked both lexically
 * (so a path outside the roots is refused without probing whether it exists)
 * and after realpath (so a symlink inside a root can't point outside it).
 * Throws 400 when an in-root directory doesn't exist.
 */
export async function resolveAllowedDirectory(directory, roots, cwd = process.cwd()) {
  const requested = path.resolve(cwd, directory || cwd);
  const forbidden = () =>
    httpError(403, `directory '${requested}' is outside the allowed reindex roots (MNEMOSYNE_REINDEX_ROOTS)`);
  if (!roots.some((root) => isWithin(requested, root))) throw forbidden();

  let real;
  try {
    real = await realpath(requested);
  } catch {
    throw httpError(400, `directory '${requested}' does not exist`);
  }
  const realRoots = await Promise.all(roots.map((r) => realpath(r).catch(() => null)));
  if (!realRoots.some((root) => root && isWithin(real, root))) throw forbidden();
  return real;
}

// --- repo -> scope map ----------------------------------------------------------

/** "https://github.com/Owner/Repo.git" / "owner/repo" -> "owner/repo". */
export function normalizeRepo(repo) {
  return String(repo || "")
    .trim()
    .replace(/^(https?:\/\/|git@)?github\.com[/:]/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * Parses MNEMOSYNE_REPO_SCOPES, a JSON object of
 *   { "<owner>/<repo>": { "scope": "<scope>", "directory": "<checkout path>" } }
 * into a Map keyed by normalizeRepo(). Throws on malformed config so a bad
 * value fails the service at startup, not silently on the first event.
 */
export function parseRepoScopes(value) {
  const map = new Map();
  if (!value || !String(value).trim()) return map;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (e) {
    throw new Error(`MNEMOSYNE_REPO_SCOPES is not valid JSON: ${e.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MNEMOSYNE_REPO_SCOPES must be a JSON object of repo -> {scope, directory}");
  }
  for (const [repo, entry] of Object.entries(parsed)) {
    if (!entry || typeof entry.scope !== "string" || typeof entry.directory !== "string") {
      throw new Error(`MNEMOSYNE_REPO_SCOPES['${repo}'] needs string 'scope' and 'directory'`);
    }
    map.set(normalizeRepo(repo), { scope: entry.scope, directory: entry.directory });
  }
  return map;
}

// --- job store -----------------------------------------------------------------

/**
 * `reindex(scope, {directory})` is engine.mjs's bulk reindex (injected so
 * tests can stub it). `collectionExists(collection)` is the read-only Qdrant
 * check; pass null to skip it.
 */
export function createReindexJobs({
  reindex,
  collectionExists = null,
  maxJobs = DEFAULT_MAX_JOBS,
  now = () => new Date(),
  newId = randomUUID,
} = {}) {
  const jobs = new Map(); // job_id -> job, insertion (= start) order
  const runningByScope = new Map(); // scope -> job_id

  function view(job) {
    const { done, ...rest } = job;
    return { ...rest, errors: [...rest.errors] };
  }

  function prune() {
    for (const [id, job] of jobs) {
      if (jobs.size <= maxJobs) break;
      if (job.status !== "running") jobs.delete(id);
    }
  }

  async function execute(job) {
    try {
      if (collectionExists && !(await collectionExists(job.collection))) {
        throw new Error(
          `collection '${job.collection}' for scope '${job.scope}' does not exist in Qdrant; ` +
            `reindex never creates collections -- create it first ` +
            `(mnemosyne onboard <path> --collection ${job.collection} --create)`
        );
      }
      const result = await reindex(job.scope, { directory: job.directory });
      job.files_scanned = result.files_scanned;
      job.files_indexed = result.files_indexed;
      job.errors = result.errors || [];
      job.status = "succeeded";
      console.log(
        `[mnemosyne] reindex job ${job.job_id} succeeded scope=${job.scope} files_indexed=${job.files_indexed}/${job.files_scanned} errors=${job.errors.length}`
      );
    } catch (e) {
      job.status = "failed";
      job.error = String(e?.message || e);
      console.error(`[mnemosyne] ERROR reindex job ${job.job_id} failed scope=${job.scope}: ${job.error}`);
    } finally {
      job.finished_at = now().toISOString();
      runningByScope.delete(job.scope);
      prune();
    }
  }

  return {
    /**
     * Starts a job for `scope`, or returns the one already running for it.
     * Resolves `{ job, deduplicated, done }`; `done` settles when the job
     * finishes (never rejects — failures land on the job).
     */
    start({ scope, collection, directory, trigger = { type: "api" } }) {
      const runningId = runningByScope.get(scope);
      if (runningId) {
        const existing = jobs.get(runningId);
        return { job: view(existing), deduplicated: true, done: existing.done };
      }
      const job = {
        job_id: newId(),
        scope,
        collection,
        directory,
        trigger,
        status: "running",
        files_scanned: null,
        files_indexed: null,
        errors: [],
        error: null,
        started_at: now().toISOString(),
        finished_at: null,
      };
      jobs.set(job.job_id, job);
      runningByScope.set(scope, job.job_id);
      // Deferred a tick so a synchronously-throwing stub still reports
      // `running` to the caller that started it.
      job.done = Promise.resolve().then(() => execute(job));
      prune();
      return { job: view(job), deduplicated: false, done: job.done };
    },

    get(jobId) {
      const job = jobs.get(jobId);
      return job ? view(job) : null;
    },

    list() {
      return [...jobs.values()].map(view).reverse();
    },
  };
}
