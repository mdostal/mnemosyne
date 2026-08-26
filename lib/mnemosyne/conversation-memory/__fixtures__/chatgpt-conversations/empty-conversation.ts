/**
 * cm-04-chatgpt-export-parser (epic: mnemosyne-conversation-memory).
 *
 * Synthetic fixture: a conversation scaffolded but never actually messaged
 * -- `current_node` is `null`. Not an error case; `parseChatGptConversation()`
 * returns an empty array (module doc comment).
 */

import type { RawChatGptConversation } from '../../parseChatGptExport.js';

export const EMPTY_CONVERSATION: RawChatGptConversation = {
  title: 'Synthetic fixture: never actually messaged',
  create_time: 1769500000,
  update_time: 1769500000,
  conversation_id: 'fixture-empty-conversation-0001',
  current_node: null,
  mapping: {
    'node-0-root': {
      id: 'node-0-root',
      message: null,
      parent: null,
      children: [],
    },
  },
};
