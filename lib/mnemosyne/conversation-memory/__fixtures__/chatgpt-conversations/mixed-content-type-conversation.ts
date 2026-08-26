/**
 * cm-04-chatgpt-export-parser (epic: mnemosyne-conversation-memory).
 *
 * Synthetic, schema-accurate fixture exercising the real
 * `message.author.role` / `content.content_type` diversity this story's
 * research step found directly in the real, current `conversations.json`
 * (far larger than research-brief.md §1.2's original sample -- see
 * `parseChatGptExport.ts`'s own module doc comment): a `'tool'`-authored
 * node (excluded -- not one of the shared contract's three roles), a
 * `content_type: 'code'` assistant node (excluded -- content-type
 * whitelist, this story's first-cut scope), and a `content_type:
 * 'multimodal_text'` user node whose `parts` MIXES a real caption string
 * with an image-asset-pointer object (only the string is extracted, the
 * attachment reference is skipped, its binary content never read).
 */

import type { RawChatGptConversation } from '../../parseChatGptExport.js';

export const MIXED_CONTENT_TYPE_CONVERSATION: RawChatGptConversation = {
  title: 'Synthetic fixture: tool role, code block, and an image attachment',
  create_time: 1769300000,
  update_time: 1769300100,
  conversation_id: 'fixture-mixed-content-type-conversation-0001',
  current_node: 'node-5-assistant-final',
  mapping: {
    'node-0-root': {
      id: 'node-0-root',
      message: null,
      parent: null,
      children: ['node-1-user-image'],
    },
    // multimodal_text: a real caption string MIXED with an image-asset-
    // pointer object. Only the caption string is extracted.
    'node-1-user-image': {
      id: 'node-1-user-image',
      message: {
        id: 'msg-1-user',
        author: { role: 'user', name: null },
        create_time: 1769300001,
        content: {
          content_type: 'multimodal_text',
          parts: [
            {
              content_type: 'image_asset_pointer',
              asset_pointer: 'sediment://file_FIXTURE_NEVER_READ_AS_TEXT',
              size_bytes: 12345,
              width: 100,
              height: 100,
            },
            'FIXTURE_CAPTION: what plant is this in my photo?',
          ],
        },
        metadata: {},
        status: 'finished_successfully',
      },
      parent: 'node-0-root',
      children: ['node-2-tool'],
    },
    // 'tool' role -- not one of the shared contract's three roles; excluded.
    'node-2-tool': {
      id: 'node-2-tool',
      message: {
        id: 'msg-2-tool',
        author: { role: 'tool', name: 'fixture_vision_tool' },
        create_time: 1769300005,
        content: { content_type: 'text', parts: ['FIXTURE_TOOL_OUTPUT should never appear in output (tool role excluded)'] },
        metadata: {},
        status: 'finished_successfully',
      },
      parent: 'node-1-user-image',
      children: ['node-3-assistant-code'],
    },
    // content_type 'code' -- not in the text-extraction whitelist; excluded.
    'node-3-assistant-code': {
      id: 'node-3-assistant-code',
      message: {
        id: 'msg-3-assistant',
        author: { role: 'assistant', name: null },
        create_time: 1769300010,
        content: { content_type: 'code', parts: ['FIXTURE_CODE_BLOCK should never appear in output (code content_type excluded)'] },
        metadata: {},
        status: 'finished_successfully',
      },
      parent: 'node-2-tool',
      children: ['node-4-user-followup'],
    },
    'node-4-user-followup': {
      id: 'node-4-user-followup',
      message: {
        id: 'msg-4-user',
        author: { role: 'user', name: null },
        create_time: 1769300015,
        content: { content_type: 'text', parts: ['FIXTURE_FOLLOWUP: any care tips?'] },
        metadata: {},
        status: 'finished_successfully',
      },
      parent: 'node-3-assistant-code',
      children: ['node-5-assistant-final'],
    },
    'node-5-assistant-final': {
      id: 'node-5-assistant-final',
      message: {
        id: 'msg-5-assistant',
        author: { role: 'assistant', name: null },
        create_time: 1769300020,
        content: { content_type: 'text', parts: ['FIXTURE_CARE_TIPS: keep it in indirect light and water weekly.'] },
        metadata: {},
        status: 'finished_successfully',
      },
      parent: 'node-4-user-followup',
      children: [],
    },
  },
};
