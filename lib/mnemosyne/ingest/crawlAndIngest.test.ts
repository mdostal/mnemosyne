/**
 * ro-11-bounded-website-crawl (epic: mnemosyne-repo-onboarding).
 *
 * Failing-first tests (TDD, per the story's `test-spec` step) for
 * `crawlAndIngest()` against a real, local, throwaway `node:http` test
 * server — NEVER a live external site. Covers every acceptance criterion in
 * `.pHive/epics/mnemosyne-repo-onboarding/stories/ro-11-bounded-website-
 * crawl.yaml`: single-page default, robots.txt disallow, multi-page
 * hard-cap, real-timestamp rate-limit enforcement, non-text Content-Type
 * rejection before body read, oversized-body abort, 401/403 loud failure,
 * timeout loud failure, and the full SSRF guard (each blocked range via a
 * stubbed DNS resolver, a literal-blocked-IP case with no DNS mocking, a
 * genuinely-public resolved-IP allow case, no-bypass-flag-in-source, and
 * call-count-instrumented proof of one resolve-and-check per fetch).
 *
 * SSRF-guard interaction with the test server itself: the throwaway server
 * always binds to 127.0.0.1 (loopback — itself inside the guard's own
 * blocked range). Every "happy path" test therefore targets it via the
 * hostname `localhost` with `resolveHostname` STUBBED to return a
 * genuinely-public-looking address for `localhost` — the guard's own check
 * passes against that stubbed address, while the REAL `fetch()` call (never
 * stubbed) still resolves `localhost` for real (via Node's own DNS) and
 * connects to the real local server. This is a deliberate testing/DI seam
 * (`ResolveHostnameFn`), never a guard bypass: the blocked-range check itself
 * always runs unconditionally against whatever the resolver returns.
 */

import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Content, Provenance, RememberResult, Scope } from '../interfaces.js';
import type { IngestClient } from './ingestDocument.js';
import {
  crawlAndIngest,
  MAX_CRAWL_PAGES,
  MIN_REQUEST_DELAY_MS,
  type ResolveHostnameFn,
} from './crawlAndIngest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A public-looking IP, unconditionally outside every blocked range —
// used by the stubbed resolver for every "happy path" test.
const PUBLIC_IP = '93.184.216.34';

function publicResolver(): ResolveHostnameFn {
  return vi.fn(async () => [PUBLIC_IP]);
}

// ---------------------------------------------------------------------------
// Fake IngestClient — records every remember() call, never touches Qdrant.
// Mirrors ingestDocument.test.ts's own stub-client convention.
// ---------------------------------------------------------------------------

function fakeProvenance(): Provenance {
  return {
    layer: 'vector',
    source: 'fake:point:1',
    chunk_span: { index: 0 },
    index_timestamp: '2026-08-19T00:00:00.000Z',
    content_hash: 'deadbeef',
    embedder: 'fake-embedder',
    retrieval_time: null,
  };
}

function makeFakeClient(): { client: IngestClient; calls: { content: Content; scope: Scope }[] } {
  const calls: { content: Content; scope: Scope }[] = [];
  const client: IngestClient = {
    remember: async (content: Content, scope: Scope): Promise<RememberResult> => {
      calls.push({ content, scope });
      return { ok: true, layer: 'vector', provenance: fakeProvenance() };
    },
  };
  return { client, calls };
}

// ---------------------------------------------------------------------------
// Throwaway local HTTP test server.
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  url: string;
  receivedAt: number;
}

interface TestServer {
  port: number;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

function startTestServer(handler: http.RequestListener): Promise<TestServer> {
  return new Promise((resolve) => {
    const requests: RecordedRequest[] = [];
    const sockets = new Set<Socket>();
    const server = http.createServer((req, res) => {
      requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', receivedAt: Date.now() });
      handler(req, res);
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        requests,
        close: () =>
          new Promise<void>((res2) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => res2());
          }),
      });
    });
  });
}

let activeServer: TestServer | null = null;

afterEach(async () => {
  if (activeServer) {
    await activeServer.close();
    activeServer = null;
  }
});

function targetUrl(server: TestServer, pathname = '/'): string {
  return `http://localhost:${server.port}${pathname}`;
}

const NO_ROBOTS_RESTRICTIONS = (req: http.IncomingMessage, res: http.ServerResponse) => {
  if (req.url === '/robots.txt') {
    res.writeHead(404);
    res.end();
    return true;
  }
  return false;
};

// ---------------------------------------------------------------------------
// AC: single-page default — fetches EXACTLY one page, never follows a link,
// feeds extracted text through ingestDocument() unchanged.
// ---------------------------------------------------------------------------

describe('crawlAndIngest — single-page default', () => {
  it('fetches exactly one page, never follows a link, and lands via ingestDocument()', async () => {
    activeServer = await startTestServer((req, res) => {
      if (NO_ROBOTS_RESTRICTIONS(req, res)) return;
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body><script>evil()</script><h1>Hello</h1><p>World.</p><a href="/other">link</a></body></html>');
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const { client, calls } = makeFakeClient();
    const result = await crawlAndIngest(client, targetUrl(activeServer), { resolveHostname: publicResolver() });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]!.ok).toBe(true);

    // Only robots.txt + the one page were ever requested -- /other was never fetched.
    const urls = activeServer.requests.map((r) => r.url);
    expect(urls).toContain('/');
    expect(urls).not.toContain('/other');
    expect(activeServer.requests.filter((r) => r.url === '/other')).toHaveLength(0);

    // Real ingestDocument() chunking metadata is present -- proves this
    // module feeds ro-10's primitive unchanged, not a second storage path.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.content.metadata).toMatchObject({ filename: null, chunk_index: 0, chunk_count: 1 });
    expect(calls[0]!.content.text).toContain('Hello');
    expect(calls[0]!.content.text).toContain('World');
    expect(calls[0]!.content.text).not.toContain('evil()');
    expect(calls[0]!.content.text).not.toContain('<h1>');
  });
});

// ---------------------------------------------------------------------------
// AC: robots.txt disallow -> loud failure, page never fetched.
// ---------------------------------------------------------------------------

describe('crawlAndIngest — robots.txt', () => {
  it('fails loudly naming the disallow, and never fetches the disallowed page', async () => {
    activeServer = await startTestServer((req, res) => {
      if (req.url === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('User-agent: *\nDisallow: /private\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('should never be reached');
    });

    const { client } = makeFakeClient();
    const result = await crawlAndIngest(client, targetUrl(activeServer, '/private/page'), { resolveHostname: publicResolver() });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error.code).toBe('robots_disallowed');
    expect(result.error.message).toMatch(/robots\.txt/i);
    expect(result.error.message).toMatch(/\/private/);
    expect(result.pages).toHaveLength(0);

    const urls = activeServer.requests.map((r) => r.url);
    expect(urls).not.toContain('/private/page');
  });

  it('treats a missing (404) robots.txt as no restrictions', async () => {
    activeServer = await startTestServer((req, res) => {
      if (NO_ROBOTS_RESTRICTIONS(req, res)) return;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('fine');
    });

    const { client } = makeFakeClient();
    const result = await crawlAndIngest(client, targetUrl(activeServer), { resolveHostname: publicResolver() });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC: multi-page hard cap -- never truly unbounded even when opted in.
// ---------------------------------------------------------------------------

describe('crawlAndIngest — multi-page hard cap', () => {
  it('caps at MAX_CRAWL_PAGES regardless of a much higher requested page count', async () => {
    const linkCount = MAX_CRAWL_PAGES + 4;
    const links = Array.from({ length: linkCount }, (_, i) => `<a href="/page${i}">p${i}</a>`).join('\n');

    activeServer = await startTestServer((req, res) => {
      if (NO_ROBOTS_RESTRICTIONS(req, res)) return;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><body>${links}</body></html>`);
    });

    const { client } = makeFakeClient();
    const result = await crawlAndIngest(client, targetUrl(activeServer), {
      resolveHostname: publicResolver(),
      multiPage: { maxPages: 999 },
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');
    expect(result.pages).toHaveLength(MAX_CRAWL_PAGES);
  });
});

// ---------------------------------------------------------------------------
// AC: real, enforced minimum delay between successive same-host requests.
// ---------------------------------------------------------------------------

describe('crawlAndIngest — rate limiting', () => {
  it('enforces a real minimum delay between successive page requests (real timestamps)', async () => {
    activeServer = await startTestServer((req, res) => {
      if (NO_ROBOTS_RESTRICTIONS(req, res)) return;
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body><a href="/p1">1</a><a href="/p2">2</a></body></html>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('page');
    });

    const { client } = makeFakeClient();
    const result = await crawlAndIngest(client, targetUrl(activeServer), {
      resolveHostname: publicResolver(),
      multiPage: { maxPages: 3 },
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');
    expect(result.pages).toHaveLength(3);

    const pageRequests = activeServer.requests.filter((r) => r.url !== '/robots.txt');
    expect(pageRequests).toHaveLength(3);
    for (let i = 1; i < pageRequests.length; i++) {
      const elapsed = pageRequests[i]!.receivedAt - pageRequests[i - 1]!.receivedAt;
      expect(elapsed).toBeGreaterThanOrEqual(MIN_REQUEST_DELAY_MS - 5); // small scheduling-jitter tolerance
    }
  });
});

// ---------------------------------------------------------------------------
// AC: non-text Content-Type rejected before any body read.
// ---------------------------------------------------------------------------

describe('crawlAndIngest — Content-Type rejection', () => {
  it('rejects a non-text/xhtml Content-Type citing it, and never reads the body', async () => {
    activeServer = await startTestServer((req, res) => {
      if (NO_ROBOTS_RESTRICTIONS(req, res)) return;
      // Headers only, then withhold the body forever -- if the
      // implementation ever tried to read it, this test would time out
      // instead of resolving quickly, proving the body is never touched.
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '999999999' });
      res.write(Buffer.alloc(16));
      // Deliberately never res.end() -- socket is force-destroyed in afterEach.
    });

    const { client } = makeFakeClient();
    const result = await crawlAndIngest(client, targetUrl(activeServer), { resolveHostname: publicResolver(), timeoutMs: 5000 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error.code).toBe('invalid_content_type');
    expect(result.error.message).toContain('application/octet-stream');
  }, 3000);
});

// ---------------------------------------------------------------------------
// AC: oversized body -- aborts the read once MAX_INGEST_BYTES is hit, never
// buffers the full oversized body first.
// ---------------------------------------------------------------------------

describe('crawlAndIngest — oversized body', () => {
  it('aborts mid-read once the shared MAX_INGEST_BYTES cap is hit, never sending/buffering the full body', async () => {
    const chunk = Buffer.alloc(8192, 97); // 'a'
    const totalIntended = 2_000_000; // >> MAX_INGEST_BYTES (200_000) by ~10x
    let bytesSent = 0;
    let aborted = false;

    activeServer = await startTestServer((req, res) => {
      if (NO_ROBOTS_RESTRICTIONS(req, res)) return;
      res.writeHead(200, { 'content-type': 'text/plain' });
      req.on('aborted', () => {
        aborted = true;
      });
      const interval = setInterval(() => {
        if (res.destroyed || res.writableEnded || bytesSent >= totalIntended) {
          clearInterval(interval);
          if (!res.writableEnded && !res.destroyed) res.end();
          return;
        }
        res.write(chunk);
        bytesSent += chunk.length;
      }, 1);
    });

    const { client } = makeFakeClient();
    const result = await crawlAndIngest(client, targetUrl(activeServer), { resolveHostname: publicResolver(), timeoutMs: 5000 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error.code).toBe('oversized_response');

    // Give the server's interval a moment to notice the aborted connection.
    await new Promise((r) => setTimeout(r, 100));
    expect(bytesSent).toBeLessThan(totalIntended);
    expect(aborted || bytesSent < totalIntended / 2).toBe(true);
  }, 5000);
});

// ---------------------------------------------------------------------------
// AC: 401/403 -> loud failure, no retry, no workaround.
// ---------------------------------------------------------------------------

describe('crawlAndIngest — auth failures', () => {
  it.each([401, 403])('fails loudly surfacing HTTP %i, no retry', async (status) => {
    let requestCount = 0;
    activeServer = await startTestServer((req, res) => {
      if (NO_ROBOTS_RESTRICTIONS(req, res)) return;
      requestCount++;
      res.writeHead(status, { 'content-type': 'text/plain' });
      res.end('nope');
    });

    const { client } = makeFakeClient();
    const result = await crawlAndIngest(client, targetUrl(activeServer), { resolveHostname: publicResolver() });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error.code).toBe('auth_failed');
    expect(result.error.message).toContain(String(status));
    expect(requestCount).toBe(1); // no retry
  });
});

// ---------------------------------------------------------------------------
// AC: real per-request timeout -> aborted, loud timeout-specific failure.
// ---------------------------------------------------------------------------

describe('crawlAndIngest — timeout', () => {
  it('aborts via AbortController/signal and fails loudly with a timeout-specific message', async () => {
    activeServer = await startTestServer((req, res) => {
      if (NO_ROBOTS_RESTRICTIONS(req, res)) return;
      // Never respond -- forces the timeout path.
    });

    const { client } = makeFakeClient();
    const start = Date.now();
    const result = await crawlAndIngest(client, targetUrl(activeServer), { resolveHostname: publicResolver(), timeoutMs: 150 });
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error.code).toBe('timeout');
    expect(result.error.message).toMatch(/timeout/i);
    expect(elapsed).toBeLessThan(2000); // never hangs indefinitely
  }, 3000);
});

// ---------------------------------------------------------------------------
// AC: SSRF guard -- each blocked range, checked BEFORE any fetch, naming
// the specific matched range.
// ---------------------------------------------------------------------------

describe('crawlAndIngest — SSRF guard, blocked ranges', () => {
  const cases: Array<{ ip: string; range: string }> = [
    { ip: '127.0.0.5', range: '127.0.0.0/8' },
    { ip: '10.1.2.3', range: '10.0.0.0/8' },
    { ip: '172.20.5.6', range: '172.16.0.0/12' },
    { ip: '192.168.50.1', range: '192.168.0.0/16' },
    { ip: '169.254.169.254', range: '169.254.0.0/16' },
    { ip: '::1', range: '::1/128' },
    { ip: 'fd12:3456:789a::1', range: 'fc00::/7' },
    { ip: 'fe80::1234', range: 'fe80::/10' },
  ];

  it.each(cases)('rejects a hostname resolving to $ip (inside $range) before any fetch, naming the range', async ({ ip, range }) => {
    const fetchSpy = vi.fn();
    const resolveHostname: ResolveHostnameFn = vi.fn(async () => [ip]);
    const { client } = makeFakeClient();

    const result = await crawlAndIngest(client, 'http://blocked.invalid/', {
      resolveHostname,
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error.code).toBe('blocked_ip_range');
    expect(result.error.message).toContain(ip);
    expect(result.error.message).toContain(range);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('crawlAndIngest — SSRF guard, literal IP hostname', () => {
  it('catches a literal blocked IP in the URL via direct IP parsing, no DNS mocking needed', async () => {
    const fetchSpy = vi.fn();
    const resolveHostname = vi.fn();
    const { client } = makeFakeClient();

    const result = await crawlAndIngest(client, 'http://127.0.0.1:1/', {
      resolveHostname: resolveHostname as unknown as ResolveHostnameFn,
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error.code).toBe('blocked_ip_range');
    expect(result.error.message).toContain('127.0.0.0/8');
    expect(resolveHostname).not.toHaveBeenCalled(); // no DNS round-trip needed for a literal IP
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('crawlAndIngest — SSRF guard, genuinely public IP', () => {
  it('allows the fetch to proceed for a genuinely public resolved IP -- a real allow/deny check, never a blanket deny', async () => {
    activeServer = await startTestServer((req, res) => {
      if (NO_ROBOTS_RESTRICTIONS(req, res)) return;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('allowed through');
    });

    const resolveHostname = publicResolver();
    const { client } = makeFakeClient();
    const result = await crawlAndIngest(client, targetUrl(activeServer), { resolveHostname });

    expect(result.ok).toBe(true);
    expect(resolveHostname).toHaveBeenCalled();
  });
});

describe('crawlAndIngest — SSRF guard, no bypass', () => {
  it('has no flag/option/env-var anywhere in the module CODE that could bypass the guard', () => {
    const source = readFileSync(path.join(__dirname, 'crawlAndIngest.ts'), 'utf8');
    // Strip comments first -- this module's own doc comments legitimately
    // DISCUSS the guard's no-bypass posture in prose ("never a guard
    // bypass"); what must never exist is a real CODE construct (an
    // identifier, option field, or env-var read) that could actually skip
    // the check. Stripping comments before scanning avoids a false positive
    // on the prose that documents the absence of exactly that.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/process\.env/);
    expect(code.toLowerCase()).not.toMatch(/skip[_-]?ssrf/);
    expect(code.toLowerCase()).not.toMatch(/bypass/);
    expect(code.toLowerCase()).not.toMatch(/allow[_-]?private/);
    expect(code.toLowerCase()).not.toMatch(/disable[_-]?guard/);
    expect(code.toLowerCase()).not.toMatch(/no[_-]?ssrf/);
    // Sanity: confirms the assertions above are actually exercising the real,
    // current implementation file, not an empty/misnamed path.
    expect(code).toContain('checkSsrfGuard');
  });
});

describe('crawlAndIngest — SSRF guard, re-checked before EVERY individual fetch', () => {
  it('re-resolves and re-checks once per fetch across a multi-page crawl (call-count instrumentation), not once per crawl', async () => {
    activeServer = await startTestServer((req, res) => {
      if (NO_ROBOTS_RESTRICTIONS(req, res)) return;
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body><a href="/p1">1</a><a href="/p2">2</a></body></html>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('page');
    });

    const resolveHostname = publicResolver();
    const { client } = makeFakeClient();
    const result = await crawlAndIngest(client, targetUrl(activeServer), {
      resolveHostname,
      multiPage: { maxPages: 3 },
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');
    expect(result.pages).toHaveLength(3);

    // robots.txt (1) + 3 page fetches = 4 real network requests -> 4
    // independent resolve-and-check calls, never cached/trusted after the
    // first.
    expect(resolveHostname).toHaveBeenCalledTimes(4);
  });
});
