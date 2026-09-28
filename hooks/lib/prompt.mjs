// prompt.mjs — turn a raw hook prompt into a recall query + ticket identifiers.
//
// Agent runners (Multica today) wrap every turn in the same boilerplate
// preamble: "You are running as a local coding agent ... Your assigned issue ID
// is: <uuid> ... Start by running `multica issue get ...`". Used verbatim as a
// semantic query, that preamble recalls the same irrelevant hits on every turn.
// So: pull identifiers out first, strip known runner lines, and let the caller
// skip semantic recall when nothing task-specific is left.
//
// Pure string work — no network, no env beyond what the caller passes.

// Known runner preamble lines. Each pattern matches a whole line (after trim).
// Add a runner's lines here rather than special-casing it in pre-recall.
export const RUNNER_BOILERPLATE = [
  // Multica local agent runner
  /^You are running as a local coding agent for a Multica workspace\.?$/i,
  /^Your assigned issue ID is:?\s*\S+\.?$/i,
  /^Start by running `multica issue get [^`]*`.*$/i,
  /^For comment history, workflow step \d+ applies\..*$/i,
];

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// PANT-834, PAN-6443, FFE-7. Not preceded by a word char/dash so the tail of a
// uuid or a branch like feat/ro-01 (lowercase anyway) doesn't match.
const TICKET_KEY_RE = /(?<![\w-])[A-Z][A-Z0-9]{1,9}-\d+\b/g;
// Upper-case tokens that look like ticket keys but aren't.
const NOT_TICKET_PREFIXES = new Set(["UTF", "SHA", "ISO", "RFC", "CVE", "HTTP", "TLS", "SSL", "MD", "X"]);

export const MAX_IDENTIFIERS = 5;

// extractTicketIds(text) -> ordered, deduped ids: ticket keys first, then uuids.
export function extractTicketIds(text) {
  const src = String(text || "");
  const ids = [];
  const seen = new Set();
  const add = (id) => {
    const key = id.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    ids.push(id);
  };
  for (const m of src.matchAll(TICKET_KEY_RE)) {
    const prefix = m[0].slice(0, m[0].indexOf("-"));
    if (!NOT_TICKET_PREFIXES.has(prefix)) add(m[0]);
  }
  for (const m of src.matchAll(UUID_RE)) add(m[0].toLowerCase());
  return ids.slice(0, MAX_IDENTIFIERS);
}

// stripRunnerBoilerplate(text) -> { text, stripped } where `stripped` counts
// the removed preamble lines.
export function stripRunnerBoilerplate(text) {
  let stripped = 0;
  const kept = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trim();
    if (t && RUNNER_BOILERPLATE.some((re) => re.test(t))) {
      stripped++;
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n").trim(), stripped };
}

// A query is meaningful when it has some actual words left once identifiers
// are removed — a bare uuid or ticket key goes to keyword recall instead.
export function isMeaningfulQuery(text) {
  const words = String(text || "")
    .replace(UUID_RE, " ")
    .match(/[A-Za-z]{3,}/g);
  return !!words && words.length >= 2;
}

// analyzePrompt(raw) -> { query, identifiers, boilerplate, meaningful }
export function analyzePrompt(raw) {
  const identifiers = extractTicketIds(raw);
  const { text, stripped } = stripRunnerBoilerplate(raw);
  return {
    query: text,
    identifiers,
    boilerplate: stripped > 0,
    meaningful: isMeaningfulQuery(text),
  };
}
