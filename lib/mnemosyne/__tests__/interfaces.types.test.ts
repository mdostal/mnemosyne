/**
 * Type-checking contract tests for `lib/mnemosyne/interfaces.ts`.
 *
 * These tests are compile-time in nature: the fixture objects below only
 * type-check if the interfaces are shaped correctly, and the
 * `// @ts-expect-error` cases only pass `tsc --noEmit` if the type system
 * genuinely rejects the invalid shape on the very next line (an unused
 * `@ts-expect-error` directive is itself a compile error under `tsc`, so
 * these double as negative tests, not just positive ones).
 *
 * `vitest run` transpiles this file with esbuild (types stripped, not
 * checked), so the runtime assertions below are deliberately shallow sanity
 * checks — the real enforcement of the type contract is `npm run typecheck`
 * (see package.json). Both scripts must pass for this file to be considered
 * a passing contract test.
 */
import { describe, expect, it } from 'vitest';
import type {
  ChunkSpan,
  Content,
  DegradedWrite,
  Hit,
  Intent,
  Layer,
  LayerSkip,
  MnemosyneClient,
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
} from '../interfaces.js';

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

describe('enumerations', () => {
  it('accepts every documented Layer value', () => {
    const layers: Layer[] = [
      'meta',
      'enterprise',
      'project',
      'code-graph',
      'vector',
      'file',
    ];
    expect(layers).toHaveLength(6);
  });

  it('accepts every documented Scope value', () => {
    const scopes: Scope[] = ['project', 'enterprise', 'meta'];
    expect(scopes).toHaveLength(3);
  });

  it('accepts every documented Intent value', () => {
    const intents: Intent[] = ['narrow', 'broad'];
    expect(intents).toHaveLength(2);
  });

  it('rejects an arbitrary string as Scope', () => {
    // @ts-expect-error -- "workspace" is not one of project/enterprise/meta
    const bad: Scope = 'workspace';
    expect(bad).toBeDefined();
  });

  it('rejects an arbitrary string as Layer', () => {
    // @ts-expect-error -- "database" is not one of the six documented layers
    const bad: Layer = 'database';
    expect(bad).toBeDefined();
  });

  it('rejects an arbitrary string as Intent', () => {
    // @ts-expect-error -- "aggressive" is not narrow/broad
    const bad: Intent = 'aggressive';
    expect(bad).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ChunkSpan
// ---------------------------------------------------------------------------

describe('ChunkSpan', () => {
  it('accepts pre-expansion shape (index only)', () => {
    const span: ChunkSpan = { index: 0 };
    expect(span.index).toBe(0);
  });

  it('accepts post-expansion shape (index + start/end)', () => {
    const span: ChunkSpan = { index: 3, start: 120, end: 480 };
    expect(span.end).toBe(480);
  });

  it('rejects a span missing the required index key', () => {
    // @ts-expect-error -- `index` is required, not optional
    const span: ChunkSpan = { start: 0, end: 10 };
    expect(span).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Provenance — the "all 7 keys always present" contract
// ---------------------------------------------------------------------------

describe('Provenance', () => {
  it('accepts a fully-populated provenance object', () => {
    const p: Provenance = {
      layer: 'vector',
      source: 'qdrant://points/abc123',
      chunk_span: { index: 2, start: 100, end: 200 },
      index_timestamp: '2026-07-27T00:00:00.000Z',
      content_hash: 'sha256:deadbeef',
      embedder: 'text-embedding-3-small',
      retrieval_time: '2026-07-27T00:00:01.000Z',
    };
    expect(p.layer).toBe('vector');
  });

  it('accepts a provenance with every nullable field explicitly null (e.g. file layer)', () => {
    const p: Provenance = {
      layer: 'file',
      source: '/repo/README.md',
      chunk_span: null,
      index_timestamp: null,
      content_hash: null,
      embedder: null,
      retrieval_time: null,
    };
    expect(p.chunk_span).toBeNull();
    expect(p.embedder).toBeNull();
  });

  it('rejects a provenance missing a required key entirely (embedder omitted)', () => {
    // @ts-expect-error -- `embedder` key must be present (even if null), not omitted
    const p: Provenance = {
      layer: 'code-graph',
      source: 'node://foo',
      chunk_span: null,
      index_timestamp: null,
      content_hash: null,
      retrieval_time: null,
    };
    expect(p).toBeDefined();
  });

  it('rejects a provenance missing `source`', () => {
    // @ts-expect-error -- `source` is required
    const p: Provenance = {
      layer: 'meta',
      chunk_span: null,
      index_timestamp: null,
      content_hash: null,
      embedder: null,
      retrieval_time: null,
    };
    expect(p).toBeDefined();
  });

  it('rejects an invalid Layer value inside Provenance', () => {
    const p: Provenance = {
      // @ts-expect-error -- not a valid Layer literal
      layer: 'sql-database',
      source: 'x',
      chunk_span: null,
      index_timestamp: null,
      content_hash: null,
      embedder: null,
      retrieval_time: null,
    };
    expect(p).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Hit / LayerSkip
// ---------------------------------------------------------------------------

describe('Hit', () => {
  const provenance: Provenance = {
    layer: 'vector',
    source: 'qdrant://points/abc123',
    chunk_span: { index: 0 },
    index_timestamp: '2026-07-27T00:00:00.000Z',
    content_hash: null,
    embedder: 'text-embedding-3-small',
    retrieval_time: '2026-07-27T00:00:01.000Z',
  };

  it('accepts a scored hit', () => {
    const hit: Hit = { content: 'some recalled text', provenance, score: 0.87 };
    expect(hit.score).toBeCloseTo(0.87);
  });

  it('accepts an unscored hit (score is absent, not null)', () => {
    const hit: Hit = { content: 'graph traversal result', provenance };
    expect(hit.score).toBeUndefined();
  });

  it('rejects a hit missing provenance', () => {
    // @ts-expect-error -- `provenance` is required, never optional, on a Hit
    const hit: Hit = { content: 'no provenance here' };
    expect(hit).toBeDefined();
  });
});

describe('LayerSkip', () => {
  it('accepts a skip with detail', () => {
    const skip: LayerSkip = {
      layer: 'enterprise',
      reason: 'unreachable',
      detail: 'connection refused after 3 retries',
    };
    expect(skip.reason).toBe('unreachable');
  });

  it('accepts a skip without detail', () => {
    const skip: LayerSkip = { layer: 'enterprise', reason: 'not_configured' };
    expect(skip.detail).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// RecallResult discriminated union
// ---------------------------------------------------------------------------

describe('RecallSuccess', () => {
  it('accepts a zero-hit success (legitimate empty result, not a failure)', () => {
    const result: RecallSuccess = {
      ok: true,
      query: 'how does auth work',
      scope: 'project',
      intent: 'narrow',
      hits: [],
      layers_queried: ['project'],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    };
    expect(result.hits).toHaveLength(0);
  });

  it('accepts a success with hits, escalation, and degraded layers', () => {
    const result: RecallSuccess = {
      ok: true,
      query: 'deployment runbook',
      scope: 'enterprise',
      intent: 'broad',
      hits: [
        {
          content: 'runbook excerpt',
          provenance: {
            layer: 'file',
            source: '/docs/runbook.md',
            chunk_span: null,
            index_timestamp: null,
            content_hash: null,
            embedder: null,
            retrieval_time: null,
          },
        },
      ],
      layers_queried: ['project', 'enterprise', 'file'],
      layers_skipped: [{ layer: 'vector', reason: 'timeout' }],
      escalated: true,
      degraded: true,
    };
    expect(result.escalated).toBe(true);
  });

  it('rejects a RecallSuccess missing layers_queried (loud-failure field must always be present)', () => {
    // @ts-expect-error -- `layers_queried` is required, never omitted
    const result: RecallSuccess = {
      ok: true,
      query: 'x',
      scope: 'project',
      intent: 'narrow',
      hits: [],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    };
    expect(result).toBeDefined();
  });

  it('rejects a RecallSuccess with an `error` field bleeding in from the failure branch', () => {
    const result: RecallSuccess = {
      ok: true,
      query: 'x',
      scope: 'project',
      intent: 'narrow',
      hits: [],
      layers_queried: [],
      layers_skipped: [],
      escalated: false,
      degraded: false,
      // @ts-expect-error -- `error` is not a member of RecallSuccess
      error: { layer: null, message: 'oops' },
    };
    expect(result).toBeDefined();
  });
});

describe('RecallFailure', () => {
  it('accepts a failure with a layer-attributed error', () => {
    const result: RecallFailure = {
      ok: false,
      query: 'anything',
      scope: 'meta',
      intent: 'broad',
      error: { layer: 'vector', message: 'qdrant unreachable', code: 'qdrant_unreachable' },
    };
    expect(result.error.code).toBe('qdrant_unreachable');
  });

  it('accepts a failure that predates layer dispatch (error.layer null)', () => {
    const result: RecallFailure = {
      ok: false,
      query: 'anything',
      scope: 'project',
      intent: 'narrow',
      error: { layer: null, message: 'invalid scope' },
    };
    expect(result.error.layer).toBeNull();
  });

  it('rejects a RecallFailure with `hits` bleeding in from the success branch', () => {
    const result: RecallFailure = {
      ok: false,
      query: 'anything',
      scope: 'project',
      intent: 'narrow',
      error: { layer: null, message: 'invalid scope' },
      // @ts-expect-error -- `hits` is not a member of RecallFailure
      hits: [],
    };
    expect(result).toBeDefined();
  });

  it('rejects a RecallFailure missing `error`', () => {
    // @ts-expect-error -- `error` is required on a failed recall
    const result: RecallFailure = {
      ok: false,
      query: 'anything',
      scope: 'project',
      intent: 'narrow',
    };
    expect(result).toBeDefined();
  });
});

describe('RecallResult (discriminated union)', () => {
  it('narrows to RecallSuccess when ok is true', () => {
    const result: RecallResult = {
      ok: true,
      query: 'q',
      scope: 'project',
      intent: 'narrow',
      hits: [],
      layers_queried: ['project'],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    };
    if (result.ok) {
      // Only reachable/typed correctly if the union narrows properly.
      expect(result.hits).toEqual([]);
    } else {
      throw new Error('expected ok:true branch');
    }
  });

  it('narrows to RecallFailure when ok is false', () => {
    const result: RecallResult = {
      ok: false,
      query: 'q',
      scope: 'project',
      intent: 'narrow',
      error: { layer: null, message: 'boom' },
    };
    if (!result.ok) {
      expect(result.error.message).toBe('boom');
    } else {
      throw new Error('expected ok:false branch');
    }
  });

  it('rejects `ok` as a plain boolean instead of the true/false literal split', () => {
    const flag: boolean = Math.random() > 2; // always false, but typed as `boolean`
    // @ts-expect-error -- a widened `boolean` cannot satisfy the `ok: true`/`ok: false` discriminant alone
    const result: RecallResult = {
      ok: flag,
      query: 'q',
      scope: 'project',
      intent: 'narrow',
      hits: [],
      layers_queried: [],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    };
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

describe('Content', () => {
  it('accepts text-only content', () => {
    const content: Content = { text: 'some note body' };
    expect(content.metadata).toBeUndefined();
  });

  it('accepts content with free-form metadata', () => {
    const content: Content = {
      text: 'some note body',
      metadata: { title: 'Meeting notes', tags: ['standup', 'q3'] },
    };
    expect(content.metadata?.title).toBe('Meeting notes');
  });

  it('rejects content missing the required text field', () => {
    // @ts-expect-error -- `text` is required
    const content: Content = { metadata: { title: 'oops' } };
    expect(content).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// RememberResult discriminated union
// ---------------------------------------------------------------------------

describe('DegradedWrite', () => {
  it('accepts a degraded write record', () => {
    const degraded: DegradedWrite = {
      reason: 'secondary index unavailable',
      failed_parts: ['vector-index'],
    };
    expect(degraded.failed_parts).toContain('vector-index');
  });
});

describe('RememberSuccess', () => {
  const provenance: Provenance = {
    layer: 'project',
    source: '/notes/2026-07-27.md',
    chunk_span: { index: 0 },
    index_timestamp: '2026-07-27T00:00:00.000Z',
    content_hash: 'sha256:abc',
    embedder: null,
    retrieval_time: null,
  };

  it('accepts a fully healthy write (no degraded field)', () => {
    const result: RememberSuccess = { ok: true, layer: 'project', provenance };
    expect(result.degraded).toBeUndefined();
  });

  it('accepts a partially degraded write', () => {
    const result: RememberSuccess = {
      ok: true,
      layer: 'project',
      provenance,
      degraded: { reason: 'secondary index unavailable', failed_parts: ['vector-index'] },
    };
    expect(result.degraded?.reason).toBeDefined();
  });

  it('rejects a RememberSuccess missing provenance', () => {
    // @ts-expect-error -- `provenance` is required on a successful write
    const result: RememberSuccess = { ok: true, layer: 'project' };
    expect(result).toBeDefined();
  });

  it('rejects a RememberSuccess with an `error` field bleeding in from the failure branch', () => {
    const result: RememberSuccess = {
      ok: true,
      layer: 'project',
      provenance,
      // @ts-expect-error -- `error` is not a member of RememberSuccess
      error: { layer: null, message: 'oops' },
    };
    expect(result).toBeDefined();
  });
});

describe('RememberFailure', () => {
  it('accepts a failure with a structured error', () => {
    const result: RememberFailure = {
      ok: false,
      error: { layer: 'vector', message: 'embedder unavailable', code: 'embedder_error' },
    };
    expect(result.error.code).toBe('embedder_error');
  });

  it('rejects a RememberFailure with `layer`/`provenance` bleeding in from the success branch', () => {
    const result: RememberFailure = {
      ok: false,
      error: { layer: null, message: 'boom' },
      // @ts-expect-error -- `layer` is not a member of RememberFailure
      layer: 'project',
    };
    expect(result).toBeDefined();
  });

  it('rejects a RememberFailure missing `error`', () => {
    // @ts-expect-error -- `error` is required on a failed write
    const result: RememberFailure = { ok: false };
    expect(result).toBeDefined();
  });
});

describe('RememberResult (discriminated union)', () => {
  it('narrows to RememberSuccess when ok is true', () => {
    const result: RememberResult = {
      ok: true,
      layer: 'meta',
      provenance: {
        layer: 'meta',
        source: 'meta://global',
        chunk_span: null,
        index_timestamp: null,
        content_hash: null,
        embedder: null,
        retrieval_time: null,
      },
    };
    if (result.ok) {
      expect(result.layer).toBe('meta');
    } else {
      throw new Error('expected ok:true branch');
    }
  });

  it('narrows to RememberFailure when ok is false', () => {
    const result: RememberResult = {
      ok: false,
      error: { layer: null, message: 'boom' },
    };
    if (!result.ok) {
      expect(result.error.message).toBe('boom');
    } else {
      throw new Error('expected ok:false branch');
    }
  });
});

// ---------------------------------------------------------------------------
// Function/client surface
// ---------------------------------------------------------------------------

describe('RecallFn / RememberFn / MnemosyneClient', () => {
  const recall: RecallFn = (query, scope, intent) => ({
    ok: true,
    query,
    scope,
    intent: intent ?? 'narrow',
    hits: [],
    layers_queried: [scope],
    layers_skipped: [],
    escalated: false,
    degraded: false,
  });

  const remember: RememberFn = (content, scope, layer) => ({
    ok: true,
    layer: layer ?? 'project',
    provenance: {
      layer: layer ?? 'project',
      source: 'synthetic',
      chunk_span: null,
      index_timestamp: null,
      content_hash: null,
      embedder: null,
      retrieval_time: null,
    },
  });

  it('recall() is callable with and without intent', () => {
    const withIntent = recall('q', 'project', 'broad');
    const withoutIntent = recall('q', 'project');
    expect(withIntent.ok).toBe(true);
    expect(withoutIntent.ok).toBe(true);
  });

  it('remember() is callable with and without layer', () => {
    const withLayer = remember({ text: 't' }, 'project', 'vector');
    const withoutLayer = remember({ text: 't' }, 'project');
    expect(withLayer.ok).toBe(true);
    expect(withoutLayer.ok).toBe(true);
  });

  it('MnemosyneClient groups recall/remember behind one interface', () => {
    const client: MnemosyneClient = { recall, remember };
    const result: RecallResult = client.recall('q', 'meta');
    expect(result.ok).toBe(true);
  });

  it('rejects a RecallFn returning a Promise (this story is synchronous)', () => {
    // @ts-expect-error -- RecallFn's return type is RecallResult, not Promise<RecallResult>
    const asyncRecall: RecallFn = async (query, scope) => ({
      ok: true,
      query,
      scope,
      intent: 'narrow',
      hits: [],
      layers_queried: [],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    });
    expect(asyncRecall).toBeDefined();
  });
});

// Re-export a couple of shared error types to prove they type-check on their
// own too (RecallError / RememberError are structurally identical but kept
// as distinct named types in interfaces.ts).
describe('RecallError / RememberError', () => {
  it('both accept a null layer and an optional code', () => {
    const recallError: RecallError = { layer: null, message: 'x' };
    const rememberError: RememberError = { layer: null, message: 'y', code: 'z' };
    expect(recallError.code).toBeUndefined();
    expect(rememberError.code).toBe('z');
  });
});
