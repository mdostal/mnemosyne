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
//   create           pw-05-cli-persona-create: closes Epic 1's one
//                     deliberately-deferred gap -- writeGlobalPersona/
//                     writeRepoLocalPersona (persona-store-global.ts /
//                     persona-store-repo-local.ts) were real, tested,
//                     TS-only functions with zero CLI/MCP/skill-harness
//                     wrapper anywhere before this verb. A THIN wrapper: the
//                     whole persona candidate (tier, scopeId, displayName,
//                     scope, sections, optional parentRefs) lives in
//                     --file's YAML document, parsed and passed through
//                     UNCHANGED (no field picking, no merging) to whichever
//                     store function is called -- so a smuggled
//                     `mandateSections` key is preserved all the way to
//                     assertValidPersona's own guard (persona.ts) instead of
//                     being silently dropped by this CLI layer first.
//   --file PATH      required -- path to a YAML file containing the FULL
//                     persona candidate. Chosen over a flag-per-field design
//                     (e.g. --display-name/--section) because `sections`
//                     (and optional `parentRefs`) are arrays of
//                     {heading, body} objects with no clean flat-flag
//                     encoding, and because this is exactly the same YAML
//                     shape persona-store-{global,repo-local}.ts already
//                     persist to disk (their own `stringify(candidate)`) --
//                     one document shape for both directions, not a second,
//                     CLI-specific encoding.
//   --repo PATH      when given, routes the write to the REPO-LOCAL store
//                     (writeRepoLocalPersona(--repo, candidate)) -- required
//                     for a code-architect candidate, since that store's
//                     root IS the target repo. This is the CLI's OWN routing
//                     decision, independent of whatever candidate.tier
//                     actually says: if the candidate's tier doesn't belong
//                     in the store this routes to, writeRepoLocalPersona's
//                     own assertRepoLocalTier guard rejects it before any
//                     disk write -- not a second, CLI-level copy of that
//                     check.
//   --root PATH      (create only, and only when --repo is NOT given)
//                     overrides the global persona store's root -- mirrors
//                     `seed`'s own --root, primarily for test isolation.
//                     Without --repo, create routes to the GLOBAL store
//                     (writeGlobalPersona(candidate, --root ?? default)); if
//                     candidate.tier is actually code-architect, this is
//                     exactly the "a code-architect candidate routed at the
//                     global store" tier/store-mismatch case --
//                     writeGlobalPersona's own assertGlobalTier guard
//                     rejects it before any disk write.
//
//   resolve-remember-scope --tier <tier> --scope-id <id>
//                     pw-13-crawl-and-feed-wiring: the ONE real TS/JS-boundary
//                     crossing point for skills/mnemosyne-persona-interview/
//                     persona-remember.mjs (a plain ESM module, same
//                     no-build-step constraint as this whole file -- see the
//                     "Must be launched via tsx" note below) to call pw-09's
//                     resolveRememberScope() (persona.ts) for real, never a
//                     hand-copied/reimplemented version of that mapping. Pure
//                     pass-through: prints resolveRememberScope({tier,
//                     scopeId})'s own `{scope, tag}` result as JSON, no
//                     filesystem access, no persona-store read/write.
//
//   show TIER SCOPE_ID   pf-13-cli-persona-show: the on-demand fetch surface
//                     an agent uses after following pf-12's rendered
//                     "Parent context (query up)" pointer -- prints that
//                     persona's real, current content. A THIN, READ-ONLY
//                     wrapper over pf-06's persona-store-global.ts
//                     `readGlobalPersona` -- no new store-access logic here,
//                     no fallback-to-TIER_CONTENT (that's `sync`'s/
//                     `getPersonaContent`'s behavior, not this verb's: `show`
//                     either returns the real persona or errors, it never
//                     silently substitutes hardcoded content). Positional
//                     args (TIER then SCOPE_ID), not flags -- matches this
//                     subcommand's acceptance criteria
//                     (`mnemosyne persona show project-orchestrator default`).
//                     Only valid for the 3 GLOBAL tiers (top-orchestrator/
//                     company-director/project-orchestrator) --
//                     PERSONA_STORE_BY_TIER is the single source of truth for
//                     that split (persona.ts); a code-architect scopeId is
//                     rejected with a clear error before any disk access,
//                     since that tier's content lives in the repo-local store
//                     (persona-store-repo-local.ts), which this verb does not
//                     read. Genuinely read-only: the only fs call reachable
//                     from `readGlobalPersona` is `readFileSync`
//                     (persona-store-global.ts) -- no `writeFileSync`,
//                     no `mkdirSync`, no `withLock` (locking guards
//                     read-splice-WRITE sequences, lock.ts; a bare read never
//                     takes one) anywhere in this code path. Also a LIVE read
//                     every time -- persona-store-global.ts reads fresh off
//                     disk on every call, no module-level caching -- so an
//                     edit made to a persona file between two `show` runs is
//                     reflected on the very next run, no repo-local re-sync
//                     required.
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
import { parse as parseYaml } from "yaml";
import { buildManagedBody, syncAllHarnesses } from "../lib/mnemosyne/layer1/sync.ts";
import { spliceManagedBlock } from "../lib/mnemosyne/layer1/block.ts";
import { HARNESS_TARGETS } from "../lib/mnemosyne/layer1/harness.ts";
import { DEFAULT_LEVEL0_PATH, readLevel0Content } from "../lib/mnemosyne/layer1/level0.ts";
import { TIERS } from "../lib/mnemosyne/layer1/tiers.ts";
import { PERSONA_STORE_BY_TIER, resolveRememberScope } from "../lib/mnemosyne/layer1/persona.ts";
import { readGlobalPersona, writeGlobalPersona } from "../lib/mnemosyne/layer1/persona-store-global.ts";
import { writeRepoLocalPersona } from "../lib/mnemosyne/layer1/persona-store-repo-local.ts";
import {
  disposeDraftPersona,
  readDraftPersona,
  writeDraftPersona,
} from "../lib/mnemosyne/layer1/persona-draft-store.ts";
import { run as runPersonaSeed } from "./mnemosyne-persona-seed.mjs";
// Plain ESM, not .ts -- no tsx-boundary issue importing it from here (same
// reasoning as importing ./mnemosyne-persona-seed.mjs above). `draft
// approve`'s remember()-firing reuses this real subprocess transport
// unchanged (a real `node bin/mnemosyne-skill-helper.mjs remember` call ->
// real POST /remember -> engine.mjs's remember()) -- never a hand-rolled
// fetch() or an in-process call to engine.mjs, matching persona-remember.mjs's
// own rememberInterviewSource() rigor (pw-13) and this ticket's own doc
// comment on why (`draft approve`'s remember() paragraph below).
import { fireRememberCall } from "../skills/mnemosyne-persona-interview/persona-remember.mjs";

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

const USAGE_SHOW = [
  "usage: mnemosyne persona show <tier> <scope-id>",
  "  Prints that persona's real, current content -- a read-only, live read straight off the",
  "  global persona store (~/.mnemosyne/personas). No harness file is touched or written, no",
  "  lock is taken, and nothing is cached: an edit to the persona file is reflected on the very",
  "  next `show` run, no repo-local sync required.",
  "  Only valid for the 3 global tiers (top-orchestrator, company-director, project-orchestrator)",
  "  -- code-architect personas live in the repo-local store, which this verb does not read.",
].join("\n");

const USAGE_CREATE = [
  "usage: mnemosyne persona create --file <path-to-yaml> [--repo <path>] [--root <path>]",
  "  --file is required -- a YAML document with the full persona candidate:",
  "  {tier, scopeId, displayName, scope, sections, parentRefs?}. Passed through UNCHANGED to",
  "  writeGlobalPersona/writeRepoLocalPersona, so a smuggled 'mandateSections' key is rejected by",
  "  their own guard, not silently stripped here.",
  "  --repo, when given, routes the write to the repo-local store (writeRepoLocalPersona) --",
  "  required for a code-architect candidate. Without --repo, the write routes to the global",
  "  store (writeGlobalPersona). A tier that doesn't belong in the store this routes to is",
  "  rejected before any disk write.",
  "  --root (only without --repo) overrides the global persona store's root -- mirrors seed's own",
  "  --root, primarily for test isolation.",
].join("\n");

const USAGE_RESOLVE_REMEMBER_SCOPE = [
  "usage: mnemosyne persona resolve-remember-scope --tier <tier> --scope-id <id>",
  "  Prints resolveRememberScope({tier, scopeId})'s real {scope, tag} result as JSON --",
  "  the ONE real remember()-scope mapping (persona.ts, pw-09). No filesystem access.",
].join("\n");

const USAGE_DRAFT = [
  "usage: mnemosyne persona draft propose --file <path-to-yaml> [--repo <repo>]",
  "       mnemosyne persona draft show <tier> <scope-id> [--repo <repo>]",
  "       mnemosyne persona draft approve <tier> <scope-id> [--repo <repo>]",
  "       mnemosyne persona draft discard <tier> <scope-id> [--repo <repo>]",
  "  A draft is an in-review persona candidate, held in a structurally separate store",
  "  (~/.mnemosyne/persona-drafts, persona-draft-store.ts) -- never reachable by sync/show",
  "  until a human runs `draft approve`. `draft show`'s output is always, visibly labeled",
  "  DRAFT -- never rendered indistinguishably from real `persona show` output.",
  "  propose  writes/overwrites the active draft for {tier, scope-id} via writeDraftPersona",
  "           (structural sanity only -- a valid tier, a non-empty scopeId -- full",
  "           assertValidPersona-strength validation happens only at approve time).",
  "  show     prints the active draft's content, clearly labeled DRAFT, including",
  "           proposedBy/proposedAt/sourceSummary metadata when present.",
  "  approve  commits the draft via the SAME unchanged write primitive `create` uses",
  "           (writeGlobalPersona/writeRepoLocalPersona), archives the draft (never",
  "           deletes it), and -- only when the draft carries a sourceSummary -- fires a",
  "           real remember() call scoped via resolveRememberScope(). A human-typed draft",
  "           with no sourceSummary never fires remember() (no real source material to index).",
  "  discard  archives the active draft to the discarded/ subtree (never deletes it).",
  "  --repo   required for a code-architect draft (repo-local); omit for the 3 global tiers.",
].join("\n");

const USAGE = `${USAGE_SYNC}\n${USAGE_SEED}\n${USAGE_SHOW}\n${USAGE_CREATE}\n${USAGE_RESOLVE_REMEMBER_SCOPE}\n${USAGE_DRAFT}`;

export function parseArgs(argv) {
  const args = {
    subcommand: undefined,
    repo: undefined,
    tier: undefined,
    scopeId: undefined,
    dryRun: false,
    file: undefined,
    root: undefined,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") args.repo = argv[++i];
    else if (a === "--tier") args.tier = argv[++i];
    else if (a === "--scope-id") args.scopeId = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--file") args.file = argv[++i];
    else if (a === "--root") args.root = argv[++i];
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

/**
 * Renders a persona's real content as plain text for `show`'s stdout.
 * Deliberately NOT `getPersonaContent`/`reinjectMandateSections` --
 * `mandateSections`/`parentContextSections` are render-time additions
 * `sync.ts` layers on for the harness-file managed block; `show` prints the
 * persona record itself (design_decisions: the harness-agnostic fetch
 * contract a future adapter would call), not a harness-file rendering of it.
 */
export function formatPersonaShow(persona) {
  const lines = [
    `tier: ${persona.tier}`,
    `scopeId: ${persona.scopeId}`,
    `displayName: ${persona.displayName}`,
    `scope: ${persona.scope}`,
    "",
  ];
  for (const section of persona.sections) {
    lines.push(`## ${section.heading}`, section.body, "");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

/**
 * Renders an in-review DRAFT persona's content for `draft show`'s stdout --
 * pu-04. DELIBERATELY a different rendering shape from `formatPersonaShow`
 * above (banner lines top and bottom, both containing the literal word
 * "DRAFT"), never the same field-list-with-no-banner shape a real, committed
 * `persona show` produces (design-discussion.md §4 lens 4 / this ticket's
 * own acceptance criteria: a human or another agent inspecting CLI output
 * must never mistake in-review content for committed, governing persona
 * content). Prints `proposedBy`/`proposedAt`/`sourceSummary` metadata when
 * present -- a draft may not have them yet (e.g. a bare structurally-valid
 * candidate mid-edit) -- and prints whatever `sections` exist, same section
 * rendering as `formatPersonaShow`.
 */
export function formatDraftShow(draft) {
  const lines = [
    "############################################################",
    "###  DRAFT -- IN REVIEW, NOT YET APPROVED, NOT COMMITTED  ###",
    "############################################################",
    `tier: ${draft.tier}`,
    `scopeId: ${draft.scopeId}`,
  ];
  if (draft.displayName !== undefined) lines.push(`displayName: ${draft.displayName}`);
  if (draft.scope !== undefined) lines.push(`scope: ${draft.scope}`);
  if (draft.proposedBy !== undefined) lines.push(`proposedBy: ${draft.proposedBy}`);
  if (draft.proposedAt !== undefined) lines.push(`proposedAt: ${draft.proposedAt}`);
  if (draft.sourceSummary !== undefined) lines.push(`sourceSummary: ${draft.sourceSummary}`);
  lines.push("");
  for (const section of draft.sections ?? []) {
    lines.push(`## ${section.heading}`, section.body, "");
  }
  lines.push("############################################################");
  lines.push("###  END DRAFT -- run `persona draft approve` to commit   ###");
  lines.push("############################################################");
  return lines.join("\n").replace(/\n+$/, "\n") + "\n";
}

/**
 * "buildRememberText()-shaped" summary for a DRAFT's approve-time remember()
 * call (pu-04, mirroring interview-engine.mjs's `buildRememberText(persona)`
 * header format -- tier/scopeId/displayName -- see that function's own doc
 * comment). Deliberately NOT a literal call to `buildRememberText(draft)`:
 * what is worth indexing at draft-approve time is the SOURCE MATERIAL that
 * justified the proposal (`sourceSummary`, pu-07's bounded crawl output),
 * not a restatement of the draft's own proposed sections -- the committed
 * persona record itself already fully captures those (design-discussion.md
 * §9 judgment call #9 / §3b). Only ever called when `sourceSummary` is a
 * real, non-empty string (see `runDraftApprove` below) -- this function does
 * not itself decide whether to fire, it only shapes the text once the caller
 * already knows firing is correct.
 */
function buildDraftRememberText(draft) {
  return (
    `Persona draft proposal — tier: ${draft.tier}, scopeId: ${draft.scopeId}, ` +
    `displayName: ${draft.displayName}. Source material the proposal was based on: ${draft.sourceSummary}`
  );
}

/**
 * Extracts `--repo <path>` (optional, used by every draft subcommand) from
 * `argv`, returning `{ repo, positional }` where `positional` is every
 * remaining argv entry in order -- mirrors the top-level `parseArgs`'s own
 * flag-then-positional split, scoped to just the one flag every `draft`
 * subcommand shares. `draft propose` additionally has its own `--file`
 * flag, parsed the same way by its own caller below.
 */
function parseDraftRepoArg(argv) {
  const positional = [];
  let repo;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo") repo = argv[++i];
    else positional.push(argv[i]);
  }
  return { repo, positional };
}

/**
 * `persona draft propose --file <path> [--repo <repo>]` -- pu-04. A thin
 * wrapper over pu-02's `writeDraftPersona`, mirroring `create`'s own "parse
 * --file's YAML, pass the candidate through UNCHANGED" shape exactly (see
 * `runCreate` above) -- no field picking, no re-derived structural check
 * here (that's `writeDraftPersona`'s own `assertStructurallyValidDraft`,
 * exercised unchanged). `--repo`, when given, threads `ctx.repoRoot` through
 * so a code-architect draft resolves to the repo-local draft subtree; the
 * store-level dispatch on `PERSONA_STORE_BY_TIER` happens entirely inside
 * `persona-draft-store.ts`, never re-derived here.
 */
function runDraftPropose(argv, { log, warn }) {
  const { repo, positional } = parseDraftRepoArg(argv);
  let file;
  for (let i = 0; i < positional.length; i++) {
    if (positional[i] === "--file") file = positional[++i];
  }
  if (!file) {
    warn("mnemosyne persona draft propose: --file <path-to-yaml> is required");
    warn(USAGE_DRAFT);
    return { ok: false };
  }

  const filePath = path.resolve(file);
  if (!existsSync(filePath)) {
    warn(`mnemosyne persona draft propose: no such file '${filePath}'`);
    return { ok: false };
  }

  let candidate;
  try {
    candidate = parseYaml(readFileSync(filePath, "utf8"));
  } catch (e) {
    warn(`mnemosyne persona draft propose: failed to parse --file as YAML: ${e.message}`);
    return { ok: false };
  }

  const ctx = repo ? { repoRoot: path.resolve(repo) } : {};
  let writtenPath;
  try {
    writtenPath = writeDraftPersona(candidate, ctx);
  } catch (e) {
    warn(`mnemosyne persona draft propose: ${e.message}`);
    return { ok: false };
  }

  log(`proposed draft ${candidate?.tier}/${candidate?.scopeId} -> ${writtenPath}`);
  return { ok: true, filePath: writtenPath };
}

/**
 * Shared `<tier> <scope-id> [--repo <repo>]` positional parsing for
 * `draft show`/`draft approve`/`draft discard` -- validates both are
 * present and `tier` is a real tier BEFORE any draft-store call, mirroring
 * `runShow`'s own up-front validation shape. Returns `null` (having already
 * `warn`ed) on any failure, or `{ tier, scopeId, ctx }` on success.
 */
function parseDraftIdentityArgs(argv, subcommandLabel, { warn }) {
  const { repo, positional } = parseDraftRepoArg(argv);
  const [tier, scopeId] = positional;
  if (!tier || !scopeId) {
    warn(`mnemosyne persona draft ${subcommandLabel}: <tier> and <scope-id> are both required`);
    warn(USAGE_DRAFT);
    return null;
  }
  if (!TIERS.includes(tier)) {
    warn(`mnemosyne persona draft ${subcommandLabel}: invalid tier '${tier}'. Valid tiers: ${TIERS.join(", ")}.`);
    return null;
  }
  const ctx = repo ? { repoRoot: path.resolve(repo) } : {};
  return { tier, scopeId, ctx };
}

/**
 * `persona draft show <tier> <scope-id> [--repo <repo>]` -- pu-04. Read-only
 * (`readDraftPersona`'s own `readFileSync`, no write anywhere in this path).
 * Output is ALWAYS rendered via `formatDraftShow` (banner-wrapped, labeled
 * DRAFT) -- never `formatPersonaShow`, so it can never be mistaken for real,
 * committed persona content at a glance (this ticket's own acceptance
 * criteria / design_decisions).
 */
function runDraftShow(argv, { log, warn }) {
  const parsed = parseDraftIdentityArgs(argv, "show", { warn });
  if (!parsed) return { ok: false };
  const { tier, scopeId, ctx } = parsed;

  let draft;
  try {
    draft = readDraftPersona(tier, scopeId, ctx);
  } catch (e) {
    warn(`mnemosyne persona draft show: ${e.message}`);
    return { ok: false };
  }

  log(formatDraftShow(draft));
  return { ok: true, draft };
}

/**
 * `persona draft approve <tier> <scope-id> [--repo <repo>]` -- pu-04.
 * Produces the SAME outcome pu-03's HTTP `POST /persona/draft/:tier/:scopeId/approve`
 * route produces, from the same two real write primitives `create` already
 * calls (writeGlobalPersona/writeRepoLocalPersona) -- never a second,
 * re-derived write or validation path (this ticket's own review step /
 * risks table).
 *
 * Sequence: (1) read the active draft (pu-02's readDraftPersona -- throws a
 * clear error, nothing further happens, if none exists); (2) strip
 * draft-only metadata (`proposedBy`/`proposedAt`/`sourceSummary`) so the
 * committed file is byte-for-byte what `create`/`POST /persona/:tier/:scopeId`
 * would have produced for the same candidate; (3) call the real write
 * primitive -- if it throws (assertValidPersona failure, e.g. missing
 * displayName), stop here: nothing is written, and the draft is NOT
 * archived, so a human can fix it and re-propose; (4) only once the write
 * has actually succeeded, archive the draft via `disposeDraftPersona(...,
 * 'approved')` (never delete); (5) ONLY IF the pre-strip draft carried a
 * real, non-empty `sourceSummary`, fire a real `remember()` call -- scoped
 * via `resolveRememberScope()` (persona.ts, the same resolver
 * `resolve-remember-scope`/persona-remember.mjs already use), text shaped by
 * `buildDraftRememberText` above -- through the same real
 * `fireRememberCall` subprocess transport `rememberInterviewSource()`
 * (persona-remember.mjs, pw-13) already uses, never an in-process/hand-rolled
 * call. A draft with NO `sourceSummary` (a human typed it directly, never
 * touched the bounded crawl) never fires remember() -- there is no real
 * source material to index (design-discussion.md §9 judgment call #9) --
 * matching pu-03's HTTP approve route's own firing condition exactly. A
 * remember() failure at this stage is reported to stderr but does NOT flip
 * the exit code or undo the already-successful commit+archive -- the
 * persona write is the one action this command's exit code gates.
 */
async function runDraftApprove(argv, { log, warn }) {
  const parsed = parseDraftIdentityArgs(argv, "approve", { warn });
  if (!parsed) return { ok: false };
  const { tier, scopeId, ctx } = parsed;

  let draft;
  try {
    draft = readDraftPersona(tier, scopeId, ctx);
  } catch (e) {
    warn(`mnemosyne persona draft approve: ${e.message}`);
    return { ok: false };
  }

  // proposedBy/proposedAt are stripped (draft-only metadata) and intentionally unused below;
  // sourceSummary is stripped from `candidate` too (never author-storable in the committed
  // record) but is read below to decide whether remember() fires.
  const { proposedBy: _proposedBy, proposedAt: _proposedAt, sourceSummary, ...candidate } = draft;

  let writtenPath;
  try {
    writtenPath = ctx.repoRoot ? writeRepoLocalPersona(ctx.repoRoot, candidate) : writeGlobalPersona(candidate);
  } catch (e) {
    // Write failed (e.g. assertValidPersona rejects an incomplete draft) --
    // nothing written, draft stays active (no disposeDraftPersona call), so
    // a human can go fix it and re-propose.
    warn(`mnemosyne persona draft approve: ${e.message}`);
    return { ok: false };
  }

  const archivePath = disposeDraftPersona(tier, scopeId, "approved", ctx);
  log(`approved draft ${tier}/${scopeId} -> ${writtenPath} (draft archived -> ${archivePath})`);

  let remembered = false;
  if (typeof sourceSummary === "string" && sourceSummary.trim() !== "") {
    const resolution = resolveRememberScope({ tier, scopeId });
    const text = buildDraftRememberText({ ...candidate, sourceSummary });
    const fired = await fireRememberCall({ text, scope: resolution.scope, tag: resolution.tag });
    if (fired.ok && fired.result?.remembered === true) {
      remembered = true;
      log(`remember() fired for draft ${tier}/${scopeId} (scope=${resolution.scope}, tag=${resolution.tag})`);
    } else {
      warn(
        `mnemosyne persona draft approve: remember() call did not complete (persona is already committed; this is ` +
          `non-fatal): ${fired.error || fired.stderr || "remember() did not report remembered:true"}`,
      );
    }
  }

  return { ok: true, writtenPath, archivePath, remembered };
}

/**
 * `persona draft discard <tier> <scope-id> [--repo <repo>]` -- pu-04.
 * Archives the active draft to the `discarded/` subtree via pu-02's
 * `disposeDraftPersona` -- NEVER a bare filesystem delete (mirrors
 * `approve`'s own archive-not-delete convention, and this codebase's
 * broader "never wipe state" posture).
 */
function runDraftDiscard(argv, { log, warn }) {
  const parsed = parseDraftIdentityArgs(argv, "discard", { warn });
  if (!parsed) return { ok: false };
  const { tier, scopeId, ctx } = parsed;

  let archivePath;
  try {
    archivePath = disposeDraftPersona(tier, scopeId, "discarded", ctx);
  } catch (e) {
    warn(`mnemosyne persona draft discard: ${e.message}`);
    return { ok: false };
  }

  log(`discarded draft ${tier}/${scopeId} -> archived at ${archivePath}`);
  return { ok: true, archivePath };
}

/**
 * `persona draft <propose|show|approve|discard> ...` dispatcher -- pu-04.
 * Mirrors `run`'s own top-level dispatch shape one level down.
 */
async function runDraft(argv, { log, warn }) {
  const verb = argv[0];
  if (verb === "propose") return runDraftPropose(argv.slice(1), { log, warn });
  if (verb === "show") return runDraftShow(argv.slice(1), { log, warn });
  if (verb === "approve") return runDraftApprove(argv.slice(1), { log, warn });
  if (verb === "discard") return runDraftDiscard(argv.slice(1), { log, warn });
  warn(`mnemosyne persona draft: unknown or missing sub-subcommand '${verb ?? ""}'`);
  warn(USAGE_DRAFT);
  return { ok: false };
}

/**
 * `persona show <tier> <scope-id>` -- pf-13. Positional args, not flags (see
 * USAGE_SHOW). Read-only by construction: the only fs call reachable from
 * here is `readGlobalPersona`'s own `readFileSync`
 * (persona-store-global.ts) -- no write function, no `withLock`, is called
 * anywhere in this function or anything it calls. Also a live read every
 * time: `readGlobalPersona` reads fresh off disk on every call (no
 * module-level caching anywhere in persona-store-global.ts), so an edit made
 * to the persona file between two `show` invocations is reflected on the
 * very next one.
 */
function runShow(argv, { log, warn }) {
  const [tier, scopeId] = argv;
  if (!tier || !scopeId) {
    warn("mnemosyne persona show: <tier> and <scope-id> are both required");
    warn(USAGE_SHOW);
    return { ok: false };
  }
  if (!TIERS.includes(tier)) {
    warn(`mnemosyne persona show: invalid tier '${tier}'. Valid tiers: ${TIERS.join(", ")}.`);
    return { ok: false };
  }
  if (PERSONA_STORE_BY_TIER[tier] !== "global") {
    warn(
      `mnemosyne persona show: tier '${tier}' is not a global tier -- 'show' only reads from the ` +
        "global persona store (~/.mnemosyne/personas). code-architect personas live in the repo-local " +
        "store (persona-store-repo-local.ts), which this verb does not read.",
    );
    return { ok: false };
  }

  let persona;
  try {
    persona = readGlobalPersona(tier, scopeId);
  } catch (e) {
    warn(`mnemosyne persona show: ${e.message}`);
    return { ok: false };
  }

  log(formatPersonaShow(persona));
  return { ok: true, persona };
}

/**
 * `persona create --file <path> [--repo <path>] [--root <path>]` -- pw-05.
 * A thin wrapper over writeGlobalPersona/writeRepoLocalPersona (Epic 1,
 * pf-06/pf-01): parses --file's YAML into a candidate and passes it through
 * UNCHANGED to exactly one of those two functions, picked by whether --repo
 * was given. No business logic is reimplemented here -- validation
 * (including the mandateSections-smuggling guard), the tier/store-mismatch
 * guard, directory creation, and the withLock'd write are all handled
 * entirely inside the store functions themselves, same as pf-08's seed
 * script already does for its own writeGlobalPersona calls.
 */
function runCreate(args, { log, warn }) {
  if (!args.file) {
    warn("mnemosyne persona create: --file <path-to-yaml> is required");
    warn(USAGE_CREATE);
    return { ok: false };
  }

  const filePath = path.resolve(args.file);
  if (!existsSync(filePath)) {
    warn(`mnemosyne persona create: no such file '${filePath}'`);
    return { ok: false };
  }

  let candidate;
  try {
    candidate = parseYaml(readFileSync(filePath, "utf8"));
  } catch (e) {
    warn(`mnemosyne persona create: failed to parse --file as YAML: ${e.message}`);
    return { ok: false };
  }

  const storeKind = args.repo ? "repo-local" : "global";
  let writtenPath;
  try {
    if (args.repo) {
      writtenPath = writeRepoLocalPersona(path.resolve(args.repo), candidate);
    } else {
      const root = args.root ? path.resolve(args.root) : undefined;
      writtenPath = root !== undefined ? writeGlobalPersona(candidate, root) : writeGlobalPersona(candidate);
    }
  } catch (e) {
    warn(`mnemosyne persona create: ${e.message}`);
    return { ok: false };
  }

  log(`created ${storeKind} persona ${candidate?.tier}/${candidate?.scopeId} -> ${writtenPath}`);
  return { ok: true, filePath: writtenPath };
}

/**
 * `persona resolve-remember-scope --tier <tier> --scope-id <id>` -- pw-13.
 * Pure pass-through to persona.ts's `resolveRememberScope` (pw-09) -- the
 * ONE real crossing point a plain-ESM caller (persona-remember.mjs) uses to
 * invoke that TS function for real, mirroring `create`'s/`show`'s own
 * "thin wrapper, no reimplemented logic" shape. Zero filesystem access:
 * resolveRememberScope is a pure `{tier, scopeId} -> {scope, tag}` function,
 * same "same {tier, scopeId} in -> same {scope, tag} out, always" contract
 * its own doc comment states.
 */
function runResolveRememberScope(args, { log, warn }) {
  if (!args.tier || !args.scopeId) {
    warn("mnemosyne persona resolve-remember-scope: --tier and --scope-id are both required");
    warn(USAGE_RESOLVE_REMEMBER_SCOPE);
    return { ok: false };
  }

  let resolution;
  try {
    resolution = resolveRememberScope({ tier: args.tier, scopeId: args.scopeId });
  } catch (e) {
    warn(`mnemosyne persona resolve-remember-scope: ${e.message}`);
    return { ok: false };
  }

  log(JSON.stringify(resolution));
  return { ok: true, ...resolution };
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

  if (argv[0] === "show") {
    return runShow(argv.slice(1), { log, warn });
  }

  if (argv[0] === "draft") {
    return runDraft(argv.slice(1), { log, warn });
  }

  const args = parseArgs(argv);
  if (args.subcommand === "create") {
    return runCreate(args, { log, warn });
  }
  if (args.subcommand === "resolve-remember-scope") {
    return runResolveRememberScope(args, { log, warn });
  }
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
