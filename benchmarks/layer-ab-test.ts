/**
 * layer-ab-test — real A/B comparison of two-or-more layer-stack configs
 * (pl-03-layer-ab-testing). A REPORTING tool, not a pass/fail gate: layer
 * tradeoffs (coverage vs. noise vs. latency) are an operator judgment call,
 * this script's job is to surface real numbers, not decide a winner.
 *
 * Follows recall-vs-find.ts's real-measurement discipline exactly (that
 * benchmark shipped broken once this session — never awaited, fake
 * baseline — this one does not repeat that mistake): every number below
 * comes from an actual MnemosyneClient.recall() call against real
 * MnemosyneClientOptions.layerStack configs, never simulated/estimated.
 *
 * Extended by la-10-graphify-ab-benchmark to add a `graphify`-configured
 * stack (swaps the 'code-graph' slot for 'graphify', keeping 'vector'/'file'
 * identical to `baseline`, so the only variable between the two configs is
 * the graph layer itself) run against the SAME real query set as `baseline`
 * — a direct, apples-to-apples comparison of the two graph-layer
 * implementations, feeding the go/no-go retirement call documented in
 * docs/layer-architecture-v2-plan.md. This story does NOT remove
 * 'code-graph' — both layer names stay registered (registry.ts) and both
 * configs stay in this file's comparison regardless of the outcome.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MnemosyneClient } from '../lib/mnemosyne/client.js';
import type { Layer, Scope } from '../lib/mnemosyne/interfaces.js';
import type { LayerStackConfig } from '../lib/mnemosyne/layers/config.js';
import { estimateTokens } from './recall-vs-find.js';
// Import for its registration side-effect only — makes 'hive-memory' available
// to any LayerStackConfig this script builds, matching how a real consumer
// would opt in.
import '../lib/mnemosyne/layers/HiveMemoryLayerAdapter.js';

export interface NamedLayerStackConfig {
  name: string;
  config: LayerStackConfig;
}

export interface PerQueryResult {
  query: string;
  hitCount: number;
  tokenCost: number;
  latencyMs: number;
  contributingLayers: Layer[];
  ok: boolean;
}

export interface ConfigReport {
  name: string;
  layers: string[];
  perQuery: PerQueryResult[];
  totalHits: number;
  totalTokens: number;
  avgLatencyMs: number;
}

/** Runs one query against one config, measuring real latency/hits/tokens — never estimated. */
async function runOne(client: MnemosyneClient, query: string, scope: Scope): Promise<PerQueryResult> {
  const startedAt = Date.now();
  const result = await client.recall(query, scope, 'broad');
  const latencyMs = Date.now() - startedAt;

  if (!result.ok) {
    return { query, hitCount: 0, tokenCost: 0, latencyMs, contributingLayers: [], ok: false };
  }

  let tokenCost = 0;
  const contributingLayers = new Set<Layer>();
  for (const hit of result.hits) {
    tokenCost += estimateTokens(hit.content);
    contributingLayers.add(hit.provenance.layer);
  }

  return {
    query,
    hitCount: result.hits.length,
    tokenCost,
    latencyMs,
    contributingLayers: [...contributingLayers],
    ok: true,
  };
}

/** Runs a full query set against one named config, aggregating real per-query results. */
export async function runConfig(
  namedConfig: NamedLayerStackConfig,
  queries: string[],
  scope: Scope,
  rootDirectory: string,
): Promise<ConfigReport> {
  const client = new MnemosyneClient({ rootDirectory, layerStack: namedConfig.config });
  const perQuery: PerQueryResult[] = [];
  for (const query of queries) {
    perQuery.push(await runOne(client, query, scope));
  }

  const totalHits = perQuery.reduce((sum, r) => sum + r.hitCount, 0);
  const totalTokens = perQuery.reduce((sum, r) => sum + r.tokenCost, 0);
  const avgLatencyMs = perQuery.length > 0 ? perQuery.reduce((sum, r) => sum + r.latencyMs, 0) / perQuery.length : 0;

  return {
    name: namedConfig.name,
    layers: namedConfig.config.layers.map((l) => l.name),
    perQuery,
    totalHits,
    totalTokens,
    avgLatencyMs,
  };
}

/** Runs the same query set against every given config and returns all reports — the actual A/B comparison. */
export async function runAbTest(
  configs: NamedLayerStackConfig[],
  queries: string[],
  scope: Scope,
  rootDirectory: string,
): Promise<ConfigReport[]> {
  const reports: ConfigReport[] = [];
  for (const namedConfig of configs) {
    reports.push(await runConfig(namedConfig, queries, scope, rootDirectory));
  }
  return reports;
}

function printReport(report: ConfigReport): void {
  console.log(`\n=== ${report.name} [${report.layers.join(' -> ')}] ===`);
  for (const r of report.perQuery) {
    console.log(
      `  ${JSON.stringify(r.query)}: ok=${r.ok} hits=${r.hitCount} tokens=${r.tokenCost} latency=${r.latencyMs}ms layers=[${r.contributingLayers.join(',')}]`,
    );
  }
  console.log(
    `  TOTAL: hits=${report.totalHits} tokens=${report.totalTokens} avg_latency=${report.avgLatencyMs.toFixed(1)}ms`,
  );
}

/**
 * la-10: prints a direct head-to-head between two named reports — the exact
 * numbers a go/no-go retirement recommendation should be grounded in
 * (docs/layer-architecture-v2-plan.md), not left implicit in the raw
 * per-config listing above.
 */
function printHeadToHead(a: ConfigReport, b: ConfigReport): void {
  const okCount = (r: ConfigReport) => r.perQuery.filter((q) => q.ok).length;
  console.log(`\n=== head-to-head: ${a.name} vs ${b.name} ===`);
  console.log(`  hits:           ${a.name}=${a.totalHits}  ${b.name}=${b.totalHits}`);
  console.log(`  tokens:         ${a.name}=${a.totalTokens}  ${b.name}=${b.totalTokens}`);
  console.log(`  avg_latency_ms: ${a.name}=${a.avgLatencyMs.toFixed(1)}  ${b.name}=${b.avgLatencyMs.toFixed(1)}`);
  console.log(
    `  ok_queries:     ${a.name}=${okCount(a)}/${a.perQuery.length}  ${b.name}=${okCount(b)}/${b.perQuery.length}`,
  );
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const scope: Scope = (process.argv[2] as Scope | undefined) ?? 'project';

  const queries = process.argv.slice(3);
  const queryList = queries.length > 0 ? queries : ['mnemosyne', 'layer registry', 'secrets-adapter'];

  const configs: NamedLayerStackConfig[] = [
    { name: 'baseline (code-graph)', config: { layers: [{ name: 'code-graph' }, { name: 'vector' }, { name: 'file' }] } },
    // la-10: 'vector'/'file' held identical to baseline — only the graph
    // layer itself (code-graph -> graphify) varies, so any delta in
    // hits/tokens/latency below is attributable to the graph layer swap.
    { name: 'graphify', config: { layers: [{ name: 'graphify' }, { name: 'vector' }, { name: 'file' }] } },
    {
      name: 'with-hive-memory',
      config: { layers: [{ name: 'code-graph' }, { name: 'vector' }, { name: 'file' }, { name: 'hive-memory' }] },
    },
  ];

  console.log(`layer A/B benchmark — scope=${scope} root=${repoRoot} queries=${JSON.stringify(queryList)}`);
  const reports = await runAbTest(configs, queryList, scope, repoRoot);
  for (const report of reports) {
    printReport(report);
  }

  const baselineReport = reports.find((r) => r.name === 'baseline (code-graph)');
  const graphifyReport = reports.find((r) => r.name === 'graphify');
  if (baselineReport && graphifyReport) {
    printHeadToHead(baselineReport, graphifyReport);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
