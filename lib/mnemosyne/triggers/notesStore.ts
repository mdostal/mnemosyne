/**
 * `MemoryStatusStore` (see `types.ts`) over the local notes directory that
 * `remember()` already writes to on both write paths this repo has
 * (`../layers/VectorLayerAdapter.ts` (TS) and `../../src/engine.mjs`'s
 * `remember()` (JS) — both default to `MNEMOSYNE_NOTES_DIR` env or
 * `~/.local/share/mnemosyne/notes`, see either file's own doc comment).
 *
 * Every note file starts with a single HTML-comment header line carrying
 * its flight status as literal text, e.g.:
 *
 *   <!-- remembered via Mnemosyne @ 2026-08-13T00:00:00.000Z scope=project status=provisional branch=feat/x commit=abc123... -->
 *
 * (the JS write path also embeds `scope=`; the TS write path does not —
 * this store tolerates both, matching is done on `status=`/`branch=`/
 * `commit=` only.) This IS the durable local record of a write's flight
 * status — `findByStatus`/`updateStatus` below read and rewrite exactly
 * that header line, nothing else in the file.
 *
 * "Never delete on supersede" (la-04/la-06's shared contract): `updateStatus`
 * only ever rewrites the `status=` token in place — the file, and every
 * other byte of it, is untouched. A `superseded` note is exactly as present
 * on disk as a `confirmed` one.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Status } from '../interfaces.js';
import type { MemoryEntryRef, MemoryStatusStore } from './types.js';

/** Matches the header line's `status=<x> branch=<y> commit=<z>` fragment, tolerant of an optional `scope=` before it (JS write path) or not (TS write path). Anchored to a HTML-comment line so it only ever matches the header, never a note's body text. */
const HEADER_LINE_RE =
  /^<!--.*\bstatus=(provisional|confirmed|superseded)\s+branch=(\S+)\s+commit=([0-9a-fA-F]{7,64})\b.*-->/;

function parseHeader(firstLine: string): { status: Status; branch: string; commit_sha: string } | null {
  const m = HEADER_LINE_RE.exec(firstLine.trim());
  if (!m) return null;
  const [, status, branch, commit_sha] = m;
  return { status: status as Status, branch: branch as string, commit_sha: commit_sha as string };
}

export interface NotesDirectoryStatusStoreOptions {
  notesDirectory: string;
}

export class NotesDirectoryStatusStore implements MemoryStatusStore {
  private readonly notesDirectory: string;

  constructor(options: NotesDirectoryStatusStoreOptions) {
    this.notesDirectory = options.notesDirectory;
  }

  async findByStatus(status: Status): Promise<MemoryEntryRef[]> {
    let names: string[];
    try {
      names = await readdir(this.notesDirectory);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return []; // no notes written yet from this cwd — not an error
      throw error;
    }

    const entries: MemoryEntryRef[] = [];
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const file = path.join(this.notesDirectory, name);
      const content = await readFile(file, 'utf8');
      const firstLine = content.split('\n', 1)[0] ?? '';
      const parsed = parseHeader(firstLine);
      if (!parsed) continue;
      if (parsed.status !== status) continue;
      entries.push({
        id: file,
        status: parsed.status,
        source_ref: { branch: parsed.branch, commit_sha: parsed.commit_sha, pr_url: null },
      });
    }
    return entries;
  }

  async updateStatus(entry: MemoryEntryRef, to: Status): Promise<void> {
    const content = await readFile(entry.id, 'utf8');
    const newlineIndex = content.indexOf('\n');
    const firstLine = newlineIndex === -1 ? content : content.slice(0, newlineIndex);
    const rest = newlineIndex === -1 ? '' : content.slice(newlineIndex);

    if (!parseHeader(firstLine)) {
      throw new Error(`${entry.id}: header line does not match the expected Mnemosyne note format, refusing to rewrite it`);
    }

    const rewritten = firstLine.replace(/\bstatus=(provisional|confirmed|superseded)\b/, `status=${to}`);
    await writeFile(entry.id, rewritten + rest, 'utf8');
  }
}
