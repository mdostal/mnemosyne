/**
 * Layer 1 — draft persona store.
 *
 * A new, STRUCTURALLY SEPARATE persistence layer for in-review persona
 * drafts, distinct from the real stores (persona-store-global.ts /
 * persona-store-repo-local.ts). This module imports nothing from either of
 * those two files -- the separation is proven by construction, not just
 * asserted (design-discussion.md §3b, "Risks" table): a draft's path must
 * never come close enough to the real store's path convention that a future
 * refactor could accidentally make an in-review draft reachable by
 * `getPersonaContent`/`sync.ts` before it's approved.
 *
 * Location (design-discussion.md §3b), always home-rooted, NEVER inside any
 * consuming repo's git-tracked working tree:
 *
 *   - global tiers (`top-orchestrator` / `company-director` /
 *     `project-orchestrator`): `~/.mnemosyne/persona-drafts/<tier>/<scopeId>.yaml`
 *     -- mirrors `persona-store-global.ts`'s own `globalPersonaPath`
 *     convention exactly, just rooted under `persona-drafts` instead of
 *     `personas`.
 *   - `code-architect` (repo-local): `~/.mnemosyne/persona-drafts/repo-local/<repoSlug>/<scopeId>.yaml`,
 *     where `repoSlug` is `path.resolve(repoRoot)` sanitized with the EXACT
 *     same rule `persona.ts`'s `resolveRememberScope()` already applies to a
 *     persona's `scopeId` (`.replace(/[^a-zA-Z0-9_-]/g, '-')`) -- reusing an
 *     existing sanitization rule rather than inventing a third one.
 *     `persona-store-repo-local.ts`'s own doc comment states the real
 *     repo-local store is deliberately NOT gitignored ("git-committed
 *     alongside the code it describes"); putting ephemeral, possibly-rejected
 *     draft content in that same repo tree would either force Mnemosyne to
 *     mutate every consuming repo's `.gitignore` (a burden it takes on
 *     nowhere else) or risk an in-progress/rejected draft landing in that
 *     repo's git history by accident. Home-rooting every draft, mirroring
 *     where Mnemosyne already keeps its own operational state
 *     (`~/.mnemosyne/personas`), avoids both.
 *
 * One module dispatching internally on `PERSONA_STORE_BY_TIER` (persona.ts),
 * not two files mirroring the real stores' own split (design-discussion.md
 * §9 judgment call #2) -- unlike the real store, this one is new from
 * scratch and the two locations' read/write/list/dispose shape is otherwise
 * identical, so one module with an internal path-resolution branch avoids
 * duplicating the same logic twice.
 *
 * One active draft per `{tier, scopeId}`: a second `writeDraftPersona` call
 * for the same identity overwrites the existing active draft file in place
 * -- never a second active draft file for the same identity (mirrors the
 * real stores' own "same write route handles create-or-edit" convention).
 *
 * Disposal is archive-by-MOVE, never `fs.unlink`: `disposeDraftPersona`
 * relocates the active draft file to a timestamped path under a home-rooted
 * `approved/` or `discarded/` subtree (mirroring the active tree's own
 * `<tier>/<scopeId>.yaml` or `repo-local/<repoSlug>/<scopeId>.yaml` shape one
 * level down). This mirrors this codebase's own already-shipped
 * flight-status philosophy (provisional/confirmed/superseded, never deleted
 * -- docs/layer-architecture-v2-plan.md): a discarded agent proposal has the
 * same forensic value a superseded memory write does.
 *
 * Full `assertValidPersona`-strength schema validation is DELIBERATELY NOT
 * applied at this layer -- only structural sanity (a valid `tier`, a
 * non-empty `scopeId`). A draft is explicitly allowed to be incomplete while
 * a human is still reviewing/editing it (design-discussion.md §3b);
 * `assertValidPersona` remains the single real enforcement point, exercised
 * unchanged only at approval time (pu-03's job, not this module's).
 *
 * Reuses `withLock` (lock.ts) around every write/dispose exactly as the real
 * stores do -- no new locking mechanism.
 *
 * Story: pu-02-draft-persona-store (epic: mnemosyne-persona-ux)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { withLock } from './lock.js';
import { PERSONA_STORE_BY_TIER } from './persona.js';
import { TIERS, type Tier } from './tiers.js';

/** `~/.mnemosyne/persona-drafts` -- sibling to the real global store's `~/.mnemosyne/personas` (persona-store-global.ts), never inside any repo's working tree. */
export const DEFAULT_DRAFT_PERSONA_ROOT = path.join(homedir(), '.mnemosyne', 'persona-drafts');

/** A draft candidate: `{tier, scopeId}` identity plus arbitrary in-progress content. Deliberately looser than `Persona` -- a draft may be incomplete. */
export interface DraftPersonaCandidate {
  tier: Tier;
  scopeId: string;
  [key: string]: unknown;
}

/** Disposition a draft can be archived under -- the two terminal states a human review can end in (design-discussion.md §3b). Never a third "still active" value here; "active" is simply "not yet disposed of." */
export type DraftPersonaDisposition = 'approved' | 'discarded';

/**
 * Threading context every function in this module accepts. `repoRoot` is
 * required only when `tier` routes to the repo-local store
 * (`PERSONA_STORE_BY_TIER[tier] === 'repo-local'`) -- ignored for global
 * tiers. `draftRoot` overrides `DEFAULT_DRAFT_PERSONA_ROOT`, used by this
 * module's own tests to avoid touching a real home directory; production
 * callers should never need to set it.
 */
export interface DraftPersonaContext {
  repoRoot?: string;
  draftRoot?: string;
}

/**
 * Structural-only sanity check (NOT `assertValidPersona`-strength, see this
 * module's doc comment): `tier` must be one of the four real tiers, and
 * `scopeId` must be a non-empty string. Throws BEFORE any disk access, so a
 * rejected candidate never creates a directory or file -- mirrors
 * `persona-store-global.ts`'s `assertGlobalTier`/`persona-store-repo-local.ts`'s
 * `assertRepoLocalTier` running before any `mkdirSync`/`writeFileSync` call.
 */
function assertStructurallyValidDraft(candidate: unknown): asserts candidate is DraftPersonaCandidate {
  const tier = (candidate as { tier?: unknown } | null)?.tier;
  if (typeof tier !== 'string' || !TIERS.includes(tier as Tier)) {
    throw new Error(`writeDraftPersona: 'tier' must be one of ${TIERS.join(', ')}, got ${String(tier)}.`);
  }
  const scopeId = (candidate as { scopeId?: unknown } | null)?.scopeId;
  if (typeof scopeId !== 'string' || scopeId.trim() === '') {
    throw new Error("writeDraftPersona: 'scopeId' must be a non-empty string.");
  }
}

/**
 * The exact same sanitization rule `persona.ts`'s `resolveRememberScope()`
 * already applies to a persona's `scopeId`
 * (`.replace(/[^a-zA-Z0-9_-]/g, '-')`) -- reused byte-for-byte here for
 * `repoSlug` derivation, not a second, subtly different regex
 * (design-discussion.md §3b). Deliberately no `.slice(0, 40)` truncation --
 * that limit is specific to `resolveRememberScope`'s `remember()` `opts.tag`
 * contract, not part of the shared sanitization rule this module reuses.
 */
function sanitizeForPath(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}

/** `path.resolve(repoRoot)`, sanitized -- the repo-local draft subtree's directory name. */
function repoSlug(repoRoot: string): string {
  return sanitizeForPath(path.resolve(repoRoot));
}

/** The single tier `PERSONA_STORE_BY_TIER` routes to the repo-local store. Derived from the shared map (never imported from persona-store-repo-local.ts) so this module stays structurally separate from the real store's own module. */
function repoLocalTier(): Tier {
  const repoLocalTiers = (Object.keys(PERSONA_STORE_BY_TIER) as Tier[]).filter(
    (tier) => PERSONA_STORE_BY_TIER[tier] === 'repo-local',
  );
  const [tier, ...rest] = repoLocalTiers;
  if (!tier || rest.length > 0) {
    throw new Error(
      `Draft store: expected exactly one repo-local tier in PERSONA_STORE_BY_TIER, found ${repoLocalTiers.length}.`,
    );
  }
  return tier;
}

/**
 * The path segments (relative to a draft root) identifying `tier`'s active
 * draft location -- `[tier]` for a global tier, `['repo-local', repoSlug]`
 * for the repo-local tier. Shared by both the active-tree path builder and
 * the archive-tree path builder, so the two trees stay structurally
 * parallel (`<root>/<segments>/<scopeId>.yaml` active,
 * `<root>/<disposition>/<segments>/...` archived).
 */
function draftSubpathSegments(tier: Tier, ctx: DraftPersonaContext): string[] {
  if (PERSONA_STORE_BY_TIER[tier] === 'repo-local') {
    if (!ctx.repoRoot) {
      throw new Error(`Draft store: tier '${tier}' is repo-local -- ctx.repoRoot is required.`);
    }
    return ['repo-local', repoSlug(ctx.repoRoot)];
  }
  return [tier];
}

/**
 * `<draftRoot>/<tier>/<scopeId>.yaml` (global tiers) or
 * `<draftRoot>/repo-local/<repoSlug>/<scopeId>.yaml` (`code-architect`) --
 * the draft store's fixed active-draft location convention. `draftRoot`
 * defaults to `DEFAULT_DRAFT_PERSONA_ROOT`; `ctx.repoRoot` is required when
 * `tier` is repo-local.
 */
export function draftPersonaPath(tier: Tier, scopeId: string, ctx: DraftPersonaContext = {}): string {
  const root = ctx.draftRoot ?? DEFAULT_DRAFT_PERSONA_ROOT;
  return path.join(root, ...draftSubpathSegments(tier, ctx), `${scopeId}.yaml`);
}

/**
 * Writes (creates or overwrites-in-place) the active draft for `{tier,
 * scopeId}`. Throws -- writing nothing to disk -- if `candidate` fails the
 * structural-only check above (invalid tier, empty/missing scopeId); full
 * `assertValidPersona`-strength validation is deliberately never applied
 * here (see this module's doc comment). A second call for the same identity
 * overwrites the existing active draft file in place -- never a second
 * active draft file for that identity. Returns the file path written.
 */
export function writeDraftPersona(candidate: unknown, ctx: DraftPersonaContext = {}): string {
  assertStructurallyValidDraft(candidate);

  const filePath = draftPersonaPath(candidate.tier, candidate.scopeId, ctx);
  // Directory must exist before the lock file (co-located with filePath) can be created --
  // same ordering as the real stores' writeGlobalPersona/writeRepoLocalPersona.
  mkdirSync(path.dirname(filePath), { recursive: true });
  withLock(filePath, () => {
    writeFileSync(filePath, stringify(candidate), 'utf8');
  });
  return filePath;
}

/**
 * Reads the active draft for `{tier, scopeId}` back, fresh off disk (no
 * caching, mirrors the real stores' "read fresh every call" contract).
 * Throws a clear error if no active draft exists at that identity. No
 * schema validation is applied to the parsed content -- a draft may be
 * incomplete.
 */
export function readDraftPersona(tier: Tier, scopeId: string, ctx: DraftPersonaContext = {}): DraftPersonaCandidate {
  const filePath = draftPersonaPath(tier, scopeId, ctx);
  if (!existsSync(filePath)) {
    throw new Error(`No active draft persona found at ${filePath}.`);
  }
  const raw = readFileSync(filePath, 'utf8');
  return parse(raw) as DraftPersonaCandidate;
}

/**
 * Enumerates every ACTIVE draft (never archived ones) -- readdir + parse of
 * the filename only, no file content read or validated, mirrors
 * `listGlobalPersonas`/`listRepoLocalPersonas`'s own contract. Always
 * includes all three global tiers; additionally includes the repo-local
 * tier's drafts for `ctx.repoRoot` when it is given (omitted entirely
 * otherwise, since there is no single repo-local subtree to list without
 * knowing which repo). A missing tier/repo-local directory is NOT an error
 * here -- it just means that identity has never had a draft written yet.
 */
export function listDraftPersonas(ctx: DraftPersonaContext = {}): { tier: Tier; scopeId: string }[] {
  const root = ctx.draftRoot ?? DEFAULT_DRAFT_PERSONA_ROOT;
  const entries: { tier: Tier; scopeId: string }[] = [];

  const globalTiers = (Object.keys(PERSONA_STORE_BY_TIER) as Tier[]).filter(
    (tier) => PERSONA_STORE_BY_TIER[tier] === 'global',
  );
  for (const tier of globalTiers) {
    const tierDir = path.join(root, tier);
    if (!existsSync(tierDir)) continue;
    for (const fileName of readdirSync(tierDir)) {
      if (!fileName.endsWith('.yaml')) continue;
      entries.push({ tier, scopeId: fileName.slice(0, -'.yaml'.length) });
    }
  }

  if (ctx.repoRoot) {
    const tier = repoLocalTier();
    const repoDir = path.join(root, 'repo-local', repoSlug(ctx.repoRoot));
    if (existsSync(repoDir)) {
      for (const fileName of readdirSync(repoDir)) {
        if (!fileName.endsWith('.yaml')) continue;
        entries.push({ tier, scopeId: fileName.slice(0, -'.yaml'.length) });
      }
    }
  }

  return entries;
}

/** Filesystem-safe timestamp for an archive filename -- ISO 8601 with `:`/`.` swapped for `-`. */
function archiveTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Disposes of the active draft at `{tier, scopeId}` by MOVING it (never
 * `fs.unlink`) to a timestamped path under the home-rooted `approved/` or
 * `discarded/` archive subtree -- mirrors the active tree's own shape one
 * level down (`<draftRoot>/<disposition>/<tier>/<scopeId>-<timestamp>.yaml`
 * or `<draftRoot>/<disposition>/repo-local/<repoSlug>/<scopeId>-<timestamp>.yaml`).
 * The file no longer appears in `listDraftPersonas`' active output after
 * this call, but is never deleted from disk. Throws if no active draft
 * exists at that identity. Returns the archive path written to.
 */
export function disposeDraftPersona(
  tier: Tier,
  scopeId: string,
  disposition: DraftPersonaDisposition,
  ctx: DraftPersonaContext = {},
): string {
  const root = ctx.draftRoot ?? DEFAULT_DRAFT_PERSONA_ROOT;
  const activePath = draftPersonaPath(tier, scopeId, ctx);
  if (!existsSync(activePath)) {
    throw new Error(`No active draft persona found at ${activePath} to dispose of.`);
  }

  const segments = draftSubpathSegments(tier, ctx);
  const archivePath = path.join(root, disposition, ...segments, `${scopeId}-${archiveTimestamp()}.yaml`);

  // Same lock target as writeDraftPersona (the active file itself) -- a concurrent write and
  // dispose of the same identity serialize against each other, not just concurrent disposals.
  withLock(activePath, () => {
    mkdirSync(path.dirname(archivePath), { recursive: true });
    renameSync(activePath, archivePath);
  });

  return archivePath;
}
