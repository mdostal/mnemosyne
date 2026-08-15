/**
 * pf-08-seed-migration-script: tests for bin/mnemosyne-persona-seed.mjs, the
 * one-time export of the hardcoded TIER_CONTENT (tiers.ts:116-189) into
 * pf-06's global persona store.
 *
 * design-discussion.md names the absence of this script "the single
 * highest-blast-radius risk in the epic" -- without it, a cutover to
 * data-driven persona content on an empty global store silently regresses
 * every harness file in every repo to zero Layer 1 content. The critical
 * test in this file (`byte-for-byte equivalence`) is the concrete proof, not
 * a visual/manual check.
 *
 * bin/mnemosyne-persona-seed.mjs imports lib/mnemosyne/layer1/*.ts directly
 * (mirrors bin/mnemosyne-persona.mjs), so -- exactly like
 * sync.integration.test.ts's `runCli` -- it is exercised ONLY via a real
 * subprocess run through tsx, never imported in-process (tsconfig.json's
 * `noEmit: true` means there is no build step to import a .ts module any
 * other way; see bin/mnemosyne-persona-seed.mjs's own doc comment).
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { getPersonaContent } from '../persona.js';
import { globalPersonaPath, readGlobalPersona } from '../persona-store-global.js';
import { renderTierContentMarkdown, TIER_CONTENT } from '../tiers.js';
import { stringify } from 'yaml';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CLI = path.join(REPO_ROOT, 'bin', 'mnemosyne-persona-seed.mjs');

const GLOBAL_TIERS = ['top-orchestrator', 'company-director', 'project-orchestrator'] as const;
const DEFAULT_SEED_SCOPE_ID = 'default';

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the real `mnemosyne-persona-seed.mjs` CLI as a real subprocess (tsx), mirroring sync.integration.test.ts's runCli. */
async function runSeedCli(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [TSX_BIN, CLI, ...args], {
      cwd: REPO_ROOT,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempGlobalRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-persona-seed-'));
  tempRoots.push(root);
  return root;
}

describe('mnemosyne-persona-seed.mjs against an empty global store', () => {
  it('produces exactly 3 files (one per global tier), nothing else', async () => {
    const root = await makeTempGlobalRoot();
    const result = await runSeedCli(['--root', root]);
    expect(result.code, `seed stderr: ${result.stderr}`).toBe(0);

    for (const tier of GLOBAL_TIERS) {
      const filePath = globalPersonaPath(tier, DEFAULT_SEED_SCOPE_ID, root);
      expect(existsSync(filePath), `expected ${filePath} to exist after seeding`).toBe(true);
    }

    // Nothing else -- exactly 3 tier directories, one file in each, and
    // critically NO 'code-architect' directory (acceptance criterion 4: the
    // seed script never touches the repo-local store).
    const tierDirs = (await readdir(root)).sort();
    expect(tierDirs).toEqual([...GLOBAL_TIERS].sort());
    expect(tierDirs).not.toContain('code-architect');

    for (const tier of GLOBAL_TIERS) {
      const files = await readdir(path.join(root, tier));
      expect(files).toEqual([`${DEFAULT_SEED_SCOPE_ID}.yaml`]);
    }
  });

  it('the 3 written personas are valid and carry NO mandateSections key (never author-storable)', async () => {
    const root = await makeTempGlobalRoot();
    await runSeedCli(['--root', root]);

    for (const tier of GLOBAL_TIERS) {
      const persona = readGlobalPersona(tier, DEFAULT_SEED_SCOPE_ID, root);
      expect(persona.tier).toBe(tier);
      expect(persona.scopeId).toBe(DEFAULT_SEED_SCOPE_ID);
      expect(Object.prototype.hasOwnProperty.call(persona, 'mandateSections')).toBe(false);
    }
  });

  /**
   * THE critical acceptance test (pf-08's own risks table): a freshly-seeded
   * environment must produce IDENTICAL rendered output to today's hardcoded
   * TIER_CONTENT path -- not "looks right," a real character-for-character
   * diff. Renders both paths:
   *
   *   (a) TODAY:  renderTierContentMarkdown(TIER_CONTENT[tier])
   *   (b) SEEDED: renderTierContentMarkdown(getPersonaContent(tier, 'default', {globalPersonaRoot: root}))
   *
   * (b) goes through getPersonaContent -- not a raw read of the persona
   * YAML -- specifically because that is what re-injects MANDATE_SECTIONS
   * (personas never store their own mandate; see persona.ts's
   * `reinjectMandateSections`), which is what actually gets synced into a
   * harness file end to end. Comparing raw YAML alone would only prove the
   * data survived a round-trip, not that a synced CLAUDE.md would be
   * unchanged.
   */
  it('byte-for-byte equivalence: seeded + re-hydrated content renders IDENTICAL markdown to the current hardcoded TIER_CONTENT path, for all 3 global tiers', async () => {
    const root = await makeTempGlobalRoot();
    const result = await runSeedCli(['--root', root]);
    expect(result.code, `seed stderr: ${result.stderr}`).toBe(0);

    const proof: Record<string, { today: string; seeded: string; identical: boolean }> = {};

    for (const tier of GLOBAL_TIERS) {
      const today = renderTierContentMarkdown(TIER_CONTENT[tier]);

      const seededContent = getPersonaContent(tier, DEFAULT_SEED_SCOPE_ID, {
        repoRoot: '/does/not/exist',
        globalPersonaRoot: root,
      });
      const seeded = renderTierContentMarkdown(seededContent);

      proof[tier] = { today, seeded, identical: today === seeded };

      // Character-for-character. Not `.toContain`, not a normalized
      // comparison -- true equality of the full rendered string.
      expect(seeded, `tier '${tier}': seeded-and-rehydrated markdown must equal today's hardcoded rendering exactly`).toBe(today);
      expect(seeded.length).toBe(today.length);
    }

    // Attach the actual before/after strings to the test report (not just a
    // boolean) so the equivalence claim is inspectable, not asserted blind.
    // eslint-disable-next-line no-console
    console.log('[pf-08 byte-for-byte proof]', JSON.stringify(Object.fromEntries(
      Object.entries(proof).map(([tier, p]) => [tier, { identical: p.identical, length: p.today.length }]),
    ), null, 2));
  });
});

describe('mnemosyne-persona-seed.mjs re-run is a true no-op', () => {
  it('a second run leaves all 3 files byte-unchanged (content AND mtime), not just "still exists"', async () => {
    const root = await makeTempGlobalRoot();
    const first = await runSeedCli(['--root', root]);
    expect(first.code, `first seed stderr: ${first.stderr}`).toBe(0);

    const filePaths = GLOBAL_TIERS.map((tier) => globalPersonaPath(tier, DEFAULT_SEED_SCOPE_ID, root));
    const beforeContents = await Promise.all(filePaths.map((p) => readFile(p, 'utf8')));
    const beforeStats = await Promise.all(filePaths.map((p) => stat(p)));

    const second = await runSeedCli(['--root', root]);
    expect(second.code, `second seed stderr: ${second.stderr}`).toBe(0);
    // Every tier reported as skipped on the re-run.
    for (const tier of GLOBAL_TIERS) {
      expect(second.stdout).toMatch(new RegExp(`skip.*${tier}`));
    }

    const afterContents = await Promise.all(filePaths.map((p) => readFile(p, 'utf8')));
    const afterStats = await Promise.all(filePaths.map((p) => stat(p)));

    filePaths.forEach((p, i) => {
      expect(afterContents[i], `${p} content must be byte-identical after a no-op re-run`).toBe(beforeContents[i]);
      expect(afterStats[i]!.mtimeMs, `${p} mtime must be unchanged after a no-op re-run (proves it was never re-opened for write)`).toBe(
        beforeStats[i]!.mtimeMs,
      );
    });
  });

  it('never clobbers an operator hand-edit made after the first run', async () => {
    const root = await makeTempGlobalRoot();
    const first = await runSeedCli(['--root', root]);
    expect(first.code, `first seed stderr: ${first.stderr}`).toBe(0);

    // Simulate an operator editing the seeded company-director persona by
    // hand after the first run -- NOT via writeGlobalPersona, a real
    // external edit like persona-store-global.test.ts's own "read-fresh"
    // test.
    const filePath = globalPersonaPath('company-director', DEFAULT_SEED_SCOPE_ID, root);
    const operatorEdited = {
      tier: 'company-director' as const,
      scopeId: DEFAULT_SEED_SCOPE_ID,
      displayName: 'Company Director — OPERATOR EDITED',
      scope: 'An operator-authored replacement scope statement.',
      sections: [{ heading: 'Operator note', body: 'This was hand-edited after the seed script first ran.' }],
    };
    await writeFile(filePath, stringify(operatorEdited), 'utf8');

    const second = await runSeedCli(['--root', root]);
    expect(second.code, `second seed stderr: ${second.stderr}`).toBe(0);

    const afterSecondRun = readGlobalPersona('company-director', DEFAULT_SEED_SCOPE_ID, root);
    expect(afterSecondRun.displayName).toBe('Company Director — OPERATOR EDITED');
    expect(afterSecondRun.scope).toBe('An operator-authored replacement scope statement.');
  });
});

describe('a fresh/never-seeded environment still falls back correctly (pf-02/pf-07 contract) -- proven here, not assumed', () => {
  it('getPersonaContent returns TIER_CONTENT-equivalent content for all 3 global tiers when the seed script has never run', async () => {
    const root = await makeTempGlobalRoot(); // created, but the seed CLI is deliberately never invoked against it
    expect(await readdir(root)).toEqual([]);

    for (const tier of GLOBAL_TIERS) {
      const content = getPersonaContent(tier, DEFAULT_SEED_SCOPE_ID, {
        repoRoot: '/does/not/exist',
        globalPersonaRoot: root,
      });
      expect(renderTierContentMarkdown(content)).toBe(renderTierContentMarkdown(TIER_CONTENT[tier]));
    }
  });

  it('this fallback holds even for a scopeId the seed script would never use', async () => {
    const root = await makeTempGlobalRoot();
    const content = getPersonaContent('top-orchestrator', 'some-other-scope-id-never-seeded', {
      repoRoot: '/does/not/exist',
      globalPersonaRoot: root,
    });
    expect(renderTierContentMarkdown(content)).toBe(renderTierContentMarkdown(TIER_CONTENT['top-orchestrator']));
  });
});

describe('scope boundary: the seed script never writes a repo-local code-architect persona anywhere', () => {
  it('running the seed script does not create a .mnemosyne/personas directory or any code-architect file in the current working directory (REPO_ROOT)', async () => {
    const root = await makeTempGlobalRoot();
    await runSeedCli(['--root', root]);

    // The seed script must only ever touch the global root it's told to use --
    // it must not, as a side effect, write anything under this checkout's
    // own repo-local persona store.
    expect(existsSync(path.join(REPO_ROOT, '.mnemosyne', 'personas'))).toBe(false);
  });
});
