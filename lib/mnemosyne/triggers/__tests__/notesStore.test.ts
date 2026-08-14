/**
 * Tests for `NotesDirectoryStatusStore` against a real (throwaway, temp-dir)
 * notes directory with real note files on disk — never mocked filesystem
 * state. Covers both header shapes this repo's two real write paths
 * produce: JS's `src/engine.mjs` (includes `scope=`) and TS's
 * `../layers/VectorLayerAdapter.ts` (does not).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NotesDirectoryStatusStore } from '../notesStore.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeNotesDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mnemosyne-notes-store-'));
  tempDirs.push(dir);
  return dir;
}

async function writeNote(
  dir: string,
  name: string,
  opts: { status: string; branch: string; commit: string; scope?: string; body?: string },
): Promise<string> {
  const file = path.join(dir, name);
  const scopeFrag = opts.scope ? `scope=${opts.scope} ` : '';
  const header = `<!-- remembered via Mnemosyne @ 2026-08-13T00:00:00.000Z ${scopeFrag}status=${opts.status} branch=${opts.branch} commit=${opts.commit} -->\n`;
  await writeFile(file, header + (opts.body ?? 'some note body\n'), 'utf8');
  return file;
}

describe('NotesDirectoryStatusStore.findByStatus', () => {
  it('finds JS-write-path notes (header includes scope=) with the requested status', async () => {
    const dir = await makeNotesDir();
    await writeNote(dir, 'a.md', { status: 'provisional', branch: 'feat/x', commit: 'a'.repeat(40), scope: 'project' });
    const store = new NotesDirectoryStatusStore({ notesDirectory: dir });

    const found = await store.findByStatus('provisional');
    expect(found).toHaveLength(1);
    expect(found[0]!.source_ref).toEqual({ branch: 'feat/x', commit_sha: 'a'.repeat(40), pr_url: null });
  });

  it('finds TS-write-path notes (header has no scope=) equally well', async () => {
    const dir = await makeNotesDir();
    await writeNote(dir, 'a.md', { status: 'provisional', branch: 'feat/x', commit: 'a'.repeat(40) }); // no scope
    const store = new NotesDirectoryStatusStore({ notesDirectory: dir });

    const found = await store.findByStatus('provisional');
    expect(found).toHaveLength(1);
    expect(found[0]!.source_ref.branch).toBe('feat/x');
  });

  it('excludes notes of a different status', async () => {
    const dir = await makeNotesDir();
    await writeNote(dir, 'confirmed.md', { status: 'confirmed', branch: 'main', commit: 'b'.repeat(40) });
    await writeNote(dir, 'provisional.md', { status: 'provisional', branch: 'feat/x', commit: 'a'.repeat(40) });
    const store = new NotesDirectoryStatusStore({ notesDirectory: dir });

    const found = await store.findByStatus('provisional');
    expect(found.map((e) => path.basename(e.id))).toEqual(['provisional.md']);
  });

  it('ignores non-.md files and files with no recognizable header', async () => {
    const dir = await makeNotesDir();
    await writeNote(dir, 'a.md', { status: 'provisional', branch: 'feat/x', commit: 'a'.repeat(40) });
    await writeFile(path.join(dir, 'readme.txt'), 'status=provisional branch=feat/x commit=deadbeef\n', 'utf8');
    await writeFile(path.join(dir, 'no-header.md'), 'just some content, no header at all\n', 'utf8');
    const store = new NotesDirectoryStatusStore({ notesDirectory: dir });

    const found = await store.findByStatus('provisional');
    expect(found).toHaveLength(1);
  });

  it('returns [] (not an error) when the notes directory does not exist yet', async () => {
    const dir = path.join(await makeNotesDir(), 'does-not-exist');
    const store = new NotesDirectoryStatusStore({ notesDirectory: dir });
    await expect(store.findByStatus('provisional')).resolves.toEqual([]);
  });
});

describe('NotesDirectoryStatusStore.updateStatus', () => {
  it('rewrites only the status= token, leaves everything else byte-identical', async () => {
    const dir = await makeNotesDir();
    const file = await writeNote(dir, 'a.md', {
      status: 'provisional',
      branch: 'feat/x',
      commit: 'a'.repeat(40),
      scope: 'project',
      body: 'decision: ship the thing\nsecond line\n',
    });
    const before = await readFile(file, 'utf8');
    const store = new NotesDirectoryStatusStore({ notesDirectory: dir });

    await store.updateStatus(
      { id: file, status: 'provisional', source_ref: { branch: 'feat/x', commit_sha: 'a'.repeat(40), pr_url: null } },
      'confirmed',
    );

    const after = await readFile(file, 'utf8');
    expect(after).toBe(before.replace('status=provisional', 'status=confirmed'));
    expect(after).toContain('decision: ship the thing\nsecond line\n'); // body untouched
  });

  it('never deletes the file on supersede — the note stays on disk, just with a new status', async () => {
    const dir = await makeNotesDir();
    const file = await writeNote(dir, 'a.md', { status: 'provisional', branch: 'feat/abandoned', commit: 'c'.repeat(40) });
    const store = new NotesDirectoryStatusStore({ notesDirectory: dir });

    await store.updateStatus(
      { id: file, status: 'provisional', source_ref: { branch: 'feat/abandoned', commit_sha: 'c'.repeat(40), pr_url: null } },
      'superseded',
    );

    const after = await readFile(file, 'utf8');
    expect(after).toContain('status=superseded');
    await expect(readFile(file, 'utf8')).resolves.toBeTruthy(); // still exists, still readable
  });

  it('a real findByStatus -> updateStatus round trip actually moves the entry between status buckets', async () => {
    const dir = await makeNotesDir();
    await writeNote(dir, 'a.md', { status: 'provisional', branch: 'feat/x', commit: 'a'.repeat(40) });
    const store = new NotesDirectoryStatusStore({ notesDirectory: dir });

    const [entry] = await store.findByStatus('provisional');
    await store.updateStatus(entry!, 'confirmed');

    expect(await store.findByStatus('provisional')).toEqual([]);
    const confirmed = await store.findByStatus('confirmed');
    expect(confirmed).toHaveLength(1);
  });

  it('refuses to rewrite a file whose header does not match the expected format', async () => {
    const dir = await makeNotesDir();
    const file = path.join(dir, 'weird.md');
    await mkdir(dir, { recursive: true });
    await writeFile(file, 'not a header at all\nbody\n', 'utf8');
    const store = new NotesDirectoryStatusStore({ notesDirectory: dir });

    await expect(
      store.updateStatus({ id: file, status: 'provisional', source_ref: { branch: 'x', commit_sha: 'y', pr_url: null } }, 'confirmed'),
    ).rejects.toThrow(/expected Mnemosyne note format/);
  });
});

/**
 * la-08-lifecycle-outcome-feedback — `NotesDirectoryStatusStore.recordOutcome`
 * against real note files on disk. Appends the outcome as a new section,
 * never touching the header line (`updateStatus`'s job, already covered
 * above) or any existing body content.
 */
describe('NotesDirectoryStatusStore.recordOutcome', () => {
  it('appends the outcome summary to the note body, leaving the header and existing body untouched', async () => {
    const dir = await makeNotesDir();
    const file = await writeNote(dir, 'a.md', {
      status: 'confirmed',
      branch: 'feat/x',
      commit: 'a'.repeat(40),
      body: 'decision: ship the thing\n',
    });
    const before = await readFile(file, 'utf8');
    const store = new NotesDirectoryStatusStore({ notesDirectory: dir });

    await store.recordOutcome(
      { id: file, status: 'confirmed', source_ref: { branch: 'feat/x', commit_sha: 'a'.repeat(40), pr_url: null } },
      { summary: "merge to 'main' (fast-forward), 1 commit(s) from 'feat/x': ship the thing" },
    );

    const after = await readFile(file, 'utf8');
    expect(after.startsWith(before)).toBe(true); // pre-existing content is a strict prefix — nothing rewritten, only appended
    expect(after).toContain("merge to 'main' (fast-forward), 1 commit(s) from 'feat/x': ship the thing");
  });

  it('a second recordOutcome call appends again rather than replacing the first outcome (never silently loses a prior lesson)', async () => {
    const dir = await makeNotesDir();
    const file = await writeNote(dir, 'a.md', { status: 'confirmed', branch: 'feat/x', commit: 'a'.repeat(40) });
    const store = new NotesDirectoryStatusStore({ notesDirectory: dir });

    await store.recordOutcome(
      { id: file, status: 'confirmed', source_ref: { branch: 'feat/x', commit_sha: 'a'.repeat(40), pr_url: null } },
      { summary: 'first outcome' },
    );
    await store.recordOutcome(
      { id: file, status: 'confirmed', source_ref: { branch: 'feat/x', commit_sha: 'a'.repeat(40), pr_url: null } },
      { summary: 'second outcome' },
    );

    const after = await readFile(file, 'utf8');
    expect(after).toContain('first outcome');
    expect(after).toContain('second outcome');
  });

  it('does not disturb the flight-status header — findByStatus still resolves the same status after an outcome is recorded', async () => {
    const dir = await makeNotesDir();
    await writeNote(dir, 'a.md', { status: 'superseded', branch: 'feat/abandoned', commit: 'c'.repeat(40) });
    const store = new NotesDirectoryStatusStore({ notesDirectory: dir });
    const [entry] = await store.findByStatus('superseded');

    await store.recordOutcome(entry!, { summary: "branch 'feat/abandoned' deleted without merging" });

    const stillSuperseded = await store.findByStatus('superseded');
    expect(stillSuperseded).toHaveLength(1);
  });
});
