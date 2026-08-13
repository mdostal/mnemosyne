import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { HiveMemoryLayerAdapter } from '../HiveMemoryLayerAdapter.js';

const execFileAsync = promisify(execFile);

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-hive-memory-'));
  tempRoots.push(root);
  return root;
}

/** Builds a throwaway kg.sqlite with the real triples schema, using the real sqlite3 CLI — never touches ~/.claude/hive/kg.sqlite. */
async function makeFixtureKg(root: string, rows: Array<{ subject: string; predicate: string; object: string; valid_until?: string | null }>): Promise<string> {
  const kgPath = path.join(root, 'kg.sqlite');
  await execFileAsync('sqlite3', [
    kgPath,
    `CREATE TABLE triples (subject TEXT, predicate TEXT, object TEXT, valid_from TEXT, valid_until TEXT, source_epic TEXT, source_agent TEXT);`,
  ]);
  const sqlEscape = (s: string) => s.replace(/'/g, "''");
  for (const row of rows) {
    const validUntil = row.valid_until === undefined ? 'NULL' : row.valid_until === null ? 'NULL' : `'${sqlEscape(row.valid_until)}'`;
    await execFileAsync('sqlite3', [
      kgPath,
      `INSERT INTO triples (subject, predicate, object, valid_from, valid_until, source_epic, source_agent) VALUES ('${sqlEscape(row.subject)}', '${sqlEscape(row.predicate)}', '${sqlEscape(row.object)}', '2026-08-01T00:00:00Z', ${validUntil}, 'test-epic', 'test-agent');`,
    ]);
  }
  return kgPath;
}

async function makeFixtureMemoryFile(root: string, relPath: string, content: string): Promise<string> {
  const filePath = path.join(root, relPath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

describe('HiveMemoryLayerAdapter', () => {
  it('finds a KG triple whose subject matches the query', async () => {
    const root = await makeTempRoot();
    const kgPath = await makeFixtureKg(root, [{ subject: 'mnemosyne-pluggable-layers', predicate: 'decided', object: 'use-sqlite3-cli-not-better-sqlite3' }]);
    const adapter = new HiveMemoryLayerAdapter({ kgPath, memoryDirs: [] });

    const result = await adapter.recall('pluggable-layers');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.provenance.layer).toBe('hive-memory');
    expect(result.hits[0]?.content).toBe('mnemosyne-pluggable-layers --decided--> use-sqlite3-cli-not-better-sqlite3');
    expect(result.hits[0]?.provenance.source).toContain('mnemosyne-pluggable-layers');
  });

  it('finds a KG triple whose object matches the query', async () => {
    const root = await makeTempRoot();
    const kgPath = await makeFixtureKg(root, [{ subject: 'architect', predicate: 'decided', object: 'use-chromadb-for-l3' }]);
    const adapter = new HiveMemoryLayerAdapter({ kgPath, memoryDirs: [] });

    const result = await adapter.recall('chromadb');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.content).toContain('use-chromadb-for-l3');
  });

  it('excludes superseded triples (valid_until is set)', async () => {
    const root = await makeTempRoot();
    const kgPath = await makeFixtureKg(root, [
      { subject: 'old-decision', predicate: 'decided', object: 'target-thing', valid_until: '2026-08-05T00:00:00Z' },
    ]);
    const adapter = new HiveMemoryLayerAdapter({ kgPath, memoryDirs: [] });

    const result = await adapter.recall('target-thing');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.hits).toHaveLength(0);
  });

  it('finds a memory markdown file containing the query', async () => {
    const root = await makeTempRoot();
    const filePath = await makeFixtureMemoryFile(root, 'memories/tester/pattern.md', 'always verify the fix with a real test run\n');
    const adapter = new HiveMemoryLayerAdapter({ kgPath: path.join(root, 'no-such-kg.sqlite'), memoryDirs: [path.join(root, 'memories')] });

    const result = await adapter.recall('real test run');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.provenance.source).toBe(filePath);
    expect(result.hits[0]?.provenance.chunk_span).toEqual({ index: 1 });
    expect(result.hits[0]?.provenance.content_hash).toEqual(expect.any(String));
  });

  it('scans memory dirs recursively (nested subdirectories)', async () => {
    const root = await makeTempRoot();
    await makeFixtureMemoryFile(root, 'memories/team-a/sub/nested.md', 'the needle-token is here\n');
    const adapter = new HiveMemoryLayerAdapter({ kgPath: path.join(root, 'no-such-kg.sqlite'), memoryDirs: [path.join(root, 'memories')] });

    const result = await adapter.recall('needle-token');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.hits).toHaveLength(1);
  });

  it('kg.sqlite missing -> empty result from that source, not an error, and memory files still checked', async () => {
    const root = await makeTempRoot();
    const filePath = await makeFixtureMemoryFile(root, 'memories/x.md', 'findable-only-in-file token\n');
    const adapter = new HiveMemoryLayerAdapter({
      kgPath: path.join(root, 'definitely-does-not-exist.sqlite'),
      memoryDirs: [path.join(root, 'memories')],
    });

    const result = await adapter.recall('findable-only-in-file');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.provenance.source).toBe(filePath);
  });

  it('memory dirs missing -> empty result from that source, not an error, and KG still checked', async () => {
    const root = await makeTempRoot();
    const kgPath = await makeFixtureKg(root, [{ subject: 'only-in-kg', predicate: 'decided', object: 'findable-only-in-kg' }]);
    const adapter = new HiveMemoryLayerAdapter({ kgPath, memoryDirs: [path.join(root, 'no-such-dir')] });

    const result = await adapter.recall('findable-only-in-kg');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.hits).toHaveLength(1);
  });

  it('both sources absent -> ok:true, zero hits, not a failure', async () => {
    const root = await makeTempRoot();
    const adapter = new HiveMemoryLayerAdapter({ kgPath: path.join(root, 'no-kg.sqlite'), memoryDirs: [path.join(root, 'no-dir')] });

    const result = await adapter.recall('anything');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.hits).toHaveLength(0);
  });

  it('query matches nothing anywhere -> ok:true, zero hits', async () => {
    const root = await makeTempRoot();
    const kgPath = await makeFixtureKg(root, [{ subject: 'alpha', predicate: 'decided', object: 'beta' }]);
    await makeFixtureMemoryFile(root, 'memories/x.md', 'gamma delta\n');
    const adapter = new HiveMemoryLayerAdapter({ kgPath, memoryDirs: [path.join(root, 'memories')] });

    const result = await adapter.recall('zzz-nonexistent-query-zzz');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.hits).toHaveLength(0);
  });

  it('a SQL-metacharacter-laden query does not break the KG query (injection/escaping safety)', async () => {
    const root = await makeTempRoot();
    const kgPath = await makeFixtureKg(root, [{ subject: "weird'subject", predicate: 'decided', object: 'x' }]);
    const adapter = new HiveMemoryLayerAdapter({ kgPath, memoryDirs: [] });

    const result = await adapter.recall("weird'subject");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    // Real proof, not just "didn't crash": a literal single-quote in the
    // query is correctly escaped and still MATCHES the row containing it.
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.content).toContain("weird'subject");
  });

  it('empty query returns a RecallFailure, same contract as the other layers', async () => {
    const adapter = new HiveMemoryLayerAdapter();
    const result = await adapter.recall('   ');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('invalid_query');
  });

  it('this adapter is read-only: no INSERT/UPDATE/DELETE against sqlite, no writeFile into any memory dir', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../HiveMemoryLayerAdapter.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(source).not.toMatch(/\bUPDATE\s+triples\b/i);
    expect(source).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(source).not.toMatch(/\bwriteFile\s*\(/);
    expect(source).not.toMatch(/\bmkdir\s*\(/); // no directory creation into a Hive-owned path either
  });
});
