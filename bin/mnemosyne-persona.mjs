#!/usr/bin/env node
// mnemosyne-persona — CLI wrapper around Layer 1's syncHarnessFile/
// syncAllHarnesses (lib/mnemosyne/layer1/sync.ts). Invoked as
// `mnemosyne persona <subcommand>` via bin/mnemosyne.
//
// pf-04-cli-persona-sync-dry-run: this is the FIRST real production
// invocation path for syncHarnessFile/syncAllHarnesses -- previously only
// exercised by the Vitest suite (lib/mnemosyne/layer1/__tests__/sync.test.ts).
// No CLI verb, no hook, no HTTP route called it for real before this file.
//
// Usage: mnemosyne persona sync --repo <path> --tier <tier> --scope-id <id> [--dry-run]
//
//   sync             the only subcommand in this slice (Slice 1) -- no
//                     `persona seed`/`persona show` yet (those need the
//                     global persona store, not built until pf-06/pf-07).
//   --repo PATH      required -- repo root whose CLAUDE.md/AGENTS.md/GEMINI.md
//                     get synced (also the repo-local persona store's root
//                     for tier=code-architect -- see persona.ts).
//   --tier TIER      required -- one of tiers.ts's TIERS. This story's own
//                     scope is code-architect, but the CLI passes any valid
//                     tier straight through to syncAllHarnesses unchanged
//                     (sync.ts already supports every tier; restricting the
//                     CLI to one value would be an arbitrary extra
//                     restriction the underlying functions don't have).
//   --scope-id ID    required -- threaded through to getPersonaContent
//                    (repo-local persona lookup for code-architect; ignored
//                    by every other tier this slice -- see sync.ts).
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

const USAGE = "usage: mnemosyne persona sync --repo <path> --tier <tier> --scope-id <id> [--dry-run]";

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
    warn(USAGE);
    return { ok: false };
  }
  if (!TIERS.includes(args.tier)) {
    warn(`mnemosyne persona sync: invalid --tier '${args.tier}'. Valid tiers: ${TIERS.join(", ")}.`);
    return { ok: false };
  }

  const repoRoot = path.resolve(args.repo);

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
