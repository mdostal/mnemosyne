/**
 * ro-02-onboard-repo-core-orchestrator (epic: mnemosyne-repo-onboarding) —
 * tests for the shared `onboardRepo()` orchestrator.
 *
 * Written before lib/mnemosyne/onboarding/onboardRepo.ts exists (TDD per
 * this story's `methodology: tdd`) — every test here is expected to fail
 * until the module is implemented.
 *
 * Isolation convention (mirrors test/agent-cli.mjs's mkdtemp-per-test-block
 * approach): every temp repo lives under a fresh `mkdtemp()` directory, and
 * every scenario that depends on Level 0 (`~/.mnemosyne/level0-rules.md`)
 * points `$HOME` at a fresh, throwaway `mkdtemp()` directory too — never
 * this operator's real $HOME or repo state. Because `DEFAULT_LEVEL0_PATH`
 * (lib/mnemosyne/layer1/level0.ts) is a MODULE-LEVEL constant computed once
 * from `homedir()` at import time, each test that needs a specific Level-0
 * presence/absence stubs `$HOME` via `vi.stubEnv` and THEN resets the
 * module registry (`vi.resetModules()`) before dynamically importing
 * onboardRepo.ts (and any sibling module whose own constants are similarly
 * HOME-anchored) — so the constant is recomputed against the fresh, fake
 * HOME rather than whatever HOME happened to be set when some earlier test
 * file's import ran first.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const MODULE_SOURCE_PATH = fileURLFromHere('./onboardRepo.ts');
const MODULE_IMPORT_SPECIFIER = '../onboarding/onboardRepo.js';
const CLIENT_IMPORT_SPECIFIER = '../client.js';
const COMPUTE_MEMORY_LEVELS_IMPORT_SPECIFIER = '../memory-levels/computeMemoryLevels.js';
const PERSONA_IMPORT_SPECIFIER = '../layer1/persona.js';
const PERSONA_STORE_IMPORT_SPECIFIER = '../layer1/persona-store-repo-local.js';
const VECTOR_LAYER_IMPORT_SPECIFIER = '../layers/VectorLayerAdapter.js';

function fileURLFromHere(relative: string): string {
  return new URL(relative, import.meta.url).pathname;
}

const LEVEL0_FIXTURE_CONTENT = '# Level 0 operator rules (test fixture)\n\nAlways be kind.\n';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A fresh, throwaway repo root -- never this repo's own working tree. */
async function makeTempRepo(): Promise<string> {
  return makeTempDir('mnemosyne-onboard-repo-');
}

/** A fresh, throwaway $HOME, optionally pre-seeded with a Level 0 rules fixture. */
async function makeFakeHome(withLevel0: boolean): Promise<string> {
  const home = await makeTempDir('mnemosyne-onboard-home-');
  if (withLevel0) {
    await mkdir(path.join(home, '.mnemosyne'), { recursive: true });
    await writeFile(path.join(home, '.mnemosyne', 'level0-rules.md'), LEVEL0_FIXTURE_CONTENT, 'utf8');
  }
  return home;
}

/**
 * Stubs $HOME, resets the module registry, and dynamically (re-)imports
 * onboardRepo.ts plus the sibling modules tests cross-check it against --
 * all inside the SAME fresh module graph, so every HOME-anchored constant
 * (DEFAULT_LEVEL0_PATH) agrees between onboardRepo's own internals and
 * whatever a test constructs directly for comparison.
 */
async function loadFreshModules(home: string) {
  vi.stubEnv('HOME', home);
  vi.resetModules();
  const [onboardMod, clientMod, computeMod, personaMod, personaStoreMod, vectorMod] = await Promise.all([
    import(MODULE_IMPORT_SPECIFIER),
    import(CLIENT_IMPORT_SPECIFIER),
    import(COMPUTE_MEMORY_LEVELS_IMPORT_SPECIFIER),
    import(PERSONA_IMPORT_SPECIFIER),
    import(PERSONA_STORE_IMPORT_SPECIFIER),
    import(VECTOR_LAYER_IMPORT_SPECIFIER),
  ]);
  return {
    onboardRepo: onboardMod.onboardRepo as (options: unknown) => Promise<any>,
    resolveScopedLayerStack: onboardMod.resolveScopedLayerStack as (repoRoot: string) => {
      layers: { name: string; options?: Record<string, unknown> }[];
    },
    MnemosyneClient: clientMod.MnemosyneClient,
    computeMemoryLevels: computeMod.computeMemoryLevels,
    assertValidPersona: personaMod.assertValidPersona,
    repoLocalPersonaPath: personaStoreMod.repoLocalPersonaPath,
    VectorLayerAdapter: vectorMod.VectorLayerAdapter,
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('lib/mnemosyne/onboarding/onboardRepo.ts', () => {
  it('module file exists', () => {
    expect(existsSync(MODULE_SOURCE_PATH)).toBe(true);
  });

  it('a fresh repo, mode standalone: CLAUDE.md/AGENTS.md/GEMINI.md are created with the managed block (Level 0 + tier content + la-07 mandate)', async () => {
    const home = await makeFakeHome(true);
    const { onboardRepo } = await loadFreshModules(home);
    const repoRoot = await makeTempRepo();

    const result = await onboardRepo({ mode: 'standalone', repoRoot, scopeId: 'test-scope', skipGraph: true });

    expect(result.layer1Synced).toHaveLength(3);
    for (const fileName of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
      const filePath = path.join(repoRoot, fileName);
      expect(existsSync(filePath)).toBe(true);
      const content = await readFile(filePath, 'utf8');
      expect(content).toContain('<!-- mnemosyne:layer1:begin');
      expect(content).toContain('<!-- mnemosyne:layer1:end -->');
      // Level 0 fixture content, verbatim.
      expect(content).toContain('Always be kind.');
      // la-07 memory-lifecycle mandate section, spliced in by syncAllHarnesses.
      expect(content).toContain('Memory-lifecycle mandate');
    }
  });

  it('a fresh repo: <repoRoot>/.mnemosyne/personas/<scopeId>.yaml exists and passes assertValidPersona', async () => {
    const home = await makeFakeHome(true);
    const { onboardRepo, assertValidPersona, repoLocalPersonaPath } = await loadFreshModules(home);
    const repoRoot = await makeTempRepo();

    const result = await onboardRepo({ mode: 'standalone', repoRoot, scopeId: 'test-scope', skipGraph: true });

    const personaPath = repoLocalPersonaPath(repoRoot, 'test-scope');
    expect(result.personaSeeded.created).toBe(true);
    expect(result.personaSeeded.path).toBe(personaPath);
    expect(existsSync(personaPath)).toBe(true);

    const { parse } = await import('yaml');
    const raw = await readFile(personaPath, 'utf8');
    const parsed = parse(raw);
    expect(() => assertValidPersona(parsed, 'code-architect')).not.toThrow();
  });

  it('a fresh repo: <repoRoot>/.mnemosyne/file-index.json exists with a non-empty files list', async () => {
    const home = await makeFakeHome(true);
    const { onboardRepo } = await loadFreshModules(home);
    const repoRoot = await makeTempRepo();
    // Give the file layer something real to index.
    await writeFile(path.join(repoRoot, 'README.md'), '# hello\n', 'utf8');

    const result = await onboardRepo({ mode: 'standalone', repoRoot, scopeId: 'test-scope', skipGraph: true });

    const manifestPath = path.join(repoRoot, '.mnemosyne', 'file-index.json');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(Array.isArray(manifest.files)).toBe(true);
    expect(manifest.files.length).toBeGreaterThan(0);
    expect(result.fileIndex.files).toBe(manifest.files.length);
    expect(result.fileIndex.areas).toBe(Object.keys(manifest.areas).length);
  });

  it('a repo with an already-existing persona file: onboardRepo() leaves it byte-unchanged (never overwritten)', async () => {
    const home = await makeFakeHome(true);
    const { onboardRepo, repoLocalPersonaPath } = await loadFreshModules(home);
    const repoRoot = await makeTempRepo();

    const personaPath = repoLocalPersonaPath(repoRoot, 'test-scope');
    await mkdir(path.dirname(personaPath), { recursive: true });
    const sentinelContent = 'tier: code-architect\nscopeId: test-scope\ndisplayName: Operator-authored\nscope: hand-written, never touch\nsections: []\n';
    await writeFile(personaPath, sentinelContent, 'utf8');

    const result = await onboardRepo({ mode: 'standalone', repoRoot, scopeId: 'test-scope', skipGraph: true });

    expect(result.personaSeeded.created).toBe(false);
    const afterContent = await readFile(personaPath, 'utf8');
    expect(afterContent).toBe(sentinelContent);
  });

  it('Level 0 missing: throws the same loud error readLevel0Content throws -- never a partial onboarding', async () => {
    const home = await makeFakeHome(false);
    const { onboardRepo } = await loadFreshModules(home);
    const repoRoot = await makeTempRepo();

    await expect(onboardRepo({ mode: 'standalone', repoRoot, scopeId: 'test-scope' })).rejects.toThrow(
      /Level 0 operator rules not found/,
    );

    // Never a partial onboarding: no harness files, no persona, no index.
    expect(existsSync(path.join(repoRoot, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(path.join(repoRoot, '.mnemosyne'))).toBe(false);
  });

  it('graphify NOT on PATH: completes successfully with graphIndex: { ran: false, reason: <matches config.ts soft-fallback reasoning> }, never a hard failure', async () => {
    const home = await makeFakeHome(true);
    vi.stubEnv('GRAPHIFY_BIN', 'definitely-not-a-real-graphify-binary-xyz');
    const { onboardRepo } = await loadFreshModules(home);
    const repoRoot = await makeTempRepo();

    const result = await onboardRepo({ mode: 'standalone', repoRoot, scopeId: 'test-scope' });

    expect(result.graphIndex.ran).toBe(false);
    expect(result.graphIndex.reason).toMatch(/graphify/i);
    expect(result.graphIndex.reason).toMatch(/PATH/);
    expect(result.graphIndex.reason).toMatch(/uv tool install graphifyy/);
  });

  it('skipGraph: true short-circuits the L2 graph build entirely, regardless of graphify availability', async () => {
    const home = await makeFakeHome(true);
    const { onboardRepo } = await loadFreshModules(home);
    const repoRoot = await makeTempRepo();

    const result = await onboardRepo({ mode: 'standalone', repoRoot, scopeId: 'test-scope', skipGraph: true });

    expect(result.graphIndex.ran).toBe(false);
  });

  it("mode 'tree': vectorIndex is the stubbed { ran: false, reason: 'not yet implemented' } (real wiring lands in ro-07)", async () => {
    const home = await makeFakeHome(true);
    const { onboardRepo } = await loadFreshModules(home);
    const repoRoot = await makeTempRepo();

    const result = await onboardRepo({ mode: 'tree', repoRoot, scopeId: 'test-scope', collection: 'some-collection', skipGraph: true });

    expect(result.vectorIndex).toEqual({ ran: false, reason: 'not yet implemented' });
  });

  it("mode 'standalone': vectorIndex sub-step is never attempted", async () => {
    const home = await makeFakeHome(true);
    const { onboardRepo } = await loadFreshModules(home);
    const repoRoot = await makeTempRepo();

    const result = await onboardRepo({ mode: 'standalone', repoRoot, scopeId: 'test-scope', skipGraph: true });

    expect(result.vectorIndex.ran).toBe(false);
  });

  it("baseLevel matches exactly what GET /memory-levels would report for a service rooted at repoRoot (cross-checked against computeMemoryLevels called directly)", async () => {
    const home = await makeFakeHome(true);
    const { onboardRepo, MnemosyneClient, computeMemoryLevels } = await loadFreshModules(home);
    const repoRoot = await makeTempRepo();

    const result = await onboardRepo({ mode: 'standalone', repoRoot, scopeId: 'test-scope', skipGraph: true });

    const directClient = new MnemosyneClient({ rootDirectory: repoRoot });
    const directBaseLevel = computeMemoryLevels(directClient, repoRoot);

    expect(result.baseLevel).toEqual(directBaseLevel);
  });

  it('a layer stack that includes vector for this repoRoot: the constructed vector adapter resolves notesDirectory to <repoRoot>/mnemosyne-notes, not the machine-global default (design-discussion.md §7.1)', async () => {
    const home = await makeFakeHome(true);
    const { onboardRepo, resolveScopedLayerStack, VectorLayerAdapter } = await loadFreshModules(home);
    const repoRoot = await makeTempRepo();
    // Explicit layer stack naming vector, with no notesDirectory of its own
    // -- the common case this amendment targets (design-discussion.md §7.1).
    await writeFile(
      path.join(repoRoot, 'mnemosyne.layers.json'),
      JSON.stringify({ layers: [{ name: 'vector' }, { name: 'file' }] }, null, 2),
      'utf8',
    );

    const result = await onboardRepo({ mode: 'standalone', repoRoot, scopeId: 'test-scope', skipGraph: true });

    // Verified by actually constructing the real adapter from the exact
    // options onboardRepo's own scoped-stack resolver produces -- not
    // merely asserted against a plain object -- per this story's explicit
    // AC wording. resolveScopedLayerStack is the exact function onboardRepo
    // itself calls to build the layerStack it passes into its scoped
    // MnemosyneClient (see onboardRepo.ts), so this is the real resolution
    // path, not a re-derivation of it.
    const scopedStack = resolveScopedLayerStack(repoRoot);
    const vectorEntry = scopedStack.layers.find((l) => l.name === 'vector');
    expect(vectorEntry).toBeDefined();
    const adapter = new VectorLayerAdapter(vectorEntry!.options);
    expect((adapter as unknown as { notesDirectory: string }).notesDirectory).toBe(
      path.join(repoRoot, 'mnemosyne-notes'),
    );

    // baseLevel's own client must have been built against this same
    // colocated resolution -- level 3 (vector) reads active in the cascade.
    const l3 = result.baseLevel.find((l: { id: number }) => l.id === 3);
    expect(l3.configured).toBe(true);
  });

  it('a layer stack that does NOT include vector for this repoRoot: no vector-adapter notesDirectory resolution happens at all (zero behavior added)', async () => {
    const home = await makeFakeHome(true);
    const { onboardRepo, resolveScopedLayerStack } = await loadFreshModules(home);
    const repoRoot = await makeTempRepo();
    // Mirrors Mode B's own default docs/embedded-layers.json: vector omitted.
    await writeFile(
      path.join(repoRoot, 'mnemosyne.layers.json'),
      JSON.stringify({ layers: [{ name: 'file' }] }, null, 2),
      'utf8',
    );

    const result = await onboardRepo({ mode: 'standalone', repoRoot, scopeId: 'test-scope', skipGraph: true });

    const scopedStack = resolveScopedLayerStack(repoRoot);
    expect(scopedStack.layers.find((l) => l.name === 'vector')).toBeUndefined();
    // No notesDirectory-bearing options anywhere in the resolved stack --
    // this amendment adds zero behavior for a repo that never configures
    // vector.
    expect(scopedStack.layers.every((l) => !l.options || l.options.notesDirectory === undefined)).toBe(true);

    const l3 = result.baseLevel.find((l: { id: number }) => l.id === 3);
    expect(l3.configured).toBe(false);
  });
});
