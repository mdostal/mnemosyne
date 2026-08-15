#!/usr/bin/env node
// mnemosyne-persona — CLI wrapper around Layer 1's syncHarnessFile/
// syncAllHarnesses (lib/mnemosyne/layer1/sync.ts) and, as of pf-09, pf-08's
// global-tier seed/migration script. Invoked as `mnemosyne persona
// <subcommand>` via bin/mnemosyne.
//
// pf-04-cli-persona-sync-dry-run: this is the FIRST real production
// invocation path for syncHarnessFile/syncAllHarnesses -- previously only
// exercised by the Vitest suite (lib/mnemosyne/layer1/__tests__/sync.test.ts).
// No CLI verb, no hook, no HTTP route called it for real before this file.
//
// pf-09-cli-persona-seed-and-global-sync: adds the `seed` subcommand (thin
// wiring around bin/mnemosyne-persona-seed.mjs's own `run`, pf-08 -- no
// logic duplicated here) and confirms/documents that `sync` already works
// for the 3 global tiers (top-orchestrator/company-director/
// project-orchestrator), since sync.ts + persona.ts's getPersonaContent
// (pf-06/pf-07) were already tier-generic. The one real gap this story
// closes for `sync` is messaging, not behavior: nothing previously told an
// operator that a global tier's CONTENT comes from the global persona store
// (~/.mnemosyne/personas), never from --repo, even though --repo is still
// required as the harness-file WRITE target for every tier including the 3
// global ones (design_decisions in pf-09's story YAML).
//
// Usage: mnemosyne persona sync --repo <path> --tier <tier> --scope-id <id> [--dry-run]
//        mnemosyne persona seed [--root <path>] [--scope-id <id>]
//        mnemosyne persona --help
//
//   sync             writes tier content into a target repo's harness files.
//   --repo PATH      required for EVERY tier, including the 3 global ones --
//                     it is always the write target: the repo root whose
//                     CLAUDE.md/AGENTS.md/GEMINI.md get synced. For
//                     tier=code-architect, --repo doubles as the repo-local
//                     persona store's root too (see persona.ts), so it is
//                     ALSO the content source there. For the 3 global tiers
//                     (top-orchestrator/company-director/project-orchestrator)
//                     it is ONLY the write target -- content for those comes
//                     from the global persona store (~/.mnemosyne/personas,
//                     persona-store-global.ts), never from anything inside
//                     --repo. Do not read "--repo required" as "content is
//                     repo-scoped" for a global tier -- it is not.
//   --tier TIER      required -- one of tiers.ts's TIERS. The CLI passes any
//                     valid tier straight through to syncAllHarnesses
//                     unchanged (sync.ts already supports every tier;
//                     restricting the CLI to a subset would be an arbitrary
//                     extra restriction the underlying functions don't have).
//   --scope-id ID    required -- threaded through to getPersonaContent.
//                    Repo-local persona lookup (under --repo) for
//                    code-architect; global persona store lookup (under
//                    ~/.mnemosyne/personas, NOT under --repo) for the 3
//                    global tiers -- see persona.ts's dispatch.
//   --dry-run        computes the would-be managed-block diff in memory via
//                     sync.ts's buildManagedBody + block.ts's
//                     spliceManagedBlock and prints it. NEVER calls
//                     syncHarnessFile/syncAllHarnesses or any fs write
//                     function in this branch -- not even write-then-revert
//                     (horizontal-plan.md H6.2: avoids any window where an
//                     interrupted process could leave a real write behind).
//                     Zero filesystem writes, provably: the only fs calls in
//                     the dry-run branch below are existsSync/readFileSync.
//
//   seed             invokes pf-08's bin/mnemosyne-persona-seed.mjs to seed
//                     the 3 global tiers into the global persona store at
//                     the well-known "default" scopeId, reporting which
//                     tiers were newly seeded vs. already present. Pure
//                     pass-through of argv/log/warn to that script's own
//                     `run` -- no re-implementation of its idempotency or
//                     reporting logic here.
//   --root PATH      (seed only) overrides the global persona store's root
//                     -- see mnemosyne-persona-seed.mjs.
//   --scope-id ID    (seed only) overrides the "default" seed scopeId --
//                     see mnemosyne-persona-seed.mjs; not required.
//
// Must be launched via `node_modules/.bin/tsx`, not plain `node` (see
// bin/mnemosyne's dispatcher for this verb). Unlike bin/mnemosyne-reindex.mjs
// (a thin HTTP client with zero TypeScript imports), this file imports
// lib/mnemosyne/layer1/*.ts directly -- a plain `node bin/mnemosyne-persona.mjs`
// process cannot import a .ts module (tsconfig.json's `noEmit: true`, no
// build step configured for any bin/ script; see bin/graphify-bridge.mjs's
// doc comment for the same repo-wide constraint, documented there for the
// MCP surface).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildManagedBody, syncAllHarnesses } from "../lib/mnemosyne/layer1/sync.ts";
import { spliceManagedBlock } from "../lib/mnemosyne/layer1/block.ts";
import { HARNESS_TARGETS } from "../lib/mnemosyne/layer1/harness.ts";
import { DEFAULT_LEVEL0_PATH, readLevel0Content } from "../lib/mnemosyne/layer1/level0.ts";
import { TIERS } from "../lib/mnemosyne/layer1/tiers.ts";
import { PERSONA_STORE_BY_TIER } from "../lib/mnemosyne/layer1/persona.ts";
import { run as runPersonaSeed } from "./mnemosyne-persona-seed.mjs";

const USAGE_SYNC = [
  "usage: mnemosyne persona sync --repo <path> --tier <tier> --scope-id <id> [--dry-run]",
  "  --repo is required for every tier -- it is always the harness-file WRITE TARGET.",
  "  For tier=code-architect, --repo is ALSO the content source (repo-local persona store).",
  "  For the 3 global tiers (top-orchestrator, company-director, project-orchestrator),",
  "  --repo is ONLY the write target -- content comes from the global persona store",
  "  (~/.mnemosyne/personas), never from --repo. Global-tier content is NOT repo-scoped.",
].join("\n");

const USAGE_SEED = [
  "usage: mnemosyne persona seed [--root <path>] [--scope-id <id>]",
  "  Seeds the 3 global tiers (top-orchestrator, company-director, project-orchestrator)",
  "  into the global persona store, skipping any tier already present (idempotent).",
].join("\n");

const USAGE = `${USAGE_SYNC}\n${USAGE_SEED}`;

export function parseArgs(argv) {
  const args = { subcommand: undefined, repo: undefined, tier: undefined, scopeId: undefined, dryRun: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") args.repo = argv[++i];
    else if (a === "--tier") args.tier = argv[++i];
    else if (a === "--scope-id") args.scopeId = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else positional.push(a);
  }
  args.subcommand = positional[0];
  return args;
}

/**
 * Line-level diff of two candidate file contents (either may be `null`,
 * meaning "file does not exist yet"). No external diff dependency --
 * package.json carries none, and this repo's convention (see
 * bin/graphify-bridge.mjs) is to keep bin/ scripts dependency-light. Finds
 * the common prefix/suffix runs and reports only the differing middle,
 * which is accurate (every changed line is shown) even though it isn't a
 * minimal (LCS) diff.
 */
export function formatDiff(beforeText, afterText) {
  const before = beforeText === null ? [] : beforeText.split("\n");
  const after = afterText === null ? [] : afterText.split("\n");

  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }

  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);

  const lines = [];
  if (prefix > 0) lines.push(`    … ${prefix} unchanged line(s) …`);
  for (const line of removed) lines.push(`  - ${line}`);
  for (const line of added) lines.push(`  + ${line}`);
  if (suffix > 0) lines.push(`    … ${suffix} unchanged line(s) …`);
  if (lines.length === 0) lines.push("    (no change)");
  return lines.join("\n");
}

/**
 * Computes the dry-run preview for every harness target under `repoRoot`.
 * Read-only by construction: the only fs calls anywhere in this function
 * (and everything it calls -- buildManagedBody/getPersonaContent/
 * spliceManagedBlock) are `existsSync`/`readFileSync`. There is no
 * `writeFileSync`/`mkdirSync` call reachable from this function at all --
 * NOT "the real write path, called then reverted."
 */
function computeDryRunPreview(repoRoot, tier, scopeId, level0Path) {
  const level0Content = readLevel0Content(level0Path);
  const managedBody = buildManagedBody(tier, scopeId, repoRoot, level0Content);

  return HARNESS_TARGETS.map((target) => {
    const targetFilePath = path.join(repoRoot, target.fileName);
    const existingContent = existsSync(targetFilePath) ? readFileSync(targetFilePath, "utf8") : null;
    const nextContent = spliceManagedBlock(existingContent, managedBody);
    return {
      targetFilePath,
      harness: target.id,
      tier,
      created: existingContent === null,
      existingContent,
      nextContent,
    };
  });
}

async function runSync(args, { log, warn }) {
  if (!args.repo || !args.tier || !args.scopeId) {
    warn("mnemosyne persona sync: --repo, --tier, and --scope-id are all required");
    warn(USAGE_SYNC);
    return { ok: false };
  }
  if (!TIERS.includes(args.tier)) {
    warn(`mnemosyne persona sync: invalid --tier '${args.tier}'. Valid tiers: ${TIERS.join(", ")}.`);
    return { ok: false };
  }

  const repoRoot = path.resolve(args.repo);

  // pf-09: for the 3 global tiers, --repo is only the harness-file write target -- content
  // resolution happens against the global persona store, never against anything inside --repo.
  // Stated explicitly here (not just in --help) so a real run's own output can't be misread as
  // "this tier's content lives in --repo."
  if (PERSONA_STORE_BY_TIER[args.tier] === "global") {
    log(
      `mnemosyne persona sync: tier '${args.tier}' is a global tier -- its content comes from the ` +
        "global persona store (~/.mnemosyne/personas), not from --repo. --repo is only used as the " +
        "write target for this repo's harness files below.",
    );
  }

  if (args.dryRun) {
    let results;
    try {
      results = computeDryRunPreview(repoRoot, args.tier, args.scopeId, DEFAULT_LEVEL0_PATH);
    } catch (e) {
      warn(`mnemosyne persona sync --dry-run: ${e.message}`);
      return { ok: false };
    }

    for (const r of results) {
      log(`--- ${r.targetFilePath} (${r.harness}) ${r.created ? "[would create]" : "[would update]"} ---`);
      log(formatDiff(r.existingContent, r.nextContent));
    }
    log(`mnemosyne persona sync --dry-run: computed ${results.length} preview(s), zero filesystem writes.`);
    return { ok: true, dryRun: true, results };
  }

  let results;
  try {
    results = syncAllHarnesses(repoRoot, args.tier, args.scopeId);
  } catch (e) {
    warn(`mnemosyne persona sync: ${e.message}`);
    return { ok: false };
  }

  for (const r of results) {
    log(`${r.created ? "created" : "updated"} ${r.filePath} (${r.harness}, tier=${r.tier})`);
  }
  return { ok: true, results };
}

export async function run(argv, { log = console.log, warn = console.error } = {}) {
  if (argv[0] === "--help" || argv[0] === "-h") {
    log(USAGE);
    return { ok: true };
  }

  if (argv[0] === "seed") {
    // Pure pass-through to pf-08's own run() (bin/mnemosyne-persona-seed.mjs) -- that script owns
    // its own arg parsing (--root/--scope-id) and its own reporting of which of the 3 global tiers
    // were newly seeded vs. already present. Nothing about that logic is reimplemented here.
    return runPersonaSeed(argv.slice(1), { log, warn });
  }

  const args = parseArgs(argv);
  if (args.subcommand !== "sync") {
    warn(`mnemosyne persona: unknown or missing subcommand '${args.subcommand ?? ""}'`);
    warn(USAGE);
    return { ok: false };
  }
  return runSync(args, { log, warn });
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const { ok } = await run(process.argv.slice(2));
  process.exit(ok ? 0 : 1);
}
