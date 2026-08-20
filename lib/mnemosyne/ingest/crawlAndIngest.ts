/**
 * ro-11-bounded-website-crawl (epic: mnemosyne-repo-onboarding).
 *
 * Amendment story (design-discussion.md §7.3, firmed up in §7.9), deliberately
 * isolated from `ro-10` and held to the SAME rigor as `ro-06` per the
 * operator's own instruction. Closes the "crawl website" third of the
 * operator's ask: fetches a given URL (default: EXACTLY that one page — same-
 * domain multi-page crawling is a separate, explicit opt-in, hard-capped even
 * when used), extracts best-effort text, and feeds it through `ro-10`'s
 * `ingestDocument()` UNCHANGED — never a second, parallel storage/ingestion
 * mechanism.
 *
 * Explicit non-goals (never hand-waved):
 *  - Not a general-purpose web scraper/spider.
 *  - Not unbounded or recursive crawling by default.
 *  - Not able to authenticate, inject credentials, use cookies, or otherwise
 *    bypass any access control — plain, unauthenticated GET only; 401/403
 *    fails loudly, never worked around.
 *  - Not a scheduled/background crawler — one bounded, on-demand call.
 *  - Not a readability/content-extraction engine — naive tag-stripping only
 *    (R10, design-discussion.md §7.6): no HTML-parsing dependency exists in
 *    this codebase today (confirmed via package.json), so extraction quality
 *    is a named, accepted limitation, not silently promised as high-fidelity.
 *
 * Real research first, not assumed: this codebase already uses the Node 20+
 * global `fetch()` repeatedly (`server.ts:248`, `bin/mnemosyne-reindex.mjs:39`,
 * `bin/mnemosyne-skill-helper.mjs:104/122/195`,
 * `bin/mnemosyne-install-hooks:108`) with `AbortController`/`signal`-based
 * timeouts — this module reuses that exact pattern (see `guardedFetch` below)
 * rather than inventing a new HTTP-client convention. `node:dns`/`node:net`
 * have NO existing precedent anywhere in this repo (confirmed via a
 * repo-wide grep) — the SSRF guard below is genuinely new code.
 *
 * ---------------------------------------------------------------------------
 * THE SSRF GUARD (design-discussion.md §7.9.2, the operator's own words:
 * "SSRF, lets put a guard in place unless that blocks something explicitly").
 * ---------------------------------------------------------------------------
 * FIRM and default-on. No flag, option, or environment variable exists
 * anywhere in this module to bypass it, for any target, under any
 * circumstance — this is intentional and load-bearing, not an oversight to
 * "fix" later. The target hostname is resolved (or, for a literal IP
 * hostname, parsed directly — no DNS round-trip needed) and the resolved
 * address is checked against a fixed blocked-range list BEFORE any fetch is
 * attempted; a match fails loudly, naming the SPECIFIC matched range. Blocked
 * ranges: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
 * 169.254.0.0/16 (includes the 169.254.169.254 cloud-metadata address), ::1,
 * fc00::/7, fe80::/10.
 *
 * The guard re-resolves and re-checks IMMEDIATELY BEFORE EVERY INDIVIDUAL
 * fetch this module makes (the robots.txt fetch, and each page fetch of a
 * multi-page crawl) — never once per whole `crawlAndIngest()` call and
 * cached/trusted for later requests. `guardedFetch()` below is the ONLY
 * function in this module that ever calls `fetchImpl` — every call site goes
 * through it, so the guard can never be raced or skipped.
 *
 * Redirects (HTTP 3xx) are deliberately NOT followed (`redirect: 'manual'`
 * below) — automatically following a redirect would create a brand-new
 * fetch to a location this module never SSRF-checked, reopening exactly the
 * gap the guard exists to close. A redirect response fails loudly instead,
 * naming the target and the unfollowed Location — a first-cut scope
 * limitation (real-world sites that 301 http->https or www<->non-www will
 * need the caller to retry with the final URL directly), never a silent
 * bypass.
 *
 * Named, accepted residual risk (R13, grill round 3, finding 3.3.1 — NOT
 * silently treated as solved): resolving a hostname via DNS and then making
 * a SEPARATE `fetch()` call afterward has an inherent TOCTOU gap — a
 * malicious/rebinding DNS server could return a public IP for the guard's
 * own resolve-and-check and a different, private-range IP for `fetch()`'s
 * own internal resolution at actual connect time. A full fix (pinning the
 * exact validated socket address while still presenting the correct hostname
 * for TLS SNI) requires connection-level control this module's "first cut"
 * (plain global `fetch()`, no custom dispatcher) does not have. This
 * module's mitigation — re-running the guard before EVERY individual fetch,
 * not once per crawl — narrows but does not eliminate the single-request
 * window; a full fix is a genuine, separate follow-on.
 *
 * ---------------------------------------------------------------------------
 * robots.txt (real, testable politeness — not "best effort").
 * ---------------------------------------------------------------------------
 * Fetched and checked BEFORE any page fetch — a disallowed path is never
 * fetched, and the call fails loudly naming the disallow. The parser below
 * is deliberately MINIMAL (research-step scope decision, per the story's own
 * `research` step): it understands only `User-agent: *` groups' `Disallow`
 * lines (simple path-prefix matching, no `Allow` precedence, no wildcard/`$`
 * matching, no `Crawl-delay`) — a real, testable disallow check, not a full
 * spec-compliant parser. A robots.txt that itself 404s, or any non-200
 * robots.txt response, or a genuine network failure/timeout fetching it, is
 * treated as "no restrictions found" (the common, expected crawler
 * convention for a missing robots.txt) — EXCEPT an SSRF-guard rejection of
 * the robots.txt fetch itself, which always propagates as a real, loud
 * failure (the guard is never silently swallowed, for any fetch, for any
 * reason).
 *
 * ---------------------------------------------------------------------------
 * Named, accepted risk (R11, NOT solved here — design-discussion.md §7.6):
 * repeated crawls of the same URL create new, additive chunks each time
 * (`remember()`'s vector write path is `--no-prune` by design) — unbounded
 * storage growth from repeat crawls is a real risk, deferred to whoever
 * eventually builds dedup/staleness handling.
 * ---------------------------------------------------------------------------
 *
 * Scope decision (first cut, not a recursive spider): multi-page crawling
 * only follows same-domain links discovered on the INITIAL page — it never
 * recursively crawls links found on page 2..N. Combined with the hard
 * `MAX_CRAWL_PAGES` cap, this keeps the blast radius small and bounded,
 * matching the "not a general-purpose web scraper/spider" non-goal.
 */

import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { ingestDocument, MAX_INGEST_BYTES, type IngestClient, type IngestDocumentResult } from './ingestDocument.js';
import type { Scope } from '../interfaces.js';

// ---------------------------------------------------------------------------
// Named caps (every cap enforced in code, not just documented — mirrors
// `ingestDocument.ts`'s own discipline).
// ---------------------------------------------------------------------------

/** Per-request timeout (AbortController/signal, matching `bin/mnemosyne-skill-helper.mjs`'s established pattern). */
export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Real, enforced minimum delay between successive same-host requests when
 * multi-page crawling is opted into. Measured directly against real
 * timestamps in this module's own test suite — never merely present in code
 * and untested.
 */
export const MIN_REQUEST_DELAY_MS = 250;

/**
 * Hard ceiling on total pages fetched per `crawlAndIngest()` call, even when
 * multi-page crawling is opted into with a higher requested page count —
 * never truly unbounded.
 */
export const MAX_CRAWL_PAGES = 5;

/** Byte ceiling on the raw robots.txt response body (a separate, much smaller cap than MAX_INGEST_BYTES — robots.txt is never a multi-hundred-KB file in practice). */
const MAX_ROBOTS_BYTES = 100_000;

/** Honest, self-identifying User-Agent — never a spoofed browser UA to dodge robots.txt/rate limits. */
export const USER_AGENT = 'Mnemosyne-Crawler/1.0 (+https://github.com/mdostal/mnemosyne)';

/** `Content-Type` values this module will read a body for. Checked from the header alone, before any body read. */
const ALLOWED_CONTENT_TYPE_RE = /^(text\/|application\/xhtml\+xml)/i;

// ---------------------------------------------------------------------------
// SSRF guard — blocked-range table and membership checks.
// ---------------------------------------------------------------------------

interface BlockedRange {
  readonly cidr: string;
  readonly description: string;
  readonly family: 4 | 6;
  readonly network: string;
  readonly prefixLen: number;
}

const BLOCKED_RANGES: readonly BlockedRange[] = [
  { cidr: '127.0.0.0/8', description: 'loopback', family: 4, network: '127.0.0.0', prefixLen: 8 },
  { cidr: '10.0.0.0/8', description: 'private-network', family: 4, network: '10.0.0.0', prefixLen: 8 },
  { cidr: '172.16.0.0/12', description: 'private-network', family: 4, network: '172.16.0.0', prefixLen: 12 },
  { cidr: '192.168.0.0/16', description: 'private-network', family: 4, network: '192.168.0.0', prefixLen: 16 },
  { cidr: '169.254.0.0/16', description: 'link-local/cloud-metadata', family: 4, network: '169.254.0.0', prefixLen: 16 },
  { cidr: '::1/128', description: 'loopback', family: 6, network: '::1', prefixLen: 128 },
  { cidr: 'fc00::/7', description: 'private-network (unique-local)', family: 6, network: 'fc00::', prefixLen: 7 },
  { cidr: 'fe80::/10', description: 'link-local', family: 6, network: 'fe80::', prefixLen: 10 },
];

function ipv4ToInt(ip: string): number {
  const octets = ip.split('.').map((part) => Number(part));
  return (((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0);
}

function ipv4InRange(ip: string, networkAddr: string, prefixLen: number): boolean {
  const mask = prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
  return (ipv4ToInt(ip) & mask) >>> 0 === (ipv4ToInt(networkAddr) & mask) >>> 0;
}

/** Splits a (possibly `::`-compressed) IPv6 literal into its head/tail group-strings. */
function splitOnDoubleColon(ip: string): [string, string | null] {
  const idx = ip.indexOf('::');
  if (idx === -1) return [ip, null];
  return [ip.slice(0, idx), ip.slice(idx + 2)];
}

/** Expands an IPv6 literal (compressed or not) into its 8 16-bit groups. */
function expandIPv6Groups(ip: string): number[] {
  const [head, tail] = splitOnDoubleColon(ip);
  const headGroups = head.length ? head.split(':') : [];
  const tailGroups = tail !== null ? (tail.length ? tail.split(':') : []) : [];
  const missing = Math.max(8 - headGroups.length - tailGroups.length, 0);
  const allGroups = [...headGroups, ...Array(missing).fill('0'), ...tailGroups];
  return allGroups.map((g) => parseInt(g || '0', 16));
}

function ipv6ToBigInt(ip: string): bigint {
  let result = 0n;
  for (const group of expandIPv6Groups(ip)) result = (result << 16n) | BigInt(group);
  return result;
}

function ipv6InRange(ip: string, networkAddr: string, prefixLen: number): boolean {
  const shift = BigInt(128 - prefixLen);
  return (ipv6ToBigInt(ip) >> shift) === (ipv6ToBigInt(networkAddr) >> shift);
}

/** Returns the specific blocked range an IP address matches, or `null` if it's outside all of them. */
function findBlockedRange(ip: string): BlockedRange | null {
  const family = net.isIP(ip);
  if (family === 4) {
    return BLOCKED_RANGES.find((r) => r.family === 4 && ipv4InRange(ip, r.network, r.prefixLen)) ?? null;
  }
  if (family === 6) {
    return BLOCKED_RANGES.find((r) => r.family === 6 && ipv6InRange(ip, r.network, r.prefixLen)) ?? null;
  }
  return null;
}

/** Injectable hostname-resolution seam (default: real `node:dns/promises` `lookup()`) — a testing/DI boundary, never a guard bypass: whatever it returns is still checked against `BLOCKED_RANGES` unconditionally. */
export type ResolveHostnameFn = (hostname: string) => Promise<string[]>;

async function defaultResolveHostname(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

interface SsrfGuardResult {
  allowed: boolean;
  resolvedIp?: string;
  blockedRange?: BlockedRange;
  reason?: string;
}

/**
 * The SSRF guard itself: literal-IP hostnames are parsed directly (no DNS
 * round-trip); name hostnames are resolved via `resolveHostname`. EVERY
 * resolved address is checked (a multi-address result is blocked if ANY
 * address is in a blocked range — the conservative, safe choice). No
 * parameter here (or anywhere in this module) skips this check.
 */
async function checkSsrfGuard(hostname: string, resolveHostname: ResolveHostnameFn): Promise<SsrfGuardResult> {
  if (net.isIP(hostname) !== 0) {
    const blocked = findBlockedRange(hostname);
    return blocked ? { allowed: false, resolvedIp: hostname, blockedRange: blocked } : { allowed: true, resolvedIp: hostname };
  }

  let addresses: string[];
  try {
    addresses = await resolveHostname(hostname);
  } catch (error) {
    return { allowed: false, reason: `DNS resolution failed for '${hostname}': ${error instanceof Error ? error.message : String(error)}` };
  }
  if (addresses.length === 0) {
    return { allowed: false, reason: `DNS resolution for '${hostname}' returned no addresses.` };
  }
  for (const address of addresses) {
    const blocked = findBlockedRange(address);
    if (blocked) return { allowed: false, resolvedIp: address, blockedRange: blocked };
  }
  return { allowed: true, resolvedIp: addresses[0]! };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type CrawlErrorCode =
  | 'invalid_url'
  | 'blocked_ip_range'
  | 'dns_resolution_failed'
  | 'robots_disallowed'
  | 'auth_failed'
  | 'http_error'
  | 'redirect_not_followed'
  | 'invalid_content_type'
  | 'oversized_response'
  | 'timeout'
  | 'network_error'
  | 'ingest_failed'
  | 'unexpected_error';

class CrawlError extends Error {
  readonly code: CrawlErrorCode;
  constructor(code: CrawlErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// guardedFetch — the ONLY function in this module that ever calls
// `fetchImpl`. Every network request (robots.txt, every page) goes through
// this, so the SSRF guard can never be raced, skipped, or run only once per
// crawl.
// ---------------------------------------------------------------------------

/** Injectable fetch seam (default: global `fetch`) — a testing/DI boundary, same pattern as `ResolveHostnameFn`. */
export type FetchFn = typeof fetch;

interface GuardedFetchContext {
  timeoutMs: number;
  resolveHostname: ResolveHostnameFn;
  fetchImpl: FetchFn;
}

async function guardedFetch(target: URL, ctx: GuardedFetchContext): Promise<Response> {
  const guard = await checkSsrfGuard(target.hostname, ctx.resolveHostname);
  if (!guard.allowed) {
    if (guard.blockedRange) {
      throw new CrawlError(
        'blocked_ip_range',
        `target '${target.hostname}' resolves to ${guard.resolvedIp}, inside the ${guard.blockedRange.description} range ${guard.blockedRange.cidr} — the fetch was never attempted.`,
      );
    }
    throw new CrawlError('dns_resolution_failed', guard.reason ?? `could not resolve '${target.hostname}'.`);
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ctx.timeoutMs);

  let response: Response;
  try {
    response = await ctx.fetchImpl(target, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT },
    });
  } catch (error) {
    if (timedOut) {
      throw new CrawlError('timeout', `request to ${target.href} exceeded the ${ctx.timeoutMs}ms timeout — aborted, never hangs indefinitely.`);
    }
    throw new CrawlError('network_error', `request to ${target.href} failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    throw new CrawlError(
      'redirect_not_followed',
      `${target.href} returned HTTP ${response.status} redirecting to '${location ?? '(no Location header)'}' — redirects are not followed (would require a fetch this module never SSRF-checks); retry with the final destination URL directly.`,
    );
  }

  return response;
}

/**
 * Reads a response body up to `maxBytes`, ABORTING the read the moment the
 * cap is hit — never buffers a full oversized body into memory first.
 */
async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new CrawlError('oversized_response', `response body exceeded the ${maxBytes}-byte MAX_INGEST_BYTES cap — the read was aborted mid-stream, never buffered in full.`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

// ---------------------------------------------------------------------------
// robots.txt — minimal, testable disallow check (see module doc comment for
// the explicit scope decision).
// ---------------------------------------------------------------------------

function parseRobotsTxtDisallowRules(text: string): string[] {
  const rules: string[] = [];
  let inWildcardGroup = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim().toLowerCase();
    const value = line.slice(colonIndex + 1).trim();
    if (key === 'user-agent') {
      inWildcardGroup = value === '*';
    } else if (key === 'disallow' && inWildcardGroup && value) {
      rules.push(value);
    }
  }
  return rules;
}

function isPathDisallowed(pathname: string, disallowRules: readonly string[]): string | null {
  return disallowRules.find((rule) => pathname.startsWith(rule)) ?? null;
}

async function fetchRobotsDisallowRules(origin: URL, ctx: GuardedFetchContext): Promise<string[]> {
  const robotsUrl = new URL('/robots.txt', origin);
  let response: Response;
  try {
    response = await guardedFetch(robotsUrl, ctx);
  } catch (error) {
    // The SSRF guard rejecting robots.txt's OWN fetch is a real, loud
    // failure that always propagates — never silently swallowed. A genuine
    // network failure/timeout fetching robots.txt, by contrast, is treated
    // as "no restrictions found" (the common crawler convention for a
    // missing/unreachable robots.txt) — see module doc comment.
    if (error instanceof CrawlError && (error.code === 'blocked_ip_range' || error.code === 'dns_resolution_failed')) {
      throw error;
    }
    return [];
  }
  if (response.status !== 200) return [];
  const text = await readBoundedBody(response, MAX_ROBOTS_BYTES);
  return parseRobotsTxtDisallowRules(text);
}

// ---------------------------------------------------------------------------
// Naive, best-effort tag-stripping text extraction (R10 — explicitly named
// as naive, never claimed to be readability-grade — see module doc comment).
// ---------------------------------------------------------------------------

const HTML_ENTITIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&nbsp;/gi, ' '],
  [/&amp;/gi, '&'],
  [/&lt;/gi, '<'],
  [/&gt;/gi, '>'],
  [/&quot;/gi, '"'],
  [/&#39;/gi, "'"],
  [/&apos;/gi, "'"],
];

function extractText(html: string): string {
  let text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  for (const [pattern, replacement] of HTML_ENTITIES) text = text.replace(pattern, replacement);
  return text
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Same-domain-only link extraction (never cross-domain) — feeds multi-page crawling's opt-in page queue. First cut: only ever called against the INITIAL page (see module doc comment's scope decision). */
function extractSameDomainLinks(html: string, baseUrl: URL): URL[] {
  const hrefRe = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
  const found: URL[] = [];
  let match: RegExpExecArray | null;
  while ((match = hrefRe.exec(html)) !== null) {
    const raw = match[1];
    if (!raw) continue;
    let candidate: URL;
    try {
      candidate = new URL(raw, baseUrl);
    } catch {
      continue;
    }
    if (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') continue;
    if (candidate.hostname !== baseUrl.hostname) continue;
    candidate.hash = '';
    found.push(candidate);
  }
  return found;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export interface CrawlMultiPageOptions {
  /** Requested page count; hard-capped at `MAX_CRAWL_PAGES` regardless of what's requested — never truly unbounded even when opted in. */
  maxPages: number;
}

export interface CrawlAndIngestOptions {
  scope?: Scope;
  tag?: string;
  /** Omit entirely for the default (exactly one page, never following any link). Opt into same-domain multi-page crawling by supplying this. */
  multiPage?: CrawlMultiPageOptions;
  /** Per-request timeout override (default `DEFAULT_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Testing/DI seam only — see `ResolveHostnameFn`'s doc comment. Defaults to real DNS resolution. */
  resolveHostname?: ResolveHostnameFn;
  /** Testing/DI seam only — see `FetchFn`'s doc comment. Defaults to the global `fetch`. */
  fetchImpl?: FetchFn;
}

export interface CrawlPageOutcome {
  url: string;
  ok: boolean;
  ingest: IngestDocumentResult;
}

export interface CrawlAndIngestError {
  code: CrawlErrorCode;
  message: string;
}

export interface CrawlAndIngestSuccess {
  ok: true;
  pages: CrawlPageOutcome[];
}

export interface CrawlAndIngestFailure {
  ok: false;
  error: CrawlAndIngestError;
  /** Every page actually attempted before the failure (empty for a pre-fetch rejection, e.g. an invalid URL, robots.txt disallow on the first page, or an SSRF-guard rejection) — never hidden behind a generic error. */
  pages: CrawlPageOutcome[];
}

export type CrawlAndIngestResult = CrawlAndIngestSuccess | CrawlAndIngestFailure;

/**
 * Fetches `url` (default: EXACTLY that one page, never following any link),
 * extracts best-effort text, and feeds it through `ro-10`'s
 * `ingestDocument()` UNCHANGED, once per page, sequentially. See this
 * module's doc comment for the full safety-bound contract (SSRF guard,
 * robots.txt, rate limiting, size/time ceilings) — every bound is real,
 * enforced code, not documentation-only.
 */
export async function crawlAndIngest(client: IngestClient, url: string, options: CrawlAndIngestOptions = {}): Promise<CrawlAndIngestResult> {
  const ctx: GuardedFetchContext = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    resolveHostname: options.resolveHostname ?? defaultResolveHostname,
    fetchImpl: options.fetchImpl ?? fetch,
  };

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { ok: false, pages: [], error: { code: 'invalid_url', message: `'${url}' is not a valid absolute URL.` } };
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return { ok: false, pages: [], error: { code: 'invalid_url', message: `crawlAndIngest() only supports http/https URLs — got '${target.protocol}' for '${url}'.` } };
  }

  const maxPages = Math.max(1, Math.min(options.multiPage?.maxPages ?? 1, MAX_CRAWL_PAGES));
  const pages: CrawlPageOutcome[] = [];

  try {
    const disallowRules = await fetchRobotsDisallowRules(target, ctx);

    const queue: URL[] = [target];
    const visited = new Set<string>([target.href]);
    let lastRequestAt: number | null = null;

    while (queue.length > 0 && pages.length < maxPages) {
      const pageUrl = queue.shift()!;

      if (lastRequestAt !== null) {
        const elapsed = Date.now() - lastRequestAt;
        if (elapsed < MIN_REQUEST_DELAY_MS) await sleep(MIN_REQUEST_DELAY_MS - elapsed);
      }

      const disallowedBy = isPathDisallowed(pageUrl.pathname, disallowRules);
      if (disallowedBy !== null) {
        throw new CrawlError(
          'robots_disallowed',
          `robots.txt at ${target.origin}/robots.txt disallows '${disallowedBy}' (matches '${pageUrl.pathname}') for User-agent: * — the page is never fetched.`,
        );
      }

      lastRequestAt = Date.now();
      const response = await guardedFetch(pageUrl, ctx);

      if (response.status === 401 || response.status === 403) {
        throw new CrawlError('auth_failed', `${pageUrl.href} returned HTTP ${response.status} — no retry, no credential injection, no workaround attempted.`);
      }
      if (response.status >= 400) {
        throw new CrawlError('http_error', `${pageUrl.href} returned HTTP ${response.status}.`);
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!ALLOWED_CONTENT_TYPE_RE.test(contentType)) {
        throw new CrawlError(
          'invalid_content_type',
          `${pageUrl.href} returned Content-Type '${contentType || '(missing)'}' — crawlAndIngest() only accepts text/* or application/xhtml+xml, rejected from the header alone before reading the body.`,
        );
      }

      const html = await readBoundedBody(response, MAX_INGEST_BYTES);
      const text = extractText(html);

      const ingestResult = await ingestDocument(client, {
        content: text,
        ...(options.tag !== undefined ? { tag: options.tag } : {}),
        ...(options.scope !== undefined ? { scope: options.scope } : {}),
      });

      pages.push({ url: pageUrl.href, ok: ingestResult.ok, ingest: ingestResult });
      if (!ingestResult.ok) {
        throw new CrawlError('ingest_failed', `ingestDocument() failed for ${pageUrl.href}: ${ingestResult.error.message}`);
      }

      if (options.multiPage && pageUrl.href === target.href && pages.length < maxPages) {
        for (const link of extractSameDomainLinks(html, target)) {
          if (visited.has(link.href)) continue;
          visited.add(link.href);
          queue.push(link);
        }
      }
    }

    return { ok: true, pages };
  } catch (error) {
    if (error instanceof CrawlError) {
      return { ok: false, pages, error: { code: error.code, message: error.message } };
    }
    return { ok: false, pages, error: { code: 'unexpected_error', message: error instanceof Error ? error.message : String(error) } };
  }
}
