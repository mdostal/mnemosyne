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
 * `project-orchestrator` live in the GLOBAL store (persona-store-global.ts,
 * pf-06); `code-architect` lives in the REPO-LOCAL store
 * (persona-store-repo-local.ts). `PERSONA_STORE_BY_TIER` is the single
 * source of truth for that split — both store backends and any future
 * caller should consult it rather than hardcoding the mapping again.
 *
 * Story: pf-01-persona-schema-repo-local-store (epic: mnemosyne-persona-foundation)
 */

import { existsSync } from 'node:fs';
import { MANDATE_SECTIONS, TIER_CONTENT, TIERS, type Tier, type TierContent, type TierContentSection } from './tiers.js';
import { readRepoLocalPersona, repoLocalPersonaPath } from './persona-store-repo-local.js';
import { DEFAULT_GLOBAL_PERSONA_ROOT, globalPersonaPath, readGlobalPersona } from './persona-store-global.js';

/**
 * Which of the two storage levels (design-discussion.md §3a) a given tier's
 * personas live in. `global` = `~/.mnemosyne/personas/<tier>/<scopeId>.yaml`
 * (persona-store-global.ts, pf-06). `repo-local` =
 * `<repoRoot>/.mnemosyne/personas/<scopeId>.yaml`
 * (persona-store-repo-local.ts, pf-01).
 */
export type PersonaStoreKind = 'global' | 'repo-local';

/**
 * The two-store split, keyed by tier. `code-architect` is the only tier the
 * repo-local store accepts — everything else belongs in the global store
 * (persona-store-global.ts). Both store backends should guard writes
 * against this map rather than re-deriving the split independently.
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
    // A parentRef's tier must be one of the GLOBAL-store tiers
    // (PERSONA_STORE_BY_TIER, the single source of truth for the two-store
    // split) -- a repo-local (code-architect) persona names its applicable
    // global-store parent(s) (pf-11, horizontal-plan.md H5.1), never another
    // repo-local persona. This is a pure shape check: whether a persona
    // actually exists yet at the named (tier, scopeId) is deliberately NOT
    // checked here -- that belongs to the fetch path (pf-12/pf-13), since a
    // parent and its child can be authored in either order.
    const isValidParentRef = (r: unknown): boolean =>
      isPlainRecord(r) &&
      typeof r.tier === 'string' &&
      TIERS.includes(r.tier as Tier) &&
      PERSONA_STORE_BY_TIER[r.tier as Tier] === 'global' &&
      typeof r.scopeId === 'string' &&
      r.scopeId.trim() !== '';
    if (!Array.isArray(candidate.parentRefs) || !candidate.parentRefs.every(isValidParentRef)) {
      throw new Error(
        "Invalid persona: 'parentRefs', if present, must be an array of {tier, scopeId} pairs " +
          "whose tier is one of top-orchestrator, company-director, project-orchestrator -- a " +
          'repo-local persona cannot name another repo-local persona as its parent.',
      );
    }
  }
}

/**
 * Context `getPersonaContent` needs to resolve a scoped persona. `repoRoot`
 * is the repo-local store's root (required by every call, even a
 * global-tier one, since callers like sync.ts always have a repo root handy
 * and today's call sites never omit it). `globalPersonaRoot` is an optional
 * override of the global store's root (persona-store-global.ts's
 * `DEFAULT_GLOBAL_PERSONA_ROOT`, `~/.mnemosyne/personas`, when omitted) --
 * exists purely so tests can point the global-tier dispatch path at a temp
 * directory instead of the real `$HOME`, mirroring the `root` parameter
 * persona-store-global.ts's own functions already accept.
 */
export interface PersonaContentContext {
  repoRoot: string;
  globalPersonaRoot?: string;
}

/**
 * Re-injects `MANDATE_SECTIONS` as an explicit, named step -- mirrors
 * tiers.ts's `tier()` builder helper (tiers.ts, `mandateSections: [...MANDATE_SECTIONS]`),
 * which does the same thing inline for the hardcoded `TIER_CONTENT` map.
 * `mandateSections` is always the shared, code-owned `MANDATE_SECTIONS`
 * constant, spread fresh on every call so callers can never mutate the
 * shared array by reference. Personas themselves are never allowed to carry
 * their own `mandateSections` (`assertValidPersona` rejects mere presence of
 * the key) -- this is the one place that value gets attached, at render
 * time, for a repo-local persona hit.
 */
function reinjectMandateSections(base: Omit<TierContent, 'mandateSections'>): TierContent {
  return { ...base, mandateSections: [...MANDATE_SECTIONS] };
}

/**
 * Shared fallback-and-warn safety net for BOTH persona-store dispatch paths
 * (repo-local's `code-architect`, pf-02; global's three tiers, pf-07) -- one
 * implementation so a fix to this behavior (e.g. the warning's wording, or
 * whether it fires at all) applies to both paths without a second patch
 * (pf-07-getpersonacontent-global-dispatch.yaml's design_decisions). Not
 * silent -- an empty store falling back unnoticed is exactly what
 * horizontal-plan.md H2.1 flags as a risk, and what pf-08's seed script
 * later relies on this warning to surface. `expectedPath` is whatever path
 * the caller actually checked (`repoLocalPersonaPath`'s or
 * `globalPersonaPath`'s result), named in the warning so an operator can go
 * look at exactly that path.
 */
function fallbackToTierContentWithWarning(
  tier: Tier,
  scopeId: string,
  storeKind: PersonaStoreKind,
  expectedPath: string,
): TierContent {
  // eslint-disable-next-line no-console
  console.warn(
    `[mnemosyne/layer1] No ${storeKind} persona found for tier '${tier}', scopeId '${scopeId}' ` +
      `(expected at ${expectedPath}) -- falling back to the hardcoded TIER_CONTENT['${tier}']. ` +
      'Seed a real persona for this scope to replace this fallback.',
  );
  return TIER_CONTENT[tier];
}

/**
 * Resolves the actual content to render for one tier + scope -- replaces the
 * old bare-tier `getTierContent(tier)` assumption (design-discussion.md
 * §3a; pf-02). Dispatch keys off `PERSONA_STORE_BY_TIER`, the single source
 * of truth for the two-store split, not a duplicated if/else:
 *
 *   - `tier === 'code-architect'` (repo-local store, pf-02): if a persona
 *     exists on disk for `scopeId` under `ctx.repoRoot`, renders THAT
 *     persona's content, with `MANDATE_SECTIONS` explicitly re-injected
 *     (personas never store their own mandate). If none exists yet, falls
 *     back via `fallbackToTierContentWithWarning`.
 *   - every other tier (global store, pf-07): same shape, against
 *     persona-store-global.ts's `globalPersonaPath`/`readGlobalPersona`
 *     instead -- if a persona exists on disk for `scopeId` under
 *     `ctx.globalPersonaRoot` (defaulting to `DEFAULT_GLOBAL_PERSONA_ROOT`,
 *     `~/.mnemosyne/personas`, when omitted), renders it, mandate
 *     re-injected the same way. If none exists yet, falls back via the same
 *     shared `fallbackToTierContentWithWarning` helper the repo-local path
 *     uses -- not a second, drifted copy of the fallback logic.
 *
 * `getTierContent(tier)`'s old bare-tier signature is fully removed by this
 * story (tiers.ts no longer exports it) -- this is the one and only
 * content-resolution entry point `sync.ts` calls now.
 */
export function getPersonaContent(tier: Tier, scopeId: string, ctx: PersonaContentContext): TierContent {
  if (!TIER_CONTENT[tier]) {
    throw new Error(`Unknown tier: ${String(tier)}. Valid tiers are: ${TIERS.join(', ')}.`);
  }

  if (PERSONA_STORE_BY_TIER[tier] === 'global') {
    const globalRoot = ctx.globalPersonaRoot ?? DEFAULT_GLOBAL_PERSONA_ROOT;
    const personaPath = globalPersonaPath(tier, scopeId, globalRoot);
    if (!existsSync(personaPath)) {
      return fallbackToTierContentWithWarning(tier, scopeId, 'global', personaPath);
    }

    const persona = readGlobalPersona(tier, scopeId, globalRoot);
    return reinjectMandateSections({
      tier: persona.tier,
      displayName: persona.displayName,
      scope: persona.scope,
      sections: persona.sections,
    });
  }

  const personaPath = repoLocalPersonaPath(ctx.repoRoot, scopeId);
  if (!existsSync(personaPath)) {
    return fallbackToTierContentWithWarning(tier, scopeId, 'repo-local', personaPath);
  }

  const persona = readRepoLocalPersona(ctx.repoRoot, scopeId);
  return reinjectMandateSections({
    tier: persona.tier,
    displayName: persona.displayName,
    scope: persona.scope,
    sections: persona.sections,
  });
}
