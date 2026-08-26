/**
 * cm-06-cross-session-clustering (epic: mnemosyne-conversation-memory).
 *
 * Failing-first tests (TDD) for `clusterConversations.ts`. Every test runs
 * against a STUBBED `Embedder` and a STUBBED `ScopeConfigReader` (never a
 * live embedding call, never a live `swarm-memory config` shell-out) --
 * mirrors `triageSession.test.ts`'s own stubbed-client convention exactly.
 * The one exception (AC9, "missing org-tree.yaml is not an error") uses the
 * REAL `listOrgTreeEntries()` (ro-04) bound to a controlled, definitely-
 * nonexistent TEMP path -- never this operator's own real
 * `~/.mnemosyne/org-tree.yaml`.
 *
 * Covers this story's acceptance criteria:
 *  1. Every keep/uncertain entry receives a cluster assignment.
 *  2. trash-verdict entries never reach the embedding call (defensive
 *     filter, not merely output filtering).
 *  3. Cross-slug clustering is REAL (two similar summaries, different
 *     slugs, land in the same cluster) -- and the converse, same slug +
 *     dissimilar summary does NOT force a merge, proving slug is a facet,
 *     never a partition.
 *  4. cluster_id + real project-slug facet(s) always carried, never
 *     discarded.
 *  5. Deterministic/reproducible cluster assignments across two runs of
 *     the same input.
 *  6. resolved_scope_candidate populated on unambiguous slug agreement
 *     against a stubbed swarm-memory [scopes] table.
 *  7. resolved_scope_candidate null on a genuinely mixed-slug cluster.
 *  8. Zero write/create calls anywhere against a scope registry, config
 *     file, or Qdrant collection.
 *  9. Missing ~/.mnemosyne/org-tree.yaml completes normally, contributes
 *     nothing (ro-04's own "missing file is not an error" contract).
 */

import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listOrgTreeEntries, type OrgTreeEntry } from '../onboarding/orgTree.js';

// Node's ESM module namespace objects are non-configurable, so `vi.spyOn`
// cannot patch a built-in module's named export directly (vitest docs, ESM
// limitations) -- `vi.mock` with a factory that wraps the REAL
// implementation in `vi.fn()` is the supported way to make a built-in's
// write/exec surface spy-observable while every other export (readFileSync,
// existsSync, mkdtempSync, rmSync, ...) keeps its real, unmocked behavior.
// This is what the AC8 test below asserts against.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    appendFileSync: vi.fn(actual.appendFileSync),
    mkdirSync: vi.fn(actual.mkdirSync),
  };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn(actual.execFile),
    exec: vi.fn(actual.exec),
  };
});

import {
  clusterBySimilarity,
  clusterConversations,
  computeDominantSlug,
  cosineSimilarity,
  deriveSlugBasename,
  type ClusterableTriageEntry,
  type Embedder,
  type OrgTreeReader,
  type ScopeConfigReader,
} from './clusterConversations.js';

// ---------------------------------------------------------------------------
// Fixtures / stubs
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<ClusterableTriageEntry> = {}): ClusterableTriageEntry {
  return {
    sessionId: 'session-1',
    verdict: 'keep',
    summary: 'a summary',
    projectSlug: '/Users/mdostal/Code/example',
    ...overrides,
  };
}

/** Stub embedder: a fixed lookup table keyed by exact summary text. Throws
 * (never silently returns a zero vector) if asked to embed anything not in
 * the table -- this is how the trash-exclusion tests prove a trash
 * session's summary was never passed to `embed()`. */
function stubEmbedder(vectors: Record<string, number[]>): { embedder: Embedder; calls: string[] } {
  const calls: string[] = [];
  const embedder: Embedder = {
    async embed(text: string): Promise<number[]> {
      calls.push(text);
      const vector = vectors[text];
      if (!vector) {
        throw new Error(`stub embedder was asked to embed unexpected text: ${JSON.stringify(text)}`);
      }
      return vector;
    },
  };
  return { embedder, calls };
}

function stubScopeReader(scopes: Record<string, string>): ScopeConfigReader & { calls: number } {
  const reader = {
    calls: 0,
    async readScopes(): Promise<Record<string, string>> {
      reader.calls++;
      return scopes;
    },
  };
  return reader;
}

function stubOrgTreeReader(entries: OrgTreeEntry[]): OrgTreeReader & { calls: number } {
  const reader = {
    calls: 0,
    async readEntries(): Promise<OrgTreeEntry[]> {
      reader.calls++;
      return entries;
    },
  };
  return reader;
}

const EMPTY_SCOPES = stubScopeReader({});
const EMPTY_ORG_TREE = stubOrgTreeReader([]);

// ---------------------------------------------------------------------------
// Pure-function unit tests
// ---------------------------------------------------------------------------

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 10);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it('is 0 (never NaN/throws) for a zero vector', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('clusterBySimilarity', () => {
  it('groups vectors above threshold, leaves dissimilar vectors singleton, deterministically ordered', () => {
    const groups = clusterBySimilarity(
      [
        [1, 0, 0],
        [0.99, 0.14, 0],
        [0, 1, 0],
      ],
      0.9,
    );
    expect(groups).toEqual([[0, 1], [2]]);
  });
});

describe('deriveSlugBasename', () => {
  it('takes the lowercased final path segment of an absolute project slug', () => {
    expect(deriveSlugBasename('/Users/mdostal/Documents/work/personal/arizona-compound')).toBe(
      'arizona-compound',
    );
  });

  it('handles a bare name with no path separators', () => {
    expect(deriveSlugBasename('mnemosyne')).toBe('mnemosyne');
  });
});

describe('computeDominantSlug', () => {
  it('returns the unanimous slug at share 1.0 when every member agrees', () => {
    expect(computeDominantSlug(['/a/b', '/a/b', '/a/b'], 0.8)).toEqual({ slug: '/a/b', share: 1 });
  });

  it('returns null for a genuinely mixed set with no slug reaching the threshold', () => {
    expect(computeDominantSlug(['/a/b', '/c/d', '/e/f', '/g/h', '/a/b'], 0.8)).toBeNull();
  });

  it('returns the majority slug when it meets an overwhelming-majority threshold (not unanimity)', () => {
    expect(computeDominantSlug(['/a/b', '/a/b', '/a/b', '/a/b', '/c/d'], 0.8)).toEqual({
      slug: '/a/b',
      share: 0.8,
    });
  });

  it('returns null when every slug is null', () => {
    expect(computeDominantSlug([null, null], 0.8)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// clusterConversations() -- integration-level behavior
// ---------------------------------------------------------------------------

describe('clusterConversations', () => {
  it('assigns every keep/uncertain entry to a cluster -- none silently dropped (AC1)', async () => {
    const entries = [
      makeEntry({ sessionId: 's1', verdict: 'keep', summary: 'auth refactor', projectSlug: '/a' }),
      makeEntry({ sessionId: 's2', verdict: 'uncertain', summary: 'unrelated topic', projectSlug: '/b' }),
      makeEntry({ sessionId: 's3', verdict: 'keep', summary: 'yet another topic', projectSlug: '/c' }),
    ];
    const { embedder } = stubEmbedder({
      'auth refactor': [1, 0, 0],
      'unrelated topic': [0, 1, 0],
      'yet another topic': [0, 0, 1],
    });

    const result = await clusterConversations({
      entries,
      embedder,
      scopeConfigReader: EMPTY_SCOPES,
      orgTreeReader: EMPTY_ORG_TREE,
    });

    expect(Object.keys(result.assignments).sort()).toEqual(['s1', 's2', 's3']);
    const allMembers = result.clusters.flatMap((c) => c.member_session_ids);
    expect(allMembers.sort()).toEqual(['s1', 's2', 's3']);
  });

  it('never calls embed() for a trash-verdict session -- excluded from the input set entirely (AC2, hard constraint)', async () => {
    const entries = [
      makeEntry({ sessionId: 'keep-1', verdict: 'keep', summary: 'keep this one', projectSlug: '/a' }),
      makeEntry({
        sessionId: 'trash-1',
        verdict: 'trash',
        summary: 'DO NOT EMBED THIS TRASH SUMMARY',
        projectSlug: '/a',
      }),
      makeEntry({ sessionId: 'unc-1', verdict: 'uncertain', summary: 'uncertain one', projectSlug: '/b' }),
    ];
    // Deliberately omit a vector for the trash summary -- the stub embedder
    // throws if it is ever asked to embed unrecognized text, so if
    // clusterConversations() ever called embed() on the trash summary, this
    // whole test would fail with a thrown error rather than silently
    // passing.
    const { embedder, calls } = stubEmbedder({
      'keep this one': [1, 0, 0],
      'uncertain one': [0, 1, 0],
    });

    const result = await clusterConversations({
      entries,
      embedder,
      scopeConfigReader: EMPTY_SCOPES,
      orgTreeReader: EMPTY_ORG_TREE,
    });

    expect(calls).toEqual(['keep this one', 'uncertain one']);
    expect(calls).not.toContain('DO NOT EMBED THIS TRASH SUMMARY');
    expect(result.assignments['trash-1']).toBeUndefined();
    expect(result.clusters.flatMap((c) => c.member_session_ids)).not.toContain('trash-1');
  });

  it('clusters two sessions with similar summaries but DIFFERENT project slugs into the same cluster (AC3, real cross-slug proof)', async () => {
    const entries = [
      makeEntry({
        sessionId: 'mnemosyne-session',
        verdict: 'keep',
        summary: 'refactored the recall pipeline',
        projectSlug: '/Users/mdostal/Documents/work/pantheon/mnemosyne',
      }),
      makeEntry({
        sessionId: 'arizona-session',
        verdict: 'keep',
        summary: 'refactoring a data pipeline for recall',
        projectSlug: '/Users/mdostal/Documents/work/personal/arizona-compound',
      }),
      // A distractor: SAME slug as mnemosyne-session, but a genuinely
      // dissimilar topic -- proves slug agreement alone does not force a
      // merge either (similarity is the real grouping key, not slug).
      makeEntry({
        sessionId: 'mnemosyne-unrelated-session',
        verdict: 'keep',
        summary: 'discussed lunch plans, nothing technical',
        projectSlug: '/Users/mdostal/Documents/work/pantheon/mnemosyne',
      }),
    ];
    const { embedder } = stubEmbedder({
      'refactored the recall pipeline': [1, 0, 0],
      'refactoring a data pipeline for recall': [0.98, 0.2, 0],
      'discussed lunch plans, nothing technical': [0, 0, 1],
    });

    const result = await clusterConversations({
      entries,
      embedder,
      scopeConfigReader: EMPTY_SCOPES,
      orgTreeReader: EMPTY_ORG_TREE,
      similarityThreshold: 0.9,
    });

    expect(result.assignments['mnemosyne-session']).toBe(result.assignments['arizona-session']);
    expect(result.assignments['mnemosyne-unrelated-session']).not.toBe(result.assignments['mnemosyne-session']);

    const sharedCluster = result.clusters.find((c) => c.member_session_ids.includes('mnemosyne-session'))!;
    expect(sharedCluster.member_session_ids.sort()).toEqual(['arizona-session', 'mnemosyne-session']);
    expect(sharedCluster.project_slugs.sort()).toEqual(
      [
        '/Users/mdostal/Documents/work/pantheon/mnemosyne',
        '/Users/mdostal/Documents/work/personal/arizona-compound',
      ].sort(),
    );
  });

  it('carries cluster_id and the real project-slug facet(s) of members, never discarded (AC4)', async () => {
    const entries = [
      makeEntry({ sessionId: 's1', verdict: 'keep', summary: 'topic a', projectSlug: '/proj/one' }),
    ];
    const { embedder } = stubEmbedder({ 'topic a': [1, 0] });

    const result = await clusterConversations({
      entries,
      embedder,
      scopeConfigReader: EMPTY_SCOPES,
      orgTreeReader: EMPTY_ORG_TREE,
    });

    expect(result.clusters).toHaveLength(1);
    const cluster = result.clusters[0]!;
    expect(cluster.cluster_id).toBeTruthy();
    expect(cluster.project_slugs).toEqual(['/proj/one']);
  });

  it('produces stable/reproducible cluster assignments for the same input run twice (AC5)', async () => {
    const entries = [
      makeEntry({ sessionId: 's1', verdict: 'keep', summary: 'a', projectSlug: '/a' }),
      makeEntry({ sessionId: 's2', verdict: 'keep', summary: 'b', projectSlug: '/b' }),
      makeEntry({ sessionId: 's3', verdict: 'uncertain', summary: 'c', projectSlug: '/a' }),
    ];
    const vectors = { a: [1, 0, 0], b: [0.99, 0.1, 0], c: [0, 0, 1] };

    const run1 = await clusterConversations({
      entries,
      embedder: stubEmbedder(vectors).embedder,
      scopeConfigReader: EMPTY_SCOPES,
      orgTreeReader: EMPTY_ORG_TREE,
    });
    const run2 = await clusterConversations({
      entries,
      embedder: stubEmbedder(vectors).embedder,
      scopeConfigReader: EMPTY_SCOPES,
      orgTreeReader: EMPTY_ORG_TREE,
    });

    expect(run1).toEqual(run2);
  });

  it('populates resolved_scope_candidate when a cluster unambiguously agrees on a slug matching a stubbed [scopes] key (AC6)', async () => {
    const arizonaSlug = '/Users/mdostal/Documents/work/personal/arizona-compound';
    const entries = [
      makeEntry({ sessionId: 's1', verdict: 'keep', summary: 'a', projectSlug: arizonaSlug }),
      makeEntry({ sessionId: 's2', verdict: 'keep', summary: 'a2', projectSlug: arizonaSlug }),
      makeEntry({ sessionId: 's3', verdict: 'keep', summary: 'a3', projectSlug: arizonaSlug }),
      makeEntry({ sessionId: 's4', verdict: 'keep', summary: 'a4', projectSlug: arizonaSlug }),
    ];
    const { embedder } = stubEmbedder({
      a: [1, 0, 0],
      a2: [0.99, 0.1, 0],
      a3: [0.98, 0.1, 0],
      a4: [0.97, 0.1, 0],
    });
    const scopeReader = stubScopeReader({
      arizona: 'clients_arizona_compound_memory',
      personal: 'personal_memory',
    });

    const result = await clusterConversations({
      entries,
      embedder,
      scopeConfigReader: scopeReader,
      orgTreeReader: EMPTY_ORG_TREE,
      similarityThreshold: 0.9,
    });

    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]!.resolved_scope_candidate).toEqual({
      scope_key: 'arizona',
      collection: 'clients_arizona_compound_memory',
      matched_registry: 'swarm-memory-scopes',
      review_reason: 'scope_route_candidate',
    });
    expect(scopeReader.calls).toBe(1);
  });

  it('produces a null resolved_scope_candidate for a genuinely mixed-slug cluster -- never a best guess (AC7)', async () => {
    const entries = [
      makeEntry({ sessionId: 's1', verdict: 'keep', summary: 'x1', projectSlug: '/Users/x/arizona-compound' }),
      makeEntry({ sessionId: 's2', verdict: 'keep', summary: 'x2', projectSlug: '/Users/x/personal-stuff' }),
      makeEntry({ sessionId: 's3', verdict: 'keep', summary: 'x3', projectSlug: '/Users/x/some-client' }),
      makeEntry({ sessionId: 's4', verdict: 'keep', summary: 'x4', projectSlug: '/Users/x/another-thing' }),
      makeEntry({ sessionId: 's5', verdict: 'keep', summary: 'x5', projectSlug: '/Users/x/arizona-compound' }),
    ];
    // All five vectors mutually similar enough to land in ONE cluster
    // despite five different project slugs (2 of 5 share arizona-compound
    // -- 40%, well under the 80% overwhelming-majority threshold).
    const { embedder } = stubEmbedder({
      x1: [1, 0],
      x2: [0.99, 0.05],
      x3: [0.98, 0.05],
      x4: [0.97, 0.05],
      x5: [0.96, 0.05],
    });
    const scopeReader = stubScopeReader({ arizona: 'clients_arizona_compound_memory' });

    const result = await clusterConversations({
      entries,
      embedder,
      scopeConfigReader: scopeReader,
      orgTreeReader: EMPTY_ORG_TREE,
      similarityThreshold: 0.9,
    });

    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]!.resolved_scope_candidate).toBeNull();
  });

  it('falls through to org-tree when swarm-memory scopes has no match, and matched_registry names the real source', async () => {
    const slug = '/Users/mdostal/Documents/work/pantheon/mnemosyne';
    const entries = [
      makeEntry({ sessionId: 's1', verdict: 'keep', summary: 'y1', projectSlug: slug }),
      makeEntry({ sessionId: 's2', verdict: 'keep', summary: 'y2', projectSlug: slug }),
    ];
    const { embedder } = stubEmbedder({ y1: [1, 0], y2: [0.99, 0.1] });
    const scopeReader = stubScopeReader({ arizona: 'clients_arizona_compound_memory' }); // no 'mnemosyne' key
    const orgTreeReader = stubOrgTreeReader([
      {
        repo_path: slug,
        collection: 'project-mnemosyne',
        scope: 'project',
        org_tree_path: 'org/project/mnemosyne',
        needs_override: false,
        onboarded_at: '2026-08-19T00:00:00Z',
      },
    ]);

    const result = await clusterConversations({
      entries,
      embedder,
      scopeConfigReader: scopeReader,
      orgTreeReader,
      similarityThreshold: 0.9,
    });

    expect(result.clusters[0]!.resolved_scope_candidate).toEqual({
      scope_key: 'project',
      collection: 'project-mnemosyne',
      matched_registry: 'org-tree',
      review_reason: 'scope_route_candidate',
    });
  });

  it('performs zero write/create calls anywhere against a scope registry, config file, or Qdrant collection (AC8, hard constraint)', async () => {
    const entries = [makeEntry({ sessionId: 's1', verdict: 'keep', summary: 'z', projectSlug: '/a' })];
    const { embedder } = stubEmbedder({ z: [1, 0] });

    await clusterConversations({
      entries,
      embedder,
      scopeConfigReader: stubScopeReader({ arizona: 'clients_arizona_compound_memory' }),
      orgTreeReader: EMPTY_ORG_TREE,
    });

    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled();
    expect(vi.mocked(fs.appendFileSync)).not.toHaveBeenCalled();
    expect(vi.mocked(fs.mkdirSync)).not.toHaveBeenCalled();
    expect(vi.mocked(childProcess.execFile)).not.toHaveBeenCalled();
    expect(vi.mocked(childProcess.exec)).not.toHaveBeenCalled();
  });

  describe('missing ~/.mnemosyne/org-tree.yaml (AC9, ro-04 contract)', () => {
    let tempRoot: string;

    afterEach(() => {
      if (tempRoot) {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('completes normally with no error and contributes no candidate from that source when the file genuinely does not exist', async () => {
      tempRoot = mkdtempSync(path.join(tmpdir(), 'mnemosyne-cm06-org-tree-'));
      const definitelyMissingPath = path.join(tempRoot, 'org-tree.yaml');
      expect(fs.existsSync(definitelyMissingPath)).toBe(false);

      // The REAL ro-04 reader, bound to a controlled, definitely-nonexistent
      // temp path -- never this operator's own real
      // ~/.mnemosyne/org-tree.yaml.
      const realOrgTreeReader: OrgTreeReader = {
        readEntries: () => listOrgTreeEntries(definitelyMissingPath),
      };

      const slug = '/Users/mdostal/Documents/work/pantheon/mnemosyne';
      const entries = [
        makeEntry({ sessionId: 's1', verdict: 'keep', summary: 'w1', projectSlug: slug }),
        makeEntry({ sessionId: 's2', verdict: 'keep', summary: 'w2', projectSlug: slug }),
      ];
      const { embedder } = stubEmbedder({ w1: [1, 0], w2: [0.99, 0.1] });

      // No matching swarm-memory scope key either -- forces the org-tree
      // fallback path to be the only possible source, and it must not
      // exist, and this must not throw.
      const result = await clusterConversations({
        entries,
        embedder,
        scopeConfigReader: stubScopeReader({}),
        orgTreeReader: realOrgTreeReader,
        similarityThreshold: 0.9,
      });

      expect(result.clusters).toHaveLength(1);
      expect(result.clusters[0]!.resolved_scope_candidate).toBeNull();
    });
  });
});
