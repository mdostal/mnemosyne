/**
 * Layer 1 — global persona store.
 *
 * Holds `top-orchestrator` / `company-director` / `project-orchestrator`
 * tier personas only (design-discussion.md §3a): NOT scoped to any single
 * repo, NOT git-committed anywhere (lives entirely outside any repo's
 * working tree). This is the storage level for ideation that happens
 * BEFORE a repo exists -- the repo-local store
 * (persona-store-repo-local.ts) covers the remaining tier, `code-architect`,
 * which is scoped to one repo and git-committed alongside it.
 *
 * Location is a sibling convention to Level 0's own global file
 * (level0.ts's `DEFAULT_LEVEL0_PATH`, `~/.mnemosyne/level0-rules.md`):
 * `~/.mnemosyne/personas/<tier>/<scopeId>.yaml` -- same rationale as Level 0
 * itself (horizontal-plan.md H1.2): this content spans potentially many
 * future repos/companies/projects, so it cannot live inside any one repo's
 * working tree.
 *
 * Reads are fresh off disk on every call, no module-level caching --
 * mirrors level0.ts's "read fresh, never cache" contract (level0.ts:23-33)
 * exactly: an operator hand-editing a persona file must see the change take
 * effect on the very next read, with no stale copy anywhere in this process.
 *
 * Format is YAML, matching persona-store-repo-local.ts (design-discussion.md
 * §7a) -- reuses the `yaml` package already in package.json's dependencies.
 *
 * Story: pf-06-global-persona-store-module (epic: mnemosyne-persona-foundation)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { withLock } from './lock.js';
import { PERSONA_STORE_BY_TIER, assertValidPersona, type Persona } from './persona.js';
import type { Tier } from './tiers.js';

/** `~/.mnemosyne/personas` -- sibling to Level 0's `DEFAULT_LEVEL0_PATH` (level0.ts:21), not repo-scoped. */
export const DEFAULT_GLOBAL_PERSONA_ROOT = path.join(homedir(), '.mnemosyne', 'personas');

/**
 * Guards that `tier` is one `PERSONA_STORE_BY_TIER` actually routes to the
 * global store -- consults the shared map (persona.ts) rather than
 * re-deriving the split independently, mirroring
 * persona-store-repo-local.ts's `assertRepoLocalTier`. Critically, this is
 * checked BEFORE any disk access in `writeGlobalPersona`, so a
 * `code-architect` candidate is rejected without creating any directory or
 * file.
 */
function assertGlobalTier(tier: unknown): asserts tier is Tier {
  const kind = typeof tier === 'string' ? PERSONA_STORE_BY_TIER[tier as Tier] : undefined;
  if (kind !== 'global') {
    throw new Error(
      `The global persona store never holds 'code-architect' personas -- got tier '${String(tier)}'. ` +
        'code-architect personas belong in the repo-local store (persona-store-repo-local.ts), not this one. Refusing to write.',
    );
  }
}

/** `<root>/<tier>/<scopeId>.yaml` -- the global store's fixed location convention. `root` defaults to `DEFAULT_GLOBAL_PERSONA_ROOT`. */
export function globalPersonaPath(
  tier: Tier,
  scopeId: string,
  root: string = DEFAULT_GLOBAL_PERSONA_ROOT,
): string {
  return path.join(root, tier, `${scopeId}.yaml`);
}

/**
 * Validates and writes a global-tier persona (`top-orchestrator`,
 * `company-director`, or `project-orchestrator`) to the global store.
 * Throws -- writing nothing to disk -- if `candidate.tier` is
 * `code-architect` (or any other non-global tier), or fails schema
 * validation (including a bare attempt to smuggle in `mandateSections`).
 * The tier guard runs before any `mkdirSync`/`writeFileSync` call, so a
 * rejected candidate never touches disk. Returns the file path written.
 */
export function writeGlobalPersona(candidate: unknown, root: string = DEFAULT_GLOBAL_PERSONA_ROOT): string {
  const tier = (candidate as { tier?: unknown } | null)?.tier;
  assertGlobalTier(tier);
  assertValidPersona(candidate, tier);

  const filePath = globalPersonaPath(tier, candidate.scopeId, root);
  // The lock file itself lives alongside filePath, so its directory must exist before we can
  // even attempt to acquire the lock -- create it up front, outside the locked section (same
  // ordering as persona-store-repo-local.ts's writeRepoLocalPersona).
  mkdirSync(path.dirname(filePath), { recursive: true });
  withLock(filePath, () => {
    writeFileSync(filePath, stringify(candidate), 'utf8');
  });
  return filePath;
}

/**
 * Reads a global-tier persona back from the global store, fresh off disk on
 * every call -- no module-level caching, ever (mirrors level0.ts's
 * "read fresh every run" contract, level0.ts:23-33). Throws a clear error
 * if no persona file exists for `tier`/`scopeId`, or if the on-disk content
 * fails schema validation.
 */
export function readGlobalPersona(
  tier: Tier,
  scopeId: string,
  root: string = DEFAULT_GLOBAL_PERSONA_ROOT,
): Persona {
  const filePath = globalPersonaPath(tier, scopeId, root);
  if (!existsSync(filePath)) {
    throw new Error(`No global persona found at ${filePath}.`);
  }

  const raw = readFileSync(filePath, 'utf8');
  const parsed: unknown = parse(raw);
  assertValidPersona(parsed, tier);
  return parsed;
}

/**
 * Enumerates every persona on disk across all three global tiers --
 * `readdir` + parse of the filename only, no file content is read or
 * validated (story pw-01-listing-primitives: "readdir + parse only, no
 * search, filter, or pagination"). A missing `<root>/<tier>` directory is
 * NOT an error here, unlike `readGlobalPersona`'s missing-FILE contract --
 * it just means that tier has never been seeded, i.e. legitimately empty. A
 * missing `root` itself (a fresh/never-seeded environment) is the same case,
 * one directory level up, and is handled identically.
 *
 * The tier list is read from `PERSONA_STORE_BY_TIER` inside the function
 * body, not at module scope -- persona.ts and this module import each other
 * (persona.ts consults `globalPersonaPath`/`readGlobalPersona`), so a
 * module-scope read of `PERSONA_STORE_BY_TIER` can observe it mid-init
 * depending on which side of the cycle loads first.
 */
export function listGlobalPersonas(root: string = DEFAULT_GLOBAL_PERSONA_ROOT): { tier: Tier; scopeId: string }[] {
  const globalTiers = (Object.keys(PERSONA_STORE_BY_TIER) as Tier[]).filter(
    (tier) => PERSONA_STORE_BY_TIER[tier] === 'global',
  );
  const entries: { tier: Tier; scopeId: string }[] = [];
  for (const tier of globalTiers) {
    const tierDir = path.join(root, tier);
    if (!existsSync(tierDir)) {
      continue;
    }
    for (const fileName of readdirSync(tierDir)) {
      if (!fileName.endsWith('.yaml')) {
        continue;
      }
      entries.push({ tier, scopeId: fileName.slice(0, -'.yaml'.length) });
    }
  }
  return entries;
}
