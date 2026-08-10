#!/usr/bin/env node
// post-remember.mjs — THE POST-HOOK. Stores what an agent learned/did AFTER it
// works a ticket. STATUS-AWARE: in-progress | reviewed | full-send (Mathew's
// spec: "a final hook to update + mark status-aware").
//
// Designed for Claude Code's `Stop` / `SubagentStop` hook contract, but
// shape-tolerant so it also works from plugin-hive step wiring or a plain pipe:
//
//   stdin JSON (any of):
//     { "transcript_path": "/…/session.jsonl" }        # Claude Code Stop
//     { "text": "what I learned…", "scope": "att", "status": "reviewed" }
//     { "summary": "…", "ticket": "PAN-123", "status": "full-send" }
//
//   stdout: JSON summary of the write-back (also useful for logs).
//
// Resilience contract: NEVER blocks. On any failure -> exit 0.
// Never wipes the corpus — remember() is additive (--no-prune upsert).

import { readFile } from "node:fs/promises";
import { remember } from "./lib/mnemo-client.mjs";
import { resolveScope } from "./lib/scope.mjs";

const STATUSES = ["in-progress", "reviewed", "full-send"];

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    if (process.stdin.isTTY) return resolve("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(buf));
    setTimeout(() => resolve(buf), 5000);
  });
}

function normStatus(s) {
  const v = String(s || process.env.MNEMOSYNE_STATUS || "in-progress").toLowerCase();
  return STATUSES.includes(v) ? v : "in-progress";
}

// Minimal transcript extraction: pull the last assistant text message from a
// Claude Code JSONL transcript. Kept deliberately small for v1 — richer
// summarization (what changed, decisions) is a follow-on layer.
async function textFromTranscript(p) {
  try {
    const raw = await readFile(p, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      let obj;
      try { obj = JSON.parse(lines[i]); } catch { continue; }
      const msg = obj.message || obj;
      if (msg && msg.role === "assistant") {
        const c = msg.content;
        if (typeof c === "string") return c;
        if (Array.isArray(c)) {
          const t = c.filter((b) => b && b.type === "text").map((b) => b.text).join("\n").trim();
          if (t) return t;
        }
      }
    }
  } catch {
    /* fall through */
  }
  return "";
}

function pickText(input) {
  return input.text || input.summary || input.learned || input.note || "";
}

async function main() {
  let input = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) input = JSON.parse(raw);
  } catch {
    input = {};
  }

  let text = String(pickText(input)).trim();
  if (!text && input.transcript_path) {
    text = (await textFromTranscript(input.transcript_path)).trim();
  }
  if (!text) {
    process.stderr.write("[post-remember] nothing to store (no text/summary/transcript); skipping\n");
    process.exit(0);
  }

  const status = normStatus(input.status);
  const { scope, role } = resolveScope(input);
  const ticket = input.ticket || input.story || input.session_id || "-";

  // STATUS-aware framing: the stored note carries its lifecycle marker so a
  // later recall can tell in-progress notes from full-send truth.
  const stamped =
    `STATUS: ${status}\n` +
    `TICKET: ${ticket}\n` +
    `ROLE: ${role}\n` +
    `WHEN: ${new Date().toISOString()}\n\n` +
    text;

  const tag = `${ticket !== "-" ? ticket + "-" : ""}${status}`;
  const result = await remember(stamped, scope, { tag });

  const out = {
    ok: !!result.remembered,
    status,
    scope,
    role,
    ticket,
    via: result.via,
    collection: result.collection || null,
    file: result.file || null,
    chunks_upserted: result.chunks_upserted ?? null,
    error: result.remembered ? undefined : (result.service_error || result.cli_error),
  };
  process.stdout.write(JSON.stringify(out));
  process.stderr.write(
    `[post-remember] ${out.ok ? "stored" : "FAILED"} status=${status} scope=${scope} via=${out.via} ticket=${ticket}\n`
  );
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`[post-remember] error: ${e.message || e}\n`);
  process.exit(0);
});
