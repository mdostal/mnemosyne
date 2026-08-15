/**
 * Layer 1 — persona schema.
 *
 * A "persona" is one tier instance, scoped by an explicit human-assigned
 * identifier (design-discussion.md §3a): `{tier, scopeId, content}`, where
 * `content` is `TierContent` (see tiers.ts) MINUS `mandateSections`.
 * `mandateSections` stays a shared, code-owned constant re-injected at
 * render time (pf-02's `getPersonaContent`) — it is never author-storable,
 * so a wizard/human can never accidentally author mandate-shaped content
 * into a persona record. `assertValidPersona` is the real enforcement point
 * for that rule, not just documentation (design-discussion.md Risks table).
 *
 * Personas are split across two storage levels by tier (design-discussion.md
 * §3a, operator-resolved): `top-orchestrator` / `company-director` /
 * `project-orchestrator` live in the GLOBAL store (not built in this story);
 * `code-architect` lives in the REPO-LOCAL store
 * (persona-store-repo-local.ts). `PERSONA_STORE_BY_TIER` is the single
 * source of truth for that split — both store backends and any future
 * caller should consult it rather than hardcoding the mapping again.
 *
 * Story: pf-01-persona-schema-repo-local-store (epic: mnemosyne-persona-foundation)
 */

import { TIERS, type Tier, type TierContentSection } from './tiers.js';

/**
 * Which of the two storage levels (design-discussion.md §3a) a given tier's
 * personas live in. `global` = `~/.mnemosyne/personas/` (not built in this
 * story — see pf-01's later sibling story for the global store). `repo-local`
 * = `<repoRoot>/.mnemosyne/personas/` (persona-store-repo-local.ts, this
 * story).
 */
export type PersonaStoreKind = 'global' | 'repo-local';

/**
 * The two-store split, keyed by tier. `code-architect` is the only tier the
 * repo-local store accepts — everything else belongs in the (not-yet-built)
 * global store. Both store backends should guard writes against this map
 * rather than re-deriving the split independently.
 */
export const PERSONA_STORE_BY_TIER: Record<Tier, PersonaStoreKind> = {
  'top-orchestrator': 'global',
  'company-director': 'global',
  'project-orchestrator': 'global',
  'code-architect': 'repo-local',
};

/**
 * The persona data shape. Structurally compatible with `TierContent`
 * (tiers.ts) minus `mandateSections` — the fields `sync.ts`/pf-02's
 * `getPersonaContent` need to render are all here (`displayName`, `scope`,
 * `sections`), plus persona-specific identity (`tier`, `scopeId`) and an
 * extension point for the query-up mechanism (`parentRefs`, unused until
 * pf-11/pf-12 — see horizontal-plan.md H1.1, kept now to avoid a second
 * schema migration later).
 */
export interface Persona {
  tier: Tier;
  /** Human-assigned scope identifier (company/project/repo name) — plain label, no auto-detection (design-discussion.md Risks table). */
  scopeId: string;
  /** Human-readable tier/persona name, e.g. "Code/Area Architect". Rendered as a heading. */
  displayName: string;
  /** One-line statement of what this persona is responsible for and what it is NOT. */
  scope: string;
  sections: TierContentSection[];
  /**
   * Optional pointers into applicable parent-tier scopeId(s) so a lower-tier
   * persona can query UP into its parent's store on demand (design-
   * discussion.md Risks table: "query up, never copy down"). Unused until
   * pf-11/pf-12 (Slice 3) — present now, harmless if unused, per
   * horizontal-plan.md H1.1 and H5.1 (`{tier, scopeId}[]` pairs, not bare
   * strings — a parent is identified by both which tier's store to look in
   * and which scopeId within it).
   */
  parentRefs?: { tier: Tier; scopeId: string }[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTierContentSection(value: unknown): value is TierContentSection {
  return (
    isPlainRecord(value) &&
    typeof value.heading === 'string' &&
    typeof value.body === 'string'
  );
}

/**
 * Validates a persona candidate and narrows its type. Throws a clear,
 * specific error on the first violation found rather than collecting all
 * violations — callers (store write/read paths) only need to know
 * "invalid, and why," not a full validation report.
 *
 * `expectedTier` is the tier the caller already knows this persona should
 * be (e.g. the store it's being written to, or the tier a caller asked to
 * read). A mismatch between `candidate.tier` and `expectedTier` is rejected
 * here — this is the schema-level half of tier/store-mismatch protection;
 * `persona-store-repo-local.ts` additionally guards at the store level via
 * `PERSONA_STORE_BY_TIER` before ever calling this.
 */
export function assertValidPersona(candidate: unknown, expectedTier: Tier): asserts candidate is Persona {
  if (!isPlainRecord(candidate)) {
    throw new Error(`Invalid persona: expected an object, got ${typeof candidate}.`);
  }

  // mandateSections is never author-storable (design-discussion.md §3a) --
  // reject on mere PRESENCE of the key, regardless of its value, so an
  // empty-array attempt to "smuggle in" the key is caught too.
  if (Object.prototype.hasOwnProperty.call(candidate, 'mandateSections')) {
    throw new Error(
      "Invalid persona: 'mandateSections' is never author-storable -- it is a shared, code-owned " +
        'constant re-injected at render time (design-discussion.md §3a), never per-persona content. ' +
        'Remove it from the candidate before writing.',
    );
  }

  if (typeof candidate.tier !== 'string' || !TIERS.includes(candidate.tier as Tier)) {
    throw new Error(
      `Invalid persona: 'tier' must be one of ${TIERS.join(', ')}, got ${String(candidate.tier)}.`,
    );
  }
  if (candidate.tier !== expectedTier) {
    throw new Error(
      `Persona tier mismatch: expected tier '${expectedTier}', got '${candidate.tier}'.`,
    );
  }

  if (typeof candidate.scopeId !== 'string' || candidate.scopeId.trim() === '') {
    throw new Error("Invalid persona: 'scopeId' must be a non-empty string.");
  }
  if (typeof candidate.displayName !== 'string' || candidate.displayName.trim() === '') {
    throw new Error("Invalid persona: 'displayName' must be a non-empty string.");
  }
  if (typeof candidate.scope !== 'string' || candidate.scope.trim() === '') {
    throw new Error("Invalid persona: 'scope' must be a non-empty string.");
  }

  if (!Array.isArray(candidate.sections) || !candidate.sections.every(isTierContentSection)) {
    throw new Error(
      "Invalid persona: 'sections' must be an array of {heading: string, body: string} entries.",
    );
  }

  if (candidate.parentRefs !== undefined) {
    const isValidParentRef = (r: unknown): boolean =>
      isPlainRecord(r) &&
      typeof r.tier === 'string' &&
      TIERS.includes(r.tier as Tier) &&
      typeof r.scopeId === 'string' &&
      r.scopeId.trim() !== '';
    if (!Array.isArray(candidate.parentRefs) || !candidate.parentRefs.every(isValidParentRef)) {
      throw new Error(
        "Invalid persona: 'parentRefs', if present, must be an array of {tier, scopeId} pairs.",
      );
    }
  }
}
