import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MnemosyneClient } from '../lib/mnemosyne/client.js';
import type { Intent, RecallResult, Scope } from '../lib/mnemosyne/interfaces.js';

/**
 * Structural, not nominal: accepts the real async `MnemosyneClient` class
 * (its `recall()` returns `Promise<RecallResult>`) as well as any
 * synchronous test-double shaped like the `interfaces.ts` contract (`await`
 * on a non-Promise value just resolves immediately) — so this benchmark
 * works against both real data and hermetic test fixtures without requiring
 * every caller to redesign around a concrete class.
 */
export interface RecallCapable {
  recall(query: string, scope: Scope, intent?: Intent): RecallResult | Promise<RecallResult>;
}

export function estimateTokens(text: string): number {
  // Rough heuristic: 4 chars per token
  return Math.ceil(text.length / 4);
}

const DEFAULT_IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage']);

async function* walk(directory: string, ignored: Set<string>): AsyncGenerator<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignored.has(entry.name)) {
        yield* walk(entryPath, ignored);
      }
      continue;
    }
    if (entry.isFile()) {
      yield entryPath;
    }
  }
}

/**
 * The "find" baseline: a real grep-equivalent — scan every file under
 * `rootDirectory` for a literal match of `query`, then sum the token cost of
 * reading each MATCHING FILE IN FULL. This is the realistic cost of a
 * find/grep-then-read-whole-file workflow, which is what recall() (returning
 * targeted chunks, not whole files) is meant to beat. Not a hardcoded
 * constant — actually walks the tree and actually reads matching files.
 */
export async function measureFindTokens(
  query: string,
  rootDirectory: string,
  ignoredDirectories: Set<string> = DEFAULT_IGNORED_DIRECTORIES,
): Promise<{ tokens: number; filesMatched: number }> {
  let tokens = 0;
  let filesMatched = 0;
  for await (const filePath of walk(rootDirectory, ignoredDirectories)) {
    let content: string;
    try {
      content = await readFile(filePath, 'utf8');
    } catch {
      continue; // unreadable (binary, permissions, symlink loop, ...) - grep would skip too
    }
    if (content.includes(query)) {
      filesMatched += 1;
      tokens += estimateTokens(content);
    }
  }
  return { tokens, filesMatched };
}

export interface TokenCostComparison {
  recallOk: boolean;
  recallTokens: number;
  findTokens: number;
  filesMatched: number;
  ratio: number;
  beatsFind: boolean;
}

/**
 * Compares MnemosyneClient.recall()'s real token cost against the real
 * "find" baseline above, for the same query/scope/rootDirectory. Both sides
 * measure real data — no synthesized/hardcoded numbers on either side.
 */
export async function compareTokenCost(
  client: RecallCapable,
  query: string,
  scope: Scope,
  rootDirectory: string,
): Promise<TokenCostComparison> {
  const [result, find] = await Promise.all([
    Promise.resolve(client.recall(query, scope, 'broad')),
    measureFindTokens(query, rootDirectory),
  ]);

  let recallTokens = 0;
  if (result.ok) {
    for (const hit of result.hits) {
      recallTokens += estimateTokens(hit.content);
    }
  }

  const ratio = find.tokens > 0 ? recallTokens / find.tokens : 0;

  return {
    recallOk: result.ok,
    recallTokens,
    findTokens: find.tokens,
    filesMatched: find.filesMatched,
    ratio,
    beatsFind: result.ok && recallTokens <= find.tokens,
  };
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const query = process.argv[2] ?? 'Mnemosyne';
  const scope = (process.argv[3] as Scope | undefined) ?? 'project';

  const client = new MnemosyneClient({ rootDirectory: repoRoot });
  const comparison = await compareTokenCost(client, query, scope, repoRoot);

  console.log(`recall-vs-find benchmark — query=${JSON.stringify(query)} scope=${scope} root=${repoRoot}`);
  console.log(`  recall: ok=${comparison.recallOk} tokens=${comparison.recallTokens}`);
  console.log(`  find:   files_matched=${comparison.filesMatched} tokens=${comparison.findTokens}`);
  console.log(`  ratio (recall/find): ${comparison.ratio.toFixed(4)}`);
  console.log(`  beats find: ${comparison.beatsFind}`);

  if (!comparison.recallOk) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
