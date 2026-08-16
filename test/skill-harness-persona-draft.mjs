// skill-harness-persona-draft.mjs — pu-05: real-subprocess coverage for the
// 4 draft skill-harness actions (personaDraftProposeAction/
// personaDraftShowAction/personaDraftApproveAction/personaDraftDiscardAction,
// bin/mnemosyne-skill-helper.mjs), the same "no prior coverage exists for
// this persona-action group" gap the wizard epic's H5 already documented
// for `create` before pw-06 closed it.
//
// Same real-subprocess, fake-$HOME convention test/skill-harness.mjs's own
// persona-* block (personaSyncAction/personaSeedAction/personaShowAction/
// personaCreateAction) already uses -- no running Mnemosyne HTTP service is
// needed for any of this (the persona CLI operates directly on the
// filesystem via tsx, not fetch()); `port` is threaded through purely to
// keep every action function's call signature uniform, same as every other
// persona-* action. No new logic is exercised here beyond the CLI
// subprocess boundary already proven correct by test/persona-cli.mjs's own
// AC-draft-propose/AC-draft-show/AC-draft-approve/AC-draft-discard blocks --
// this file proves personaDraftProposeAction/personaDraftShowAction/
// personaDraftApproveAction/personaDraftDiscardAction wrap that CLI
// correctly, not that the CLI itself is correct (already covered).
//
// Usage: node test/skill-harness-persona-draft.mjs
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  personaDraftProposeAction,
  personaDraftShowAction,
  personaDraftApproveAction,
  personaDraftDiscardAction,
  personaShowAction,
} from "../bin/mnemosyne-skill-helper.mjs";

// `port` is unused by every persona-* action (no HTTP surface involved) --
// same placeholder convention test/skill-harness.mjs's own persona-* block
// uses, on a port distinct from every other test file's (8477/8479/8483/
// 8487/8491/8497/8498/8499/8500/8501/8502/8503/8504).
const PORT = Number(process.env.MNEMOSYNE_TEST_PORT || 8505);

let fails = 0;
const ok = (c, m) => { console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`); if (!c) fails++; };

async function makeFakeHome() {
  const home = await mkdtemp(path.join(tmpdir(), "mnemosyne-skill-harness-draft-home-"));
  await mkdir(path.join(home, ".mnemosyne"), { recursive: true });
  await writeFile(
    path.join(home, ".mnemosyne", "level0-rules.md"),
    "# Level 0 fixture\n\nSKILL_HARNESS_DRAFT_LEVEL0_MARKER — pull first, never commit to main.\n",
    "utf8",
  );
  return home;
}

async function writeCandidateFile(dir, filename, candidate) {
  const filePath = path.join(dir, filename);
  const lines = [];
  for (const key of ["tier", "scopeId", "displayName", "scope"]) {
    if (candidate[key] !== undefined) lines.push(`${key}: ${JSON.stringify(candidate[key])}`);
  }
  if (candidate.sections !== undefined) {
    lines.push("sections:");
    for (const s of candidate.sections) {
      lines.push(`  - heading: ${JSON.stringify(s.heading)}`, `    body: ${JSON.stringify(s.body)}`);
    }
  }
  await writeFile(filePath, lines.join("\n") + "\n", "utf8");
  return filePath;
}

async function fileExists(p) {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

const fakeHome = await makeFakeHome();
const fakeRepo = await mkdtemp(path.join(tmpdir(), "mnemosyne-skill-harness-draft-repo-"));
const contentDir = await mkdtemp(path.join(tmpdir(), "mnemosyne-skill-harness-draft-content-"));
const savedHome = process.env.HOME;
process.env.HOME = fakeHome;

try {
  // =========================================================================
  // personaDraftProposeAction / personaDraftShowAction -- global tier round
  // trip. Propose writes into the structurally separate draft store
  // (~/.mnemosyne/persona-drafts), never the real persona store; show reads
  // it back, clearly labeled DRAFT.
  // =========================================================================
  {
    const candidateFile = await writeCandidateFile(contentDir, "propose-global.yaml", {
      tier: "project-orchestrator",
      scopeId: "skill-harness-draft-global",
      displayName: "Project Orchestrator (draft)",
      scope: "SKILL_HARNESS_DRAFT_GLOBAL_MARKER — proposed via personaDraftProposeAction.",
      sections: [{ heading: "Authored section", body: "SKILL_HARNESS_DRAFT_GLOBAL_BODY_MARKER" }],
    });

    const proposeResult = await personaDraftProposeAction(PORT, { file: candidateFile });
    ok(proposeResult.ok === true, `personaDraftProposeAction() (global tier) succeeds (got ${JSON.stringify(proposeResult).slice(0, 200)})`);
    ok(/proposed/.test(proposeResult.output), "personaDraftProposeAction() output reports the write with the CLI's own 'proposed' verb");

    const realStoreUntouched = await fileExists(
      path.join(fakeHome, ".mnemosyne", "personas", "project-orchestrator", "skill-harness-draft-global.yaml"),
    );
    ok(realStoreUntouched === false, "personaDraftProposeAction() wrote NOTHING into the real global persona store");

    const showResult = await personaDraftShowAction(PORT, "project-orchestrator", "skill-harness-draft-global");
    ok(showResult.ok === true, `personaDraftShowAction() (global tier) succeeds (got ${JSON.stringify(showResult).slice(0, 200)})`);
    ok(
      /SKILL_HARNESS_DRAFT_GLOBAL_MARKER/.test(showResult.output) && /SKILL_HARNESS_DRAFT_GLOBAL_BODY_MARKER/.test(showResult.output),
      "personaDraftShowAction() round-trips the just-proposed draft's real content",
    );
    ok(/DRAFT/.test(showResult.output), "personaDraftShowAction()'s output is visibly labeled DRAFT");
  }

  // =========================================================================
  // personaDraftProposeAction / personaDraftShowAction -- repo-local tier
  // (code-architect), --repo threaded through untouched. Without --repo the
  // same identity is not visible (repo-local drafts are scoped by repoRoot).
  // =========================================================================
  {
    const candidateFile = await writeCandidateFile(contentDir, "propose-repo.yaml", {
      tier: "code-architect",
      scopeId: "skill-harness-draft-repo",
      displayName: "Code/Area Architect (draft)",
      scope: "SKILL_HARNESS_DRAFT_REPO_MARKER — proposed via personaDraftProposeAction --repo.",
      sections: [{ heading: "Authored section", body: "SKILL_HARNESS_DRAFT_REPO_BODY_MARKER" }],
    });

    const proposeResult = await personaDraftProposeAction(PORT, { file: candidateFile, repo: fakeRepo });
    ok(proposeResult.ok === true, `personaDraftProposeAction() (repo-local tier) succeeds (got ${JSON.stringify(proposeResult).slice(0, 200)})`);

    const realRepoStoreUntouched = await fileExists(path.join(fakeRepo, ".mnemosyne", "personas", "skill-harness-draft-repo.yaml"));
    ok(realRepoStoreUntouched === false, "personaDraftProposeAction() (repo-local) wrote NOTHING into the repo's real repo-local persona store");

    const showResult = await personaDraftShowAction(PORT, "code-architect", "skill-harness-draft-repo", { repo: fakeRepo });
    ok(showResult.ok === true, `personaDraftShowAction() (repo-local tier) succeeds (got ${JSON.stringify(showResult).slice(0, 200)})`);
    ok(/SKILL_HARNESS_DRAFT_REPO_MARKER/.test(showResult.output), "personaDraftShowAction() (repo-local) round-trips the draft's real content");

    const showNoRepoResult = await personaDraftShowAction(PORT, "code-architect", "skill-harness-draft-repo");
    ok(showNoRepoResult.ok === false, "personaDraftShowAction() (repo-local identity, repo omitted) returns ok:false -- not visible without --repo");
  }

  // =========================================================================
  // personaDraftApproveAction -- success path: commits via the SAME write
  // primitive `create` uses, archives the draft (never deletes), and the
  // draft is no longer active afterward. Same "prove it's real" round trip
  // as personaCreateAction's own coverage above.
  // =========================================================================
  {
    const candidateFile = await writeCandidateFile(contentDir, "approve-success.yaml", {
      tier: "company-director",
      scopeId: "skill-harness-draft-approve",
      displayName: "Company Director (draft)",
      scope: "SKILL_HARNESS_DRAFT_APPROVE_MARKER — approved via personaDraftApproveAction.",
      sections: [{ heading: "Authored section", body: "SKILL_HARNESS_DRAFT_APPROVE_BODY_MARKER" }],
    });

    const proposeResult = await personaDraftProposeAction(PORT, { file: candidateFile });
    ok(proposeResult.ok === true, `[approve] personaDraftProposeAction() succeeds (got ${JSON.stringify(proposeResult).slice(0, 200)})`);

    const approveResult = await personaDraftApproveAction(PORT, "company-director", "skill-harness-draft-approve");
    ok(approveResult.ok === true, `personaDraftApproveAction() succeeds (got ${JSON.stringify(approveResult).slice(0, 200)})`);
    ok(/approved draft/.test(approveResult.output), "personaDraftApproveAction() output reports the approval with the CLI's own 'approved draft' verb");

    const committedContent = await readFile(
      path.join(fakeHome, ".mnemosyne", "personas", "company-director", "skill-harness-draft-approve.yaml"),
      "utf8",
    );
    ok(
      committedContent.includes("SKILL_HARNESS_DRAFT_APPROVE_MARKER") && committedContent.includes("SKILL_HARNESS_DRAFT_APPROVE_BODY_MARKER"),
      "personaDraftApproveAction() actually committed the draft's real content into the real global persona store",
    );

    // Round-trips through personaShowAction -- proves the two subprocess
    // boundaries share the same $HOME-resolved global store.
    const shownAfterApprove = await personaShowAction(PORT, "company-director", "skill-harness-draft-approve");
    ok(shownAfterApprove.ok === true, "personaShowAction() reads back what personaDraftApproveAction() just committed");

    // The archive tree got a new file (approved/company-director/), and the
    // draft is no longer active.
    const archiveDir = path.join(fakeHome, ".mnemosyne", "persona-drafts", "approved", "company-director");
    const archiveFiles = await readdir(archiveDir).catch(() => []);
    ok(archiveFiles.length === 1, `exactly one archived draft file exists under approved/company-director/ (got ${JSON.stringify(archiveFiles)})`);
    ok(
      archiveFiles[0]?.startsWith("skill-harness-draft-approve-"),
      `archived draft filename is timestamped off the original scopeId -> ${JSON.stringify(archiveFiles)}`,
    );

    const showAfterApprove = await personaDraftShowAction(PORT, "company-director", "skill-harness-draft-approve");
    ok(showAfterApprove.ok === false, "personaDraftShowAction() reports ok:false after approve -- the draft is archived, no longer active");
  }

  // =========================================================================
  // personaDraftApproveAction -- failure path: an incomplete draft
  // (structurally valid enough to write, but assertValidPersona-invalid --
  // missing displayName/scope) is rejected at approve time, never a silent
  // no-op. The draft remains active (not archived), and the real store is
  // never touched. Matches the exact bar this ticket's acceptance criteria
  // states for a rejected draft-approve.
  // =========================================================================
  {
    const candidateFile = await writeCandidateFile(contentDir, "approve-failure.yaml", {
      tier: "top-orchestrator",
      scopeId: "skill-harness-draft-approve-fail",
      sections: [{ heading: "Section", body: "body" }],
    });

    const proposeResult = await personaDraftProposeAction(PORT, { file: candidateFile });
    ok(proposeResult.ok === true, `[approve-failure] personaDraftProposeAction() (incomplete candidate) succeeds -- structural-only check, not assertValidPersona-strength (got ${JSON.stringify(proposeResult).slice(0, 200)})`);

    const approveResult = await personaDraftApproveAction(PORT, "top-orchestrator", "skill-harness-draft-approve-fail");
    ok(approveResult.ok === false, "personaDraftApproveAction() of an invalid draft returns ok:false, not a thrown error -- never a silent no-op");
    ok(
      !/EACCES|ENOENT|TypeError/.test(approveResult.stderr || ""),
      "personaDraftApproveAction() failure surfaces the CLI's own clear stderr, no unexpected internal error text",
    );

    const committed = await fileExists(
      path.join(fakeHome, ".mnemosyne", "personas", "top-orchestrator", "skill-harness-draft-approve-fail.yaml"),
    );
    ok(committed === false, "the failed personaDraftApproveAction() wrote NOTHING to the real global persona store");

    // The draft is still active (not archived) after the failed approve.
    const showAfterFail = await personaDraftShowAction(PORT, "top-orchestrator", "skill-harness-draft-approve-fail");
    ok(showAfterFail.ok === true, "personaDraftShowAction() still succeeds after a FAILED approve -- the draft remains active, not archived");
  }

  // =========================================================================
  // personaDraftDiscardAction -- archives to discarded/ (never deletes), the
  // draft is no longer active afterward, and nothing was ever committed to
  // the real store.
  // =========================================================================
  {
    const candidateFile = await writeCandidateFile(contentDir, "discard.yaml", {
      tier: "top-orchestrator",
      scopeId: "skill-harness-draft-discard",
      displayName: "Top Orchestrator (draft, to be discarded)",
      scope: "SKILL_HARNESS_DRAFT_DISCARD_MARKER — proposed then discarded.",
      sections: [{ heading: "Authored section", body: "SKILL_HARNESS_DRAFT_DISCARD_BODY_MARKER" }],
    });

    const proposeResult = await personaDraftProposeAction(PORT, { file: candidateFile });
    ok(proposeResult.ok === true, `[discard] personaDraftProposeAction() succeeds (got ${JSON.stringify(proposeResult).slice(0, 200)})`);

    const discardResult = await personaDraftDiscardAction(PORT, "top-orchestrator", "skill-harness-draft-discard");
    ok(discardResult.ok === true, `personaDraftDiscardAction() succeeds (got ${JSON.stringify(discardResult).slice(0, 200)})`);
    ok(/discarded/.test(discardResult.output), "personaDraftDiscardAction() output reports the archival with the CLI's own 'discarded' verb");

    const archiveDir = path.join(fakeHome, ".mnemosyne", "persona-drafts", "discarded", "top-orchestrator");
    const archiveFiles = await readdir(archiveDir).catch(() => []);
    ok(archiveFiles.length === 1, `exactly one archived draft file exists under discarded/top-orchestrator/ (got ${JSON.stringify(archiveFiles)})`);

    const neverCommitted = await fileExists(
      path.join(fakeHome, ".mnemosyne", "personas", "top-orchestrator", "skill-harness-draft-discard.yaml"),
    );
    ok(neverCommitted === false, "personaDraftDiscardAction() never committed anything into the real global persona store");

    const showAfterDiscard = await personaDraftShowAction(PORT, "top-orchestrator", "skill-harness-draft-discard");
    ok(showAfterDiscard.ok === false, "personaDraftShowAction() reports ok:false after discard -- no longer an active draft");
  }

  // =========================================================================
  // A --file that does not exist, or a genuinely unknown draft identity,
  // still comes back ok:false with clear stderr, not a thrown transport
  // error -- matching every other persona-* action's established contract
  // (test/skill-harness.mjs's own personaCreateAction coverage).
  // =========================================================================
  {
    const missingFileResult = await personaDraftProposeAction(PORT, {
      file: path.join(contentDir, "does-not-exist.yaml"),
    });
    ok(missingFileResult.ok === false, "personaDraftProposeAction() with a --file that does not exist returns ok:false, not a thrown error");

    const missingDraftResult = await personaDraftShowAction(PORT, "top-orchestrator", "no-such-draft-ever");
    ok(missingDraftResult.ok === false, "personaDraftShowAction() on a genuinely unproposed identity returns ok:false, not a thrown error");

    const missingApproveResult = await personaDraftApproveAction(PORT, "top-orchestrator", "no-such-draft-ever");
    ok(missingApproveResult.ok === false, "personaDraftApproveAction() on a genuinely unproposed identity returns ok:false, not a thrown error");

    const missingDiscardResult = await personaDraftDiscardAction(PORT, "top-orchestrator", "no-such-draft-ever");
    ok(missingDiscardResult.ok === false, "personaDraftDiscardAction() on a genuinely unproposed identity returns ok:false, not a thrown error");
  }
} finally {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  await rm(fakeHome, { recursive: true, force: true });
  await rm(fakeRepo, { recursive: true, force: true });
  await rm(contentDir, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall skill-harness-persona-draft checks passed");
process.exit(fails ? 1 : 0);
