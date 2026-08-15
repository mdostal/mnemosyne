/**
 * Layer 1 — idempotent managed-block splicing.
 *
 * Every generated harness file (CLAUDE.md/AGENTS.md/GEMINI.md) carries a
 * single, clearly delimited "managed block" that Mnemosyne owns exclusively.
 * Re-running the sync must:
 *   - update ONLY the text between the markers,
 *   - never duplicate the markers,
 *   - never touch human-authored content before or after the block.
 *
 * This module has no knowledge of tiers, Level 0, or harnesses — it is pure
 * string splicing, kept separate so it's trivially testable and reusable by
 * any future sync target.
 */

export const BLOCK_START =
  '<!-- mnemosyne:layer1:begin — managed by Mnemosyne Layer 1 sync. Do not hand-edit between these markers: edit ~/.mnemosyne/level0-rules.md (Level 0) or lib/mnemosyne/layer1/tiers.ts (tier content) instead, then re-run the sync. -->';

export const BLOCK_END = '<!-- mnemosyne:layer1:end -->';

/** Wraps a managed-block body in the start/end markers. */
export function wrapManagedBlock(body: string): string {
  return `${BLOCK_START}\n${body.trim()}\n${BLOCK_END}`;
}

/**
 * Produces the next full file content given the current file content (or
 * `null` if the file does not exist yet) and the new managed-block body.
 *
 * - No existing file: the managed block IS the file.
 * - Existing file with no markers yet: the block is appended after existing
 *   content, which is preserved verbatim.
 * - Existing file with markers: only the text between them is replaced;
 *   everything before the start marker and after the end marker is
 *   preserved verbatim, in place.
 */
export function spliceManagedBlock(existingFileContent: string | null, managedBody: string): string {
  const block = wrapManagedBlock(managedBody);

  if (existingFileContent === null || existingFileContent.length === 0) {
    return `${block}\n`;
  }

  // lastIndexOf, not indexOf (pf-05 fix): a file can accumulate a STRAY,
  // never-closed BLOCK_START ahead of the real, well-formed pair -- e.g. an
  // interrupted manual paste that left a lone begin marker (exactly the
  // partial-marker fixture's shape), followed later by a normal append-mode
  // sync that adds the real pair after it. Pairing the FIRST BLOCK_START
  // with the FIRST BLOCK_END would then wrongly treat the stray leading
  // marker as the real block's start and silently delete every human line
  // sitting between it and the real end marker on the next sync. Always
  // targeting the LAST start/end pair means Mnemosyne only ever touches the
  // block it (or a previous sync) actually wrote, never an earlier stray.
  const startIdx = existingFileContent.lastIndexOf(BLOCK_START);
  const endIdx = existingFileContent.lastIndexOf(BLOCK_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existingFileContent.slice(0, startIdx);
    const after = existingFileContent.slice(endIdx + BLOCK_END.length);
    return `${before}${block}${after}`;
  }

  // No prior managed block: append after existing (human-authored) content,
  // preserving it verbatim, with a blank-line separator.
  const trimmedExisting = existingFileContent.replace(/\n+$/, '');
  return `${trimmedExisting}\n\n${block}\n`;
}

/** Returns the current managed-block body, or `null` if no block is present. */
export function extractManagedBlockBody(fileContent: string): string | null {
  // lastIndexOf, not indexOf -- same reasoning as spliceManagedBlock above:
  // always resolve to the real (most recently synced) block, never a stray
  // leading marker.
  const startIdx = fileContent.lastIndexOf(BLOCK_START);
  const endIdx = fileContent.lastIndexOf(BLOCK_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return null;
  }
  return fileContent.slice(startIdx + BLOCK_START.length, endIdx).trim();
}
