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
}

export class MnemosyneClient {
  private readonly fileLayer: LayerAdapter;

  constructor(options: MnemosyneClientOptions = {}) {
    this.fileLayer = new FileLayerAdapter(options.rootDirectory ?? process.cwd());
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

    const result = await this.fileLayer.recall(query, { scope, intent: resolvedIntent });
    if (!result.ok) {
      return result;
    }

    return {
      ...result,
      hits: mergeHits(result.hits),
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
