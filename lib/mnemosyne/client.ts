/**
 * MnemosyneClient — the library Pantheon gods import to call recall()/
 * remember(). Wraps the per-layer adapters (`LayerAdapter`) behind the
 * unified `interfaces.ts` contract, so gods depend on this module instead of
 * talking to any layer (or HTTP) directly.
 *
 * Story: s2-02-client-library (epic: mnemosyne-operational-slice-2)
 * Updated: s2-07-code-graph-layer-adapter adds structural impact recall
 * ahead of vector/file. Updated again: cr-01-graphify-default-layer changes
 * the unconfigured default's structural-graph slot from 'code-graph' to
 * 'graphify' (see layers/config.ts's doc comment for why, and its soft
 * PATH-availability fallback back to 'code-graph' for bare installs).
 *
 * NOTE on sync vs. async: `interfaces.ts` declares `RecallFn`/`RememberFn`
 * as synchronous for contract-literalism reasons (see that file's docs on
 * `MnemosyneClient`). This class's `recall()`/`remember()` return
 * `Promise<...>` instead, per the story's accepted async/sync mismatch —
 * every layer adapter does real I/O and cannot be synchronous.
 *
 * Layer selection: the structural-graph layer (graphify by default, or
 * code-graph — see layers/config.ts) is queried first for structural impact
 * recall. If it has no hits, Mnemosyne falls through to vector recall, then
 * the file layer as the final floor. Layer failures are recorded as skipped
 * layers and surfaced through `degraded: true` — never silently dropped.
 */

import { createHash } from 'node:crypto';
import { logger as defaultLogger, type Logger } from '../../src/observability/logger.js';
import { metrics as defaultMetrics, type Metrics } from '../../src/observability/metrics.js';
import type { LayerAdapter, RecallOptions } from './layers/LayerAdapter.js';
import { defaultRegistry, LayerRegistry } from './layers/registry.js';
import { resolveLayerStackConfig, type LayerStackConfig } from './layers/config.js';
import { detectGitContext, GitContextDetectionError } from './flight-status.js';
import { filterHitsByStatus } from './status-filter.js';
// Side-effect import: registers "hive-memory" into defaultRegistry() (see
// HiveMemoryLayerAdapter.ts's bottom). Not part of the default layer stack
// (config.ts's DEFAULT_LAYER_STACK_CONFIG is [graphify, vector, file] as of
// cr-01-graphify-default-layer, soft-falling-back to [code-graph, vector,
// file] only when graphify isn't on PATH) -- this only makes the name
// resolvable so MNEMOSYNE_LAYERS / a config file can actually opt into it.
// Without this import, defaultRegistry() never learns about "hive-memory"
// in a real running process (only test files and benchmarks/layer-ab-test.ts
// imported it directly, which masked this gap).
import './layers/HiveMemoryLayerAdapter.js';
import type {
  Content,
  Hit,
  Intent,
  Layer,
  LayerSkip,
  RecallFailure,
  RecallResult,
  RecallSuccess,
  RememberResult,
  Scope,
} from './interfaces.js';

export interface MnemosyneClientOptions {
  /** Directory the file layer searches. Defaults to `process.cwd()`. */
  rootDirectory?: string;
  /**
   * Override the structural-graph adapter slot (mainly for tests). Takes
   * priority over whatever the resolved layer stack would otherwise
   * construct for that slot. cr-01-graphify-default-layer: the
   * unconfigured default's first slot is now named 'graphify', not
   * 'code-graph' — this override applies to BOTH names (see
   * legacyOverrideByName below) so every existing caller that passes
   * `codeGraphLayer` to stub out "whichever adapter fills the first/
   * structural-graph cascade slot" keeps working unchanged, regardless of
   * which name the resolved stack currently uses for that slot.
   */
  codeGraphLayer?: LayerAdapter;
  /** Override the vector adapter slot (mainly for tests). See codeGraphLayer. */
  vectorLayer?: LayerAdapter;
  /** Override the file adapter slot (mainly for tests). See codeGraphLayer. */
  layerAdapter?: LayerAdapter;
  logger?: Logger;
  metrics?: Metrics;
  /**
   * Explicit layer-stack config (pl-01-layer-registry) — which layers to
   * build, in what order, with what per-layer options. Omitted: resolved
   * from MNEMOSYNE_LAYERS env, then mnemosyne.layers.json, then the
   * hardcoded default (code-graph, vector, file — today's exact behavior).
   */
  layerStack?: LayerStackConfig;
  /** Override the layer registry (mainly for tests that register a fake layer under a test-only name). Defaults to the shared module-level registry. */
  registry?: LayerRegistry;
}

/** Describes one configured layer for introspection (GET /layers, pl-03). */
export interface ConfiguredLayerInfo {
  layer: Layer;
  writable: boolean;
}

/**
 * Recall-side flight-status filtering options (la-05-recall-status-filtering).
 * Default recall is confirmed-only across branches — an entry a DIFFERENT
 * branch wrote as `provisional` is excluded — except the caller's own
 * current branch's `provisional` writes, which are always included. See
 * `status-filter.ts` for the filtering rules themselves.
 */
export interface RecallStatusOptions {
  /**
   * Directory to resolve the caller's own current git branch from (for the
   * same-branch-provisional-inclusive default). Defaults to
   * `process.cwd()`. Mirrors `RememberOptions.cwd`'s role on the write side.
   */
  cwd?: string;
  /**
   * Explicit opt-in (off by default): also surface cross-branch
   * `provisional`/`superseded` entries — for review/debugging use cases,
   * never the default.
   */
  includeCrossBranchProvisional?: boolean;
}

/**
 * kw-02-ts-client-keyword-layer: a single step of the recall() cascade.
 * Normally each configured layer is its own step ('single'). When a
 * consumer's resolved stack configures BOTH 'vector' and 'keyword',
 * those two entries collapse into one 'parallel-pair' step (see
 * `buildCascadeNodes`) so they are queried concurrently and merged as one
 * cascade slot, instead of 'keyword' sitting as its own sequential
 * zero-hit-escalation candidate. A stack that does not configure both
 * names produces ONLY 'single' nodes -- byte-identical to this class's
 * pre-kw-02 cascade, so an unconfigured/non-opted consumer sees zero
 * behavior change.
 */
type CascadeNode =
  | { kind: 'single'; adapter: LayerAdapter }
  | { kind: 'parallel-pair'; vector: LayerAdapter; keyword: LayerAdapter };

/**
 * Groups `layers` into cascade steps, collapsing a configured 'vector' +
 * 'keyword' pair into a single 'parallel-pair' step positioned at whichever
 * of the two appears FIRST in the resolved stack order (the other's own
 * slot is dropped, folded into the pair). Every other layer keeps its
 * normal single-step position and relative order. When only one (or
 * neither) of 'vector'/'keyword' is configured, this is a no-op mapping
 * (one 'single' node per layer, same order) -- the pairing behavior is
 * strictly additive and only engages when a consumer explicitly configured
 * both names.
 */
function buildCascadeNodes(layers: LayerAdapter[]): CascadeNode[] {
  const vectorIndex = layers.findIndex((adapter) => adapter.layer === 'vector');
  const keywordIndex = layers.findIndex((adapter) => adapter.layer === 'keyword');

  if (vectorIndex === -1 || keywordIndex === -1) {
    return layers.map((adapter) => ({ kind: 'single', adapter }));
  }

  const pairIndex = Math.min(vectorIndex, keywordIndex);
  const nodes: CascadeNode[] = [];
  for (let i = 0; i < layers.length; i++) {
    if (i === vectorIndex && i !== pairIndex) continue; // folded into the pair below
    if (i === keywordIndex && i !== pairIndex) continue; // folded into the pair below
    if (i === pairIndex) {
      nodes.push({ kind: 'parallel-pair', vector: layers[vectorIndex]!, keyword: layers[keywordIndex]! });
      continue;
    }
    nodes.push({ kind: 'single', adapter: layers[i]! });
  }
  return nodes;
}

/**
 * Identity used to dedupe a hit found by both the vector and keyword
 * cascade steps -- mirrors kw-01's `hitIdentity()` (src/engine.mjs, the JS
 * zero-dep server's own always-parallel implementation) so both
 * implementations agree on what counts as "the same hit," per this epic's
 * "kept in sync" convention. Prefers `chunk_span.index` when a layer
 * reports one (a real "same chunk" match); falls back to the hit's own
 * content when it doesn't, so two different, unrelated hits that merely
 * share a source (e.g. a layer with no chunk-index concept) are never
 * incorrectly collapsed into one.
 */
function hitIdentity(hit: Hit): string {
  const chunk = hit.provenance.chunk_span?.index !== undefined ? String(hit.provenance.chunk_span.index) : hit.content;
  return `${hit.provenance.source}::${chunk}`;
}

/**
 * Dedupes hits produced by the always-parallel vector+keyword cascade step
 * (kw-02) that name the exact same source+chunk -- the same underlying
 * memory found via both paths is one result, not two. The FIRST occurrence
 * in `hits` (vector's, since `queryVectorKeywordPair` concatenates vector's
 * hits before keyword's) is kept; its `also_matched` field records that
 * the OTHER layer(s) confirmed it too, so that signal isn't silently lost
 * when the duplicate is dropped. Order-preserving otherwise.
 */
function dedupeParallelHits(hits: Hit[]): Hit[] {
  const bySourceChunk = new Map<string, Hit>();
  const order: string[] = [];

  for (const hit of hits) {
    const key = hitIdentity(hit);
    const existing = bySourceChunk.get(key);
    if (!existing) {
      bySourceChunk.set(key, hit);
      order.push(key);
      continue;
    }
    if (existing.provenance.layer === hit.provenance.layer) {
      // Same layer producing two hits for the same source+chunk (e.g. a
      // layer's own internal duplication) isn't this story's "matched both
      // ways" case -- keep the first, don't synthesize also_matched.
      continue;
    }
    const alsoMatched = new Set(existing.also_matched ?? []);
    alsoMatched.add(hit.provenance.layer);
    bySourceChunk.set(key, { ...existing, also_matched: [...alsoMatched] });
  }

  return order.map((key) => bySourceChunk.get(key)!);
}

export class MnemosyneClient {
  private readonly layers: LayerAdapter[];
  private readonly cascadeNodes: CascadeNode[];
  private readonly logger: Logger;
  private readonly metrics: Metrics;

  constructor(options: MnemosyneClientOptions = {}) {
    this.logger = options.logger ?? defaultLogger;
    this.metrics = options.metrics ?? defaultMetrics;

    const registry = options.registry ?? defaultRegistry();
    const stackConfig = resolveLayerStackConfig({ explicit: options.layerStack });
    const ctx = { rootDirectory: options.rootDirectory };

    // Legacy per-slot overrides (codeGraphLayer/vectorLayer/layerAdapter)
    // apply on top of the resolved stack, replacing whichever entry has a
    // matching `.layer` name — this preserves every existing call site
    // (tests, current consumers) that injects a stub via these three fields
    // without requiring them to learn the new registry/config API.
    const legacyOverrideByName: Partial<Record<string, LayerAdapter>> = {
      'code-graph': options.codeGraphLayer,
      // graphify (cr-01-graphify-default-layer): see MnemosyneClientOptions.codeGraphLayer's
      // doc comment above — the SAME override now also applies when the resolved
      // stack names the structural-graph slot 'graphify' (the new unconfigured
      // default's first entry), so existing callers never need to learn a new
      // option name just because the default's slot name changed.
      graphify: options.codeGraphLayer,
      vector: options.vectorLayer,
      file: options.layerAdapter,
    };

    this.layers = stackConfig.layers.map((entry) => {
      const override = legacyOverrideByName[entry.name];
      if (override) return override;
      return registry.create(entry.name, entry.options ?? {}, ctx);
    });
    // kw-02-ts-client-keyword-layer: collapses a configured vector+keyword
    // pair into one parallel cascade step -- see buildCascadeNodes's doc
    // comment. `this.layers` (above) stays the flat, ungrouped list, since
    // getConfiguredLayers()/remember()'s by-name lookup still need to see
    // every configured layer individually regardless of cascade pairing.
    this.cascadeNodes = buildCascadeNodes(this.layers);
  }

  /** The resolved layer stack, in cascade order — for GET /layers (pl-03) and similar introspection. */
  getConfiguredLayers(): ConfiguredLayerInfo[] {
    return this.layers.map((layer) => ({ layer: layer.layer, writable: typeof layer.remember === 'function' }));
  }

  /**
   * `statusOptions` (la-05-recall-status-filtering) is an additional,
   * optional 4th parameter beyond `interfaces.ts`'s `RecallFn` contract
   * (`query, scope, intent?`) — same accepted deviation as this class's
   * sync-vs-async mismatch (see this file's top-of-module doc comment): a
   * function with an extra optional parameter remains assignable to the
   * narrower `RecallFn` type, so existing 3-arg call sites are unaffected.
   */
  async recall(
    query: string,
    scope: Scope,
    intent?: Intent,
    statusOptions?: RecallStatusOptions,
  ): Promise<RecallResult> {
    const startedAt = Date.now();
    const resolvedIntent = intent ?? 'narrow';
    const normalizedQuery = query.trim();

    this.logInfo('recall_start', { query, scope, intent: resolvedIntent });

    if (!normalizedQuery) {
      const result: RecallResult = {
        ok: false,
        query,
        scope,
        intent: resolvedIntent,
        error: {
          layer: null,
          message: 'query must not be empty',
          code: 'invalid_query',
        },
      };

      this.recordRecallEnd(result, startedAt);
      return result;
    }

    const recallOptions = { scope, intent: resolvedIntent };
    const layersQueried: Layer[] = [];
    const layersSkipped: LayerSkip[] = [];
    let degraded = false;
    let escalated = false;
    let finalHits: Hit[] | undefined;
    let lastResult: RecallResult | undefined;

    // Generic N-layer cascade (pl-01-layer-registry), reproducing the
    // original hand-written 3-layer chain's exact semantics:
    //   - The FIRST layer never sets `escalated` on a zero-hit continuation
    //     (code-graph is a "bonus early check", not part of the escalation
    //     ladder proper) — every SUBSEQUENT layer's zero-hit continuation
    //     does set `escalated`.
    //   - A layer FAILING (ok:false) never sets `escalated`, at any index —
    //     only a successful-but-empty continuation does.
    //   - The moment any layer succeeds with >0 hits, the cascade stops and
    //     those hits win, regardless of position.
    //   - If the cascade runs off the end without ever finding a non-empty
    //     success, the LAST layer's own raw outcome decides the return: if
    //     it failed, that RecallFailure is returned verbatim (discarding any
    //     earlier zero-hit success's tentative empty result — an escalation
    //     that ends in failure surfaces the failure, not a stale "found
    //     nothing"); if it succeeded (even empty), a RecallSuccess with its
    //     (possibly empty) hits is returned.
    // kw-02-ts-client-keyword-layer: iterates cascade STEPS, not raw
    // layers -- a step is normally one layer ('single'), but when the
    // resolved stack configures both 'vector' and 'keyword' those two
    // collapse into one 'parallel-pair' step (see buildCascadeNodes). A
    // stack that doesn't configure both produces one 'single' step per
    // layer in the same order as before, so this loop's semantics for
    // every existing (non-keyword-opted) consumer are unchanged: a
    // 'single' step's RecallSuccess always carries `layers_queried:
    // [thatLayer.layer]` and `layers_skipped: []` (every adapter's own
    // recall() sets this), so spreading them below reproduces the old
    // `layersQueried.push(layerAdapter.layer)` byte-for-byte.
    for (let i = 0; i < this.cascadeNodes.length; i++) {
      const node = this.cascadeNodes[i]!;
      const { result, skips } = await this.queryCascadeNode(node, query, recallOptions);
      lastResult = result;

      if (!result.ok) {
        degraded = true;
        layersSkipped.push(...skips);
        continue;
      }

      layersQueried.push(...result.layers_queried);
      layersSkipped.push(...result.layers_skipped);
      degraded = degraded || result.degraded;
      finalHits = result.hits;

      if (result.hits.length > 0) {
        break;
      }
      if (i > 0) {
        escalated = true;
      }
      // zero hits, not the first step's special-case pass-through — loop
      // continues to the next step (or ends naturally if this was last).
    }

    if (this.cascadeNodes.length === 0) {
      // No layer configured at all — the loop never ran, lastResult/finalHits
      // are both still undefined. Distinct from "every configured layer
      // failed" below (that case has a real lastResult to surface).
      const result: RecallFailure = {
        ok: false,
        query,
        scope,
        intent: resolvedIntent,
        error: { layer: null, message: 'no layers configured', code: 'no_layers_configured' },
      };
      this.recordRecallEnd(result, startedAt);
      return result;
    }

    if (finalHits === undefined) {
      // Every configured layer failed outright (no layer ever succeeded) —
      // lastResult is guaranteed to be the final layer's own RecallFailure.
      const failure = lastResult as RecallFailure;
      this.recordRecallEnd(failure, startedAt);
      return failure;
    }

    if (lastResult && !lastResult.ok) {
      // An earlier layer succeeded with zero hits (escalating onward), but
      // the layer we escalated TO then failed — surface that failure, don't
      // silently fall back to the earlier empty success.
      this.recordRecallEnd(lastResult, startedAt);
      return lastResult;
    }

    const filteredHits = await this.applyStatusFilter(mergeHits(finalHits), statusOptions);

    const result: RecallResult = {
      ok: true,
      query,
      scope,
      intent: resolvedIntent,
      hits: filteredHits,
      layers_queried: layersQueried,
      layers_skipped: layersSkipped,
      escalated,
      degraded,
    };

    this.recordRecallEnd(result, startedAt);
    return result;
  }

  /**
   * la-05-recall-status-filtering: resolves the caller's own current git
   * branch (from `statusOptions.cwd`, defaulting to `process.cwd()`) and
   * filters `hits` down to what default (or opted-in) recall should surface
   * — see `status-filter.ts`'s `isEntryVisible` for the exact rules.
   *
   * An unresolvable git context (detached HEAD, no repo, no `git` binary) is
   * NOT fatal here, unlike `remember()`'s loud-fail write contract — recall
   * degrades to the safe default instead: with no caller branch to prove
   * "this is my own provisional work" against, cross-branch provisional
   * entries stay excluded, exactly as they would for any other caller whose
   * branch can't be confirmed.
   */
  private async applyStatusFilter(hits: Hit[], statusOptions?: RecallStatusOptions): Promise<Hit[]> {
    let callerBranch: string | null = null;
    try {
      const context = await detectGitContext({ cwd: statusOptions?.cwd });
      callerBranch = context.branch;
    } catch (error) {
      if (!(error instanceof GitContextDetectionError)) {
        throw error;
      }
      // Ambiguous/unresolvable git context — fall through with callerBranch
      // staying null (safe default), not a recall failure.
    }

    return filterHitsByStatus(hits, {
      callerBranch,
      includeCrossBranchProvisional: statusOptions?.includeCrossBranchProvisional ?? false,
    });
  }

  async remember(content: Content, scope: Scope, layer?: Layer): Promise<RememberResult> {
    const startedAt = Date.now();
    // Auto-routing beyond a fixed default is a later story's concern (per
    // interfaces.ts's RememberFn docs) — 'vector' remains the default
    // target, matching pre-pl-01 behavior exactly when no layer is given.
    const resolvedLayer = layer ?? 'vector';
    const contentHash = sha256(content.text);

    this.logInfo('remember_start', {
      scope,
      layer: resolvedLayer,
      content_hash: contentHash,
    });

    // Resolve by NAME against the configured stack (pl-01) rather than a
    // hardcoded field — any registered, configured, writable layer can be
    // targeted this way, not only 'vector'. A name absent from the current
    // stack, or present but recall-only (no remember()), is the same
    // caller-facing error as before: 'layer_not_writable', never a silent
    // no-op or a fake success.
    const targetAdapter = this.layers.find((candidate) => candidate.layer === resolvedLayer);

    let result: RememberResult;
    if (!targetAdapter) {
      result = {
        ok: false,
        error: {
          layer: resolvedLayer,
          message: `remember() to layer '${resolvedLayer}' is not supported — that layer is not in the configured stack`,
          code: 'layer_not_writable',
        },
      };
    } else if (typeof targetAdapter.remember !== 'function') {
      result = {
        ok: false,
        error: {
          layer: resolvedLayer,
          message: `the configured '${resolvedLayer}' layer adapter does not implement remember()`,
          code: 'layer_not_writable',
        },
      };
    } else {
      result = await targetAdapter.remember(content.text, { scope });
    }

    const durationMs = elapsedMs(startedAt);

    this.logInfo('remember_end', {
      duration_ms: durationMs,
      layer: resolvedLayer,
      scope,
      ok: result.ok,
      ...(result.ok ? {} : { error_code: result.error.code }),
    });
    this.recordHistogram('remember_duration_ms', durationMs, {
      layer: resolvedLayer,
      scope,
      ok: result.ok,
    });
    if (!result.ok) {
      this.recordLayerDegraded(resolvedLayer, scope, result.error.code ?? 'remember_failed', result.error.message);
    }

    return result;
  }

  private async queryLayer(
    layerAdapter: LayerAdapter,
    query: string,
    recallOptions: RecallOptions & { scope: Scope; intent: Intent },
  ): Promise<RecallResult> {
    const layerStartedAt = Date.now();
    const result = await layerAdapter.recall(query, recallOptions);

    this.logInfo('layer_query', {
      layer: layerAdapter.layer,
      scope: recallOptions.scope,
      duration_ms: elapsedMs(layerStartedAt),
      ok: result.ok,
    });
    this.recordDegradation(result, recallOptions.scope);

    return result;
  }

  /**
   * Runs one cascade step (see `CascadeNode`). A 'single' step is exactly
   * today's per-layer query, wrapped so the caller gets a uniform
   * `{ result, skips }` shape (`skips` here is always 0-or-1 entries,
   * derived straight from `result.error` on failure — byte-identical to
   * this class's pre-kw-02 `layersSkipped.push({...})` call).
   *
   * A 'parallel-pair' step (kw-02) queries 'vector' and 'keyword'
   * CONCURRENTLY via `Promise.all` — never sequential escalation gated on
   * hit count or score, per docs/qdrant-hybrid-retrieval-experiment.md's
   * own finding that real matches and noise occupy nearly the same score
   * band for this corpus, making "is this weak enough to escalate" logic
   * unreliable here. Both are queried on EVERY recall() call that reaches
   * this step, every time — not a zero-hit fallback.
   */
  private async queryCascadeNode(
    node: CascadeNode,
    query: string,
    recallOptions: RecallOptions & { scope: Scope; intent: Intent },
  ): Promise<{ result: RecallResult; skips: LayerSkip[] }> {
    if (node.kind === 'single') {
      const result = await this.queryLayer(node.adapter, query, recallOptions);
      if (!result.ok) {
        return {
          result,
          skips: [
            {
              layer: node.adapter.layer,
              reason: result.error.code ?? `${node.adapter.layer}_unavailable`,
              detail: result.error.message,
            },
          ],
        };
      }
      return { result, skips: [] };
    }

    const [vectorResult, keywordResult] = await Promise.all([
      this.queryLayer(node.vector, query, recallOptions),
      this.queryLayer(node.keyword, query, recallOptions),
    ]);

    const skips: LayerSkip[] = [];
    const layersQueried: Layer[] = [];
    let hits: Hit[] = [];
    let degraded = false;

    if (vectorResult.ok) {
      layersQueried.push(...vectorResult.layers_queried);
      hits = hits.concat(vectorResult.hits);
      degraded = degraded || vectorResult.degraded;
    } else {
      skips.push({
        layer: 'vector',
        reason: vectorResult.error.code ?? 'vector_unavailable',
        detail: vectorResult.error.message,
      });
      degraded = true;
    }

    if (keywordResult.ok) {
      layersQueried.push(...keywordResult.layers_queried);
      hits = hits.concat(keywordResult.hits);
      degraded = degraded || keywordResult.degraded;
    } else {
      skips.push({
        layer: 'keyword',
        reason: keywordResult.error.code ?? 'keyword_unavailable',
        detail: keywordResult.error.message,
      });
      degraded = true;
    }

    if (layersQueried.length === 0) {
      // Both failed outright -- surface vector's own RecallFailure so this
      // step is treated exactly like any other failed cascade step (the
      // outer loop marks it skipped via `skips` above and continues to the
      // next configured layer, if any). Both failures are still visible
      // individually via `skips` and via each queryLayer() call's own
      // logging/metrics above, regardless of which one is surfaced as the
      // step's raw RecallResult.
      return { result: vectorResult, skips };
    }

    const merged: RecallSuccess = {
      ok: true,
      query,
      scope: recallOptions.scope,
      intent: recallOptions.intent,
      hits: dedupeParallelHits(hits),
      layers_queried: layersQueried,
      layers_skipped: skips,
      escalated: false,
      degraded,
    };
    // `skips` is already folded into `merged.layers_skipped` above, so the
    // outer loop (which reads `result.layers_skipped` on success) doesn't
    // need a second copy here.
    return { result: merged, skips: [] };
  }

  private recordRecallEnd(result: RecallResult, startedAt: number): void {
    const durationMs = elapsedMs(startedAt);
    const layersQueried = result.ok ? result.layers_queried : [];
    const hitCount = result.ok ? result.hits.length : 0;

    this.logInfo('recall_end', {
      duration_ms: durationMs,
      hit_count: hitCount,
      layers_queried: layersQueried,
      scope: result.scope,
      intent: result.intent,
      ok: result.ok,
      ...(result.ok ? {} : { error_code: result.error.code, error_layer: result.error.layer }),
    });
    this.recordHistogram('recall_duration_ms', durationMs, {
      scope: result.scope,
      intent: result.intent,
      ok: result.ok,
      hit_count: hitCount,
      layers_queried: layersQueried,
    });
  }

  private recordDegradation(result: RecallResult, scope: Scope): void {
    if (!result.ok) {
      if (result.error.layer !== null) {
        this.recordLayerDegraded(
          result.error.layer,
          scope,
          result.error.code ?? 'recall_failed',
          result.error.message,
        );
      }
      return;
    }

    for (const skipped of result.layers_skipped) {
      this.recordLayerDegraded(skipped.layer, scope, skipped.reason, skipped.detail);
    }

    if (result.degraded && result.layers_skipped.length === 0) {
      for (const layer of result.layers_queried) {
        this.recordLayerDegraded(layer, scope, 'degraded');
      }
    }
  }

  private recordLayerDegraded(layer: Layer, scope: Scope, reason: string, detail?: string): void {
    const fields = {
      layer,
      scope,
      reason,
      ...(detail === undefined ? {} : { detail }),
    };

    this.logWarn('layer_degraded', fields);
    this.recordCounter('layer_degraded_total', 1, fields);
  }

  private logInfo(event: string, fields: Record<string, unknown>): void {
    try {
      this.logger.info(event, fields);
    } catch {
      // Observability must not change recall/remember behavior.
    }
  }

  private logWarn(event: string, fields: Record<string, unknown>): void {
    try {
      this.logger.warn(event, fields);
    } catch {
      // Observability must not change recall/remember behavior.
    }
  }

  private recordHistogram(name: string, value: number, fields: Record<string, unknown>): void {
    try {
      this.metrics.histogram(name, value, fields);
    } catch {
      // Observability must not change recall/remember behavior.
    }
  }

  private recordCounter(name: string, value: number, fields: Record<string, unknown>): void {
    try {
      this.metrics.counter(name, value, fields);
    } catch {
      // Observability must not change recall/remember behavior.
    }
  }
}

/**
 * Groups hits by their provenance source (e.g. file path) and orders each
 * group by chunk position, so multiple matches within the same source read
 * top-to-bottom instead of in whatever order the layer happened to emit
 * them. Source-group order otherwise follows first-appearance order from
 * the layer result.
 */
function mergeHits(hits: Hit[]): Hit[] {
  const bySource = new Map<string, Hit[]>();

  for (const hit of hits) {
    const key = hit.provenance.source;
    const group = bySource.get(key);
    if (group) {
      group.push(hit);
    } else {
      bySource.set(key, [hit]);
    }
  }

  const merged: Hit[] = [];
  for (const group of bySource.values()) {
    group.sort((a, b) => (a.provenance.chunk_span?.index ?? 0) - (b.provenance.chunk_span?.index ?? 0));
    merged.push(...group);
  }

  return merged;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}
