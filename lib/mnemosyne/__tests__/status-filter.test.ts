/**
 * Unit tests for `lib/mnemosyne/status-filter.ts` (la-05-recall-status-filtering).
 *
 * Per the story's TDD methodology + the operator's testing bar for this
 * story specifically (unlike la-04's unit-only carve-out, ALL THREE are
 * required here): unit tests on the filtering logic itself (this file), a
 * real subprocess-level integration test spawning two real git
 * branches/worktrees (test/recall-status-filtering.mjs), and live
 * dogfooding in this repo.
 *
 * Covers exactly what the acceptance criteria hinge on:
 *   1. provisional entries written on branch X are excluded when the caller
 *      is on a different branch Y (default behavior).
 *   2. provisional entries written on the CALLER's own current branch are
 *      included by default.
 *   3. an explicit opt-in (`includeCrossBranchProvisional`) makes
 *      cross-branch provisional (and superseded) entries visible.
 *   4. entries with no flight-status header at all (pre-la-04 legacy data,
 *      or non-note content matched by other layers) are never filtered —
 *      treated as confirmed/no-filter, per this story's explicit guidance.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  filterHitsByStatus,
  isEntryVisible,
  parseFlightHeaderLine,
  readFlightHeader,
  type FlightHeader,
} from '../status-filter.js';
import type { Hit } from '../interfaces.js';

// ---------------------------------------------------------------------------
// parseFlightHeaderLine — pure string parsing, no I/O
// ---------------------------------------------------------------------------

describe('parseFlightHeaderLine', () => {
  it('parses a real remember()-written header line (engine.mjs / VectorLayerAdapter format)', () => {
    const line =
      '<!-- remembered via Mnemosyne @ 2026-08-13T00:00:00.000Z scope=project ' +
      'status=provisional branch=feat/la-05-recall-status-filtering commit=abc123 -->';
    expect(parseFlightHeaderLine(line)).toEqual({
      status: 'provisional',
      branch: 'feat/la-05-recall-status-filtering',
      commit_sha: 'abc123',
    } satisfies FlightHeader);
  });

  it('parses confirmed and superseded status values', () => {
    expect(
      parseFlightHeaderLine('<!-- ... status=confirmed branch=main commit=deadbeef -->'),
    )?.toMatchObject({ status: 'confirmed' });
    expect(
      parseFlightHeaderLine('<!-- ... status=superseded branch=dev commit=deadbeef -->'),
    )?.toMatchObject({ status: 'superseded' });
  });

  it('returns null for a line with no flight-status header (pre-la-04 legacy note, or an unrelated file)', () => {
    expect(parseFlightHeaderLine('just some ordinary content')).toBeNull();
    expect(
      parseFlightHeaderLine('<!-- remembered via Mnemosyne hook @ 2026-01-01 scope=personal -->'),
    ).toBeNull();
    expect(parseFlightHeaderLine('')).toBeNull();
  });

  it('rejects an unrecognized status word rather than guessing', () => {
    expect(parseFlightHeaderLine('status=bogus branch=main commit=abc -->')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isEntryVisible — the core filtering decision, pure logic
// ---------------------------------------------------------------------------

describe('isEntryVisible', () => {
  it('a legacy entry with no header (null) is always visible — never filtered', () => {
    expect(isEntryVisible(null, { callerBranch: 'main' })).toBe(true);
    expect(isEntryVisible(null, { callerBranch: 'some-other-branch' })).toBe(true);
    expect(isEntryVisible(null, {})).toBe(true);
  });

  it('a confirmed entry is always visible, regardless of caller branch', () => {
    const header: FlightHeader = { status: 'confirmed', branch: 'main', commit_sha: 'abc' };
    expect(isEntryVisible(header, { callerBranch: 'main' })).toBe(true);
    expect(isEntryVisible(header, { callerBranch: 'feat/other' })).toBe(true);
    expect(isEntryVisible(header, {})).toBe(true);
  });

  it('AC1: a provisional entry written on branch X is excluded when the caller is on a different branch Y', () => {
    const header: FlightHeader = { status: 'provisional', branch: 'feat/x', commit_sha: 'abc' };
    expect(isEntryVisible(header, { callerBranch: 'feat/y' })).toBe(false);
    expect(isEntryVisible(header, { callerBranch: 'main' })).toBe(false);
  });

  it('AC2: a provisional entry written on the CALLER\'s own current branch is included by default', () => {
    const header: FlightHeader = { status: 'provisional', branch: 'feat/x', commit_sha: 'abc' };
    expect(isEntryVisible(header, { callerBranch: 'feat/x' })).toBe(true);
  });

  it('a provisional entry is excluded when the caller branch is unknown/unresolvable (safe default)', () => {
    const header: FlightHeader = { status: 'provisional', branch: 'feat/x', commit_sha: 'abc' };
    expect(isEntryVisible(header, { callerBranch: null })).toBe(false);
    expect(isEntryVisible(header, {})).toBe(false);
  });

  it('AC3: the explicit opt-in makes cross-branch provisional entries visible on demand', () => {
    const header: FlightHeader = { status: 'provisional', branch: 'feat/x', commit_sha: 'abc' };
    expect(
      isEntryVisible(header, { callerBranch: 'feat/y', includeCrossBranchProvisional: true }),
    ).toBe(true);
    expect(
      isEntryVisible(header, { callerBranch: null, includeCrossBranchProvisional: true }),
    ).toBe(true);
  });

  it('a superseded entry is excluded by default (not "ground truth", not the caller\'s live work), but visible via the same opt-in', () => {
    const header: FlightHeader = { status: 'superseded', branch: 'feat/x', commit_sha: 'abc' };
    expect(isEntryVisible(header, { callerBranch: 'feat/x' })).toBe(false);
    expect(isEntryVisible(header, { callerBranch: 'feat/y' })).toBe(false);
    expect(
      isEntryVisible(header, { callerBranch: 'feat/y', includeCrossBranchProvisional: true }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readFlightHeader / filterHitsByStatus — real fs I/O against real temp files
// ---------------------------------------------------------------------------

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-status-filter-'));
  tempRoots.push(root);
  return root;
}

function noteHit(source: string, score = 0.9): Hit {
  return {
    content: 'irrelevant chunk text',
    provenance: {
      layer: 'vector',
      source,
      chunk_span: null,
      index_timestamp: null,
      content_hash: null,
      embedder: null,
      retrieval_time: null,
    },
    score,
  };
}

describe('readFlightHeader', () => {
  it('reads and parses a real header from a real note file on disk', async () => {
    const root = await makeTempDir();
    const file = path.join(root, 'note.md');
    await writeFile(
      file,
      '<!-- remembered via Mnemosyne @ 2026-08-13T00:00:00.000Z scope=project ' +
        'status=provisional branch=feat/x commit=abc123 -->\nsome body text\n',
      'utf8',
    );

    const header = await readFlightHeader(file);
    expect(header).toEqual({ status: 'provisional', branch: 'feat/x', commit_sha: 'abc123' });
  });

  it('returns null (never throws) for a file with no header', async () => {
    const root = await makeTempDir();
    const file = path.join(root, 'plain.md');
    await writeFile(file, 'no header here at all\n', 'utf8');

    await expect(readFlightHeader(file)).resolves.toBeNull();
  });

  it('returns null (never throws) for a nonexistent file — never guesses a status for unreadable content', async () => {
    await expect(readFlightHeader('/definitely/does/not/exist/mnemosyne-note.md')).resolves.toBeNull();
  });

  it('returns null for an undefined/null path', async () => {
    await expect(readFlightHeader(undefined)).resolves.toBeNull();
    await expect(readFlightHeader(null)).resolves.toBeNull();
  });
});

describe('filterHitsByStatus', () => {
  it('excludes a cross-branch provisional hit and keeps a same-branch one, resolved from real files', async () => {
    const root = await makeTempDir();
    const otherBranchFile = path.join(root, 'from-feat-x.md');
    const ownBranchFile = path.join(root, 'from-feat-y.md');
    const confirmedFile = path.join(root, 'confirmed.md');
    const legacyFile = path.join(root, 'legacy.md');

    await writeFile(
      otherBranchFile,
      '<!-- remembered via Mnemosyne @ t scope=project status=provisional branch=feat/x commit=c1 -->\nbody\n',
      'utf8',
    );
    await writeFile(
      ownBranchFile,
      '<!-- remembered via Mnemosyne @ t scope=project status=provisional branch=feat/y commit=c2 -->\nbody\n',
      'utf8',
    );
    await writeFile(
      confirmedFile,
      '<!-- remembered via Mnemosyne @ t scope=project status=confirmed branch=main commit=c3 -->\nbody\n',
      'utf8',
    );
    await writeFile(legacyFile, 'pre-la-04 legacy note, no header\n', 'utf8');

    const hits = [
      noteHit(otherBranchFile),
      noteHit(ownBranchFile),
      noteHit(confirmedFile),
      noteHit(legacyFile),
    ];

    const visible = await filterHitsByStatus(hits, { callerBranch: 'feat/y' });

    expect(visible.map((h) => h.provenance.source).sort()).toEqual(
      [ownBranchFile, confirmedFile, legacyFile].sort(),
    );
  });

  it('with the opt-in, includes the cross-branch provisional hit too', async () => {
    const root = await makeTempDir();
    const otherBranchFile = path.join(root, 'from-feat-x.md');
    await writeFile(
      otherBranchFile,
      '<!-- remembered via Mnemosyne @ t scope=project status=provisional branch=feat/x commit=c1 -->\nbody\n',
      'utf8',
    );

    const visible = await filterHitsByStatus([noteHit(otherBranchFile)], {
      callerBranch: 'feat/y',
      includeCrossBranchProvisional: true,
    });

    expect(visible).toHaveLength(1);
  });

  it('an empty hits array filters to an empty array (no crash)', async () => {
    await expect(filterHitsByStatus([], { callerBranch: 'main' })).resolves.toEqual([]);
  });
});
