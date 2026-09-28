// collection-exists.mjs — read-only "does this Qdrant collection exist?"
// check, shared by bin/mnemosyne-onboard.mjs (ro-05) and src/server.mjs's
// reindex jobs (PANT-837). Plain Node (no tsx) so the service can import it.
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const PYTHON_BIN = process.env.MNEMOSYNE_PYTHON_BIN || "python3";

// Reuses mnemosyne/inventory/qdrant_inventory.py's own read-only
// read_qdrant_key -> load_qdrant_url -> build_qdrant_client ->
// list_collection_names chain verbatim -- no new Qdrant-touching Python
// code (see bin/mnemosyne-onboard.mjs's header comment / ro-05's risk mitigation).
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
