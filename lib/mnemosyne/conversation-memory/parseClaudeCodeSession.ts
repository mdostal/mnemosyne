/**
 * cm-03-claude-code-session-parser (epic: mnemosyne-conversation-memory).
 *
 * Turns a real Claude Code session JSONL file
 * (`~/.claude/projects/<project-slug>/<session-id>.jsonl`, research-brief.md
 * §1.1's confirmed schema) into the shared `ConversationTurn[]` normalized
 * shape (`./types.ts`) both this story and `cm-04` produce.
 *
 * ---------------------------------------------------------------------------
 * Streaming, never a full-file in-memory load.
 * ---------------------------------------------------------------------------
 * Real sessions run 6MB to 53MB+ (research-brief.md §1.1). This module reads
 * the file line-by-line via `node:readline` over a `fs.createReadStream` --
 * `fs.readFileSync`/`fs.promises.readFile` (a whole-file buffer/string) are
 * never called against a session file anywhere in this module. Only the
 * (small, per-turn, excerpt-bounded) OUTPUT accumulates in memory as this
 * function reads forward -- never the raw file bytes as a second copy.
 *
 * ---------------------------------------------------------------------------
 * Non-conversational lines: skip by WHITELIST, not by an enumerated
 * blacklist.
 * ---------------------------------------------------------------------------
 * This story's own research step re-confirmed the real JSONL schema against
 * three real, current sessions across three different real projects (two
 * different Claude Code CLI versions: 2.1.219 and 2.1.233 observed) and
 * found the real, non-conversational line `type` set is FAR larger than the
 * three names research-brief.md §1.1 originally sampled (`mode`,
 * `permission-mode`, `file-history-snapshot`): real sessions also carry
 * `last-prompt`, `file-history-delta`, `ai-title`, `attachment`, `pr-link`,
 * `system`, `queue-operation`, and `frame-link` lines, and the exact set
 * visibly differs release to release (schema drift, this story's own named
 * risk). Rather than maintain a blacklist that a future CLI version could
 * silently outrun (producing a NEW non-conversational type this module has
 * never seen, which a blacklist would then wrongly attempt to parse as a
 * turn), this module uses the inverse, structurally robust rule: only lines
 * with `type === 'user'` or `type === 'assistant'` are ever treated as
 * conversational. Every other well-formed JSON line -- named ones above,
 * and any future one a newer CLI release invents -- is silently skipped,
 * never treated as a parse failure (the story's own AC6). Only a line that
 * fails `JSON.parse` outright is a loud, named failure.
 *
 * ---------------------------------------------------------------------------
 * Content-block extraction rules (per `message.content` block `type`).
 * ---------------------------------------------------------------------------
 *  - `text`             -> the block's own `text` string, verbatim.
 *  - `thinking`         -> the block's own `thinking` string (the model's
 *                          real reasoning content) ONLY. The block's
 *                          `signature` field -- an opaque, large base64
 *                          cryptographic signature OVER that reasoning, not
 *                          reasoning content itself (research-brief.md
 *                          §1.1) -- is never read, never referenced, never
 *                          copied anywhere in this module. AC2 is enforced
 *                          structurally by this: `extractBlockText()`'s
 *                          `'thinking'` case has no code path that touches
 *                          `block.signature` at all.
 *  - `tool_use`         -> a single bounded excerpt line: tool `name` plus
 *                          a truncated summary of `input`, capped at
 *                          `TOOL_EXCERPT_MAX_CHARS` -- never the full raw
 *                          `input` payload verbatim (a real `Bash` call's
 *                          `input.command` can itself be arbitrarily long),
 *                          and never omitted entirely (tool activity is
 *                          real signal for WHAT was built).
 *  - `tool_result`      -> a single bounded excerpt line of the result
 *                          `content` (string, or an array of sub-blocks --
 *                          only `text` sub-blocks are read; each other
 *                          sub-block type, e.g. an image, is skipped, same
 *                          whitelist discipline as the top-level line
 *                          type), capped at `TOOL_EXCERPT_MAX_CHARS`.
 *  - anything else       -> skipped for this block only (never crashes the
 *                          whole line) -- an unrecognized block type inside
 *                          an otherwise well-formed `user`/`assistant` line
 *                          is not the same failure class as a malformed
 *                          JSON line (AC6 only names the latter as a loud
 *                          failure); this module treats an unknown block
 *                          type the same as any other forward-compatible
 *                          unknown shape, consistent with the line-level
 *                          whitelist discipline above.
 *
 * `TOOL_EXCERPT_MAX_CHARS = 200`: this story's own suggested bound
 * (`.pHive/.../cm-03-claude-code-session-parser.yaml` step `research`),
 * adopted as-is -- long enough that a truncated `Bash` command or file
 * excerpt still reads as a real, useful summary for later triage, short
 * enough that even an arbitrarily large raw tool payload never dominates
 * this module's output size or a downstream LLM call's token budget.
 *
 * ---------------------------------------------------------------------------
 * `cm-01` secret-scan integration (design-discussion.md §2.8, checkpoint
 * 1 of 2).
 * ---------------------------------------------------------------------------
 * `scanForSecrets()` (`./scanForSecrets.ts`, cm-01, already built) runs over
 * EVERY extracted turn's `text` before this function returns -- the real,
 * unstubbed export, never a mock. A match quarantines that turn
 * (`quarantined: true`, `quarantineReason: 'secret_detected'`,
 * `secretMatches` populated with cm-01's own real, already-redaction-safe
 * match objects) -- never silently dropped, never silently passed through
 * unflagged.
 *
 * Story: cm-03-claude-code-session-parser (epic: mnemosyne-conversation-memory).
 */

import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { decodeProjectSlug } from './discoverSources.js';
import { scanForSecrets } from './scanForSecrets.js';
import type { ConversationTurn } from './types.js';

/**
 * Bound on a `tool_use`/`tool_result` excerpt's character length -- see
 * this module's own doc comment for the full rationale. Named and exported
 * so tests independently verify the real bound is enforced, not merely
 * documented.
 */
export const TOOL_EXCERPT_MAX_CHARS = 200;

const TRUNCATION_SUFFIX = '…[truncated]';

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const sliceLen = Math.max(0, maxChars - TRUNCATION_SUFFIX.length);
  return text.slice(0, sliceLen) + TRUNCATION_SUFFIX;
}

// ---------------------------------------------------------------------------
// Raw envelope / content-block shapes. Deliberately loose (`unknown`-typed
// fields probed defensively) -- this is untrusted, harness-authored JSONL
// from a real filesystem, not a shape this module controls.
// ---------------------------------------------------------------------------

interface RawContentBlock {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  // `signature` intentionally NOT declared as a field this module ever
  // reads -- see module doc comment. It is present on real `thinking`
  // blocks but no code path below accesses it.
  name?: unknown;
  input?: unknown;
  content?: unknown;
  is_error?: unknown;
}

interface RawMessage {
  role?: unknown;
  content?: unknown;
}

interface RawEnvelope {
  type?: unknown;
  uuid?: unknown;
  timestamp?: unknown;
  sessionId?: unknown;
  message?: unknown;
}

// ---------------------------------------------------------------------------
// Per-block-type excerpt builders.
// ---------------------------------------------------------------------------

function summarizeToolUseInput(input: unknown): string {
  if (input === undefined) return '';
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function excerptToolUse(block: RawContentBlock): string {
  const name = typeof block.name === 'string' && block.name.length > 0 ? block.name : 'unknown_tool';
  const summary = summarizeToolUseInput(block.input);
  return truncate(`[tool_use:${name}] ${summary}`, TOOL_EXCERPT_MAX_CHARS);
}

/** Flattens a `tool_result` block's `content` -- a string, or an array of sub-blocks (only `text` sub-blocks are read). */
function flattenToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const sub of content) {
      if (sub && typeof sub === 'object' && (sub as { type?: unknown }).type === 'text') {
        const t = (sub as { text?: unknown }).text;
        if (typeof t === 'string') parts.push(t);
      }
    }
    return parts.join('\n');
  }
  return '';
}

function excerptToolResult(block: RawContentBlock): string {
  const prefix = block.is_error === true ? '[tool_result:error]' : '[tool_result]';
  const body = flattenToolResultContent(block.content);
  return truncate(`${prefix} ${body}`, TOOL_EXCERPT_MAX_CHARS);
}

/** Extracts this ONE block's contribution to a turn's text, per the module doc comment's per-type rules. `null` when this block contributes nothing. */
function extractBlockText(block: RawContentBlock): string | null {
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' && block.text.length > 0 ? block.text : null;
    case 'thinking':
      // Reads `block.thinking` ONLY -- `block.signature` is never touched
      // anywhere in this function (AC2).
      return typeof block.thinking === 'string' && block.thinking.length > 0 ? block.thinking : null;
    case 'tool_use':
      return excerptToolUse(block);
    case 'tool_result':
      return excerptToolResult(block);
    default:
      return null;
  }
}

/** Extracts a turn's full text from `message.content` -- a plain string (simple user turns) or an array of typed blocks. */
function extractTurnText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const text = extractBlockText(raw as RawContentBlock);
    if (text) parts.push(text);
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parses a real Claude Code session JSONL file at `filePath` into the
 * shared `ConversationTurn[]` contract, streaming the file line-by-line
 * (never a full-file in-memory load -- see module doc comment).
 *
 * Non-conversational lines (`type` other than `'user'`/`'assistant'`) are
 * silently skipped, never treated as a parse failure. A genuinely malformed
 * JSON line rejects loudly, naming the 1-based line number and the file
 * path.
 *
 * Runs `cm-01`'s real `scanForSecrets()` over every extracted turn's text
 * before returning -- a match quarantines that turn (never silently
 * dropped, never silently passed through unflagged).
 */
export async function parseClaudeCodeSession(filePath: string): Promise<ConversationTurn[]> {
  const projectSlug = decodeProjectSlug(path.basename(path.dirname(filePath)));

  const turns: ConversationTurn[] = [];
  let lineNumber = 0;
  let turnIndex = 0;

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const rawLine of rl) {
    lineNumber++;
    const line = rawLine.trim();
    if (line.length === 0) continue;

    let envelope: RawEnvelope;
    try {
      envelope = JSON.parse(line) as RawEnvelope;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`parseClaudeCodeSession: malformed JSON on line ${lineNumber} of ${filePath}: ${reason}`);
    }

    // Whitelist, not blacklist -- see module doc comment for why.
    if (envelope.type !== 'user' && envelope.type !== 'assistant') continue;

    const role = envelope.type;
    const message = (envelope.message && typeof envelope.message === 'object' ? envelope.message : {}) as RawMessage;
    const text = extractTurnText(message.content);
    const sessionId = typeof envelope.sessionId === 'string' ? envelope.sessionId : '';
    const timestamp = typeof envelope.timestamp === 'string' ? envelope.timestamp : null;

    const secretMatches = scanForSecrets(text);
    const quarantined = secretMatches.length > 0;

    turns.push({
      sessionId,
      sourceType: 'claude-code',
      role,
      text,
      timestamp,
      projectSlug,
      turnIndex,
      quarantined,
      quarantineReason: quarantined ? 'secret_detected' : null,
      secretMatches,
    });
    turnIndex++;
  }

  return turns;
}
