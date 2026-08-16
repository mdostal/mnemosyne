import type { Intent, Layer, RecallResult, RememberResult, Scope, SourceRef, Status } from '../interfaces.js';

export interface RecallOptions {
  scope?: Scope;
  intent?: Intent;
  limit?: number;
  /**
   * ml-07-file-store-index-query: optional area hint, matching
   * `FileStoreIndex.ts`'s directory-based "area" convention (e.g. `"docs"`,
   * `"docs/guides"`, or `""` for root-level files). A layer MAY use this to
   * scope/narrow its search when it has a matching persisted index to
   * consult. Purely additive and layer-specific: layers with no area-aware
   * narrowing (every layer except `FileLayerAdapter`, as of ml-07) simply
   * ignore it. Omitting it (the default for every existing caller) requests
   * exactly today's unscoped behavior from every layer -- this field can
   * never change behavior for a caller that doesn't pass it.
   */
  area?: string;
}

export interface RememberOptions {
  scope?: Scope;
  tag?: string;
  /**
   * Explicit flight status (la-04-flight-status-schema) for this write.
   * Omit to auto-detect from real cwd git state — see `flight-status.ts`.
   * If either `status` or `sourceRef` is passed explicitly, a
   * flight-status-aware layer treats BOTH as caller-supplied: it does not
   * mix an explicit `status` with an auto-detected `sourceRef` or vice
   * versa, since a caller providing one has presumably already resolved
   * the git context themselves.
   */
  status?: Status;
  /** Explicit source_ref for this write. See `status` above. */
  sourceRef?: SourceRef;
  /** cwd to auto-detect git context from, for a flight-status-aware layer. Defaults to `process.cwd()`. Mainly for tests. */
  cwd?: string;
  /** Default-branch override for flight-status auto-detection (writes on it resolve to `confirmed`). Defaults to the repo's `origin/HEAD`, falling back to `'main'`. */
  defaultBranch?: string;
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
