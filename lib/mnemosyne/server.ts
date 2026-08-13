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
 *   POST /recall  {query, scope, intent?}            -> RecallResult
 *   POST /remember {content: {text, metadata?}, scope, layer?} -> RememberResult
 *
 * No authentication — localhost-only for this slice; auth is future work.
 */

import http from 'node:http';
import { stat } from 'node:fs/promises';
import { MnemosyneClient } from './client.js';
import type { Layer, Scope } from './interfaces.js';

const PORT = Number(process.env.MNEMOSYNE_PORT || 3141);
const ROOT_DIRECTORY = process.env.MNEMOSYNE_ROOT_DIR || process.cwd();

const SCOPES: ReadonlySet<Scope> = new Set(['project', 'enterprise', 'meta']);
const INTENTS = new Set(['narrow', 'broad']);
const LAYERS: ReadonlySet<Layer> = new Set([
  'meta',
  'enterprise',
  'project',
  'code-graph',
  'vector',
  'file',
]);

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
      return sendJson(res, 200, { layers: client.getConfiguredLayers() });
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
