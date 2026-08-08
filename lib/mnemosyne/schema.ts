/**
 * JSON Schema (2020-12) definitions mirroring the wire-facing types in
 * `interfaces.ts` — `Provenance`, `RecallResult`, `RememberResult`.
 *
 * These are plain data (`as const` object literals), suitable for handing to
 * a runtime validator such as ajv:
 *
 *   import Ajv from 'ajv/dist/2020';
 *   import addFormats from 'ajv-formats';
 *   const ajv = new Ajv();
 *   addFormats(ajv);
 *   const validateRecall = ajv.compile(RecallResultSchema);
 *
 * There is no runtime logic in this file itself — no validator is
 * constructed or invoked here. That belongs to the layer implementations
 * that consume these schemas (later stories), not to the contract
 * definition story.
 *
 * Each exported schema below is self-contained (embeds the full shared
 * `$defs` set) so it can be compiled independently without wiring up
 * cross-schema `$id` resolution.
 */

/** Shared subschema definitions, referenced via `$ref: '#/$defs/<Name>'` from each top-level schema below. */
const $defs = {
  Layer: {
    type: 'string',
    enum: ['meta', 'enterprise', 'project', 'code-graph', 'vector', 'file'],
  },

  Scope: {
    type: 'string',
    enum: ['project', 'enterprise', 'meta'],
  },

  Intent: {
    type: 'string',
    enum: ['narrow', 'broad'],
  },

  ChunkSpan: {
    // Nullable as a whole: layers with no chunking concept report `null`
    // for `Provenance.chunk_span`, never omit the key.
    type: ['object', 'null'],
    properties: {
      index: { type: 'integer', minimum: 0 },
      start: { type: 'integer', minimum: 0 },
      end: { type: 'integer', minimum: 0 },
    },
    required: ['index'],
    additionalProperties: false,
  },

  Provenance: {
    type: 'object',
    description:
      'Full provenance for a recall hit. All 7 keys are always required; ' +
      'fields a layer cannot populate are explicitly null, never omitted.',
    properties: {
      layer: { $ref: '#/$defs/Layer' },
      source: { type: 'string' },
      chunk_span: { $ref: '#/$defs/ChunkSpan' },
      index_timestamp: {
        type: ['string', 'null'],
        format: 'date-time',
      },
      content_hash: { type: ['string', 'null'] },
      embedder: { type: ['string', 'null'] },
      retrieval_time: {
        type: ['string', 'null'],
        format: 'date-time',
      },
    },
    required: [
      'layer',
      'source',
      'chunk_span',
      'index_timestamp',
      'content_hash',
      'embedder',
      'retrieval_time',
    ],
    additionalProperties: false,
  },

  Hit: {
    type: 'object',
    properties: {
      content: { type: 'string' },
      provenance: { $ref: '#/$defs/Provenance' },
      score: { type: 'number' },
    },
    required: ['content', 'provenance'],
    additionalProperties: false,
  },

  LayerSkip: {
    type: 'object',
    properties: {
      layer: { $ref: '#/$defs/Layer' },
      reason: { type: 'string' },
      detail: { type: 'string' },
    },
    required: ['layer', 'reason'],
    additionalProperties: false,
  },

  RecallError: {
    type: 'object',
    properties: {
      layer: {
        anyOf: [{ $ref: '#/$defs/Layer' }, { type: 'null' }],
      },
      message: { type: 'string' },
      code: { type: 'string' },
    },
    required: ['layer', 'message'],
    additionalProperties: false,
  },

  RecallSuccess: {
    type: 'object',
    properties: {
      ok: { const: true },
      query: { type: 'string' },
      scope: { $ref: '#/$defs/Scope' },
      intent: { $ref: '#/$defs/Intent' },
      hits: { type: 'array', items: { $ref: '#/$defs/Hit' } },
      layers_queried: { type: 'array', items: { $ref: '#/$defs/Layer' } },
      layers_skipped: { type: 'array', items: { $ref: '#/$defs/LayerSkip' } },
      escalated: { type: 'boolean' },
      degraded: { type: 'boolean' },
    },
    required: [
      'ok',
      'query',
      'scope',
      'intent',
      'hits',
      'layers_queried',
      'layers_skipped',
      'escalated',
      'degraded',
    ],
    additionalProperties: false,
  },

  RecallFailure: {
    type: 'object',
    properties: {
      ok: { const: false },
      query: { type: 'string' },
      scope: { $ref: '#/$defs/Scope' },
      intent: { $ref: '#/$defs/Intent' },
      error: { $ref: '#/$defs/RecallError' },
    },
    required: ['ok', 'query', 'scope', 'intent', 'error'],
    additionalProperties: false,
  },

  RecallResult: {
    description:
      'Discriminated on `ok`: a legitimate zero-hit search (ok: true, hits: []) ' +
      'is a structurally different shape from a failed search (ok: false, error).',
    oneOf: [
      { $ref: '#/$defs/RecallSuccess' },
      { $ref: '#/$defs/RecallFailure' },
    ],
  },

  DegradedWrite: {
    type: 'object',
    properties: {
      reason: { type: 'string' },
      failed_parts: { type: 'array', items: { type: 'string' } },
    },
    required: ['reason', 'failed_parts'],
    additionalProperties: false,
  },

  RememberError: {
    type: 'object',
    properties: {
      layer: {
        anyOf: [{ $ref: '#/$defs/Layer' }, { type: 'null' }],
      },
      message: { type: 'string' },
      code: { type: 'string' },
    },
    required: ['layer', 'message'],
    additionalProperties: false,
  },

  RememberSuccess: {
    type: 'object',
    properties: {
      ok: { const: true },
      layer: { $ref: '#/$defs/Layer' },
      provenance: { $ref: '#/$defs/Provenance' },
      degraded: { $ref: '#/$defs/DegradedWrite' },
    },
    required: ['ok', 'layer', 'provenance'],
    additionalProperties: false,
  },

  RememberFailure: {
    type: 'object',
    properties: {
      ok: { const: false },
      error: { $ref: '#/$defs/RememberError' },
    },
    required: ['ok', 'error'],
    additionalProperties: false,
  },

  RememberResult: {
    description:
      'Discriminated on `ok`: no field is nullable/omittable in a way that ' +
      'could represent "silently no memory" — either the write succeeded ' +
      '(with a resolved layer + provenance) or it failed loudly (with a ' +
      'structured error).',
    oneOf: [
      { $ref: '#/$defs/RememberSuccess' },
      { $ref: '#/$defs/RememberFailure' },
    ],
  },
} as const;

/** Runtime-validatable schema for `Provenance` (see `interfaces.ts`). */
export const ProvenanceSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://mnemosyne.dev/schema/provenance.json',
  $ref: '#/$defs/Provenance',
  $defs,
} as const;

/** Runtime-validatable schema for `RecallResult` (see `interfaces.ts`). */
export const RecallResultSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://mnemosyne.dev/schema/recall-result.json',
  $ref: '#/$defs/RecallResult',
  $defs,
} as const;

/** Runtime-validatable schema for `RememberResult` (see `interfaces.ts`). */
export const RememberResultSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://mnemosyne.dev/schema/remember-result.json',
  $ref: '#/$defs/RememberResult',
  $defs,
} as const;
