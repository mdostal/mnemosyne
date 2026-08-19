/**
 * ro-01-memory-levels-scoped-extraction (epic: mnemosyne-repo-onboarding) —
 * tests for the extracted, repo-scoped `computeMemoryLevels(client, repoRoot,
 * level0Path?)` function.
 *
 * Written before lib/mnemosyne/memory-levels/computeMemoryLevels.ts exists
 * (TDD per this story's `methodology: tdd`) — every test here is expected to
 * fail until the module is implemented.
 *
 * server.ts's existing GET /memory-levels route computes this against ONE
 * ambient, module-level MnemosyneClient singleton scoped to the running
 * service's own ROOT_DIRECTORY. This function is the standalone,
 * `(client, repoRoot)`-parameterized extraction of that same computation, so
 * it can be called against an ARBITRARY repo — the primitive ro-02's
 * onboarding orchestrator depends on. The real HTTP regression for GET
 * /memory-levels itself lives in test/http-api.mjs (testMemoryLevelsRoute)
 * and is asserted unchanged, not duplicated here.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MnemosyneClient } from '../../client.js';

const MODULE_SOURCE_PATH = fileURLFromHere('../computeMemoryLevels.ts');
const MODULE_IMPORT_SPECIFIER = '../computeMemoryLevels.js';

function fileURLFromHere(relative: string): string {
  return new URL(relative, import.meta.url).pathname;
}

// Only 'file' configured, mirroring test/http-api.mjs's testMemoryLevelsRoute
// fixture exactly — deterministic, no live graphify/Qdrant dependency:
// level 2 (graphify/code-graph) and level 3 (vector/keyword) must resolve
// inactive; level 4 (file) must resolve active.
const FILE_ONLY_LAYER_STACK = { layers: [{ name: 'file' as const }] };

const tempDirs: string[] = [];

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mnemosyne-compute-memory-levels-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('lib/mnemosyne/memory-levels/computeMemoryLevels.ts', () => {
  it('module file exists', () => {
    expect(existsSync(MODULE_SOURCE_PATH)).toBe(true);
  });

  it('reports level 1 differently for two MnemosyneClient instances rooted at different temp directories with different mnemosyne.md presence', async () => {
    const { computeMemoryLevels } = await import(MODULE_IMPORT_SPECIFIER);

    const withoutRepo = await makeTempRepo();
    const withRepo = await makeTempRepo();
    await writeFile(path.join(withRepo, 'mnemosyne.md'), '# managed content\n', 'utf8');

    // level0Path pointed at a definitely-missing file for both clients, so
    // this assertion isolates level 1 (repo-scoped) from level 0
    // (operator-global) — level 0 must read false b'/c the level0-rules.md
    // fixture doesn't exist for either repo.
    const missingLevel0Path = path.join(await makeTempRepo(), 'level0-rules.md');

    const clientWithout = new MnemosyneClient({ rootDirectory: withoutRepo, layerStack: FILE_ONLY_LAYER_STACK });
    const clientWith = new MnemosyneClient({ rootDirectory: withRepo, layerStack: FILE_ONLY_LAYER_STACK });

    const levelsWithout = computeMemoryLevels(clientWithout, withoutRepo, missingLevel0Path);
    const levelsWith = computeMemoryLevels(clientWith, withRepo, missingLevel0Path);

    const l1Without = levelsWithout.find((l: { id: number }) => l.id === 1);
    const l1With = levelsWith.find((l: { id: number }) => l.id === 1);

    expect(l1Without.configured).toBe(false);
    expect(l1With.configured).toBe(true);
  });

  it('returns the same 5-level configured/not-configured shape GET /memory-levels would return, for a client scoped to an arbitrary repoRoot (not the calling process ROOT_DIRECTORY)', async () => {
    const { computeMemoryLevels } = await import(MODULE_IMPORT_SPECIFIER);

    const repoRoot = await makeTempRepo();
    await writeFile(path.join(repoRoot, 'mnemosyne.md'), '# managed content\n', 'utf8');
    const missingLevel0Path = path.join(await makeTempRepo(), 'level0-rules.md');

    const client = new MnemosyneClient({ rootDirectory: repoRoot, layerStack: FILE_ONLY_LAYER_STACK });
    const levels = computeMemoryLevels(client, repoRoot, missingLevel0Path);

    expect(Array.isArray(levels)).toBe(true);
    expect(levels).toHaveLength(5);
    expect(levels.map((l: { id: number }) => l.id)).toEqual([0, 1, 2, 3, 4]);

    for (const entry of levels) {
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('label');
      expect(entry).toHaveProperty('storeType');
      expect(entry).toHaveProperty('configured');
      expect(entry).toHaveProperty('sourceRef');
    }

    const [l0, l1, l2, l3, l4] = levels;
    // level 0 is operator-global (level0Path), unaffected by repoRoot —
    // missingLevel0Path doesn't exist, so configured:false.
    expect(l0.configured).toBe(false);
    expect(l0).not.toHaveProperty('activeInCascade');
    // level 1 resolves against path.join(repoRoot, 'mnemosyne.md'), which
    // this test wrote — configured:true.
    expect(l1.configured).toBe(true);
    expect(l1).not.toHaveProperty('activeInCascade');
    // levels 2-4 read the client's already-resolved cascade only (file-only
    // stack): graphify/code-graph and vector/keyword inactive, file active.
    expect(l2.configured).toBe(false);
    expect(l2.activeInCascade).toBe(false);
    expect(l3.configured).toBe(false);
    expect(l3.activeInCascade).toBe(false);
    expect(l4.configured).toBe(true);
    expect(l4.activeInCascade).toBe(true);
  });

  it('level 0 resolves against the level0Path parameter, not repoRoot, when repoRoot differs from the real machine root', async () => {
    const { computeMemoryLevels } = await import(MODULE_IMPORT_SPECIFIER);

    const repoRoot = await makeTempRepo();
    const level0Dir = await makeTempRepo();
    const level0Path = path.join(level0Dir, 'level0-rules.md');
    await writeFile(level0Path, '# operator-global rules\n', 'utf8');

    const client = new MnemosyneClient({ rootDirectory: repoRoot, layerStack: FILE_ONLY_LAYER_STACK });
    const levels = computeMemoryLevels(client, repoRoot, level0Path);

    const l0 = levels.find((l: { id: number }) => l.id === 0);
    expect(l0.configured).toBe(true);
  });

  it('levels 2-4 read ONLY client.getConfiguredLayers() — never call any layer-resolution logic of its own', async () => {
    const { computeMemoryLevels } = await import(MODULE_IMPORT_SPECIFIER);

    const repoRoot = await makeTempRepo();
    const missingLevel0Path = path.join(await makeTempRepo(), 'level0-rules.md');
    const client = new MnemosyneClient({ rootDirectory: repoRoot, layerStack: FILE_ONLY_LAYER_STACK });

    let callCount = 0;
    const originalGetConfiguredLayers = client.getConfiguredLayers.bind(client);
    client.getConfiguredLayers = () => {
      callCount += 1;
      return originalGetConfiguredLayers();
    };

    computeMemoryLevels(client, repoRoot, missingLevel0Path);

    expect(callCount).toBe(1);
  });
});
