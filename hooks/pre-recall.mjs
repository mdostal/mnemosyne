#!/usr/bin/env node
// pre-recall.mjs — THE PRE-HOOK. Loads relevant memory into an agent's context
// BEFORE it works a ticket. Built on the Mnemosyne service (swarm-memory/Qdrant).
//
// Designed for Claude Code's `UserPromptSubmit` hook contract, but shape-tolerant
// so it also works from plugin-hive step wiring or a plain pipe:
//
//   stdin JSON (any of):
//     { "prompt": "..." }                     # Claude Code UserPromptSubmit
//     { "query": "...", "scope": "att", "role": "developer", "cwd": "..." }
//     { "task_description": "...", "ticket": "PAN-123" }
//
//   stdout: Claude Code hook JSON that injects context:
//     {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<Prior Memory block>"}}
//
// Resilience contract: this hook NEVER blocks the agent loop. Any failure ->
// exit 0 with no injected context. A memory miss is not a ticket failure.

import { recall, grep, MNEMOSYNE_URL } from "./lib/mnemo-client.mjs";
import { resolveScope } from "./lib/scope.mjs";
import { formatPriorMemory, mergeResults } from "./lib/format.mjs";

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    if (process.stdin.isTTY) return resolve("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(buf));
    setTimeout(() => resolve(buf), 5000); // never hang the loop
  });
}

function pickQuery(input) {
  return (
    input.query ||
    input.prompt ||
    input.task_description ||
    input.task ||
    input.text ||
    ""
  );
}

function emit(additionalContext) {
  // Claude Code UserPromptSubmit contract: additionalContext is prepended.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext,
      },
    })
  );
}

async function main() {
  let input = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) input = JSON.parse(raw);
  } catch {
    // non-JSON stdin -> treat the whole thing as the query
    input = {};
  }

  const query = String(pickQuery(input)).trim();
  if (!query) {
    // nothing to recall on; stay silent, don't break the loop
    process.exit(0);
  }

  const { scope, escalate, role, reason } = resolveScope(input);

  const hits = Number(input.hits || process.env.MNEMOSYNE_HITS || 5);

  // HYBRID recall: semantic (concepts) + keyword (exact IDENTIFIERS only).
  // Semantic owns the natural-language query. Keyword grep runs only on explicit
  // identifiers (ticket / story ids, or short token-like queries) — the exact
  // strings embeddings do NOT encode — giving DETERMINISTIC per-ticket recall.
  // Keyword-exact hits merge FIRST so a definite identifier match surfaces at top.
  const semantic = await recall(query, scope, { hits, escalate });

  const identifiers = [];
  if (input.ticket) identifiers.push(String(input.ticket));
  if (input.story && input.story !== input.ticket) identifiers.push(String(input.story));
  // a bare token-like query (single word, has a digit/dash, no spaces) is itself
  // an identifier worth an exact lookup.
  if (!identifiers.length && /^[\w./-]{6,}$/.test(query) && /[\d-]/.test(query)) {
    identifiers.push(query);
  }
  const kwResults = [];
  for (const id of identifiers) {
    kwResults.push(await grep(id, scope, { hits: 3, escalate }));
  }
  // keyword first so exact-identifier chunks win dedup + sort above semantic.
  const result = mergeResults(...kwResults, semantic);
  result.total_hits =
    (semantic.total_hits || 0) + kwResults.reduce((n, r) => n + (r.total_hits || 0), 0);
  result.via = semantic.via;

  // If memory is entirely unreachable, stay silent (resilience) rather than
  // injecting an error into the agent's context.
  if (semantic.via === "none" && kwResults.every((r) => r.via === "none")) {
    process.stderr.write(
      `[pre-recall] memory unreachable (${semantic.service_error || ""}); skipping injection\n`
    );
    process.exit(0);
  }

  const block = formatPriorMemory(result, {
    scope,
    escalate,
    role,
    url: MNEMOSYNE_URL,
    max: Number(input.max || 6),
  });

  const header =
    `<!-- mnemosyne pre-recall: scope=${scope} role=${role} escalate=${escalate} ` +
    `via=${result.via} total_hits=${result.total_hits ?? 0} reason="${reason}" ` +
    `ticket=${input.ticket || input.story || "-"} -->`;

  emit(`${header}\n${block}`);
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`[pre-recall] error: ${e.message || e}\n`);
  process.exit(0); // never break the loop
});
