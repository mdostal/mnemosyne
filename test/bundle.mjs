import {
  CACHE_BREAKPOINT,
  LAYER_PRIORITY,
  buildMemoryBundle,
} from "../hooks/lib/format.mjs";
import { resolveScope } from "../hooks/lib/scope.mjs";
import { analyzePrompt, extractTicketIds } from "../hooks/lib/prompt.mjs";

let fails = 0;
const ok = (condition, message) => {
  console.log(`${condition ? "  PASS" : "  FAIL"}  ${message}`);
  if (!condition) fails++;
};

const recallResult = {
  total_hits: 4,
  scopes: [
    {
      scope: "mnemosyne",
      hits: [
        {
          source: "docs/semantic.md",
          full_path: "/repo/docs/semantic.md",
          chunk_span: [10, 18],
          score: 0.99,
          text: "Semantic hit that should sort below an exact ticket identifier even with a higher score.",
        },
        {
          source: "docs/ticket.md",
          full_path: "/repo/docs/ticket.md",
          chunk_span: [2, 4],
          score: 0.2,
          match_type: "keyword",
          text: "PAN-7190 exact identifier memory for the current ticket.",
        },
        {
          source: "docs/oversize.md",
          full_path: "/repo/docs/oversize.md",
          chunk_span: [20, 80],
          score: 0.1,
          text: "This lower-ranked hit is intentionally verbose. ".repeat(80),
        },
      ],
    },
    {
      scope: "top",
      hits: [
        {
          source: "global/cache.md",
          full_path: "/repo/global/cache.md",
          chunk_span: [1, 6],
          score: 0.75,
          text: "Global/shared guidance about keeping prompt-cache prefixes byte-identical.",
        },
      ],
    },
  ],
};

const meta = {
  scope: "mnemosyne",
  sharedScope: "top",
  role: "developer",
  url: "http://127.0.0.1:8477",
  max: 3,
  tokenBudget: 260,
  ticket: "PAN-7190",
};

const claudeBundle = buildMemoryBundle(recallResult, meta);
const codexBundle = buildMemoryBundle(recallResult, meta);
ok(
  claudeBundle.text === codexBundle.text,
  "canonical bundle text is identical for Claude and Codex adapters"
);

const otherTicketBundle = buildMemoryBundle(recallResult, {
  ...meta,
  ticket: "PAN-9999",
});
ok(
  claudeBundle.cacheablePrefix === otherTicketBundle.cacheablePrefix,
  "cacheable prefix is byte-identical when only the ticket changes"
);
ok(
  claudeBundle.text.includes(CACHE_BREAKPOINT),
  "bundle contains an explicit cache breakpoint before variable memory"
);
ok(
  claudeBundle.text.indexOf("PAN-7190") > claudeBundle.text.indexOf(CACHE_BREAKPOINT),
  "ticket-specific memory appears only after the cache breakpoint"
);
ok(
  claudeBundle.memoryDelta.indexOf("keyword-exact") <
    claudeBundle.memoryDelta.indexOf("score 0.99"),
  "keyword-exact hit sorts above higher-score semantic hits"
);
ok(
  !claudeBundle.memoryDelta.includes("intentionally verbose"),
  "lower-ranked verbose hit is omitted by the variable token budget"
);
ok(
  claudeBundle.stats.delta_tokens_estimate <= meta.tokenBudget + 80,
  "variable memory delta stays close to the configured token budget"
);

const scoped = resolveScope({
  target_repo: "git@github.com:mdostal/auriga.git",
  role: "developer",
});
ok(
  scoped.scope === "ffe" && scoped.escalate === false,
  "scope can be derived from target_repo for per-repo developer recall"
);

// --- high-level-first injection (mc-05) ---

const layeredRecall = {
  total_hits: 4,
  scopes: [
    {
      scope: "meta",
      hits: [
        {
          source: "meta/pantheon-overview.md",
          full_path: "/repo/meta/pantheon-overview.md",
          chunk_span: [1, 5],
          score: 0.1,
          text: "Low-score meta hit that must still outrank a higher-score vector hit.",
        },
      ],
    },
    {
      scope: "vector",
      hits: [
        {
          source: "vector/embedding-note.md",
          full_path: "/repo/vector/embedding-note.md",
          chunk_span: [1, 3],
          score: 0.95,
          text: "High-score vector hit that should still sort below the meta layer hit.",
        },
      ],
    },
  ],
};

const layeredBundle = buildMemoryBundle(layeredRecall, {
  ...meta,
  max: 6,
  tokenBudget: 900,
});
ok(
  layeredBundle.memoryDelta.indexOf("[meta") <
    layeredBundle.memoryDelta.indexOf("[vector"),
  "meta layer hits appear before vector layer hits regardless of score"
);

const withinLayerRecall = {
  total_hits: 2,
  scopes: [
    {
      scope: "project",
      hits: [
        {
          source: "project/low.md",
          full_path: "/repo/project/low.md",
          chunk_span: [1, 2],
          score: 0.3,
          text: "Lower-score project hit.",
        },
        {
          source: "project/high.md",
          full_path: "/repo/project/high.md",
          chunk_span: [1, 2],
          score: 0.8,
          text: "Higher-score project hit.",
        },
      ],
    },
  ],
};
const withinLayerBundle = buildMemoryBundle(withinLayerRecall, {
  ...meta,
  max: 6,
  tokenBudget: 900,
});
ok(
  withinLayerBundle.memoryDelta.indexOf("project/high.md") <
    withinLayerBundle.memoryDelta.indexOf("project/low.md"),
  "within the same layer, hits rank by score descending"
);

ok(
  LAYER_PRIORITY.meta < LAYER_PRIORITY.enterprise &&
    LAYER_PRIORITY.enterprise < LAYER_PRIORITY.project &&
    LAYER_PRIORITY.project < LAYER_PRIORITY.vector &&
    LAYER_PRIORITY.vector < LAYER_PRIORITY.file,
  "layer priority map orders meta > enterprise > project > vector > file"
);

// Budget reservation: a big meta layer must not crowd out a small vector hit.
const reservationRecall = {
  total_hits: 4,
  scopes: [
    {
      scope: "meta",
      hits: [
        {
          source: "meta/one.md",
          full_path: "/repo/meta/one.md",
          chunk_span: [1, 2],
          score: 0.9,
          text: "Meta filler content. ".repeat(60),
        },
        {
          source: "meta/two.md",
          full_path: "/repo/meta/two.md",
          chunk_span: [1, 2],
          score: 0.8,
          text: "More meta filler content. ".repeat(60),
        },
        {
          source: "meta/three.md",
          full_path: "/repo/meta/three.md",
          chunk_span: [1, 2],
          score: 0.7,
          text: "Even more meta filler content. ".repeat(60),
        },
      ],
    },
    {
      scope: "vector",
      hits: [
        {
          source: "vector/small.md",
          full_path: "/repo/vector/small.md",
          chunk_span: [1, 2],
          score: 0.99,
          text: "Small, important vector-layer hit.",
        },
      ],
    },
  ],
};
const reservationBundle = buildMemoryBundle(reservationRecall, {
  ...meta,
  max: 6,
  tokenBudget: 900,
});
ok(
  reservationBundle.memoryDelta.includes("vector/small.md"),
  "a small low-layer hit still surfaces even when the meta layer has enough content to fill the whole budget"
);
ok(
  reservationBundle.stats.high_level_tokens_estimate <= 300 + 80,
  "meta+enterprise layer hits stay within the ~300 token high-level reservation cap"
);

// No high-level hits -> full budget available for lower layers (no wasted space).
const noHighLevelRecall = {
  total_hits: 1,
  scopes: [
    {
      scope: "project",
      hits: [
        {
          source: "project/only.md",
          full_path: "/repo/project/only.md",
          chunk_span: [1, 2],
          score: 0.5,
          text: "Project-only filler content. ".repeat(60),
        },
      ],
    },
  ],
};
const noHighLevelBundle = buildMemoryBundle(noHighLevelRecall, {
  ...meta,
  max: 6,
  tokenBudget: 900,
});
ok(
  noHighLevelBundle.stats.high_level_tokens_estimate === 0,
  "no high-level hits means zero tokens are set aside for the (empty) high-level reservation"
);
ok(
  noHighLevelBundle.memoryDelta.includes("Project-only filler content"),
  "the full token budget is available to lower layers when no high-level hits exist"
);

// Cache-safe layout: stable prefix is unaffected by layer-priority ranking.
ok(
  layeredBundle.cacheablePrefix === claudeBundle.cacheablePrefix,
  "layer-priority ranking does not change the stable cache-safe prefix"
);

// --- PANT-834: scope precedence (env target repo before cwd basename) ---

const SCOPE_ENV = ["MNEMOSYNE_TARGET_REPO", "MNEMOSYNE_SCOPE", "MNEMOSYNE_ROLE", "MNEMOSYNE_CWD"];
function withScopeEnv(env, fn) {
  const saved = Object.fromEntries(SCOPE_ENV.map((k) => [k, process.env[k]]));
  for (const k of SCOPE_ENV) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const k of SCOPE_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}
const runnerCwd = "/home/node/multica_workspaces/x/pant-834/workdir";

ok(
  withScopeEnv({}, () => resolveScope({ cwd: runnerCwd })).scope === "top",
  "unknown cwd basename (workdir) falls back to top"
);
ok(
  withScopeEnv({ MNEMOSYNE_TARGET_REPO: "mdostal/janus" }, () => resolveScope({ cwd: runnerCwd })).scope === "janus",
  "env MNEMOSYNE_TARGET_REPO resolves an unmapped repo to its own scope"
);
ok(
  withScopeEnv({ MNEMOSYNE_TARGET_REPO: "mdostal/janus" }, () => resolveScope({ cwd: "/src/att" })).scope === "janus",
  "env MNEMOSYNE_TARGET_REPO wins over a known cwd basename"
);
ok(
  withScopeEnv({ MNEMOSYNE_TARGET_REPO: "mdostal/janus" }, () => resolveScope({ cwd: "/src/att", role: "developer" })).scope === "janus",
  "env MNEMOSYNE_TARGET_REPO wins over cwd for a developer role too"
);
ok(
  withScopeEnv({ MNEMOSYNE_TARGET_REPO: "mdostal/janus" }, () => resolveScope({ target_repo: "mdostal/heimdall" })).scope === "heimdall",
  "stdin target_repo wins over env MNEMOSYNE_TARGET_REPO"
);
ok(
  withScopeEnv({ MNEMOSYNE_SCOPE: "att", MNEMOSYNE_TARGET_REPO: "mdostal/janus" }, () => resolveScope({ cwd: "/src/arizona", role: "developer" })).scope === "att",
  "env MNEMOSYNE_SCOPE wins over target repo and cwd"
);
ok(
  withScopeEnv({ MNEMOSYNE_TARGET_REPO: "mdostal/janus" }, () => resolveScope({ scope: "clients" })).scope === "clients",
  "stdin scope still wins over everything"
);
ok(
  withScopeEnv({ MNEMOSYNE_TARGET_REPO: "mdostal/janus" }, () => resolveScope({ cwd: "/src/unknown-thing" })).scope === "janus" &&
    withScopeEnv({}, () => resolveScope({ cwd: "/src/unknown-thing" })).scope === "top",
  "an unmapped cwd basename never mints a scope; an explicit target repo does"
);

// --- PANT-834: prompt analysis ---

const runnerPreamble = [
  "You are running as a local coding agent for a Multica workspace.",
  "",
  "Your assigned issue ID is: 01a0e4d0-4e6e-7c42-91d4-dbd18fe2f508",
  "",
  "Start by running `multica issue get 01a0e4d0-4e6e-7c42-91d4-dbd18fe2f508 --output json` to understand your task, then complete it.",
].join("\n");
const boilerOnly = analyzePrompt(runnerPreamble);
ok(boilerOnly.query === "" && boilerOnly.boilerplate && !boilerOnly.meaningful, "runner preamble alone strips to an empty, non-meaningful query");
ok(
  boilerOnly.identifiers.length === 1 && boilerOnly.identifiers[0] === "01a0e4d0-4e6e-7c42-91d4-dbd18fe2f508",
  "issue uuid is extracted (once) from the runner preamble"
);
const plain = analyzePrompt("fix the login bug");
ok(plain.query === "fix the login bug" && !plain.boilerplate, "a plain prompt passes through untouched");
const ids = extractTicketIds("See PANT-834 and FFE-7, not UTF-8 or feat/ro-01; PANT-834 again");
ok(ids.join(",") === "PANT-834,FFE-7", "ticket keys are extracted and deduped, UTF-8 and lowercase branch names are not");

// --- PANT-834: keyword-only hits render the match type, not a null score ---

const nullScore = buildMemoryBundle(
  {
    total_hits: 2,
    scopes: [{
      scope: "top",
      hits: [
        { source: "a.md", chunk_index: 1, score: null, text: "grep hit with no match_type" },
        { source: "b.md", chunk_index: 2, score: null, match_type: "both", text: "both-path hit without a score" },
      ],
    }],
  },
  { scope: "top", role: "dev", ticket: "PANT-834" }
);
ok(!nullScore.memoryDelta.includes("score ?"), "null-score hits never render as `score ?`");
ok(/\[top · keyword\] a\.md/.test(nullScore.memoryDelta), "null-score hit without match_type renders as keyword");
ok(/\[top · both\] b\.md/.test(nullScore.memoryDelta), "null-score hit renders its match_type");

console.log(fails ? `\n${fails} check(s) failed` : "\nall bundle checks passed");
process.exit(fails ? 1 : 0);
