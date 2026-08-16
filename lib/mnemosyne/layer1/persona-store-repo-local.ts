/**
 * Layer 1 — repo-local persona store.
 *
 * Holds `code-architect`-tier personas only (design-discussion.md §3a):
 * scoped to exactly one repo, git-committed alongside the code it describes
 * (not gitignored — see .gitignore, which deliberately has no
 * `.mnemosyne/personas` exclusion). This is the storage level for the
 * "repo build-out" step of the repo-spinup lifecycle, AFTER a repo exists;
 * the (not-yet-built) global store covers the other three tiers, which do
 * their ideation BEFORE any repo exists.
 *
 * Format is YAML, not JSON (design-discussion.md §7a, direct operator
 * correction: "we define our own yaml") — reuses the `yaml` package already
 * in package.json's dependencies rather than adding a new one.
 *
 * Reads are fresh off disk on every call, no module-level caching -- mirrors
 * level0.ts's "read fresh every run" contract (level0.ts:23-33).
 *
 * Story: pf-01-persona-schema-repo-local-store (epic: mnemosyne-persona-foundation)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { withLock } from './lock.js';
import { PERSONA_STORE_BY_TIER, assertValidPersona, type Persona } from './persona.js';
import type { Tier } from './tiers.js';

/** The only tier the repo-local store ever holds. */
export const REPO_LOCAL_PERSONA_TIER: Tier = 'code-architect';

/**
 * Guards that `tier` is one PERSONA_STORE_BY_TIER actually routes to the
 * repo-local store -- consults the shared map (persona.ts) rather than
 * re-deriving the split independently, so a future change to the map can't
 * silently desync store enforcement from schema-level tier validation.
 */
function assertRepoLocalTier(tier: unknown): asserts tier is Tier {
  const kind = typeof tier === 'string' ? PERSONA_STORE_BY_TIER[tier as Tier] : undefined;
  if (kind !== 'repo-local') {
    throw new Error(
      `The repo-local persona store only holds '${REPO_LOCAL_PERSONA_TIER}' personas -- ` +
        `got tier '${String(tier)}', which belongs in the global store (not this one). Refusing to write.`,
    );
  }
}

/** `<repoRoot>/.mnemosyne/personas/<scopeId>.yaml` -- the repo-local store's fixed location convention. */
export function repoLocalPersonaPath(repoRoot: string, scopeId: string): string {
  return path.join(repoRoot, '.mnemosyne', 'personas', `${scopeId}.yaml`);
}

/**
 * Validates and writes a code-architect persona to the repo-local store.
 * Throws (writing nothing) if `candidate` is not tier=code-architect, or
 * fails schema validation (including a bare attempt to smuggle in
 * `mandateSections`). Returns the file path written.
 */
export function writeRepoLocalPersona(repoRoot: string, candidate: unknown): string {
  const tier = (candidate as { tier?: unknown } | null)?.tier;
  assertRepoLocalTier(tier);
  assertValidPersona(candidate, tier);

  const filePath = repoLocalPersonaPath(repoRoot, candidate.scopeId);
  // The lock file itself lives alongside filePath, so its directory must exist before we can
  // even attempt to acquire the lock -- create it up front, outside the locked section.
  mkdirSync(path.dirname(filePath), { recursive: true });
  // A manual persona edit racing a sync (or two writes racing each other) is the same class of
  // TOCTOU risk as syncHarnessFile's read-splice-write -- serialize writes to this path too.
  withLock(filePath, () => {
    writeFileSync(filePath, stringify(candidate), 'utf8');
  });
  return filePath;
}

/**
 * Reads a code-architect persona back from the repo-local store, fresh off
 * disk (never cached). Throws a clear error if no persona file exists for
 * `scopeId`, or if the on-disk content fails schema validation.
 */
export function readRepoLocalPersona(repoRoot: string, scopeId: string): Persona {
  const filePath = repoLocalPersonaPath(repoRoot, scopeId);
  if (!existsSync(filePath)) {
    throw new Error(`No repo-local persona found at ${filePath}.`);
  }

  const raw = readFileSync(filePath, 'utf8');
  const parsed: unknown = parse(raw);
  assertValidPersona(parsed, REPO_LOCAL_PERSONA_TIER);
  return parsed;
}

/**
 * Enumerates every code-architect persona on disk for this repo --
 * `readdir` + parse of the filename only, no file content is read or
 * validated (story pw-01-listing-primitives: "readdir + parse only, no
 * search, filter, or pagination"). Tier is always `code-architect`
 * (`REPO_LOCAL_PERSONA_TIER`), so unlike `listGlobalPersonas` there is no
 * per-entry tier to discriminate. A missing `<repoRoot>/.mnemosyne/personas`
 * directory is NOT an error here, unlike `readRepoLocalPersona`'s
 * missing-FILE contract -- it just means this repo has never had a persona
 * written yet, i.e. legitimately empty.
 */
export function listRepoLocalPersonas(repoRoot: string): { scopeId: string }[] {
  const personasDir = path.join(repoRoot, '.mnemosyne', 'personas');
  if (!existsSync(personasDir)) {
    return [];
  }
  return readdirSync(personasDir)
    .filter((fileName) => fileName.endsWith('.yaml'))
    .map((fileName) => ({ scopeId: fileName.slice(0, -'.yaml'.length) }));
}
