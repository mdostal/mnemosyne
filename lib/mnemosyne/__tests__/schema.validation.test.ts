/**
 * Runtime schema-validation contract tests for `lib/mnemosyne/schema.ts`.
 *
 * These are the actual runtime enforcement of the story's acceptance
 * criteria (type-checking alone only proves the TypeScript author-time
 * contract; these tests prove the JSON Schema mirrors reject bad data at
 * runtime too, which is what matters once payloads cross a process/wire
 * boundary and lose their static types).
 *
 * One `describe` block per acceptance criterion (AC1-AC4), each asserting at
 * least one valid fixture passes and one invalid fixture fails.
 */
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ProvenanceSchema,
  RecallResultSchema,
  RememberResultSchema,
} from '../schema.js';

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

let validateProvenance: ReturnType<typeof ajv.compile>;
let validateRecallResult: ReturnType<typeof ajv.compile>;
let validateRememberResult: ReturnType<typeof ajv.compile>;

beforeAll(() => {
  validateProvenance = ajv.compile(ProvenanceSchema);
  validateRecallResult = ajv.compile(RecallResultSchema);
  validateRememberResult = ajv.compile(RememberResultSchema);
});

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const fullProvenance = {
  layer: 'vector',
  source: 'qdrant://points/abc123',
  chunk_span: { index: 2, start: 100, end: 200 },
  index_timestamp: '2026-07-27T00:00:00.000Z',
  content_hash: 'sha256:deadbeef',
  embedder: 'text-embedding-3-small',
  retrieval_time: '2026-07-27T00:00:01.000Z',
};

const allNullProvenance = {
  layer: 'file',
  source: '/repo/README.md',
  chunk_span: null,
  index_timestamp: null,
  content_hash: null,
  embedder: null,
  retrieval_time: null,
};

// ---------------------------------------------------------------------------
// AC1: recall() hits carry full provenance (Hit requires provenance; schema
// requires all 7 keys)
// ---------------------------------------------------------------------------

describe('AC1: recall() hits carry full provenance', () => {
  it('a RecallSuccess hit with fully-populated provenance validates', () => {
    const payload = {
      ok: true,
      query: 'how does auth work',
      scope: 'project',
      intent: 'narrow',
      hits: [{ content: 'chunk text', provenance: fullProvenance, score: 0.9 }],
      layers_queried: ['project'],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    };
    const valid = validateRecallResult(payload);
    expect(validateRecallResult.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it('a RecallSuccess hit whose provenance is missing a key is rejected', () => {
    const { embedder: _embedder, ...provenanceMissingEmbedder } = fullProvenance;
    const payload = {
      ok: true,
      query: 'how does auth work',
      scope: 'project',
      intent: 'narrow',
      hits: [{ content: 'chunk text', provenance: provenanceMissingEmbedder }],
      layers_queried: ['project'],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    };
    expect(validateRecallResult(payload)).toBe(false);
    expect(validateRecallResult.errors).not.toBeNull();
  });

  it('a hit with no provenance key at all is rejected', () => {
    const payload = {
      ok: true,
      query: 'q',
      scope: 'project',
      intent: 'narrow',
      hits: [{ content: 'chunk text with no provenance' }],
      layers_queried: ['project'],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    };
    expect(validateRecallResult(payload)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC2: remember() succeeds or fails loudly (RememberResult schema rejects a
// shape that isn't cleanly ok:true or ok:false)
// ---------------------------------------------------------------------------

describe('AC2: remember() succeeds or fails loudly', () => {
  it('a clean ok:true success (layer + provenance) validates', () => {
    const payload = { ok: true, layer: 'project', provenance: fullProvenance };
    expect(validateRememberResult(payload)).toBe(true);
  });

  it('a clean ok:false failure (structured error) validates', () => {
    const payload = {
      ok: false,
      error: { layer: 'vector', message: 'embedder unavailable', code: 'embedder_error' },
    };
    expect(validateRememberResult(payload)).toBe(true);
  });

  it('rejects a payload missing `ok` entirely', () => {
    const payload = { layer: 'project', provenance: fullProvenance };
    expect(validateRememberResult(payload)).toBe(false);
  });

  it('rejects ok:true without a layer/provenance (silent success)', () => {
    const payload = { ok: true };
    expect(validateRememberResult(payload)).toBe(false);
  });

  it('rejects ok:true with only layer, missing provenance', () => {
    const payload = { ok: true, layer: 'project' };
    expect(validateRememberResult(payload)).toBe(false);
  });

  it('rejects ok:false without an error (silent failure)', () => {
    const payload = { ok: false };
    expect(validateRememberResult(payload)).toBe(false);
  });

  it('rejects a payload that mixes both branches (ok:true but also carries error)', () => {
    // additionalProperties: false on each branch means a payload with fields
    // from both shapes cannot satisfy either half of the oneOf.
    const payload = {
      ok: true,
      layer: 'project',
      provenance: fullProvenance,
      error: { layer: null, message: 'should not coexist with ok:true' },
    };
    expect(validateRememberResult(payload)).toBe(false);
  });

  it('rejects an arbitrary truthy-but-not-boolean `ok` value', () => {
    const payload = { ok: 'true', layer: 'project', provenance: fullProvenance };
    expect(validateRememberResult(payload)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC3: provenance schema requires all 7 fields, rejects a payload with one
// field omitted entirely (even though nullable, key must be present)
// ---------------------------------------------------------------------------

describe('AC3: Provenance requires all 7 fields present as keys', () => {
  it('a fully-populated provenance validates', () => {
    expect(validateProvenance(fullProvenance)).toBe(true);
  });

  it('a provenance with every nullable field explicitly null validates (file layer)', () => {
    expect(validateProvenance(allNullProvenance)).toBe(true);
  });

  it.each([
    'layer',
    'source',
    'chunk_span',
    'index_timestamp',
    'content_hash',
    'embedder',
    'retrieval_time',
  ] as const)('rejects a provenance with `%s` omitted entirely', (key) => {
    const { [key]: _omitted, ...rest } = allNullProvenance as Record<string, unknown>;
    expect(validateProvenance(rest)).toBe(false);
  });

  it('rejects a provenance with an additional, undocumented property', () => {
    const payload = { ...fullProvenance, extra_field: 'not part of the contract' };
    expect(validateProvenance(payload)).toBe(false);
  });

  it('rejects a provenance where a nullable field is set to `undefined`-shaped (key missing) rather than explicit null', () => {
    // JSON has no `undefined` — the only way to express "no value" on the
    // wire is either an explicit null (allowed) or omitting the key
    // (disallowed). This double-checks the omission case for one field.
    const payload = {
      layer: 'code-graph',
      source: 'node://foo',
      chunk_span: null,
      index_timestamp: null,
      content_hash: null,
      embedder: null,
      // retrieval_time intentionally omitted
    };
    expect(validateProvenance(payload)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC4: Scope schema accepts project/enterprise/meta and rejects an arbitrary
// string
// ---------------------------------------------------------------------------

describe('AC4: Scope accepts project/enterprise/meta, rejects arbitrary strings', () => {
  it.each(['project', 'enterprise', 'meta'])('accepts scope=%s in a RecallResult', (scope) => {
    const payload = {
      ok: true,
      query: 'q',
      scope,
      intent: 'narrow',
      hits: [],
      layers_queried: [],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    };
    expect(validateRecallResult(payload)).toBe(true);
  });

  it('rejects an arbitrary string scope (e.g. "workspace")', () => {
    const payload = {
      ok: true,
      query: 'q',
      scope: 'workspace',
      intent: 'narrow',
      hits: [],
      layers_queried: [],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    };
    expect(validateRecallResult(payload)).toBe(false);
  });

  it('rejects a RecallFailure with an arbitrary string scope too', () => {
    const payload = {
      ok: false,
      query: 'q',
      scope: 'global',
      intent: 'narrow',
      error: { layer: null, message: 'x' },
    };
    expect(validateRecallResult(payload)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Additional whole-result coverage: RecallResult discriminated union
// ---------------------------------------------------------------------------

describe('RecallResult discriminated union (whole-shape)', () => {
  it('a legitimate zero-hit success validates (empty hits is not a failure)', () => {
    const payload = {
      ok: true,
      query: 'nothing found',
      scope: 'project',
      intent: 'narrow',
      hits: [],
      layers_queried: ['project'],
      layers_skipped: [{ layer: 'vector', reason: 'timeout' }],
      escalated: false,
      degraded: false,
    };
    expect(validateRecallResult(payload)).toBe(true);
  });

  it('a failure validates with a structured error, and rejects if `hits` bleeds in', () => {
    const failure = {
      ok: false,
      query: 'q',
      scope: 'meta',
      intent: 'broad',
      error: { layer: 'vector', message: 'qdrant unreachable', code: 'qdrant_unreachable' },
    };
    expect(validateRecallResult(failure)).toBe(true);

    const mixed = { ...failure, hits: [] };
    expect(validateRecallResult(mixed)).toBe(false);
  });

  it('rejects an invalid Layer enum value inside layers_queried', () => {
    const payload = {
      ok: true,
      query: 'q',
      scope: 'project',
      intent: 'narrow',
      hits: [],
      layers_queried: ['sql-database'],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    };
    expect(validateRecallResult(payload)).toBe(false);
  });

  it('rejects a wrong-enum layer value inside a hit provenance', () => {
    const payload = {
      ok: true,
      query: 'q',
      scope: 'project',
      intent: 'narrow',
      hits: [{ content: 'x', provenance: { ...fullProvenance, layer: 'not-a-real-layer' } }],
      layers_queried: ['project'],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    };
    expect(validateRecallResult(payload)).toBe(false);
  });
});
