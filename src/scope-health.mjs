// scope-health.mjs — PANT-833: GET /health's per-scope collection check.
//
// A scope whose Qdrant collection doesn't exist recalls 0 hits with only a
// per-call error, so nothing flagged it. This check reports every configured
// scope's collection as {collection, exists, points} and names the missing
// ones, so /health can say `status: "degraded"` instead of staying quiet.
//
// Cached exactly like engine.mjs's reconcileDrift(): health never blocks on
// a live Qdrant read. It returns the last result immediately and refreshes
// in the background (deduped) once the cache is older than maxAgeMs; before
// the first refresh finishes it reports `scopes_checking: true`.

/**
 * Pure: joins the configured scope -> collection map with a collections
 * listing. `missing_scopes` is sorted for stable output.
 */
export function summarizeScopeCollections(scopeCollections, listing) {
  const names = new Set(listing.names || []);
  const points = listing.points || {};
  const scopes = {};
  const missing = [];
  for (const [scope, collection] of Object.entries(scopeCollections || {})) {
    const exists = names.has(collection);
    scopes[scope] = { collection, exists, points: exists ? (points[collection] ?? null) : 0 };
    if (!exists) missing.push(scope);
  }
  return { scopes, missing_scopes: missing.sort() };
}

/**
 * Returns an async check() -> one of:
 *   {scopes, missing_scopes, scopes_checked_at, scopes_checking}
 *   {scopes: null, missing_scopes: null, scope_check_error, scopes_checked_at, scopes_checking}
 *   {scopes: null, missing_scopes: null, scopes_checking: true}   (cold start)
 * `scopeMap()` resolves the configured scopes; `listCollections(wanted)` is
 * the one Qdrant listing (collection-exists.mjs's listCollections()).
 */
export function createScopeHealthCheck({ scopeMap, listCollections, maxAgeMs = 5 * 60_000 }) {
  let cache = null; // { result, at }
  let inFlight = null;

  async function refresh() {
    try {
      const m = await scopeMap();
      const scopeCollections = m.scopes || {};
      const listing = await listCollections([...new Set(Object.values(scopeCollections))]);
      return summarizeScopeCollections(scopeCollections, listing);
    } catch (e) {
      return { scopes: null, missing_scopes: null, scope_check_error: String(e.message || e) };
    }
  }

  return async function check() {
    const isStale = !cache || Date.now() - cache.at > maxAgeMs;
    if (isStale && !inFlight) {
      inFlight = refresh()
        .then((result) => {
          cache = { result, at: Date.now() };
          return result;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    if (cache) {
      return { ...cache.result, scopes_checked_at: new Date(cache.at).toISOString(), scopes_checking: isStale };
    }
    return { scopes: null, missing_scopes: null, scopes_checking: true };
  };
}

/**
 * Overall /health status. `ok` stays engine liveness only; `status` also
 * folds in scope coverage: "degraded" if the engine is down, any scope's
 * collection is missing, or the scope check itself failed; "checking" until
 * the first scope check has finished; otherwise "ok".
 */
export function healthStatus(engineOk, scopeCheck) {
  if (!engineOk) return "degraded";
  if (scopeCheck.scope_check_error) return "degraded";
  if (Array.isArray(scopeCheck.missing_scopes) && scopeCheck.missing_scopes.length > 0) return "degraded";
  if (!scopeCheck.scopes) return "checking";
  return "ok";
}
