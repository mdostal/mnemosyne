/**
 * Layer 1 — harness targets.
 *
 * Mnemosyne piggybacks on each harness's OWN native auto-load convention
 * rather than inventing a new one: CLAUDE.md (Claude Code), AGENTS.md
 * (Codex), GEMINI.md (Gemini CLI). Adding a future harness is adding one
 * entry here, nothing else in this module changes.
 *
 * Research notes (2026-08-13), informing why the sync mechanism must never
 * cache and must keep content reasonably compact:
 *   - Claude Code auto-loads CLAUDE.md at repo root (and nested dirs) at
 *     session start.
 *   - Codex auto-loads AGENTS.md as a chain: repo root + the AGENTS.md in
 *     the subdirectory it's working in. Codex caps combined loaded content
 *     at `project_doc_max_bytes` (32 KiB default) and skips/truncates past
 *     that limit — a reason to keep generated tier content concise.
 *   - Gemini CLI concatenates GEMINI.md hierarchically: global
 *     (~/.gemini/GEMINI.md), project/workspace level, and directory level,
 *     most-specific-wins on overlapping guidance. `/memory reload` forces a
 *     re-scan, i.e. Gemini CLI itself does not cache stale content either —
 *     consistent with this story's "read Level 0 fresh every run" rule.
 */

export type HarnessId = 'claude-code' | 'codex' | 'gemini-cli';

export interface HarnessTarget {
  id: HarnessId;
  label: string;
  fileName: string;
}

export const HARNESS_TARGETS: readonly HarnessTarget[] = [
  { id: 'claude-code', label: 'Claude Code', fileName: 'CLAUDE.md' },
  { id: 'codex', label: 'Codex', fileName: 'AGENTS.md' },
  { id: 'gemini-cli', label: 'Gemini CLI', fileName: 'GEMINI.md' },
];

export function getHarnessTarget(id: HarnessId): HarnessTarget {
  const found = HARNESS_TARGETS.find((target) => target.id === id);
  if (!found) {
    throw new Error(
      `Unknown harness: ${String(id)}. Known harnesses: ${HARNESS_TARGETS.map((t) => t.id).join(', ')}.`,
    );
  }
  return found;
}
