/**
 * MnemosyneClient — the library Pantheon gods import to call recall()/
 * remember(). Wraps the per-layer adapters (`LayerAdapter`) behind the
 * unified `interfaces.ts` contract, so gods depend on this module instead of
 * talking to any layer (or HTTP) directly.
 *
 * Story: s2-02-client-library (epic: mnemosyne-operational-slice-2)
 *
 * NOTE on sync vs. async: `interfaces.ts` declares `RecallFn`/`RememberFn`
 * as synchronous for contract-literalism reasons (see that file's docs on
 * `MnemosyneClient`). This class's `recall()`/`remember()` return
 * `Promise<...>` instead, per the story's accepted async/sync mismatch —
 * every layer adapter does real I/O and cannot be synchronous.
 *
 * Layer selection is hardcoded to the file layer for this story; vector and
 * code-graph layers are added by later stories in this epic.
 */

import { createHash } from 'node:crypto';
import { logger as defaultLogger, type Logger } from '../../src/observability/logger.js';
import { metrics as defaultMetrics, type Metrics } from '../../src/observability/metrics.js';
import { FileLayerAdapter } from './layers/FileLayerAdapter.js';
import type { LayerAdapter } from './layers/LayerAdapter.js';
import type {
  Content,
  Hit,
  Intent,
  Layer,
  RecallResult,
  RememberResult,
  Scope,
} from './interfaces.js';

export interface MnemosyneClientOptions {
  /** Directory the file layer searches. Defaults to `process.cwd()`. */
  rootDirectory?: string;
  /** Optional adapter override for tests and future routing. */
  layerAdapter?: LayerAdapter;
  logger?: Logger;
  metrics?: Metrics;
}

export class MnemosyneClient {
  private readonly fileLayer: LayerAdapter;
  private readonly logger: Logger;
  private readonly metrics: Metrics;

  constructor(options: MnemosyneClientOptions = {}) {
    this.fileLayer = options.layerAdapter ?? new FileLayerAdapter(options.rootDirectory ?? process.cwd());
    this.logger = options.logger ?? defaultLogger;
    this.metrics = options.metrics ?? defaultMetrics;
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

    const layerStartedAt = Date.now();
    const result = await this.fileLayer.recall(query, { scope, intent: resolvedIntent });
    this.logInfo('layer_query', {
      layer: this.fileLayer.layer,
      scope,
      duration_ms: elapsedMs(layerStartedAt),
      ok: result.ok,
    });

    this.recordDegradation(result, scope);
    this.recordRecallEnd(result, startedAt);

    if (!result.ok) {
      return result;
    }

    return {
      ...result,
      hits: mergeHits(result.hits),
    };
  }

  async remember(content: Content, scope: Scope, layer?: Layer): Promise<RememberResult> {
    const startedAt = Date.now();
    const resolvedLayer = layer ?? 'file';
    const contentHash = sha256(content.text);

    this.logInfo('remember_start', {
      scope,
      layer: resolvedLayer,
      content_hash: contentHash,
    });

    const result: RememberResult = {
      ok: true,
      layer: resolvedLayer,
      provenance: {
        layer: resolvedLayer,
        source: `stub:remember:${scope}`,
        chunk_span: null,
        index_timestamp: null,
        content_hash: contentHash,
        embedder: null,
        retrieval_time: new Date().toISOString(),
      },
    };

    const durationMs = elapsedMs(startedAt);

    this.logInfo('remember_end', {
      duration_ms: durationMs,
      layer: resolvedLayer,
      scope,
      ok: true,
    });
    this.recordHistogram('remember_duration_ms', durationMs, {
      layer: resolvedLayer,
      scope,
      ok: true,
    });

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
