/**
 * cm-04-chatgpt-export-parser (epic: mnemosyne-conversation-memory).
 *
 * Synthetic fixture: a structurally corrupt conversation whose
 * `current_node` names a node id absent from `mapping` -- the one loud-
 * failure case `parseChatGptConversation()` names (module doc comment).
 */

import type { RawChatGptConversation } from '../../parseChatGptExport.js';

export const CORRUPTED_DANGLING_CURRENT_NODE_CONVERSATION: RawChatGptConversation = {
  title: 'Synthetic fixture: current_node points nowhere',
  create_time: 1769400000,
  update_time: 1769400001,
  conversation_id: 'fixture-corrupted-conversation-0001',
  current_node: 'node-does-not-exist',
  mapping: {
    'node-0-root': {
      id: 'node-0-root',
      message: null,
      parent: null,
      children: [],
    },
  },
};

/** Same idea, but the dangling reference is a `parent` pointer partway up the chain rather than `current_node` itself. */
export const CORRUPTED_DANGLING_PARENT_CONVERSATION: RawChatGptConversation = {
  title: 'Synthetic fixture: a parent pointer points nowhere',
  create_time: 1769400100,
  update_time: 1769400101,
  conversation_id: 'fixture-corrupted-conversation-0002',
  current_node: 'node-1-user',
  mapping: {
    'node-1-user': {
      id: 'node-1-user',
      message: {
        id: 'msg-1-user',
        author: { role: 'user', name: null },
        create_time: 1769400100,
        content: { content_type: 'text', parts: ['fixture text'] },
        metadata: {},
        status: 'finished_successfully',
      },
      parent: 'node-0-does-not-exist',
      children: [],
    },
  },
};
