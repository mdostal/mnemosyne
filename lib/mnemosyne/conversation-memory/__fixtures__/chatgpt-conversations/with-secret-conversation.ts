/**
 * cm-04-chatgpt-export-parser (epic: mnemosyne-conversation-memory).
 *
 * Synthetic, schema-accurate fixture exercising `cm-01`'s real
 * `scanForSecrets()` integration: a clean turn followed by a turn whose text
 * embeds one of `cm-01`'s OWN fixture secrets
 * (`../secrets-corpus.ts`'s `POSITIVE_FIXTURES`) -- identical discipline to
 * `parseClaudeCodeSession.test.ts`'s own `with-secret.jsonl` fixture.
 */

import type { RawChatGptConversation } from '../../parseChatGptExport.js';
import { POSITIVE_FIXTURES } from '../secrets-corpus.js';

const FIXTURE_SECRET_TEXT = POSITIVE_FIXTURES.find((f) => f.id === 'openai-shaped-sk-key')!.text;

export const WITH_SECRET_CONVERSATION: RawChatGptConversation = {
  title: 'Synthetic fixture: a leaked-looking API key mid-conversation',
  create_time: 1769200000,
  update_time: 1769200100,
  conversation_id: 'fixture-with-secret-conversation-0001',
  current_node: 'node-3-assistant-secret',
  mapping: {
    'node-0-root': {
      id: 'node-0-root',
      message: null,
      parent: null,
      children: ['node-1-user'],
    },
    'node-1-user': {
      id: 'node-1-user',
      message: {
        id: 'msg-1-user',
        author: { role: 'user', name: null },
        create_time: 1769200001,
        content: { content_type: 'text', parts: ['Fixture: how do I call the fixture API from a Node script?'] },
        metadata: {},
        status: 'finished_successfully',
      },
      parent: 'node-0-root',
      children: ['node-2-assistant-clean'],
    },
    'node-2-assistant-clean': {
      id: 'node-2-assistant-clean',
      message: {
        id: 'msg-2-assistant',
        author: { role: 'assistant', name: null },
        create_time: 1769200010,
        content: { content_type: 'text', parts: ['Fixture: use fetch() with your API key in an Authorization header, kept out of source control.'] },
        metadata: {},
        status: 'finished_successfully',
      },
      parent: 'node-1-user',
      children: ['node-3-user-secret'],
    },
    'node-3-user-secret': {
      id: 'node-3-user-secret',
      message: {
        id: 'msg-3-user',
        author: { role: 'user', name: null },
        create_time: 1769200020,
        content: { content_type: 'text', parts: [FIXTURE_SECRET_TEXT] },
        metadata: {},
        status: 'finished_successfully',
      },
      parent: 'node-2-assistant-clean',
      children: ['node-3-assistant-secret'],
    },
    'node-3-assistant-secret': {
      id: 'node-3-assistant-secret',
      message: {
        id: 'msg-4-assistant',
        author: { role: 'assistant', name: null },
        create_time: 1769200030,
        content: { content_type: 'text', parts: ['Fixture: thanks, but please rotate that key immediately since you just pasted it here.'] },
        metadata: {},
        status: 'finished_successfully',
      },
      parent: 'node-3-user-secret',
      children: [],
    },
  },
};
