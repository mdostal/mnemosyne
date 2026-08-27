/**
 * cm-10-gemini-conversation-ingestion (epic: mnemosyne-conversation-memory).
 *
 * Synthetic fixture: a structurally corrupt conversation entry whose
 * `conversation_turns` field is not an array at all -- the one loud-
 * failure case `parseGeminiTakeoutConversation()` names, mirroring
 * `parseChatGptExport.ts`'s own dangling-reference loud-failure precedent.
 */

import type { RawGeminiTakeoutConversation } from '../../parseGeminiTakeoutExport.js';

export const CORRUPTED_NON_ARRAY_TURNS_CONVERSATION: RawGeminiTakeoutConversation = {
  title: 'Fixture: conversation_turns is not an array',
  creation_time: '2026-03-05T13:00:00.000000+00:00',
  last_modification_time: '2026-03-05T13:00:00.000000+00:00',
  // Deliberately wrong shape for this test -- a real export always carries
  // an array here; this fixture asserts the parser fails loudly rather
  // than silently coercing/crashing unhelpfully.
  conversation_turns: 'not-an-array' as unknown as RawGeminiTakeoutConversation['conversation_turns'],
};
