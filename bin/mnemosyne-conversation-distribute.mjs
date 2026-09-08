#!/usr/bin/env node
// bin/mnemosyne-conversation-distribute.mjs — cm-13-intake-distribution's
// missing CLI wrapper (epic: mnemosyne-conversation-memory).
//
// cm-08 (pilot) and cm-16 (triage-review) both got real CLI entry points;
// cm-13's own `distributeIntakeEntries()` never did, leaving no way for an
// operator to actually run distribution outside a test. This file
// introduces ZERO new distribution logic — it wires the ALREADY-BUILT
// `distributeIntakeEntries()` (lib/mnemosyne/conversation-memory/
// distributeIntakeEntries.ts) to the same real `MnemosyneClient` the pilot
// CLI already uses and the same real `makePythonScrollPointsFn()` the
// triage-review CLI already uses (imported, not re-implemented).
//
// Usage:
//   mnemosyne-conversation-distribute --json
//
// Refuses to do anything beyond what distributeIntakeEntries() itself does:
// every confirmed intake candidate (or one with no candidate at all) gets
// written to its resolved destination scope (a confirmed real scope, or
// 'meta' by default) via the same additive-only ingestDocument()/
// remember() primitive cm-07 already uses, then marked distributed via a
// brand-new marker point in the intake collection. Never mutates or
// deletes the original intake point.

import { distributeIntakeEntries } from '../lib/mnemosyne/conversation-memory/distributeIntakeEntries.ts';
import { MnemosyneClient } from '../lib/mnemosyne/client.ts';
import { makePythonScrollPointsFn } from './mnemosyne-conversation-triage-review.mjs';

export async function runDistribute({
  client = new MnemosyneClient({ rootDirectory: process.env.MNEMOSYNE_ROOT_DIR || process.cwd() }),
  scrollPoints = makePythonScrollPointsFn(),
} = {}) {
  return distributeIntakeEntries({ client, scrollPoints });
}

async function main(argv) {
  const json = argv.includes('--json');
  try {
    const result = await runDistribute();
    if (json) {
      console.log(JSON.stringify({ ok: true, result }, null, 2));
    } else {
      console.log(`distributed: ${result.distributed.length}, skipped: ${result.skipped.length}`);
      for (const d of result.distributed) {
        console.log(`  [${d.ok ? 'ok' : 'FAILED'}] entry=${d.entryId} cluster=${d.clusterId} -> ${d.destinationScope}`);
      }
      for (const s of result.skipped) {
        console.log(`  [skipped:${s.reason}] entry=${s.entryId}`);
      }
    }
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (json) {
      console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(`error: ${message}`);
    }
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
