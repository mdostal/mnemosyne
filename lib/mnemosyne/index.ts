export { MnemosyneClient } from './client.js';
export type { MnemosyneClientOptions } from './client.js';

export { FileLayerAdapter } from './layers/FileLayerAdapter.js';
export type { FileLayerAdapterOptions } from './layers/FileLayerAdapter.js';
export { VectorLayerAdapter } from './layers/VectorLayerAdapter.js';
export type { VectorLayerAdapterOptions } from './layers/VectorLayerAdapter.js';
export { KeywordLayerAdapter } from './layers/KeywordLayerAdapter.js';
export type { KeywordLayerAdapterOptions } from './layers/KeywordLayerAdapter.js';
export type { LayerAdapter, RecallOptions } from './layers/LayerAdapter.js';

export type {
  ChunkSpan,
  Content,
  DegradedWrite,
  Hit,
  Intent,
  Layer,
  LayerSkip,
  MnemosyneClient as MnemosyneClientInterface,
  Provenance,
  RecallError,
  RecallFailure,
  RecallFn,
  RecallResult,
  RecallSuccess,
  RememberError,
  RememberFailure,
  RememberFn,
  RememberResult,
  RememberSuccess,
  Scope,
} from './interfaces.js';
