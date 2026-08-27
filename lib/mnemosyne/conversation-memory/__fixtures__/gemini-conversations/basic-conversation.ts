/**
 * cm-10-gemini-conversation-ingestion (epic: mnemosyne-conversation-memory).
 *
 * Synthetic, schema-accurate fixture mirroring the real, research-confirmed
 * Google Takeout "Gemini in Workspace" conversation-entry schema (this
 * story's own `research` step, re-confirmed directly against the real
 * staged export at `~/Downloads/Google Takeout Aug 26 2026.zip` -- content
 * NEVER copied here, only the schema shape). Despite the real entry's
 * `.txt` file extension, its content is JSON, not plain text and not an
 * `AF_initDataCallback`-style data-hydration blob (that shape belongs to
 * the separate, still-unstaged Share-link export type).
 *
 * Real, confirmed top-level shape: `{ conversation_turns, creation_time,
 * last_modification_time, title }`. `conversation_turns` is an array of
 * single-key wrapper objects -- each element is EITHER `{ user_turn: {...
 * } }` OR `{ system_turn: { ... } }`, never both on the same element.
 * `'system_turn'` is Gemini's own vocabulary for the ASSISTANT's reply turn
 * (never a system-prompt role) -- normalized onto the shared contract's
 * `'assistant'` role, never `'system'`.
 *
 * `user_turn`: `{ prompt: string, turn_index: number, turn_last_modified:
 * ISO-8601 string }`.
 *
 * `system_turn`: `{ text: Array<{ data: string, preamble?: string }>,
 * turn_index: number, turn_last_modified: ISO-8601 string }` -- a real,
 * previously-unconfirmed nuance this story's research step found: a
 * `system_turn`'s reply can be split across multiple `text` array parts,
 * and a part may carry a `preamble` (a short lead-in sentence) paired with
 * an EMPTY `data` string, immediately followed by a sibling part carrying
 * the real reply text in `data` with no `preamble` key at all. This basic
 * fixture's second `system_turn` exercises exactly that two-part shape.
 */

import type { RawGeminiTakeoutConversation } from '../../parseGeminiTakeoutExport.js';

export const BASIC_CONVERSATION: RawGeminiTakeoutConversation = {
  title: 'Fixture: synthetic basic Gemini in Workspace conversation',
  creation_time: '2026-03-01T09:00:00.000000+00:00',
  last_modification_time: '2026-03-01T09:00:20.000000+00:00',
  conversation_turns: [
    {
      user_turn: {
        prompt: 'Fixture: draft a short thank-you note to the fixture team.',
        turn_index: 0,
        turn_last_modified: '2026-03-01T09:00:00.000000+00:00',
      },
    },
    {
      system_turn: {
        text: [
          { data: '', preamble: 'Fixture: sure, here is a short draft.' },
          { data: 'Fixture: thank you all for the fixture-project effort this quarter.' },
        ],
        turn_index: 1,
        turn_last_modified: '2026-03-01T09:00:05.000000+00:00',
      },
    },
    {
      user_turn: {
        prompt: 'Fixture: make it a bit warmer in tone.',
        turn_index: 2,
        turn_last_modified: '2026-03-01T09:00:15.000000+00:00',
      },
    },
    {
      system_turn: {
        text: [{ data: 'Fixture: thank you so much, truly, for such a wonderful quarter of fixture-project work!' }],
        turn_index: 3,
        turn_last_modified: '2026-03-01T09:00:20.000000+00:00',
      },
    },
  ],
};
