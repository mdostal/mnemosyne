// test/onboard-reachability.mjs — ro-08-role-metadata-reachability-verification
// (epic: mnemosyne-repo-onboarding).
//
// The operator's own stated payoff for Mode A ("Then it becomes EASY to
// define the roles and places and metadata across etc.") was, before this
// story, only an ASSUMED side effect of ro-02's onboardRepo() persona-seed /
// Layer-1-sync sub-steps. This file makes it a directly verified acceptance
// surface: every check below reads back through a REAL, INDEPENDENT read
// path -- never a re-inspection of onboardRepo()'s own return value.
//
// Runs as a real tsx process (see package.json's "test:onboard-reachability")
// so it can import lib/mnemosyne/onboarding/onboardRepo.ts and its sibling
// TS modules directly, in-process -- mirrors test/persona-draft-cross-
// transport.mjs's own established "plain .mjs file, run via tsx, imports
// .ts directly" precedent (that file's own `tsx test/persona-draft-cross-
// transport.mjs` script), rather than lib/mnemosyne/onboarding/
// onboardRepo.test.ts's vitest-based approach.
//
// Covers (per ro-08's acceptance criteria):
//
//   AC1  bin/mnemosyne-persona.mjs's shipped `show` CLI verb successfully
//        reads back the code-architect persona onboardRepo()'s seed step
//        wrote -- run as a REAL SUBPROCESS (tsx bin/mnemosyne-persona.mjs
//        show code-architect <scopeId> --repo <repoRoot>), never an
//        in-process call to the store function itself. This is a genuinely
//        independent read path: `show`'s own dispatch, argument parsing,
//        and rendering are exercised for real.
//
//        RESEARCH FINDING (this story's own `research` step): as shipped
//        (pf-13-cli-persona-show), `show` unconditionally REFUSED every
//        code-architect scopeId with "tier 'code-architect' is not a global
//        tier" -- it had no repo-local dispatch path at all, so ro-02's
//        persona seed was, in fact, NOT reachable through this verb. This is
//        exactly the class of gap this story's design_decisions/risks
//        anticipated ("the seeded persona doesn't actually pass `show`'s own
//        read path"). Fixed at its real source (bin/mnemosyne-persona.mjs's
//        `show` verb itself, ADDITIVELY -- see that file's own updated doc
//        comment): `show` now accepts an optional `--repo <path>` and, only
//        when given for the one repo-local tier, dispatches to
//        persona-store-repo-local.ts's `readRepoLocalPersona`. Calling
//        `show code-architect ...` WITHOUT `--repo` still refuses with
//        pf-13's own original wording byte-for-byte (still asserted by
//        test/persona-cli.mjs's own pf-13 regression coverage) -- this fix
//        is additive, never a reopening of pf-13's already-integrated
//        acceptance criteria.
//
//   AC2  The synced CLAUDE.md managed block (parsed fresh off disk, via
//        block.ts's own exported `extractManagedBlockBody` -- never sync.ts's
//        internal return value) actually contains a heading matching
//        TIER_CONTENT['code-architect'].displayName AND a "Memory-lifecycle
//        mandate" heading with non-empty body content underneath.
//
//   AC3  (Mode A only) The org-tree entry ro-04/ro-05/ro-07 would write is
//        listable via listOrgTreeEntries() and its org_tree_path
//        independently cross-checks against placement_engine.py's own
//        `_org_tree_path` convention.
//
//        BLOCKED as of this run: lib/mnemosyne/onboarding/orgTree.ts
//        (ro-04-org-tree-registry) has NOT shipped in this codebase --
//        status: pending, zero implementation on `dev` as of this story's
//        execution. ro-08's own `depends_on` names only ro-02; AC3
//        additionally requires ro-04 (the registry itself), ro-05 (the
//        onboard CLI verb that would call it) and ro-07 (the full Mode A
//        flow) -- none of which exist yet. Building any of those three
//        stories' own scope inside ro-08 would violate this story's own
//        design_decisions ("no assumed new production code" /
//        "verification-only") and its risk mitigation ("a discovered gap
//        has a clear place to be fixed... without reopening an
//        already-integrated story's own acceptance criteria" -- the
//        inverse holds too: a NOT-YET-integrated story's scope does not
//        belong here either). The check below is written and ready --
//        it activates automatically the moment lib/mnemosyne/onboarding/
//        orgTree.ts exists -- but reports BLOCKED, not a fabricated pass,
//        until then. See this file's own final summary output.
//
//   AC4  Negative case: a repo where onboarding has NOT run fails each of
//        the three checks above with a clear, DISTINGUISHABLE message (no
//        persona found / no managed block found / no org-tree entry found)
//        -- never a generic error.
//
// Usage: tsx test/onboard-reachability.mjs (wired into `npm test`, see
// package.json's "test:onboard-reachability").

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TSX_BIN = path.join(ROOT, "node_modules", ".bin", "tsx");
const PERSONA_CLI = path.join(ROOT, "bin", "mnemosyne-persona.mjs");
const ORG_TREE_MODULE_PATH = path.join(ROOT, "lib", "mnemosyne", "onboarding", "orgTree.ts");

let fails = 0;
let blocked = 0;
const ok = (c, m) => {
  console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`);
  if (!c) fails++;
};
const blockedNotice = (m) => {
  console.log(`  BLOCKED  ${m}`);
  blocked++;
};

/** Truncates long output for readable log lines (assertions still check the full string). */
function short(text, max = 200) {
  const s = JSON.stringify(text ?? "");
  return s.length > max ? `${s.slice(0, max)}…[truncated, ${s.length} chars total]` : s;
}

const tempDirs = [];
async function makeTempDir(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A real, throwaway Level 0 rules file + $HOME pointing at it -- never the real ~/.mnemosyne/level0-rules.md. */
async function makeFakeHome() {
  const home = await makeTempDir("mnemosyne-onboard-reachability-home-");
  await mkdir(path.join(home, ".mnemosyne"), { recursive: true });
  await writeFile(
    path.join(home, ".mnemosyne", "level0-rules.md"),
    "# Level 0 fixture\n\nRO08_LEVEL0_MARKER — always pull first, never commit to main.\n",
    "utf8",
  );
  return home;
}

/** A fresh, throwaway repo root -- never this repo's own working tree. */
async function makeTempRepo() {
  const dir = await makeTempDir("mnemosyne-onboard-reachability-repo-");
  // Give the file layer something real to index.
  await writeFile(path.join(dir, "README.md"), "# hello\n", "utf8");
  return dir;
}

/**
 * Runs the REAL `bin/mnemosyne-persona.mjs show` CLI as a real subprocess --
 * the independent read path AC1 verifies against. Never an in-process call
 * to readRepoLocalPersona/readGlobalPersona directly.
 */
async function runPersonaShowCli(args, { home } = {}) {
  const env = { ...process.env };
  if (home) env.HOME = home;
  try {
    const { stdout, stderr } = await execFileAsync(TSX_BIN, [PERSONA_CLI, ...args], { cwd: ROOT, env });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extracts the body text following a markdown heading (any level, `#`-`######`)
 * whose text matches `headingText` exactly, up to (but not including) the next
 * heading of a STRICTLY SHALLOWER level -- so sub-headings nested under the
 * matched heading (e.g. the la-07 mandate's own per-subsection `###`
 * headings, nested under its own `### Memory-lifecycle mandate` heading) stay
 * part of the returned body rather than truncating it to nothing. Returns
 * `null` if no heading matches at all -- the caller distinguishes "heading
 * missing" from "heading present with empty body".
 */
function extractHeadingBody(markdown, headingText) {
  const lines = markdown.split("\n");
  const headingRe = new RegExp(`^#{1,6}\\s*${escapeRegExp(headingText)}\\s*$`);
  const idx = lines.findIndex((l) => headingRe.test(l.trim()));
  if (idx === -1) return null;
  const headingLevel = (lines[idx].match(/^#+/) || [""])[0].length;
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+/);
    if (m && m[1].length < headingLevel) {
      end = i;
      break;
    }
  }
  return lines.slice(idx + 1, end).join("\n").trim();
}

/**
 * AC2's independent read path: reads CLAUDE.md fresh off disk and parses it
 * via block.ts's own EXPORTED `extractManagedBlockBody` (never sync.ts's
 * internal return value, never syncAllHarnesses()'s own SyncResult), then
 * checks for the two required headings. Distinguishes "file missing" from
 * "file exists but has no managed block" from "block present but a required
 * heading/body is missing" -- three different reasons, one per AC4's
 * distinguishability requirement.
 */
async function checkHarnessManagedBlock(repoRoot, { extractManagedBlockBody, tierContent }) {
  const claudePath = path.join(repoRoot, "CLAUDE.md");
  if (!existsSync(claudePath)) {
    return { ok: false, reason: `no managed block found -- CLAUDE.md does not exist at ${claudePath}` };
  }

  const content = await readFile(claudePath, "utf8");
  const body = extractManagedBlockBody(content);
  if (body === null) {
    return {
      ok: false,
      reason: `no managed block found -- CLAUDE.md exists at ${claudePath} but has no mnemosyne:layer1:begin/end markers`,
    };
  }

  const displayNameBody = extractHeadingBody(body, tierContent.displayName);
  const mandateBody = extractHeadingBody(body, "Memory-lifecycle mandate");

  if (displayNameBody === null) {
    return { ok: false, reason: `no managed block found -- managed block has no '${tierContent.displayName}' heading` };
  }
  if (mandateBody === null) {
    return { ok: false, reason: "no managed block found -- managed block has no 'Memory-lifecycle mandate' heading" };
  }
  if (mandateBody.length === 0) {
    return { ok: false, reason: "no managed block found -- 'Memory-lifecycle mandate' heading has empty body" };
  }

  return { ok: true, displayNameBody, mandateBody, body };
}

/**
 * AC3's independent read path -- gated behind lib/mnemosyne/onboarding/
 * orgTree.ts actually existing (ro-04-org-tree-registry, not yet shipped as
 * of this run -- see this file's own top-of-file doc comment). Written and
 * ready: activates the moment that module lands, cross-checking
 * listOrgTreeEntries()'s org_tree_path against a REAL, separate
 * `python3 -c` subprocess call into placement_engine.py's own
 * `classify_collection` (which computes org_tree_path via that module's own
 * `_org_tree_path` convention) -- never a JS re-derivation of that formula.
 */
async function computeExpectedOrgTreePath(name) {
  const script = [
    "import json",
    "from mnemosyne.placement_engine import classify_collection",
    `result = classify_collection(${JSON.stringify(name)})`,
    "print(json.dumps({'org_tree_path': result.org_tree_path, 'scope': result.scope}))",
  ].join("\n");
  const { stdout } = await execFileAsync("python3", ["-c", script], { cwd: ROOT });
  return JSON.parse(stdout.trim());
}

async function main() {
  const home = await makeFakeHome();
  process.env.HOME = home;
  // ro-07-onboard-new-collection-full-mode-a: onboardRepo()'s mode:'tree'
  // vector-index sub-step now makes a real POST /reindex call against
  // $MNEMOSYNE_URL (default http://127.0.0.1:8477 -- a real, live service
  // may well be running there on an operator's own machine). This suite's
  // AC3 block below calls onboardRepo({ mode: 'tree', ... }) purely to
  // exercise org-tree reachability, never to test vector indexing -- so
  // MNEMOSYNE_URL is pinned to a deliberately unroutable address (TEST-NET-1,
  // RFC 5737, mirrors test/layer1-mandate-hook.mjs's own UNREACHABLE_URL
  // convention) to keep this run offline and side-effect-free regardless of
  // what else happens to be listening on the default port. The vector-index
  // sub-step fails soft ({ ran: false, reason }), never throws, so this has
  // no effect on any assertion below.
  process.env.MNEMOSYNE_URL = "http://192.0.2.1:1";

  // Dynamic imports, AFTER $HOME is pointed at our fake, throwaway home --
  // onboardRepo.ts's own DEFAULT_LEVEL0_PATH (and any sibling HOME-anchored
  // constant) is computed at module-load time from homedir(), so it must be
  // resolved against our fixture home, never this operator's real $HOME
  // (mirrors onboardRepo.test.ts's own vi.stubEnv-then-import ordering,
  // adapted for a plain tsx-run script with no module-registry reset needed
  // since this file only ever imports each module once).
  const { onboardRepo } = await import("../lib/mnemosyne/onboarding/onboardRepo.js");
  const { TIER_CONTENT } = await import("../lib/mnemosyne/layer1/tiers.js");
  const { extractManagedBlockBody } = await import("../lib/mnemosyne/layer1/block.js");

  const tierContent = TIER_CONTENT["code-architect"];

  // --- AC1 + AC2, positive case, both onboardRepo() modes -------------------
  for (const mode of ["standalone", "tree"]) {
    const repoRoot = await makeTempRepo();
    const scopeId = `ro08-${mode}-scope`;

    const result = await onboardRepo({ mode, repoRoot, scopeId, skipGraph: true });
    ok(result.personaSeeded.created === true, `[mode=${mode}] onboardRepo() seeded a new persona`);

    // AC1: bin/mnemosyne-persona.mjs show code-architect <scopeId> --repo <repoRoot>
    // -- a REAL SUBPROCESS, independent of onboardRepo()'s own return value.
    const shown = await runPersonaShowCli(["show", "code-architect", scopeId, "--repo", repoRoot], { home });
    ok(
      shown.code === 0,
      `[mode=${mode}] AC1: 'persona show code-architect ${scopeId} --repo <repo>' exits 0 (got ${shown.code}, stderr=${short(shown.stderr)})`,
    );
    ok(
      shown.stdout.includes(`tier: code-architect`) && shown.stdout.includes(`scopeId: ${scopeId}`),
      `[mode=${mode}] AC1: show output identifies the exact tier/scopeId ro-02 seeded -> ${short(shown.stdout)}`,
    );
    ok(
      shown.stdout.includes(`displayName: ${tierContent.displayName}`) && shown.stdout.includes(`scope: ${tierContent.scope}`),
      `[mode=${mode}] AC1: show output's displayName/scope match TIER_CONTENT['code-architect'] exactly (the shape ro-02's seed step wrote) -> ${short(shown.stdout)}`,
    );
    for (const section of tierContent.sections) {
      ok(
        shown.stdout.includes(`## ${section.heading}`) && shown.stdout.includes(section.body),
        `[mode=${mode}] AC1: show output contains section '${section.heading}' verbatim`,
      );
    }

    // AC2: CLAUDE.md's managed block, parsed fresh off disk via block.ts's
    // own extractManagedBlockBody.
    const harnessCheck = await checkHarnessManagedBlock(repoRoot, { extractManagedBlockBody, tierContent });
    ok(harnessCheck.ok, `[mode=${mode}] AC2: CLAUDE.md managed block has both required headings -> ${harnessCheck.reason ?? "ok"}`);
    if (harnessCheck.ok) {
      ok(
        harnessCheck.mandateBody.length > 0,
        `[mode=${mode}] AC2: 'Memory-lifecycle mandate' heading has non-empty body content (${harnessCheck.mandateBody.length} chars)`,
      );
    }

    await rm(repoRoot, { recursive: true, force: true });
  }

  // --- AC4 negative case: onboarding has NOT run -----------------------------
  {
    const bareRepo = await makeTempRepo();
    const scopeId = "ro08-negative-scope";

    // AC1 negative: no repo-local persona exists yet.
    const shown = await runPersonaShowCli(["show", "code-architect", scopeId, "--repo", bareRepo], { home });
    ok(shown.code !== 0, `AC4/AC1: show against an un-onboarded repo -> non-zero exit (got ${shown.code})`);
    ok(
      /no repo-local persona found/i.test(shown.stderr),
      `AC4/AC1: clear, distinguishable "no persona found" message -> ${short(shown.stderr)}`,
    );

    // AC2 negative: no CLAUDE.md / managed block exists yet.
    const { extractManagedBlockBody } = await import("../lib/mnemosyne/layer1/block.js");
    const harnessCheck = await checkHarnessManagedBlock(bareRepo, { extractManagedBlockBody, tierContent });
    ok(harnessCheck.ok === false, "AC4/AC2: harness check against an un-onboarded repo reports not-ok");
    ok(
      /no managed block found/i.test(harnessCheck.reason ?? ""),
      `AC4/AC2: clear, distinguishable "no managed block found" message -> ${short(harnessCheck.reason)}`,
    );

    // Sanity: the three negative-case messages are mutually distinguishable
    // (an operator reading any one of them can tell WHICH onboarding step is
    // missing, per AC4's own wording).
    ok(
      /persona/i.test(shown.stderr) && !/managed block/i.test(shown.stderr),
      "AC4: the persona-check message and the managed-block-check message do not read as the same generic error",
    );

    await rm(bareRepo, { recursive: true, force: true });
  }

  // --- AC3 (Mode A only): org-tree entry reachability ------------------------
  if (!existsSync(ORG_TREE_MODULE_PATH)) {
    blockedNotice(
      "AC3 (org-tree entry reachability, Mode A) cannot be exercised against a real, independent " +
        "read path: lib/mnemosyne/onboarding/orgTree.ts (ro-04-org-tree-registry's listOrgTreeEntries()) " +
        "has not shipped in this codebase yet (status: pending, zero implementation on `dev` as of this " +
        "run). ro-08 formally depends only on ro-02; AC3 additionally requires ro-04 (registry), ro-05 " +
        "(onboard CLI verb) and ro-07 (full Mode A flow) -- none of which exist. This check is written " +
        "and will activate automatically once lib/mnemosyne/onboarding/orgTree.ts exists -- reported " +
        "here as a genuine blocked prerequisite, never a fabricated pass or a silently-dropped criterion.",
    );
  } else {
    // Real path -- activates once ro-04 ships. Not exercised in this run.
    const { appendOrgTreeEntry, listOrgTreeEntries } = await import("../lib/mnemosyne/onboarding/orgTree.js");
    const repoRoot = await makeTempRepo();
    const scopeId = "ro08-mode-a-scope";
    const collectionName = `project-${scopeId}`;

    await onboardRepo({ mode: "tree", repoRoot, scopeId, collection: collectionName, skipGraph: true });
    // A real Mode A flow (ro-05/ro-07) would append the org-tree entry
    // itself as its own separate step alongside onboardRepo() -- simulated
    // here since neither of those CLI/flow stories exist yet either.
    const expected = await computeExpectedOrgTreePath(collectionName);
    await appendOrgTreeEntry({
      repo_path: repoRoot,
      scope: expected.scope,
      name: collectionName,
      org_tree_path: expected.org_tree_path,
    });

    const entries = listOrgTreeEntries();
    const entry = entries.find((e) => e.repo_path === repoRoot);
    ok(entry !== undefined, "AC3: the new repo's entry is present via listOrgTreeEntries()");
    ok(
      entry?.org_tree_path === expected.org_tree_path,
      `AC3: org_tree_path matches placement_engine._org_tree_path's own independent computation exactly (got ${short(entry?.org_tree_path)}, expected ${short(expected.org_tree_path)})`,
    );

    // AC4 negative case for org-tree: a repo never registered.
    const neverOnboarded = await makeTempRepo();
    const missing = listOrgTreeEntries().find((e) => e.repo_path === neverOnboarded);
    ok(missing === undefined, "AC4/AC3: an un-onboarded repo has no org-tree entry -- clear, distinguishable absence");

    await rm(repoRoot, { recursive: true, force: true });
    await rm(neverOnboarded, { recursive: true, force: true });
  }
}

try {
  await main();
} finally {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
}

console.log(
  `\n${fails ? `${fails} check(s) failed` : "all onboard-reachability checks passed"}` +
    (blocked ? ` (${blocked} check group blocked on an unshipped prerequisite -- see BLOCKED lines above)` : ""),
);
process.exit(fails ? 1 : 0);
