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
import { CodeGraphLayerAdapter } from './layers/CodeGraphLayerAdapter.js';
import { FileLayerAdapter } from './layers/FileLayerAdapter.js';
import type { LayerAdapter } from './layers/LayerAdapter.js';
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
}

export class MnemosyneClient {
  private readonly codeGraphLayer: LayerAdapter;
  private readonly fileLayer: LayerAdapter;
  private readonly vectorLayer: LayerAdapter;

  constructor(options: MnemosyneClientOptions = {}) {
    this.codeGraphLayer = options.codeGraphLayer ?? new CodeGraphLayerAdapter();
    this.fileLayer = new FileLayerAdapter(options.rootDirectory ?? process.cwd());
    this.vectorLayer = options.vectorLayer ?? new VectorLayerAdapter();
  }

  async recall(query: string, scope: Scope, intent?: Intent): Promise<RecallResult> {
    const resolvedIntent = intent ?? 'narrow';
    const normalizedQuery = query.trim();

    if (!normalizedQuery) {
      return {
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
    }

    const recallOptions = { scope, intent: resolvedIntent };
    const layersQueried: Layer[] = [];
    const layersSkipped: LayerSkip[] = [];
    let hits: Hit[];
    let degraded = false;
    let escalated = false;

    const codeGraphResult = await this.codeGraphLayer.recall(query, recallOptions);
    if (codeGraphResult.ok) {
      layersQueried.push('code-graph');
      degraded = degraded || codeGraphResult.degraded;
      hits = codeGraphResult.hits;

      if (hits.length > 0) {
        return {
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
      }
    } else {
      degraded = true;
      layersSkipped.push({
        layer: 'code-graph',
        reason: codeGraphResult.error.code ?? 'code_graph_unavailable',
        detail: codeGraphResult.error.message,
      });
    }

    const vectorResult = await this.vectorLayer.recall(query, recallOptions);
    if (vectorResult.ok) {
      layersQueried.push('vector');
      degraded = degraded || vectorResult.degraded;
      hits = vectorResult.hits;

      if (hits.length === 0) {
        escalated = true;
        const fileResult = await this.fileLayer.recall(query, recallOptions);
        if (!fileResult.ok) {
          return fileResult;
        }
        layersQueried.push('file');
        hits = fileResult.hits;
      }
    } else {
      degraded = true;
      layersSkipped.push({
        layer: 'vector',
        reason: vectorResult.error.code ?? 'vector_unreachable',
        detail: vectorResult.error.message,
      });

      const fileResult = await this.fileLayer.recall(query, recallOptions);
      if (!fileResult.ok) {
        return fileResult;
      }
      layersQueried.push('file');
      hits = fileResult.hits;
    }

    return {
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
  }

  async remember(content: Content, scope: Scope, layer?: Layer): Promise<RememberResult> {
    const resolvedLayer = layer ?? 'file';

    return {
      ok: true,
      layer: resolvedLayer,
      provenance: {
        layer: resolvedLayer,
        source: `stub:remember:${scope}`,
        chunk_span: null,
        index_timestamp: null,
        content_hash: sha256(content.text),
        embedder: null,
        retrieval_time: new Date().toISOString(),
      },
    };
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
