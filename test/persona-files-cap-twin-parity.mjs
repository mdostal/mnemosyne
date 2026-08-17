// persona-files-cap-twin-parity.mjs — TDD parity proof for
// pf-04-client-cap-twin: ui/app.js's new client-side twin of
// skills/mnemosyne-persona-interview/crawl-context.mjs's capExcerpt()/
// assembleSourceSummary() must produce byte-for-byte identical output to the
// real Node originals, given the same fixture input — not an approximate or
// visual comparison (pf-04-client-cap-twin.yaml acceptance criteria).
//
// Technique: matches this repo's own established convention (see
// test/personas-panel-shell.mjs) of extracting a plain-script function's
// source text via regex from ui/app.js (this file has no export mechanism —
// it is a non-ESM <script> loaded directly by ui/index.html) and exercising
// it directly via a real-execution technique (`new Function(...)`), rather
// than re-typing a second, hand-copied expectation that could silently
// diverge from what actually ships. The same extraction+real-execution
// technique is also applied to crawl-context.mjs's own assembleSourceSummary
// (module-private, not exported) so this test never needs to modify that
// file (pf-01's concurrent, unrelated work lives there) to get a real,
// callable reference to compare against — capExcerpt() and the three cap
// constants ARE exported already, so those are imported directly, no
// extraction needed for them.
//
// Usage: node test/persona-files-cap-twin-parity.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  capExcerpt as nodeCapExcerpt,
  MAX_LINES_PER_SOURCE as NODE_MAX_LINES_PER_SOURCE,
  MAX_CHARS_PER_SOURCE as NODE_MAX_CHARS_PER_SOURCE,
  MAX_SOURCE_SUMMARY_CHARS as NODE_MAX_SOURCE_SUMMARY_CHARS,
} from "../skills/mnemosyne-persona-interview/crawl-context.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CRAWL_CONTEXT_PATH = path.join(__dirname, "..", "skills", "mnemosyne-persona-interview", "crawl-context.mjs");
const APP_JS_PATH = path.join(__dirname, "..", "ui", "app.js");

let fails = 0;
const ok = (c, m) => { console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`); if (!c) fails++; };

// ---------------------------------------------------------------------------
// Step 1: get a REAL, callable Node-side assembleSourceSummary(), even though
// crawl-context.mjs does not export it. Extracted via regex from the actual
// on-disk source (never touched/modified), then constructed with
// `new Function(...)` so this is genuinely executing crawl-context.mjs's own
// bytes, not a re-typed reimplementation of them.
// ---------------------------------------------------------------------------
const crawlContextSrc = readFileSync(CRAWL_CONTEXT_PATH, "utf8");

const truncationMarkerMatch = crawlContextSrc.match(/const TRUNCATION_MARKER = (.*);/);
ok(!!truncationMarkerMatch, "extracted TRUNCATION_MARKER literal from crawl-context.mjs source");
const nodeTruncationMarkerLiteral = truncationMarkerMatch ? truncationMarkerMatch[1] : "''";

const nodeAssembleFnMatch = crawlContextSrc.match(/function assembleSourceSummary\([\s\S]*?\n\}\n/);
ok(!!nodeAssembleFnMatch, "extracted assembleSourceSummary() function body from crawl-context.mjs source");
const nodeAssembleFnSrc = nodeAssembleFnMatch ? nodeAssembleFnMatch[0] : "";

const nodeAssembleSourceSummary = new Function(
  "MAX_SOURCE_SUMMARY_CHARS",
  `const TRUNCATION_MARKER = ${nodeTruncationMarkerLiteral};\n${nodeAssembleFnSrc}\nreturn assembleSourceSummary;`,
)(NODE_MAX_SOURCE_SUMMARY_CHARS);
ok(typeof nodeAssembleSourceSummary === "function", "built a real, callable Node-side assembleSourceSummary()");

// ---------------------------------------------------------------------------
// Step 2: get REAL, callable client-side twins from ui/app.js, the same way
// -- extracted via regex from the served/on-disk content, then exercised
// directly, matching test/personas-panel-shell.mjs's own established
// extraction convention exactly.
// ---------------------------------------------------------------------------
const appJsSrc = readFileSync(APP_JS_PATH, "utf8");

function extractConst(name, src) {
  const m = src.match(new RegExp(`const ${name} = (.*);`));
  return m ? m[1] : undefined;
}

const uiMaxLinesLiteral = extractConst("MAX_LINES_PER_SOURCE", appJsSrc);
const uiMaxCharsLiteral = extractConst("MAX_CHARS_PER_SOURCE", appJsSrc);
const uiMaxSummaryLiteral = extractConst("MAX_SOURCE_SUMMARY_CHARS", appJsSrc);
const uiTruncationMarkerLiteral = extractConst("TRUNCATION_MARKER", appJsSrc);

ok(uiMaxLinesLiteral !== undefined, "ui/app.js declares a MAX_LINES_PER_SOURCE const");
ok(uiMaxCharsLiteral !== undefined, "ui/app.js declares a MAX_CHARS_PER_SOURCE const");
ok(uiMaxSummaryLiteral !== undefined, "ui/app.js declares a MAX_SOURCE_SUMMARY_CHARS const");
ok(uiTruncationMarkerLiteral !== undefined, "ui/app.js declares a TRUNCATION_MARKER const");

// --- constants parity: same VALUES as the Node originals, never hand-copied
// numbers that could silently drift (acceptance criterion #2) --------------
ok(Number(uiMaxLinesLiteral) === NODE_MAX_LINES_PER_SOURCE,
  `ui/app.js MAX_LINES_PER_SOURCE (${uiMaxLinesLiteral}) === Node original (${NODE_MAX_LINES_PER_SOURCE})`);
ok(Number(uiMaxCharsLiteral) === NODE_MAX_CHARS_PER_SOURCE,
  `ui/app.js MAX_CHARS_PER_SOURCE (${uiMaxCharsLiteral}) === Node original (${NODE_MAX_CHARS_PER_SOURCE})`);
ok(Number(uiMaxSummaryLiteral) === NODE_MAX_SOURCE_SUMMARY_CHARS,
  `ui/app.js MAX_SOURCE_SUMMARY_CHARS (${uiMaxSummaryLiteral}) === Node original (${NODE_MAX_SOURCE_SUMMARY_CHARS})`);
// Compare actual string VALUES, not raw literal source text -- the Node
// original uses single-quotes and ui/app.js uses double-quotes (matching
// each file's own prevailing quote-style convention), which is an
// immaterial source-formatting difference, not a value difference.
const uiTruncationMarkerValue = new Function(`return (${uiTruncationMarkerLiteral});`)();
const nodeTruncationMarkerValue = new Function(`return (${nodeTruncationMarkerLiteral});`)();
ok(uiTruncationMarkerValue === nodeTruncationMarkerValue,
  `ui/app.js TRUNCATION_MARKER value (${JSON.stringify(uiTruncationMarkerValue)}) === crawl-context.mjs's own (${JSON.stringify(nodeTruncationMarkerValue)})`);

const uiCapExcerptMatch = appJsSrc.match(/function capExcerpt\([\s\S]*?\n\}\n/);
ok(!!uiCapExcerptMatch, "extracted capExcerpt() function body from ui/app.js source");
const uiCapExcerptSrc = uiCapExcerptMatch ? uiCapExcerptMatch[0] : "";

const uiAssembleMatch = appJsSrc.match(/function assembleSourceSummary\([\s\S]*?\n\}\n/);
ok(!!uiAssembleMatch, "extracted assembleSourceSummary() function body from ui/app.js source");
const uiAssembleSrc = uiAssembleMatch ? uiAssembleMatch[0] : "";

const uiCapExcerpt = new Function(
  "MAX_LINES_PER_SOURCE",
  "MAX_CHARS_PER_SOURCE",
  `const TRUNCATION_MARKER = ${uiTruncationMarkerLiteral};\n${uiCapExcerptSrc}\nreturn capExcerpt;`,
)(Number(uiMaxLinesLiteral), Number(uiMaxCharsLiteral));
ok(typeof uiCapExcerpt === "function", "built a real, callable ui/app.js-side capExcerpt()");

const uiAssembleSourceSummary = new Function(
  "MAX_SOURCE_SUMMARY_CHARS",
  `const TRUNCATION_MARKER = ${uiTruncationMarkerLiteral};\n${uiAssembleSrc}\nreturn assembleSourceSummary;`,
)(Number(uiMaxSummaryLiteral));
ok(typeof uiAssembleSourceSummary === "function", "built a real, callable ui/app.js-side assembleSourceSummary()");

// ---------------------------------------------------------------------------
// Step 3: acceptance criterion #3 -- pf-05-ui-file-attachment has now wired
// these functions into personaForm's submit handler (test/persona-write-
// form.mjs is the dedicated, dynamic proof of that wiring's actual runtime
// behavior) -- so the invariant here changes from "never called" to
// "called from exactly one real call site (the submit handler), beyond
// each function's own definition."
// ---------------------------------------------------------------------------
// Strip comments (JSDoc/// prose legitimately mentions "capExcerpt()" /
// "assembleSourceSummary()" by name several times -- that's documentation,
// not a call site) before counting real code occurrences. Line comments
// MUST be stripped before block comments: this file's own ui/app.js has at
// least one `//` line comment whose PROSE contains a literal "/*"
// substring (e.g. "for /persona/*,"), which would otherwise make the
// block-comment regex (run first) swallow everything up to the next real
// "*/" -- silently eating real code, not just comments, in between.
function stripJsComments(src) {
  return src
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}
const appJsCodeOnly = stripJsComments(appJsSrc);

const capExcerptCallCount = (appJsCodeOnly.match(/\bcapExcerpt\(/g) || []).length;
const capExcerptDefCount = (appJsCodeOnly.match(/function capExcerpt\(/g) || []).length;
ok(capExcerptCallCount === capExcerptDefCount + 1,
  `pf-05: capExcerpt() has exactly one real call site beyond its own definition (${capExcerptDefCount} def, ${capExcerptCallCount} total code occurrences of "capExcerpt(") -- the submit handler's file-attachment wiring, never a second one`);

const assembleCallCount = (appJsCodeOnly.match(/\bassembleSourceSummary\(/g) || []).length;
const assembleDefCount = (appJsCodeOnly.match(/function assembleSourceSummary\(/g) || []).length;
ok(assembleCallCount === assembleDefCount + 1,
  `pf-05: assembleSourceSummary() has exactly one real call site beyond its own definition (${assembleDefCount} def, ${assembleCallCount} total code occurrences of "assembleSourceSummary(") -- the submit handler's file-attachment wiring, never a second one`);

// ---------------------------------------------------------------------------
// Step 4: the actual parity fixtures -- same input, both real
// implementations, byte-for-byte identical output (acceptance criterion #1).
// Mirrors lib/mnemosyne/layer1/__tests__/persona-interview-crawl.test.ts's
// own known cases (oversized-source truncation, pathologically-long-line
// char cap) plus capExcerpt()'s own boundary cases.
// ---------------------------------------------------------------------------
function assertCapExcerptParity(label, raw) {
  const nodeResult = nodeCapExcerpt(raw);
  const uiResult = uiCapExcerpt(raw);
  ok(uiResult.excerpt === nodeResult.excerpt, `capExcerpt() parity [${label}]: excerpt strings are byte-for-byte identical`);
  ok(uiResult.truncated === nodeResult.truncated, `capExcerpt() parity [${label}]: truncated flag matches (${nodeResult.truncated})`);
  ok(JSON.stringify(uiResult) === JSON.stringify(nodeResult), `capExcerpt() parity [${label}]: full result object is byte-for-byte identical`);
}

// Case 1: short, untouched text -- well under both caps, no truncation.
assertCapExcerptParity("short text, no truncation", "hello\nworld\nthis is a short fixture.");

// Case 2: empty string.
assertCapExcerptParity("empty string", "");

// Case 3: exactly MAX_LINES_PER_SOURCE lines -- boundary, must NOT truncate by lines.
const exactlyAtLineCap = Array.from({ length: NODE_MAX_LINES_PER_SOURCE }, (_, i) => `line ${i}`).join("\n");
assertCapExcerptParity("exactly at line cap (no truncation)", exactlyAtLineCap);

// Case 4: one line over MAX_LINES_PER_SOURCE -- must truncate by lines.
const oneOverLineCap = Array.from({ length: NODE_MAX_LINES_PER_SOURCE + 1 }, (_, i) => `line ${i}`).join("\n");
assertCapExcerptParity("one line over the line cap", oneOverLineCap);

// Case 5: oversized source, 500 lines (mirrors the Node test's own oversized-README case).
const oversized = Array.from({ length: 500 }, (_, i) => `LINE_${String(i).padStart(4, "0")}_MARKER content here.`).join("\n");
assertCapExcerptParity("oversized 500-line source", oversized);

// Case 6: a single pathologically long line -- must be capped by
// MAX_CHARS_PER_SOURCE, not just the line cap.
const longLine = "X".repeat(NODE_MAX_CHARS_PER_SOURCE * 4);
assertCapExcerptParity("single pathologically long line", longLine);

// Case 7: mixed content with CRLF line endings -- capExcerpt splits on /\r?\n/.
const crlfContent = "alpha\r\nbeta\r\ngamma\r\n" + "delta\r\n".repeat(50);
assertCapExcerptParity("CRLF line endings", crlfContent);

// Case 8: unicode/multibyte content (e.g. em dashes, emoji) -- char-length
// truncation must behave identically (JS string .length semantics).
const unicodeContent = "emoji test \u{1F600}\u{1F601}\u{1F602} — em dash — ".repeat(100);
assertCapExcerptParity("unicode/multibyte content", unicodeContent);

function assertAssembleParity(label, sourcesRead, sourcesMissing) {
  const nodeResult = nodeAssembleSourceSummary(sourcesRead, sourcesMissing);
  const uiResult = uiAssembleSourceSummary(sourcesRead, sourcesMissing);
  ok(uiResult === nodeResult, `assembleSourceSummary() parity [${label}]: byte-for-byte identical string output`);
}

// Case A: zero sources read -- the "none of the named sources present" branch.
assertAssembleParity("zero sources present", [], ["README", "package/project manifest", "CLAUDE.md", "AGENTS.md"]);

// Case B: a couple of small sources, well under MAX_SOURCE_SUMMARY_CHARS -- no truncation.
assertAssembleParity(
  "small sources, no truncation",
  [
    { name: "README.md", ...nodeCapExcerpt("README_MARKER — this repo does X.") },
    { name: "package.json", ...nodeCapExcerpt('{"name":"PACKAGE_MARKER-repo"}') },
  ],
  [],
);

// Case C: sources whose combined assembled text exceeds MAX_SOURCE_SUMMARY_CHARS
// -- the whole-string cap must trigger identically in both implementations.
const bigSources = Array.from({ length: 6 }, (_, i) => ({
  name: `source-${i}.md`,
  ...nodeCapExcerpt(`SOURCE_${i}_MARKER — ` + "filler content ".repeat(60)),
}));
assertAssembleParity("combined sources exceed MAX_SOURCE_SUMMARY_CHARS", bigSources, []);

// Case D: a parent-persona-summary-shaped single source.
assertAssembleParity(
  "single parent-persona-summary-shaped source",
  [{ name: "parent persona summary (project-orchestrator/demo)", ...nodeCapExcerpt("Parent persona (project-orchestrator/demo) — displayName: Demo; scope: Demo scope.") }],
  ["README", "package/project manifest"],
);

console.log(fails ? `\n${fails} check(s) failed` : "\nall persona-files-cap-twin-parity checks passed");
process.exit(fails ? 1 : 0);
