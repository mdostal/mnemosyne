import test from "node:test";
import assert from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, "..", "bin", "mnemosyne-reconcile");

test("reconcile helper", async (t) => {
  let tempDir;
  let mockBinPath;
  
  t.beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "mnemosyne-test-"));
    mockBinPath = path.join(tempDir, "mock-swarm-memory.sh");
    // Default mock: always returns empty hits (not found)
    await writeFile(mockBinPath, `#!/bin/bash\necho '[{"hits":[]}]'\n`);
    await chmod(mockBinPath, 0o755);
  });

  t.afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const runReconcile = async (args = []) => {
    try {
      const { stdout, stderr } = await execFileP(BIN, args, {
        env: { ...process.env, MNEMOSYNE_NOTES_DIR: tempDir, SWARM_MEMORY_BIN: mockBinPath }
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      return { code: err.code || err.status || 1, stdout: err.stdout, stderr: err.stderr };
    }
  };

  await t.test("handles empty notes directory gracefully", async () => {
    const res = await runReconcile();
    assert.strictEqual(res.code, 0);
    assert.match(res.stdout, /OK: all files synced/);
  });

  await t.test("N drift -> exit 1, DRIFT message", async () => {
    await writeFile(path.join(tempDir, "2026-08-01T00-00-00-Z-note.md"), "test");
    const res = await runReconcile();
    assert.strictEqual(res.code, 1);
    assert.match(res.stdout, /DRIFT: 1 files missing from Qdrant/);
    assert.match(res.stdout, /2026-08-01T00-00-00-Z-note.md/);
  });

  await t.test("0 drift with files -> exit 0", async () => {
    const filename = "2026-08-01T00-00-00-Z-note.md";
    await writeFile(path.join(tempDir, filename), "test");
    // Mock swarm-memory to return a hit for this file
    const mockJson = JSON.stringify([{ hits: [{ provenance: { source: filename } }] }]);
    await writeFile(mockBinPath, `#!/bin/bash\necho '${mockJson}'\n`);
    const res = await runReconcile();
    assert.strictEqual(res.code, 0);
    assert.match(res.stdout, /OK: all files synced/);
  });

  await t.test("--json flag -> structured output", async () => {
    const filename = "2026-08-01T00-00-00-Z-note.md";
    await writeFile(path.join(tempDir, filename), "test");
    const res = await runReconcile(["--json"]);
    assert.strictEqual(res.code, 1);
    const parsed = JSON.parse(res.stdout);
    assert.strictEqual(parsed.drift_count, 1);
    assert.strictEqual(parsed.missing_files.length, 1);
    assert.strictEqual(parsed.missing_files[0], path.join(tempDir, filename));
  });

  await t.test("--limit flag -> restricts number of processed files", async () => {
    await writeFile(path.join(tempDir, "2026-08-01T00-00-00-Z-1.md"), "test");
    await writeFile(path.join(tempDir, "2026-08-01T00-00-00-Z-2.md"), "test");
    await writeFile(path.join(tempDir, "2026-08-01T00-00-00-Z-3.md"), "test");
    const res = await runReconcile(["--limit", "2", "--json"]);
    assert.strictEqual(res.code, 1);
    const parsed = JSON.parse(res.stdout);
    assert.strictEqual(parsed.drift_count, 2);
    assert.strictEqual(parsed.missing_files.length, 2);
  });
});
