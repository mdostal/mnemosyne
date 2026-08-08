// format.mjs — turn recall results into the canonical Mnemosyne injection.
//
// Mathew's key insight: "Claude's memory is trash, it feeds WHOLE files."
// So this block feeds POINTERS, not files: each hit is an index entry with its
// layer (collection), a score, the file, and the LINE RANGE of the relevant
// chunk (chunk_span) — plus a short trimmed excerpt. The agent opens the file
// (or calls the memory tools) for full detail and can BUBBLE UP to other layers.

const EXCERPT_CHARS = Number(process.env.MNEMOSYNE_EXCERPT_CHARS || 320);
const DEFAULT_MEMORY_TOKEN_BUDGET = Number(
  process.env.MNEMOSYNE_MEMORY_TOKEN_BUDGET || 900
);
const DEFAULT_MAX_HITS = Number(process.env.MNEMOSYNE_MAX_HITS || 6);
const DEFAULT_HIGH_LEVEL_TOKEN_BUDGET = Number(
  process.env.MNEMOSYNE_HIGH_LEVEL_TOKEN_BUDGET || 300
);

export const CACHE_BREAKPOINT =
  "<!-- mnemosyne-cache-breakpoint: variable-ticket-memory-below -->";

// Layer stack (meta -> enterprise -> project -> vector -> file), narrowest
// number = highest priority. "Inject the high level first" — meta/enterprise
// hits are never crowded out by noisy low-level (vector/file) hits, even when
// the low-level hit scores higher. A hit with a missing/unrecognized layer is
// treated as the lowest-priority tier (file).
export const LAYER_PRIORITY = {
  meta: 0,
  enterprise: 1,
  project: 2,
  vector: 3,
  file: 4,
};
const HIGH_LEVEL_MAX_PRIORITY = LAYER_PRIORITY.enterprise;

function layerPriority(layer) {
  const key = String(layer || "").toLowerCase();
  return Object.prototype.hasOwnProperty.call(LAYER_PRIORITY, key)
    ? LAYER_PRIORITY[key]
    : LAYER_PRIORITY.file;
}

function isHighLevel(hit) {
  return layerPriority(hit.layer) <= HIGH_LEVEL_MAX_PRIORITY;
}

export function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

function trimExcerpt(text) {
  if (!text) return "";
  const oneLine = String(text).replace(/\s+/g, " ").trim();
  return oneLine.length > EXCERPT_CHARS
    ? oneLine.slice(0, EXCERPT_CHARS) + " …"
    : oneLine;
}

function lineRange(hit) {
  const span = hit.chunk_span;
  if (Array.isArray(span) && span.length === 2) return `lines ${span[0]}–${span[1]}`;
  if (hit.chunk_index != null) return `chunk ${hit.chunk_index}`;
  return "";
}

function stableCachePrefix(meta = {}) {
  const scope = meta.scope || "?";
  const sharedScope = meta.sharedScope || "top";
  const role = meta.role || "?";
  const url = meta.url || MNEMOSYNE_URL_PLACEHOLDER;

  return [
    `<!-- mnemosyne-cache-prefix-v1 scope=${scope} shared_scope=${sharedScope} role=${role} -->`,
    "## Mnemosyne Memory Injection",
    "This prefix is stable for this repo scope, shared scope, and role. Keep it byte-identical across ticket runs so provider prompt caches can reuse it.",
    "Layout: [stable cached prefix] + [small variable memory delta] + [ticket]. The variable delta starts after the cache breakpoint marker.",
    "Memory contract: use recalled memory as pointers with provenance, not as full source files. Open referenced files or call memory tools only when the pointer is relevant.",
    `Primary scope: ${scope}. Shared/global scope: ${sharedScope}. Memory tools: POST ${url}/recall and POST ${url}/remember.`,
  ].join("\n");
}

// mergeResults(...results) -> combined { scopes } from several recall/grep calls.
export function mergeResults(...results) {
  const scopes = [];
  for (const r of results) {
    if (r && Array.isArray(r.scopes)) scopes.push(...r.scopes);
  }
  return { scopes };
}

// Flatten scopes[].hits[] into a single ranked, DEDUPED list, tagged with layer.
// Ranked by (1) layer priority — meta/enterprise/project/vector/file, high
// level first — then (2) keyword (exact) hits, since they are high-confidence
// identifier matches (ticket IDs, tokens), then (3) semantic score descending.
// A high-scoring low-level hit is still ranked below a low-scoring high-level
// hit: a high-scoring file hit is less valuable than a low-scoring meta hit.
export function flattenHits(recallResult) {
  const out = [];
  const seen = new Set();
  for (const s of recallResult.scopes || []) {
    for (const h of s.hits || []) {
      const key = `${h.full_path || h.location || h.source}#${h.chunk_index ?? h.chunk_span}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...h, layer: h.layer || s.scope || h.collection });
    }
  }
  out.sort((a, b) => {
    const ap = layerPriority(a.layer);
    const bp = layerPriority(b.layer);
    if (ap !== bp) return ap - bp; // high-level layer first
    const ak = a.match_type === "keyword" ? 1 : 0;
    const bk = b.match_type === "keyword" ? 1 : 0;
    if (ak !== bk) return bk - ak; // keyword-exact first
    return (b.score || 0) - (a.score || 0);
  });
  return out;
}

function renderHit(h, index) {
  const src = h.source || h.location || h.full_path || "(unknown)";
  const range = lineRange(h);
  const conf =
    h.match_type === "keyword"
      ? "keyword-exact"
      : h.score != null
      ? `score ${h.score.toFixed(2)}`
      : "score ?";
  const candidate = [];
  candidate.push(`${index + 1}. [${h.layer} · ${conf}] ${src}${range ? " " + range : ""}`);
  const ex = trimExcerpt(h.text);
  if (ex) candidate.push(`   > ${ex}`);
  if (h.full_path) candidate.push(`   -> ${h.full_path}`);
  return candidate.join("\n");
}

// Fill `shown` from `segmentHits`, spending at most `segmentBudget` tokens on
// this segment (the first hit in a segment is always kept, even if it alone
// exceeds the segment budget, so a segment with hits is never shown empty).
function fillSegment(segmentHits, segmentBudget, max, shown) {
  let segmentTokens = 0;
  let skipped = 0;
  for (const h of segmentHits) {
    if (shown.length >= max) break;
    const candidateText = renderHit(h, shown.length);
    const candidateTokens = estimateTokens(candidateText);
    if (segmentTokens > 0 && segmentTokens + candidateTokens > segmentBudget) {
      skipped++;
      continue;
    }
    shown.push(candidateText);
    segmentTokens += candidateTokens;
  }
  return { segmentTokens, skipped };
}

function formatPriorMemoryDelta(recallResult, meta = {}) {
  const hits = flattenHits(recallResult);
  const max = Number(meta.max || DEFAULT_MAX_HITS);
  const tokenBudget = Number(meta.tokenBudget || DEFAULT_MEMORY_TOKEN_BUDGET);
  // Reserve a high-level (meta+enterprise) sub-budget so a handful of noisy
  // low-level (project/vector/file) hits never crowd it out entirely — but
  // cap it at that reservation so a busy meta layer can't consume the whole
  // budget either, leaving nothing for lower layers.
  const highLevelBudget = Math.min(
    Number(meta.highLevelTokenBudget || DEFAULT_HIGH_LEVEL_TOKEN_BUDGET),
    tokenBudget
  );

  const highLevelHits = hits.filter(isHighLevel);
  const lowLevelHits = hits.filter((h) => !isHighLevel(h));

  const shown = [];
  const highLevelResult = fillSegment(highLevelHits, highLevelBudget, max, shown);
  const lowLevelBudget = Math.max(tokenBudget - highLevelResult.segmentTokens, 0);
  const lowLevelResult = fillSegment(lowLevelHits, lowLevelBudget, max, shown);

  const highLevelTokens = highLevelResult.segmentTokens;
  const estimatedTokens = highLevelTokens + lowLevelResult.segmentTokens;
  const skippedForBudget = highLevelResult.skipped + lowLevelResult.skipped;

  if (shown.length === 0) {
    return {
      text: [
        `<!-- mnemosyne-variable-memory scope=${meta.scope || "?"} role=${meta.role || "?"} total_hits=${recallResult.total_hits ?? 0} ticket=${meta.ticket || "-"} -->`,
        `## Prior Memory Delta (Mnemosyne)`,
        `No prior memory matched this task. Use the memory tools to look more up`,
        `(POST ${meta.url || "/recall"}) or record a finding (POST /remember).`,
      ].join("\n"),
      highLevelTokens: 0,
    };
  }

  const lines = [];
  lines.push(
    `<!-- mnemosyne-variable-memory scope=${meta.scope || "?"} shared_scope=${meta.sharedScope || "top"} role=${meta.role || "?"} total_hits=${recallResult.total_hits ?? 0} shown=${shown.length} token_budget=${tokenBudget} ticket=${meta.ticket || "-"} -->`
  );
  lines.push(
    `## Prior Memory Delta (Mnemosyne recall — ${shown.length} hit${shown.length === 1 ? "" : "s"}${meta.escalate ? ", escalated" : ""})`
  );
  lines.push(
    `These are POINTERS with line ranges — not whole files. Open the file or call memory tools for full detail only when the pointer is relevant.`
  );
  lines.push("");
  lines.push(...shown);
  lines.push("");
  if (skippedForBudget) {
    lines.push(`Budget note: ${skippedForBudget} lower-ranked hit${skippedForBudget === 1 ? "" : "s"} omitted to keep the variable memory delta small.`);
  }
  lines.push(
    `memory-tools: recall more via POST ${meta.url || MNEMOSYNE_URL_PLACEHOLDER}/recall · record a finding via POST /remember (bubble up).`
  );
  return { text: lines.join("\n"), highLevelTokens };
}

export function buildMemoryBundle(recallResult, meta = {}) {
  const cacheablePrefix = stableCachePrefix(meta);
  const { text: memoryDelta, highLevelTokens } = formatPriorMemoryDelta(recallResult, meta);
  const text = [cacheablePrefix, CACHE_BREAKPOINT, memoryDelta].join("\n\n");
  return {
    text,
    cacheablePrefix,
    memoryDelta,
    cacheBreakpoint: CACHE_BREAKPOINT,
    promptLayout: "[stable cached prefix] + [small variable memory delta] + [ticket]",
    stats: {
      prefix_tokens_estimate: estimateTokens(cacheablePrefix),
      delta_tokens_estimate: estimateTokens(memoryDelta),
      total_tokens_estimate: estimateTokens(text),
      total_hits: recallResult.total_hits ?? 0,
      shown_hits: flattenHits(recallResult).slice(0, Number(meta.max || DEFAULT_MAX_HITS)).length,
      token_budget: Number(meta.tokenBudget || DEFAULT_MEMORY_TOKEN_BUDGET),
      high_level_tokens_estimate: highLevelTokens,
    },
  };
}

// formatPriorMemory(recallResult, meta) -> canonical markdown string.
export function formatPriorMemory(recallResult, meta = {}) {
  return buildMemoryBundle(recallResult, meta).text;
}

const MNEMOSYNE_URL_PLACEHOLDER = "http://127.0.0.1:8477";
