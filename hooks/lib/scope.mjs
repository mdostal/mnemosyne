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

// resolveScope(input) -> { scope, escalate, role, reason }
// Precedence: explicit scope > role+repo mapping > env > default.
export function resolveScope(input = {}) {
  const role = String(
    input.role || process.env.MNEMOSYNE_ROLE || ""
  ).toLowerCase();
  const cwd = input.cwd || process.env.MNEMOSYNE_CWD || process.cwd();
  const repo =
    input.target_repo ||
    input.repo ||
    input.repository ||
    process.env.MNEMOSYNE_TARGET_REPO ||
    cwd;
  const repoScope = repoScopeFromValue(repo);

  // 1) explicit scope always wins
  if (input.scope) {
    return {
      scope: String(input.scope),
      escalate: input.escalate != null ? !!input.escalate : role.includes("orch") || role.includes("architect"),
      role: role || "explicit",
      reason: "explicit scope",
    };
  }

  // 2) role-scoped resolution
  if (role.includes("orch") || role === "top" || role.includes("queen")) {
    // top orchestrator: broadest — all-repo metadata, escalate up the ladder
    return { scope: process.env.MNEMOSYNE_SCOPE || "top", escalate: true, role, reason: "orchestrator -> top (all-repo, escalate)" };
  }
  if (role.includes("architect")) {
    // repo architect: this repo's meta/graph, escalate to shared knowledge
    return { scope: repoScope || process.env.MNEMOSYNE_SCOPE || "top", escalate: true, role, reason: "architect -> repo scope (escalate)" };
  }
  if (role.includes("dev") || role.includes("engineer") || role.includes("developer")) {
    // developer: just its repo slice; no escalation (narrow context)
    return { scope: repoScope || process.env.MNEMOSYNE_SCOPE || "top", escalate: false, role, reason: "developer -> repo slice (no escalate)" };
  }

  // 3) env / repo fallback
  if (process.env.MNEMOSYNE_SCOPE) {
    return { scope: process.env.MNEMOSYNE_SCOPE, escalate: false, role: role || "env", reason: "env MNEMOSYNE_SCOPE" };
  }
  if (repoScope) {
    return { scope: repoScope, escalate: false, role: role || "repo", reason: "repo-from-cwd" };
  }

  // 4) default
  return { scope: "top", escalate: true, role: role || "default", reason: "default -> top" };
}
