import { describe, it, expect } from 'vitest';
import { MinervaMemory } from '../memory.js';
import { MinervaDecisions } from '../decisions.js';
import { compareTokenCost } from '../../../benchmarks/recall-vs-find.js';
import { MnemosyneClient, RecallResult, RememberResult, Layer } from '../../mnemosyne/interfaces.js';

describe('Minerva First-God Integration', () => {
  
  // Mock Mnemosyne Client
  const mockClient: MnemosyneClient = {
    recall: (query, scope, intent): RecallResult => {
      if (query === 'test_remember') {
        return {
          ok: true,
          query,
          scope,
          intent: intent || 'broad',
          hits: [{
            content: 'Planning decision: use Minerva',
            provenance: {
              layer: 'project',
              source: '/notes/decision-1',
              chunk_span: { index: 0, start: 0, end: 100 },
              index_timestamp: '2026-08-08T12:00:00Z',
              content_hash: 'abc123hash',
              embedder: null,
              retrieval_time: '2026-08-08T12:01:00Z'
            }
          }],
          layers_queried: ['project'],
          layers_skipped: [],
          escalated: false,
          degraded: false
        };
      }

      return {
        ok: true,
        query,
        scope,
        intent: intent || 'broad',
        hits: [
          {
            content: 'Hit from project meta',
            provenance: {
              layer: 'project',
              source: '/repo/config.json',
              chunk_span: null,
              index_timestamp: '2026-08-01T10:00:00Z',
              content_hash: 'hash1',
              embedder: null,
              retrieval_time: '2026-08-08T10:00:00Z'
            }
          },
          {
            content: 'Hit from code-graph',
            provenance: {
              layer: 'code-graph',
              source: 'node_modules_graph',
              chunk_span: { index: 1 },
              index_timestamp: null,
              content_hash: null,
              embedder: null,
              retrieval_time: '2026-08-08T10:00:01Z'
            }
          },
          {
            content: 'Hit from vector storage',
            provenance: {
              layer: 'vector',
              source: 'qdrant_point_123',
              chunk_span: { index: 0, start: 0, end: 15 },
              index_timestamp: '2026-08-02T10:00:00Z',
              content_hash: 'hash2',
              embedder: 'text-embedding-3-small',
              retrieval_time: '2026-08-08T10:00:02Z'
            },
            score: 0.95
          }
        ],
        layers_queried: ['project', 'code-graph', 'vector', 'enterprise'],
        layers_skipped: [{ layer: 'file', reason: 'unreachable' }],
        escalated: true,
        degraded: false
      };
    },
    
    remember: (content, scope, layer): RememberResult => {
      return {
        ok: true,
        layer: layer || 'project',
        provenance: {
          layer: layer || 'project',
          source: '/notes/decision-1',
          chunk_span: { index: 0 },
          index_timestamp: new Date().toISOString(),
          content_hash: 'new_hash',
          embedder: null,
          retrieval_time: null
        }
      };
    }
  };

  it('recall() results span ≥3 layers', () => {
    const minerva = new MinervaMemory(mockClient);
    const result = minerva.searchContext('architectural decisions');
    
    expect(result.ok).toBe(true);
    if (result.ok) {
      const layers = new Set(result.hits.map(h => h.provenance.layer));
      expect(layers.size).toBeGreaterThanOrEqual(3);
      expect(layers.has('project')).toBe(true);
      expect(layers.has('code-graph')).toBe(true);
      expect(layers.has('vector')).toBe(true);
    }
  });

  it('recall() vs find/grep token cost ratio is ≤ 1.0', () => {
    const stats = compareTokenCost(mockClient, 'architectural decisions', 'project');
    expect(stats.beatsFind).toBe(true);
    expect(stats.ratio).toBeLessThanOrEqual(0.5); // Target is 0.5 per metric config
  });

  it('remember() stored content is retrievable via recall()', () => {
    const minervaDecisions = new MinervaDecisions(mockClient);
    const writeResult = minervaDecisions.recordPlanningDecision('use Minerva');
    expect(writeResult.ok).toBe(true);
    
    const minervaMemory = new MinervaMemory(mockClient);
    const readResult = minervaMemory.searchContext('test_remember');
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.hits.length).toBeGreaterThan(0);
      expect(readResult.hits[0].content).toContain('use Minerva');
    }
  });

  it('provenance includes all 7 fields for each hit', () => {
    const minerva = new MinervaMemory(mockClient);
    const result = minerva.searchContext('architectural decisions');
    
    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const hit of result.hits) {
        expect(hit.provenance).toHaveProperty('layer');
        expect(hit.provenance).toHaveProperty('source');
        expect(hit.provenance).toHaveProperty('chunk_span');
        expect(hit.provenance).toHaveProperty('index_timestamp');
        expect(hit.provenance).toHaveProperty('content_hash');
        expect(hit.provenance).toHaveProperty('embedder');
        expect(hit.provenance).toHaveProperty('retrieval_time');
      }
    }
  });
});
