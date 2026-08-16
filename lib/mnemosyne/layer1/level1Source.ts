/**
 * Layer 1 — Level 1 (`mnemosyne.md`, repo-owned) reader.
 *
 * Level 1 sits between Level 0 (operator-global, above the 4-tier
 * hierarchy — see level0.ts) and tier/persona content — see
 * docs/design-discussion.md §4a/§4b (epic: mnemosyne-memory-levels, story:
 * ml-02). It is repo-owned, harness-agnostic, and (initially) tier-agnostic
 * guidance a human edits directly in a `mnemosyne.md` file at a repo's
 * root.
 *
 * Deliberately mirrors level0.ts's shape:
 *
 *   - read FRESH on every call (no module-level caching, no memoization —
 *     the same hard rule level0.ts documents for Level 0),
 *   - a default-path constant callers can rely on without wiring their own
 *     path resolution.
 *
 * It diverges from level0.ts in exactly ONE deliberate, documented way —
 * missing-file behavior:
 *
 *   - level0.ts's readLevel0Content THROWS when Level 0 is missing. Level 0
 *     is operator-global and must never be silently omitted from a synced
 *     harness file (level0.ts:13-14).
 *   - readMnemosyneMdContent here returns `null` instead. Level 1 is NEW,
 *     per-repo, OPT-IN content this epic introduces to a codebase where
 *     EVERY existing repo lacks a mnemosyne.md on day one
 *     (design-discussion.md §7.2). Hard-requiring it would break every
 *     already-adopted repo's harness sync the moment this epic ships — a
 *     repo adopts Level 1 by adding the file, not by being forced to.
 *     `null` (not `''`) is the chosen "absent" sentinel so callers can tell
 *     "file absent" apart from "file present but empty" without an extra
 *     existsSync check of their own.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Repo-root `mnemosyne.md`, resolved from the current working directory —
 * Level 1 content is repo-owned (design-discussion.md §4a), not
 * operator-global like Level 0's `homedir()`-anchored default. Callers
 * syncing a specific target repo (`bin/mnemosyne-persona.mjs sync --repo`)
 * pass an explicit path instead of relying on this default; this constant
 * exists for the common case of running from within the repo being synced,
 * mirroring level0.ts's DEFAULT_LEVEL0_PATH pattern.
 */
export const DEFAULT_MNEMOSYNE_MD_PATH = path.join(process.cwd(), 'mnemosyne.md');

/**
 * Reads Level 1 (`mnemosyne.md`) content from disk fresh -- no caching,
 * ever, matching level0.ts's own hard rule. Unlike readLevel0Content, a
 * missing file is NOT an error: returns `null` (see module doc comment for
 * the full reasoning behind this documented divergence).
 */
export function readMnemosyneMdContent(
  mnemosyneMdPath: string = DEFAULT_MNEMOSYNE_MD_PATH,
): string | null {
  if (!existsSync(mnemosyneMdPath)) {
    return null;
  }
  return readFileSync(mnemosyneMdPath, 'utf8');
}
