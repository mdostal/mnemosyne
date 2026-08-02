import { CACHE_BREAKPOINT, buildMemoryBundle } from "../hooks/lib/format.mjs";
import { resolveScope } from "../hooks/lib/scope.mjs";

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

console.log(fails ? `\n${fails} check(s) failed` : "\nall bundle checks passed");
process.exit(fails ? 1 : 0);
