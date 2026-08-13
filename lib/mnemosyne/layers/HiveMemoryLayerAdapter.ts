/**
 * HiveMemoryLayerAdapter — plugin-hive's own memory system (kg.sqlite +
 * per-agent/team markdown files) as a real, read-only Mnemosyne layer
 * (pl-02-hive-memory-layer).
 *
 * Two independent, OPTIONAL data sources, neither ever written to by this
 * adapter — plugin-hive owns writes to its own memory system, this adapter
 * only reads it:
 *
 *   1. The L2 knowledge graph (~/.claude/hive/kg.sqlite): subject-predicate-
 *      object triples. Queried via the `sqlite3` CLI (shelled out, exactly
 *      like VectorLayerAdapter shells to `swarm-memory` — never a native
 *      binding link; better-sqlite3, used by CodeGraphLayerAdapter, is known
 *      to segfault on at least one real dev machine, and this file
 *      deliberately avoids that class of risk). No embeddings exist here —
 *      this is keyword/substring matching against subject/object, not
 *      semantic search; see knowledge-graph-schema.md for the real schema.
 *   2. Per-agent (~/.claude/hive/memories/<agent>/ ...) and team-scoped
 *      (<repoRoot>/.pHive/team-memories/<team>/ ...) markdown memory files,
 *      scanned recursively — plain substring scan, same philosophy as
 *      FileLayerAdapter's grep.
 *
 * Both sources degrade gracefully to zero hits when absent (fresh install,
 * no kg.sqlite yet, no memory dirs yet) rather than erroring the whole
 * recall() call — this layer is additive context, never a hard dependency.
 */
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import type { Hit, RecallFailure, RecallResult, RecallSuccess } from '../interfaces.js';
import type { LayerAdapter, RecallOptions } from './LayerAdapter.js';
import { defaultRegistry } from './registry.js';

const execFileAsync = promisify(execFile);

const DEFAULT_KG_PATH = path.join(homedir(), '.claude', 'hive', 'kg.sqlite');
const DEFAULT_MEMORY_DIR = path.join(homedir(), '.claude', 'hive', 'memories');
const DEFAULT_TEAM_MEMORY_DIR = path.join(process.cwd(), '.pHive', 'team-memories');
const DEFAULT_SQLITE_BIN = process.env.MNEMOSYNE_SQLITE_BIN || 'sqlite3';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_LIMIT = 10;

export interface HiveMemoryLayerAdapterOptions {
  /** Path to the L2 knowledge graph sqlite file. Defaults to ~/.claude/hive/kg.sqlite. */
  kgPath?: string;
  /** Directories to scan for memory markdown files. Defaults to [~/.claude/hive/memories, <cwd>/.pHive/team-memories], scanned recursively. */
  memoryDirs?: string[];
  /** `sqlite3` executable override, mainly for tests. */
  sqliteBin?: string;
  timeoutMs?: number;
  /** Max hits per source (KG and memory-files each capped independently). */
  limit?: number;
}

interface TripleRow {
  subject: string;
  predicate: string;
  object: string;
  source_epic: string | null;
  source_agent: string | null;
  valid_from: string;
}

export class HiveMemoryLayerAdapter implements LayerAdapter {
  readonly layer = 'hive-memory' as const;

  private readonly kgPath: string;
  private readonly memoryDirs: string[];
  private readonly sqliteBin: string;
  private readonly timeoutMs: number;
  private readonly limit: number;

  constructor(options: HiveMemoryLayerAdapterOptions = {}) {
    this.kgPath = options.kgPath ?? DEFAULT_KG_PATH;
    this.memoryDirs = options.memoryDirs ?? [DEFAULT_MEMORY_DIR, DEFAULT_TEAM_MEMORY_DIR];
    this.sqliteBin = options.sqliteBin ?? DEFAULT_SQLITE_BIN;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.limit = options.limit ?? DEFAULT_LIMIT;
  }

  async recall(query: string, options: RecallOptions = {}): Promise<RecallResult> {
    const normalizedQuery = query.trim();
    const scope = options.scope ?? 'project';
    const intent = options.intent ?? 'narrow';

    if (!normalizedQuery) {
      return this.failure(query, scope, intent, 'invalid_query', 'query must not be empty');
    }

    const [kgHits, fileHits] = await Promise.all([
      this.queryKnowledgeGraph(normalizedQuery),
      this.scanMemoryFiles(normalizedQuery),
    ]);

    return {
      ok: true,
      query,
      scope,
      intent,
      hits: [...kgHits, ...fileHits],
      layers_queried: ['hive-memory'],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    } satisfies RecallSuccess;
  }

  // --- source 1: the L2 knowledge graph -------------------------------------

  private async queryKnowledgeGraph(query: string): Promise<Hit[]> {
    const pattern = `%${escapeSqliteLike(query)}%`;
    const sql =
      `SELECT subject, predicate, object, source_epic, source_agent, valid_from FROM triples ` +
      `WHERE (subject LIKE '${pattern}' ESCAPE '\\' OR object LIKE '${pattern}' ESCAPE '\\') ` +
      `AND valid_until IS NULL LIMIT ${this.limit};`;

    let stdout: string;
    try {
      const result = await execFileAsync(this.sqliteBin, ['-json', this.kgPath, sql], {
        timeout: this.timeoutMs,
      });
      stdout = result.stdout;
    } catch {
      // Missing kg.sqlite, missing sqlite3 binary, a locked/corrupt db, a
      // timeout — all degrade to "this optional source found nothing" per
      // this layer's graceful-degradation contract. This is a Mnemosyne
      // consumer of plugin-hive's data, not plugin-hive's own health check;
      // a broken KG here is not a Mnemosyne infra failure.
      return [];
    }

    if (!stdout.trim()) {
      return [];
    }

    let rows: TripleRow[];
    try {
      rows = JSON.parse(stdout) as TripleRow[];
    } catch {
      return [];
    }

    const retrievalTime = new Date().toISOString();
    return rows.map((row) => ({
      content: `${row.subject} --${row.predicate}--> ${row.object}`,
      provenance: {
        layer: 'hive-memory',
        source: `kg:${row.subject}|${row.predicate}|${row.object}`,
        chunk_span: null,
        index_timestamp: row.valid_from ?? null,
        content_hash: null,
        embedder: null,
        retrieval_time: retrievalTime,
      },
    }));
  }

  // --- source 2: per-agent / team memory markdown files ---------------------

  private async scanMemoryFiles(query: string): Promise<Hit[]> {
    const needle = query.toLowerCase();
    const hits: Hit[] = [];
    const retrievalTime = new Date().toISOString();

    for (const dir of this.memoryDirs) {
      for await (const filePath of this.walkMarkdown(dir)) {
        if (hits.length >= this.limit) return hits;

        let content: string;
        try {
          content = await readFile(filePath, 'utf8');
        } catch {
          continue; // file vanished between listing and read, or unreadable — skip, don't fail the whole scan
        }

        const lines = content.split(/\r?\n/);
        for (const [offset, line] of lines.entries()) {
          if (!line.toLowerCase().includes(needle)) continue;
          hits.push({
            content: line,
            provenance: {
              layer: 'hive-memory',
              source: filePath,
              chunk_span: { index: offset + 1 },
              index_timestamp: null,
              content_hash: sha256(line),
              embedder: null,
              retrieval_time: retrievalTime,
            },
          });
          if (hits.length >= this.limit) return hits;
        }
      }
    }

    return hits;
  }

  private async *walkMarkdown(directory: string): AsyncGenerator<string> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return; // directory doesn't exist / unreadable — this optional source is simply absent
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        yield* this.walkMarkdown(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.md')) {
        yield entryPath;
      }
    }
  }

  private failure(
    query: string,
    scope: RecallFailure['scope'],
    intent: RecallFailure['intent'],
    code: string,
    message: string,
  ): RecallFailure {
    return {
      ok: false,
      query,
      scope,
      intent,
      error: { layer: 'hive-memory', message, code },
    };
  }
}

function escapeSqliteLike(value: string): string {
  // Escape SQL LIKE metacharacters AND the single-quote string delimiter —
  // this is interpolated directly into a SQL string (the sqlite3 CLI has no
  // straightforward bind-parameter mode over -json/one-shot invocation), so
  // correctness here is a real injection boundary, not just LIKE-pattern
  // hygiene. Standard SQL single-quote escape is doubling it.
  return value.replace(/'/g, "''").replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// Register into the shared default registry at import time — consumers that
// want "hive-memory" available just need to import this module once (e.g.
// from the layer stack config resolution point) before constructing a
// MnemosyneClient with it in the configured stack.
defaultRegistry().register('hive-memory', (options) => new HiveMemoryLayerAdapter(options as HiveMemoryLayerAdapterOptions));
