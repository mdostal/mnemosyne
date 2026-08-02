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

export const CACHE_BREAKPOINT =
  "<!-- mnemosyne-cache-breakpoint: variable-ticket-memory-below -->";

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
// Keyword (exact) hits sort FIRST — they are high-confidence identifier matches
// (ticket IDs, tokens) — then semantic hits by score descending.
export function flattenHits(recallResult) {
  const out = [];
  const seen = new Set();
  for (const s of recallResult.scopes || []) {
    for (const h of s.hits || []) {
      const key = `${h.full_path || h.location || h.source}#${h.chunk_index ?? h.chunk_span}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...h, layer: s.scope || h.collection });
    }
  }
  out.sort((a, b) => {
    const ak = a.match_type === "keyword" ? 1 : 0;
    const bk = b.match_type === "keyword" ? 1 : 0;
    if (ak !== bk) return bk - ak; // keyword-exact first
    return (b.score || 0) - (a.score || 0);
  });
  return out;
}

function formatPriorMemoryDelta(recallResult, meta = {}) {
  const hits = flattenHits(recallResult);
  const max = Number(meta.max || DEFAULT_MAX_HITS);
  const tokenBudget = Number(meta.tokenBudget || DEFAULT_MEMORY_TOKEN_BUDGET);
  const shown = [];
  let estimatedTokens = 0;
  let skippedForBudget = 0;

  for (const h of hits) {
    if (shown.length >= max) break;
    const src = h.source || h.location || h.full_path || "(unknown)";
    const range = lineRange(h);
    const conf =
      h.match_type === "keyword"
        ? "keyword-exact"
        : h.score != null
        ? `score ${h.score.toFixed(2)}`
        : "score ?";
    const candidate = [];
    candidate.push(
      `${shown.length + 1}. [${h.layer} · ${conf}] ${src}${range ? " " + range : ""}`
    );
    const ex = trimExcerpt(h.text);
    if (ex) candidate.push(`   > ${ex}`);
    if (h.full_path) candidate.push(`   -> ${h.full_path}`);
    const candidateText = candidate.join("\n");
    const candidateTokens = estimateTokens(candidateText);
    if (shown.length > 0 && estimatedTokens + candidateTokens > tokenBudget) {
      skippedForBudget++;
      continue;
    }
    shown.push(candidateText);
    estimatedTokens += candidateTokens;
  }

  if (shown.length === 0) {
    return [
      `<!-- mnemosyne-variable-memory scope=${meta.scope || "?"} role=${meta.role || "?"} total_hits=${recallResult.total_hits ?? 0} ticket=${meta.ticket || "-"} -->`,
      `## Prior Memory Delta (Mnemosyne)`,
      `No prior memory matched this task. Use the memory tools to look more up`,
      `(POST ${meta.url || "/recall"}) or record a finding (POST /remember).`,
    ].join("\n");
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
  return lines.join("\n");
}

export function buildMemoryBundle(recallResult, meta = {}) {
  const cacheablePrefix = stableCachePrefix(meta);
  const memoryDelta = formatPriorMemoryDelta(recallResult, meta);
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
    },
  };
}

// formatPriorMemory(recallResult, meta) -> canonical markdown string.
export function formatPriorMemory(recallResult, meta = {}) {
  return buildMemoryBundle(recallResult, meta).text;
}

const MNEMOSYNE_URL_PLACEHOLDER = "http://127.0.0.1:8477";
