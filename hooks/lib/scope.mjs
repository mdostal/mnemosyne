// scope.mjs — ROLE-SCOPED memory resolution (v1, minimal).
//
// Mathew's spec: always-loaded memory is role-scoped —
//   - top orchestrator  -> metadata about ALL repos (broadest; escalate up)
//   - repo architect     -> that repo's full meta + graph
//   - developer          -> just its repo slice + graph + impact edges
//
// v1 keeps this deliberately thin: role + repo/cwd + env resolve to a
// swarm-memory { scope, escalate } pair. This is the SEAM the later layers
// (code-graph, per-ticket line-range indexing, per-repo meta) grow into —
// it is intentionally simple now, not a guess at the full model.

import path from "node:path";

// cwd basename / repo name -> swarm-memory scope. Extend as repos get their
// own collections. Unknown repos fall through to the role default.
const REPO_SCOPE = {
  att: "att",
  "att-site": "att",
  "all-that-cable": "att",
  arizona: "arizona",
  "arizona-compound": "arizona",
  clients: "clients",
  mnemosyne: "top",
  pantheon: "top",
  "dostal-pantheon": "top",
  multica: "ffe",
  auriga: "ffe",
  hive: "ffe",
};

function normalizeRepoName(value) {
  if (!value) return "";
  const raw = String(value).trim().replace(/\.git$/i, "");
  const withoutUrl = raw
    .replace(/^git@github\.com:/i, "")
    .replace(/^https:\/\/github\.com\//i, "");
  return path.basename(withoutUrl).toLowerCase();
}

function repoScopeFromValue(value) {
  const base = normalizeRepoName(value);
  return REPO_SCOPE[base] || null;
}

// An EXPLICIT target repo (stdin target_repo/repo/repository or env
// MNEMOSYNE_TARGET_REPO) that isn't in REPO_SCOPE resolves to its own basename:
// live scopes are named per repo (janus, heimdall, portunus, ...). A cwd
// basename never does — runner cwds are generic (`workdir`) and would mint
// bogus scopes.
function explicitRepoScope(value) {
  if (!value) return null;
  return repoScopeFromValue(value) || normalizeRepoName(value) || null;
}

// resolveScope(input) -> { scope, escalate, role, reason }
// Precedence:
//   1) stdin `scope`
//   2) orchestrator role -> MNEMOSYNE_SCOPE || top
//   3) env MNEMOSYNE_SCOPE
//   4) explicit target repo: stdin target_repo/repo/repository, then env
//      MNEMOSYNE_TARGET_REPO (mapped via REPO_SCOPE, else the repo basename)
//   5) cwd basename, only when it's a known repo in REPO_SCOPE
//   6) default -> top
// Role only decides `escalate` (architect escalates, developer doesn't) for 3-5.
export function resolveScope(input = {}) {
  const role = String(
    input.role || process.env.MNEMOSYNE_ROLE || ""
  ).toLowerCase();

  // 1) explicit scope always wins
  if (input.scope) {
    return {
      scope: String(input.scope),
      escalate: input.escalate != null ? !!input.escalate : role.includes("orch") || role.includes("architect"),
      role: role || "explicit",
      reason: "explicit scope",
    };
  }

  // 2) top orchestrator: broadest — all-repo metadata, escalate up the ladder
  if (role.includes("orch") || role === "top" || role.includes("queen")) {
    return { scope: process.env.MNEMOSYNE_SCOPE || "top", escalate: true, role, reason: "orchestrator -> top (all-repo, escalate)" };
  }

  const isArchitect = role.includes("architect");
  const isDeveloper = role.includes("dev") || role.includes("engineer") || role.includes("developer");
  // architect: repo meta/graph, escalate to shared knowledge.
  // developer: just its repo slice, no escalation (narrow context).
  const escalate = isArchitect;
  const roleLabel = (fallback) => role || fallback;
  const roleNote = isArchitect ? " (architect, escalate)" : isDeveloper ? " (developer, no escalate)" : "";

  // 3) env scope override
  if (process.env.MNEMOSYNE_SCOPE) {
    return { scope: process.env.MNEMOSYNE_SCOPE, escalate, role: roleLabel("env"), reason: `env MNEMOSYNE_SCOPE${roleNote}` };
  }

  // 4) explicit target repo
  const inputRepo = input.target_repo || input.repo || input.repository;
  const repo = inputRepo || process.env.MNEMOSYNE_TARGET_REPO;
  const repoScope = explicitRepoScope(repo);
  if (repoScope) {
    const from = inputRepo ? "target_repo" : "env MNEMOSYNE_TARGET_REPO";
    return { scope: repoScope, escalate, role: roleLabel("repo"), reason: `${from} -> repo scope${roleNote}` };
  }

  // 5) cwd basename (known repos only)
  const cwd = input.cwd || process.env.MNEMOSYNE_CWD || process.cwd();
  const cwdScope = repoScopeFromValue(cwd);
  if (cwdScope) {
    return { scope: cwdScope, escalate, role: roleLabel("repo"), reason: `repo-from-cwd${roleNote}` };
  }

  // 6) default
  return { scope: "top", escalate: !isDeveloper, role: roleLabel("default"), reason: "default -> top" };
}
