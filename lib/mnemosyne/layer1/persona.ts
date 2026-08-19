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
 * `resolveRememberScope` (pw-09, OQ2) additionally maps a persona's
 * `{tier, scopeId}` to a real `remember()` call's `scope`/`tag` arguments —
 * see that function's own doc comment for the full rationale.
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
   * discussion.md Risks table: "query up, never copy down"). Schema-validated
   * since pf-11; rendered as pointer-only "Parent context (query up)"
   * sections by `getPersonaContent`'s repo-local dispatch path since pf-12
   * (`buildParentContextSections`) — per horizontal-plan.md H1.1 and H5.1,
   * `{tier, scopeId}[]` pairs, not bare strings, since a parent is identified
   * by both which tier's store to look in and which scopeId within it.
   */
  parentRefs?: { tier: Tier; scopeId: string }[];
  /**
   * Post-approval provenance note (puf-03, closing pu-14's FLAGGED finding
   * D3): once an agent-proposed draft is approved, the resulting live
   * persona is otherwise indistinguishable from a hand-typed one --
   * agent-provenance-trust.md named that distinguishability "a distinctive,
   * concrete strength" of this design lineage, so losing it at approve time
   * was a real regression, not cosmetic. Populated ONLY by the approve route
   * (server.ts's `POST /persona/draft/:tier/:scopeId/approve`), and ONLY
   * when the approved draft itself carried real `proposedBy`/`proposedAt`
   * values -- a human-typed draft with neither has no `origin` at all,
   * never a fabricated one (schema-enforced below by `assertValidPersona`,
   * not left to caller discipline). `proposedBy`/`proposedAt` are copied
   * verbatim from the draft (persona-draft-store.ts's `DraftPersonaCandidate`);
   * `approvedAt` is NOT one of those two -- a draft has no notion of its own
   * future approval time, so this is a fresh, real timestamp the approve
   * route captures itself at the moment of commit, never copied or
   * inferred. All three fields travel together or not at all -- see
   * `assertValidPersona`'s `origin` check.
   */
  origin?: PersonaOrigin;
}

/** {@link Persona.origin}'s shape -- schema-validated by `assertValidPersona`, never an untyped bag. */
export interface PersonaOrigin {
  /** Verbatim from the approved draft's own `proposedBy` (e.g. 'agent'; pf-06 also allows other values for a human-attached draft). */
  proposedBy: string;
  /** Verbatim from the approved draft's own `proposedAt` (ISO 8601) -- when the draft was originally proposed, not when it was approved. */
  proposedAt: string;
  /** When THIS persona was approved -- captured fresh by the approve route itself (server.ts), never copied from the draft. */
  approvedAt: string;
}

/**
 * OQ2 resolver — persona `{tier, scopeId}` -> `remember()` scope mapping
 * (pw-09-remember-scope-mapping; full rationale in a design-discussion.md
 * addendum, "OQ2 Resolution (pw-09)"). Short version for readers who land
 * directly on this code:
 *
 * TARGET: `src/engine.mjs`'s `remember(text, scope, opts)` — deliberately
 * NOT `lib/mnemosyne/client.ts`'s `MnemosyneClient.remember()`. This is not
 * a preference, it's a fact about which implementation the wizard's actual
 * caller (pw-10's interview skill, a running Claude Code skill) can reach:
 * a skill's two real transports for firing a `remember()` call —
 * `bin/mnemosyne-mcp.mjs`'s MCP `"remember"` tool and
 * `bin/mnemosyne-skill-helper.mjs`'s `rememberAction` — both default to
 * `DEFAULT_PORT` 8477, `src/server.mjs`'s `POST /remember`, which calls
 * `engine.mjs`'s `remember()`. `lib/mnemosyne/server.ts` (port 3141,
 * `MnemosyneClient.remember()`) is a separate process a skill has no
 * standard path to. Mapping into the closed `Scope` union would be correct
 * for a library caller but dead code for this epic's actual caller.
 *
 * SHAPE: `tier` alone selects one of four FIXED, dedicated lane names
 * (`PERSONA_REMEMBER_SCOPE_BY_TIER` below) — `scopeId` never gets folded
 * into the scope string itself. Reason: `engine.mjs`'s "free-form"
 * vocabulary is free-form only in the sense of "not a closed TS union" —
 * every real scope name still has to be pre-provisioned as a `[scopes]`
 * entry in swarm-memory's `config.toml` before `remember()` will accept it
 * (`engine.mjs`'s `unknown scope` 400, `SCOPE_NAME_RE`), and that table is a
 * small, hand-curated set in practice (confirmed against a real
 * `~/.config/swarm-memory/config.toml`: `top`/`clients`/`personal`/`att`/...
 * with a `[ladder]` fallback chain — never one entry per fine-grained
 * entity). A scope name computed per-`scopeId` (e.g.
 * `persona-code-architect-mnemosyne`) would need its own `addLane()` config
 * mutation for every single persona ever authored — an unbounded, uncurated
 * lane explosion nothing else in this codebase's config convention does.
 * Four fixed tier lanes is a one-time, four-line setup cost instead, the
 * same shape every other lane in `config.toml` already has.
 *
 * `scopeId` is NOT dropped — it still matters for recall-time precision, so
 * this resolver returns it back as `tag`, pre-sanitized with the exact same
 * rule `engine.mjs remember()` applies to `opts.tag` internally
 * (`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40)`, `src/engine.mjs` near
 * its `remember()` body) — so a caller can pass it straight through as
 * `opts.tag` with zero further transformation and get the exact same
 * result `remember()` would have computed itself. The caller (pw-10's
 * interview skill) SHOULD also fold `scopeId` into the remembered `text`
 * itself so it stays recall-searchable, not just present in the note's
 * filename — this resolver only owns the `scope`-argument mapping, per this
 * story's explicit boundary (it does not touch either `remember()`
 * implementation).
 */
export const PERSONA_REMEMBER_SCOPE_BY_TIER: Record<Tier, string> = {
  'top-orchestrator': 'persona-top-orchestrator',
  'company-director': 'persona-company-director',
  'project-orchestrator': 'persona-project-orchestrator',
  'code-architect': 'persona-code-architect',
};

/** Result of {@link resolveRememberScope}. */
export interface RememberScopeResolution {
  /** `engine.mjs remember()`'s `scope` argument — one of `PERSONA_REMEMBER_SCOPE_BY_TIER`'s values. */
  scope: string;
  /** `engine.mjs remember()`'s `opts.tag` — `scopeId`, pre-sanitized to that function's own tag rule. */
  tag: string;
}

/**
 * Deterministically resolves a persona's `{tier, scopeId}` to the
 * `remember()` call it should feed (see the block comment above for the
 * full rationale). Same `{tier, scopeId}` in -> same `{scope, tag}` out,
 * always -- no randomness, no ambient/config/filesystem state consulted.
 */
export function resolveRememberScope(persona: { tier: Tier; scopeId: string }): RememberScopeResolution {
  if (typeof persona?.tier !== 'string' || !TIERS.includes(persona.tier as Tier)) {
    throw new Error(
      `resolveRememberScope: 'tier' must be one of ${TIERS.join(', ')}, got ${String(persona?.tier)}.`,
    );
  }
  if (typeof persona.scopeId !== 'string' || persona.scopeId.trim() === '') {
    throw new Error("resolveRememberScope: 'scopeId' must be a non-empty string.");
  }

  const scope = PERSONA_REMEMBER_SCOPE_BY_TIER[persona.tier];
  // Mirrors engine.mjs remember()'s own tag sanitization exactly (src/engine.mjs,
  // inside remember(), `const tag = (opts.tag || "note").replace(...).slice(0, 40)`)
  // so this is guaranteed to be a valid, already-normalized opts.tag with no
  // further transformation needed by the caller.
  const tag = persona.scopeId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40);

  return { scope, tag };
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

  // puf-03: origin, if present, is schema-validated -- {proposedBy,
  // proposedAt, approvedAt}, all non-empty strings, ALL THREE together or
  // not at all (a partially-populated origin, e.g. proposedBy with no
  // approvedAt, would render a broken/misleading provenance note --
  // see ui/app.js). This is the single real enforcement point for that
  // shape; server.ts's approve route only ever constructs a fully-populated
  // origin (or omits the key entirely), but this check does not trust that
  // caller discipline alone -- any future write path (CLI/MCP/skill-harness)
  // that starts passing an `origin` through gets the same guarantee for free.
  if (candidate.origin !== undefined) {
    const origin = candidate.origin;
    const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
    if (
      !isPlainRecord(origin) ||
      !isNonEmptyString(origin.proposedBy) ||
      !isNonEmptyString(origin.proposedAt) ||
      !isNonEmptyString(origin.approvedAt)
    ) {
      throw new Error(
        "Invalid persona: 'origin', if present, must be {proposedBy: string, proposedAt: string, " +
          'approvedAt: string}, all non-empty -- never partially populated.',
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
 *
 * `parentContextSections` (pf-12) defaults to `[]` -- only the repo-local
 * dispatch path below ever passes a non-empty array, built by
 * `buildParentContextSections` from the persona's OWN `parentRefs` field,
 * never by reading anything from the parent's actual store.
 */
function reinjectMandateSections(
  base: Omit<TierContent, 'mandateSections' | 'parentContextSections'>,
  parentContextSections: TierContentSection[] = [],
): TierContent {
  return { ...base, mandateSections: [...MANDATE_SECTIONS], parentContextSections };
}

/**
 * pf-12-pointer-rendering-query-up: builds the pointer-only "query up"
 * sections for a repo-local (code-architect) persona's `parentRefs`. Each
 * entry names ONLY the parent's `tier` and `scopeId` plus a fetch
 * instruction -- it deliberately never reads the parent's store (global or
 * otherwise), so there is no code path here through which a parent's real
 * `sections` content could ever leak in. This is the concrete guardrail
 * against the copy-down trap docs/layer-architecture-v2-plan.md:35 flags:
 * "cross-project impact is still answered by querying UP the hierarchy,
 * never held locally at [the code tier]."
 *
 * The fetch instruction references the future `mnemosyne persona show
 * <tier> <scope-id>` CLI command (pf-13, not yet implemented as of this
 * story) -- mirrors tiers.ts's `MANDATE_SECTIONS` pattern of instructing an
 * agent to take an explicit action on demand rather than force-feeding
 * everything into context on every sync.
 */
function buildParentContextSections(parentRefs: { tier: Tier; scopeId: string }[]): TierContentSection[] {
  return parentRefs.map((ref) => ({
    heading: `Parent: ${ref.tier} (scopeId: ${ref.scopeId})`,
    body:
      `This persona has a parent context at tier '${ref.tier}', scopeId '${ref.scopeId}'. ` +
      'Cross-project impact is answered by querying UP the hierarchy, never held locally at this tier ' +
      '(docs/layer-architecture-v2-plan.md). Do not assume, infer, or fabricate that parent\'s content here -- ' +
      `fetch it on demand when you actually need it, via \`mnemosyne persona show ${ref.tier} ${ref.scopeId}\` ` +
      '(planned; not implemented yet as of this story) or by resolving it manually against the global persona store in the meantime.',
  }));
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
 *     (personas never store their own mandate). Also renders a "Parent
 *     context (query up)" pointer section from the persona's own
 *     `parentRefs`, if any (pf-12, `buildParentContextSections`) -- pointer
 *     only (parent tier + scopeId + a fetch instruction), never the parent's
 *     actual `sections` content; `[]`/no section at all when `parentRefs` is
 *     absent. If no persona exists yet, falls back via
 *     `fallbackToTierContentWithWarning`.
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
  return reinjectMandateSections(
    {
      tier: persona.tier,
      displayName: persona.displayName,
      scope: persona.scope,
      sections: persona.sections,
    },
    // pf-12: pointer-only sections built from THIS persona's own parentRefs field --
    // never a read of the parent's actual store/content. [] (and therefore no
    // "Parent context" section at all) when parentRefs is absent -- opt-in, not forced.
    buildParentContextSections(persona.parentRefs ?? []),
  );
}
