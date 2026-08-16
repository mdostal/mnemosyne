#!/usr/bin/env node
// fake-swarm-memory-pu03.mjs — pu-03-draft-persona-routes.
//
// A SEPARATE test double from test/fixtures/fake-swarm-memory.mjs and
// fake-swarm-memory-kw03.mjs (same "own dedicated fixture per feature"
// convention lib/mnemosyne/layer1/__tests__/fixtures/fake-swarm-memory-pw13.mjs's
// own doc comment establishes) -- dedicated to pu-03's own proof that the
// HTTP approve route's remember()-firing lands for real and genuinely does
// NOT fire during the pending-review window.
//
// `config` provisions the same four persona-* scope lanes pw-09's
// PERSONA_REMEMBER_SCOPE_BY_TIER (persona.ts) produces -- mirrors
// fake-swarm-memory-pw13.mjs's config exactly, since resolveRememberScope()
// is unchanged by this story.
//
// `index`/`recall`/`grep` are STATEFUL, keyed off FAKE_SWARM_PU03_INDEX_STORE
// (mirrors the base fake-swarm-memory.mjs's own FAKE_SWARM_INDEX_STORE
// mechanism, la-05-recall-status-filtering): `index` records the REAL note
// file path engine.mjs's remember() was asked to index, plus that file's
// REAL on-disk content, into this JSON store. `recall`/`grep` search the
// store's recorded content for the query as a literal substring and only
// return a hit when a real match exists.
//
// This is deliberately NOT a static stub that would return "no hits"
// regardless of whether anything was ever indexed -- a query run BEFORE any
// remember() call genuinely finds nothing (because nothing is in the store
// yet), and the SAME query run AFTER a real remember() call genuinely finds
// it (because `index` really recorded it) -- so http-api.mjs's "no
// remember() call fires during the pending-review window" proof is a real
// behavioral proof, not a response-field trust exercise.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [, , cmd, ...args] = process.argv;

const SCOPES = {
  "persona-top-orchestrator": "persona_top_orchestrator_pu03_test",
  "persona-company-director": "persona_company_director_pu03_test",
  "persona-project-orchestrator": "persona_project_orchestrator_pu03_test",
  "persona-code-architect": "persona_code_architect_pu03_test",
};

function storePath() {
  return process.env.FAKE_SWARM_PU03_INDEX_STORE;
}

function readStore() {
  const store = storePath();
  if (!store || !existsSync(store)) return [];
  try {
    return JSON.parse(readFileSync(store, "utf8"));
  } catch {
    return [];
  }
}

function writeStore(entries) {
  const store = storePath();
  if (store) {
    writeFileSync(store, JSON.stringify(entries), "utf8");
  }
}

function scopeForCollection(collection) {
  const found = Object.entries(SCOPES).find(([, c]) => c === collection);
  return found ? found[0] : "persona-top-orchestrator";
}

if (cmd === "config") {
  process.stdout.write(
    JSON.stringify({
      scopes: SCOPES,
      ladder: {},
      default_scope: "persona-top-orchestrator",
      fallback_collection: "persona_pu03_fallback",
    })
  );
  process.exit(0);
}

if (cmd === "index") {
  // engine.mjs remember() invokes: index <collection> --no-prune <file>
  const collection = args[0];
  const file = args[args.length - 1];
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    text = "";
  }
  const entries = readStore().filter((e) => e.full_path !== file);
  entries.push({ full_path: file, collection, text });
  writeStore(entries);
  process.stdout.write("indexed 1 file(s), upserted 3 chunks into test_collection\n");
  process.exit(0);
}

if (cmd === "recall") {
  const query = args[0] || "";
  const entries = readStore().filter((e) => e.text.includes(query));
  const hits = entries.map((e) => ({
    text: e.text,
    score: 0.91,
    full_path: e.full_path,
    source: e.full_path,
  }));
  const collection = entries[0]?.collection || "persona_pu03_fallback";
  process.stdout.write(
    JSON.stringify({
      query,
      total_hits: hits.length,
      scopes: [{ scope: scopeForCollection(collection), collection, hits }],
    })
  );
  process.exit(0);
}

if (cmd === "grep") {
  const query = args[0] || "";
  const entries = readStore().filter((e) => e.text.includes(query));
  const hits = entries.map((e) => ({
    text: e.text,
    full_path: e.full_path,
    source: e.full_path,
  }));
  const collection = entries[0]?.collection || "persona_pu03_fallback";
  process.stdout.write(JSON.stringify([{ scope: scopeForCollection(collection), collection, hits }]));
  process.exit(0);
}

if (cmd === "graph") {
  // CodeGraphLayer/recall()'s parallel graph calls -- harmless empty arrays,
  // same convention as fake-swarm-memory-kw03.mjs's own passthrough.
  process.stdout.write(JSON.stringify([]));
  process.exit(0);
}

process.stderr.write(`fake-swarm-memory-pu03: unknown command ${cmd}\n`);
process.exit(2);
