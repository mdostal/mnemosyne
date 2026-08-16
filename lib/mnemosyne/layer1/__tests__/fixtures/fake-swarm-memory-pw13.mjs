#!/usr/bin/env node
// fake-swarm-memory-pw13.mjs — pw-13-crawl-and-feed-wiring.
//
// A test double for the `swarm-memory` CLI, dedicated to this story's own
// tests -- a SEPARATE fixture from test/fixtures/fake-swarm-memory.mjs (that
// one's `config` command hardcodes only `personal`/`top`, so it can't
// resolve the four `persona-*` scopes pw-09's PERSONA_REMEMBER_SCOPE_BY_TIER
// actually produces; same "own dedicated fixture per feature" convention
// test/fixtures/fake-swarm-memory-kw03.mjs already establishes for kw-03).
//
// `config` returns collection mappings for all four real persona-*
// scope names (persona.ts's PERSONA_REMEMBER_SCOPE_BY_TIER values) so a real
// engine.mjs remember() call scoped via resolveRememberScope() actually
// resolves to a known collection here, instead of hitting the real
// swarm-memory config.toml's "unknown scope" 400 (design-discussion.md §8's
// documented, accepted "known operational caveat" -- the real config.toml
// intentionally has no persona-* lanes provisioned yet).
//
// `index` always succeeds and reports "upserted 3 chunks" -- this fixture
// only needs to prove the real HTTP -> engine.mjs -> CLI-subprocess -> note-
// file-on-disk pipeline actually fires end-to-end for this story; failure-
// mode coverage of remember()'s own write-through contract already lives in
// test/write-through.mjs against a different fixture.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const [, , cmd, ...args] = process.argv;

const SCOPES = {
  "persona-top-orchestrator": "persona_top_orchestrator_pw13_test",
  "persona-company-director": "persona_company_director_pw13_test",
  "persona-project-orchestrator": "persona_project_orchestrator_pw13_test",
  "persona-code-architect": "persona_code_architect_pw13_test",
};

if (cmd === "config") {
  process.stdout.write(
    JSON.stringify({
      scopes: SCOPES,
      ladder: {},
      default_scope: "persona-top-orchestrator",
      fallback_collection: "persona_pw13_fallback",
    })
  );
  process.exit(0);
}

if (cmd === "index") {
  // FAKE_SWARM_PW13_INDEX_LOG (optional): appends one JSON line per `index`
  // invocation {collection, file} so a test can independently confirm which
  // collection/file this fixture was actually asked to index -- not just
  // that engine.mjs's own return value said so.
  const logPath = process.env.FAKE_SWARM_PW13_INDEX_LOG;
  if (logPath) {
    const collection = args[0];
    const file = args[args.length - 1];
    const prior = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    writeFileSync(logPath, prior + JSON.stringify({ collection, file }) + "\n", "utf8");
  }
  process.stdout.write("indexed 1 file(s), upserted 3 chunks into test_collection\n");
  process.exit(0);
}

process.stderr.write(`fake-swarm-memory-pw13: unknown command ${cmd}\n`);
process.exit(2);
