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
 *   POST /recall  {query, scope, intent?}            -> RecallResult
 *   POST /remember {content: {text, metadata?}, scope, layer?} -> RememberResult
 *
 * No authentication — localhost-only for this slice; auth is future work.
 *
 * CORS: /persona/* and /layers responses carry an Access-Control-Allow-Origin
 * header (pw-02-get-persona-routes-cors; extended to /layers by
 * pw-04-layer-stack-visibility) -- the standalone UI is served from
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
import { PERSONA_STORE_BY_TIER } from './layer1/persona.js';
import { listGlobalPersonas, readGlobalPersona, writeGlobalPersona } from './layer1/persona-store-global.js';
import {
  listRepoLocalPersonas,
  readRepoLocalPersona,
  REPO_LOCAL_PERSONA_TIER,
  writeRepoLocalPersona,
} from './layer1/persona-store-repo-local.js';
import { TIERS, type Tier } from './layer1/tiers.js';

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
      const { repo: bodyRepo, ...candidate } = body;

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
