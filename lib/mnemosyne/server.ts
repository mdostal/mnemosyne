/**
 * Mnemosyne client HTTP API — a thin REST wrapper around `MnemosyneClient`
 * for external, non-TypeScript consumers (CLI tools, non-TS agents). Every
 * request is a straight pass-through to the client library: this file does
 * transport only (parse request, call the client, shape the response), no
 * memory logic of its own.
 *
 * Story: s2-03-http-service (epic: mnemosyne-operational-slice-2)
 *
 * Distinct from `src/server.mjs` (the production `:8477` service wrapping
 * the swarm-memory/Qdrant engine): this service wraps the newer
 * `MnemosyneClient` (code-graph/vector/file routing, see client.ts), runs on
 * its own port (`MNEMOSYNE_PORT`, default 3141), and does not share routes or
 * process with it.
 *
 *   GET  /health            -> layer availability status
 *   GET  /layers            -> the resolved layer stack (pl-03-layer-ab-testing):
 *                               names in cascade order + write-capability per layer
 *   GET  /memory-levels     -> the 5 canonical memory-STORE-TYPE levels
 *                               (ml-04-memory-levels-route, epic mnemosyne-
 *                               memory-levels): ml-01's static taxonomy plus
 *                               live configured/activeInCascade checks -- a
 *                               NEW, parallel route, never an extension of
 *                               GET /layers above (different data model;
 *                               levels 0/1 don't participate in a recall()
 *                               cascade at all)
 *   GET  /persona           -> list personas (pw-02-get-persona-routes-cors):
 *                               global tiers by default, or ?repo=<path>'s
 *                               code-architect personas -- wraps pw-01's
 *                               listGlobalPersonas/listRepoLocalPersonas
 *                               directly, no re-implementation
 *   GET  /persona/:tier/:scopeId  -> read one persona (?repo=<path> required
 *                               for tier=code-architect) -- wraps
 *                               readGlobalPersona/readRepoLocalPersona
 *   POST /persona/:tier/:scopeId  -> write one persona (pw-15-post-persona-
 *                               routes): body is the persona candidate
 *                               itself ({tier, scopeId, displayName, scope,
 *                               sections, parentRefs?} -- the same bare
 *                               shape the CLI's --file YAML / MCP's
 *                               persona_create / skill-harness's
 *                               personaCreateAction already accept), plus an
 *                               optional `repo` field (or ?repo= query,
 *                               required for tier=code-architect) -- wraps
 *                               writeGlobalPersona/writeRepoLocalPersona
 *                               directly, the 4th write-capable transport
 *                               alongside CLI/MCP/skill-harness
 *   GET  /persona/draft           -> list every ACTIVE draft (pu-03-draft-
 *                               persona-routes): global tiers by default, or
 *                               ?repo=<path> ADDS that repo's code-architect
 *                               drafts alongside them (pu-02's
 *                               listDraftPersonas's own contract -- not a
 *                               "switch" the way GET /persona's ?repo= is)
 *   GET  /persona/draft/:tier/:scopeId  -> read one active draft back
 *                               (?repo=<path> required for tier=code-
 *                               architect) -- wraps readDraftPersona
 *   POST /persona/draft/:tier/:scopeId  -> propose a new draft, or overwrite
 *                               the existing active one for the same
 *                               identity -- wraps writeDraftPersona directly,
 *                               same bare-candidate-plus-optional-`repo`
 *                               convention as POST /persona/:tier/:scopeId.
 *                               Full assertValidPersona-strength validation
 *                               is deliberately NOT applied here -- a draft
 *                               may be incomplete while under review
 *   POST /persona/draft/:tier/:scopeId/approve  -> commits the active draft
 *                               via the SAME writeGlobalPersona/
 *                               writeRepoLocalPersona POST /persona/:tier/
 *                               :scopeId already uses (draft-only metadata
 *                               stripped first; proposedBy/proposedAt, when
 *                               BOTH real, are re-attached as `origin`
 *                               {proposedBy, proposedAt, approvedAt} --
 *                               puf-03-post-approval-provenance-note --
 *                               omitted entirely for a human-typed draft),
 *                               archives the draft
 *                               (disposeDraftPersona('approved'), never
 *                               deleted), and -- ONLY when the draft carries
 *                               a real `sourceSummary` (agent-proposed via
 *                               pu-07's bounded crawl) -- fires a real
 *                               remember() call against the swarm-memory-
 *                               backed service (src/server.mjs), scoped via
 *                               resolveRememberScope() (persona.ts), AFTER
 *                               the write succeeds. A human-typed draft (no
 *                               sourceSummary) never fires remember() --
 *                               there is no real source material to index.
 *                               POST /persona/:tier/:scopeId (direct write,
 *                               above) always CLEARS `origin` even if its
 *                               body carries one -- see that route's own
 *                               comment for the full rationale (puf-03 AC5)
 *   DELETE /persona/draft/:tier/:scopeId  -> discard the active draft --
 *                               ALWAYS disposeDraftPersona('discarded')
 *                               (archive-by-move), never a bare filesystem
 *                               delete
 *   POST /recall  {query, scope, intent?}            -> RecallResult
 *   POST /remember {content: {text, metadata?}, scope, layer?} -> RememberResult
 *   POST /ingest  {content, filename?, tag?, scope?} -> IngestDocumentResult
 *                               (ro-10-document-ingestion-primitive, epic
 *                               mnemosyne-repo-onboarding): chunks bounded
 *                               `content` (.txt/.md, or a free-text
 *                               description/CV with no `filename` at all)
 *                               and calls this same `client`'s remember()
 *                               once per chunk, sequentially -- a thin
 *                               transport wrap of
 *                               `ingest/ingestDocument.ts`'s `ingestDocument()`,
 *                               no ingestion logic of its own. Always 200,
 *                               same convention as POST /recall and POST
 *                               /remember above (the response body's own
 *                               `ok`/`error` discriminates a rejected/
 *                               partially-failed ingest from a real success).
 *   POST /crawl  {url, scope?, tag?, multiPage?: {maxPages}, timeoutMs?} -> CrawlAndIngestResult
 *                               (ro-11-bounded-website-crawl, epic
 *                               mnemosyne-repo-onboarding): a thin transport
 *                               wrap of `ingest/crawlAndIngest.ts`'s
 *                               `crawlAndIngest()` -- default scope is
 *                               EXACTLY one page (the given `url`), never
 *                               following any link; same-domain multi-page
 *                               crawling is opt-in via `multiPage`, hard-
 *                               capped regardless of what's requested. The
 *                               firm, default-on SSRF guard (rejects
 *                               loopback/private-network/link-local/cloud-
 *                               metadata resolved targets, re-checked before
 *                               EVERY individual fetch) has no bypass
 *                               anywhere in this route or the module it
 *                               wraps. Extracted text is fed through this
 *                               same `client`'s `remember()` cascade via
 *                               `ro-10`'s unmodified `ingestDocument()` --
 *                               never a second, parallel storage path. Always
 *                               200, same convention as POST /recall, POST
 *                               /remember, and POST /ingest above.
 *
 * No authentication — localhost-only for this slice; auth is future work.
 *
 * CORS: /persona/*, /layers, and /memory-levels responses carry an
 * Access-Control-Allow-Origin header (pw-02-get-persona-routes-cors;
 * extended to /layers by pw-04-layer-stack-visibility; extended to
 * /memory-levels by ml-04-memory-levels-route) -- the standalone UI is served from
 * src/server.mjs on a DIFFERENT port (8477 by default) than this service
 * (3141 by default), so a browser fetch from the UI to either is a real
 * cross-origin request that gets silently blocked without it. Scoped to the
 * UI's known origins (127.0.0.1:8477, localhost:8477), never a wildcard "*"
 * -- see UI_ORIGINS/applyPersonaCors below.
 */

import http from 'node:http';
import { stat } from 'node:fs/promises';
import { MnemosyneClient } from './client.js';
import type { Layer, Scope } from './interfaces.js';
import { ingestDocument } from './ingest/ingestDocument.js';
import { crawlAndIngest, type CrawlAndIngestOptions } from './ingest/crawlAndIngest.js';
import { PERSONA_STORE_BY_TIER, resolveRememberScope } from './layer1/persona.js';
import {
  disposeDraftPersona,
  listDraftPersonas,
  readDraftPersona,
  writeDraftPersona,
  type DraftPersonaCandidate,
  type DraftPersonaContext,
} from './layer1/persona-draft-store.js';
import { listGlobalPersonas, readGlobalPersona, writeGlobalPersona } from './layer1/persona-store-global.js';
import {
  listRepoLocalPersonas,
  readRepoLocalPersona,
  REPO_LOCAL_PERSONA_TIER,
  writeRepoLocalPersona,
} from './layer1/persona-store-repo-local.js';
import { TIERS, type Tier } from './layer1/tiers.js';
import { computeMemoryLevels } from './memory-levels/computeMemoryLevels.js';

const PORT = Number(process.env.MNEMOSYNE_PORT || 3141);
const ROOT_DIRECTORY = process.env.MNEMOSYNE_ROOT_DIR || process.cwd();

const SCOPES: ReadonlySet<Scope> = new Set(['project', 'enterprise', 'meta']);
const INTENTS = new Set(['narrow', 'broad']);
// cr-04-single-layer-config-proof: this set must track interfaces.ts's
// `Layer` union in full, not just the original three built-ins — a caller
// explicitly targeting an already-shipped optional layer (e.g. 'graphify'
// in a graphify-only config) must get client.ts's accurate
// 'layer_not_writable' (or a real success) when that name is valid but
// merely not writable/not configured, never a route-level 'invalid_layer'
// rejection for a layer name the system actually knows about. Found via a
// real subprocess test: POST /remember { layer: 'graphify' } against a
// graphify-only MNEMOSYNE_LAYERS config was wrongly 400'd here before this
// fix, even though 'graphify' is a real, live layer (la-02-graphify-adapter).
const LAYERS: ReadonlySet<Layer> = new Set([
  'meta',
  'enterprise',
  'project',
  'code-graph',
  'vector',
  'file',
  'hive-memory',
  'graphify',
  'crossref-linker',
  // 'keyword' (kw-02-ts-client-keyword-layer): opt-in only, never part of
  // DEFAULT_LAYER_STACK_CONFIG, but a real, valid layer name once a
  // consumer's MNEMOSYNE_LAYERS configures it -- same reasoning as every
  // other optional layer in this set (see comment above).
  'keyword',
]);

// pw-02-get-persona-routes-cors: the standalone UI's real, known origins
// (src/server.mjs's static /ui handler, default PORT 8477 -- confirmed by
// reading that file, not guessed). Deliberately an allow-list, not "*": a
// wildcard would work for a locally-run tool but is looser than necessary
// (vertical-plan.md's stated recommendation) -- reflected back verbatim only
// when the request's Origin header is an exact match to one of these.
const UI_ORIGINS: ReadonlySet<string> = new Set(['http://127.0.0.1:8477', 'http://localhost:8477']);

/**
 * Sets Access-Control-Allow-Origin (scoped, never "*") on /persona/*
 * responses when the request's Origin header matches one of UI_ORIGINS.
 * `res.setHeader` here merges with the headers object `sendJson`'s later
 * `res.writeHead` call passes (Node merges setHeader()-set headers with
 * writeHead()'s, precedence to writeHead() only on a literal key clash --
 * there is none here), so calling this before `sendJson`/`badRequest` is
 * sufficient. No-op (sends no CORS header at all) for any other origin --
 * this is the "scoped, not wildcarded" contract pw-02 requires.
 */
function applyPersonaCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && UI_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
}

// pu-03-draft-persona-routes: the target port for the approve route's
// remember()-on-approval firing (below) -- the swarm-memory-backed service
// (src/server.mjs), NOT this file's own /remember route (which wraps
// MnemosyneClient.remember(), a structurally different engine, see
// persona.ts's resolveRememberScope() doc comment for the full rationale on
// why the target must be engine.mjs's remember(), never client.ts's).
// Deliberately reuses the SAME `PORT` env var convention
// bin/mnemosyne-skill-helper.mjs's own DEFAULT_PORT and src/server.mjs
// already use (default 8477) -- not a new env var -- so a test (or an
// operator) can redirect this call the exact same way those already do.
const REMEMBER_SERVICE_PORT = Number(process.env.PORT || 8477);

interface RememberCallResult {
  ok: boolean;
  scope: string;
  tag: string;
  text: string;
  file: string | null;
  chunksUpserted: number | null;
  error: string | null;
}

/**
 * Fires the real remember() call the approve route wires in for an
 * agent-proposed draft (design-discussion.md OQ3/§9.9, "remember() fires on
 * approval, never on draft creation"): scopes it via `resolveRememberScope()`
 * (persona.ts) -- the exact same real resolver
 * skills/mnemosyne-persona-interview/persona-remember.mjs's
 * `rememberInterviewSource()` uses, never a hand-copied scope table -- builds
 * text in the same `buildRememberText()`-shaped style (identity line +
 * source-material body), but from the draft's own `sourceSummary` rather
 * than `persona.sections` (that function's own input): `sourceSummary` is
 * the crawled SOURCE material a human is meant to trust an agent's proposal
 * against, distinct from the persona content itself. A REAL `POST /remember`
 * HTTP call against the swarm-memory-backed service (never a stubbed/
 * in-process call) -- mirrors `bin/mnemosyne-skill-helper.mjs`'s
 * `rememberAction`'s exact request/response contract
 * ({text,scope,tag} -> {remembered, file, chunks_upserted, ...}), just
 * invoked via a direct fetch() rather than a subprocess, since this file is
 * already a running Node/TS process (unlike the interview skill, a plain
 * .mjs module that cannot import persona.ts directly and must cross the
 * TS/JS boundary via a real CLI subprocess instead).
 */
async function fireDraftApprovalRemember(
  tier: Tier,
  scopeId: string,
  sourceSummary: string,
  displayName: unknown,
): Promise<RememberCallResult> {
  const { scope, tag } = resolveRememberScope({ tier, scopeId });
  const text =
    `Persona draft proposal — tier: ${tier}, scopeId: ${scopeId}` +
    (typeof displayName === 'string' && displayName.trim() !== '' ? `, displayName: ${displayName}` : '') +
    `. Source material (pu-07 bounded crawl): ${sourceSummary}`;

  try {
    const res = await fetch(`http://127.0.0.1:${REMEMBER_SERVICE_PORT}/remember`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, scope, tag }),
    });
    const data = (await res.json()) as {
      remembered?: boolean;
      file?: string;
      chunks_upserted?: number;
      error?: unknown;
    };
    if (res.status >= 400 || data.remembered !== true) {
      return {
        ok: false,
        scope,
        tag,
        text,
        file: null,
        chunksUpserted: null,
        error:
          typeof data.error === 'string' ? data.error : `remember() did not report remembered:true (status ${res.status})`,
      };
    }
    return {
      ok: true,
      scope,
      tag,
      text,
      file: data.file ?? null,
      chunksUpserted: data.chunks_upserted ?? null,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      scope,
      tag,
      text,
      file: null,
      chunksUpserted: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const client = new MnemosyneClient({ rootDirectory: ROOT_DIRECTORY });

interface HttpError extends Error {
  status?: number;
  code?: string;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function badRequest(res: http.ServerResponse, code: string, message: string): void {
  sendJson(res, 400, { error: { code, message } });
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 4 * 1024 * 1024) {
        reject(Object.assign(new Error('payload too large') as HttpError, {
          status: 400,
          code: 'payload_too_large',
        }));
      }
    });
    req.on('end', () => {
      if (!buf.trim()) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(Object.assign(new Error('request body must be valid JSON') as HttpError, {
          status: 400,
          code: 'invalid_json',
        }));
      }
    });
    req.on('error', reject);
  });
}

async function fileLayerHealth(): Promise<{ layer: 'file'; available: boolean; root_directory: string; detail?: string }> {
  try {
    const s = await stat(ROOT_DIRECTORY);
    if (!s.isDirectory()) {
      return {
        layer: 'file',
        available: false,
        root_directory: ROOT_DIRECTORY,
        detail: 'root directory path is not a directory',
      };
    }
    return { layer: 'file', available: true, root_directory: ROOT_DIRECTORY };
  } catch (error) {
    return {
      layer: 'file',
      available: false,
      root_directory: ROOT_DIRECTORY,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    // CORS preflight (pw-17 follow-up): a browser sends a real OPTIONS
    // preflight before POST /persona/:tier/:scopeId, since that request
    // carries a `content-type: application/json` body -- one of the
    // conditions that makes a cross-origin request non-"simple" per the
    // Fetch spec, requiring the browser to get an explicit go-ahead first.
    // Without an OPTIONS handler here, that preflight fell through to the
    // 404 catch-all below with no CORS header on it, so the browser blocked
    // the real POST before it was ever sent -- discovered when pw-17's UI
    // write form was checked against this server directly rather than only
    // against unit tests that call fetch() server-side (which never enforce
    // preflight the way a real browser does). Scoped to /persona/*, the
    // only route this UI actually POSTs cross-origin with a JSON body;
    // reuses applyPersonaCors as-is (same allow-listed origins, same
    // scoped-not-wildcard posture), never a second CORS implementation.
    if (req.method === 'OPTIONS' && url.pathname.startsWith('/persona/')) {
      applyPersonaCors(req, res);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.writeHead(204);
      return res.end();
    }

    if (route === 'GET /health') {
      const layers = [await fileLayerHealth()];
      const ok = layers.every((l) => l.available);
      return sendJson(res, ok ? 200 : 503, { ok, layers });
    }

    if (route === 'GET /layers') {
      // Read-only introspection of what MnemosyneClient actually resolved
      // (registry + config), never a hardcoded/stale echo — see
      // client.ts's getConfiguredLayers() and layers/config.ts.
      //
      // pw-04-layer-stack-visibility: this route itself is reused exactly
      // as Epic pl-03 shipped it (no new route, no new logic) -- but the
      // Personas panel's layer-stack section is the first browser caller,
      // and pw-02-get-persona-routes-cors's CORS fix was scoped only to
      // /persona/* (server.ts's route review for that story explicitly
      // confirmed "GET /layers confirmed untouched"). Without the same
      // Access-Control-Allow-Origin header applied here, the same
      // cross-origin block vertical-plan.md's Decision 1 already
      // identified for /persona/* would silently break this route's only
      // browser consumer too. Reusing applyPersonaCors as-is (same
      // allow-listed origins, same scoped-not-wildcard posture) rather
      // than duplicating its logic.
      applyPersonaCors(req, res);
      return sendJson(res, 200, { layers: client.getConfiguredLayers() });
    }

    if (route === 'GET /memory-levels') {
      // ml-04-memory-levels-route (epic mnemosyne-memory-levels): a NEW,
      // parallel introspection route -- never an extension or repurposing of
      // GET /layers directly above, which stays byte-for-byte unchanged (see
      // that route's own comment plus test/http-api.mjs's dedicated
      // regression check). GET /layers answers "what's in the CURRENT
      // recall() retrieval cascade"; this route answers a structurally
      // different question -- "what are this system's 5 canonical memory
      // STORE TYPES, and is each one configured right now" -- levels 0/1
      // never participate in a recall() cascade at all, so they are
      // structurally unrepresentable inside GET /layers's shape
      // (design-discussion.md §5/§7.3; levels.ts's own module doc).
      //
      // Data sources, per ml-01's MEMORY_LEVELS (levels.ts) plus exactly two
      // kinds of live, read-only check -- never a second, independent
      // cascade resolution:
      //   - levels 0/1: a real existsSync check against that level's real
      //     source file on disk right now (~/.mnemosyne/level0-rules.md via
      //     layer1/level0.ts's DEFAULT_LEVEL0_PATH; this root's mnemosyne.md).
      //   - levels 2-4: is at least one of that level's mapped adapter names
      //     (levels.ts's own adapterNames -- the one place this mapping
      //     lives, never duplicated here) present in
      //     client.getConfiguredLayers()'s CURRENT resolved cascade -- a
      //     READ of that already-computed output only, so this route can
      //     never disagree with what GET /layers itself would report.
      //
      // ro-01-memory-levels-scoped-extraction (epic mnemosyne-repo-
      // onboarding): the computation itself now lives in
      // memory-levels/computeMemoryLevels.ts, parameterized on
      // (client, repoRoot, level0Path?) so it can also be called against an
      // ARBITRARY repo (onboardRepo(), ro-02). This route is now a thin
      // caller of that extracted function against its own existing
      // singleton `client` + `ROOT_DIRECTORY` -- same output, zero behavior
      // change.
      applyPersonaCors(req, res);
      const levels = computeMemoryLevels(client, ROOT_DIRECTORY);
      return sendJson(res, 200, { levels });
    }

    if (route === 'GET /persona') {
      // pw-02-get-persona-routes-cors: no ?repo -> global tiers
      // (top-orchestrator/company-director/project-orchestrator), wrapping
      // pw-01's listGlobalPersonas directly. ?repo=<path> SWITCHES to that
      // repo's code-architect personas (listRepoLocalPersonas) -- not
      // merged with the global list (vertical-plan.md's Resolved
      // Ambiguities #2: "?repo= switches to repo-local").
      applyPersonaCors(req, res);
      const repo = url.searchParams.get('repo');
      if (repo) {
        const personas = listRepoLocalPersonas(repo).map((p) => ({
          tier: REPO_LOCAL_PERSONA_TIER,
          scopeId: p.scopeId,
        }));
        return sendJson(res, 200, { personas });
      }
      return sendJson(res, 200, { personas: listGlobalPersonas() });
    }

    // pu-03-draft-persona-routes: 5 new draft-route branches, checked BEFORE
    // the existing generic GET/POST /persona/:tier/:scopeId handlers below
    // (design-discussion.md §9 judgment call #7) -- a 3-segment
    // /persona/draft/:tier/:scopeId path happens to fail those handlers' own
    // segments.length !== 2 guard today, but relying on that as the ONLY
    // protection would be fragile/incidental; explicit dispatch ordering
    // (this block runs first, in source order) is the real guarantee. Wraps
    // pu-02's persona-draft-store.ts functions (writeDraftPersona/
    // readDraftPersona/listDraftPersonas/disposeDraftPersona) directly -- no
    // re-implemented storage logic here. The OPTIONS preflight handler above
    // already covers every path under this prefix with zero changes needed
    // (its own check, `url.pathname.startsWith('/persona/')`, structurally
    // includes '/persona/draft/*'), and applyPersonaCors is reused unchanged
    // on every branch below -- never a second CORS implementation.
    if (url.pathname === '/persona/draft' || url.pathname.startsWith('/persona/draft/')) {
      applyPersonaCors(req, res);
      const draftSegments =
        url.pathname === '/persona/draft'
          ? []
          : url.pathname.slice('/persona/draft/'.length).split('/').filter(Boolean);

      // GET /persona/draft -- list every ACTIVE draft (pu-02's
      // listDraftPersonas). Global tiers always included; ?repo=<path> ADDS
      // that repo's code-architect drafts alongside them (listDraftPersonas'
      // own contract) -- NOT a "switch" the way GET /persona's ?repo= is
      // (pw-02), since a draft reviewer plausibly wants to see everything
      // pending across both stores at once.
      if (draftSegments.length === 0) {
        if (req.method !== 'GET') {
          return sendJson(res, 404, { error: { code: 'not_found', message: `no route for ${route}` } });
        }
        const repoParam = url.searchParams.get('repo');
        const listCtx: DraftPersonaContext = repoParam ? { repoRoot: repoParam } : {};
        return sendJson(res, 200, { drafts: listDraftPersonas(listCtx) });
      }

      // GET/POST/DELETE /persona/draft/:tier/:scopeId
      if (draftSegments.length === 2) {
        const [tierParam, scopeId] = draftSegments as [string, string];
        if (!(TIERS as readonly string[]).includes(tierParam)) {
          return badRequest(res, 'invalid_tier', `"tier" must be one of: ${TIERS.join(', ')}`);
        }
        const tier = tierParam as Tier;
        const isRepoLocal = PERSONA_STORE_BY_TIER[tier] === 'repo-local';

        if (req.method === 'GET') {
          // GET /persona/draft/:tier/:scopeId -- read one active draft back,
          // wrapping readDraftPersona directly (no re-implemented parsing --
          // pw-01's write-path non-duplication concern applies equally here).
          const repoParam = url.searchParams.get('repo');
          if (isRepoLocal && !repoParam) {
            return badRequest(
              res,
              'missing_repo',
              '"repo" query parameter is required to read a code-architect draft persona',
            );
          }
          const readCtx: DraftPersonaContext = repoParam ? { repoRoot: repoParam } : {};
          try {
            return sendJson(res, 200, { draft: readDraftPersona(tier, scopeId, readCtx) });
          } catch (error) {
            return sendJson(res, 404, {
              error: { code: 'draft_not_found', message: error instanceof Error ? error.message : String(error) },
            });
          }
        }

        if (req.method === 'POST') {
          // POST /persona/draft/:tier/:scopeId -- propose a new draft, or
          // overwrite the existing active one for the same identity (pu-02's
          // own "one active draft per identity" contract), wrapping
          // writeDraftPersona directly. Same "the body IS the candidate,
          // `repo` is this route's own routing metadata and is stripped
          // before the rest is passed through UNCHANGED" convention as
          // POST /persona/:tier/:scopeId below -- no re-implemented
          // validation here; writeDraftPersona's own structural-only check
          // is deliberately the single enforcement point at this layer
          // (assertValidPersona is NOT applied until approve, below -- a
          // draft may be incomplete while a human is still reviewing it).
          let body: Record<string, unknown>;
          try {
            body = await readJsonBody(req);
          } catch (error) {
            const e = error as HttpError;
            return badRequest(res, e.code ?? 'invalid_body', e.message);
          }
          const { repo: bodyRepo, ...candidate } = body;

          const proposeCtx: DraftPersonaContext = {};
          if (isRepoLocal) {
            const repo = (typeof bodyRepo === 'string' && bodyRepo) || url.searchParams.get('repo');
            if (!repo) {
              return badRequest(
                res,
                'missing_repo',
                '"repo" (request body field or query parameter) is required to propose a code-architect draft persona',
              );
            }
            proposeCtx.repoRoot = repo;
          }

          try {
            const filePath = writeDraftPersona(candidate, proposeCtx);
            return sendJson(res, 201, { proposed: true, tier, scopeId, path: filePath });
          } catch (error) {
            return badRequest(res, 'invalid_draft', error instanceof Error ? error.message : String(error));
          }
        }

        if (req.method === 'DELETE') {
          // DELETE /persona/draft/:tier/:scopeId -- discard, ALWAYS via
          // disposeDraftPersona('discarded') (archive-by-move, mirrors this
          // codebase's own flight-status philosophy), never a bare
          // filesystem delete (design-discussion.md §9 judgment call #5).
          const repoParam = url.searchParams.get('repo');
          if (isRepoLocal && !repoParam) {
            return badRequest(
              res,
              'missing_repo',
              '"repo" query parameter is required to discard a code-architect draft persona',
            );
          }
          const discardCtx: DraftPersonaContext = repoParam ? { repoRoot: repoParam } : {};
          try {
            const archivedDraftPath = disposeDraftPersona(tier, scopeId, 'discarded', discardCtx);
            return sendJson(res, 200, { discarded: true, tier, scopeId, archivedDraftPath });
          } catch (error) {
            return sendJson(res, 404, {
              error: { code: 'draft_not_found', message: error instanceof Error ? error.message : String(error) },
            });
          }
        }

        return sendJson(res, 404, { error: { code: 'not_found', message: `no route for ${route}` } });
      }

      // POST /persona/draft/:tier/:scopeId/approve -- the human-in-the-loop
      // gate ask 2 exists to create. Commits via the SAME write primitive
      // POST /persona/:tier/:scopeId already uses, completely unchanged --
      // no re-implemented validation at this route layer (design-
      // discussion.md §5 risk table's "no second write path" guardrail;
      // assertValidPersona, inside writeGlobalPersona/writeRepoLocalPersona,
      // remains the single real enforcement point, exercised for the first
      // time only at this moment).
      if (draftSegments.length === 3 && draftSegments[2] === 'approve') {
        const [tierParam, scopeId] = draftSegments as [string, string, string];
        if (!(TIERS as readonly string[]).includes(tierParam)) {
          return badRequest(res, 'invalid_tier', `"tier" must be one of: ${TIERS.join(', ')}`);
        }
        const tier = tierParam as Tier;

        if (req.method !== 'POST') {
          return sendJson(res, 404, { error: { code: 'not_found', message: `no route for ${route}` } });
        }

        const isRepoLocal = PERSONA_STORE_BY_TIER[tier] === 'repo-local';
        const repoParam = url.searchParams.get('repo');
        if (isRepoLocal && !repoParam) {
          return badRequest(
            res,
            'missing_repo',
            '"repo" query parameter is required to approve a code-architect draft persona',
          );
        }
        const approveCtx: DraftPersonaContext = repoParam ? { repoRoot: repoParam } : {};

        let draft: DraftPersonaCandidate;
        try {
          draft = readDraftPersona(tier, scopeId, approveCtx);
        } catch (error) {
          return sendJson(res, 404, {
            error: { code: 'draft_not_found', message: error instanceof Error ? error.message : String(error) },
          });
        }

        // Strip draft-only metadata (proposedBy/proposedAt/sourceSummary)
        // BEFORE calling the real write primitive -- proposedBy/proposedAt
        // are re-attached below as `origin`, in the shape persona.ts's
        // `Persona.origin` actually defines; sourceSummary never survives
        // into the real store at all (it stays draft-only source material,
        // consumed instead by fireDraftApprovalRemember below).
        const { proposedBy, proposedAt, sourceSummary, ...rest } = draft;

        // puf-03-post-approval-provenance-note: populate `origin` ONLY when
        // the draft genuinely carried BOTH proposedBy and proposedAt -- a
        // human-typed draft (pf-05/pf-06: a human can attach real source
        // material too, but that alone doesn't set proposedBy/proposedAt)
        // commits with NO origin field at all, never a fabricated one
        // (puf-03's own acceptance criteria). `approvedAt` is captured HERE,
        // fresh, at the real moment of commit -- it is not, and cannot be,
        // copied from the draft (persona.ts's `PersonaOrigin` doc comment).
        const hasRealProvenance =
          typeof proposedBy === 'string' &&
          proposedBy.trim() !== '' &&
          typeof proposedAt === 'string' &&
          proposedAt.trim() !== '';
        const candidate = hasRealProvenance
          ? { ...rest, origin: { proposedBy, proposedAt, approvedAt: new Date().toISOString() } }
          : rest;

        let filePath: string;
        try {
          filePath = isRepoLocal
            ? writeRepoLocalPersona(repoParam as string, candidate)
            : writeGlobalPersona(candidate);
        } catch (error) {
          // assertValidPersona (or the store's own tier guard) rejected the
          // candidate -- nothing was written, and the draft is left ACTIVE
          // (not archived) so a human can go fix it, per this story's own
          // acceptance criteria.
          return badRequest(res, 'invalid_persona', error instanceof Error ? error.message : String(error));
        }

        // Only NOW, after the real write has genuinely succeeded, archive
        // the draft -- disposeDraftPersona('approved'), never a bare delete.
        const archivedDraftPath = disposeDraftPersona(tier, scopeId, 'approved', approveCtx);

        // remember() fires HERE, after the write succeeds, ONLY when the
        // draft actually carried a real sourceSummary (agent-proposed, via
        // pu-07's bounded crawl) -- a human-typed draft has no real source
        // material to index, and this route must never invent placeholder
        // text just to have something to remember() (design-discussion.md
        // OQ3/§9.9, "remember() fires on approval, never on draft creation").
        let remembered: RememberCallResult | null = null;
        if (typeof sourceSummary === 'string' && sourceSummary.trim() !== '') {
          remembered = await fireDraftApprovalRemember(tier, scopeId, sourceSummary, candidate.displayName);
        }

        return sendJson(res, 200, {
          approved: true,
          store: isRepoLocal ? 'repo-local' : 'global',
          tier,
          scopeId,
          path: filePath,
          archivedDraftPath,
          remembered,
        });
      }

      return sendJson(res, 404, { error: { code: 'not_found', message: `no route for ${route}` } });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/persona/')) {
      // GET /persona/:tier/:scopeId -- read one persona back, wrapping
      // readGlobalPersona/readRepoLocalPersona directly (no re-implemented
      // parsing/validation -- pw-01's write-path non-duplication concern
      // applies equally to these read wrappers).
      applyPersonaCors(req, res);
      const segments = url.pathname.slice('/persona/'.length).split('/').filter(Boolean);
      if (segments.length !== 2) {
        return sendJson(res, 404, { error: { code: 'not_found', message: `no route for ${route}` } });
      }
      const [tierParam, scopeId] = segments as [string, string];
      if (!(TIERS as readonly string[]).includes(tierParam)) {
        return badRequest(res, 'invalid_tier', `"tier" must be one of: ${TIERS.join(', ')}`);
      }
      const tier = tierParam as Tier;

      try {
        if (PERSONA_STORE_BY_TIER[tier] === 'global') {
          return sendJson(res, 200, { persona: readGlobalPersona(tier, scopeId) });
        }
        // repo-local (code-architect): requires ?repo=<path> -- there is no
        // ambient "current repo" for this HTTP service to guess at.
        const repo = url.searchParams.get('repo');
        if (!repo) {
          return badRequest(res, 'missing_repo', '"repo" query parameter is required to read a code-architect persona');
        }
        return sendJson(res, 200, { persona: readRepoLocalPersona(repo, scopeId) });
      } catch (error) {
        // readGlobalPersona/readRepoLocalPersona throw for "no persona at
        // this path" (and for on-disk schema-validation failure) -- both are
        // "this persona is not available", i.e. 404, not a 500.
        return sendJson(res, 404, {
          error: {
            code: 'persona_not_found',
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }

    if (req.method === 'POST' && url.pathname.startsWith('/persona/')) {
      // POST /persona/:tier/:scopeId -- pw-15-post-persona-routes: the 4th
      // write-capable transport alongside CLI/MCP/skill-harness. Wraps
      // writeGlobalPersona/writeRepoLocalPersona directly -- no
      // re-implemented validation/locking logic here, the exact same
      // "wrap, never re-derive" principle the GET routes above already
      // follow. Reuses applyPersonaCors as-is (no second CORS block).
      applyPersonaCors(req, res);
      const segments = url.pathname.slice('/persona/'.length).split('/').filter(Boolean);
      if (segments.length !== 2) {
        return sendJson(res, 404, { error: { code: 'not_found', message: `no route for ${route}` } });
      }
      const [tierParam, urlScopeId] = segments as [string, string];
      if (!(TIERS as readonly string[]).includes(tierParam)) {
        return badRequest(res, 'invalid_tier', `"tier" must be one of: ${TIERS.join(', ')}`);
      }
      const tier = tierParam as Tier;

      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        const e = error as HttpError;
        return badRequest(res, e.code ?? 'invalid_body', e.message);
      }

      // The request body IS the persona candidate itself -- the same bare
      // {tier, scopeId, displayName, scope, sections, parentRefs?} shape the
      // CLI's --file YAML, MCP's persona_create tool, and skill-harness's
      // personaCreateAction all already accept, just parsed as JSON instead
      // of YAML here. `repo`, when present, is THIS route's own routing
      // metadata (which store to write to) -- not a persona field -- so
      // it's stripped out before the rest is passed through UNCHANGED as
      // the write functions' candidate argument. The URL's :tier segment
      // only selects which store to call (mirrors the GET route's dispatch
      // above); it is deliberately NOT cross-checked against the body's own
      // `tier` field here -- that's exactly the "tier/target mismatch" case
      // writeGlobalPersona/writeRepoLocalPersona's own assertGlobalTier/
      // assertRepoLocalTier guards already reject (a code-architect
      // candidate routed at the global store, or vice versa), so re-checking
      // it here would be the reimplemented-validation this story explicitly
      // rules out.
      // puf-03-post-approval-provenance-note, acceptance criterion 5 (an
      // explicit, DOCUMENTED decision, not an accidental side effect): a
      // direct (non-draft) write through THIS route always CLEARS `origin`,
      // even if the posted body happens to still carry one (e.g. a caller
      // fetched the live persona, edited a field, and POSTed the whole
      // object back unchanged). Decision: CLEAR, not keep. Rationale --
      // `origin` is a provenance claim ("this content traces back to an
      // agent's proposal, approved on this date"); this route is NOT the
      // draft-approve flow (server.ts's own POST /persona/draft/:tier/
      // :scopeId/approve, above) and has no draft to read a genuine
      // proposedBy/proposedAt/approvedAt from, so it cannot construct a new,
      // truthful origin for whatever changed. Passing an old one through
      // unchanged would silently misrepresent freshly hand-edited content as
      // still being "as the agent proposed it," which is exactly the kind
      // of fabricated/stale provenance puf-03's own acceptance criteria rule
      // out for the CREATE path -- the same standard applies here. This also
      // keeps a single, unambiguous answer to "where did this persona's
      // `origin` come from?": only ever the approve route above, never this
      // one, regardless of what a client sends -- mirrors this file's
      // existing "no second write path" guardrail (design-discussion.md §5)
      // by making sure no second path can plant/preserve `origin` either.
      const { repo: bodyRepo, origin: _originClearedOnDirectWrite, ...candidate } = body;

      try {
        if (PERSONA_STORE_BY_TIER[tier] === 'global') {
          const filePath = writeGlobalPersona(candidate);
          return sendJson(res, 201, { created: true, store: 'global', tier, scopeId: urlScopeId, path: filePath });
        }
        // repo-local (code-architect): requires a repo target -- same
        // convention as the GET repo-local routes' ?repo=, accepted from
        // either the request body (`repo`) or the query string (?repo=)
        // (vertical-plan.md's Resolved Ambiguities #2: "repo-local writes
        // need repo in the request body or query, same convention as the
        // GET").
        const repo = (typeof bodyRepo === 'string' && bodyRepo) || url.searchParams.get('repo');
        if (!repo) {
          return badRequest(
            res,
            'missing_repo',
            '"repo" (request body field or query parameter) is required to write a code-architect persona',
          );
        }
        const filePath = writeRepoLocalPersona(repo, candidate);
        return sendJson(res, 201, { created: true, store: 'repo-local', tier, scopeId: urlScopeId, path: filePath });
      } catch (error) {
        // writeGlobalPersona/writeRepoLocalPersona throw -- writing nothing
        // to disk -- for every validation failure: mandateSections
        // smuggling, tier/store mismatch, or a schema violation
        // (persona.ts's assertValidPersona/assertGlobalTier/
        // assertRepoLocalTier). All of these are "the caller sent an
        // invalid candidate," i.e. a 400 via the existing badRequest
        // convention, never a 500.
        return badRequest(
          res,
          'invalid_persona',
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    if (route === 'POST /recall') {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        const e = error as HttpError;
        return badRequest(res, e.code ?? 'invalid_body', e.message);
      }

      if (typeof body.query !== 'string') {
        return badRequest(res, 'missing_query', '"query" is required and must be a string');
      }
      if (typeof body.scope !== 'string' || !SCOPES.has(body.scope as Scope)) {
        return badRequest(res, 'invalid_scope', `"scope" is required and must be one of: ${[...SCOPES].join(', ')}`);
      }
      if (body.intent !== undefined && !INTENTS.has(body.intent as string)) {
        return badRequest(res, 'invalid_intent', `"intent" must be one of: ${[...INTENTS].join(', ')}`);
      }

      const result = await client.recall(body.query, body.scope as Scope, body.intent as 'narrow' | 'broad' | undefined);
      return sendJson(res, 200, result);
    }

    if (route === 'POST /remember') {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        const e = error as HttpError;
        return badRequest(res, e.code ?? 'invalid_body', e.message);
      }

      const content = body.content as { text?: unknown; metadata?: Record<string, unknown> } | undefined;
      if (!content || typeof content.text !== 'string') {
        return badRequest(res, 'missing_content', '"content.text" is required and must be a string');
      }
      if (typeof body.scope !== 'string' || !SCOPES.has(body.scope as Scope)) {
        return badRequest(res, 'invalid_scope', `"scope" is required and must be one of: ${[...SCOPES].join(', ')}`);
      }
      if (body.layer !== undefined && !LAYERS.has(body.layer as Layer)) {
        return badRequest(res, 'invalid_layer', `"layer" must be one of: ${[...LAYERS].join(', ')}`);
      }

      const result = await client.remember(
        content.metadata !== undefined
          ? { text: content.text, metadata: content.metadata }
          : { text: content.text },
        body.scope as Scope,
        body.layer as Layer | undefined,
      );
      return sendJson(res, 200, result);
    }

    if (route === 'POST /ingest') {
      // ro-10-document-ingestion-primitive: a thin transport wrap of
      // ingestDocument() -- no chunking/bounding/format logic of its own,
      // see that module's doc comment for the real contract. `filename`/
      // `tag`/`scope` are genuinely optional (a free-text description/CV
      // with no file at all is the trivial subcase), so each is only
      // forwarded when the caller actually sent it -- never an explicit
      // `undefined` passed through (exactOptionalPropertyTypes).
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        const e = error as HttpError;
        return badRequest(res, e.code ?? 'invalid_body', e.message);
      }

      if (typeof body.content !== 'string') {
        return badRequest(res, 'missing_content', '"content" is required and must be a string');
      }
      if (body.scope !== undefined && (typeof body.scope !== 'string' || !SCOPES.has(body.scope as Scope))) {
        return badRequest(res, 'invalid_scope', `"scope" must be one of: ${[...SCOPES].join(', ')}`);
      }
      if (body.filename !== undefined && typeof body.filename !== 'string') {
        return badRequest(res, 'invalid_filename', '"filename" must be a string when provided');
      }
      if (body.tag !== undefined && typeof body.tag !== 'string') {
        return badRequest(res, 'invalid_tag', '"tag" must be a string when provided');
      }

      const result = await ingestDocument(client, {
        content: body.content,
        ...(typeof body.filename === 'string' ? { filename: body.filename } : {}),
        ...(typeof body.tag === 'string' ? { tag: body.tag } : {}),
        ...(typeof body.scope === 'string' ? { scope: body.scope as Scope } : {}),
      });
      return sendJson(res, 200, result);
    }

    if (route === 'POST /crawl') {
      // ro-11-bounded-website-crawl: a thin transport wrap of
      // crawlAndIngest() -- no fetch/SSRF-guard/robots.txt/extraction logic
      // of its own, see that module's own doc comment for the real
      // contract. `scope`/`tag`/`multiPage`/`timeoutMs` are genuinely
      // optional and only forwarded when the caller actually sent them --
      // never an explicit `undefined` passed through (exactOptionalPropertyTypes).
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        const e = error as HttpError;
        return badRequest(res, e.code ?? 'invalid_body', e.message);
      }

      if (typeof body.url !== 'string') {
        return badRequest(res, 'missing_url', '"url" is required and must be a string');
      }
      if (body.scope !== undefined && (typeof body.scope !== 'string' || !SCOPES.has(body.scope as Scope))) {
        return badRequest(res, 'invalid_scope', `"scope" must be one of: ${[...SCOPES].join(', ')}`);
      }
      if (body.tag !== undefined && typeof body.tag !== 'string') {
        return badRequest(res, 'invalid_tag', '"tag" must be a string when provided');
      }
      if (body.timeoutMs !== undefined && typeof body.timeoutMs !== 'number') {
        return badRequest(res, 'invalid_timeout_ms', '"timeoutMs" must be a number when provided');
      }
      let multiPage: { maxPages: number } | undefined;
      if (body.multiPage !== undefined) {
        const mp = body.multiPage as { maxPages?: unknown } | null;
        if (!mp || typeof mp.maxPages !== 'number') {
          return badRequest(res, 'invalid_multi_page', '"multiPage" must be an object with a numeric "maxPages" when provided');
        }
        multiPage = { maxPages: mp.maxPages };
      }

      const result = await crawlAndIngest(client, body.url, {
        ...(typeof body.scope === 'string' ? { scope: body.scope as Scope } : {}),
        ...(typeof body.tag === 'string' ? { tag: body.tag } : {}),
        ...(multiPage !== undefined ? { multiPage } : {}),
        ...(typeof body.timeoutMs === 'number' ? { timeoutMs: body.timeoutMs } : {}),
      } satisfies CrawlAndIngestOptions);
      return sendJson(res, 200, result);
    }

    return sendJson(res, 404, { error: { code: 'not_found', message: `no route for ${route}` } });
  } catch (error) {
    return sendJson(res, 500, {
      error: {
        code: 'internal_error',
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[mnemosyne] client HTTP API listening on http://127.0.0.1:${PORT} (root=${ROOT_DIRECTORY})`);
});
