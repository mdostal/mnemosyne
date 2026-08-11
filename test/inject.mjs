import { inject } from "../src/inject.mjs";
import { CACHE_BREAKPOINT, estimateTokens } from "../hooks/lib/format.mjs";

let fails = 0;
const ok = (condition, message) => {
  console.log(`${condition ? "  PASS" : "  FAIL"}  ${message}`);
  if (!condition) fails++;
};

const ticket = {
  identifier: "PAN-7192",
  title: "pre-hook recall inject MVP",
  description: "Call recall(ticket-topic, repo-scope) and return a small cache-safe context block.",
};

const recallCalls = [];
const recall = async (query, scope, opts) => {
  recallCalls.push({ query, scope, opts });
  return {
    total_hits: 4,
    scopes: [
      {
        scope,
        hits: [
          {
            source: "z-later.md",
            full_path: "/repo/z-later.md",
            chunk_span: [1, 2],
            score: 0.5,
            text: "Same-score hit that should sort after a.md.",
          },
          {
            source: "a-first.md",
            full_path: "/repo/a-first.md",
            chunk_span: [1, 2],
            score: 0.5,
            text: "Same-score hit that should sort before z.md.",
          },
          {
            source: "high.md",
            full_path: "/repo/high.md",
            chunk_span: [3, 5],
            score: 0.9,
            text: "Top semantic recall hit for the ticket topic.",
          },
          {
            source: "verbose.md",
            full_path: "/repo/verbose.md",
            chunk_span: [10, 20],
            score: 0.1,
            text: "Verbose lower-ranked recall content. ".repeat(120),
          },
        ],
      },
    ],
  };
};

const block = await inject(ticket, "mnemosyne", {
  recall,
  tokenBudget: 440,
  hits: 4,
  url: "http://127.0.0.1:8477",
});

ok(recallCalls.length === 1, "inject calls recall exactly once");
ok(
  recallCalls[0].query.includes("PAN-7192") &&
    recallCalls[0].query.includes("pre-hook recall inject MVP"),
  "inject recalls by ticket topic"
);
ok(recallCalls[0].scope === "mnemosyne", "inject recalls within the repo scope");
ok(recallCalls[0].opts.hits === 4, "inject requests the configured top-K hit count");

ok(block.includes("## Mnemosyne Memory Injection"), "context block is clearly labeled");
ok(block.includes(CACHE_BREAKPOINT), "context block has a cache breakpoint after the stable prefix");
ok(
  block.indexOf("PAN-7192") > block.indexOf(CACHE_BREAKPOINT),
  "ticket-specific text stays after the stable cache prefix"
);
ok(block.includes("high.md"), "recall hit is included in the injectable context block");
ok(
  estimateTokens(block) <= 440,
  "inject returns a context block within the configured token budget"
);
ok(!block.includes("verbose.md"), "lower-ranked hits are omitted to honor the token budget");
ok(
  block.indexOf("a-first.md") < block.indexOf("z-later.md"),
  "same-score hits render in deterministic source order"
);

console.log(fails ? `\n${fails} check(s) failed` : "\nall inject checks passed");
process.exit(fails ? 1 : 0);
