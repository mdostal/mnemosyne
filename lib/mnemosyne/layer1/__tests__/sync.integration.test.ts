/**
 * pf-05-realworld-fixtures-integration-tests: exercises the sync/splice
 * mechanism (block.ts + sync.ts + bin/mnemosyne-persona.mjs) against
 * realistic, marker-free, human-edited files -- not the fully-controlled
 * `writeFile`-in-a-temp-dir fixtures sync.test.ts builds by hand.
 *
 * This is a SEPARATE file from sync.test.ts on purpose (horizontal-plan.md
 * H7.2): sync.test.ts stays a fast, clean-fixture unit suite; this file is
 * the necessarily messier, realistic-fixture integration suite, including
 * real subprocess CLI invocations and real cross-process locking.
 *
 * Fixtures live at fixtures/real-world/ and are NEVER written to directly --
 * every test copies a fixture into a fresh temp dir first (`copyFixtureTo`)
 * and operates on the copy, so the fixtures stay byte-for-byte stable across
 * runs (design_decisions in the story YAML). The last `it` in this file
 * verifies that invariant held for the whole suite.
 */

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { syncHarnessFile } from '../sync.js';
import { BLOCK_END, BLOCK_START } from '../block.js';
import { writeGlobalPersona } from '../persona-store-global.js';
import { TIER_CONTENT, type Tier } from '../tiers.js';
// Pure, side-effect-free CLI helper reused directly rather than
// reimplemented -- see bin/mnemosyne-persona.mjs's own doc comment for why
// the rest of that module (the parts that touch fs/process.exit) is
// exercised only via real subprocesses (`runCli` below), never imported
// in-process: it reads DEFAULT_LEVEL0_PATH from os.homedir() at import
// time, which a same-process HOME override can't retroactively fix.
//
// TS ambient module declarations don't apply to relative (`./`/`../`)
// specifiers -- TS always attempts real file resolution for those and never
// consults an ambient `declare module` for them -- so bin/'s plain-JS,
// declaration-file-less .mjs unavoidably surfaces one TS7016 on the import
// line itself. Suppressed there only; the re-typed const below keeps every
// actual USE of formatDiff in this file properly type-checked.
// @ts-expect-error -- bin/mnemosyne-persona.mjs is plain JS with no .d.ts; see doc comment above.
import { formatDiff as formatDiffUntyped } from '../../../../bin/mnemosyne-persona.mjs';
const formatDiff: (beforeText: string | null, afterText: string | null) => string = formatDiffUntyped;

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'real-world');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CLI = path.join(REPO_ROOT, 'bin', 'mnemosyne-persona.mjs');
const RACE_WORKER = fileURLToPath(new URL('./fixtures/sync-race-worker.ts', import.meta.url));

const SCOPE_ID = 'pf05-scope';

const FIXTURES = {
  noMarkers: path.join(FIXTURES_DIR, 'claude-md-no-markers.md'),
  mixedFormatting: path.join(FIXTURES_DIR, 'agents-md-mixed-formatting.md'),
  partialMarker: path.join(FIXTURES_DIR, 'gemini-md-partial-marker.md'),
  // pf-10: global-tier-flavored real-world fixture (Slice 2 closing story) --
  // same "marker-free, human-edited" shape as claude-md-no-markers.md, but
  // content flavored for a company-director/global-tier reader. Included in
  // the same FIXTURES map on purpose so the fixture-stability guard
  // (beforeAll/afterAll below) covers it automatically, no separate guard
  // needed.
  companyDirector: path.join(FIXTURES_DIR, 'company-director-example.md'),
};

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempRoot(prefix = 'mnemosyne-layer1-integration-'): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

/** Reads a fixture's ORIGINAL content. Read-only -- callers must never write to `fixturePath`. */
function readFixture(fixturePath: string): string {
  return readFileSync(fixturePath, 'utf8');
}

/** Copies a fixture's content into `destPath` -- the only path a test may write to. */
async function copyFixtureTo(fixturePath: string, destPath: string): Promise<string> {
  const content = readFixture(fixturePath);
  await mkdir(path.dirname(destPath), { recursive: true });
  await writeFile(destPath, content, 'utf8');
  return content;
}

async function makeLevel0(root: string, body: string): Promise<string> {
  const level0Path = path.join(root, 'level0-rules.md');
  await writeFile(level0Path, body, 'utf8');
  return level0Path;
}

/** A real, throwaway $HOME with its own ~/.mnemosyne/level0-rules.md -- mirrors test/persona-cli.mjs. Never the real one. */
async function makeFakeHome(marker: string): Promise<string> {
  const home = await makeTempRoot('mnemosyne-layer1-integration-home-');
  await mkdir(path.join(home, '.mnemosyne'), { recursive: true });
  await writeFile(
    path.join(home, '.mnemosyne', 'level0-rules.md'),
    `# Level 0 fixture\n\n${marker} — pull first, never commit to main.\n`,
    'utf8',
  );
  return home;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the real `mnemosyne persona sync` CLI as a real subprocess (tsx), exactly like test/persona-cli.mjs. */
async function runCli(args: string[], home: string): Promise<CliResult> {
  const env = { ...process.env, HOME: home };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [TSX_BIN, CLI, ...args], {
      cwd: REPO_ROOT,
      env,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/** Extracts one harness target's `--- <path> (<harness>) [would ...] ---` preview section from --dry-run stdout. */
function extractDryRunSection(stdout: string, targetFilePath: string): string | null {
  const lines = stdout.split('\n');
  const headerPrefix = `--- ${targetFilePath} (`;
  const startIdx = lines.findIndex((l) => l.startsWith(headerPrefix));
  if (startIdx === -1) return null;
  const rest = lines.slice(startIdx + 1);
  const nextHeaderIdx = rest.findIndex((l) => l.startsWith('--- '));
  const body = nextHeaderIdx === -1 ? rest : rest.slice(0, nextHeaderIdx);
  const filtered = body.filter((l) => !l.startsWith('mnemosyne persona sync --dry-run: computed'));
  return filtered.join('\n').replace(/\s+$/, '');
}

interface WorkerResult {
  pid: number;
  start: number;
  end: number;
}

async function tsxLoaderPath(): Promise<string> {
  const resolved = import.meta.resolve('tsx');
  return fileURLToPath(resolved);
}

/** Spawns a real OS process running sync-race-worker.ts against `targetPath`. */
async function runSyncRaceWorker(
  targetPath: string,
  level0Path: string,
  tier: string,
  scopeId: string,
  repoRoot: string,
  holdMs: number,
): Promise<WorkerResult> {
  const loader = await tsxLoaderPath();
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', loader, RACE_WORKER, targetPath, level0Path, tier, scopeId, repoRoot, String(holdMs)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`sync-race-worker exited with code ${code}. stderr:\n${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as WorkerResult);
      } catch (err) {
        reject(new Error(`could not parse worker stdout ${JSON.stringify(stdout)}: ${String(err)}`));
      }
    });
  });
}

// --- fixture-stability guard: captured before any test runs, checked after all of them do -----
let fixtureHashesBefore: Record<string, string>;
beforeAll(() => {
  fixtureHashesBefore = Object.fromEntries(
    Object.entries(FIXTURES).map(([name, p]) => [name, sha256(readFixture(p))]),
  );
});
afterAll(() => {
  for (const [name, p] of Object.entries(FIXTURES)) {
    expect(sha256(readFixture(p)), `fixture ${name} (${p}) must be byte-for-byte unchanged after the suite ran`).toBe(
      fixtureHashesBefore[name],
    );
  }
});

describe('real-world fixture: claude-md-no-markers.md (marker-free, human-edited file)', () => {
  it('the fixture itself really has no mnemosyne markers (sanity, not the interesting assertion)', () => {
    const original = readFixture(FIXTURES.noMarkers);
    expect(original).not.toContain('mnemosyne:layer1');
    expect(original.indexOf(BLOCK_START)).toBe(-1);
    expect(original.indexOf(BLOCK_END)).toBe(-1);
  });

  it('sync preserves human content byte-for-byte and adds exactly one managed block, idempotently', async () => {
    const root = await makeTempRoot();
    const level0Path = await makeLevel0(root, '# Level 0\n\nPF05_L0_MARKER — pull first, never commit to main.\n');
    const targetPath = path.join(root, 'CLAUDE.md');
    const original = await copyFixtureTo(FIXTURES.noMarkers, targetPath);

    const result = syncHarnessFile(targetPath, 'code-architect', 'claude-code', SCOPE_ID, { level0Path });
    expect(result.created).toBe(false);

    const written = readFileSync(targetPath, 'utf8');
    const trimmedOriginal = original.replace(/\n+$/, '');
    // Byte-for-byte: everything up to the (normalized) trailing newlines is
    // an exact, untouched prefix of the synced file.
    expect(written.startsWith(trimmedOriginal)).toBe(true);
    expect(written).toContain('## Known gotchas');
    expect(written).toContain('Billing domain questions: #kestrel-eng');
    expect(written).toContain('PF05_L0_MARKER');

    // No marker duplication.
    expect(written.split(BLOCK_START)).toHaveLength(2);
    expect(written.split(BLOCK_END)).toHaveLength(2);

    // Idempotent second run: still exactly one pair, human content still intact.
    const second = syncHarnessFile(targetPath, 'code-architect', 'claude-code', SCOPE_ID, { level0Path });
    expect(second.created).toBe(false);
    const writtenTwice = readFileSync(targetPath, 'utf8');
    expect(writtenTwice.split(BLOCK_START)).toHaveLength(2);
    expect(writtenTwice.split(BLOCK_END)).toHaveLength(2);
    expect(writtenTwice.startsWith(trimmedOriginal)).toBe(true);
    expect(writtenTwice).toContain('Billing domain questions: #kestrel-eng');
  });
});

describe('real-world fixture: agents-md-mixed-formatting.md (mixed headings, trailing whitespace, unrelated --- divider)', () => {
  it('the fixture itself really has mixed heading levels, trailing whitespace, and a bare --- divider (sanity)', () => {
    const original = readFixture(FIXTURES.mixedFormatting);
    expect(original).toMatch(/^# /m);
    expect(original).toMatch(/^### /m);
    expect(original).toMatch(/^##### /m);
    expect(original).toMatch(/^## /m);
    expect(original).toMatch(/^#### /m);
    expect(countMatches(original, / +\n/g)).toBeGreaterThan(0);
    expect(countMatches(original, /^---$/gm)).toBe(1);
  });

  it('sync preserves trailing whitespace, mixed heading levels, and the unrelated --- divider verbatim', async () => {
    const root = await makeTempRoot();
    const level0Path = await makeLevel0(root, '# Level 0\n\nPF05_L0_MARKER — pull first.\n');
    const targetPath = path.join(root, 'AGENTS.md');
    const original = await copyFixtureTo(FIXTURES.mixedFormatting, targetPath);
    const origDividerCount = countMatches(original, /^---$/gm);

    syncHarnessFile(targetPath, 'code-architect', 'claude-code', SCOPE_ID, { level0Path });
    const written = readFileSync(targetPath, 'utf8');

    const trimmedOriginal = original.replace(/\n+$/, '');
    expect(written.startsWith(trimmedOriginal)).toBe(true);

    // Trailing-whitespace lines survive character-for-character.
    expect(written).toContain('# Agents Guide — Fenwick Platform  \n');
    expect(written).toContain('- `services/` — one directory per microservice   \n');
    expect(written).toContain('1. Merge to `dev`.   \n');

    // Mixed heading levels are untouched, in original order.
    expect(written.indexOf('### Repository layout')).toBeLessThan(written.indexOf('##### Deploy checklist'));
    expect(written.indexOf('##### Deploy checklist')).toBeLessThan(written.indexOf('## Testing'));
    expect(written.indexOf('## Testing')).toBeLessThan(written.indexOf('#### A deeply nested aside'));

    // The unrelated divider survives; buildManagedBody's own Level0/tier
    // divider (sync.ts) legitimately adds exactly one more bare '---' line
    // inside the managed block, so the total goes from 1 -> 2, not more.
    expect(countMatches(written, /^---$/gm)).toBe(origDividerCount + 1);
    expect(written).toContain('That horizontal rule above is NOT a Mnemosyne marker.');

    expect(written.split(BLOCK_START)).toHaveLength(2);
    expect(written.split(BLOCK_END)).toHaveLength(2);
  });
});

describe('real-world fixture: gemini-md-partial-marker.md (BLOCK_START present, no BLOCK_END) -- append-mode fallback', () => {
  it('the fixture genuinely exercises spliceManagedBlock\'s startIdx/endIdx guard: BLOCK_START present, BLOCK_END absent', () => {
    const original = readFixture(FIXTURES.partialMarker);
    const startIdx = original.indexOf(BLOCK_START);
    const endIdx = original.indexOf(BLOCK_END);
    expect(startIdx).not.toBe(-1);
    expect(endIdx).toBe(-1); // <- this is exactly what forces the `startIdx !== -1 && endIdx !== -1` guard to fail
    expect(original.split(BLOCK_START)).toHaveLength(2); // exactly one stray, unmatched BLOCK_START
    expect(original.split(BLOCK_END)).toHaveLength(1); // zero BLOCK_END anywhere
  });

  it('sync falls back to append-mode: original content (incl. the stray marker) is an exact prefix, a well-formed block is appended', async () => {
    const root = await makeTempRoot();
    const level0Path = await makeLevel0(root, '# Level 0\n\nPF05_L0_MARKER_V1 — v1 rule text.\n');
    const targetPath = path.join(root, 'GEMINI.md');
    const original = await copyFixtureTo(FIXTURES.partialMarker, targetPath);

    syncHarnessFile(targetPath, 'code-architect', 'claude-code', SCOPE_ID, { level0Path });
    const written = readFileSync(targetPath, 'utf8');

    // The decisive assertion: had the code taken the "replace between
    // markers" branch with endIdx === -1 (e.g. `.slice(endIdx +
    // BLOCK_END.length)` === `.slice(18)` on a -1 endIdx), this would
    // truncate/duplicate the original content instead of preserving it as a
    // clean prefix -- verified against a deliberately-broken guard during
    // development, see the pf-05 completion report for the corrupted output
    // that guard produced against this exact fixture.
    const trimmedOriginal = original.replace(/\n+$/, '');
    expect(written.startsWith(trimmedOriginal)).toBe(true);

    // append-mode signature: TWO BLOCK_STARTs (the stray original + the new
    // one), but only ONE BLOCK_END (from the newly appended block only).
    expect(written.split(BLOCK_START)).toHaveLength(3);
    expect(written.split(BLOCK_END)).toHaveLength(2);

    // The lone BLOCK_END belongs to the newly appended block -- it comes
    // after the SECOND BLOCK_START, not the stray first one.
    const firstStart = written.indexOf(BLOCK_START);
    const secondStart = written.indexOf(BLOCK_START, firstStart + BLOCK_START.length);
    const onlyEnd = written.indexOf(BLOCK_END);
    expect(secondStart).toBeGreaterThan(firstStart);
    expect(onlyEnd).toBeGreaterThan(secondStart);

    // Human content sitting between the stray marker and EOF survives whole.
    expect(written).toContain('These notes were added later by a human, after the stray begin marker');
    expect(written).toContain('## Notes added after the stray marker');
    expect(written).toContain('PF05_L0_MARKER_V1');

    // Regression check for the bug this integration suite found and fixed
    // (block.ts's spliceManagedBlock/extractManagedBlockBody used indexOf,
    // pairing the FIRST BLOCK_START with the FIRST BLOCK_END): re-sync after
    // a Level 0 change and confirm the stray marker's trailing human content
    // -- "trapped" between the stray start and the real block -- survives a
    // SECOND sync untouched, and only the real (most-recent) block's body
    // updates.
    await writeFile(level0Path, '# Level 0\n\nPF05_L0_MARKER_V2 — v2 rule text.\n', 'utf8');
    syncHarnessFile(targetPath, 'code-architect', 'claude-code', SCOPE_ID, { level0Path });
    const writtenTwice = readFileSync(targetPath, 'utf8');

    expect(writtenTwice).toContain('These notes were added later by a human, after the stray begin marker');
    expect(writtenTwice).toContain('## Notes added after the stray marker');
    expect(writtenTwice.split(BLOCK_START)).toHaveLength(3); // still exactly 2 occurrences
    expect(writtenTwice.split(BLOCK_END)).toHaveLength(2); // still exactly 1 occurrence
    expect(writtenTwice).toContain('PF05_L0_MARKER_V2');
    expect(writtenTwice).not.toContain('PF05_L0_MARKER_V1');
  });
});

describe('real-world fixture: company-director-example.md (global-tier flavor, pf-10/Slice 2)', () => {
  it('the fixture itself really has no mnemosyne markers, and its own bare --- divider (sanity, not the interesting assertion)', () => {
    const original = readFixture(FIXTURES.companyDirector);
    expect(original).not.toContain('mnemosyne:layer1');
    expect(original.indexOf(BLOCK_START)).toBe(-1);
    expect(original.indexOf(BLOCK_END)).toBe(-1);
    expect(countMatches(original, /^---$/gm)).toBe(1);
    expect(countMatches(original, / +\n/g)).toBeGreaterThan(0);
  });

  it(
    'sync (in-process, tier=company-director) preserves human content byte-for-byte and adds exactly one managed block, idempotently -- same guarantees pf-05 proved for code-architect',
    async () => {
      // In-process calls have no way to point getPersonaContent's global-store
      // lookup at a temp dir: sync.ts's SyncOptions only threads level0Path
      // through to getPersonaContent -- ctx.globalPersonaRoot is left
      // undefined at every real call site sync.ts has (a documented pf-07
      // design decision; see persona.test.ts's "defaults globalPersonaRoot to
      // DEFAULT_GLOBAL_PERSONA_ROOT when omitted from ctx (real call-site
      // shape: sync.ts only ever passes repoRoot)" test). So this in-process
      // case necessarily exercises the fallback-to-TIER_CONTENT path, not a
      // seeded persona -- which is still a fully real, production code path
      // (`fallbackToTierContentWithWarning`) and proves the same round-trip/
      // no-corruption mechanics hold for a global tier as for code-architect.
      // The genuine SEEDED-persona round trip is proven below, via the real
      // CLI subprocess, whose HOME override actually takes effect (fresh
      // process => DEFAULT_GLOBAL_PERSONA_ROOT resolves against the fake HOME
      // at import time) -- same reasoning as this file's own top-of-file doc
      // comment about DEFAULT_LEVEL0_PATH.
      const root = await makeTempRoot();
      const level0Path = await makeLevel0(root, '# Level 0\n\nPF10_L0_MARKER — pull first, never commit to main.\n');
      const targetPath = path.join(root, 'CLAUDE.md');
      const original = await copyFixtureTo(FIXTURES.companyDirector, targetPath);

      const result = syncHarnessFile(targetPath, 'company-director', 'claude-code', SCOPE_ID, { level0Path });
      expect(result.created).toBe(false);

      const written = readFileSync(targetPath, 'utf8');
      const trimmedOriginal = original.replace(/\n+$/, '');
      expect(written.startsWith(trimmedOriginal)).toBe(true);
      expect(written).toContain('## Escalation');
      expect(written).toContain("Board/investor questions: ask Directors' Ops first, not Legal");
      expect(written).toContain('PF10_L0_MARKER');
      expect(written).toContain(TIER_CONTENT['company-director'].displayName);

      // No marker duplication.
      expect(written.split(BLOCK_START)).toHaveLength(2);
      expect(written.split(BLOCK_END)).toHaveLength(2);

      // Idempotent second run: still exactly one pair, human content still intact.
      const second = syncHarnessFile(targetPath, 'company-director', 'claude-code', SCOPE_ID, { level0Path });
      expect(second.created).toBe(false);
      const writtenTwice = readFileSync(targetPath, 'utf8');
      expect(writtenTwice.split(BLOCK_START)).toHaveLength(2);
      expect(writtenTwice.split(BLOCK_END)).toHaveLength(2);
      expect(writtenTwice.startsWith(trimmedOriginal)).toBe(true);
      expect(writtenTwice).toContain("Board/investor questions: ask Directors' Ops first, not Legal");
    },
  );
});

describe('global persona store round trip via the real CLI subprocess (top-orchestrator / company-director / project-orchestrator)', () => {
  // Distinct seeded content per tier, deliberately NOT sharing any substring
  // with that tier's hardcoded TIER_CONTENT.displayName (tiers.ts) -- the
  // "must NOT contain the fallback's displayName" assertion below is what
  // proves the seeded persona (not the fallback) is genuinely what got
  // rendered, not just a coincidentally-overlapping string.
  const GLOBAL_TIER_CASES: {
    tier: Tier;
    scopeId: string;
    displayName: string;
    distinctiveBody: string;
  }[] = [
    {
      tier: 'top-orchestrator',
      scopeId: 'pf10-top-scope',
      displayName: 'Pantheon Portfolio Lead (seeded persona)',
      distinctiveBody: 'Seeded top-orchestrator persona body unique to scope pf10-top-scope.',
    },
    {
      tier: 'company-director',
      scopeId: 'pf10-director-scope',
      displayName: 'Northwind Business Lead (seeded persona)',
      distinctiveBody: 'Seeded company-director persona body unique to scope pf10-director-scope.',
    },
    {
      tier: 'project-orchestrator',
      scopeId: 'pf10-project-scope',
      displayName: 'Fenwick Delivery Lead (seeded persona)',
      distinctiveBody: 'Seeded project-orchestrator persona body unique to scope pf10-project-scope.',
    },
  ];

  it.each(GLOBAL_TIER_CASES)(
    'mnemosyne persona sync --tier $tier renders the SEEDED global persona (not the TIER_CONTENT fallback) onto a real-world fixture, byte-preserving, idempotent',
    async ({ tier, scopeId, displayName, distinctiveBody }) => {
      const home = await makeFakeHome(`PF10_GLOBAL_L0_MARKER_${tier}`);
      const globalRoot = path.join(home, '.mnemosyne', 'personas');
      writeGlobalPersona(
        {
          tier,
          scopeId,
          displayName,
          scope: `A persona-authored scope statement unique to ${tier}/${scopeId}.`,
          sections: [{ heading: 'Seeded section', body: distinctiveBody }],
        },
        globalRoot,
      );

      const repo = await makeTempRoot('mnemosyne-layer1-integration-global-cli-repo-');
      const original = await copyFixtureTo(FIXTURES.companyDirector, path.join(repo, 'CLAUDE.md'));

      const first = await runCli(['sync', '--repo', repo, '--tier', tier, '--scope-id', scopeId], home);
      expect(first.code, `cli sync stderr: ${first.stderr}`).toBe(0);
      expect(first.stdout).toMatch(/updated .*CLAUDE\.md/);

      const written = await readFile(path.join(repo, 'CLAUDE.md'), 'utf8');
      const trimmedOriginal = original.replace(/\n+$/, '');
      expect(written.startsWith(trimmedOriginal)).toBe(true);

      // The SEEDED persona's own content -- proves the global store is the
      // real content source for this sync, not the hardcoded TIER_CONTENT
      // fallback. Checked as a rendered HEADING ("## <displayName>",
      // renderTierContentMarkdown's own format) rather than a bare substring
      // search, because company-director-example.md's own human prose
      // legitimately contains the words "Company Director" (it's a
      // company-director-flavored fixture) -- a bare-substring check would
      // false-positive against that prose, not against fallback content.
      expect(written).toContain(displayName);
      expect(written).toContain(distinctiveBody);
      expect(written).not.toContain(`## ${TIER_CONTENT[tier].displayName}`);

      expect(written).toContain(`PF10_GLOBAL_L0_MARKER_${tier}`);
      expect(written.split(BLOCK_START)).toHaveLength(2);
      expect(written.split(BLOCK_END)).toHaveLength(2);

      // Idempotent second run: still exactly one pair, seeded content still intact.
      const second = await runCli(['sync', '--repo', repo, '--tier', tier, '--scope-id', scopeId], home);
      expect(second.code, `cli sync (2nd run) stderr: ${second.stderr}`).toBe(0);
      const writtenTwice = await readFile(path.join(repo, 'CLAUDE.md'), 'utf8');
      expect(writtenTwice.split(BLOCK_START)).toHaveLength(2);
      expect(writtenTwice.split(BLOCK_END)).toHaveLength(2);
      expect(writtenTwice).toContain(distinctiveBody);
      expect(writtenTwice.startsWith(trimmedOriginal)).toBe(true);
    },
    20_000,
  );
});

describe('via the pf-04 CLI (real subprocess, not in-process)', () => {
  it('mnemosyne persona sync against a repo of real-world fixtures: human content survives, no marker duplication, idempotent', async () => {
    const home = await makeFakeHome('PF05_CLI_L0_MARKER');
    const repo = await makeTempRoot('mnemosyne-layer1-integration-cli-repo-');

    const originalClaude = await copyFixtureTo(FIXTURES.noMarkers, path.join(repo, 'CLAUDE.md'));
    const originalAgents = await copyFixtureTo(FIXTURES.mixedFormatting, path.join(repo, 'AGENTS.md'));
    const originalGemini = await copyFixtureTo(FIXTURES.partialMarker, path.join(repo, 'GEMINI.md'));

    const first = await runCli(['sync', '--repo', repo, '--tier', 'code-architect', '--scope-id', SCOPE_ID], home);
    expect(first.code, `cli sync stderr: ${first.stderr}`).toBe(0);
    expect(first.stdout).toMatch(/updated .*CLAUDE\.md/);
    expect(first.stdout).toMatch(/updated .*AGENTS\.md/);
    expect(first.stdout).toMatch(/updated .*GEMINI\.md/);

    const [claude, agents, gemini] = await Promise.all([
      readFile(path.join(repo, 'CLAUDE.md'), 'utf8'),
      readFile(path.join(repo, 'AGENTS.md'), 'utf8'),
      readFile(path.join(repo, 'GEMINI.md'), 'utf8'),
    ]);

    expect(claude.startsWith(originalClaude.replace(/\n+$/, ''))).toBe(true);
    expect(agents.startsWith(originalAgents.replace(/\n+$/, ''))).toBe(true);
    expect(gemini.startsWith(originalGemini.replace(/\n+$/, ''))).toBe(true);

    for (const [name, content] of [['CLAUDE.md', claude], ['AGENTS.md', agents], ['GEMINI.md', gemini]] as const) {
      expect(content.split(BLOCK_START).length, `${name} BLOCK_START count`).toBeGreaterThanOrEqual(2);
      expect(content).toContain('PF05_CLI_L0_MARKER');
    }
    // GEMINI.md is the partial-marker fixture -- append-mode signature via the CLI too.
    expect(gemini.split(BLOCK_START)).toHaveLength(3);
    expect(gemini.split(BLOCK_END)).toHaveLength(2);

    // Idempotent second CLI run: no additional marker duplication.
    const second = await runCli(['sync', '--repo', repo, '--tier', 'code-architect', '--scope-id', SCOPE_ID], home);
    expect(second.code).toBe(0);
    const claudeAfterSecond = await readFile(path.join(repo, 'CLAUDE.md'), 'utf8');
    const geminiAfterSecond = await readFile(path.join(repo, 'GEMINI.md'), 'utf8');
    expect(claudeAfterSecond.split(BLOCK_START)).toHaveLength(2);
    expect(geminiAfterSecond.split(BLOCK_START)).toHaveLength(3); // stray + real, unchanged
    expect(geminiAfterSecond.split(BLOCK_END)).toHaveLength(2);
    expect(geminiAfterSecond).toContain('## Notes added after the stray marker');
  }, 20_000);
});

describe('dry-run parity + zero-write guarantee (every real-world fixture)', () => {
  it('--dry-run preview matches a real run exactly, and every fixture copy is provably unchanged on disk afterward', async () => {
    const home = await makeFakeHome('PF05_DRYRUN_L0_MARKER');

    const repoReal = await makeTempRoot('mnemosyne-layer1-integration-dryrun-real-');
    const repoDry = await makeTempRoot('mnemosyne-layer1-integration-dryrun-dry-');

    const targets = [
      { fixture: FIXTURES.noMarkers, fileName: 'CLAUDE.md' },
      { fixture: FIXTURES.mixedFormatting, fileName: 'AGENTS.md' },
      { fixture: FIXTURES.partialMarker, fileName: 'GEMINI.md' },
    ];

    const originals: Record<string, string> = {};
    for (const t of targets) {
      const content = await copyFixtureTo(t.fixture, path.join(repoReal, t.fileName));
      await copyFixtureTo(t.fixture, path.join(repoDry, t.fileName));
      originals[t.fileName] = content;
    }

    const beforeDryRunStats = await Promise.all(
      targets.map((t) => stat(path.join(repoDry, t.fileName))),
    );
    const beforeDryRunHashes = targets.map((t) => sha256(originals[t.fileName]!));

    // Real run, against repoReal.
    const real = await runCli(['sync', '--repo', repoReal, '--tier', 'code-architect', '--scope-id', SCOPE_ID], home);
    expect(real.code, `real run stderr: ${real.stderr}`).toBe(0);

    // Dry run, against the IDENTICAL starting state in repoDry, same fake home/level0.
    const dry = await runCli(
      ['sync', '--repo', repoDry, '--tier', 'code-architect', '--scope-id', SCOPE_ID, '--dry-run'],
      home,
    );
    expect(dry.code, `dry run stderr: ${dry.stderr}`).toBe(0);
    expect(dry.stdout).toMatch(/zero filesystem writes/i);

    for (const t of targets) {
      const realAfter = await readFile(path.join(repoReal, t.fileName), 'utf8');
      // Trim trailing whitespace the same way extractDryRunSection does below --
      // console.log(formatDiff(...)) followed by stdout capture/regex-slicing
      // naturally loses a trailing space on the very last printed diff line
      // (real terminal/pipe behavior, not a bug in formatDiff or the CLI), so
      // comparing both sides under the identical normalization is the accurate
      // "matches exactly" check, not a loosened one.
      const expectedDiff = formatDiff(originals[t.fileName]!, realAfter).replace(/\s+$/, '');
      const actualSection = extractDryRunSection(dry.stdout, path.join(repoDry, t.fileName));
      expect(actualSection, `dry-run stdout had no section for ${t.fileName}:\n${dry.stdout}`).not.toBeNull();
      expect(actualSection, `dry-run preview for ${t.fileName} must match what the real run produced`).toBe(
        expectedDiff,
      );
    }

    // Zero-write guarantee: every fixture copy in repoDry is provably unchanged.
    const afterDryRunStats = await Promise.all(targets.map((t) => stat(path.join(repoDry, t.fileName))));
    const afterDryRunContents = await Promise.all(
      targets.map((t) => readFile(path.join(repoDry, t.fileName), 'utf8')),
    );
    targets.forEach((t, i) => {
      expect(afterDryRunContents[i]).toBe(originals[t.fileName]!);
      expect(sha256(afterDryRunContents[i]!), `${t.fileName} sha256 unchanged after --dry-run`).toBe(
        beforeDryRunHashes[i],
      );
      expect(afterDryRunStats[i]!.mtimeMs, `${t.fileName} mtime unchanged after --dry-run`).toBe(
        beforeDryRunStats[i]!.mtimeMs,
      );
    });
  }, 30_000);
});

describe('concurrency: pf-03 locking holds against a real-world fixture (not the synthetic counter file)', () => {
  it(
    'two overlapping sync invocations (separate OS processes) against the same real-world fixture copy serialize: no corruption, no marker duplication',
    async () => {
      const root = await makeTempRoot();
      const level0Path = await makeLevel0(root, '# Level 0\n\nPF05_RACE_L0_MARKER — pull first.\n');
      const targetPath = path.join(root, 'CLAUDE.md');
      const original = await copyFixtureTo(FIXTURES.noMarkers, targetPath);

      // Both processes call the SAME real production functions
      // syncHarnessFile itself calls internally (buildManagedBody,
      // spliceManagedBlock, withLock -- see fixtures/sync-race-worker.ts),
      // with an artificial hold widening the window between read and write
      // so a broken lock would reliably manifest, not just occasionally.
      const [a, b] = await Promise.all([
        runSyncRaceWorker(targetPath, level0Path, 'code-architect', SCOPE_ID, root, 150),
        runSyncRaceWorker(targetPath, level0Path, 'code-architect', SCOPE_ID, root, 150),
      ]);

      // Mutual exclusion: the two workers' locked critical sections must not overlap in wall-clock time.
      const overlapped = a.start < b.end && b.start < a.end;
      expect(overlapped, `worker A [${a.start},${a.end}] vs worker B [${b.start},${b.end}] must not overlap`).toBe(
        false,
      );

      const finalContent = readFileSync(targetPath, 'utf8');
      const trimmedOriginal = original.replace(/\n+$/, '');
      expect(finalContent.startsWith(trimmedOriginal)).toBe(true);
      expect(finalContent.split(BLOCK_START)).toHaveLength(2); // no duplication despite the race
      expect(finalContent.split(BLOCK_END)).toHaveLength(2);
      expect(finalContent).toContain('PF05_RACE_L0_MARKER');
      expect(finalContent).toContain('Billing domain questions: #kestrel-eng');

      // No lock file left behind by either worker.
      const { existsSync } = await import('node:fs');
      expect(existsSync(`${targetPath}.mnemosyne.lock`)).toBe(false);
    },
    20_000,
  );
});

/**
 * pf-10 (Slice 2's closing story): an EXPLICIT regression block re-exercising
 * Slice 1's own production code paths -- syncHarnessFile and the real pf-04
 * CLI subprocess, against the exact same fixtures pf-05 used -- to prove
 * repo-local/code-architect sync still works, unchanged, now that Slice 2
 * (pf-06 global persona store, pf-07 global-tier getPersonaContent dispatch,
 * pf-08 seed/migration script) has landed on this branch.
 *
 * This is deliberately NOT "the describe blocks above this comment, which
 * happen to still be in the file" -- those already re-run on every suite
 * execution and would already catch a regression, but this block exists so
 * that fact is explicit and load-bearing rather than incidental: it uses its
 * own fresh marker strings (PF10_SLICE1_REGRESSION_MARKER /
 * PF10_SLICE1_CLI_REGRESSION_MARKER, never used anywhere above) precisely so
 * it cannot be satisfied by any cached state or prior assertion in this
 * file -- every expectation here is computed fresh, in this block, against
 * the current (post-Slice-2) codebase.
 */
describe('Slice 1 regression (pf-10): repo-local code-architect sync still works, unchanged, after Slice 2 (pf-06/pf-07/pf-08) landed', () => {
  it.each([
    {
      name: 'noMarkers',
      fixture: FIXTURES.noMarkers,
      fileName: 'CLAUDE.md',
      mustContain: 'Billing domain questions: #kestrel-eng',
      expectedStartCount: 2,
      expectedEndCount: 2,
    },
    {
      name: 'mixedFormatting',
      fixture: FIXTURES.mixedFormatting,
      fileName: 'AGENTS.md',
      mustContain: 'That horizontal rule above is NOT a Mnemosyne marker.',
      expectedStartCount: 2,
      expectedEndCount: 2,
    },
    {
      name: 'partialMarker (append-mode fallback)',
      fixture: FIXTURES.partialMarker,
      fileName: 'GEMINI.md',
      mustContain: 'These notes were added later by a human, after the stray begin marker',
      expectedStartCount: 3, // stray original BLOCK_START + the new one
      expectedEndCount: 2, // real appended block's BLOCK_END only
    },
  ])(
    're-exercises syncHarnessFile(tier=code-architect) against the $name real-world fixture: byte-for-byte preservation, no marker duplication, idempotent -- the same production code path pf-05 exercised, run now against Slice 2\'s codebase state',
    async ({ fixture, fileName, mustContain, expectedStartCount, expectedEndCount }) => {
      const root = await makeTempRoot();
      const level0Path = await makeLevel0(
        root,
        '# Level 0\n\nPF10_SLICE1_REGRESSION_MARKER — pull first, never commit to main.\n',
      );
      const targetPath = path.join(root, fileName);
      const original = await copyFixtureTo(fixture, targetPath);

      syncHarnessFile(targetPath, 'code-architect', 'claude-code', SCOPE_ID, { level0Path });
      const written = readFileSync(targetPath, 'utf8');
      const trimmedOriginal = original.replace(/\n+$/, '');

      expect(written.startsWith(trimmedOriginal)).toBe(true);
      expect(written).toContain(mustContain);
      expect(written).toContain('PF10_SLICE1_REGRESSION_MARKER');
      // code-architect's own content resolution (repo-local store, pf-02) is
      // unchanged: no repo-local persona exists at SCOPE_ID here, so this
      // falls back to the hardcoded TIER_CONTENT heading, exactly as before
      // Slice 2.
      expect(written).toContain(TIER_CONTENT['code-architect'].displayName);
      expect(written.split(BLOCK_START)).toHaveLength(expectedStartCount);
      expect(written.split(BLOCK_END)).toHaveLength(expectedEndCount);

      // Idempotent second run -- still true post-Slice-2.
      syncHarnessFile(targetPath, 'code-architect', 'claude-code', SCOPE_ID, { level0Path });
      const writtenTwice = readFileSync(targetPath, 'utf8');
      expect(writtenTwice.split(BLOCK_START)).toHaveLength(expectedStartCount);
      expect(writtenTwice.split(BLOCK_END)).toHaveLength(expectedEndCount);
      expect(writtenTwice.startsWith(trimmedOriginal)).toBe(true);
    },
  );

  it('re-exercises the real pf-04 CLI subprocess end-to-end against all three real-world fixtures at once, tier=code-architect: unchanged after Slice 2', async () => {
    const home = await makeFakeHome('PF10_SLICE1_CLI_REGRESSION_MARKER');
    const repo = await makeTempRoot('mnemosyne-layer1-integration-slice1-regression-cli-repo-');

    const originalClaude = await copyFixtureTo(FIXTURES.noMarkers, path.join(repo, 'CLAUDE.md'));
    const originalAgents = await copyFixtureTo(FIXTURES.mixedFormatting, path.join(repo, 'AGENTS.md'));
    const originalGemini = await copyFixtureTo(FIXTURES.partialMarker, path.join(repo, 'GEMINI.md'));

    const result = await runCli(['sync', '--repo', repo, '--tier', 'code-architect', '--scope-id', SCOPE_ID], home);
    expect(result.code, `cli sync stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/updated .*CLAUDE\.md/);
    expect(result.stdout).toMatch(/updated .*AGENTS\.md/);
    expect(result.stdout).toMatch(/updated .*GEMINI\.md/);

    const [claude, agents, gemini] = await Promise.all([
      readFile(path.join(repo, 'CLAUDE.md'), 'utf8'),
      readFile(path.join(repo, 'AGENTS.md'), 'utf8'),
      readFile(path.join(repo, 'GEMINI.md'), 'utf8'),
    ]);

    expect(claude.startsWith(originalClaude.replace(/\n+$/, ''))).toBe(true);
    expect(agents.startsWith(originalAgents.replace(/\n+$/, ''))).toBe(true);
    expect(gemini.startsWith(originalGemini.replace(/\n+$/, ''))).toBe(true);
    expect(claude).toContain('PF10_SLICE1_CLI_REGRESSION_MARKER');
    // append-mode signature (GEMINI.md's stray BLOCK_START) unchanged post-Slice-2.
    expect(gemini.split(BLOCK_START)).toHaveLength(3);
    expect(gemini.split(BLOCK_END)).toHaveLength(2);

    // Idempotent second CLI run: no additional marker duplication.
    const second = await runCli(['sync', '--repo', repo, '--tier', 'code-architect', '--scope-id', SCOPE_ID], home);
    expect(second.code).toBe(0);
    const claudeAfterSecond = await readFile(path.join(repo, 'CLAUDE.md'), 'utf8');
    const geminiAfterSecond = await readFile(path.join(repo, 'GEMINI.md'), 'utf8');
    expect(claudeAfterSecond.split(BLOCK_START)).toHaveLength(2);
    expect(geminiAfterSecond.split(BLOCK_START)).toHaveLength(3);
    expect(geminiAfterSecond.split(BLOCK_END)).toHaveLength(2);
  }, 20_000);
});
