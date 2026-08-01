// format.mjs — turn a recall result into a compact "Prior Memory" block.
//
// Mathew's key insight: "Claude's memory is trash, it feeds WHOLE files."
// So this block feeds POINTERS, not files: each hit is an index entry with its
// layer (collection), a score, the file, and the LINE RANGE of the relevant
// chunk (chunk_span) — plus a short trimmed excerpt. The agent opens the file
// (or calls the memory tools) for full detail and can BUBBLE UP to other layers.

const EXCERPT_CHARS = Number(process.env.MNEMOSYNE_EXCERPT_CHARS || 320);

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

// formatPriorMemory(recallResult, {scope, escalate, role, max}) -> markdown string
export function formatPriorMemory(recallResult, meta = {}) {
  const hits = flattenHits(recallResult);
  const max = meta.max || 6;
  const shown = hits.slice(0, max);

  if (shown.length === 0) {
    return [
      `## Prior Memory (Mnemosyne — scope: ${meta.scope || "?"}, role: ${meta.role || "?"})`,
      `No prior memory matched this task. Use the memory tools to look more up`,
      `(POST ${meta.url || "/recall"}) or record a finding (POST /remember).`,
    ].join("\n");
  }

  const lines = [];
  lines.push(
    `## Prior Memory (Mnemosyne recall — scope: ${meta.scope}, role: ${meta.role}, ${shown.length} hit${shown.length === 1 ? "" : "s"}${meta.escalate ? ", escalated" : ""})`
  );
  lines.push(
    `These are POINTERS with line ranges — not whole files. Open the file (or call the memory tools) for full detail; you can look up more and BUBBLE UP to other layers.`
  );
  lines.push("");
  shown.forEach((h, i) => {
    const src = h.source || h.location || h.full_path || "(unknown)";
    const range = lineRange(h);
    const conf =
      h.match_type === "keyword"
        ? "keyword-exact"
        : h.score != null
        ? `score ${h.score.toFixed(2)}`
        : "score ?";
    lines.push(`${i + 1}. [${h.layer} · ${conf}] ${src}${range ? " " + range : ""}`);
    const ex = trimExcerpt(h.text);
    if (ex) lines.push(`   > ${ex}`);
    if (h.full_path) lines.push(`   ↳ ${h.full_path}`);
  });
  lines.push("");
  lines.push(
    `memory-tools: recall more via POST ${meta.url || MNEMOSYNE_URL_PLACEHOLDER}/recall · record a finding via POST /remember (bubble up).`
  );
  return lines.join("\n");
}

const MNEMOSYNE_URL_PLACEHOLDER = "http://127.0.0.1:8477";
