/**
 * cm-10-gemini-conversation-ingestion (epic: mnemosyne-conversation-memory).
 *
 * Synthetic fixture exercising the whitelist-not-blacklist / no-principled-
 * text edge cases `parseGeminiTakeoutConversation()` must handle without
 * ever surfacing an empty or fabricated turn:
 *
 *  - An unrecognized turn-wrapper key (`tool_turn`) -- a plausible FUTURE
 *    Gemini turn kind neither this story's research step nor
 *    `design-discussion.md §10.1` has ever observed in the real staged
 *    export. Whitelist-filtered out silently, never coerced onto the
 *    shared 3-role contract (mirrors `parseChatGptExport.ts`'s own real
 *    `'tool'`-role precedent).
 *  - A `user_turn` whose `prompt` is an empty string -- no principled text
 *    to extract, excluded rather than surfaced as an empty turn.
 *  - A `system_turn` whose every `text` part is an empty-`data`,
 *    no-`preamble` part -- likewise excluded.
 *  - A real, non-empty `user_turn` and `system_turn` pair bracketing the
 *    above, to prove exclusion is per-turn, not a whole-conversation
 *    short-circuit.
 */

import type { RawGeminiTakeoutConversation } from '../../parseGeminiTakeoutExport.js';

export const EDGE_CASE_CONVERSATION: RawGeminiTakeoutConversation = {
  title: 'Fixture: edge cases -- unrecognized turn kind, empty prompt, empty system text',
  creation_time: '2026-03-04T12:00:00.000000+00:00',
  last_modification_time: '2026-03-04T12:00:30.000000+00:00',
  conversation_turns: [
    {
      user_turn: {
        prompt: 'Fixture: FIXTURE_REAL_FIRST_PROMPT -- what is today\'s fixture agenda?',
        turn_index: 0,
        turn_last_modified: '2026-03-04T12:00:00.000000+00:00',
      },
    },
    {
      // Not a real, observed Gemini turn kind -- future-proofing whitelist test.
      tool_turn: {
        tool_name: 'fixture_calendar_lookup',
        turn_index: 1,
        turn_last_modified: '2026-03-04T12:00:05.000000+00:00',
      },
    },
    {
      user_turn: {
        prompt: '',
        turn_index: 2,
        turn_last_modified: '2026-03-04T12:00:10.000000+00:00',
      },
    },
    {
      system_turn: {
        text: [{ data: '' }, { data: '', preamble: '' }],
        turn_index: 3,
        turn_last_modified: '2026-03-04T12:00:15.000000+00:00',
      },
    },
    {
      system_turn: {
        text: [{ data: 'Fixture: FIXTURE_REAL_LAST_REPLY -- here is the fixture agenda for today.' }],
        turn_index: 4,
        turn_last_modified: '2026-03-04T12:00:30.000000+00:00',
      },
    },
  ],
};
