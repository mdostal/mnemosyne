/**
 * cm-10-gemini-conversation-ingestion (epic: mnemosyne-conversation-memory).
 *
 * Synthetic fixture exercising `cm-01`'s real `scanForSecrets()`
 * integration: a clean exchange followed by a `user_turn` whose `prompt`
 * embeds one of `cm-01`'s OWN fixture secrets (`../secrets-corpus.ts`'s
 * `POSITIVE_FIXTURES`) -- identical discipline to `parseChatGptExport.
 * test.ts`'s own `with-secret-conversation.ts` fixture.
 */

import type { RawGeminiTakeoutConversation } from '../../parseGeminiTakeoutExport.js';
import { POSITIVE_FIXTURES } from '../secrets-corpus.js';

const FIXTURE_SECRET_TEXT = POSITIVE_FIXTURES.find((f) => f.id === 'aws-access-key-id')!.text;

export const WITH_SECRET_CONVERSATION: RawGeminiTakeoutConversation = {
  title: 'Fixture: synthetic Gemini in Workspace conversation with a leaked-looking secret',
  creation_time: '2026-03-02T10:00:00.000000+00:00',
  last_modification_time: '2026-03-02T10:00:12.000000+00:00',
  conversation_turns: [
    {
      user_turn: {
        prompt: 'Fixture: how do I connect to the fixture deployment service from a script?',
        turn_index: 0,
        turn_last_modified: '2026-03-02T10:00:00.000000+00:00',
      },
    },
    {
      system_turn: {
        text: [{ data: 'Fixture: use the fixture deployment CLI with your access key kept out of source control.' }],
        turn_index: 1,
        turn_last_modified: '2026-03-02T10:00:04.000000+00:00',
      },
    },
    {
      user_turn: {
        prompt: FIXTURE_SECRET_TEXT,
        turn_index: 2,
        turn_last_modified: '2026-03-02T10:00:08.000000+00:00',
      },
    },
    {
      system_turn: {
        text: [{ data: 'Fixture: thanks, but please rotate that credential immediately since you just pasted it here.' }],
        turn_index: 3,
        turn_last_modified: '2026-03-02T10:00:12.000000+00:00',
      },
    },
  ],
};
