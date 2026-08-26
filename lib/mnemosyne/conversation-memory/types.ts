/**
 * cm-03-claude-code-session-parser (epic: mnemosyne-conversation-memory).
 *
 * The single shared `ConversationTurn` contract this story's
 * `parseClaudeCodeSession.ts` and `cm-04`'s `parseChatGptExport.ts` both
 * produce (docs/structured-outline.md §2 Phase 2) -- the ONE normalized
 * shape every downstream story (`cm-05`/`cm-06`/`cm-07`) consumes, never a
 * source-specific field. `cm-04` imports this file UNCHANGED -- do not add
 * a Claude-Code-specific or ChatGPT-specific field here; a source's own
 * extra detail belongs in that source's own parser internals, not in this
 * shared contract.
 *
 * Story: cm-03-claude-code-session-parser (epic: mnemosyne-conversation-memory).
 */

import type { SecretMatch } from './scanForSecrets.js';

/** Which parser produced a given turn -- stamped at parse time, never inferred downstream. */
export type ConversationSourceType = 'claude-code' | 'chatgpt';

/**
 * Speaker role. `'system'` exists for parity with the ChatGPT `mapping`
 * tree's `message.author.role` values (research-brief.md §1.2, consumed by
 * `cm-04`) -- a real Claude Code session JSONL line's `type` is only ever
 * `'user'` or `'assistant'` (research-brief.md §1.1), so
 * `parseClaudeCodeSession()` never itself produces a `'system'`-role turn.
 */
export type ConversationRole = 'user' | 'assistant' | 'system';

/**
 * Why a turn was quarantined. A union of exactly one value today --
 * `cm-01`'s secret scanner is the only quarantine trigger anywhere in this
 * epic (design-discussion.md §2.8) -- so a future second trigger is a
 * compile-time-visible addition to this type, never a silently-invented
 * string literal at some call site.
 */
export type QuarantineReason = 'secret_detected';

/**
 * The normalized shape every source-specific parser in this epic produces.
 *
 * Provenance-completeness (this epic's own named cross-cutting concern):
 * every turn traces back to a real position in a real source session --
 * `sessionId` + `turnIndex` + `projectSlug`, never an anonymous blob.
 */
export interface ConversationTurn {
  /** Real session/conversation id from the source (Claude Code's own `sessionId`; ChatGPT's `conversation_id` for cm-04). */
  sessionId: string;
  /** Which parser produced this turn. */
  sourceType: ConversationSourceType;
  /** Speaker role for this turn. */
  role: ConversationRole;
  /**
   * Extracted, human-readable text only.
   *
   * A `thinking` content block's `signature` field is NEVER read into this
   * field, under any circumstance -- see `parseClaudeCodeSession.ts`'s own
   * doc comment for the exact per-block-type extraction rules this
   * contract's producers follow. `tool_use`/`tool_result` blocks are
   * reduced to a single bounded excerpt line each (tool name + a short
   * truncated summary) -- never the full raw payload verbatim, and never
   * silently dropped from this field entirely.
   */
  text: string;
  /** ISO 8601 timestamp, or `null` when the source line/node carries none. */
  timestamp: string | null;
  /**
   * Best-effort decoded project path (Claude Code sessions only --
   * `discoverSources.ts`'s own `decodeProjectSlug()` heuristic, reused
   * here rather than reimplemented). `null` for sources with no project
   * concept (e.g. a standalone ChatGPT conversation, `cm-04`).
   */
  projectSlug: string | null;
  /** 0-based position of this turn within its own session, in original source order -- never re-sorted, never renumbered after quarantine filtering. */
  turnIndex: number;
  /**
   * `true` when `cm-01`'s `scanForSecrets()` found at least one match
   * anywhere in this turn's extracted `text` (design-discussion.md §2.8's
   * "run twice" design -- this is checkpoint 1 of 2, the other being
   * `cm-07`'s immediate-pre-persist re-scan). Quarantine is a FLAG, never a
   * silent drop and never a silent pass-through: `text` above still
   * carries the turn's real extracted content so a human reviewer can see
   * what was caught and decide -- but a quarantined turn's raw `text` must
   * never be forwarded to `cm-05`'s LLM classification call (`cm-05`'s own
   * acceptance criterion).
   */
  quarantined: boolean;
  /** Why this turn was quarantined. `null` when `quarantined` is `false`. */
  quarantineReason: QuarantineReason | null;
  /**
   * `cm-01`'s own real match objects for this turn's `text` (empty array
   * when `quarantined` is `false`). Every field here is already
   * redaction-safe by `cm-01`'s own contract (`SecretMatch.preview` never
   * contains a raw secret value) -- safe to surface directly in a
   * human-review queue (design-discussion.md §2.8's
   * `quarantine_reason: 'secret_detected'` tagging).
   */
  secretMatches: SecretMatch[];
}
