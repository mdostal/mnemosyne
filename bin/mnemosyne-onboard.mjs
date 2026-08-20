#!/usr/bin/env node
// bin/mnemosyne-onboard.mjs — `mnemosyne onboard <path> --collection <name>
// [--create] [--scope-id <id>] [--override project|enterprise]`
// (ro-05-onboard-cli-verb-existing-collection +
// ro-07-onboard-new-collection-full-mode-a, epic: mnemosyne-repo-onboarding).
//
// Mode A's real entry point, covering BOTH sub-paths:
//   - no --create: a repo whose Qdrant collection ALREADY exists
//     (design-discussion.md §2.2, ro-05) -- proves the full Mode A pipeline
//     end-to-end against safe, already-provisioned infra.
//   - --create: a repo whose collection does NOT yet exist at all
//     (ro-07) -- wires ro-06's create_collection_and_scope() ahead of the
//     same sequence, so a genuinely new repo can be onboarded from nothing.
// Sequence, exactly (this file's own doc comment is the single place this
// ordering is spelled out):
//
//   1. Read-only "does <name> already exist in Qdrant?" pre-check
//      (collectionExists() below, reusing mnemosyne/inventory/
//      qdrant_inventory.py's already-proven, already-tested
//      read_qdrant_key/load_qdrant_url/build_qdrant_client/
//      list_collection_names call chain -- no new Qdrant-touching Python
//      code, just an existing safe primitive shelled out to from a new call
//      site).
//        - --create given AND the collection already exists: fails LOUDLY,
//          directing the operator to omit --create -- --create is never a
//          silent no-op over infra that already exists (ro-07 acceptance
//          criterion #4).
//        - --create given AND the collection does not exist: proceeds to
//          step 1b below.
//        - --create NOT given AND the collection does not exist: fails
//          LOUDLY, directing the operator to --create instead of silently
//          proceeding against infra that isn't there (ro-05 acceptance
//          criterion #5).
//   1b. --create only: createCollectionAndScope() below, shelling out to
//      ro-06's real, unmodified `mnemosyne.onboarding.
//      create_collection_and_scope(name, scope=<resolved --scope-id>)` --
//      creates the Qdrant collection and registers the scope->collection
//      mapping `POST /reindex` (step 3's vector-index sub-step) and
//      `VectorLayerAdapter.remember()` both need. A partial-failure result
//      (`ok: false`) fails this run LOUDLY too -- never silently proceeds
//      to onboard against a half-created collection.
//   2. classifyCollection() (lib/mnemosyne/onboarding/classify.ts, ro-05) --
//      shells out to the real, unmodified
//      `mnemosyne.placement_engine.classify_collection(name)`.
//   3. onboardRepo({ mode: 'tree', repoRoot, scopeId, collection })
//      (lib/mnemosyne/onboarding/onboardRepo.ts, ro-02/ro-07) -- Layer 1
//      sync, persona seed, L4/L2 index, REAL vector index (ro-07, once the
//      collection is confirmed to exist per step 1/1b above), base-level
//      report. Byte-identical to calling onboardRepo() directly.
//   4. appendOrgTreeEntry() (lib/mnemosyne/onboarding/orgTree.ts, ro-04) --
//      the classification result (or the operator's --override, when
//      given) written to ~/.mnemosyne/org-tree.yaml.
//   5. Print the base-level report + the org-tree entry that was written.
//
// --override project|enterprise (design-discussion.md §2.2, references
// placement-rules.md's own override process): when `classifyCollection()`
// reports `needs_override: true` (an ambiguous or unmarked collection
// name), the operator can supply --override to set the scope explicitly
// instead of accepting the heuristic's own enterprise-scoped default.
// --override, when given, ALWAYS takes precedence over the heuristic's own
// scope (whether or not that heuristic run itself reported
// needs_override) -- an explicit operator instruction is never
// second-guessed. Absent --override, an ambiguous/unmarked name still gets
// an org-tree entry (needs_override: true, recorded AND printed clearly) --
// never silently defaulted without a visible flag (acceptance criterion #3).
//
// --collection is REQUIRED, with no auto-derivation from the repo path or
// its git remote (design_decisions: open question #2 in
// design-discussion.md -- explicit and unambiguous is the safe starting
// point; naming-convention auto-derivation is deferred pending real
// operator usage).
//
// Because this file imports lib/mnemosyne/onboarding/onboardRepo.ts +
// orgTree.ts + classify.ts directly (.ts modules), it is tsx-launched, not
// plain node -- matching bin/mnemosyne-persona.mjs's and
// bin/mnemosyne-agent.mjs's own identical situation (see bin/mnemosyne's own
// dispatch comment): noEmit:true means there is no build step to import a
// .ts module any other way.

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { onboardRepo } from "../lib/mnemosyne/onboarding/onboardRepo.ts";
import { appendOrgTreeEntry } from "../lib/mnemosyne/onboarding/orgTree.ts";
import { classifyCollection } from "../lib/mnemosyne/onboarding/classify.ts";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

const PYTHON_BIN = process.env.MNEMOSYNE_PYTHON_BIN || "python3";
const KNOWN_SCOPES = ["project", "enterprise"];

// --- collection-existence pre-check (acceptance criterion #5) --------------
//
// Reuses mnemosyne/inventory/qdrant_inventory.py's own read-only
// read_qdrant_key -> load_qdrant_url -> build_qdrant_client ->
// list_collection_names chain verbatim -- no new Qdrant-touching Python
// code (see this file's own header comment / the story's risk mitigation).
// A `QdrantInventoryError` (bad/missing credentials, unreachable Qdrant,
// etc.) is surfaced loudly, never treated as "collection doesn't exist".
const COLLECTION_EXISTS_SCRIPT = [
  "import json, sys",
  "from mnemosyne.inventory.qdrant_inventory import (",
  "    QdrantInventoryError,",
  "    build_qdrant_client,",
  "    list_collection_names,",
  "    load_qdrant_url,",
  "    read_qdrant_key,",
  ")",
  "name = sys.argv[1]",
  "try:",
  "    key = read_qdrant_key()",
  "    url = load_qdrant_url()",
  "    client = build_qdrant_client(url, key)",
  "    names = list_collection_names(client)",
  "except QdrantInventoryError as exc:",
  "    print(str(exc), file=sys.stderr)",
  "    sys.exit(1)",
  'print(json.dumps({"exists": name in names}))',
].join("\n");

/**
 * True if `name` is a real, currently-existing Qdrant collection, per a
 * real read-only inventory read (never a live *write*, and never a guess).
 * `exec`/`command`/`cwd` are injectable purely for testability (mirrors
 * bin/mnemosyne-agent.mjs's own `{ exec }` injection convention) -- tests
 * point `cwd`'s python subprocess at a fake local HTTP "Qdrant" (via
 * HOME-relative `~/.config/swarm-memory/{qdrant.key,config.toml}` fixtures),
 * never at live Qdrant Cloud.
 */
export async function collectionExists(name, { exec = execFileAsync, command = PYTHON_BIN, cwd = REPO_ROOT } = {}) {
  let stdout;
  try {
    const result = await exec(command, ["-c", COLLECTION_EXISTS_SCRIPT, name], { cwd });
    stdout = result.stdout;
  } catch (e) {
    const detail = (e && e.stderr && String(e.stderr).trim()) || (e && e.message) || String(e);
    throw new Error(`could not check whether collection '${name}' already exists in Qdrant: ${detail}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      `Qdrant collection-existence check returned output that could not be parsed as JSON: ${stdout.slice(0, 200)}`,
    );
  }
  return parsed.exists === true;
}

// --- --create's collection-creation + scope-mapping call (ro-07) -----------
//
// Shells out to ro-06's real, unmodified `mnemosyne.onboarding.
// create_collection_and_scope(name, scope, client=...)` -- reused exactly,
// never reimplemented. `client` is the same real `HttpQdrantClient` (or the
// `qdrant_client` package, when installed) `collectionExists()` above
// already builds via `build_qdrant_client(load_qdrant_url(),
// read_qdrant_key())` -- one credential-resolution path, shared by both
// read-only and additive-only call sites.
const CREATE_COLLECTION_SCRIPT = [
  "import json, sys",
  "from mnemosyne.inventory.qdrant_inventory import (",
  "    QdrantInventoryError,",
  "    build_qdrant_client,",
  "    load_qdrant_url,",
  "    read_qdrant_key,",
  ")",
  "from mnemosyne.onboarding import create_collection_and_scope",
  "name = sys.argv[1]",
  "scope = sys.argv[2]",
  "try:",
  "    key = read_qdrant_key()",
  "    url = load_qdrant_url()",
  "    client = build_qdrant_client(url, key)",
  "except QdrantInventoryError as exc:",
  "    print(str(exc), file=sys.stderr)",
  "    sys.exit(1)",
  "result = create_collection_and_scope(name, scope, client=client)",
  "print(json.dumps({",
  "    'name': result.name,",
  "    'scope': result.scope,",
  "    'collection_created': result.collection_created,",
  "    'scope_mapped': result.scope_mapped,",
  "    'ok': result.ok,",
  "    'detail': result.detail,",
  "}))",
].join("\n");

/**
 * Creates Qdrant collection `name` and registers `scope -> name` in
 * swarm-memory's real `config.toml` `[scopes]` table -- ro-06's
 * `create_collection_and_scope()`, called for real (never re-implemented in
 * JS). Additive-only, same as the primitive it calls: no delete/drop code
 * path exists anywhere upstream of this call either.
 *
 * `exec`/`command`/`cwd` are injectable purely for testability, mirroring
 * `collectionExists()`'s own identical convention above -- tests point
 * `cwd`'s python subprocess at a fake local HTTP "Qdrant" + a throwaway
 * `config.toml`, never at live Qdrant Cloud.
 */
export async function createCollectionAndScope(
  name,
  scope,
  { exec = execFileAsync, command = PYTHON_BIN, cwd = REPO_ROOT } = {},
) {
  let stdout;
  try {
    const result = await exec(command, ["-c", CREATE_COLLECTION_SCRIPT, name, scope], { cwd });
    stdout = result.stdout;
  } catch (e) {
    const detail = (e && e.stderr && String(e.stderr).trim()) || (e && e.message) || String(e);
    throw new Error(`could not create collection '${name}' / scope '${scope}': ${detail}`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(
      `collection-creation script returned output that could not be parsed as JSON: ${stdout.slice(0, 200)}`,
    );
  }
}

// --- --override's org_tree_path derivation ----------------------------------
//
// `placement_engine.py`'s own `_org_tree_path(scope, name, marker)` builds
// `f"org/{scope}/{identifier}"` where `identifier` is derived purely from
// `name`/`marker` -- NEVER from `scope` (confirmed by reading its source,
// mnemosyne/placement_engine.py). So overriding the scope of an already-
// classified collection can safely swap just the `org/<scope>/` segment of
// the heuristic's own `org_tree_path`, keeping the identifier suffix
// byte-identical to what `_org_tree_path` itself would compute for the
// override scope -- without re-implementing that identifier-extraction
// logic (marker matching / stripping) a second time in TypeScript, which
// would risk drifting from the real Python heuristic (this module's own
// governing principle -- see classify.ts's doc comment).
export function orgTreePathForOverride(defaultOrgTreePath, overrideScope) {
  const parts = defaultOrgTreePath.split("/");
  const identifier = parts.slice(2).join("/");
  return `org/${overrideScope}/${identifier}`;
}

// --- CLI arg parsing ---------------------------------------------------------

export function parseArgs(argv) {
  const args = { path: null, collection: null, scopeId: null, override: null, create: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--collection") args.collection = argv[++i];
    else if (argv[i] === "--scope-id") args.scopeId = argv[++i];
    else if (argv[i] === "--override") args.override = argv[++i];
    else if (argv[i] === "--create") args.create = true;
    else positional.push(argv[i]);
  }
  args.path = positional[0] ?? null;
  return args;
}

/** `<repoRoot>`'s own basename -- mirrors bin/mnemosyne-agent.mjs's identical `defaultScopeId` convention. */
function defaultScopeId(repoRoot) {
  return path.basename(repoRoot);
}

/** ml-04/ro-01's canonical 5-level base-level report -- byte-identical print shape to bin/mnemosyne-agent.mjs's own `printBaseLevelReport`. */
function printBaseLevelReport(result, log) {
  log("");
  log("base-level report:");
  for (const level of result.baseLevel) {
    log(`  [${level.id}] ${level.label}: ${level.configured ? "configured" : "NOT configured"}`);
  }
}

// --- `mnemosyne onboard` ------------------------------------------------------

export async function runOnboard(argv, { log = console.log } = {}) {
  const { path: repoPath, collection, scopeId, override, create } = parseArgs(argv);

  if (!repoPath) {
    throw new Error(
      "usage: mnemosyne onboard <path> --collection <name> [--create] [--scope-id <id>] " +
        "[--override project|enterprise]",
    );
  }
  if (!collection) {
    throw new Error(
      "--collection is required (e.g. mnemosyne onboard <path> --collection <name>) -- no auto-derivation " +
        "from the repo path or its git remote (design-discussion.md open question #2)",
    );
  }
  if (override !== null && !KNOWN_SCOPES.includes(override)) {
    throw new Error(`invalid --override '${override}' -- must be one of: ${KNOWN_SCOPES.join(", ")}`);
  }

  const repoRoot = path.resolve(repoPath);
  const resolvedScopeId = scopeId || defaultScopeId(repoRoot);

  // 1. Real, read-only "does this collection actually exist?" pre-check --
  // ro-05 acceptance criterion #5. Fails loudly, never proceeds against
  // infra that isn't there.
  log(`mnemosyne onboard: checking collection '${collection}' exists in Qdrant...`);
  const exists = await collectionExists(collection);

  if (create) {
    // ro-07 acceptance criterion #4: --create is never a silent no-op over
    // a collection that already exists -- fail loudly, direct the operator
    // to the existing-collection path (--create omitted) instead.
    if (exists) {
      throw new Error(
        `--create was given but collection '${collection}' already exists in Qdrant -- --create only creates ` +
          `a genuinely NEW collection and is never a silent no-op over one that already exists. Omit --create ` +
          `to onboard against the existing collection instead.`,
      );
    }
    // 1b. Create the collection + register its scope mapping (ro-06's
    // create_collection_and_scope(), via ro-07's new call site). scope is
    // this run's own resolvedScopeId -- the per-repo scope key POST
    // /reindex's later vector-index sub-step (onboardRepo.ts) reuses too
    // (design-discussion.md's "own scope" isolation).
    log(`mnemosyne onboard: --create -- creating collection '${collection}' (scope '${resolvedScopeId}')...`);
    const creation = await createCollectionAndScope(collection, resolvedScopeId);
    if (!creation.ok) {
      throw new Error(`--create failed: ${creation.detail}`);
    }
    log(`mnemosyne onboard: ${creation.detail}`);
  } else if (!exists) {
    throw new Error(
      `collection '${collection}' does not exist in Qdrant -- 'mnemosyne onboard' only onboards an ALREADY-` +
        `EXISTING collection. Pass --create to create '${collection}' as a brand-new collection instead.`,
    );
  }

  // 2. Classify -- the real, unmodified placement_engine.classify_collection().
  log(`mnemosyne onboard: classifying collection '${collection}'...`);
  const classification = await classifyCollection(collection, { cwd: REPO_ROOT });

  let scope = classification.scope;
  let orgTreePath = classification.org_tree_path;
  let needsOverride = classification.needs_override;

  if (needsOverride && !override) {
    // Acceptance criterion #3: never silently defaulted -- printed clearly,
    // the run still completes with needs_override: true recorded.
    log("");
    log(
      `needs_override: true -- collection '${collection}' has no clear scope hint (${classification.reason}). ` +
        `Defaulting to scope '${scope}' pending operator review; re-run with --override project|enterprise to set it explicitly.`,
    );
  }

  if (override) {
    // Acceptance criterion #4: --override takes precedence over the
    // heuristic's own default, unambiguously, in both the org-tree entry
    // and this printed line.
    scope = override;
    orgTreePath = orgTreePathForOverride(classification.org_tree_path, override);
    needsOverride = false;
    log("");
    log(
      `--override ${override}: org-tree entry uses scope '${override}' (operator override) and org_tree_path ` +
        `'${orgTreePath}' -- not placement_engine's own heuristic default ('${classification.org_tree_path}').`,
    );
  }

  // 3. onboardRepo() -- Layer 1 sync, persona seed, L4/L2 index, base-level report.
  log(`mnemosyne onboard: onboarding ${repoRoot} (scopeId: ${resolvedScopeId}, collection: ${collection})...`);
  const result = await onboardRepo({ mode: "tree", repoRoot, scopeId: resolvedScopeId, collection });

  // 4. Org-tree registry entry.
  const entry = {
    repo_path: repoRoot,
    collection,
    scope,
    org_tree_path: orgTreePath,
    needs_override: needsOverride,
    onboarded_at: new Date().toISOString(),
  };
  appendOrgTreeEntry(entry);

  // 5. Report.
  printBaseLevelReport(result, log);
  log("");
  log(
    `org-tree entry written: repo_path=${entry.repo_path} collection=${entry.collection} scope=${entry.scope} ` +
      `org_tree_path=${entry.org_tree_path} needs_override=${entry.needs_override}`,
  );

  return { result, entry };
}

async function main() {
  try {
    await runOnboard(process.argv.slice(2));
    process.exit(0);
  } catch (e) {
    console.error(`mnemosyne-onboard: ${e.message || e}`);
    process.exit(1);
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main();
}
