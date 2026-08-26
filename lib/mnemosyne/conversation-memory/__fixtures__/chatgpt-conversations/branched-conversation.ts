/**
 * cm-04-chatgpt-export-parser (epic: mnemosyne-conversation-memory).
 *
 * Synthetic, schema-accurate MULTI-BRANCH (edited-message) fixture -- the
 * named, first-class acceptance criterion this story's test-spec step must
 * cover, not an edge case left to chance (story `risks`, severity medium).
 *
 * Shape mirrors a REAL branch point this story's research step found and
 * confirmed directly in the operator's real, current `conversations.json`
 * (a node with more than one `children[]` entry, `current_node` pointing
 * down exactly one of them) -- but every id, timestamp, and text value
 * below is invented/synthetic, never copied from the real export.
 *
 * Structure: root -> system(hidden) -> user -> assistant -> [BRANCH POINT] a
 * user node with TWO children (the original question, then an edited
 * rephrasing of it) -> each leads to its own assistant reply.
 * `current_node` points at the SECOND (edited) branch's assistant reply --
 * a correct backward-walk-from-current_node linearization must include
 * ONLY the edited branch's user question + assistant reply, and must NOT
 * include the abandoned original question or its assistant reply anywhere
 * in the result.
 */

import type { RawChatGptConversation } from '../../parseChatGptExport.js';

export const BRANCHED_CONVERSATION: RawChatGptConversation = {
  title: 'Synthetic fixture: an edited question mid-conversation',
  create_time: 1769100000,
  update_time: 1769100200,
  conversation_id: 'fixture-branched-conversation-0001',
  // Points down the EDITED branch -- the active path a correct walk-back
  // must reconstruct.
  current_node: 'node-6-assistant-edited-reply',
  mapping: {
    'node-0-root': {
      id: 'node-0-root',
      message: null,
      parent: null,
      children: ['node-1-system'],
    },
    'node-1-system': {
      id: 'node-1-system',
      message: {
        id: 'msg-1-system',
        author: { role: 'system', name: null },
        create_time: null,
        content: { content_type: 'text', parts: [''] },
        metadata: { is_visually_hidden_from_conversation: true },
        status: 'finished_successfully',
      },
      parent: 'node-0-root',
      children: ['node-2-user'],
    },
    'node-2-user': {
      id: 'node-2-user',
      message: {
        id: 'msg-2-user',
        author: { role: 'user', name: null },
        create_time: 1769100001,
        content: { content_type: 'text', parts: ['Fixture: can you recommend a good beginner sourdough recipe?'] },
        metadata: {},
        status: 'finished_successfully',
      },
      parent: 'node-1-system',
      children: ['node-3-assistant'],
    },
    'node-3-assistant': {
      id: 'node-3-assistant',
      message: {
        id: 'msg-3-assistant',
        author: { role: 'assistant', name: null },
        create_time: 1769100010,
        content: { content_type: 'text', parts: ['Sure -- fixture recipe: 500g flour, 350g water, 100g starter, 10g salt.'] },
        metadata: {},
        status: 'finished_successfully',
      },
      parent: 'node-2-user',
      // TWO children -- this is the real branch point. The operator asked
      // the ORIGINAL follow-up (node-4), then edited it into node-5.
      children: ['node-4-user-original', 'node-5-user-edited'],
    },
    // --- Abandoned branch (must NEVER appear in parseChatGptConversation's output) ---
    'node-4-user-original': {
      id: 'node-4-user-original',
      message: {
        id: 'msg-4-user-original',
        author: { role: 'user', name: null },
        create_time: 1769100020,
        content: { content_type: 'text', parts: ['FIXTURE_ABANDONED_ORIGINAL_QUESTION should never appear in output'] },
        metadata: {},
        status: 'finished_successfully',
      },
      parent: 'node-3-assistant',
      children: ['node-4b-assistant-original-reply'],
    },
    'node-4b-assistant-original-reply': {
      id: 'node-4b-assistant-original-reply',
      message: {
        id: 'msg-4b-assistant-original',
        author: { role: 'assistant', name: null },
        create_time: 1769100025,
        content: { content_type: 'text', parts: ['FIXTURE_ABANDONED_ORIGINAL_REPLY should never appear in output'] },
        metadata: {},
        status: 'finished_successfully',
      },
      parent: 'node-4-user-original',
      children: [],
    },
    // --- Active (edited) branch -- current_node's own ancestry ---
    'node-5-user-edited': {
      id: 'node-5-user-edited',
      message: {
        id: 'msg-5-user-edited',
        author: { role: 'user', name: null },
        create_time: 1769100021,
        content: { content_type: 'text', parts: ['FIXTURE_ACTIVE_EDITED_QUESTION: actually, can you make that recipe gluten-free instead?'] },
        metadata: {},
        status: 'finished_successfully',
      },
      parent: 'node-3-assistant',
      children: ['node-6-assistant-edited-reply'],
    },
    'node-6-assistant-edited-reply': {
      id: 'node-6-assistant-edited-reply',
      message: {
        id: 'msg-6-assistant-edited',
        author: { role: 'assistant', name: null },
        create_time: 1769100026,
        content: { content_type: 'text', parts: ['FIXTURE_ACTIVE_EDITED_REPLY: try a 1:1 gluten-free flour blend with added xanthan gum.'] },
        metadata: {},
        status: 'finished_successfully',
      },
      parent: 'node-5-user-edited',
      children: [],
    },
  },
};
