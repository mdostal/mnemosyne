#!/usr/bin/env node
// mnemosyne-persona-seed — one-time seed/migration script exporting the
// hardcoded TIER_CONTENT (lib/mnemosyne/layer1/tiers.ts:116-189) for the 3
// global tiers (top-orchestrator, company-director, project-orchestrator)
// into pf-06's global persona store, at a well-known default scopeId
// ("default").
//
// pf-08-seed-migration-script: design-discussion.md names the absence of
// this script "the single highest-blast-radius risk in the epic" -- without
// it, a cutover to data-driven persona content on an empty global store
// would silently regress every harness file (CLAUDE.md/AGENTS.md/GEMINI.md)
// in every repo to zero Layer 1 content until all 3 global tiers are
// re-authored from scratch by hand. getPersonaContent's
// fallback-to-TIER_CONTENT contract (pf-02/pf-07, persona.ts's
// `fallbackToTierContentWithWarning`) is a SECOND, independent layer of
// protection even if this script has a bug or simply hasn't been run yet in
// some environment (horizontal-plan.md H3.2) -- this script is the durable
// fix, the fallback is the safety net, not a substitute for it.
//
// Deliberately does NOT seed a repo-local code-architect persona into any
// checked-out repo (see persona-store-repo-local.ts, pf-01) -- that stays
// fully covered by getPersonaContent's existing fallback-to-TIER_CONTENT
// behavior until a repo explicitly authors its own (design_decisions in the
// pf-08 story YAML: a global seed script touching arbitrary git working
// trees it doesn't own would be real overreach -- repo-local content is
// git-committed per-repo by design, design-discussion.md §3a). This is a
// deliberate scope boundary: GLOBAL_TIERS below is derived from
// PERSONA_STORE_BY_TIER (persona.ts), the single source of truth for the
// two-store split, and will never include 'code-architect'.
//
// Idempotent by construction: skips (never overwrites) any scopeId file
// that already exists, so operator edits made after a first run -- or a
// second/partial run -- are never clobbered. writeGlobalPersona itself has
// no skip-if-exists logic (persona-store-global.ts is a generic upsert
// store used by every caller, e.g. a future wizard editing an existing
// persona on purpose) -- this script's own existsSync guard, checked BEFORE
// writeGlobalPersona is ever called, is what makes THIS operation
// specifically idempotent.
//
// Usage: mnemosyne-persona-seed.mjs [--root <path>] [--scope-id <id>]
//
//   --root PATH       overrides persona-store-global.ts's
//                      DEFAULT_GLOBAL_PERSONA_ROOT (~/.mnemosyne/personas)
//                      -- exists purely so tests can point this at a temp
//                      directory instead of the real $HOME, mirroring the
//                      `root` parameter persona-store-global.ts's own
//                      functions already accept.
//   --scope-id ID      overrides the well-known default scopeId ("default")
//                      every global tier is seeded at. Not expected to be
//                      used in normal operation -- "default" IS the
//                      contract pf-02/pf-07's fallback dispatch is written
//                      against (that's what makes it a predictable cutover
//                      target rather than an ambiguous scopeId scheme) --
//                      present for flexibility/testing only.
//
// Must be launched via tsx, not plain node -- imports lib/mnemosyne/layer1/
// *.ts directly (mirrors bin/mnemosyne-persona.mjs's own doc comment for
// the same repo-wide constraint: tsconfig.json's `noEmit: true` means there
// is no build step to import a .ts module any other way). See bin/mnemosyne
// for the dispatcher-wiring convention a future CLI subcommand (pf-09)
// would use to invoke this.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PERSONA_STORE_BY_TIER } from "../lib/mnemosyne/layer1/persona.ts";
import {
  DEFAULT_GLOBAL_PERSONA_ROOT,
  globalPersonaPath,
  writeGlobalPersona,
} from "../lib/mnemosyne/layer1/persona-store-global.ts";
import { TIER_CONTENT, TIERS } from "../lib/mnemosyne/layer1/tiers.ts";

/** The well-known default scopeId every global tier is seeded at (pf-08 design decision). */
export const DEFAULT_SEED_SCOPE_ID = "default";

/**
 * The tiers this script seeds -- derived from PERSONA_STORE_BY_TIER
 * (persona.ts), the single source of truth for the global/repo-local store
 * split, rather than a second, independently-maintained list that could
 * drift from it. Today this is exactly top-orchestrator, company-director,
 * project-orchestrator, in TIERS order -- and will NEVER include
 * 'code-architect', which is the repo-local tier this script deliberately
 * never touches (see doc comment above).
 */
export const GLOBAL_TIERS = TIERS.filter((t) => PERSONA_STORE_BY_TIER[t] === "global");

export function parseArgs(argv) {
  const args = { root: undefined, scopeId: DEFAULT_SEED_SCOPE_ID };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") args.root = argv[++i];
    else if (a === "--scope-id") args.scopeId = argv[++i];
  }
  return args;
}

/**
 * Builds the persona candidate writeGlobalPersona expects for one global
 * tier's hardcoded TIER_CONTENT entry -- structurally TierContent MINUS
 * mandateSections (persona.ts's Persona type; assertValidPersona rejects
 * mere presence of that key, since it is never author-storable -- see
 * tiers.ts's own doc comment on mandateSections for why). mandateSections
 * is deliberately dropped here, not carried through: it gets re-injected at
 * RENDER time by getPersonaContent (persona.ts's `reinjectMandateSections`),
 * the same shared, code-owned MANDATE_SECTIONS constant every render path
 * uses -- never a per-persona, per-scope copy that could drift.
 */
export function tierContentToPersonaCandidate(tier, scopeId) {
  const content = TIER_CONTENT[tier];
  return {
    tier: content.tier,
    scopeId,
    displayName: content.displayName,
    scope: content.scope,
    sections: content.sections,
  };
}

/**
 * Seeds one global tier at `scopeId` under `root`, idempotently. Returns
 * `{tier, scopeId, filePath, skipped}` -- `skipped: true` when a file
 * already existed at that path (an operator edit, or an earlier seed run)
 * and was left completely untouched: the existsSync check runs BEFORE
 * writeGlobalPersona is ever called, so a skip touches disk not at all, not
 * even a re-write of byte-identical content (no mtime bump, nothing).
 */
export function seedOneTier(tier, scopeId, root) {
  const filePath = globalPersonaPath(tier, scopeId, root);
  if (existsSync(filePath)) {
    return { tier, scopeId, filePath, skipped: true };
  }
  const candidate = tierContentToPersonaCandidate(tier, scopeId);
  const written = writeGlobalPersona(candidate, root);
  return { tier, scopeId, filePath: written, skipped: false };
}

export async function run(argv, { log = console.log, warn = console.error } = {}) {
  const args = parseArgs(argv);
  if (!args.scopeId || args.scopeId.trim() === "") {
    warn("mnemosyne-persona-seed: --scope-id, if given, must be a non-empty string");
    return { ok: false };
  }
  const root = args.root ?? DEFAULT_GLOBAL_PERSONA_ROOT;

  const results = GLOBAL_TIERS.map((tier) => seedOneTier(tier, args.scopeId, root));

  for (const r of results) {
    if (r.skipped) {
      log(`skip  ${r.tier}/${r.scopeId} -- already exists at ${r.filePath} (not overwritten)`);
    } else {
      log(`seed  ${r.tier}/${r.scopeId} -> ${r.filePath}`);
    }
  }
  const seededCount = results.filter((r) => !r.skipped).length;
  const skippedCount = results.length - seededCount;
  log(
    `mnemosyne-persona-seed: ${seededCount} seeded, ${skippedCount} skipped (already existed), ${results.length} total.`,
  );

  return { ok: true, results };
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const { ok } = await run(process.argv.slice(2));
  process.exit(ok ? 0 : 1);
}
