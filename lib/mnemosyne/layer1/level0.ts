/**
 * Layer 1 — Level 0 (operator-global rules) reader.
 *
 * Level 0 sits ABOVE the 4-tier hierarchy and above Layer 1's own
 * tier-specific content — see docs/layer-architecture-v2-plan.md §0 and
 * ~/.mnemosyne/level0-rules.md itself. It is operator-authored, global
 * (not scoped to any repo/company/project), and must be:
 *
 *   - read FRESH on every sync run (never baked into source, never cached
 *     module-level — editing level0-rules.md must take effect on the very
 *     next sync, with no stale copy anywhere in this codebase),
 *   - prepended VERBATIM ahead of any tier content,
 *   - never omitted: if the file is missing, the sync must fail loudly
 *     rather than silently generate a harness file without it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const DEFAULT_LEVEL0_PATH = path.join(homedir(), '.mnemosyne', 'level0-rules.md');

/** Reads Level 0 content from disk fresh -- no caching, ever. */
export function readLevel0Content(level0Path: string = DEFAULT_LEVEL0_PATH): string {
  if (!existsSync(level0Path)) {
    throw new Error(
      `Level 0 operator rules not found at ${level0Path}. Layer 1 sync refuses to generate a ` +
        'harness file without it -- Level 0 must never be omitted. Create it (see la-00) or pass ' +
        'an explicit level0Path.',
    );
  }
  return readFileSync(level0Path, 'utf8');
}
