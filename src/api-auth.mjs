// api-auth.mjs: network and read auth for the Mnemosyne HTTP surface (PANT-1398).
//
// Before this, src/server.mjs called server.listen(PORT) with no host, so the
// service answered on every interface (lsof showed *:8477) and anyone on the
// local network could call /recall, /grep, /note and the graph routes.
//
// Now:
// - The server binds MNEMOSYNE_HOST, default 127.0.0.1. A container that
//   other containers reach by name sets MNEMOSYNE_HOST=0.0.0.0 explicitly.
// - Every route except GET /health, GET /healthz and the static /ui shell
//   needs `Authorization: Bearer <token>`. The token comes from the local
//   vault (Portunus), injected either as MNEMOSYNE_API_TOKEN or as a file
//   named by MNEMOSYNE_API_TOKEN_FILE. MNEMOSYNE_ADMIN_TOKEN is accepted too,
//   since it already authorizes strictly more.
// - With no API token configured, only loopback callers get past the gate
//   (403 otherwise), so a standalone install still works and a deployment
//   that binds 0.0.0.0 but forgot the token fails closed.
//
// Clients resolve the token the same way (readApiToken) and send it on every
// request; see hooks/lib/mnemo-client.mjs and bin/mnemosyne-skill-helper.mjs.

import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";

export const DEFAULT_HOST = "127.0.0.1";

/**
 * The API token from the environment: MNEMOSYNE_API_TOKEN, else the trimmed
 * contents of MNEMOSYNE_API_TOKEN_FILE. Returns "" when neither is set.
 * Throws when MNEMOSYNE_API_TOKEN_FILE is set but unreadable or empty: a
 * configured-but-missing token must not silently fall back to "no token".
 */
export function readApiToken(env = process.env) {
  const direct = String(env.MNEMOSYNE_API_TOKEN || "").trim();
  if (direct) return direct;
  const file = String(env.MNEMOSYNE_API_TOKEN_FILE || "").trim();
  if (!file) return "";
  let token;
  try {
    token = readFileSync(file, "utf8").trim();
  } catch (e) {
    throw new Error(`MNEMOSYNE_API_TOKEN_FILE=${file} could not be read: ${e.code || e.message}`);
  }
  if (!token) throw new Error(`MNEMOSYNE_API_TOKEN_FILE=${file} is empty`);
  return token;
}

/** The host to bind: MNEMOSYNE_HOST, default 127.0.0.1. */
export function resolveHost(env = process.env) {
  return String(env.MNEMOSYNE_HOST || "").trim() || DEFAULT_HOST;
}

export function isLoopbackHost(host) {
  const h = String(host || "").trim().toLowerCase();
  return h === "localhost" || h === "::1" || /^127\./.test(h) || /^::ffff:127\./.test(h);
}

export function isLoopbackAddress(address) {
  const a = String(address || "");
  return a === "::1" || /^(::ffff:)?127\./.test(a);
}

/** Constant-time check of `Authorization: Bearer <token>` against `token`. */
export function bearerMatches(req, token) {
  if (!token) return false;
  const header = String(req.headers.authorization || "");
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return false;
  const given = Buffer.from(m[1].trim());
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

/**
 * Routes that need no token: the health probes (Salus/Argus and the desktop
 * sidecar poll them) and the static UI shell, which holds no memory data and
 * has to load before it can ask the operator for the token.
 */
export function isPublicRoute(method, pathname) {
  if (method !== "GET" && method !== "HEAD") return false;
  return pathname === "/health" || pathname === "/healthz" || pathname === "/ui" || pathname.startsWith("/ui/");
}

/**
 * Builds the gate. Returns null when the request may proceed, else
 * [status, body]. `isLocalPeer(req)` decides loopback for the no-token case.
 */
export function createApiGate({ apiToken, adminToken, isLocalPeer }) {
  return function apiGate(req, pathname) {
    if (isPublicRoute(req.method, pathname)) return null;
    const route = `${req.method} ${pathname}`;
    if (apiToken) {
      if (bearerMatches(req, apiToken) || bearerMatches(req, adminToken)) return null;
      return [
        401,
        {
          error: "missing or wrong API token (Authorization: Bearer <MNEMOSYNE_API_TOKEN>)",
          code: "api_token_required",
          route,
        },
      ];
    }
    if (isLocalPeer(req)) return null;
    return [
      403,
      {
        error: "non-loopback callers are refused until MNEMOSYNE_API_TOKEN is set; then send it as a Bearer token",
        code: "api_token_not_configured",
        route,
      },
    ];
  };
}
