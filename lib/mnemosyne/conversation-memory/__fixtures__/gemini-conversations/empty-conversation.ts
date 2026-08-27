/**
 * cm-10-gemini-conversation-ingestion (epic: mnemosyne-conversation-memory).
 *
 * Synthetic fixture: a real, well-formed conversation entry with a zero-
 * length `conversation_turns` array (e.g. a scaffolded-but-abandoned
 * conversation). Not an error case -- `parseGeminiTakeoutConversation()`
 * returns an empty array, mirroring `parseChatGptConversation()`'s own
 * `EMPTY_CONVERSATION` (`current_node: null`) non-error precedent.
 */

import type { RawGeminiTakeoutConversation } from '../../parseGeminiTakeoutExport.js';

export const EMPTY_CONVERSATION: RawGeminiTakeoutConversation = {
  title: 'Fixture: never actually messaged',
  creation_time: '2026-03-03T11:00:00.000000+00:00',
  last_modification_time: '2026-03-03T11:00:00.000000+00:00',
  conversation_turns: [],
};
