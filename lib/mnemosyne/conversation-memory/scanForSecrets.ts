/**
 * cm-01-secret-credential-scanner (epic: mnemosyne-conversation-memory).
 *
 * The single highest-blast-radius piece of this epic (docs/design-
 * discussion.md §2.8, §3), held to `ro-11`'s SSRF-guard rigor EXACTLY: a
 * firm, default-on, no-bypass-anywhere detector for API-key-shaped tokens,
 * bearer tokens, PEM private-key blocks, and connection strings with
 * embedded credentials, run over conversation content BEFORE it is ever
 * handed to an LLM classification call (`cm-05`) or a `remember()` persist
 * call (`cm-07`).
 *
 * This is a PURE module — no I/O, no network, no persistence, no dependency
 * on any other story in this epic. Every other new module in this epic
 * (`cm-03`, `cm-04`, `cm-07`) imports and calls this ONE exported function
 * (`scanForSecrets`); no story reimplements its own copy (design-
 * discussion.md `[grill 4.1]`).
 *
 * ---------------------------------------------------------------------------
 * THE NO-BYPASS POSTURE (mirrors `crawlAndIngest.ts`'s SSRF guard almost
 * verbatim, applied to detected-secret content instead of a resolved IP
 * address).
 * ---------------------------------------------------------------------------
 * FIRM and default-on. The exported function below takes exactly ONE
 * parameter — the text to scan — and returns EVERY match it finds. There is
 * no second "options" parameter, no per-category on/off switch, no
 * environment-variable read, and no config file anywhere in this module that
 * could suppress or skip detection for any category, for any input, under
 * any circumstance. This is intentional and load-bearing, not an oversight
 * to "fix" later. A caller that wants to act differently on a given category
 * does so by INSPECTING the returned matches, never by asking this function
 * to not look for something.
 *
 * Explicit non-goals (never hand-waved — see the story's own description):
 *  - Not a general-purpose static-analysis/SAST secret scanner. No
 *    external tool (gitleaks/trufflehog/etc) is integrated or depended on in
 *    this first cut — confirmed via a repo-wide `package.json` check that no
 *    such dependency already exists (this is genuinely new code, matching
 *    `ro-11`'s own "no existing precedent" discipline for its SSRF guard).
 *  - NOT guaranteed to catch every possible secret shape. Real coverage is a
 *    measured, reported number from `scanForSecrets.test.ts`'s own fixture
 *    corpus (false-negative/false-positive rate) — never claimed as "100%
 *    safe" anywhere in this module or its docs.
 *  - Does NOT decide retention/access policy for content this function flags
 *    — this module detects and reports; what a caller does with a match
 *    (quarantine, redact-and-continue, hard-reject) is that caller's own,
 *    separate, explicit decision (open question #4, docs/design-
 *    discussion.md §5).
 *
 * ---------------------------------------------------------------------------
 * Redaction discipline.
 * ---------------------------------------------------------------------------
 * `SecretMatch.preview` NEVER contains the raw matched secret value — not a
 * truncated prefix of it, not any substring of its high-entropy portion.
 * For `api-key` and `bearer-token` matches, the preview is built from FIXED,
 * static strings only (category name, pattern name, character count, line
 * number) — zero characters of the actual match are copied into it. For
 * `pem-private-key` matches, the preview is likewise built from the
 * (non-secret) BEGIN/END header label plus counts only. For
 * `connection-string` matches, the preview reproduces the non-credential
 * parts of the string (scheme, host, port, path) verbatim — genuinely useful
 * for triage — but the `user:password` userinfo portion is always replaced
 * with the fixed literal `[REDACTED]`, never any part of the real value.
 * `scanForSecrets.test.ts` asserts this directly: the exact fixture secret
 * value never appears verbatim anywhere in `scanForSecrets()`'s own output.
 * ---------------------------------------------------------------------------
 */

/** Broad category a match belongs to. Every match also names a more specific `pattern` within its category. */
export type SecretCategory = 'api-key' | 'bearer-token' | 'pem-private-key' | 'connection-string';

export interface SecretMatch {
  /** Broad category this match belongs to. */
  category: SecretCategory;
  /** Specific pattern name recognized within that category (e.g. `'aws-access-key-id'`). */
  pattern: string;
  /** 1-based line number within the input text where the match starts — a rough, human-usable location. */
  line: number;
  /** 0-based character offset within the input text where the match starts. */
  index: number;
  /** Length in characters of the raw matched text (reported for triage; the characters themselves are never exposed). */
  length: number;
  /** Redacted, human-readable summary. Never contains the raw secret value — see module doc comment above. */
  preview: string;
}

// ---------------------------------------------------------------------------
// Pattern tables. Adding a new shape means adding a new entry here — never a
// second, parallel copy of the scanning logic elsewhere in this repo (see
// module doc comment / AC7: cm-03/cm-04/cm-07 all import and call this one
// function).
// ---------------------------------------------------------------------------

interface SimplePattern {
  id: string;
  category: SecretCategory;
  regex: RegExp;
}

/** API-key-shaped tokens: a fixed, recognizable, non-secret prefix followed by a high-entropy suffix. */
const API_KEY_PATTERNS: readonly SimplePattern[] = [
  { id: 'openai-or-anthropic-sk-key', category: 'api-key', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'aws-access-key-id', category: 'api-key', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'github-token', category: 'api-key', regex: /\bgh[pousr]_[A-Za-z0-9]{36}\b/g },
  { id: 'slack-token', category: 'api-key', regex: /\bxox[bp]-[A-Za-z0-9-]{10,72}\b/g },
];

/** Bearer/session tokens: an `Authorization: Bearer <token>` header, or a standalone JWT (three dot-separated base64url segments). */
const BEARER_TOKEN_PATTERNS: readonly SimplePattern[] = [
  { id: 'authorization-bearer-header', category: 'bearer-token', regex: /\bBearer\s+[A-Za-z0-9\-_.=+/]{20,}/g },
  { id: 'jwt-bearer-token', category: 'bearer-token', regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
];

/** PEM private-key blocks — BEGIN/END markers must match (same header label on both ends). */
const PEM_PRIVATE_KEY_RE = /-----BEGIN ((?:[A-Z0-9]+ )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/g;

/**
 * Connection strings with embedded credentials: `scheme://user:password@host[...]`.
 * Requires BOTH a `user:password` pair (colon-separated) AND an `@host` —
 * a bare `scheme://host:port/path` (no `@`) or `scheme://user@host` (no
 * password) never matches, keeping ordinary URLs out of this category.
 */
const CONNECTION_STRING_RE = /\b([a-zA-Z][a-zA-Z0-9+.-]{1,15}):\/\/([^\s:@/]{1,200}):([^\s@/]{1,200})@([^\s/?#]{1,255})(\/[^\s]*)?/g;

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface RawMatch {
  category: SecretCategory;
  pattern: string;
  index: number;
  length: number;
  preview: string;
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

/** Builds a preview for `api-key`/`bearer-token`/`pem-private-key` matches: fixed strings and counts only, zero characters copied from the raw match. */
function genericPreview(category: SecretCategory, pattern: string, length: number, line: number): string {
  return `[REDACTED ${category}:${pattern}] (${length} chars, line ${line}) — raw value withheld`;
}

function collectSimplePatterns(text: string, patterns: readonly SimplePattern[], out: RawMatch[]): void {
  for (const p of patterns) {
    const re = new RegExp(p.regex.source, p.regex.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const raw = m[0];
      out.push({
        category: p.category,
        pattern: p.id,
        index: m.index,
        length: raw.length,
        preview: genericPreview(p.category, p.id, raw.length, lineNumberAt(text, m.index)),
      });
      // Zero-length matches can't happen with these patterns (all require
      // >=1 char), but guard against an infinite loop regardless.
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  }
}

function collectPemBlocks(text: string, out: RawMatch[]): void {
  const re = new RegExp(PEM_PRIVATE_KEY_RE.source, PEM_PRIVATE_KEY_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const headerLabel = m[1]!.trim().toLowerCase().replace(/\s+/g, '-');
    const patternId = `pem-${headerLabel}`;
    out.push({
      category: 'pem-private-key',
      pattern: patternId,
      index: m.index,
      length: raw.length,
      preview: genericPreview('pem-private-key', patternId, raw.length, lineNumberAt(text, m.index)),
    });
    if (re.lastIndex === m.index) re.lastIndex++;
  }
}

function collectConnectionStrings(text: string, out: RawMatch[]): void {
  const re = new RegExp(CONNECTION_STRING_RE.source, CONNECTION_STRING_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const scheme = m[1]!;
    const hostAndPort = m[4]!;
    const path = m[5] ?? '';
    const preview = `${scheme}://[REDACTED]@${hostAndPort}${path} (connection-string, ${raw.length} chars, line ${lineNumberAt(text, m.index)}) — credentials withheld`;
    out.push({
      category: 'connection-string',
      pattern: 'scheme-userinfo-credentials',
      index: m.index,
      length: raw.length,
      preview,
    });
    if (re.lastIndex === m.index) re.lastIndex++;
  }
}

/** True if `[aIndex, aIndex+aLength)` fully contains `[bIndex, bIndex+bLength)`. */
function contains(aIndex: number, aLength: number, bIndex: number, bLength: number): boolean {
  return aIndex <= bIndex && aIndex + aLength >= bIndex + bLength;
}

/**
 * Removes matches whose span is fully contained within another match's span
 * (e.g. a JWT found both by the generic `Bearer <token>` pattern and the
 * standalone JWT pattern when a header literally reads `Bearer eyJ...`) —
 * keeps the outer/longer match. This is de-duplication of overlapping
 * detections, never a suppression of a category: every distinct secret still
 * produces at least one match.
 */
function dedupeContained(matches: RawMatch[]): RawMatch[] {
  const sorted = [...matches].sort((a, b) => a.index - b.index || b.length - a.length);
  const kept: RawMatch[] = [];
  for (const m of sorted) {
    const isContained = kept.some((k) => contains(k.index, k.length, m.index, m.length));
    if (!isContained) kept.push(m);
  }
  return kept.sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
// Public API — the ONE exported function every other module in this epic
// calls. Exactly one required parameter; no options, no flags, no bypass.
// ---------------------------------------------------------------------------

/**
 * Scans `text` for API-key-shaped tokens, bearer/session tokens, PEM
 * private-key blocks, and connection strings with embedded credentials.
 * Returns every match found — an empty array means nothing was detected,
 * never a signal that scanning was skipped (this function performs no I/O
 * and cannot fail/throw for any input string; a non-string input is a
 * programmer error and throws immediately, per `loud-failure`).
 *
 * Pure and synchronous: no network, no filesystem, no dependency on any
 * other module in this epic.
 */
export function scanForSecrets(text: string): SecretMatch[] {
  if (typeof text !== 'string') {
    throw new TypeError(`scanForSecrets: expected a string, got ${typeof text}`);
  }

  const raw: RawMatch[] = [];
  collectSimplePatterns(text, API_KEY_PATTERNS, raw);
  collectSimplePatterns(text, BEARER_TOKEN_PATTERNS, raw);
  collectPemBlocks(text, raw);
  collectConnectionStrings(text, raw);

  return dedupeContained(raw).map((m) => ({
    category: m.category,
    pattern: m.pattern,
    line: lineNumberAt(text, m.index),
    index: m.index,
    length: m.length,
    preview: m.preview,
  }));
}
