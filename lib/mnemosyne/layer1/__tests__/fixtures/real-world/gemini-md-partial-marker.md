# Gemini Notes — Kestrel Billing

Human-authored notes for Gemini CLI. This file has a stray, malformed
Mnemosyne marker below: someone once started a manual sync (or an
interrupted/killed process left it half-written), pasted in the
`mnemosyne:layer1:begin` marker, and then never added the matching
`mnemosyne:layer1:end` marker before committing. There is no closing marker
anywhere in this file. A correct sync must NOT try to "replace between
markers" here (there is no valid `end` to replace up to) — it must fall back
to append-mode and leave everything below untouched.

<!-- mnemosyne:layer1:begin — managed by Mnemosyne Layer 1 sync. Do not hand-edit between these markers: edit ~/.mnemosyne/level0-rules.md (Level 0) or lib/mnemosyne/layer1/tiers.ts (tier content) instead, then re-run the sync. -->

This paragraph looks like it might have been managed-block content once,
but since the closing marker never made it into the file, it is, as far as
any sync tool can tell, just more human-authored prose. It must survive a
sync untouched, exactly where it is.

## Notes added after the stray marker

- These notes were added later by a human, after the stray begin marker
  above. They must also survive untouched.
- If a sync run ever corrupts or truncates this section, that's a bug in
  `spliceManagedBlock`'s partial-marker fallback path, not a fixture
  problem.
