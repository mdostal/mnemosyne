/**
 * cm-04-chatgpt-export-parser (epic: mnemosyne-conversation-memory).
 *
 * Synthetic, schema-accurate fixture: a single-branch (no editing) real-
 * shaped ChatGPT conversation -- a `client-created-root` scaffold node
 * (`message: null`) at the top, a hidden system-prompt node, then a plain
 * user -> assistant -> user -> assistant linear chain. Mirrors the real,
 * confirmed `conversations.json` shape (research-brief.md §1.2 + this
 * story's own research pass) exactly in KEY NAMES and STRUCTURE -- every
 * value below is invented, synthetic content, never copied from the
 * operator's real export.
 */

import type { RawChatGptConversation } from '../../parseChatGptExport.js';

export const BASIC_CONVERSATION: RawChatGptConversation = {
  title: 'Synthetic fixture: planning a garden layout',
  create_time: 1769000000.123,
  update_time: 1769000100.456,
  conversation_id: 'fixture-basic-conversation-0001',
  current_node: 'node-4-assistant',
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
        create_time: 1769000000.5,
        content: { content_type: 'text', parts: ['What should I plant in a small raised garden bed this fixture-spring?'] },
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
        create_time: 1769000010.5,
        content: { content_type: 'text', parts: ['For a small fixture raised bed, consider basil, cherry tomatoes, and marigolds.'] },
        metadata: {},
        status: 'finished_successfully',
      },
      parent: 'node-2-user',
      children: ['node-4-user-followup'],
    },
    'node-4-user-followup': {
      id: 'node-4-user-followup',
      message: {
        id: 'msg-4-user',
        author: { role: 'user', name: null },
        create_time: 1769000020.5,
        content: { content_type: 'text', parts: ['Great, and how often should I water the fixture basil?'] },
        metadata: {},
        status: 'finished_successfully',
      },
      parent: 'node-3-assistant',
      children: ['node-4-assistant'],
    },
    'node-4-assistant': {
      id: 'node-4-assistant',
      message: {
        id: 'msg-5-assistant',
        author: { role: 'assistant', name: null },
        create_time: 1769000030.5,
        content: { content_type: 'text', parts: ['Water fixture basil about twice a week, more in hot weather.'] },
        metadata: {},
        status: 'finished_successfully',
      },
      parent: 'node-4-user-followup',
      children: [],
    },
  },
};
