/**
 * cm-06-cross-session-clustering (epic: mnemosyne-conversation-memory).
 *
 * Embedding-based similarity clustering over `cm-05`'s own bounded per-
 * session SUMMARY text (never the raw transcript, never the full
 * normalized-turn list -- design-discussion.md §2.6, this story's own
 * design_decisions), faceted (never partitioned) by the real project-slug
 * signal `cm-02`/`cm-03` already carry. Round-3 addition (design-
 * discussion.md §10.2): a strictly READ-ONLY `resolved_scope_candidate`
 * sub-step, computed here, acted on nowhere in this story.
 *
 * ---------------------------------------------------------------------------
 * Input contract -- a real, named gap, not silently assumed away.
 * ---------------------------------------------------------------------------
 * `cm-05`'s own `TriageQueueEntry` (`triageSession.ts`) does NOT carry
 * `projectSlug` today -- it was never added to that story's own scope. This
 * story's `ClusterableTriageEntry` is therefore its own, narrower input
 * contract: the `{sessionId, verdict, summary}` fields `TriageQueueEntry`
 * already has, PLUS `projectSlug` -- a field already real and available
 * upstream (`cm-02`'s discovery manifest, carried through `cm-03`'s
 * `ConversationTurn.projectSlug`, per this story's own YAML description).
 * A future orchestrator (`cm-08`/`cm-11`) is expected to enrich queue
 * entries with that already-real value before calling
 * `clusterConversations()` -- this module does not itself read the queue
 * file or re-derive a slug from a source path.
 *
 * ---------------------------------------------------------------------------
 * trash-verdict exclusion -- defense in depth (this story's own AC2 +
 * the task's own hard constraint).
 * ---------------------------------------------------------------------------
 * design-discussion.md `[grill 2.1]` resolves this explicitly: trash-
 * verdict sessions never reach this story's input AT ALL, not merely
 * filtered from output -- that is a CALLER responsibility (the orchestrator
 * must not pass trash entries in). This module additionally, defensively,
 * filters `entries` down to `keep`/`uncertain` BEFORE calling `embedder.
 * embed()` even once -- so even if a caller ever passed a trash entry by
 * mistake, no embedding call is ever made for its summary. Verified
 * directly by `clusterConversations.test.ts`'s trash-exclusion test (a
 * stub embedder that throws on any unrecognized text).
 *
 * ---------------------------------------------------------------------------
 * The embedder -- the SAME one `VectorLayerAdapter.ts` already uses in
 * production, no new embedding infrastructure.
 * ---------------------------------------------------------------------------
 * `VectorLayerAdapter.ts` never itself calls an embedding model directly --
 * it shells out to the `swarm-memory` CLI, which resolves embeddings
 * internally (confirmed live, this story's own research step: `swarm-
 * memory config`'s real JSON output names `{provider: 'ollama', model:
 * 'nomic-embed-text', url: 'http://localhost:11434', dim: 768}`). There is
 * no existing JS/TS function to import that returns a raw embedding vector
 * -- `swarm-memory index` (the only CLI path that touches the real
 * embedder) also upserts into Qdrant, a real WRITE this story must never
 * perform (only `cm-08`'s pilot run is allowed to reach Qdrant, per
 * structured-outline.md §Phase 6). `createDefaultEmbedder()` below is
 * therefore the correct, non-duplicative production path: it reads the
 * SAME `swarm-memory config` shell-out (`readSwarmMemoryConfig()`,
 * exported from `VectorLayerAdapter.ts` for exactly this reuse) to learn
 * the real, already-configured embedder's model/url, then calls that same
 * Ollama HTTP embeddings endpoint directly -- no new provider, no new
 * model, no new external API credential surface (this story's own
 * cross_cutting `existing-infrastructure` concern). `clusterConversations.
 * test.ts` NEVER exercises this function -- every test supplies its own
 * stub `Embedder`, mirroring `triageSession.ts`'s own `createDefault
 * TriageLlmClient()` convention exactly (also untested directly, by
 * design).
 *
 * ---------------------------------------------------------------------------
 * Clustering algorithm -- deterministic, no new dependency.
 * ---------------------------------------------------------------------------
 * This story's own research step (see its YAML `steps.research`) weighed a
 * clustering-library dependency against a simple threshold/agglomerative
 * approach. This repo's `package.json` has no clustering library today, and
 * introducing one would trigger this repo's own always-on new-dependency
 * validation discipline for no real benefit at pilot scale (dozens, not
 * millions, of sessions per cm-08's own bounded-sample design). A plain
 * cosine-similarity threshold + union-find (disjoint-set) merge is O(n^2),
 * trivially deterministic (no randomness anywhere), and satisfies this
 * story's own AC5 (stable/reproducible assignments for the same input)
 * directly, by construction -- never merely hoped true.
 *
 * ---------------------------------------------------------------------------
 * resolved_scope_candidate -- strictly read-only, zero side effects.
 * ---------------------------------------------------------------------------
 * See design-discussion.md §10.2 for the full three-way "scope" vocabulary
 * disambiguation and residual-risk framing. Concretely, this module:
 *   - NEVER writes/creates/mutates a scope, a collection, or an org-tree
 *     entry -- `ScopeConfigReader`/`OrgTreeReader` below are READ-ONLY
 *     interfaces by construction (no write method exists on either type),
 *     and this file imports no fs-write or exec-capable primitive at all
 *     (verified directly by `clusterConversations.test.ts`'s AC8 test, which
 *     spies on `node:fs`'s and `node:child_process`'s write/exec functions
 *     and asserts none are ever called).
 *   - Only ever proposes a candidate, tagged `review_reason:
 *     'scope_route_candidate'` (mirrors `cm-01`'s own `quarantine_reason`
 *     tagging convention) -- surfacing that candidate into the real,
 *     on-disk human-review queue is a LATER story's own wiring (`cm-07`
 *     is the only story that ever WRITES a non-`meta` scope, gated on
 *     explicit operator confirmation); this module returns the candidate
 *     as in-memory cluster metadata only.
 *   - Requires UNAMBIGUOUS cluster-level project-slug agreement
 *     (`computeDominantSlug()`, `DEFAULT_DOMINANT_SLUG_THRESHOLD` below) --
 *     a mixed-slug cluster with no dominant slug produces `null`, never a
 *     best guess (this story's own AC7).
 *   - Checks `swarm-memory`'s own `[scopes]` table FIRST (via the exact
 *     SAME `swarm-memory config` shell-out `VectorLayerAdapter.remember()`
 *     already performs, `readSwarmMemoryConfig()`), then
 *     `~/.mnemosyne/org-tree.yaml` SECOND (via ro-04's own real, unmodified
 *     `listOrgTreeEntries()` reader, which already implements "missing file
 *     is not an error, returns empty" -- this story's own AC9 reuses that
 *     contract directly rather than re-implementing it).
 */

import { readSwarmMemoryConfig } from '../layers/VectorLayerAdapter.js';
import { listOrgTreeEntries, type OrgTreeEntry } from '../onboarding/orgTree.js';
import type { TriageVerdict } from './triageSession.js';

// ---------------------------------------------------------------------------
// Named constants -- real, documented design decisions (this story's own
// research step), not assumed/tuned silently.
// ---------------------------------------------------------------------------

/**
 * Cosine-similarity floor for two sessions' summary embeddings to be
 * considered "the same cluster." `nomic-embed-text` cosine scores in the
 * ~0.8-0.85 range are a conventional semantic-near-duplicate/strong-overlap
 * band; real tuning against actual pilot data is explicitly deferred to
 * `cm-08`'s own pilot run (this story's own `metric` block/risk R10
 * mitigation), not claimed ML-grade here.
 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.82;

/**
 * A cluster's dominant non-null project-slug must cover at least this
 * fraction of ALL members (not merely of slug-bearing members) to be
 * "unambiguous" (this story's own AC6/AC7 + design-discussion.md §10.2's
 * "all/overwhelming-majority member agreement"). Below this share, the
 * cluster is genuinely mixed and `resolved_scope_candidate` is `null` --
 * erring toward no-match is the named, accepted safe default (§10.2's
 * residual-risk framing), never a best guess.
 */
export const DEFAULT_DOMINANT_SLUG_THRESHOLD = 0.8;

const SCOPE_ROUTE_REVIEW_REASON = 'scope_route_candidate' as const;

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------

/**
 * This story's own, narrower input shape -- see the module doc comment's
 * "Input contract" section for why this is not simply `cm-05`'s
 * `TriageQueueEntry` unchanged.
 */
export interface ClusterableTriageEntry {
  sessionId: string;
  verdict: TriageVerdict;
  summary: string;
  /** The session's real project-slug facet (`cm-02`/`cm-03`), or `null` for a source with no project concept (e.g. a standalone ChatGPT conversation). */
  projectSlug: string | null;
}

// ---------------------------------------------------------------------------
// Embedder -- injectable; SAME embedder the vector layer already uses in
// production (see module doc comment).
// ---------------------------------------------------------------------------

export interface Embedder {
  /** Returns a real embedding vector for `text`. Tests MUST supply a stub -- see `clusterConversations.test.ts`. */
  embed(text: string): Promise<number[]>;
}

export interface CreateDefaultEmbedderOptions {
  /** Executable to shell out to for `swarm-memory config`. Defaults to `SWARM_MEMORY_BIN` or `swarm-memory` on PATH (matches `VectorLayerAdapter`'s own default). */
  command?: string;
  timeoutMs?: number;
  /** Fallback embedder URL when `swarm-memory config`'s own output omits `embedder.url`. Real, live-confirmed default for this operator's own machine. */
  fallbackUrl?: string;
  /** Fallback embedder model, same rationale as `fallbackUrl`. */
  fallbackModel?: string;
}

/**
 * Real, production `Embedder` -- reads the SAME `swarm-memory config`
 * shell-out `VectorLayerAdapter.remember()` already performs to learn the
 * real, already-configured embedder's model/url, then calls that same
 * Ollama embeddings HTTP endpoint directly (no new provider, no new
 * external API credential surface). Never used by
 * `clusterConversations.test.ts` -- every test there supplies its own stub
 * (mirrors `triageSession.ts`'s `createDefaultTriageLlmClient()`
 * convention exactly).
 */
export function createDefaultEmbedder(options: CreateDefaultEmbedderOptions = {}): Embedder {
  return {
    async embed(text: string): Promise<number[]> {
      const cfg = await readSwarmMemoryConfig(options.command, options.timeoutMs);
      const url = cfg.embedder?.url ?? options.fallbackUrl ?? 'http://localhost:11434';
      const model = cfg.embedder?.model ?? options.fallbackModel ?? 'nomic-embed-text';

      const response = await fetch(`${url.replace(/\/$/, '')}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: text }),
      });
      if (!response.ok) {
        throw new Error(`embedder request to ${url} failed: HTTP ${response.status}`);
      }
      const data = (await response.json()) as { embeddings?: number[][] };
      const vector = data.embeddings?.[0];
      if (!vector) {
        throw new Error(`embedder response from ${url} did not include an embedding vector`);
      }
      return vector;
    },
  };
}

// ---------------------------------------------------------------------------
// Scope-resolution readers -- strictly READ-ONLY by construction (neither
// interface below has a write method).
// ---------------------------------------------------------------------------

export interface ScopeConfigReader {
  /** Returns swarm-memory's own `[scopes]` table (`key -> collection name`). Read-only. */
  readScopes(): Promise<Record<string, string>> | Record<string, string>;
}

export interface OrgTreeReader {
  /** Returns every entry in `~/.mnemosyne/org-tree.yaml` (or `[]` when the file does not exist -- ro-04's own established contract). Read-only. */
  readEntries(): Promise<OrgTreeEntry[]> | OrgTreeEntry[];
}

/**
 * Real, production `ScopeConfigReader` -- reuses the EXACT SAME
 * `swarm-memory config` shell-out `VectorLayerAdapter.remember()` already
 * performs (`readSwarmMemoryConfig()`), never a second, independently-
 * implemented TOML/JSON parse of `config.toml`. Never used by
 * `clusterConversations.test.ts` -- every test supplies a stub.
 */
export function createDefaultScopeConfigReader(command?: string, timeoutMs?: number): ScopeConfigReader {
  return {
    async readScopes(): Promise<Record<string, string>> {
      const cfg = await readSwarmMemoryConfig(command, timeoutMs);
      return cfg.scopes ?? {};
    },
  };
}

/**
 * Real, production `OrgTreeReader` -- reuses ro-04's own, unmodified
 * `listOrgTreeEntries()` (`~/.mnemosyne/org-tree.yaml`, `DEFAULT_ORG_TREE_
 * PATH` when `orgTreePath` is omitted). Never used by
 * `clusterConversations.test.ts`'s stubbed tests; the one AC9 test that
 * exercises the "missing file" contract directly constructs its own
 * `OrgTreeReader` around this same function, bound to a controlled,
 * definitely-nonexistent temp path.
 */
export function createDefaultOrgTreeReader(orgTreePath?: string): OrgTreeReader {
  return {
    readEntries(): OrgTreeEntry[] {
      return listOrgTreeEntries(orgTreePath);
    },
  };
}

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

export type ScopeCandidateRegistry = 'swarm-memory-scopes' | 'org-tree';

export interface ResolvedScopeCandidate {
  /** The real, already-existing scope key matched (e.g. `'arizona'`). */
  scope_key: string;
  /** That scope key's real, already-existing collection name. */
  collection: string;
  /** Which real registry produced the match. */
  matched_registry: ScopeCandidateRegistry;
  /** Fixed tag, mirrors `cm-01`'s `quarantine_reason` tagging convention -- this story's own §10.2 review-queue surface, actually written by a later story. */
  review_reason: typeof SCOPE_ROUTE_REVIEW_REASON;
}

export interface ClusterMember {
  sessionId: string;
  projectSlug: string | null;
}

export interface Cluster {
  cluster_id: string;
  /** Short, human-facing label -- derived deterministically, never randomly generated. */
  cluster_label: string;
  member_session_ids: string[];
  members: ClusterMember[];
  /** Unique, real project-slug facet(s) of this cluster's members (`null` excluded from this list; a cluster entirely of `null`-slug members has an empty array here, never fabricated). */
  project_slugs: string[];
  /** `null` unless cluster members unambiguously agree on a slug that matches a real, already-existing scope key (AC6/AC7). Never acted on by this story. */
  resolved_scope_candidate: ResolvedScopeCandidate | null;
}

export interface ClusterConversationsResult {
  clusters: Cluster[];
  /** `sessionId -> cluster_id`, one entry for every keep/uncertain input session -- AC1's own "none silently dropped" guarantee, directly inspectable. */
  assignments: Record<string, string>;
}

export interface ClusterConversationsOptions {
  entries: ClusterableTriageEntry[];
  /** Defaults to `createDefaultEmbedder()` for real production wiring; tests MUST pass an explicit stub. */
  embedder?: Embedder;
  /** Defaults to `createDefaultScopeConfigReader()`; tests MUST pass an explicit stub. */
  scopeConfigReader?: ScopeConfigReader;
  /** Defaults to `createDefaultOrgTreeReader()`; tests MUST pass an explicit reader (stub, or the real reader bound to a controlled path). */
  orgTreeReader?: OrgTreeReader;
  similarityThreshold?: number;
  dominantSlugThreshold?: number;
}

// ---------------------------------------------------------------------------
// Pure helper functions -- exported individually for direct unit testing.
// ---------------------------------------------------------------------------

/** Standard cosine similarity. `0` (never `NaN`, never throws) when either vector has zero magnitude. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Deterministic threshold + union-find (disjoint-set) agglomerative
 * clustering over `vectors` (index-aligned with the caller's own item
 * list). Returns groups of ORIGINAL indices, each group sorted ascending,
 * and the list of groups itself sorted by each group's minimum index --
 * the SAME `vectors` array ALWAYS produces the SAME grouping (this
 * story's own AC5), no randomness anywhere.
 */
export function clusterBySimilarity(vectors: number[][], threshold: number): number[][] {
  const n = vectors.length;
  const parent = Array.from({ length: n }, (_, i) => i);

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  }
  function union(a: number, b: number): void {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent[rootA] = rootB;
    }
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (cosineSimilarity(vectors[i]!, vectors[j]!) >= threshold) {
        union(i, j);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) {
      groups.set(root, []);
    }
    groups.get(root)!.push(i);
  }

  return Array.from(groups.values())
    .map((group) => [...group].sort((a, b) => a - b))
    .sort((a, b) => a[0]! - b[0]!);
}

/**
 * `slug`'s final path segment, lowercased -- the conservative, deterministic
 * basis for matching against swarm-memory's own short `[scopes]` keys (e.g.
 * `/Users/.../personal/arizona-compound` -> `arizona-compound`). Never
 * fuzzy, never NLP-derived -- a plain string operation over a real,
 * already-decoded absolute path (`decodeProjectSlug()`, `discoverSources.
 * ts`).
 */
export function deriveSlugBasename(slug: string): string {
  const segments = slug.split('/').filter((segment) => segment.length > 0);
  const last = segments.length > 0 ? segments[segments.length - 1]! : slug;
  return last.toLowerCase();
}

export interface DominantSlugResult {
  slug: string;
  share: number;
}

/**
 * The most-common NON-NULL slug among `slugs`, only when its share of
 * `slugs.length` (the WHOLE cluster, not merely slug-bearing members) meets
 * `threshold` -- this story's own "unambiguous... all/overwhelming-majority
 * member agreement" rule (design-discussion.md §10.2, AC6/AC7). Returns
 * `null` when no slug reaches the threshold (including when every slug is
 * `null`). Ties are broken deterministically (highest count first, then
 * lexicographic slug order) -- named explicitly rather than left to object-
 * key iteration order.
 */
export function computeDominantSlug(slugs: (string | null)[], threshold: number): DominantSlugResult | null {
  const counts = new Map<string, number>();
  for (const slug of slugs) {
    if (slug === null) continue;
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  if (counts.size === 0 || slugs.length === 0) {
    return null;
  }

  const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [topSlug, topCount] = ranked[0]!;
  const share = topCount / slugs.length;
  return share >= threshold ? { slug: topSlug, share } : null;
}

/**
 * Matches `dominantSlug` against swarm-memory's `[scopes]` table first
 * (basename exact-or-prefix match, e.g. `arizona` matches
 * `arizona-compound`), then `~/.mnemosyne/org-tree.yaml` entries second
 * (exact `repo_path` match against the real, already-decoded absolute
 * slug) -- never fuzzy, never inferred from content, never a NEW scope
 * name proposed. `null` when neither real, already-existing registry has a
 * match.
 */
function matchScopeCandidate(
  dominantSlug: string,
  scopes: Record<string, string>,
  orgTreeEntries: OrgTreeEntry[],
): ResolvedScopeCandidate | null {
  const basename = deriveSlugBasename(dominantSlug);
  const scopeKeys = Object.keys(scopes)
    // Longest key first -- a more specific real key (e.g. 'arizona-compound'
    // over a shorter unrelated key) wins deterministically if more than one
    // real key would otherwise match the same basename.
    .sort((a, b) => b.length - a.length);
  for (const key of scopeKeys) {
    const lowerKey = key.toLowerCase();
    const isMatch = basename === lowerKey || basename.startsWith(`${lowerKey}-`) || basename.startsWith(`${lowerKey}_`);
    if (isMatch) {
      return {
        scope_key: key,
        collection: scopes[key]!,
        matched_registry: 'swarm-memory-scopes',
        review_reason: SCOPE_ROUTE_REVIEW_REASON,
      };
    }
  }

  const orgTreeMatch = orgTreeEntries.find((entry) => entry.repo_path === dominantSlug);
  if (orgTreeMatch) {
    return {
      scope_key: orgTreeMatch.scope,
      collection: orgTreeMatch.collection,
      matched_registry: 'org-tree',
      review_reason: SCOPE_ROUTE_REVIEW_REASON,
    };
  }

  return null;
}

/** Short, deterministic human-facing label -- the dominant slug's basename when unambiguous, otherwise a bounded, sorted join of every distinct slug basename present. */
function deriveClusterLabel(members: ClusterMember[], dominant: DominantSlugResult | null): string {
  if (dominant) {
    return deriveSlugBasename(dominant.slug);
  }
  const basenames = Array.from(
    new Set(members.map((m) => m.projectSlug).filter((s): s is string => s !== null).map(deriveSlugBasename)),
  ).sort();
  if (basenames.length === 0) {
    return 'mixed';
  }
  const shown = basenames.slice(0, 3);
  const suffix = basenames.length > shown.length ? ` +${basenames.length - shown.length} more` : '';
  return `${shown.join(' + ')}${suffix}`;
}

// ---------------------------------------------------------------------------
// clusterConversations() -- the public entry point.
// ---------------------------------------------------------------------------

export async function clusterConversations(
  options: ClusterConversationsOptions,
): Promise<ClusterConversationsResult> {
  const embedder = options.embedder ?? createDefaultEmbedder();
  const scopeConfigReader = options.scopeConfigReader ?? createDefaultScopeConfigReader();
  const orgTreeReader = options.orgTreeReader ?? createDefaultOrgTreeReader();
  const similarityThreshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const dominantSlugThreshold = options.dominantSlugThreshold ?? DEFAULT_DOMINANT_SLUG_THRESHOLD;

  // Defensive filter -- trash-verdict entries are excluded from this
  // function's own working set BEFORE embed() is ever called, even once
  // (this story's own AC2 + the task's own hard constraint). Per design,
  // callers should never pass trash entries in at all; this is defense in
  // depth, not the primary control.
  const workingEntries = options.entries.filter((entry) => entry.verdict === 'keep' || entry.verdict === 'uncertain');

  if (workingEntries.length === 0) {
    return { clusters: [], assignments: {} };
  }

  const vectors = await Promise.all(workingEntries.map((entry) => embedder.embed(entry.summary)));

  const groups = clusterBySimilarity(vectors, similarityThreshold);

  const [scopes, orgTreeEntries] = await Promise.all([
    Promise.resolve(scopeConfigReader.readScopes()),
    Promise.resolve(orgTreeReader.readEntries()),
  ]);

  const clusters: Cluster[] = [];
  const assignments: Record<string, string> = {};

  groups.forEach((indices, clusterIndex) => {
    const members: ClusterMember[] = indices.map((i) => ({
      sessionId: workingEntries[i]!.sessionId,
      projectSlug: workingEntries[i]!.projectSlug,
    }));
    const memberSlugs = members.map((m) => m.projectSlug);
    const dominant = computeDominantSlug(memberSlugs, dominantSlugThreshold);
    const resolvedScopeCandidate = dominant ? matchScopeCandidate(dominant.slug, scopes, orgTreeEntries) : null;

    const clusterId = `cluster-${clusterIndex}`;
    const cluster: Cluster = {
      cluster_id: clusterId,
      cluster_label: deriveClusterLabel(members, dominant),
      member_session_ids: members.map((m) => m.sessionId),
      members,
      project_slugs: Array.from(new Set(memberSlugs.filter((s): s is string => s !== null))),
      resolved_scope_candidate: resolvedScopeCandidate,
    };
    clusters.push(cluster);

    for (const member of members) {
      assignments[member.sessionId] = clusterId;
    }
  });

  return { clusters, assignments };
}
