import type { Intent, Layer, RecallResult, RememberResult, Scope } from '../interfaces.js';

export interface RecallOptions {
  scope?: Scope;
  intent?: Intent;
  limit?: number;
}

export interface RememberOptions {
  scope?: Scope;
  tag?: string;
}

export interface LayerAdapter {
  readonly layer: Layer;
  recall(query: string, options?: RecallOptions): Promise<RecallResult>;
  /**
   * Write content to this layer. Optional — not every layer is writable
   * (e.g. FileLayerAdapter and CodeGraphLayerAdapter are recall-only today).
   * A layer that doesn't implement this is a caller error at the
   * MnemosyneClient level, not a silent no-op.
   */
  remember?(content: string, options?: RememberOptions): Promise<RememberResult>;
}
