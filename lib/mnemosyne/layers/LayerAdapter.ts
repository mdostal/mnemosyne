import type { Intent, Layer, RecallResult, Scope } from '../interfaces.js';

export interface RecallOptions {
  scope?: Scope;
  intent?: Intent;
  limit?: number;
}

export interface LayerAdapter {
  readonly layer: Layer;
  recall(query: string, options?: RecallOptions): Promise<RecallResult>;
}
