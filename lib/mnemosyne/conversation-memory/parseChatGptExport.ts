/**
 * cm-04-chatgpt-export-parser (epic: mnemosyne-conversation-memory).
 *
 * Turns a real ChatGPT export's `conversations.json`
 * (`~/Downloads/ChatGPT Data Export Feb 5 2026/conversations.json`,
 * research-brief.md §1.2's confirmed schema — 258 conversations, 47,884,497
 * bytes) into the SAME shared `ConversationTurn[]` normalized shape
 * (`./types.ts`, `cm-03`'s contract, imported here UNCHANGED) that
 * `parseClaudeCodeSession.ts` produces — a `variation` sibling: same output
 * contract, structurally different input parser.
 *
 * ---------------------------------------------------------------------------
 * The mapping tree is a DAG, not a flat list. Linearize BACKWARD from
 * `current_node`, never forward from the root.
 * ---------------------------------------------------------------------------
 * Each conversation's real content lives in `mapping`: a dict keyed by node
 * id, each node carrying `id`, `message` (nullable — root/system scaffold
 * nodes have `message: null`), `parent`, and `children[]`. ChatGPT's own
 * message-editing feature creates real sibling branches — this story's own
 * research step re-confirmed this directly against the real, current
 * `conversations.json` on this machine: 32 of the real 258 conversations
 * contain at least one node with more than one child (49 real branch points
 * total), and `current_node` is the export's own pointer to the currently
 * ACTIVE path. `parseChatGptConversation()` below walks BACKWARD from
 * `current_node` through each node's own `parent` pointer, collecting the
 * real active path, then reverses it into chronological order. A forward
 * walk from the tree's root would have no principled way to choose which
 * child to descend into at a branch point and could wander into an
 * edited-away sibling branch — never attempted anywhere in this module.
 *
 * A `parent` pointer (including `current_node` itself) that names a node id
 * absent from `mapping` is a structurally corrupt export for that
 * conversation — this is a loud, named failure (`Error`), never a silent
 * empty/partial result. A `current_node` of `null`/`undefined` (a
 * conversation scaffolded but never actually messaged) is NOT an error —
 * `parseChatGptConversation()` returns an empty array for it, same as an
 * empty active path.
 *
 * ---------------------------------------------------------------------------
 * Scaffold / hidden-node filtering (never surfaced as a real turn).
 * ---------------------------------------------------------------------------
 * A node is excluded from the resulting `ConversationTurn[]` when:
 *  - `message` is `null` (a root/system scaffold node — confirmed present
 *    on every real conversation this pass: a synthetic
 *    `client-created-root` node with `message: null` sits above the real
 *    first turn).
 *  - `message.metadata.is_visually_hidden_from_conversation` is `true`
 *    (confirmed present on real system-prompt scaffold nodes AND on a real
 *    `user`-authored `user_editable_context` memory-profile node this
 *    pass — hidden filtering is NOT solely a `system`-role phenomenon).
 *
 * ---------------------------------------------------------------------------
 * Role whitelist — `message.author.role` must be `system`/`user`/`assistant`.
 * ---------------------------------------------------------------------------
 * `./types.ts`'s shared `ConversationRole` union is exactly
 * `'user' | 'assistant' | 'system'` (`cm-03`'s contract, imported here
 * UNCHANGED — this story never forks or extends it). This story's research
 * step found a FOURTH real `message.author.role` value in the real export
 * this pass: `'tool'` (~2,000 real occurrences across the 258 conversations
 * — browsing/plugin/tool-execution messages ChatGPT's own UI does not
 * render as a first-class chat bubble). A `'tool'`-authored node has no
 * principled mapping onto the shared 3-role contract, so — matching
 * `parseClaudeCodeSession.ts`'s own whitelist-not-blacklist discipline for
 * non-conversational envelope types — a node whose `author.role` is not
 * exactly `'system'`/`'user'`/`'assistant'` is silently excluded from the
 * output, never a parse failure and never coerced into one of the three
 * real roles.
 *
 * ---------------------------------------------------------------------------
 * Content-type whitelist — only real conversational TEXT is extracted.
 * ---------------------------------------------------------------------------
 * This story's design decision (`.pHive/.../cm-04-chatgpt-export-
 * parser.yaml`'s own `design_decisions`): attachment/image content
 * (`content.content_type` other than `'text'`) is never read as
 * conversational text — this story's scope is conversational text memory,
 * not full export-fidelity preservation (explicitly accepted scope
 * limitation, story `risks`). This story's own research step found the real
 * `content.content_type` set is considerably larger than research-brief.md
 * §1.2 sampled: alongside `'text'`, real conversations also carry `'code'`,
 * `'thoughts'`, `'tether_quote'`, `'multimodal_text'`, `'reasoning_recap'`,
 * `'execution_output'`, `'user_editable_context'`, `'tether_browsing_
 * display'`, `'super_widget'`, `'computer_output'`, and `'system_error'`
 * nodes in the real 258-conversation export. Per the story's own design
 * decision, only two content types are ever read for text:
 *  - `'text'`      -> `content.parts` is an array of plain strings; joined.
 *  - `'multimodal_text'` -> `content.parts` MIXES plain strings (real
 *                     user/assistant-authored caption text) with
 *                     image-asset-pointer OBJECTS (`{content_type:
 *                     'image_asset_pointer', asset_pointer: 'sediment://...',
 *                     ...}` — a reference to a binary attachment file this
 *                     module never reads). Only the STRING parts are
 *                     extracted; an asset-pointer object is skipped for that
 *                     part only — same per-part whitelist discipline
 *                     `parseClaudeCodeSession.ts` applies to `tool_result`
 *                     sub-blocks. The referenced attachment's actual binary
 *                     content is NEVER read anywhere in this module (AC5).
 *  - anything else -> the whole node is excluded from the output (no
 *                     principled "conversational text" to extract this
 *                     story's first cut) — a scope limitation, not a parse
 *                     failure.
 *
 * ---------------------------------------------------------------------------
 * `cm-01` secret-scan integration (design-discussion.md §2.8, checkpoint
 * 1 of 2) — identical discipline to `parseClaudeCodeSession.ts`.
 * ---------------------------------------------------------------------------
 * `scanForSecrets()` (`./scanForSecrets.ts`, cm-01, already built) runs over
 * EVERY extracted turn's `text` before this function returns — the real,
 * unstubbed export, never a mock. A match quarantines that turn.
 *
 * Story: cm-04-chatgpt-export-parser (epic: mnemosyne-conversation-memory).
 */

import { readFile } from 'node:fs/promises';
import { scanForSecrets } from './scanForSecrets.js';
import type { ConversationTurn } from './types.js';

// ---------------------------------------------------------------------------
// Raw export shapes. Deliberately loose (`unknown`-typed fields probed
// defensively) -- this is untrusted, externally-authored JSON from a real
// export file, not a shape this module controls. Field names match the
// real, confirmed `conversations.json` keys (research-brief.md §1.2 plus
// this story's own re-confirmation pass) exactly.
// ---------------------------------------------------------------------------

/** A single part of a `multimodal_text` node's `content.parts` array that is NOT plain text (e.g. an image attachment reference). Never read as text -- see module doc comment. */
export interface RawNonTextContentPart {
  content_type?: unknown;
  asset_pointer?: unknown;
  [key: string]: unknown;
}

export type RawContentPart = string | RawNonTextContentPart;

export interface RawMessageContent {
  content_type?: unknown;
  parts?: unknown;
}

export interface RawMessageAuthor {
  role?: unknown;
  name?: unknown;
}

export interface RawMessageMetadata {
  is_visually_hidden_from_conversation?: unknown;
  [key: string]: unknown;
}

export interface RawMessage {
  id?: unknown;
  author?: unknown;
  create_time?: unknown;
  content?: unknown;
  metadata?: unknown;
  status?: unknown;
}

export interface RawMappingNode {
  id?: unknown;
  message?: unknown;
  parent?: unknown;
  children?: unknown;
}

/** The real, confirmed per-conversation shape (research-brief.md §1.2). Only the fields this parser consumes are declared -- `moderation_results`/`plugin_ids`/`gizmo_id`/etc. are real but explicitly out of scope this story's first cut (story `risks`). */
export interface RawChatGptConversation {
  title?: unknown;
  create_time?: unknown;
  update_time?: unknown;
  conversation_id?: unknown;
  current_node?: unknown;
  mapping?: unknown;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function asRawMappingNode(value: unknown): RawMappingNode | null {
  if (!value || typeof value !== 'object') return null;
  return value as RawMappingNode;
}

function asRawMessage(value: unknown): RawMessage | null {
  if (!value || typeof value !== 'object') return null;
  return value as RawMessage;
}

/** Extracts a node's readable text per the content-type whitelist -- see module doc comment. `null` when this content type carries no conversational text this story's first cut supports. */
function extractMessageText(message: RawMessage): string | null {
  const content = message.content && typeof message.content === 'object' ? (message.content as RawMessageContent) : null;
  if (!content) return null;
  const contentType = content.content_type;
  if (contentType !== 'text' && contentType !== 'multimodal_text') return null;

  const parts = Array.isArray(content.parts) ? content.parts : [];
  const textParts: string[] = [];
  for (const part of parts) {
    // `'text'` nodes: every part is a plain string. `'multimodal_text'`
    // nodes: parts MIX plain strings with image-asset-pointer objects --
    // only the string parts are read; an object part (an attachment
    // reference) is skipped for that part only, its binary content NEVER
    // read (AC5).
    if (typeof part === 'string' && part.length > 0) textParts.push(part);
  }
  return textParts.join('\n\n');
}

/** Real `message.create_time` is a Unix epoch in seconds (float), or `null`/absent. Converts to the shared contract's ISO 8601 string, or `null`. */
function toIsoTimestamp(createTime: unknown): string | null {
  if (typeof createTime !== 'number' || !Number.isFinite(createTime)) return null;
  return new Date(createTime * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parses ONE already-parsed real (or real-shaped fixture) ChatGPT
 * conversation object into the shared `ConversationTurn[]` contract.
 *
 * Linearizes by walking BACKWARD from `current_node` through each node's own
 * `parent` pointer (never forward from the tree's root -- see module doc
 * comment), then reverses into chronological order. Scaffold nodes
 * (`message: null`), hidden nodes
 * (`message.metadata.is_visually_hidden_from_conversation === true`), nodes
 * whose `message.author.role` is not `'system'`/`'user'`/`'assistant'`, and
 * nodes whose `content.content_type` carries no supported conversational
 * text are all excluded from the result -- never surfaced as a real turn.
 *
 * Runs `cm-01`'s real `scanForSecrets()` over every extracted turn's text
 * before returning -- a match quarantines that turn.
 *
 * Throws if `current_node`, or any node's own `parent` pointer, names an id
 * absent from `mapping` (a structurally corrupt conversation) -- this is the
 * one loud-failure case in this module; a `current_node` of
 * `null`/`undefined` is NOT an error and yields an empty array.
 */
export function parseChatGptConversation(conversation: RawChatGptConversation): ConversationTurn[] {
  const sessionId = typeof conversation.conversation_id === 'string' ? conversation.conversation_id : '';
  const mappingRaw = conversation.mapping && typeof conversation.mapping === 'object' ? (conversation.mapping as Record<string, unknown>) : {};

  const mapping = new Map<string, RawMappingNode>();
  for (const [id, rawNode] of Object.entries(mappingRaw)) {
    const node = asRawMappingNode(rawNode);
    if (node) mapping.set(id, node);
  }

  const currentNode = conversation.current_node;
  if (typeof currentNode !== 'string' || currentNode.length === 0) {
    // No active path at all -- a scaffolded-but-never-messaged conversation.
    // Not an error; nothing to linearize.
    return [];
  }

  // Walk BACKWARD from current_node through parent pointers -- the real
  // active path, never a forward walk from the root (module doc comment).
  const activePathNodeIds: string[] = [];
  const visited = new Set<string>();
  let cursor: string | null = currentNode;
  while (cursor !== null) {
    if (visited.has(cursor)) {
      throw new Error(`parseChatGptConversation: cycle detected in parent chain at node "${cursor}" (conversation ${sessionId || '<unknown>'})`);
    }
    visited.add(cursor);
    const node = mapping.get(cursor);
    if (!node) {
      throw new Error(`parseChatGptConversation: node "${cursor}" referenced (as current_node or a parent pointer) but absent from mapping (conversation ${sessionId || '<unknown>'})`);
    }
    activePathNodeIds.push(cursor);
    const parent = node.parent;
    cursor = typeof parent === 'string' && parent.length > 0 ? parent : null;
  }
  activePathNodeIds.reverse(); // root-most (earliest) first -> chronological order.

  const turns: ConversationTurn[] = [];
  let turnIndex = 0;

  for (const nodeId of activePathNodeIds) {
    const node = mapping.get(nodeId)!;
    const message = asRawMessage(node.message);
    if (!message) continue; // scaffold node (`message: null`).

    const metadata = message.metadata && typeof message.metadata === 'object' ? (message.metadata as RawMessageMetadata) : null;
    if (metadata?.is_visually_hidden_from_conversation === true) continue;

    const author = message.author && typeof message.author === 'object' ? (message.author as RawMessageAuthor) : null;
    const role = author?.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') continue; // e.g. real 'tool' role -- see module doc comment.

    const text = extractMessageText(message);
    if (text === null) continue; // content_type carries no supported conversational text this story's first cut.

    const timestamp = toIsoTimestamp(message.create_time);
    const secretMatches = scanForSecrets(text);
    const quarantined = secretMatches.length > 0;

    turns.push({
      sessionId,
      sourceType: 'chatgpt',
      role,
      text,
      timestamp,
      projectSlug: null, // ChatGPT conversations have no repo/project association -- explicit, never omitted (cross_cutting: provenance-completeness).
      turnIndex,
      quarantined,
      quarantineReason: quarantined ? 'secret_detected' : null,
      secretMatches,
    });
    turnIndex++;
  }

  return turns;
}

/**
 * Parses a real ChatGPT export's `conversations.json` file at `filePath` --
 * a top-level JSON array of conversation objects (research-brief.md §1.2) --
 * into the shared `ConversationTurn[]` contract, flat-mapping
 * `parseChatGptConversation()` over every conversation in the file.
 *
 * The file itself (conversational text + tree structure, ~48MB for the real
 * 258-conversation export) is read and `JSON.parse`d as a whole -- this
 * module never reads any attachment/image blob file (those live as separate
 * files alongside `conversations.json` in a real export and are never
 * referenced by path anywhere in this module -- AC5).
 */
export async function parseChatGptExport(filePath: string): Promise<ConversationTurn[]> {
  const raw = await readFile(filePath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`parseChatGptExport: expected a top-level JSON array in ${filePath}, got ${typeof parsed}`);
  }

  const turns: ConversationTurn[] = [];
  for (const conversation of parsed as RawChatGptConversation[]) {
    turns.push(...parseChatGptConversation(conversation));
  }
  return turns;
}
