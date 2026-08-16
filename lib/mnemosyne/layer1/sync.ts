/**
 * Layer 1 — per-harness sync generator.
 *
 * Composes Level 0 (operator-global rules, read fresh every run) + one
 * tier's content into a single managed block, and idempotently writes that
 * block into a harness's native auto-load file (CLAUDE.md/AGENTS.md/
 * GEMINI.md), creating the file if it doesn't exist and never touching
 * human-authored content outside the block.
 *
 * Ordering is a hard requirement (docs/layer-architecture-v2-plan.md §0):
 * Level 0 is ALWAYS first in the managed block, verbatim, ahead of any
 * tier-specific content -- never omitted, reordered, or paraphrased.
 *
 * Content resolution is scoped-persona-aware (pf-02): `buildManagedBody`
 * resolves tier content via `getPersonaContent(tier, scopeId, ctx)`
 * (persona.ts) rather than the old bare-tier `getTierContent(tier)` -- see
 * persona.ts for the dispatch rules. `scopeId` is a required parameter on
 * both `syncHarnessFile` and `syncAllHarnesses` as a result; the repo root a
 * given target file lives under (derived from `targetFilePath`'s directory)
 * doubles as the repo-local persona store's root, since every harness
 * target (CLAUDE.md/AGENTS.md/GEMINI.md) lives directly at repo root
 * (harness.ts).
 *
 * Story: la-01-role-meta-file-sync (epic: mnemosyne-layer-architecture-v2)
 * Story: pf-02-getpersonacontent-signature-threading (epic: mnemosyne-persona-foundation)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spliceManagedBlock } from './block.js';
import { HARNESS_TARGETS, type HarnessId } from './harness.js';
import { DEFAULT_LEVEL0_PATH, readLevel0Content } from './level0.js';
import { withLock } from './lock.js';
import { getPersonaContent } from './persona.js';
import { renderTierContentMarkdown, type Tier } from './tiers.js';

export interface SyncOptions {
  /** Override the Level 0 rules file path (default: ~/.mnemosyne/level0-rules.md). Mainly for tests. */
  level0Path?: string;
}

export interface SyncResult {
  filePath: string;
  harness: HarnessId;
  tier: Tier;
  /** True if the target file did not exist before this sync run. */
  created: boolean;
}

/**
 * Exported (pf-04) so `bin/mnemosyne-persona.mjs`'s `--dry-run` path can
 * compute the exact same managed-block body production sync would write,
 * then feed it through `spliceManagedBlock` in memory -- without duplicating
 * this assembly logic (and risking silent drift between the real write path
 * and the dry-run preview if one changes and not the other).
 */
export function buildManagedBody(tier: Tier, scopeId: string, repoRoot: string, level0Content: string): string {
  const tierMarkdown = renderTierContentMarkdown(getPersonaContent(tier, scopeId, { repoRoot }));
  // Level 0 first, verbatim, ahead of tier content -- never reordered.
  return [level0Content.trim(), '', '---', '', tierMarkdown.trim()].join('\n');
}

/**
 * Syncs a single harness's native meta file at `targetFilePath` for the
 * given `tier` + `scopeId`. Idempotent: re-running updates only the managed
 * block. `scopeId` is threaded through to `getPersonaContent` -- see
 * persona.ts for how it's used (repo-local persona lookup for
 * `code-architect`; ignored for every other tier in this slice).
 */
export function syncHarnessFile(
  targetFilePath: string,
  tier: Tier,
  harnessId: HarnessId,
  scopeId: string,
  options: SyncOptions = {},
): SyncResult {
  const level0Path = options.level0Path ?? DEFAULT_LEVEL0_PATH;
  // Read fresh every call -- no module-level caching of Level 0 content.
  const level0Content = readLevel0Content(level0Path);
  const repoRoot = path.dirname(targetFilePath);
  const managedBody = buildManagedBody(tier, scopeId, repoRoot, level0Content);

  // The lock file itself lives alongside targetFilePath, so its directory must exist before we
  // can even attempt to acquire the lock -- create it up front, outside the locked section.
  mkdirSync(path.dirname(targetFilePath), { recursive: true });

  // The read (existsSync/readFileSync) -> splice -> write (writeFileSync) sequence has zero
  // coordination on its own -- two concurrent syncs of the same target file is a classic TOCTOU
  // race (design-discussion.md). withLock serializes the whole read-splice-write against that path.
  const created = withLock(targetFilePath, () => {
    const fileExisted = existsSync(targetFilePath);
    const existingContent = fileExisted ? readFileSync(targetFilePath, 'utf8') : null;
    const nextContent = spliceManagedBlock(existingContent, managedBody);

    writeFileSync(targetFilePath, nextContent, 'utf8');

    return !fileExisted;
  });

  return { filePath: targetFilePath, harness: harnessId, tier, created };
}

/**
 * Syncs every known harness target (CLAUDE.md/AGENTS.md/GEMINI.md) under
 * `repoRoot` for the given `tier` + `scopeId`, in one call.
 */
export function syncAllHarnesses(
  repoRoot: string,
  tier: Tier,
  scopeId: string,
  options: SyncOptions = {},
): SyncResult[] {
  return HARNESS_TARGETS.map((target) =>
    syncHarnessFile(path.join(repoRoot, target.fileName), tier, target.id, scopeId, options),
  );
}
