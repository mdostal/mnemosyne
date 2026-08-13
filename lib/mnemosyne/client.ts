/**
 * MnemosyneClient — the library Pantheon gods import to call recall()/
 * remember(). Wraps the per-layer adapters (`LayerAdapter`) behind the
 * unified `interfaces.ts` contract, so gods depend on this module instead of
 * talking to any layer (or HTTP) directly.
 *
 * Story: s2-02-client-library (epic: mnemosyne-operational-slice-2)
 * Updated: s2-07-code-graph-layer-adapter adds structural impact recall
 * ahead of vector/file.
 *
 * NOTE on sync vs. async: `interfaces.ts` declares `RecallFn`/`RememberFn`
 * as synchronous for contract-literalism reasons (see that file's docs on
 * `MnemosyneClient`). This class's `recall()`/`remember()` return
 * `Promise<...>` instead, per the story's accepted async/sync mismatch —
 * every layer adapter does real I/O and cannot be synchronous.
 *
 * Layer selection: code-graph is queried first for structural impact recall.
 * If it has no hits, Mnemosyne falls through to vector recall, then the file
 * layer as the final floor. Layer failures are recorded as skipped layers and
 * surfaced through `degraded: true` — never silently dropped.
 */

import { createHash } from 'node:crypto';
import { logger as defaultLogger, type Logger } from '../../src/observability/logger.js';
import { metrics as defaultMetrics, type Metrics } from '../../src/observability/metrics.js';
import { CodeGraphLayerAdapter } from './layers/CodeGraphLayerAdapter.js';
import { FileLayerAdapter } from './layers/FileLayerAdapter.js';
import type { LayerAdapter, RecallOptions } from './layers/LayerAdapter.js';
import { VectorLayerAdapter } from './layers/VectorLayerAdapter.js';
import type {
  Content,
  Hit,
  Intent,
  Layer,
  LayerSkip,
  RecallResult,
  RememberResult,
  Scope,
} from './interfaces.js';

export interface MnemosyneClientOptions {
  /** Directory the file layer searches. Defaults to `process.cwd()`. */
  rootDirectory?: string;
  /** Override the code-graph adapter (mainly for tests). Defaults to a real `CodeGraphLayerAdapter`. */
  codeGraphLayer?: LayerAdapter;
  /** Override the vector layer adapter (mainly for tests). Defaults to a real `VectorLayerAdapter`. */
  vectorLayer?: LayerAdapter;
  /** Override the file fallback adapter (mainly for tests). Defaults to a real `FileLayerAdapter`. */
  layerAdapter?: LayerAdapter;
  logger?: Logger;
  metrics?: Metrics;
}

export class MnemosyneClient {
  private readonly codeGraphLayer: LayerAdapter;
  private readonly fileLayer: LayerAdapter;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly vectorLayer: LayerAdapter;

  constructor(options: MnemosyneClientOptions = {}) {
    this.codeGraphLayer = options.codeGraphLayer ?? new CodeGraphLayerAdapter();
    this.fileLayer = options.layerAdapter ?? new FileLayerAdapter(options.rootDirectory ?? process.cwd());
    this.logger = options.logger ?? defaultLogger;
    this.metrics = options.metrics ?? defaultMetrics;
    this.vectorLayer = options.vectorLayer ?? new VectorLayerAdapter();
  }

  async recall(query: string, scope: Scope, intent?: Intent): Promise<RecallResult> {
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
    let hits: Hit[];
    let degraded = false;
    let escalated = false;

    const codeGraphResult = await this.queryLayer(this.codeGraphLayer, query, recallOptions);
    if (codeGraphResult.ok) {
      layersQueried.push('code-graph');
      degraded = degraded || codeGraphResult.degraded;
      hits = codeGraphResult.hits;

      if (hits.length > 0) {
        const result: RecallResult = {
          ok: true,
          query,
          scope,
          intent: resolvedIntent,
          hits: mergeHits(hits),
          layers_queried: layersQueried,
          layers_skipped: layersSkipped,
          escalated,
          degraded,
        };

        this.recordRecallEnd(result, startedAt);
        return result;
      }
    } else {
      degraded = true;
      layersSkipped.push({
        layer: 'code-graph',
        reason: codeGraphResult.error.code ?? 'code_graph_unavailable',
        detail: codeGraphResult.error.message,
      });
    }

    const vectorResult = await this.queryLayer(this.vectorLayer, query, recallOptions);
    if (vectorResult.ok) {
      layersQueried.push('vector');
      degraded = degraded || vectorResult.degraded;
      hits = vectorResult.hits;

      if (hits.length === 0) {
        escalated = true;
        const fileResult = await this.queryLayer(this.fileLayer, query, recallOptions);
        if (!fileResult.ok) {
          this.recordRecallEnd(fileResult, startedAt);
          return fileResult;
        }
        layersQueried.push('file');
        degraded = degraded || fileResult.degraded;
        hits = fileResult.hits;
      }
    } else {
      degraded = true;
      layersSkipped.push({
        layer: 'vector',
        reason: vectorResult.error.code ?? 'vector_unreachable',
        detail: vectorResult.error.message,
      });

      const fileResult = await this.queryLayer(this.fileLayer, query, recallOptions);
      if (!fileResult.ok) {
        this.recordRecallEnd(fileResult, startedAt);
        return fileResult;
      }
      layersQueried.push('file');
      degraded = degraded || fileResult.degraded;
      hits = fileResult.hits;
    }

    const result: RecallResult = {
      ok: true,
      query,
      scope,
      intent: resolvedIntent,
      hits: mergeHits(hits),
      layers_queried: layersQueried,
      layers_skipped: layersSkipped,
      escalated,
      degraded,
    };

    this.recordRecallEnd(result, startedAt);
    return result;
  }

  async remember(content: Content, scope: Scope, layer?: Layer): Promise<RememberResult> {
    const startedAt = Date.now();
    // Auto-routing beyond a fixed default is a later story's concern (per
    // interfaces.ts's RememberFn docs) — today the only writable layer is
    // vector, so an explicit non-vector `layer` is a caller error, not a
    // silent reroute.
    const resolvedLayer = layer ?? 'vector';
    const contentHash = sha256(content.text);

    this.logInfo('remember_start', {
      scope,
      layer: resolvedLayer,
      content_hash: contentHash,
    });

    let result: RememberResult;
    if (resolvedLayer !== 'vector') {
      result = {
        ok: false,
        error: {
          layer: resolvedLayer,
          message: `remember() to layer '${resolvedLayer}' is not supported — only 'vector' is writable today`,
          code: 'layer_not_writable',
        },
      };
    } else if (typeof this.vectorLayer.remember !== 'function') {
      result = {
        ok: false,
        error: {
          layer: resolvedLayer,
          message: 'the configured vector layer adapter does not implement remember()',
          code: 'layer_not_writable',
        },
      };
    } else {
      result = await this.vectorLayer.remember(content.text, { scope });
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
