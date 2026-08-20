/**
 * ro-05-onboard-cli-verb-existing-collection (epic: mnemosyne-repo-onboarding).
 *
 * A thin `execFile` wrapper around the existing, UNMODIFIED
 * `mnemosyne.placement_engine.classify_collection(name)` (mnemosyne/
 * placement_engine.py, shipped by the `qdrant-placement-rules` story) --
 * mirrors `VectorLayerAdapter`'s already-proven shell-out-to-CLI discipline
 * (VectorLayerAdapter.ts: never import the sibling implementation as a
 * library, treat its command-line surface as the stable contract) applied
 * here across the Python/TypeScript process boundary instead of to another
 * Node CLI. This module never re-implements `classify_collection`'s own
 * naming heuristic in TypeScript -- the Python module is the single source
 * of truth, called fresh on every invocation.
 *
 * The `python3 -c <script>` invocation shape mirrors the one already proven
 * in test/onboard-reachability.mjs's own `computeExpectedOrgTreePath`
 * (ro-08) -- this module is that same call shape promoted to a reusable,
 * production `lib/` primitive instead of a test-only helper.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND = process.env.MNEMOSYNE_PYTHON_BIN || 'python3';

/** Mirrors placement_engine.py's own `PlacementResult` dataclass shape exactly. */
export interface ClassifyResult {
  name: string;
  scope: 'project' | 'enterprise';
  org_tree_path: string;
  needs_override: boolean;
  reason: string;
}

/** Raised for a subprocess failure (non-installed python3, a real `PlacementError` from `classify_collection` itself, or unparsable output) -- never silently swallowed. */
export class ClassifyError extends Error {}

export interface ClassifyCollectionOptions {
  /** Executable to shell out to. Defaults to `MNEMOSYNE_PYTHON_BIN` or `python3` on PATH. */
  command?: string;
  /** Timeout for the shell exec, in milliseconds. */
  timeoutMs?: number;
  /**
   * Working directory the `python3 -c` subprocess runs from -- MUST be a
   * directory `mnemosyne.placement_engine` importable from (this repo's own
   * root; `python3 -c` implicitly adds cwd to `sys.path`). Callers outside
   * this repo's own bin/ scripts must pass this explicitly.
   */
  cwd?: string;
}

/**
 * Prints a single JSON line matching `ClassifyResult`'s shape on success
 * (exit 0), or writes `PlacementError`'s message to stderr and exits 1 on a
 * genuinely invalid name (missing/empty) -- never a silent default on the
 * Python side. `classify_collection` itself never raises for any other
 * reason (see placement_engine.py's own module doc comment), so exit 1 here
 * always means an invalid `name`.
 */
const CLASSIFY_SCRIPT = [
  'import json, sys',
  'from mnemosyne.placement_engine import classify_collection, PlacementError',
  'try:',
  '    result = classify_collection(sys.argv[1])',
  'except PlacementError as exc:',
  '    print(str(exc), file=sys.stderr)',
  '    sys.exit(1)',
  'print(json.dumps({',
  '    "name": result.name,',
  '    "scope": result.scope,',
  '    "org_tree_path": result.org_tree_path,',
  '    "needs_override": result.needs_override,',
  '    "reason": result.reason,',
  '}))',
].join('\n');

/**
 * Shells out to `python3 -c` to run the real, unmodified
 * `classify_collection(name)` and returns its result. Throws `ClassifyError`
 * on any subprocess failure (python3 missing, a real `PlacementError` for an
 * invalid `name`, or output that doesn't parse as the expected JSON shape)
 * -- callers never receive a guessed/default classification silently.
 */
export async function classifyCollection(
  name: string,
  options: ClassifyCollectionOptions = {},
): Promise<ClassifyResult> {
  const command = options.command ?? DEFAULT_COMMAND;
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let stdout: string;
  try {
    const result = await execFileAsync(command, ['-c', CLASSIFY_SCRIPT, name], {
      timeout,
      cwd: options.cwd,
    });
    stdout = result.stdout;
  } catch (error) {
    const err = error as { code?: unknown; stderr?: string; message?: string };
    if (err?.code === 'ENOENT') {
      throw new ClassifyError(`${command} is not installed or not on PATH -- required to classify collection '${name}'`);
    }
    const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : '';
    const detail = stderr || (typeof err?.message === 'string' ? err.message : String(error));
    throw new ClassifyError(`classify_collection('${name}') failed: ${detail}`);
  }

  try {
    return JSON.parse(stdout) as ClassifyResult;
  } catch {
    throw new ClassifyError(
      `classify_collection('${name}') returned output that could not be parsed as JSON: ${stdout.slice(0, 200)}`,
    );
  }
}
