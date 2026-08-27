// app.js — Mnemosyne standalone UI shell (s-01: liveliness + read-only settings).
// Zero third-party deps: vanilla fetch + DOM. Loads once on open, then only on
// manual refresh — no auto-polling in v1 (see design-discussion.md).

// ==================== aha-04-ui-connect-banner (epic:
// mnemosyne-agent-harness-install) ====================
// The FIRST thing in this file, deliberately: this banner's fail-open
// contract (design-discussion.md §1.4 / horizontal-plan.md's cross-cutting
// "nothing in this shell may become invisible because of a JS failure"
// rule) must hold independent of whatever else in this file does or does
// not run/throw later. ui/index.html's own static markup already renders
// the banner fully EXPANDED with zero JS (#connect-banner-main has no
// `hidden` attribute there; #connect-banner-reopen starts `hidden`) — this
// IIFE only ever COLLAPSES it, and only from a real, successfully-read
// localStorage value. Every localStorage access is inside its own try/catch
// (private browsing -- e.g. Safari -- can make `localStorage` throw merely
// on property access, not just on .getItem/.setItem calls), and the whole
// init routine is wrapped in a further try/catch so a missing element or
// any other unexpected error also just leaves the safe expanded default in
// place rather than propagating.
//
// research-brief.md §3 confirmed zero pre-existing `localStorage` usage
// anywhere in this file before this ticket — this is a genuinely new
// persistence mechanism for this codebase's UI.
const CONNECT_BANNER_STORAGE_KEY = "mnemosyne-connect-banner-collapsed";

// Applies `collapsed` to the DOM only -- never touches localStorage itself,
// so this is safe to call unconditionally from initConnectBanner() on first
// paint (whether or not a stored value was readable).
function setConnectBannerCollapsed(collapsed) {
  const main = document.getElementById("connect-banner-main");
  const reopenBtn = document.getElementById("connect-banner-reopen");
  const collapseBtn = document.getElementById("connect-banner-collapse");
  if (!main || !reopenBtn || !collapseBtn) return;
  // The affordance is NEVER fully removed from the page (design-discussion.md
  // §1.4) -- exactly one of #connect-banner-main / #connect-banner-reopen is
  // `hidden` at a time, the other always stays genuinely visible and
  // clickable.
  main.hidden = collapsed;
  reopenBtn.hidden = !collapsed;
  collapseBtn.setAttribute("aria-expanded", String(!collapsed));
  reopenBtn.setAttribute("aria-expanded", String(!collapsed));
}

// Best-effort persistence only. A throw here (private browsing, storage
// quota, disabled storage) is swallowed -- the in-memory toggle this page
// view just made via setConnectBannerCollapsed() above still stands, it
// simply won't survive a reload, which is the correct fail-open outcome
// rather than surfacing an error to the operator over a non-critical
// preference write.
function persistConnectBannerCollapsed(collapsed) {
  try {
    window.localStorage.setItem(CONNECT_BANNER_STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    // localStorage unavailable/throws -- nothing to do; see comment above.
  }
}

(function initConnectBanner() {
  try {
    const collapseBtn = document.getElementById("connect-banner-collapse");
    const reopenBtn = document.getElementById("connect-banner-reopen");
    if (!collapseBtn || !reopenBtn) return; // static markup already fail-open

    // Fail OPEN: only a real, successfully-read "1" collapses the banner.
    // Any throw (e.g. Safari private browsing, where merely reading
    // `window.localStorage` can throw a SecurityError) or any other stored
    // value (missing key on first-ever load, or anything not exactly "1")
    // leaves storedCollapsed false -- expanded, matching the static
    // markup's own zero-JS default exactly.
    let storedCollapsed = false;
    try {
      storedCollapsed = window.localStorage.getItem(CONNECT_BANNER_STORAGE_KEY) === "1";
    } catch {
      storedCollapsed = false;
    }
    setConnectBannerCollapsed(storedCollapsed);

    collapseBtn.addEventListener("click", () => {
      setConnectBannerCollapsed(true);
      persistConnectBannerCollapsed(true);
    });
    reopenBtn.addEventListener("click", () => {
      setConnectBannerCollapsed(false);
      persistConnectBannerCollapsed(false);
    });
  } catch {
    // Any unexpected error anywhere above (e.g. a future markup change)
    // leaves ui/index.html's own static default on screen -- fully
    // expanded, reopen strip hidden -- exactly as fail-open requires.
  }
})();
// ==================== end aha-04-ui-connect-banner ====================

const livelinessStatusEl = document.getElementById("liveliness-status");
const livelinessDetailEl = document.getElementById("liveliness-detail");
const settingsStatusEl = document.getElementById("settings-status");
const settingsFieldsEl = document.getElementById("settings-fields");
const refreshBtn = document.getElementById("refresh-btn");
const lastRefreshedEl = document.getElementById("last-refreshed");
const lanesStatusEl = document.getElementById("lanes-status");
const lanesTbodyEl = document.getElementById("lanes-tbody");
const addLaneForm = document.getElementById("add-lane-form");
const addLaneStatusEl = document.getElementById("add-lane-status");
const personasStatusEl = document.getElementById("personas-status");
const personasTbodyEl = document.getElementById("personas-tbody");
// pu-12-draft-review-approve-ui: loadDrafts()'s own status element (see
// that function, below, for why it's separate from personasStatusEl).
const personasDraftsStatusEl = document.getElementById("personas-drafts-status");

function setStatus(el, kind, text) {
  el.textContent = text;
  el.className = `panel-status ${kind}`;
}

// Renders swarm-memory `check`'s free-text detail as pass/fail lines. Each
// line already carries its own marker (✓ / ✗) from the engine; we just style
// it rather than re-deriving liveliness ourselves.
function renderDetailLines(container, text) {
  container.textContent = "";
  const lines = String(text || "").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const span = document.createElement("div");
    if (/[✗x]|fail|error/i.test(line) && !/^✓/.test(line)) {
      span.className = "line-fail";
    } else if (/^✓|pass/i.test(line)) {
      span.className = "line-pass";
    } else {
      span.className = "line-neutral";
    }
    span.textContent = line;
    container.appendChild(span);
  }
}

async function loadLiveliness() {
  setStatus(livelinessStatusEl, "loading", "checking…");
  livelinessDetailEl.textContent = "";
  try {
    const res = await fetch("/health");
    const body = await res.json();
    if (body.ok) {
      setStatus(livelinessStatusEl, "pass", "PASS — engine reachable");
    } else {
      setStatus(livelinessStatusEl, "fail", "FAIL — engine self-test failed");
    }
    if (body.detail) {
      renderDetailLines(livelinessDetailEl, body.detail);
    } else if (body.error) {
      renderDetailLines(livelinessDetailEl, `✗ ${body.error}`);
    } else {
      renderDetailLines(livelinessDetailEl, `HTTP ${res.status}`);
    }
  } catch (err) {
    setStatus(livelinessStatusEl, "fail", "FAIL — could not reach GET /health");
    renderDetailLines(livelinessDetailEl, `✗ ${err && err.message ? err.message : err}`);
  }
}

function field(dl, label, value) {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value == null || value === "" ? "(unset)" : String(value);
  dl.appendChild(dt);
  dl.appendChild(dd);
}

async function loadSettings() {
  setStatus(settingsStatusEl, "loading", "loading…");
  settingsFieldsEl.textContent = "";
  try {
    const res = await fetch("/config");
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setStatus(settingsStatusEl, "fail", `FAIL — GET /config returned ${res.status}`);
      field(settingsFieldsEl, "error", body.error || `HTTP ${res.status}`);
      return;
    }
    const body = await res.json();
    setStatus(settingsStatusEl, "pass", "loaded");
    field(settingsFieldsEl, "qdrant_url", body.qdrant_url);
    field(
      settingsFieldsEl,
      "embedder",
      body.embedder ? `${body.embedder.provider} / ${body.embedder.model}` : null
    );
    field(settingsFieldsEl, "default_scope", body.default_scope);
    field(settingsFieldsEl, "fallback_collection", body.fallback_collection);
  } catch (err) {
    setStatus(settingsStatusEl, "fail", "FAIL — could not reach GET /config");
    field(settingsFieldsEl, "error", err && err.message ? err.message : String(err));
  }
}

// --- Lanes panel (s-02): renders GET /scopes as a table, plus an add-lane
// form that POSTs to /lanes (the only supported mutation: appending a new
// scope entry to config.toml — see engine.mjs's addLane()).
function laneCell(text) {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}

async function loadLanes() {
  setStatus(lanesStatusEl, "loading", "loading…");
  lanesTbodyEl.textContent = "";
  try {
    const res = await fetch("/scopes");
    const body = await res.json();
    if (!res.ok) {
      setStatus(lanesStatusEl, "fail", `FAIL — GET /scopes returned ${res.status}`);
      return;
    }
    const scopeMap = body.scopes || {};
    const ladderMap = body.ladder || {};
    const names = Object.keys(scopeMap).sort();
    for (const name of names) {
      const tr = document.createElement("tr");
      const ladder = ladderMap[name] || [];
      tr.appendChild(laneCell(name));
      tr.appendChild(laneCell(scopeMap[name]));
      tr.appendChild(laneCell(ladder.length ? ladder.join(" → ") : "—"));
      tr.appendChild(laneCell(name === body.default_scope ? "default" : ""));
      lanesTbodyEl.appendChild(tr);
    }
    setStatus(lanesStatusEl, "pass", `${names.length} lane(s)`);
  } catch (err) {
    setStatus(lanesStatusEl, "fail", "FAIL — could not reach GET /scopes");
  }
}

addLaneForm.addEventListener("submit", async (evt) => {
  evt.preventDefault();
  const submitBtn = addLaneForm.querySelector("button[type=submit]");
  const formData = new FormData(addLaneForm);
  const name = String(formData.get("name") || "").trim();
  const collection = String(formData.get("collection") || "").trim();
  const ladderRaw = String(formData.get("ladder") || "").trim();
  const ladder = ladderRaw
    ? ladderRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  setStatus(addLaneStatusEl, "loading", "adding…");
  submitBtn.disabled = true;
  try {
    const res = await fetch("/lanes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, collection, ladder }),
    });
    const body = await res.json();
    if (!res.ok) {
      setStatus(addLaneStatusEl, "fail", `FAIL — ${body.error || `HTTP ${res.status}`}`);
      return;
    }
    setStatus(addLaneStatusEl, "pass", `added lane '${body.name}' → ${body.collection}`);
    addLaneForm.reset();
    await loadLanes();
  } catch (err) {
    setStatus(addLaneStatusEl, "fail", `FAIL — ${err && err.message ? err.message : err}`);
  } finally {
    submitBtn.disabled = false;
  }
});

// --- Search panel (s-03): query box + scope selector + mode toggle -> GET
// /search (a thin dispatcher over the existing recall()/grep() engine
// functions — see server.mjs). Renders full provenance, every field the
// engine returns, none dropped.
const searchForm = document.getElementById("search-form");
const searchScopeSelect = document.getElementById("search-scope");
const searchStatusEl = document.getElementById("search-status");
const searchTableEl = document.getElementById("search-table");
const searchTbodyEl = document.getElementById("search-tbody");
const searchEmptyStateEl = document.getElementById("search-empty-state");

// Populates the scope <select> from GET /scopes so it always reflects the
// live lanes (including any just-added via the Lanes panel).
async function loadSearchScopes() {
  try {
    const res = await fetch("/scopes");
    if (!res.ok) return;
    const body = await res.json();
    const names = Object.keys(body.scopes || {}).sort();
    const current = searchScopeSelect.value;
    searchScopeSelect.textContent = "";
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "(default scope)";
    searchScopeSelect.appendChild(defaultOpt);
    for (const name of names) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name === body.default_scope ? `${name} (default)` : name;
      searchScopeSelect.appendChild(opt);
    }
    if (names.includes(current)) searchScopeSelect.value = current;
  } catch {
    // Non-fatal — the search form still works with the engine's own default
    // scope if this fails to populate.
  }
}

function searchCell(text) {
  const td = document.createElement("td");
  td.textContent = text == null || text === "" ? "—" : String(text);
  return td;
}

// Renders the hit's top-level `text` (the actual matched chunk content) —
// truncated for the row, full text available via the title tooltip, so the
// most important field for a search result is never silently dropped.
function snippetCell(text) {
  const td = document.createElement("td");
  td.className = "snippet-cell";
  if (text == null || text === "") {
    td.textContent = "—";
    return td;
  }
  const full = String(text);
  td.textContent = full.length > 200 ? full.slice(0, 200) + "…" : full;
  td.title = full;
  return td;
}

// Renders EVERY key/value in a hit's provenance object, so no field the
// engine returns is ever silently dropped (schema differs between
// recall's and grep's provenance shape — this renders whichever is present).
function provenanceCell(provenance) {
  const td = document.createElement("td");
  td.className = "provenance-cell";
  if (!provenance || typeof provenance !== "object") {
    td.textContent = "—";
    return td;
  }
  const dl = document.createElement("dl");
  for (const [key, value] of Object.entries(provenance)) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = value == null || value === "" ? "(null)" : typeof value === "object" ? JSON.stringify(value) : String(value);
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  td.appendChild(dl);
  return td;
}

function renderSearchResults(body) {
  searchTbodyEl.textContent = "";
  const scopesArr = Array.isArray(body.scopes) ? body.scopes : [];
  const hits = scopesArr.flatMap((s) => (Array.isArray(s.hits) ? s.hits : []));

  if (hits.length === 0) {
    searchTableEl.hidden = true;
    searchEmptyStateEl.hidden = false;
    searchEmptyStateEl.textContent = `No hits for this query${body.mode ? ` (${body.mode} mode)` : ""}.`;
    return;
  }

  searchEmptyStateEl.hidden = true;
  searchTableEl.hidden = false;
  for (const h of hits) {
    const tr = document.createElement("tr");
    const layer = h.collection || (h.provenance && h.provenance.collection);
    tr.appendChild(searchCell(layer));
    tr.appendChild(searchCell(h.match_type));
    tr.appendChild(searchCell(h.score == null ? null : h.score.toFixed ? h.score.toFixed(4) : h.score));
    tr.appendChild(searchCell(h.full_path || h.location || h.source));
    tr.appendChild(searchCell(Array.isArray(h.chunk_span) ? h.chunk_span.join(" – ") : h.chunk_span));
    tr.appendChild(searchCell(h.provenance && h.provenance.embed_model));
    tr.appendChild(searchCell(h.provenance && h.provenance.retrieved_at));
    tr.appendChild(snippetCell(h.text));
    tr.appendChild(provenanceCell(h.provenance));
    searchTbodyEl.appendChild(tr);
  }
}

searchForm.addEventListener("submit", async (evt) => {
  evt.preventDefault();
  const submitBtn = searchForm.querySelector("button[type=submit]");
  const formData = new FormData(searchForm);
  const q = String(formData.get("q") || "").trim();
  const scope = String(formData.get("scope") || "").trim();
  const mode = String(formData.get("mode") || "recall");

  setStatus(searchStatusEl, "loading", "searching…");
  searchTableEl.hidden = true;
  searchEmptyStateEl.hidden = true;
  submitBtn.disabled = true;
  try {
    const params = new URLSearchParams({ q, mode });
    if (scope) params.set("scope", scope);
    const res = await fetch("/search?" + params.toString());
    const body = await res.json();
    if (!res.ok) {
      setStatus(searchStatusEl, "fail", `FAIL — ${body.error || `HTTP ${res.status}`}`);
      searchTableEl.hidden = true;
      searchEmptyStateEl.hidden = true;
      return;
    }
    renderSearchResults(body);
    setStatus(searchStatusEl, "pass", `${body.total_hits} hit(s) — ${body.mode} mode`);
  } catch (err) {
    setStatus(searchStatusEl, "fail", `FAIL — ${err && err.message ? err.message : err}`);
  } finally {
    submitBtn.disabled = false;
  }
});

// --- Graph panel (s-04, extended for scale by the la-02-graphify-adapter
// follow-on): renders the configured graph backend's real impact graph
// (GET /graph/stats + GET /graph/edges) as a vanilla SVG node-link diagram —
// no charting/graph-viz library (zero-dep guardrail). Clicking a node fetches
// GET /graph/impact/:node + GET /graph/deps/:node (side inspector) AND
// re-centers the on-canvas view on that node — a real graph can be
// thousands of nodes (Graphify's own graph.json easily is), so the default
// view is a bounded neighborhood around one focus node, not the whole
// graph at once. Full edge data is still fetched ONCE per load and kept
// client-side (`allNodeIds`/`allEdges` below) — every subsequent
// focus/depth/search change is a pure in-memory recompute, no extra network
// round-trip, so exploring stays instant even on a large graph.
//
// READ-ONLY: this panel (and this whole file) never calls `swarm-memory
// graph add`/`graph remove` or any /graph/add or /graph/remove route — graph
// mutation is out of scope for this story. Every request below is a GET.
const graphStatusEl = document.getElementById("graph-status");
const graphBodyEl = document.getElementById("graph-body");
const graphEmptyStateEl = document.getElementById("graph-empty-state");
const graphSvgEl = document.getElementById("graph-svg");
const graphInspectorStatusEl = document.getElementById("graph-inspector-status");
const graphInspectorDetailEl = document.getElementById("graph-inspector-detail");
const graphSelectedNodeEl = document.getElementById("graph-selected-node");
const graphImpactListEl = document.getElementById("graph-impact-list");
const graphImpactEmptyEl = document.getElementById("graph-impact-empty");
const graphDepsListEl = document.getElementById("graph-deps-list");
const graphDepsEmptyEl = document.getElementById("graph-deps-empty");
const graphToolbarEl = document.getElementById("graph-toolbar");
const graphSearchEl = document.getElementById("graph-search");
const graphSearchGoEl = document.getElementById("graph-search-go");
const graphSearchEmptyEl = document.getElementById("graph-search-empty");
const graphDepthEl = document.getElementById("graph-depth");
const graphZoomInEl = document.getElementById("graph-zoom-in");
const graphZoomOutEl = document.getElementById("graph-zoom-out");
const graphZoomResetEl = document.getElementById("graph-zoom-reset");
const graphShowAllEl = document.getElementById("graph-show-all");

const SVG_NS = "http://www.w3.org/2000/svg";
const GRAPH_WIDTH = 640;
const GRAPH_HEIGHT = 480;
// A force layout past a few hundred nodes gets both visually unreadable
// (the "packed circle" failure mode) and slow (this layout is O(n^2) per
// iteration) — this is the line "Show whole graph" warns above, not a hard
// block, since the operator may genuinely want it on a smaller repo's graph.
const LARGE_GRAPH_WARNING_THRESHOLD = 300;
const DEFAULT_NEIGHBORHOOD_MAX_NODES = 60;

// Full graph fetched once per loadGraph() call, then reused for every
// client-side neighborhood recompute below.
let allNodeIds = [];
let allEdges = [];
let currentFocusNode = null;
let currentDepth = 2;

// id -> human-readable label, built from edges' src_label/dst_label (real
// graph-backed responses -- see bin/graphify-bridge.mjs). `src`/`dst` are
// real unique node ids, used for all identity/comparison/positioning;
// idToLabel is ONLY for what gets drawn as visible text -- never use it to
// key or compare nodes, two different nodes can share a label.
let idToLabel = new Map();
function displayLabel(id) {
  return idToLabel.get(id) || shortLabel(id);
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// Last path segment (e.g. "swarm-memory/src/swarm_memory/cli.py" -> "cli.py")
// as the on-canvas label; the full node id is always available via the
// element's <title> tooltip and the click-to-inspect side panel.
function shortLabel(nodeId) {
  const parts = String(nodeId).split("/");
  return parts[parts.length - 1] || String(nodeId);
}

// Undirected BFS out from `focusId` along `edges` (edges are directionally
// labeled src->dst for the impact/deps inspector, but "what's near this
// node" should walk both ways), stopping at `depth` hops or `maxNodes`
// total nodes — whichever comes first. Closer nodes are always kept over
// farther ones (BFS order), so capping at maxNodes never drops a node in
// favor of a more-distant one. Returns { nodeIds, edges } — edges are the
// subset of the input list with BOTH endpoints inside the returned nodeIds
// (so every rendered edge has two real rendered endpoints).
function computeNeighborhood(focusId, edges, { depth = 2, maxNodes = DEFAULT_NEIGHBORHOOD_MAX_NODES } = {}) {
  const adjacency = new Map();
  const addAdj = (a, b) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a).add(b);
  };
  for (const e of edges) {
    addAdj(e.src, e.dst);
    addAdj(e.dst, e.src);
  }

  const included = new Set([focusId]);
  let frontier = [focusId];
  for (let d = 0; d < depth && included.size < maxNodes; d++) {
    const next = [];
    for (const id of frontier) {
      const neighbors = adjacency.get(id);
      if (!neighbors) continue;
      for (const n of neighbors) {
        if (included.size >= maxNodes) break;
        if (!included.has(n)) {
          included.add(n);
          next.push(n);
        }
      }
    }
    frontier = next;
  }

  const nodeIds = Array.from(included);
  const subEdges = edges.filter((e) => included.has(e.src) && included.has(e.dst));
  return { nodeIds, edges: subEdges };
}

// Highest-degree node (most edges touching it) — a reasonable, non-empty
// default focus when nothing has been searched yet. Ties broken by id for
// determinism (same graph -> same default view on reload).
function highestDegreeNode(nodeIds, edges) {
  const degree = new Map(nodeIds.map((id) => [id, 0]));
  for (const e of edges) {
    if (degree.has(e.src)) degree.set(e.src, degree.get(e.src) + 1);
    if (degree.has(e.dst)) degree.set(e.dst, degree.get(e.dst) + 1);
  }
  let best = null;
  let bestDegree = -1;
  for (const id of nodeIds) {
    const d = degree.get(id) || 0;
    if (d > bestDegree || (d === bestDegree && best !== null && id < best)) {
      best = id;
      bestDegree = d;
    }
  }
  return best;
}

// Case-insensitive: exact display-label match first (most useful for a
// user typing a filename/symbol), then substring match anywhere in the
// display label, then substring match on the full id as a last resort.
function findMatchingNode(query, nodeIds) {
  if (!query) return null;
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const exact = nodeIds.find((id) => displayLabel(id).toLowerCase() === q);
  if (exact) return exact;
  const labelSubstring = nodeIds.find((id) => displayLabel(id).toLowerCase().includes(q));
  if (labelSubstring) return labelSubstring;
  return nodeIds.find((id) => id.toLowerCase().includes(q)) || null;
}

// Minimal force-directed layout (Fruchterman-Reingold style: repulsion
// between every node pair + spring attraction along edges + a gentle
// center-pull), run for a fixed number of iterations. Deterministic (nodes
// start on a circle, not randomized) so a reload with unchanged data
// produces the same layout. Fine at this data scale (tens of nodes) per
// design-discussion.md's "vanilla-JS force-layout territory" call.
function forceLayout(nodeIds, edges, { width = GRAPH_WIDTH, height = GRAPH_HEIGHT, iterations = 300 } = {}) {
  const n = nodeIds.length;
  const positions = new Map();
  const radius = Math.min(width, height) / 3;
  nodeIds.forEach((id, i) => {
    const angle = (2 * Math.PI * i) / Math.max(n, 1);
    positions.set(id, {
      x: width / 2 + radius * Math.cos(angle),
      y: height / 2 + radius * Math.sin(angle),
    });
  });
  if (n <= 1) return positions;

  const edgePairs = edges
    .map((e) => [e.src, e.dst])
    .filter(([a, b]) => positions.has(a) && positions.has(b));

  const k = Math.sqrt((width * height) / n);
  const centerX = width / 2;
  const centerY = height / 2;
  const pad = 30;

  for (let iter = 0; iter < iterations; iter++) {
    const disp = new Map(nodeIds.map((id) => [id, { x: 0, y: 0 }]));

    for (let i = 0; i < n; i++) {
      const a = nodeIds[i];
      const pa = positions.get(a);
      for (let j = i + 1; j < n; j++) {
        const b = nodeIds[j];
        const pb = positions.get(b);
        const dx = pa.x - pb.x;
        const dy = pa.y - pb.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const force = (k * k) / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        disp.get(a).x += fx; disp.get(a).y += fy;
        disp.get(b).x -= fx; disp.get(b).y -= fy;
      }
    }

    for (const [a, b] of edgePairs) {
      const pa = positions.get(a);
      const pb = positions.get(b);
      const dx = pa.x - pb.x;
      const dy = pa.y - pb.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const force = (dist * dist) / k;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      disp.get(a).x -= fx; disp.get(a).y -= fy;
      disp.get(b).x += fx; disp.get(b).y += fy;
    }

    const temp = Math.max(1, ((iterations - iter) / iterations) * 8);
    for (const id of nodeIds) {
      const p = positions.get(id);
      const d = disp.get(id);
      const dlen = Math.sqrt(d.x * d.x + d.y * d.y) || 0.01;
      p.x += (d.x / dlen) * Math.min(dlen, temp);
      p.y += (d.y / dlen) * Math.min(dlen, temp);
      p.x += (centerX - p.x) * 0.01;
      p.y += (centerY - p.y) * 0.01;
      p.x = Math.max(pad, Math.min(width - pad, p.x));
      p.y = Math.max(pad, Math.min(height - pad, p.y));
    }
  }

  return positions;
}

function renderNodeList(ulEl, emptyEl, items) {
  ulEl.textContent = "";
  if (!items || items.length === 0) {
    ulEl.hidden = true;
    emptyEl.hidden = false;
    return;
  }
  ulEl.hidden = false;
  emptyEl.hidden = true;
  for (const it of items) {
    const li = document.createElement("li");
    li.textContent = `${it.node} (depth ${it.depth})`;
    if (it.via) li.title = it.via;
    ulEl.appendChild(li);
  }
}

// GET-only: fetches impact + deps for a clicked node and renders them in the
// side inspector. Never calls anything but GET /graph/impact/:node and
// GET /graph/deps/:node.
async function selectGraphNode(node) {
  graphSvgEl.querySelectorAll(".graph-node").forEach((el) => {
    el.classList.toggle("selected", el.dataset.node === node);
  });
  graphSelectedNodeEl.textContent = node;
  setStatus(graphInspectorStatusEl, "loading", "loading…");
  graphInspectorDetailEl.hidden = true;
  try {
    const [impactRes, depsRes] = await Promise.all([
      fetch("/graph/impact/" + encodeURIComponent(node)),
      fetch("/graph/deps/" + encodeURIComponent(node)),
    ]);
    const impactBody = await impactRes.json();
    const depsBody = await depsRes.json();
    if (!impactRes.ok || !depsRes.ok) {
      setStatus(graphInspectorStatusEl, "fail",
        `FAIL — ${(impactBody && impactBody.error) || (depsBody && depsBody.error) || "could not load node detail"}`);
      return;
    }
    renderNodeList(graphImpactListEl, graphImpactEmptyEl, impactBody.impact || []);
    renderNodeList(graphDepsListEl, graphDepsEmptyEl, depsBody.deps || []);
    graphInspectorDetailEl.hidden = false;
    setStatus(graphInspectorStatusEl, "pass", `${impactBody.count} impacted, ${depsBody.count} dep(s)`);
  } catch (err) {
    setStatus(graphInspectorStatusEl, "fail", `FAIL — ${err && err.message ? err.message : err}`);
  }
}

// --- Zoom / pan --------------------------------------------------------
// Plain SVG viewBox manipulation, no library: zoom scales the viewBox
// around the cursor (or the SVG center, for the +/- buttons), pan
// translates it while dragging. `baseViewBox` is reset to fit whatever was
// just rendered (see renderGraph below); zoom/pan act relative to it.
let baseViewBox = { x: 0, y: 0, w: GRAPH_WIDTH, h: GRAPH_HEIGHT };
let currentViewBox = { ...baseViewBox };

function applyViewBox() {
  graphSvgEl.setAttribute(
    "viewBox",
    `${currentViewBox.x} ${currentViewBox.y} ${currentViewBox.w} ${currentViewBox.h}`,
  );
}

function zoomAt(factor, clientX, clientY) {
  const rect = graphSvgEl.getBoundingClientRect();
  // Fraction across the SVG's rendered box the cursor is at (0..1), used to
  // keep that same graph-space point under the cursor after zooming.
  const fx = rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5;
  const fy = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
  const pointX = currentViewBox.x + fx * currentViewBox.w;
  const pointY = currentViewBox.y + fy * currentViewBox.h;

  const minW = baseViewBox.w * 0.05;
  const maxW = baseViewBox.w * 4;
  const newW = Math.min(maxW, Math.max(minW, currentViewBox.w * factor));
  const newH = newW * (currentViewBox.h / currentViewBox.w);

  currentViewBox = {
    x: pointX - fx * newW,
    y: pointY - fy * newH,
    w: newW,
    h: newH,
  };
  applyViewBox();
}

function resetView() {
  currentViewBox = { ...baseViewBox };
  applyViewBox();
}

function panBy(dxClient, dyClient) {
  const rect = graphSvgEl.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  const scaleX = currentViewBox.w / rect.width;
  const scaleY = currentViewBox.h / rect.height;
  currentViewBox = {
    ...currentViewBox,
    x: currentViewBox.x - dxClient * scaleX,
    y: currentViewBox.y - dyClient * scaleY,
  };
  applyViewBox();
}

let panState = null;
// Ctrl/Cmd+wheel zooms (the same convention maps/graph tools generally use)
// — a PLAIN wheel event is left completely alone (no preventDefault, no
// zoom) so scrolling the page while the cursor happens to be over the graph
// still scrolls the page normally instead of getting stuck zooming it.
graphSvgEl.addEventListener("wheel", (evt) => {
  if (!evt.ctrlKey && !evt.metaKey) return;
  evt.preventDefault();
  const factor = evt.deltaY > 0 ? 1.15 : 1 / 1.15;
  zoomAt(factor, evt.clientX, evt.clientY);
}, { passive: false });
graphSvgEl.addEventListener("pointerdown", (evt) => {
  // Only plain-left-button presses can become a drag. Deliberately does NOT
  // call setPointerCapture here — capturing on pointerdown, before any
  // actual movement, redirects the browser's synthesized click event to
  // the capturing element (this SVG) instead of the node the pointer is
  // actually over, which silently broke every node click. Capture is only
  // taken once real movement is confirmed, in pointermove below — a plain
  // click never captures, so it reaches its real target normally.
  if (evt.button !== 0) return;
  panState = { pointerId: evt.pointerId, lastX: evt.clientX, lastY: evt.clientY, moved: false };
});
graphSvgEl.addEventListener("pointermove", (evt) => {
  if (!panState) return;
  const dx = evt.clientX - panState.lastX;
  const dy = evt.clientY - panState.lastY;
  if (!panState.moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) {
    panState.moved = true;
    graphSvgEl.setPointerCapture(panState.pointerId);
  }
  if (!panState.moved) return;
  panState.lastX = evt.clientX;
  panState.lastY = evt.clientY;
  panBy(dx, dy);
});
graphSvgEl.addEventListener("pointerup", () => { panState = null; });
graphSvgEl.addEventListener("pointercancel", () => { panState = null; });
graphZoomInEl.addEventListener("click", () => {
  const rect = graphSvgEl.getBoundingClientRect();
  zoomAt(1 / 1.4, rect.left + rect.width / 2, rect.top + rect.height / 2);
});
graphZoomOutEl.addEventListener("click", () => {
  const rect = graphSvgEl.getBoundingClientRect();
  zoomAt(1.4, rect.left + rect.width / 2, rect.top + rect.height / 2);
});
graphZoomResetEl.addEventListener("click", resetView);

// Draws nodes/edges at the given (already-laid-out) positions into
// graphSvgEl. Pure DOM construction, no layout/sizing decisions — those
// live in renderGraph below, which is the only caller.
function drawGraphElements(nodeIds, edges, positions) {
  graphSvgEl.textContent = "";

  const edgesGroup = svgEl("g", { class: "graph-edges" });
  for (const e of edges) {
    const p1 = positions.get(e.src);
    const p2 = positions.get(e.dst);
    if (!p1 || !p2) continue;
    const line = svgEl("line", { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, class: "graph-edge" });
    const title = svgEl("title");
    title.textContent = `${displayLabel(e.src)} --${e.predicate}--> ${displayLabel(e.dst)} [${e.origin}]`;
    line.appendChild(title);
    edgesGroup.appendChild(line);
  }
  graphSvgEl.appendChild(edgesGroup);

  const nodesGroup = svgEl("g", { class: "graph-nodes" });
  for (const id of nodeIds) {
    const p = positions.get(id);
    const g = svgEl("g", { class: "graph-node", tabindex: "0", role: "button", "aria-label": `node ${id}` });
    g.dataset.node = id;
    if (id === currentFocusNode) g.classList.add("focus");
    const circle = svgEl("circle", { cx: p.x, cy: p.y, r: id === currentFocusNode ? 10 : 7 });
    const label = svgEl("text", { x: p.x + 10, y: p.y + 4, class: "graph-node-label" });
    label.textContent = displayLabel(id);
    const title = svgEl("title");
    title.textContent = id;
    g.appendChild(circle);
    g.appendChild(label);
    g.appendChild(title);
    // Click both inspects (impact/deps side panel) AND re-centers the
    // rendered neighborhood on this node — "drill into" a graph this size
    // means navigating through it node by node, not seeing it all at once.
    const activate = () => {
      if (panState && panState.moved) return; // a drag-release, not a click
      selectGraphNode(id);
      focusOnNode(id);
    };
    g.addEventListener("click", activate);
    g.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        activate();
      }
    });
    nodesGroup.appendChild(g);
  }
  graphSvgEl.appendChild(nodesGroup);
}

// forceLayout's repulsion pass is O(n^2) per iteration -- at the default
// neighborhood size (~60 nodes) 300 iterations is fast and produces a good
// layout, but at "Show whole graph" scale (n in the thousands) 300
// iterations measured ~40 SECONDS on this repo's own 1365-node graph,
// long enough to hang the tab. Keep a fixed total pairwise-operation
// budget (n^2 * iterations ~= budget) instead of a fixed iteration count,
// so cost stays roughly bounded regardless of n -- large graphs get fewer,
// cruder iterations (still fine, since "Show whole graph" already carries
// its own "may be slow/hard to read" warning) rather than none at all.
const LAYOUT_PAIRWISE_OP_BUDGET = 15_000_000;
function layoutIterationsFor(n) {
  if (n <= 1) return 1;
  return Math.max(15, Math.min(300, Math.round(LAYOUT_PAIRWISE_OP_BUDGET / (n * n))));
}

// Splits nodeIds/edges into connected components (plain BFS over an
// adjacency list built from edges, O(n+e) -- cheap, exact, not an estimate)
// and returns them sorted largest-first. Two nodes with zero path between
// them (e.g. two different repos merged with no real dependency, per
// docs/layer-architecture-v2-plan.md's la-09 finding) will never land in
// the same component, no matter how the force layout's physics behaves --
// this is what actually guarantees visual separation, not iteration count.
function computeConnectedComponents(nodeIds, edges) {
  const adjacency = new Map(nodeIds.map((id) => [id, new Set()]));
  const edgesByNode = new Map(nodeIds.map((id) => [id, []]));
  for (const e of edges) {
    if (!adjacency.has(e.src) || !adjacency.has(e.dst)) continue;
    adjacency.get(e.src).add(e.dst);
    adjacency.get(e.dst).add(e.src);
    edgesByNode.get(e.src).push(e);
  }

  const seen = new Set();
  const components = [];
  for (const start of nodeIds) {
    if (seen.has(start)) continue;
    const compNodes = [];
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const cur = stack.pop();
      compNodes.push(cur);
      for (const nb of adjacency.get(cur)) {
        if (!seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    const compNodeSet = new Set(compNodes);
    const compEdges = edges.filter((e) => compNodeSet.has(e.src) && compNodeSet.has(e.dst));
    components.push({ nodeIds: compNodes, edges: compEdges });
  }
  components.sort((a, b) => b.nodeIds.length - a.nodeIds.length);
  return components;
}

// Simple shelf/row bin-packing: places each component's cell left-to-right,
// wrapping to a new row once a row would get too wide relative to its
// height (keeps the overall canvas roughly square rather than one long
// strip). Cell area is proportional to node count (sqrt for side length),
// with a floor so single-node components stay clickable.
function packComponents(components, { targetAspect = 1.4 } = {}) {
  const totalNodes = components.reduce((sum, c) => sum + c.nodeIds.length, 0) || 1;
  const totalArea = GRAPH_WIDTH * GRAPH_HEIGHT * Math.max(1, totalNodes / 40);
  const areaPerNode = totalArea / totalNodes;

  const cells = components.map((c) => {
    const side = Math.max(70, Math.sqrt(areaPerNode * c.nodeIds.length));
    return { component: c, w: side, h: side };
  });

  const rowTargetWidth = Math.sqrt(totalArea * targetAspect);
  const placed = [];
  let rowX = 0;
  let rowY = 0;
  let rowHeight = 0;
  for (const cell of cells) {
    if (rowX > 0 && rowX + cell.w > rowTargetWidth) {
      rowY += rowHeight;
      rowX = 0;
      rowHeight = 0;
    }
    placed.push({ ...cell, x: rowX, y: rowY });
    rowX += cell.w;
    rowHeight = Math.max(rowHeight, cell.h);
  }
  const totalWidth = Math.max(rowTargetWidth, ...placed.map((p) => p.x + p.w));
  const totalHeight = rowY + rowHeight;
  return { placed, totalWidth, totalHeight };
}

function renderGraph(nodeIds, edges) {
  const components = computeConnectedComponents(nodeIds, edges);

  // The common case (a focus-node neighborhood, or any genuinely connected
  // graph) is exactly one component -- lay it out directly in the fixed
  // canvas, unchanged from before. Multiple components only arise from
  // "Show whole graph" on data with real structural gaps, and get packed
  // into separate regions instead of forced into one shared force layout.
  if (components.length <= 1) {
    const n = nodeIds.length;
    const scale = n <= 20 ? 1 : Math.min(3, 1 + (n - 20) / 200);
    const width = GRAPH_WIDTH * scale;
    const height = GRAPH_HEIGHT * scale;
    const positions = forceLayout(nodeIds, edges, { width, height, iterations: layoutIterationsFor(n) });
    drawGraphElements(nodeIds, edges, positions);
    baseViewBox = { x: 0, y: 0, w: width, h: height };
    resetView();
    return;
  }

  const { placed, totalWidth, totalHeight } = packComponents(components);
  const positions = new Map();
  const PAD = 6; // keeps a component's own layout from touching its cell's edge
  for (const cell of placed) {
    const cw = Math.max(1, cell.w - PAD * 2);
    const ch = Math.max(1, cell.h - PAD * 2);
    const compPositions = forceLayout(cell.component.nodeIds, cell.component.edges, {
      width: cw,
      height: ch,
      iterations: layoutIterationsFor(cell.component.nodeIds.length),
    });
    for (const [id, p] of compPositions) {
      positions.set(id, { x: cell.x + PAD + p.x, y: cell.y + PAD + p.y });
    }
  }

  drawGraphElements(nodeIds, edges, positions);
  baseViewBox = { x: 0, y: 0, w: totalWidth, h: totalHeight };
  resetView();
}

function resetGraphInspector() {
  graphSelectedNodeEl.textContent = "";
  graphInspectorStatusEl.textContent = "Click a node to inspect it.";
  graphInspectorStatusEl.className = "panel-status";
  graphInspectorDetailEl.hidden = true;
}

// Re-centers the rendered graph on `nodeId`'s neighborhood (in-memory
// recompute over the already-fetched allNodeIds/allEdges — no network
// call). This is the "drill into" / navigate action, distinct from
// selectGraphNode's side-inspector fetch, which still hits the real
// /graph/impact and /graph/deps routes for full-precision data.
function focusOnNode(nodeId) {
  if (!allNodeIds.includes(nodeId)) return;
  currentFocusNode = nodeId;
  currentDepth = Number(graphDepthEl.value) || 2;
  const { nodeIds, edges } = computeNeighborhood(nodeId, allEdges, { depth: currentDepth });
  renderGraph(nodeIds, edges);
  graphSearchEmptyEl.hidden = true;
  setStatus(
    graphStatusEl,
    "pass",
    `${allNodeIds.length} node(s) total — showing ${nodeIds.length} within ${currentDepth} hop(s) of "${displayLabel(nodeId)}"`,
  );
}

function handleGraphSearch() {
  const match = findMatchingNode(graphSearchEl.value, allNodeIds);
  if (!match) {
    graphSearchEmptyEl.hidden = false;
    return;
  }
  focusOnNode(match);
}
graphSearchGoEl.addEventListener("click", handleGraphSearch);
graphSearchEl.addEventListener("keydown", (evt) => {
  if (evt.key === "Enter") {
    evt.preventDefault();
    handleGraphSearch();
  }
});
graphDepthEl.addEventListener("change", () => {
  if (currentFocusNode) focusOnNode(currentFocusNode);
});
graphShowAllEl.addEventListener("click", () => {
  if (allNodeIds.length > LARGE_GRAPH_WARNING_THRESHOLD) {
    const proceed = window.confirm(
      `This graph has ${allNodeIds.length} nodes — rendering all of them at once can be slow and hard to read. Continue anyway?`,
    );
    if (!proceed) return;
  }
  currentFocusNode = null;
  renderGraph(allNodeIds, allEdges);
  graphSearchEmptyEl.hidden = true;
  setStatus(graphStatusEl, "pass", `${allNodeIds.length} node(s), ${allEdges.length} edge(s) — showing all`);
});

async function loadGraph() {
  setStatus(graphStatusEl, "loading", "loading…");
  graphBodyEl.hidden = true;
  graphEmptyStateEl.hidden = true;
  try {
    const statsRes = await fetch("/graph/stats");
    const stats = await statsRes.json();
    if (!statsRes.ok) {
      setStatus(graphStatusEl, "fail", `FAIL — ${stats.error || `GET /graph/stats returned ${statsRes.status}`}`);
      return;
    }
    if (!stats.edges) {
      // Explicit empty-state (fresh install / no edges) — never a broken render.
      setStatus(graphStatusEl, "pass", "0 nodes, 0 edges");
      graphEmptyStateEl.hidden = false;
      return;
    }

    const edgesRes = await fetch("/graph/edges");
    const edgesBody = await edgesRes.json();
    if (!edgesRes.ok) {
      setStatus(graphStatusEl, "fail", `FAIL — ${edgesBody.error || `GET /graph/edges returned ${edgesRes.status}`}`);
      return;
    }
    const edges = Array.isArray(edgesBody.edges) ? edgesBody.edges : [];
    const nodeSet = new Set();
    idToLabel = new Map();
    for (const e of edges) {
      nodeSet.add(e.src);
      nodeSet.add(e.dst);
      // src_label/dst_label are only present on graphify-backed responses
      // (see bin/graphify-bridge.mjs) -- absent on the default swarm-memory
      // backend, where displayLabel() falls back to shortLabel(id), same as
      // before this map existed.
      if (e.src_label) idToLabel.set(e.src, e.src_label);
      if (e.dst_label) idToLabel.set(e.dst, e.dst_label);
    }
    const nodeIds = Array.from(nodeSet).sort();

    if (nodeIds.length === 0) {
      setStatus(graphStatusEl, "pass", "0 nodes, 0 edges");
      graphEmptyStateEl.hidden = false;
      return;
    }

    allNodeIds = nodeIds;
    allEdges = edges;
    graphBodyEl.hidden = false;
    resetGraphInspector();
    graphSearchEl.value = "";
    graphSearchEmptyEl.hidden = true;

    // Prefer the backend's suggested_focus_node when present (graphify-
    // backed graphs: computed server-side with real per-node source_file
    // data, excluding test-file-defined nodes -- see bin/graphify-bridge.mjs.
    // A naive highest-degree pick reliably lands on a test-framework
    // assertion helper instead of anything architecturally meaningful, since
    // every test file calls it). Falls back to the client-side heuristic
    // for backends that don't provide it (e.g. the default swarm-memory
    // path, which has no per-node file metadata in its response shape).
    const defaultFocus =
      stats.suggested_focus_node && nodeIds.includes(stats.suggested_focus_node)
        ? stats.suggested_focus_node
        : highestDegreeNode(nodeIds, edges);
    if (nodeIds.length <= DEFAULT_NEIGHBORHOOD_MAX_NODES) {
      // Small enough to just show the whole thing straightaway.
      currentFocusNode = null;
      renderGraph(nodeIds, edges);
      setStatus(graphStatusEl, "pass", `${stats.nodes} node(s), ${stats.edges} edge(s)`);
    } else {
      focusOnNode(defaultFocus);
    }
  } catch (err) {
    setStatus(graphStatusEl, "fail", "FAIL — could not reach GET /graph/stats or GET /graph/edges");
  }
}

// --- Operations panel (s-05): Reindex (POST /index) + Refresh config cache
// (POST /cache/refresh). TWO DISTINCT actions, never conflated:
//   - Reindex shells out against the live Qdrant Cloud store (real write,
//     default CLI pruning) and requires an operator-selected lane + path(s)
//     plus an explicit confirm() before it runs.
//   - Refresh config cache is purely local (clears engine.mjs's in-memory
//     scopeMap cache only) — no confirmation needed because it cannot
//     change or delete anything external.
// This file never fetch()es any delete/wipe-style endpoint — none exists.
const reindexForm = document.getElementById("reindex-form");
const reindexLaneSelect = document.getElementById("reindex-lane");
const reindexPathsEl = document.getElementById("reindex-paths");
const reindexStatusEl = document.getElementById("reindex-status");
const reindexResultEl = document.getElementById("reindex-result");
const refreshCacheBtn = document.getElementById("refresh-cache-btn");
const refreshCacheStatusEl = document.getElementById("refresh-cache-status");

// Populates the lane <select> from GET /scopes — one option per configured
// lane, value = that lane's underlying collection (what POST /index needs).
async function loadReindexLanes() {
  try {
    const res = await fetch("/scopes");
    if (!res.ok) return;
    const body = await res.json();
    const scopeMap = body.scopes || {};
    const names = Object.keys(scopeMap).sort();
    const current = reindexLaneSelect.value;
    reindexLaneSelect.textContent = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.disabled = true;
    placeholder.textContent = "select a lane…";
    reindexLaneSelect.appendChild(placeholder);
    for (const name of names) {
      const opt = document.createElement("option");
      opt.value = scopeMap[name];
      opt.textContent = `${name} (${scopeMap[name]})`;
      reindexLaneSelect.appendChild(opt);
    }
    if (names.some((n) => scopeMap[n] === current)) reindexLaneSelect.value = current;
    else reindexLaneSelect.value = "";
  } catch {
    // Non-fatal — the operator can still retry via the manual refresh button.
  }
}

reindexForm.addEventListener("submit", async (evt) => {
  evt.preventDefault();
  const collection = reindexLaneSelect.value;
  const paths = String(reindexPathsEl.value || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  reindexResultEl.hidden = true;
  reindexResultEl.textContent = "";

  if (!collection) {
    setStatus(reindexStatusEl, "fail", "FAIL — select a lane first");
    return;
  }
  if (paths.length === 0) {
    setStatus(reindexStatusEl, "fail", "FAIL — enter at least one path");
    return;
  }

  const confirmed = window.confirm(
    `Reindex ${paths.length} path(s) into '${collection}'?\n\n` +
      "This shells out to swarm-memory against the LIVE Qdrant Cloud store and " +
      "can take real time. It writes/refreshes data — it never deletes a collection.\n\n" +
      paths.join("\n")
  );
  if (!confirmed) {
    setStatus(reindexStatusEl, "", "cancelled");
    return;
  }

  const submitBtn = document.getElementById("reindex-submit");
  setStatus(reindexStatusEl, "loading", "reindexing… (this can take a while against the live store)");
  submitBtn.disabled = true;
  try {
    const res = await fetch("/index", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collection, paths }),
    });
    const body = await res.json();
    if (!res.ok) {
      setStatus(reindexStatusEl, "fail", `FAIL — ${body.error || `HTTP ${res.status}`}`);
      return;
    }
    setStatus(
      reindexStatusEl,
      "pass",
      `done — ${body.files_indexed ?? "?"} file(s) indexed, ${body.chunks_upserted ?? "?"} chunk(s) upserted, ` +
        `${body.embed_failures ?? 0} embed failure(s), ${body.total_points ?? "?"} total point(s) in ${body.collection}`
    );
    if (body.engine_output) {
      reindexResultEl.textContent = body.engine_output;
      reindexResultEl.hidden = false;
    }
  } catch (err) {
    setStatus(reindexStatusEl, "fail", `FAIL — ${err && err.message ? err.message : err}`);
  } finally {
    submitBtn.disabled = false;
  }
});

refreshCacheBtn.addEventListener("click", async () => {
  setStatus(refreshCacheStatusEl, "loading", "refreshing local config cache…");
  refreshCacheBtn.disabled = true;
  try {
    const res = await fetch("/cache/refresh", { method: "POST" });
    const body = await res.json();
    if (!res.ok) {
      setStatus(refreshCacheStatusEl, "fail", `FAIL — ${body.error || `HTTP ${res.status}`}`);
      return;
    }
    setStatus(refreshCacheStatusEl, "pass", "config cache cleared — re-reading fresh on next load");
    // Re-load the panels that read through the now-cleared cache so the
    // effect is visible immediately, not just claimed.
    await Promise.all([loadSettings(), loadLanes(), loadReindexLanes(), loadSearchScopes()]);
  } catch (err) {
    setStatus(refreshCacheStatusEl, "fail", `FAIL — ${err && err.message ? err.message : err}`);
  } finally {
    refreshCacheBtn.disabled = false;
  }
});

// --- Personas panel (pw-03-personas-panel-view): renders GET /persona as a
// table (tier, scopeId, displayName), following the exact Lanes-panel
// table/tbody convention (laneCell/loadLanes above) and setStatus() for
// pass/fail/loading states, same as every other panel.
//
// Cross-server fetch: the persona routes live on lib/mnemosyne/server.ts, a
// DIFFERENT server/port (3141 default) than this UI's own server (8477,
// src/server.mjs -- see that file's doc comment and server.ts's matching
// one). A relative fetch("/persona") would hit THIS server, not the persona
// service, and 404 -- every persona fetch below therefore uses an absolute
// URL built from the page's own hostname (whichever of 127.0.0.1/localhost
// this UI is actually being served from) plus the persona service's port,
// matching one of the two origins server.ts's CORS allow-list (UI_ORIGINS)
// actually grants: http://127.0.0.1:8477 / http://localhost:8477.
const MNEMOSYNE_PERSONA_PORT = 3141;

function personaServiceOrigin() {
  return `${window.location.protocol}//${window.location.hostname}:${MNEMOSYNE_PERSONA_PORT}`;
}

function personaCell(text) {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}

// puf-03-post-approval-provenance-note: a persistent one-line note
// ("Originally proposed by <proposedBy>, approved <date>.") rendered
// directly under a live persona row's display name whenever that row's
// underlying live record carries a real `origin` (persona.ts's
// schema-validated {proposedBy, proposedAt, approvedAt} -- populated ONLY
// by server.ts's approve route, cleared by any direct re-save; see both
// routes' own comments). Never fabricated: this reads only what's actually
// on the record, same "never invent provenance" convention
// isAgentProposedDraft()/draftProvenanceLabel() already follow for drafts.
// `approvedAt` (an ISO timestamp) is shown as a plain locale date, not the
// full timestamp -- readable at a glance, matching the note's own "<date>"
// phrasing. Returns null (renders nothing) when `origin` is absent/partial
// -- this is the one place that decides whether the note appears at all.
function personaOriginNote(origin) {
  if (!origin || typeof origin.proposedBy !== "string" || typeof origin.approvedAt !== "string") return null;
  const parsed = new Date(origin.approvedAt);
  const dateText = Number.isNaN(parsed.getTime()) ? origin.approvedAt : parsed.toLocaleDateString();
  const p = document.createElement("div");
  p.className = "persona-origin-note";
  p.textContent = `Originally proposed by ${origin.proposedBy}, approved ${dateText}.`;
  return p;
}

// ============================================================================
// pw-04-layer-stack-visibility: layer-stack visibility section.
// Own DOM refs, own small loader function. pu-11-layer-stack-integration-
// redesign re-homed the markup these refs target from a standalone
// top-level <section> into pu-10's new Personas panel shell (nested inside
// #personas, ui/index.html) -- the element ids below, and everything in
// loadPersonaLayerStack() itself, are UNCHANGED by that move. It fetches
// the ALREADY-SHIPPED GET /layers route on lib/mnemosyne/server.ts -- no
// new backend route. That service runs on a different origin/port (3141,
// MNEMOSYNE_PORT) than this UI's own server (src/server.mjs, port 8477),
// so this is a genuine cross-origin fetch -- same pattern
// pw-02-get-persona-routes-cors's CORS fix already covers for /persona/*,
// extended by this story to /layers (see server.ts).
//
// The Level 0 pointer rendered alongside it is a STATIC path display only
// (no fetch, no form) -- intentionally view-only, matching Epic 1's own
// recommendation (design-discussion.md §3d/§6 OQ4), carried forward
// unchanged through the pu-11 re-home. There is no edit affordance for it
// anywhere in this file.
// ============================================================================
const MNEMOSYNE_CLIENT_API_LOOPBACK = "http://127.0.0.1:3141";
const MNEMOSYNE_CLIENT_API_LOCALHOST = "http://localhost:3141";

// Mirrors the hostname the page itself was loaded with (server.ts's
// UI_ORIGINS allow-lists both 127.0.0.1:8477 and localhost:8477) so the
// cross-origin request's Origin header matches one of the two origins
// server.ts's applyPersonaCors() actually allow-lists.
function mnemosyneClientApiBase() {
  return location.hostname === "localhost" ? MNEMOSYNE_CLIENT_API_LOCALHOST : MNEMOSYNE_CLIENT_API_LOOPBACK;
}

const personaLayerStackStatusEl = document.getElementById("persona-layer-stack-status");
const personaLayerStackTableEl = document.getElementById("persona-layer-stack-table");
const personaLayerStackTbodyEl = document.getElementById("persona-layer-stack-tbody");
const personaLayerStackEmptyEl = document.getElementById("persona-layer-stack-empty");

function personaLayerStackCell(text) {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}

// ml-05-memory-levels-ui (epic mnemosyne-memory-levels): element refs for
// the new, structurally separate Memory Levels (0-4) section -- never
// shared with persona-layer-stack's elements above.
const memoryLevelsStatusEl = document.getElementById("memory-levels-status");
const memoryLevelsTableEl = document.getElementById("memory-levels-table");
const memoryLevelsTbodyEl = document.getElementById("memory-levels-tbody");
const memoryLevelsEmptyEl = document.getElementById("memory-levels-empty");

function memoryLevelsCell(text) {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}

// ui-01-accent-token-reconciliation: the Status column's real color-coded
// cell -- a level the server reports as NOT configured (levels.ts's own
// live existsSync/adapter-presence checks; see server.ts's "GET
// /memory-levels" route) has no real store backing it right now, which is
// a genuine health failure for that memory level, not a pending-review
// state. It renders with .status-pill.degraded (red, var(--fail)) --
// a distinct class from .status-pill.needs-review (amber), which this
// table never uses at all; "needs review" belongs to a persona draft
// awaiting human review elsewhere in this app, a different concern
// entirely. A configured level renders .status-pill.live (green) instead.
function memoryLevelStatusCell(level) {
  const td = document.createElement("td");
  const configured = !!(level && level.configured);
  const pill = document.createElement("span");
  pill.className = `status-pill ${configured ? "live" : "degraded"}`;
  pill.textContent = configured ? "Active" : "Degraded";
  td.appendChild(pill);
  if (level && typeof level.activeInCascade === "boolean") {
    const detail = document.createElement("span");
    detail.className = "memory-level-cascade-detail";
    detail.textContent = level.activeInCascade ? " active in cascade" : " inactive in cascade";
    td.appendChild(detail);
  }
  return td;
}

// Renders a persona's parentRefs as pointer-only text ("tier: scopeId",
// comma-separated), built entirely from fields already present on the
// persona record itself -- this function never fetches anything. This is
// the UI-layer half of the "query up, never copy down" guarantee
// getPersonaContent's own buildParentContextSections (persona.ts) enforces
// server-side: a parent's real sections content must NEVER be fetched or
// inlined here, only named (research-brief.md §6). Kept as its own function
// (used by personaParentCell below, and directly wherever plain text is
// all that's needed) so the pointer-only guarantee stays in exactly one
// place, unchanged from pw-03.
function parentRefsText(parentRefs) {
  if (!Array.isArray(parentRefs) || parentRefs.length === 0) return "—";
  return parentRefs.map((ref) => `${ref.tier}: ${ref.scopeId}`).join(", ");
}

// --- pu-10-personas-panel-redesign-shell: new grouped/filterable shell ----
// Rebuilds ONLY how loadPersonas()'s result is rendered/organized, per
// selection.md's chosen synthesized option-2.md ("Trust-Gated Unified
// Queue"). loadPersonas()'s own fetch logic (below) is unchanged from pw-03
// -- still GET /persona + one GET /persona/:tier/:scopeId per entry, same
// personaServiceOrigin() cross-origin pattern, no new route, no draft fetch
// (horizontal-plan.md H7 component 1: "still reading the same GET
// /persona/... routes underneath -- pure view rebuild").
//
// pu-12-draft-review-approve-ui extends this shell (does not rebuild it):
// loadDrafts() below is a NEW function, following loadPersonas()'s own
// "fetch, setStatus, render" shape, that fetches pu-03's GET /persona/draft
// (+ one GET /persona/draft/:tier/:scopeId per entry, for the sourceSummary/
// proposedBy/proposedAt metadata the list route doesn't carry -- exactly
// mirroring loadPersonas()'s own "list route doesn't carry displayName, so
// fetch each entry's own record" shape). mergedPersonaRows() (below,
// immediately before renderPersonas()) is the ONE place that combines
// loadedPersonas (live) with loadedDrafts (draft) by identity into the rows
// renderPersonas() actually renders -- renderPersonas() itself still never
// fetches anything, matching this ticket's own "loadDrafts() following
// loadPersonas()'s existing conventions" instruction.
const personasTableEl = document.getElementById("personas-table");
const personasEmptyEl = document.getElementById("personas-empty");
const personasStatusFilterEl = document.getElementById("personas-status-filter");
const personasLiveRegionEl = document.getElementById("personas-live-region");

// puf-04-repo-scoped-personas-reachable: the repo-path input that makes
// groupPersonaRows()'s already-coded Repo-grouping branch (pu-10/pu-11)
// reachable for real. Unlike personasStatusFilterEl/the group-by radios
// above (client-side re-bucket only, no re-fetch), changing this one has to
// trigger a real re-fetch -- a repo's code-architect rows only exist once
// loadPersonas()/loadDrafts() ask the persona service for them via ?repo=,
// see currentPersonaRepoFilter()/the change listener below and both
// functions themselves further down this file.
const personasRepoFilterEl = document.getElementById("personas-repo-filter");

// Canonical tier cascade order (mirrors lib/mnemosyne/layer1/tiers.ts's
// TIERS) -- used for stable Tier-group-by ordering and to label Repo-group-
// by's 3 "global" sub-groups.
const PERSONA_TIER_ORDER = ["top-orchestrator", "company-director", "project-orchestrator", "code-architect"];

// Already-fetched persona rows, kept module-level so the group-by/status-
// filter controls below can re-render client-side on every change -- no
// re-fetch (selection.md §1: "toggling re-buckets already-fetched rows
// client-side"; every other panel's manual-refresh-only convention).
let loadedPersonas = [];

// pu-12-draft-review-approve-ui: already-fetched ACTIVE drafts (full
// records, including sourceSummary/proposedBy/proposedAt when present),
// kept module-level for the exact same client-side-re-render-on-toggle
// reason as loadedPersonas above. mergedPersonaRows() (below) is the only
// place this is combined with loadedPersonas.
let loadedDrafts = [];

// Session-scoped "has this draft's raw proposal been read at least once"
// gate (selection.md/synthesized option-2.md §4.3: "the accordion always
// opens in a non-editable, read-only mode first... a single control...
// 'I've read this -- enable editing'... Once clicked within a session, this
// specific draft's identity is marked read for the remainder of the
// session (client-side only)... a fresh page load resets it"). A plain JS
// Set is enough for that exact contract -- it lives only as long as this
// page does, never persisted, never sent anywhere.
const readDraftIdentities = new Set();

function personaRowKey(tier, scopeId) {
  return `${tier} ${scopeId}`;
}

// Status is always real cell text, never a bare glyph (accessibility.md,
// onboarding-clarity.md). This ticket's data (GET /persona, unchanged) only
// ever produces "live" rows -- the needs-review/needs-review-update/history
// values exist here so the grouping/filtering/labeling machinery is
// already correct once pu-12 merges in GET /persona/draft's rows
// alongside these (horizontal-plan.md H7 component 3), not something this
// ticket fabricates data for today.
function personaStatusLabel(status) {
  switch (status) {
    case "needs-review":
      return "needs review";
    case "needs-review-update":
      return "needs review — updates existing persona";
    case "history":
      return "history";
    default:
      return "live";
  }
}

function personaMatchesStatusFilter(row, filterValue) {
  if (filterValue === "all") return true;
  if (filterValue === "needs-review") {
    return row.status === "needs-review" || row.status === "needs-review-update";
  }
  return row.status === filterValue;
}

function currentPersonaGroupBy() {
  const checked = document.querySelector('input[name="personas-group-by"]:checked');
  return checked ? checked.value : "tier";
}

// puf-04-repo-scoped-personas-reachable: trimmed value of the new repo
// filter, or "" when blank -- the one place loadPersonas()/loadDrafts()
// below read it, so "" (the default, matching every page load before this
// ticket) is the single source of truth for "behave exactly as before".
function currentPersonaRepoFilter() {
  return personasRepoFilterEl ? personasRepoFilterEl.value.trim() : "";
}

// Buckets already-loaded (and already status-filtered) rows for the
// current group-by mode. Pure client-side recompute -- no fetch anywhere
// in this function. Repo-grouping keeps the 3 global tiers as 3 separate,
// explicitly labeled sub-groups ("<tier> — global — not repo-scoped")
// rather than collapsing them into one undifferentiated "global" bucket --
// the concrete fix for hierarchy-legibility.md's named gap in original
// Option 3 (selection.md "the deciding factor"). loadPersonas() only ever
// fetches the 3 global tiers (GET /persona, no ?repo=), so no code-architect
// row can appear via this ticket's data; the per-repo branch below is
// written for correctness/forward-compatibility but has nothing to
// populate yet under this ticket's own reuse-loadPersonas()-unchanged
// scope boundary.
function groupPersonaRows(rows, groupBy) {
  const groups = new Map(); // label -> rows[]
  const order = [];
  const push = (label, row) => {
    if (!groups.has(label)) {
      groups.set(label, []);
      order.push(label);
    }
    groups.get(label).push(row);
  };

  if (groupBy === "status") {
    for (const status of ["live", "needs-review", "needs-review-update", "history"]) {
      const label = personaStatusLabel(status);
      for (const row of rows) if (row.status === status) push(label, row);
    }
  } else if (groupBy === "repo") {
    for (const tier of PERSONA_TIER_ORDER) {
      if (tier === "code-architect") continue; // no repo-scoped rows loaded by this ticket
      const label = `${tier} — global — not repo-scoped`;
      for (const row of rows) if (row.tier === tier) push(label, row);
    }
    for (const row of rows) if (row.tier === "code-architect") push(row.repo || "(unknown repo)", row);
  } else {
    for (const tier of PERSONA_TIER_ORDER) {
      for (const row of rows) if (row.tier === tier) push(tier, row);
    }
  }
  return order.map((label) => ({ label, rows: groups.get(label) }));
}

// personaCell(text) is defined once, above (personaServiceOrigin()'s
// section) -- reused here unchanged, not redefined.

// Builds the Parent(s) <td> for one row: plain pointer-only text (via
// parentRefsText's exact phrasing) for a parentRef with no matching row in
// the currently loaded set, or a real <button> (never an href="#" anchor --
// there is nothing to navigate to, only in-page focus to move) for one that
// does. Still never fetches anything -- clicking only moves focus among
// rows already rendered from loadPersonas()'s own result.
function personaParentCell(parentRefs, loadedByKey) {
  const td = document.createElement("td");
  if (!Array.isArray(parentRefs) || parentRefs.length === 0) {
    td.textContent = "—";
    return td;
  }
  parentRefs.forEach((ref, i) => {
    if (i > 0) td.appendChild(document.createTextNode(", "));
    const label = `${ref.tier}: ${ref.scopeId}`;
    if (!loadedByKey.has(personaRowKey(ref.tier, ref.scopeId))) {
      td.appendChild(document.createTextNode(label));
      return;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "persona-parent-link";
    btn.textContent = label;
    btn.addEventListener("click", () => jumpToPersonaRow(ref.tier, ref.scopeId));
    td.appendChild(btn);
  });
  return td;
}

// Moves real DOM focus to {tier, scopeId}'s row (accessibility.md: "nothing
// said about moving actual focus... or otherwise giving a screen reader
// user any signal that the jump happened" -- flagged against a prior
// design's "scroll to and flash"). If the identity is in the loaded set but
// currently hidden by the active status filter, resets the filter to "all"
// (never the group-by mode, to avoid disorienting the operator further)
// and announces the reset via the aria-live region instead of silently
// pointing at nothing (hierarchy-legibility.md's gap in original Option 3).
function jumpToPersonaRow(tier, scopeId) {
  const findRow = () =>
    Array.from(personasTbodyEl.querySelectorAll("tr[data-tier]")).find(
      (tr) => tr.dataset.tier === tier && tr.dataset.scopeId === scopeId
    );

  let target = findRow();
  if (!target) {
    personasStatusFilterEl.value = "all";
    renderPersonas();
    target = findRow();
    if (personasLiveRegionEl) {
      personasLiveRegionEl.textContent = `Filter cleared to show parent ${tier} / ${scopeId}.`;
    }
  }
  if (target) {
    target.scrollIntoView({ block: "center" });
    target.focus();
  }
}

// Single funnel point for every <tr> renderPersonas() appends into the
// personas tbody -- so that append call is made from exactly one place in
// this file (group-header rows and data rows both route through here),
// matching test/persona-write-form.mjs's existing "no second persona-
// rendering path" guard, even though this shell now appends two kinds of
// <tr> per group.
function appendPersonaTbodyRow(tr) {
  personasTbodyEl.appendChild(tr);
}

function resetPersonaView() {
  loadedPersonas = [];
  personasTbodyEl.textContent = "";
  personasTableEl.hidden = true;
  personasEmptyEl.hidden = true;
}

// pu-12-draft-review-approve-ui: same sanitization rule
// lib/mnemosyne/layer1/persona-draft-store.ts's sanitizeForPath() /
// persona.ts's resolveRememberScope() already use for turning an arbitrary
// scopeId into a safe path/tag segment -- reused byte-for-byte here to turn
// a {tier, scopeId} identity into a safe HTML id for the draft-detail row's
// id/aria-controls pairing, rather than inventing a third sanitization rule.
function sanitizeForDomId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "-");
}

function draftDetailRowId(tier, scopeId) {
  return `persona-draft-detail-${sanitizeForDomId(tier)}-${sanitizeForDomId(scopeId)}`;
}

// The ONLY signal this file uses to decide "agent-proposed" vs "human-typed"
// for a draft: a real, non-empty sourceSummary. Mirrors server.ts's own
// approve-route logic (`typeof sourceSummary === 'string' && sourceSummary.trim() !== ''`
// gates whether remember() fires) -- same signal, reused, never a second
// definition of what counts as "agent-proposed" (design_decisions:
// "sourceSummary is rendered and labeled ONLY when present -- never
// fabricated or implied for a human-typed draft").
function isAgentProposedDraft(draft) {
  return typeof draft.sourceSummary === "string" && draft.sourceSummary.trim() !== "";
}

// pf-06 (design-discussion.md OQ3): once pf-05 shipped, a human-typed draft
// can carry a real sourceSummary too (from attached files), which
// isAgentProposedDraft()'s binary "real sourceSummary => agent-proposed"
// signal alone would mislabel -- a human who attached files is not an
// agent. This sibling function makes the full 3-way label decision
// explicit, reusing isAgentProposedDraft()'s existing "real, non-empty
// sourceSummary" signal for whether ANY source material is present at all,
// then layering proposedBy on top to decide WHO attached it.
// isAgentProposedDraft() itself stays unchanged -- so its own callers (the
// list-row snippet gate below, and any other consumer of that raw boolean)
// are untouched by this addition.
function draftProvenanceLabel(draft) {
  if (!isAgentProposedDraft(draft)) return "manual";
  return draft.proposedBy === "agent" ? "agent-proposed" : "human-attached";
}

// One-line snippet rendered directly under a collapsed agent-proposed row
// (selection.md/synthesized option-2.md §1: "a one-line sourceSummary
// snippet renders directly under any agent-proposed row, truncated to
// roughly one sentence... visible without expanding anything").
function sourceSummarySnippet(text) {
  const trimmed = String(text || "").trim();
  const firstSentence = trimmed.split(/(?<=[.!?])\s/)[0] || trimmed;
  return firstSentence.length > 140 ? `${firstSentence.slice(0, 137)}…` : firstSentence;
}

// The one place loadedPersonas (live, pw-03/loadPersonas()) and
// loadedDrafts (pu-03/loadDrafts()) are combined by identity into the rows
// renderPersonas() actually renders -- a pure function, never fetches.
// Three possible outcomes per identity, exactly selection.md/synthesized
// option-2.md §3's table: an identity with a live record and NO matching
// draft stays "live"; an identity with BOTH a live record and an active
// draft becomes "needs-review-update" (one row, not two -- the live record
// is superseded in the list by its own pending draft, matching the design's
// "current (live) vs proposed (draft)" comparison being reachable from that
// single row's detail panel); an identity with ONLY an active draft (no
// live record yet) becomes "needs-review".
function mergedPersonaRows() {
  const draftByKey = new Map(loadedDrafts.map((d) => [personaRowKey(d.tier, d.scopeId), d]));
  const rows = [];
  const seenKeys = new Set();

  for (const persona of loadedPersonas) {
    const key = personaRowKey(persona.tier, persona.scopeId);
    seenKeys.add(key);
    const draft = draftByKey.get(key);
    if (draft) {
      rows.push({ ...persona, status: "needs-review-update", draft, live: persona });
    } else {
      rows.push(persona);
    }
  }

  for (const draft of loadedDrafts) {
    const key = personaRowKey(draft.tier, draft.scopeId);
    if (seenKeys.has(key)) continue;
    rows.push({
      tier: draft.tier,
      scopeId: draft.scopeId,
      displayName: draft.displayName == null ? null : draft.displayName,
      parentRefs: Array.isArray(draft.parentRefs) ? draft.parentRefs : [],
      repo: draft.repo,
      status: "needs-review",
      draft,
      live: null,
    });
  }

  return rows;
}

// Re-renders #personas-table's grouped rows from already-fetched state --
// never fetches. Called once by loadPersonas() after a real load, again by
// loadDrafts() after a draft load, and again by the group-by/status-filter
// controls' own change listeners below on every client-side re-view.
// Building block for every row is mergedPersonaRows() above, not
// loadedPersonas directly, so live and draft identities render in ONE
// unified list (pu-12's own acceptance criterion), never two.
function renderPersonas() {
  personasTbodyEl.textContent = "";

  // puf-02-batch-approve-strip: always kept in sync with THIS render, even
  // on the two early-return (empty/filtered-empty) branches below -- the
  // reviewed-queue strip is independent of the status filter/group-by mode
  // (selection.md/synthesized option-2.md §1: it sits above the grouped
  // list, not inside any one group).
  renderBatchApproveStrip();

  const merged = mergedPersonaRows();

  if (merged.length === 0) {
    personasTableEl.hidden = true;
    personasEmptyEl.hidden = false;
    // pu-12-draft-review-approve-ui: the literal empty-state copy
    // selection.md/synthesized option-2.md §2 singles out as "concrete,
    // verifiable onboarding text" -- reused verbatim, not re-invented. Still
    // contains the exact "No personas yet." substring this file's own
    // pu-10-era test (test/personas-panel-shell.mjs) already asserts.
    personasEmptyEl.textContent =
      "No personas yet. No drafts pending. Ask an agent to propose one " +
      "(`mnemosyne persona draft propose ...` or the " +
      "`mnemosyne-persona-interview` skill), or start one by hand below.";
    return;
  }

  const filterValue = personasStatusFilterEl.value;
  const groupBy = currentPersonaGroupBy();
  const loadedByKey = new Map(merged.map((p) => [personaRowKey(p.tier, p.scopeId), p]));
  const visible = merged.filter((p) => personaMatchesStatusFilter(p, filterValue));

  if (visible.length === 0) {
    personasTableEl.hidden = true;
    personasEmptyEl.hidden = false;
    personasEmptyEl.textContent = "No personas match the current filter.";
    return;
  }
  personasTableEl.hidden = false;
  personasEmptyEl.hidden = true;

  for (const group of groupPersonaRows(visible, groupBy)) {
    const headerRow = document.createElement("tr");
    headerRow.className = "persona-group-header";
    const th = document.createElement("th");
    th.colSpan = 6;
    th.scope = "colgroup";
    th.textContent = `${group.label} (${group.rows.length})`;
    headerRow.appendChild(th);
    appendPersonaTbodyRow(headerRow);

    for (const row of group.rows) {
      const tr = document.createElement("tr");
      tr.dataset.tier = row.tier;
      tr.dataset.scopeId = row.scopeId;
      // Programmatic focus target only (parent-ref jump above) -- not
      // meant to sit in the regular Tab order, so tabindex stays -1.
      tr.tabIndex = -1;

      const displayNameTd = personaCell(row.displayName == null || row.displayName === "" ? "—" : row.displayName);
      // pu-12: one-line sourceSummary snippet under any row with a real
      // sourceSummary, visible without expanding anything (selection.md/
      // synthesized option-2.md §1) -- NEVER rendered for a draft with no
      // sourceSummary, so no fabricated provenance signal appears where
      // none exists. pf-06: the snippet itself still renders for EITHER an
      // agent-proposed OR a human-attached draft (real material is real
      // material either way) -- draftProvenanceLabel() only decides the CSS
      // hook used to style it, never whether it renders.
      if (row.draft && isAgentProposedDraft(row.draft)) {
        const snippet = document.createElement("div");
        const snippetProvenance = draftProvenanceLabel(row.draft);
        snippet.className = snippetProvenance === "agent-proposed"
          ? "persona-source-snippet"
          : "persona-source-snippet persona-source-snippet--human-attached";
        snippet.textContent = sourceSummarySnippet(row.draft.sourceSummary);
        displayNameTd.appendChild(snippet);
      }

      // puf-03-post-approval-provenance-note: the live record's own
      // `origin` -- `row.origin` for a plain live row, `row.live.origin`
      // for a needs-review-update row (a live record with a pending draft
      // on top is still the SAME approved persona, still carries its own
      // real provenance). A needs-review-only row (no live record yet) has
      // neither, so personaOriginNote() naturally renders nothing for it.
      const originNote = personaOriginNote(row.origin || (row.live && row.live.origin));
      if (originNote) displayNameTd.appendChild(originNote);

      tr.appendChild(personaCell(row.tier));
      tr.appendChild(personaCell(row.scopeId));
      tr.appendChild(displayNameTd);
      tr.appendChild(personaParentCell(row.parentRefs, loadedByKey));
      tr.appendChild(personaCell(personaStatusLabel(row.status)));

      const { actionsCell, detailRow } = buildPersonaActionsAndDetail(row);
      tr.appendChild(actionsCell);
      appendPersonaTbodyRow(tr);
      if (detailRow) appendPersonaTbodyRow(detailRow);
    }
  }
}

document.querySelectorAll('input[name="personas-group-by"]').forEach((el) => {
  el.addEventListener("change", renderPersonas);
});
personasStatusFilterEl.addEventListener("change", renderPersonas);

// puf-04-repo-scoped-personas-reachable: unlike the two listeners just
// above, a repo change has to re-FETCH (loadPersonas()/loadDrafts() below
// are the only place ?repo= is ever sent) -- both are called (like the
// initial page load below does) so the same "code-architect rows appear
// alongside live AND drafted global rows in one list" contract holds no
// matter which changed first. Fires on the input's native "change" event
// (commits on blur, matching this ticket's own task description) --
// nothing calls this at module-load time, so an untouched, blank filter
// never fires it and never re-fetches beyond the existing initial load.
if (personasRepoFilterEl) {
  personasRepoFilterEl.addEventListener("change", () => {
    loadPersonas();
    loadDrafts();
  });
}

// ==================== pu-12-draft-review-approve-ui: draft detail/edit/
// approve/discard, built per pu-01's chosen synthesized option's documented
// interaction flow (selection.md -> synthesized/option-2.md §3/§4). ========

// A plain stacked-text (never a diff library) block for one side of the
// "Current (live) vs. Proposed (draft)" comparison (§4.3.3) -- avoids the
// screen-reader trap a color/strikethrough diff would create.
function personaCompareBlock(label, record) {
  const wrap = document.createElement("div");
  const labelEl = document.createElement("p");
  labelEl.className = "persona-draft-compare-label";
  labelEl.textContent = label;
  wrap.appendChild(labelEl);

  const dl = document.createElement("dl");
  dl.className = "fields";
  const addField = (dt, dd) => {
    const dtEl = document.createElement("dt");
    dtEl.textContent = dt;
    const ddEl = document.createElement("dd");
    ddEl.textContent = dd;
    dl.appendChild(dtEl);
    dl.appendChild(ddEl);
  };
  addField("Display name", record.displayName || "—");
  addField("Scope", record.scope || "—");
  const sections = Array.isArray(record.sections) ? record.sections : [];
  sections.forEach((s, i) => {
    addField(`Section ${i + 1}: ${(s && s.heading) || "(untitled)"}`, (s && s.body) || "—");
  });
  if (record.repo) addField("Repo", record.repo);
  wrap.appendChild(dl);
  return wrap;
}

// Builds ONE draft's expandable detail row: `{ tr, focusTarget }`. `tr` is a
// full-width (colspan 6), initially-`hidden` <tr> appended directly after
// its data row (the real `hidden`-attribute toggle idiom
// #graph-inspector-detail already uses, per §4.3). `focusTarget` is the
// first heading inside -- moved to programmatically on expand (§4.3:
// "focus moves programmatically to the accordion's first heading... not
// left floating").
//
// The accordion always opens in a non-editable, read-only mode first, even
// on a later visit -- readDraftIdentities (module-level Set, above) is the
// ONLY thing that ever reveals the Edit/Approve/Discard controls without
// requiring "I've read this -- enable editing" to be clicked again *within
// this session* (§4.3's own stated contract). The gate is enforced
// structurally, by not rendering those controls into the DOM at all until
// passed -- never a `disabled` attribute (accessibility.md's named
// anti-pattern; selection.md "Design deviation from Option 2, deliberately").
function buildPersonaDraftDetailRow(row) {
  const { tier, scopeId, draft, live } = row;
  const identityKey = personaRowKey(tier, scopeId);
  // pf-06: the 3-way provenance decision (agent-proposed / human-attached /
  // manual). agentProposed below is derived FROM this, not directly from
  // isAgentProposedDraft()'s raw sourceSummary-only signal -- so a human who
  // attached files via pf-05 is never mislabeled "agent-proposed" just
  // because a real sourceSummary happens to exist.
  const provenance = draftProvenanceLabel(draft);
  const agentProposed = provenance === "agent-proposed";

  const tr = document.createElement("tr");
  tr.id = draftDetailRowId(tier, scopeId);
  tr.className = "persona-draft-detail-row";
  tr.hidden = true;

  const td = document.createElement("td");
  td.colSpan = 6;
  const panel = document.createElement("div");
  panel.className = "persona-draft-panel";

  let focusTarget = null;

  // Source summary -- ONLY rendered, and ONLY labeled agent-proposed, when
  // draft.sourceSummary is a real, non-empty string AND proposedBy ===
  // 'agent' (design_decisions: "never fabricated or implied for a
  // human-typed draft"; pf-06: never conflated with a human-attached one
  // either).
  if (agentProposed) {
    const h4 = document.createElement("h4");
    h4.tabIndex = -1;
    h4.textContent = "Why the agent proposed this";
    const badge = document.createElement("span");
    badge.className = "persona-draft-agent-label";
    badge.textContent = "agent-proposed";
    h4.appendChild(badge);
    panel.appendChild(h4);
    focusTarget = h4;

    const summaryP = document.createElement("p");
    summaryP.className = "persona-draft-source-summary";
    summaryP.textContent = draft.sourceSummary;
    panel.appendChild(summaryP);
  } else if (provenance === "human-attached") {
    // pf-06 (design-discussion.md OQ3): real source material attached by a
    // human via pf-05 -- honestly surfaced (never silently dropped down to
    // the no-sourceSummary "Manually created" label), but never labeled
    // "agent-proposed" either.
    const h4 = document.createElement("h4");
    h4.tabIndex = -1;
    h4.textContent = "Attached source material";
    const badge = document.createElement("span");
    badge.className = "persona-draft-source-label";
    badge.textContent = "human-attached";
    h4.appendChild(badge);
    panel.appendChild(h4);
    focusTarget = h4;

    const summaryP = document.createElement("p");
    summaryP.className = "persona-draft-source-summary";
    summaryP.textContent = draft.sourceSummary;
    panel.appendChild(summaryP);
  }

  // Provenance line -- always visible text, never inferred/tooltip-only
  // (§4.3.2). "Manually created" for a draft with no sourceSummary at all;
  // "Includes attached source material" (pf-06) for a real sourceSummary
  // attached by a human; "Proposed by agent" only when proposedBy ===
  // 'agent'.
  const provenanceP = document.createElement("p");
  provenanceP.className = "persona-draft-provenance";
  const proposedAt = typeof draft.proposedAt === "string" && draft.proposedAt ? draft.proposedAt : "unknown time";
  provenanceP.textContent = agentProposed
    ? `Proposed by agent · ${proposedAt}`
    : provenance === "human-attached"
      ? `Includes attached source material · ${proposedAt}`
      : `Manually created · ${proposedAt}`;
  panel.appendChild(provenanceP);
  if (!focusTarget) {
    provenanceP.tabIndex = -1;
    focusTarget = provenanceP;
  }

  // Current (live) vs. Proposed (draft) -- only when a live record already
  // exists at this identity (§4.3.3); "New persona -- nothing live yet"
  // otherwise.
  if (live) {
    const compareHeading = document.createElement("h4");
    compareHeading.textContent = "Current (live) vs. Proposed (draft)";
    panel.appendChild(compareHeading);
    panel.appendChild(personaCompareBlock("Current (live)", live));
    panel.appendChild(personaCompareBlock("Proposed (draft)", draft));
  } else {
    const newHeading = document.createElement("h4");
    newHeading.textContent = "New persona — nothing live yet";
    panel.appendChild(newHeading);
    panel.appendChild(personaCompareBlock("Proposed (draft)", draft));
  }

  // The one-time read gate + the controls it unlocks.
  const gateBtn = document.createElement("button");
  gateBtn.type = "button";
  gateBtn.className = "persona-action-btn";
  gateBtn.textContent = "I've read this — enable editing";

  const controls = document.createElement("div");
  controls.className = "persona-draft-controls";

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "persona-action-btn";
  editBtn.textContent = "Edit in form above";
  editBtn.addEventListener("click", () => populatePersonaForm(draft));

  const approveBtn = document.createElement("button");
  approveBtn.type = "button";
  approveBtn.className = "persona-action-btn";
  approveBtn.textContent = "Approve — write to persona store";
  approveBtn.addEventListener("click", () => approveDraft(tier, scopeId, draft.repo));

  const discardBtn = document.createElement("button");
  discardBtn.type = "button";
  discardBtn.className = "persona-action-btn destructive";
  discardBtn.textContent = "Discard — archive without committing";
  discardBtn.addEventListener("click", () => discardDraft(tier, scopeId, draft.repo));

  controls.appendChild(editBtn);
  controls.appendChild(approveBtn);
  controls.appendChild(discardBtn);

  const alreadyRead = readDraftIdentities.has(identityKey);
  gateBtn.hidden = alreadyRead;
  controls.hidden = !alreadyRead;

  gateBtn.addEventListener("click", () => {
    readDraftIdentities.add(identityKey);
    gateBtn.hidden = true;
    controls.hidden = false;
    editBtn.focus();
  });

  panel.appendChild(gateBtn);
  panel.appendChild(controls);

  td.appendChild(panel);
  tr.appendChild(td);
  return { tr, focusTarget };
}

// Builds the Actions <td> for one merged row, plus (for a draft-bearing
// row) its paired detail <tr> -- built together, in the SAME row-loop
// iteration, so the toggle button and the row it controls share direct
// closures rather than re-querying the DOM by a possibly-unsafe scopeId
// (accessibility.md: aria-expanded/aria-controls kept in sync here, and
// focus moved to the detail panel's focusTarget on expand, per §4.3).
function buildPersonaActionsAndDetail(row) {
  const td = document.createElement("td");

  if (row.draft) {
    const { tr: detailRow, focusTarget } = buildPersonaDraftDetailRow(row);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "persona-action-btn";
    btn.textContent = "Review ▸";
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", detailRow.id);
    btn.addEventListener("click", () => {
      const expanded = btn.getAttribute("aria-expanded") === "true";
      const next = !expanded;
      btn.setAttribute("aria-expanded", String(next));
      btn.textContent = next ? "Hide ▾" : "Review ▸";
      detailRow.hidden = !next;
      if (next && focusTarget) focusTarget.focus();
    });
    td.appendChild(btn);
    return { actionsCell: td, detailRow };
  }

  if (row.status === "live") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "persona-action-btn";
    btn.textContent = "Edit";
    btn.addEventListener("click", () => populatePersonaForm(row));
    td.appendChild(btn);
    return { actionsCell: td, detailRow: null };
  }

  td.textContent = "—";
  return { actionsCell: td, detailRow: null };
}

// Pre-fills #persona-form (the SAME editor used to propose a brand-new
// draft) with an existing record's fields -- reused for both "Edit" on a
// live row (proposes a revision draft) and "Edit in form above" on a draft's
// detail panel (overwrites that draft in place, since the form's retargeted
// submit handler below POSTs to the same {tier, scopeId} draft identity).
// One editor, reused, never a second one (design-discussion.md §9.4).
function populatePersonaForm(record) {
  personaForm.reset();
  personaTierFieldEl.value = record.tier || "";
  personaScopeIdFieldEl.value = record.scopeId || "";
  personaDisplayNameFieldEl.value = record.displayName || "";
  personaScopeFieldEl.value = record.scope || "";
  const firstSection = Array.isArray(record.sections) && record.sections[0] ? record.sections[0] : {};
  personaSectionHeadingFieldEl.value = firstSection.heading || "";
  personaSectionBodyFieldEl.value = firstSection.body || "";
  personaRepoFieldEl.value = record.repo || "";
  personaFormStatusEl.textContent = "";
  personaFormStatusEl.className = "panel-status";
  personaForm.scrollIntoView({ behavior: "smooth", block: "start" });
  personaTierFieldEl.focus();
}

// `?repo=` is only ever needed for the repo-local (code-architect) tier
// (server.ts's own `isRepoLocal` branch) -- omitted entirely for the 3
// global tiers, matching every other cross-origin persona-service fetch in
// this file.
function personaDraftServiceUrl(tier, scopeId, pathSuffix, repo) {
  const origin = personaServiceOrigin();
  const url = `${origin}/persona/draft/${encodeURIComponent(tier)}/${encodeURIComponent(scopeId)}${pathSuffix || ""}`;
  return repo ? `${url}?repo=${encodeURIComponent(repo)}` : url;
}

// Approve -- POSTs to pu-03's REAL POST /persona/draft/:tier/:scopeId/approve
// route (never a client-side simulation). Symmetric confirm-gating with
// discardDraft() below, specific descriptive copy (never a bare "Are you
// sure?"), per §4.5. On success: announces via the aria-live region, AND
// calls BOTH loadDrafts() (drops the now-archived draft from the active
// list) AND loadPersonas() (pw-03's existing, UNCHANGED function -- the
// newly-committed persona's appearance in the real list) -- never a
// duplicated/reimplemented version of either.
async function approveDraft(tier, scopeId, repo) {
  const identity = `${tier} / ${scopeId}`;
  const confirmed = window.confirm(
    `Approve ${identity}? This writes to the real persona store and cannot be undone from here.`
  );
  if (!confirmed) return;
  try {
    const res = await fetch(personaDraftServiceUrl(tier, scopeId, "/approve", repo), { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = (body.error && (body.error.message || body.error)) || `HTTP ${res.status}`;
      personasLiveRegionEl.textContent = `Approve failed for ${identity}: ${message}`;
      return;
    }
    personasLiveRegionEl.textContent = `Approved ${identity} — now live.`;
    readDraftIdentities.delete(personaRowKey(tier, scopeId));
    await Promise.all([loadDrafts(), loadPersonas()]);
  } catch (err) {
    personasLiveRegionEl.textContent = `Approve failed for ${identity}: ${err && err.message ? err.message : err}`;
  }
}

// Discard -- DELETEs via pu-03's REAL DELETE /persona/draft/:tier/:scopeId
// route (archive-by-move server-side, never a client-side simulation and
// never a bare delete). Requires this explicit window.confirm() before
// firing (a meaningfully consequential UI-level action, per
// design_decisions, even though non-destructive at the storage layer). On
// success, removes the draft from the active list immediately via
// loadDrafts() -- loadPersonas() is deliberately NOT called here, since a
// discard never touches the real persona store.
async function discardDraft(tier, scopeId, repo) {
  const identity = `${tier} / ${scopeId}`;
  const confirmed = window.confirm(
    "Discard this draft? It will be archived, not deleted, but removed from the review queue."
  );
  if (!confirmed) return;
  try {
    const res = await fetch(personaDraftServiceUrl(tier, scopeId, "", repo), { method: "DELETE" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = (body.error && (body.error.message || body.error)) || `HTTP ${res.status}`;
      personasLiveRegionEl.textContent = `Discard failed for ${identity}: ${message}`;
      return;
    }
    personasLiveRegionEl.textContent = `Discarded ${identity} — archived.`;
    readDraftIdentities.delete(personaRowKey(tier, scopeId));
    await loadDrafts();
  } catch (err) {
    personasLiveRegionEl.textContent = `Discard failed for ${identity}: ${err && err.message ? err.message : err}`;
  }
}

// loadDrafts() -- follows loadPersonas()'s existing conventions exactly
// (fetch, setStatus, render): GET /persona/draft (list; {tier, scopeId}
// pairs only -- listDraftPersonas' own contract, persona-draft-store.ts),
// then one GET /persona/draft/:tier/:scopeId per listed entry for the full
// record (displayName/scope/sections/sourceSummary/proposedBy/proposedAt),
// mirroring loadPersonas()'s own "list route doesn't carry displayName, so
// fetch each entry's own record" shape byte-for-byte. Sets loadedDrafts,
// then calls renderPersonas() -- the SAME render function loadPersonas()
// calls, never a second/duplicated rendering path.
async function loadDrafts() {
  setStatus(personasDraftsStatusEl, "loading", "loading drafts…");
  try {
    const origin = personaServiceOrigin();

    // puf-04-repo-scoped-personas-reachable: GET /persona/draft's own
    // ?repo=<path> contract ADDS that repo's code-architect drafts
    // alongside the 3 global tiers in the SAME list response (server.ts --
    // not a "switch" the way GET /persona's ?repo= is, see loadPersonas()
    // below) -- so making this reachable is a single URL change, never a
    // second fetch. No repo selected (the default) -> repo is "" -> listUrl
    // is byte-identical to before this ticket.
    const repo = currentPersonaRepoFilter();
    const listUrl = repo ? `${origin}/persona/draft?repo=${encodeURIComponent(repo)}` : `${origin}/persona/draft`;
    const listRes = await fetch(listUrl);
    const listBody = await listRes.json();
    if (!listRes.ok) {
      setStatus(personasDraftsStatusEl, "fail", `FAIL — GET /persona/draft returned ${listRes.status}`);
      loadedDrafts = [];
      renderPersonas();
      return;
    }
    const entries = Array.isArray(listBody.drafts) ? listBody.drafts : [];

    const drafts = await Promise.all(
      entries.map(async (entry) => {
        try {
          // puf-04: the per-entry read-back also needs ?repo= for a
          // code-architect entry (server.ts's own "?repo=<path> required
          // for tier=code-architect" contract on GET /persona/draft/:tier/
          // :scopeId) -- every code-architect entry in this list came from
          // the one `repo` just queried above. A global-tier entry (or any
          // entry when no repo is selected) never gets ?repo= appended,
          // same URL as before this ticket.
          const url =
            entry.tier === "code-architect" && repo
              ? `${origin}/persona/draft/${encodeURIComponent(entry.tier)}/${encodeURIComponent(entry.scopeId)}?repo=${encodeURIComponent(repo)}`
              : `${origin}/persona/draft/${encodeURIComponent(entry.tier)}/${encodeURIComponent(entry.scopeId)}`;
          const res = await fetch(url);
          const body = await res.json();
          if (!res.ok || !body.draft) return null;
          return body.draft;
        } catch {
          return null;
        }
      })
    );

    loadedDrafts = drafts.filter((d) => d != null);
    renderPersonas();
    setStatus(personasDraftsStatusEl, "pass", `${loadedDrafts.length} draft(s) pending review`);
  } catch (err) {
    setStatus(personasDraftsStatusEl, "fail", "FAIL — could not reach GET /persona/draft");
  }
}
// ==================== end pu-12-draft-review-approve-ui ====================

// ==================== puf-02-batch-approve-strip (epic mnemosyne-persona-
// panel-fidelity-followups): reviewed-queue batch-approve strip. Closes
// pu-14's fidelity-review.md FLAGGED finding D2 -- synthesized/option-2.md's
// own §6 calls this mechanism "the synthesis's own central bet" for
// answering operator-efficiency.md/information-density.md's batch-latency
// complaint (today, N drafts approved one at a time costs N independent
// approveDraft() calls, each with its own loadDrafts()/loadPersonas() pair)
// WITHOUT reopening Option 1's blind-approve failure mode -- the read-
// before-edit trust gate (readDraftIdentities, pu-12, above) stays the ONLY
// way a draft ever becomes eligible here. ===================================

const personasBatchStripEl = document.getElementById("personas-batch-strip");
const personasBatchStatusEl = document.getElementById("personas-batch-status");
const personasBatchChecklistEl = document.getElementById("personas-batch-checkboxes");
const personasBatchApproveBtn = document.getElementById("personas-batch-approve-btn");

// Session-scoped "is this reviewed identity currently checked in the strip"
// state -- separate from readDraftIdentities (the trust gate itself) so an
// operator can uncheck one reviewed draft without un-reading it.
// Reconciled against the CURRENT reviewed set on every
// renderBatchApproveStrip() call below: an identity that stops being
// reviewed-and-pending (approved, discarded, or never read) is dropped here
// too, so it can never linger as a stale, invisible "selected" entry.
const personasBatchSelected = new Set();

// The one and only definition of "batch-approve-eligible": already read
// this session (readDraftIdentities -- the trust gate pu-12 built, reused
// completely unchanged here, never a second/looser gate) AND still an
// active, pending draft (still present in loadedDrafts -- approveDraft()/
// discardDraft() already delete an identity from readDraftIdentities the
// moment its draft leaves the active set, so a stale identity can never
// appear here either). A draft that has never been opened/read this
// session is structurally absent from loadedDrafts-filtered-by-
// readDraftIdentities -- it can never become selectable/includable below.
function reviewedPendingDrafts() {
  return loadedDrafts.filter((d) => readDraftIdentities.has(personaRowKey(d.tier, d.scopeId)));
}

// Pure render, called from renderPersonas() on every load/toggle -- never
// fetches, matching every other render function in this file. Pre-checks
// every newly-reviewed identity by default (selection.md/synthesized
// option-2.md §1: "listing each reviewed-but-not-yet-committed draft... with
// a checkbox (all pre-checked)"), and hides the whole strip (not merely
// empties it) once nothing is reviewed-and-pending.
function renderBatchApproveStrip() {
  const reviewed = reviewedPendingDrafts();
  const reviewedKeys = new Set(reviewed.map((d) => personaRowKey(d.tier, d.scopeId)));

  for (const key of Array.from(personasBatchSelected)) {
    if (!reviewedKeys.has(key)) personasBatchSelected.delete(key);
  }
  for (const key of reviewedKeys) {
    if (!personasBatchSelected.has(key)) personasBatchSelected.add(key);
  }

  personasBatchChecklistEl.textContent = "";

  if (reviewed.length === 0) {
    personasBatchStripEl.hidden = true;
    return;
  }

  personasBatchStripEl.hidden = false;
  personasBatchStatusEl.textContent = `reviewed, ready to commit (${reviewed.length})`;

  for (const draft of reviewed) {
    const key = personaRowKey(draft.tier, draft.scopeId);
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = personasBatchSelected.has(key);
    cb.addEventListener("change", () => {
      if (cb.checked) personasBatchSelected.add(key);
      else personasBatchSelected.delete(key);
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(` ${draft.tier} / ${draft.scopeId}`));
    personasBatchChecklistEl.appendChild(label);
  }
}

// [Approve all] -- fires the checked subset of reviewedPendingDrafts()
// through the SAME real per-draft approve call approveDraft() (above) uses
// (personaDraftServiceUrl(tier, scopeId, "/approve", repo), POST) -- never a
// new/second write path -- once per selected draft, but issues exactly ONE
// combined loadDrafts()/loadPersonas() reload at the very end, not N
// reloads, closing pu-14's D2 finding. A native confirm() lists every
// identity about to be committed before anything fires, mirroring §4.5's
// per-draft confirm copy at batch scale (§6's own quoted example: "Approve 3
// drafts: ..."). Loading-state disable on the button during the in-flight
// batch mirrors #persona-form's own submit-button precedent (an ordinary
// loading-state disable unrelated to the read-before-edit trust gate, which
// is enforced structurally above by never rendering an unread draft into
// this strip at all -- not by a `disabled` attribute on it).
personasBatchApproveBtn.addEventListener("click", async () => {
  const targets = reviewedPendingDrafts().filter((d) =>
    personasBatchSelected.has(personaRowKey(d.tier, d.scopeId))
  );
  if (targets.length === 0) return;

  const identityList = targets.map((d) => `${d.tier} / ${d.scopeId}`).join(", ");
  const confirmed = window.confirm(
    `Approve ${targets.length} draft${targets.length === 1 ? "" : "s"}: ${identityList}? ` +
      "This writes to the real persona store and cannot be undone from here."
  );
  if (!confirmed) return;

  personasBatchApproveBtn.disabled = true;
  const failures = [];
  try {
    for (const draft of targets) {
      const identity = `${draft.tier} / ${draft.scopeId}`;
      try {
        const res = await fetch(
          personaDraftServiceUrl(draft.tier, draft.scopeId, "/approve", draft.repo),
          { method: "POST" }
        );
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          const message = (body.error && (body.error.message || body.error)) || `HTTP ${res.status}`;
          failures.push(`${identity}: ${message}`);
          continue;
        }
        readDraftIdentities.delete(personaRowKey(draft.tier, draft.scopeId));
        personasBatchSelected.delete(personaRowKey(draft.tier, draft.scopeId));
      } catch (err) {
        failures.push(`${identity}: ${err && err.message ? err.message : err}`);
      }
    }

    personasLiveRegionEl.textContent =
      failures.length === 0
        ? `Approved ${targets.length} draft${targets.length === 1 ? "" : "s"} — now live.`
        : `Approved ${targets.length - failures.length} of ${targets.length} draft(s); failed: ${failures.join("; ")}`;

    // Exactly ONE combined reload for the whole batch -- pu-14 D2's own fix
    // -- never one loadDrafts()/loadPersonas() pair per approved draft.
    await Promise.all([loadDrafts(), loadPersonas()]);
  } finally {
    personasBatchApproveBtn.disabled = false;
  }
});
// ==================== end puf-02-batch-approve-strip ====================

async function loadPersonas() {
  setStatus(personasStatusEl, "loading", "loading…");
  resetPersonaView();
  try {
    const origin = personaServiceOrigin();
    const listRes = await fetch(`${origin}/persona`);
    const listBody = await listRes.json();
    if (!listRes.ok) {
      setStatus(personasStatusEl, "fail", `FAIL — GET /persona returned ${listRes.status}`);
      return;
    }
    const entries = Array.isArray(listBody.personas) ? listBody.personas : [];

    // puf-04-repo-scoped-personas-reachable: GET /persona's own ?repo=
    // contract SWITCHES to that repo's code-architect personas ONLY
    // (server.ts -- unlike GET /persona/draft's ADD contract above), so
    // making the repo tier reachable here needs a SECOND, separate fetch
    // rather than a URL change on the one above -- the plain GET /persona
    // fetch just above stays completely untouched either way. Each
    // resulting entry is tagged with the repo it came from (`repo` isn't
    // part of GET /persona's list response shape) so the per-entry record
    // fetch below can request the right ?repo=, and so the final row carries
    // the `row.repo` groupPersonaRows()'s already-coded Repo-grouping branch
    // keys its sub-group label on. No repo selected -> this block is a
    // no-op -> `entries` is exactly what it was before this ticket.
    const repo = currentPersonaRepoFilter();
    if (repo) {
      try {
        const repoListRes = await fetch(`${origin}/persona?repo=${encodeURIComponent(repo)}`);
        const repoListBody = await repoListRes.json().catch(() => ({}));
        if (repoListRes.ok && Array.isArray(repoListBody.personas)) {
          for (const entry of repoListBody.personas) entries.push({ ...entry, repo });
        }
      } catch {
        // Swallow -- a failed repo-scoped fetch leaves the global-tier
        // rows (already fetched above) intact rather than failing the
        // whole panel load, matching this ticket's own per-entry
        // try/catch-and-fall-back convention immediately below.
      }
    }

    // One fetch per LISTED persona's OWN record only (needed for
    // displayName + parentRefs, which GET /persona's list response doesn't
    // carry) -- this is each persona's own content, not any parent's, so it
    // does not touch the copy-down guarantee above. CRITICAL: this never
    // loops over a persona's parentRefs to fetch THOSE -- see
    // parentRefsText/personaParentCell, the only things rendered for
    // parentRefs. puf-04: a repo-tagged entry (above) also needs ?repo= on
    // this per-entry read (server.ts's own "?repo=<path> required for
    // tier=code-architect" contract) and has that `repo` copied onto the
    // returned record (GET /persona/:tier/:scopeId's own response never
    // carries it back) -- an entry with no `repo` (every entry, before this
    // ticket) takes the exact same branch/URL as before.
    const personas = await Promise.all(
      entries.map(async (entry) => {
        const url = entry.repo
          ? `${origin}/persona/${encodeURIComponent(entry.tier)}/${encodeURIComponent(entry.scopeId)}?repo=${encodeURIComponent(entry.repo)}`
          : `${origin}/persona/${encodeURIComponent(entry.tier)}/${encodeURIComponent(entry.scopeId)}`;
        try {
          const res = await fetch(url);
          const body = await res.json();
          if (!res.ok || !body.persona) {
            return { tier: entry.tier, scopeId: entry.scopeId, displayName: null, parentRefs: [], repo: entry.repo };
          }
          return entry.repo ? { ...body.persona, repo: entry.repo } : body.persona;
        } catch {
          return { tier: entry.tier, scopeId: entry.scopeId, displayName: null, parentRefs: [], repo: entry.repo };
        }
      })
    );

    // pu-10-personas-panel-redesign-shell: this ticket reuses GET /persona
    // unchanged (no ?repo=, no /persona/draft) -- every row loaded here is
    // therefore a committed, live record. pu-12 is the ticket that merges
    // in GET /persona/draft's needs-review/needs-review-update rows
    // alongside these (horizontal-plan.md H7 component 3). puf-04-repo-
    // scoped-personas-reachable additively extends the SAME fetch above
    // (see the repo-scoped second fetch there) to also reach code-architect
    // rows for one selected repo -- this line, and everything below it, is
    // unchanged.
    loadedPersonas = personas.map((p) => ({ ...p, status: "live" }));
    renderPersonas();
    setStatus(personasStatusEl, "pass", `${personas.length} persona(s)`);
  } catch (err) {
    setStatus(personasStatusEl, "fail", "FAIL — could not reach GET /persona");
  }
}

// --- Personas panel write form (pw-17-personas-panel-write-form), RETARGETED
// by pu-12-draft-review-approve-ui. Same "form-row divs, POST, setStatus()
// pass/fail, re-load on success" convention addLaneForm's handler
// established -- see that handler for the exact shape this mirrors. POSTs
// to pu-03's POST /persona/draft/:tier/:scopeId route (NEVER pw-15's real
// POST /persona/:tier/:scopeId anymore -- that direct-write path is gone
// from this handler) on the persona service (same cross-origin
// personaServiceOrigin() this file's loadPersonas() above already uses).
// The request body is the same bare candidate shape as before
// ({tier, scopeId, displayName, scope, sections, repo?}) -- never
// mandateSections, which the server-side assertValidPersona would reject on
// mere presence (persona.ts) once this candidate is later approved. A
// single "knows" section (heading + body) remains the v1 minimum viable
// write path, not a full multi-section editor. On success, calls
// loadDrafts() (pu-12's new function, NOT loadPersonas() -- proposing or
// editing a draft never touches the real persona store; only an explicit
// Approve, wired below, does that).
//
// pf-05-ui-file-attachment: personaFileInputEl (#persona-file-input) is this
// same form's new, real <input type="file" multiple> field. The handler
// below reads each attached file's text via File.text(), caps it via
// pf-04's ported capExcerpt()/assembleSourceSummary() (see the
// pf-04-client-cap-twin section further down this file), and folds the
// result into the SAME candidate object as candidate.sourceSummary --
// additive only. Zero files attached -> candidate is untouched -> the
// request body is byte-for-byte identical to pu-12's own shipped behavior.
const personaForm = document.getElementById("persona-form");
const personaFormStatusEl = document.getElementById("persona-form-status");
const personaTierFieldEl = document.getElementById("persona-tier");
const personaScopeIdFieldEl = document.getElementById("persona-scope-id");
const personaDisplayNameFieldEl = document.getElementById("persona-display-name");
const personaScopeFieldEl = document.getElementById("persona-scope");
const personaSectionHeadingFieldEl = document.getElementById("persona-section-heading");
const personaSectionBodyFieldEl = document.getElementById("persona-section-body");
const personaRepoFieldEl = document.getElementById("persona-repo");
const personaFileInputEl = document.getElementById("persona-file-input");

personaForm.addEventListener("submit", async (evt) => {
  evt.preventDefault();
  const submitBtn = personaForm.querySelector("button[type=submit]");
  const formData = new FormData(personaForm);
  const tier = String(formData.get("tier") || "").trim();
  const scopeId = String(formData.get("scopeId") || "").trim();
  const displayName = String(formData.get("displayName") || "").trim();
  const scope = String(formData.get("scope") || "").trim();
  const sectionHeading = String(formData.get("sectionHeading") || "").trim();
  const sectionBody = String(formData.get("sectionBody") || "").trim();
  const repo = String(formData.get("repo") || "").trim();

  const candidate = {
    tier,
    scopeId,
    displayName,
    scope,
    sections: [{ heading: sectionHeading, body: sectionBody }],
  };
  if (repo) candidate.repo = repo;

  // pf-05-ui-file-attachment: fold any attached files' capped content into
  // THIS SAME candidate object, before the single fetch() below -- never a
  // second request. Reads real file content via File.text() (no files
  // attached -> attachedFiles is empty -> candidate is left untouched, so
  // the request body stays byte-for-byte identical to pu-12's own shipped
  // behavior). capExcerpt()/assembleSourceSummary() are pf-04's ported
  // cap-twin functions, defined further down this file (function
  // declarations are hoisted, so calling them here is safe).
  const attachedFiles = personaFileInputEl && personaFileInputEl.files ? Array.from(personaFileInputEl.files) : [];
  if (attachedFiles.length > 0) {
    const sourcesRead = [];
    for (const file of attachedFiles) {
      const raw = await file.text();
      sourcesRead.push({ name: file.name, ...capExcerpt(raw) });
    }
    candidate.sourceSummary = assembleSourceSummary(sourcesRead, []);
  }

  setStatus(personaFormStatusEl, "loading", "saving draft…");
  submitBtn.disabled = true;
  try {
    const origin = personaServiceOrigin();
    const res = await fetch(
      `${origin}/persona/draft/${encodeURIComponent(tier)}/${encodeURIComponent(scopeId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(candidate),
      }
    );
    const body = await res.json();
    if (!res.ok) {
      const message = (body.error && (body.error.message || body.error)) || `HTTP ${res.status}`;
      setStatus(personaFormStatusEl, "fail", `FAIL — ${message}`);
      return;
    }
    setStatus(personaFormStatusEl, "pass", `saved draft '${body.scopeId}' (${body.tier}) — pending review`);
    personaForm.reset();
    await loadDrafts();
  } catch (err) {
    setStatus(personaFormStatusEl, "fail", `FAIL — ${err && err.message ? err.message : err}`);
  } finally {
    submitBtn.disabled = false;
  }
});

async function loadPersonaLayerStack() {
  // Guards against running against an older served index.html that predates
  // this section (e.g. a stale cached page) -- never throws either way.
  if (!personaLayerStackStatusEl || !personaLayerStackTableEl || !personaLayerStackTbodyEl) return;

  setStatus(personaLayerStackStatusEl, "loading", "loading…");
  personaLayerStackTbodyEl.textContent = "";
  personaLayerStackTableEl.hidden = true;
  if (personaLayerStackEmptyEl) personaLayerStackEmptyEl.hidden = true;

  try {
    const res = await fetch(mnemosyneClientApiBase() + "/layers");
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setStatus(
        personaLayerStackStatusEl,
        "fail",
        `FAIL — GET /layers returned ${res.status}${body.error ? `: ${body.error.message || body.error}` : ""}`,
      );
      return;
    }
    const body = await res.json();
    const layers = Array.isArray(body.layers) ? body.layers : [];
    if (!layers.length) {
      setStatus(personaLayerStackStatusEl, "pass", "no layers configured");
      if (personaLayerStackEmptyEl) personaLayerStackEmptyEl.hidden = false;
      return;
    }
    layers.forEach((l, i) => {
      const tr = document.createElement("tr");
      tr.appendChild(personaLayerStackCell(String(i + 1)));
      tr.appendChild(personaLayerStackCell(l && l.layer != null ? String(l.layer) : "?"));
      tr.appendChild(personaLayerStackCell(l && l.writable ? "yes" : "no"));
      personaLayerStackTbodyEl.appendChild(tr);
    });
    personaLayerStackTableEl.hidden = false;
    setStatus(personaLayerStackStatusEl, "pass", `${layers.length} layer(s), cascade order`);
  } catch (err) {
    setStatus(personaLayerStackStatusEl, "fail", "FAIL — could not reach GET /layers");
  }
}
// ==================== end pw-04-layer-stack-visibility ====================

// ==================== ml-05-memory-levels-ui (epic mnemosyne-memory-levels) ====================
// Loads the 5 canonical memory-STORE-TYPE levels (ml-01's static taxonomy)
// via ml-04's NEW GET /memory-levels route -- a structurally separate
// question from loadPersonaLayerStack()'s "what's in the current recall()
// cascade" above, so this is its own function against its own section's
// elements, following the exact same setStatus()/hidden-table-toggling/
// error-handling conventions as loadPersonaLayerStack() above.
async function loadMemoryLevels() {
  // Guards against running against an older served index.html that predates
  // this section (e.g. a stale cached page) -- never throws either way.
  if (!memoryLevelsStatusEl || !memoryLevelsTableEl || !memoryLevelsTbodyEl) return;

  setStatus(memoryLevelsStatusEl, "loading", "loading…");
  memoryLevelsTbodyEl.textContent = "";
  memoryLevelsTableEl.hidden = true;
  if (memoryLevelsEmptyEl) memoryLevelsEmptyEl.hidden = true;

  try {
    const res = await fetch(mnemosyneClientApiBase() + "/memory-levels");
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setStatus(
        memoryLevelsStatusEl,
        "fail",
        `FAIL — GET /memory-levels returned ${res.status}${body.error ? `: ${body.error.message || body.error}` : ""}`,
      );
      return;
    }
    const body = await res.json();
    const levels = Array.isArray(body.levels) ? body.levels : [];
    if (!levels.length) {
      setStatus(memoryLevelsStatusEl, "pass", "no memory levels reported");
      if (memoryLevelsEmptyEl) memoryLevelsEmptyEl.hidden = false;
      return;
    }
    levels.forEach((l) => {
      const tr = document.createElement("tr");
      tr.appendChild(memoryLevelsCell(l && l.id != null ? String(l.id) : "?"));
      tr.appendChild(memoryLevelsCell(l && l.label ? String(l.label) : "?"));
      tr.appendChild(memoryLevelsCell(l && l.storeType ? String(l.storeType) : "?"));
      tr.appendChild(memoryLevelStatusCell(l));
      memoryLevelsTbodyEl.appendChild(tr);
    });
    memoryLevelsTableEl.hidden = false;
    setStatus(memoryLevelsStatusEl, "pass", `${levels.length} level(s), 0-4`);
  } catch (err) {
    setStatus(memoryLevelsStatusEl, "fail", "FAIL — could not reach GET /memory-levels");
  }
}
// ==================== end ml-05-memory-levels-ui ====================

// ==================== pf-04-client-cap-twin (epic mnemosyne-persona-files) ====================
// Client-side twin of skills/mnemosyne-persona-interview/crawl-context.mjs's
// capExcerpt()/assembleSourceSummary() -- ported verbatim (same constants,
// same truncation logic, same TRUNCATION_MARKER text) so the browser-side
// file attachment (pf-05, personaForm's submit handler above) enforces the
// identical truncation behavior before content ever leaves the browser,
// rather than trusting a server-side re-check alone (the existing 4MB
// readJsonBody() cap on lib/mnemosyne/server.ts remains the hard backstop
// regardless).
// See test/persona-files-cap-twin-parity.mjs for the running, byte-for-byte
// proof that this twin matches the Node original exactly, and
// test/persona-write-form.mjs for pf-05's proof that personaForm's submit
// handler actually calls these on attached files.
//
// pf-05-ui-file-attachment wired these in (personaForm's submit handler,
// above) -- no longer additive-only/uncalled.

/** Cap 1/3 -- at most this many lines are read from the top of any one file source. */
const MAX_LINES_PER_SOURCE = 40;
/** Cap 2/3 -- a hard character ceiling per source's excerpt, applied after the line cap. */
const MAX_CHARS_PER_SOURCE = 1200;
/** Cap 3/3 -- a hard ceiling on the assembled sourceSummary string as a whole. */
const MAX_SOURCE_SUMMARY_CHARS = 4000;

const TRUNCATION_MARKER = " …[capped]";

/**
 * Applies both file-level caps (MAX_LINES_PER_SOURCE, then
 * MAX_CHARS_PER_SOURCE) to one source's raw text. Deterministic, no I/O --
 * ported verbatim from crawl-context.mjs's own capExcerpt().
 */
function capExcerpt(raw) {
  const lines = String(raw).split(/\r?\n/);
  const truncatedByLines = lines.length > MAX_LINES_PER_SOURCE;
  let excerpt = lines.slice(0, MAX_LINES_PER_SOURCE).join("\n");

  const truncatedByChars = excerpt.length > MAX_CHARS_PER_SOURCE;
  if (truncatedByChars) {
    excerpt = excerpt.slice(0, MAX_CHARS_PER_SOURCE);
  }

  const truncated = truncatedByLines || truncatedByChars;
  return { excerpt: truncated ? excerpt + TRUNCATION_MARKER : excerpt, truncated };
}

/**
 * Assembles a final sourceSummary string from whatever sources were read,
 * applying MAX_SOURCE_SUMMARY_CHARS as a last, whole-string cap. Ported
 * verbatim from crawl-context.mjs's own (module-private) assembleSourceSummary().
 */
function assembleSourceSummary(sourcesRead, sourcesMissing) {
  if (sourcesRead.length === 0) {
    return (
      "Bounded crawl found none of the named sources present " +
      `(checked: ${sourcesMissing.join(", ")}). No repo/manifest/agent-file/parent-persona context available ` +
      "for this interview — proceeding with questions alone."
    );
  }

  const parts = sourcesRead.map((s) => `## ${s.name}\n${s.excerpt}`);
  let summary = parts.join("\n\n");
  if (summary.length > MAX_SOURCE_SUMMARY_CHARS) {
    summary = summary.slice(0, MAX_SOURCE_SUMMARY_CHARS) + TRUNCATION_MARKER;
  }
  return summary;
}
// ==================== end pf-04-client-cap-twin ====================

// ==================== ui-03-jump-chip-nav-and-status-wiring ====================
// Status-propagation layer (horizontal-plan.md H3): mirrors each panel's own
// already-rendered .panel-status pass/fail state onto its matching
// #jump-chips anchor as a chip-pass/chip-fail class. syncJumpChips() is
// called once, from refreshAll()'s completion path below, AFTER every
// load*() in that Promise.all(...) has already resolved and called its own
// real setStatus() -- so every read here is of a class that's genuinely on
// the DOM at that moment, never invented.
//
// CHIP_STATUS_SOURCE is deliberately NOT one entry per panel. It maps only
// the panels whose real markup has a top-level .panel-status element that
// setStatus() populates as a direct, unconditional part of refreshAll()
// itself:
//   - liveliness-status / settings-status / lanes-status / personas-status /
//     memory-levels-status: each is the first <p class="panel-status"> in
//     its <section>, and each panel's own load*() (loadLiveliness/
//     loadSettings/loadLanes/loadPersonas/loadMemoryLevels) sets it to
//     pass/fail unconditionally every refreshAll() call. Real signal ->
//     real ring.
//   - graph-status: same shape (loadGraph() -> pass/fail every refreshAll()
//     call, per app.js above). NOTE this deliberately diverges from this
//     story's own ticket text (which cites a claimed research-brief.md
//     statement that Graph has no panel-status line): that claim is true of
//     the round-2 design MOCKUP's Graph section (verified by inspection --
//     it has no .panel-status anywhere) but NOT of this repo's real
//     ui/index.html, where #graph-status is a real, first-child-of-<h2>
//     status element loadGraph() sets every refresh. Suppressing a real,
//     already-rendered status to match a stale/mis-cited doc would itself
//     be a form of fabrication in the other direction, so Graph's chip IS
//     wired here, sourced honestly from its own real element.
//   - search-status and the Operations sub-forms' reindex-status /
//     refresh-cache-status are deliberately EXCLUDED: search-status only
//     gets set inside the search-form's own submit handler (a user action,
//     never called from refreshAll()), and Operations has no top-level
//     .panel-status at all -- reindex-status/refresh-cache-status are two
//     separate sub-form statuses, each set only by its own submit/click
//     handler, never by refreshAll(). Per H3's "no data, no ring" rule,
//     mapping either would fabricate a ring where no real, refresh-time
//     status exists, so Search and Operations are left out on purpose --
//     their chips get neither chip-pass nor chip-fail.
//   - discovery-status (cm-15) is the SAME shape: only ever set by
//     discoveryScanBtn's own click handler, never by refreshAll() (AC1: no
//     automatic background scan fires on page load) -- left out for the
//     identical reason.
//   - triage-review (cm-16) maps to triage-candidates-status -- unlike
//     Discovery & Pilot, BOTH of this panel's own fetches (candidates +
//     queue) ARE driven by refreshAll() (they're pure reads, no write side
//     effect), so a real status exists here on every refresh; only one of
//     the two panel-status elements is picked for the chip, matching
//     Personas' own single-chip-from-personas-status precedent (not
//     personas-drafts-status).
const CHIP_STATUS_SOURCE = {
  liveliness: "liveliness-status",
  settings: "settings-status",
  lanes: "lanes-status",
  graph: "graph-status",
  personas: "personas-status",
  "memory-levels": "memory-levels-status",
  "triage-review": "triage-candidates-status",
};

function syncJumpChips() {
  document.querySelectorAll("#jump-chips a").forEach((chip) => {
    const panelId = (chip.getAttribute("href") || "").slice(1);
    const statusId = CHIP_STATUS_SOURCE[panelId];
    const statusEl = statusId ? document.getElementById(statusId) : null;
    // No mapped status element (Search/Operations, by design -- see the
    // comment above) or the element hasn't rendered a real pass/fail yet
    // (e.g. still mid-"loading") -> neither class. Never fabricate: a chip
    // only ever gets the class that's REALLY on its real panel's element.
    const isPass = !!statusEl && statusEl.classList.contains("pass");
    const isFail = !!statusEl && statusEl.classList.contains("fail");
    chip.classList.toggle("chip-pass", isPass);
    chip.classList.toggle("chip-fail", isFail);
    // ui-05-accessibility-hardening: mirror the SAME isPass/isFail values
    // just computed onto the chip's visually-hidden text alternative
    // (index.html's #chip-status-<panelId> span) -- a real screen-reader
    // announcement of this chip's real status, never a static/generic
    // label. Read via document.getElementById() (not chip.querySelector())
    // so this keeps working unmodified against test/jump-chip-nav-status-
    // wiring.mjs's fake-DOM harness, whose FakeChip stub only implements
    // getAttribute(), not querySelector() -- getElementById() on a fake
    // document that doesn't know this id just returns null, which the
    // guard below already handles safely. Concatenated after the chip's
    // own visible panel-name text node, so the chip's full accessible name
    // reads e.g. "Liveliness: pass" (never fabricated for Search/
    // Operations, which have no statusId and so always get "" here).
    const statusTextEl = document.getElementById(`chip-status-${panelId}`);
    if (statusTextEl) statusTextEl.textContent = isPass ? ": pass" : isFail ? ": fail" : "";
  });
}
// ==================== end ui-03-jump-chip-nav-and-status-wiring (part 1) ====================

// ==================== cm-15-discovery-and-pilot-trigger-ui ====================
// Discovery & Pilot panel: "Scan for new sources" (POST /conversation-memory/
// sources/scan) renders cm-02's real manifest as checkbox rows; "Run pilot on
// selected" (POST /conversation-memory/pilot/run) invokes cm-08's bounded
// orchestrator over EXACTLY the marked subset. Never auto-fetched by
// refreshAll() — AC1 requires no automatic background scan on page load, so
// this panel is deliberately absent from refreshAll()'s Promise.all(...)
// above, same as Search/Operations' own manual-trigger-only convention.
const discoveryStatusEl = document.getElementById("discovery-status");
const discoveryScanBtn = document.getElementById("discovery-scan-btn");
const discoveryScanStatusEl = document.getElementById("discovery-scan-status");
const discoverySessionsBlockEl = document.getElementById("discovery-sessions-block");
const discoverySessionsChecklistEl = document.getElementById("discovery-sessions-checkboxes");
const discoverySessionsEmptyEl = document.getElementById("discovery-sessions-empty");
const discoveryExcludedBlockEl = document.getElementById("discovery-excluded-block");
const discoveryExcludedListEl = document.getElementById("discovery-excluded-list");
const discoveryExportsBlockEl = document.getElementById("discovery-exports-block");
const discoveryExportsStatusEl = document.getElementById("discovery-exports-status");
const discoveryChatgptIdsEl = document.getElementById("discovery-chatgpt-ids");
const discoveryRunBtn = document.getElementById("discovery-run-btn");
const discoveryRunStatusEl = document.getElementById("discovery-run-status");
const discoveryLiveRegionEl = document.getElementById("discovery-live-region");
const discoveryResultsTableEl = document.getElementById("discovery-results-table");
const discoveryResultsTbodyEl = document.getElementById("discovery-results-tbody");

// Session-scoped "which session paths are currently checked" state —
// mirrors personasBatchSelected's own Set-of-keys convention. Rebuilt fresh
// on every real scan (a re-scan is a genuinely new manifest, cm-02's own
// AC7) rather than reconciled against the previous scan's marks.
let discoveryLastManifest = null;
const discoverySelectedSessionPaths = new Set();

function discoveryResultCell(text) {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}

function discoveryExportFieldRow(label, entry) {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = `${entry.status} (${entry.path})`;
  return [dt, dd];
}

// Pure render from the real, already-fetched manifest — never fetches
// itself, matching every other render function in this file (renderPersonas(),
// renderBatchApproveStrip()).
function renderDiscoveryManifest(manifest) {
  discoverySelectedSessionPaths.clear();
  discoverySessionsChecklistEl.textContent = "";
  discoveryExcludedListEl.textContent = "";
  discoveryExportsStatusEl.textContent = "";

  const sessions = Array.isArray(manifest.sessions) ? manifest.sessions : [];
  discoverySessionsBlockEl.hidden = false;
  discoverySessionsEmptyEl.hidden = sessions.length !== 0;
  for (const session of sessions) {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = session.path;
    cb.addEventListener("change", () => {
      if (cb.checked) discoverySelectedSessionPaths.add(session.path);
      else discoverySelectedSessionPaths.delete(session.path);
    });
    label.appendChild(cb);
    label.appendChild(
      document.createTextNode(
        ` ${session.path} (${session.sizeBytes ?? "?"} bytes, ${session.scratchConfidence || "unknown"})`,
      ),
    );
    discoverySessionsChecklistEl.appendChild(label);
  }

  const excluded = Array.isArray(manifest.excluded) ? manifest.excluded : [];
  discoveryExcludedBlockEl.hidden = excluded.length === 0;
  for (const entry of excluded) {
    const li = document.createElement("li");
    li.textContent = `${entry.dir} — ${entry.reason}`;
    discoveryExcludedListEl.appendChild(li);
  }

  const exports = manifest.exports || {};
  discoveryExportsBlockEl.hidden = false;
  if (exports.chatgpt) {
    const [dt, dd] = discoveryExportFieldRow("ChatGPT export", exports.chatgpt);
    discoveryExportsStatusEl.appendChild(dt);
    discoveryExportsStatusEl.appendChild(dd);
  }
  if (exports.gemini) {
    const [dt, dd] = discoveryExportFieldRow("Gemini export (no pilot support yet)", exports.gemini);
    discoveryExportsStatusEl.appendChild(dt);
    discoveryExportsStatusEl.appendChild(dd);
  }
}

discoveryScanBtn.addEventListener("click", async () => {
  setStatus(discoveryScanStatusEl, "loading", "scanning for new sources…");
  discoveryScanBtn.disabled = true;
  try {
    const res = await fetch("/conversation-memory/sources/scan", { method: "POST" });
    const body = await res.json();
    if (!res.ok) {
      setStatus(discoveryScanStatusEl, "fail", `FAIL — ${body.error || `HTTP ${res.status}`}`);
      return;
    }
    discoveryLastManifest = body;
    renderDiscoveryManifest(body);
    const sessionCount = Array.isArray(body.sessions) ? body.sessions.length : 0;
    setStatus(discoveryScanStatusEl, "pass", `scanned — ${sessionCount} session(s) found (generated ${body.generatedAt || "?"})`);
    setStatus(discoveryStatusEl, "pass", `last scan: ${sessionCount} session(s) found`);
  } catch (err) {
    setStatus(discoveryScanStatusEl, "fail", `FAIL — ${err && err.message ? err.message : err}`);
  } finally {
    discoveryScanBtn.disabled = false;
  }
});

// [Run pilot on selected] — layer 1 of the three no-implicit-selection
// layers (design-discussion.md §12.2): the button is always reachable (no
// `disabled` attribute in the static markup, mirroring the established
// Personas/Operations convention) but clicking with zero marked entries
// refuses inline and NEVER fires a fetch() — mirrors #reindex-paths's own
// identical empty-input refusal (ui/app.js's reindexForm handler, above).
discoveryRunBtn.addEventListener("click", async () => {
  const sessionPaths = Array.from(discoverySelectedSessionPaths);
  const exportKeys = String(discoveryChatgptIdsEl.value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (sessionPaths.length === 0 && exportKeys.length === 0) {
    setStatus(discoveryRunStatusEl, "fail", "select at least one source before running the pilot");
    return;
  }

  const confirmed = window.confirm(
    `Run cm-08's pilot over ${sessionPaths.length} session(s) and ${exportKeys.length} ChatGPT conversation(s)?\n\n` +
      "This shells out against LIVE Gemini + LIVE Qdrant Cloud, writes real, persisted " +
      "data, and can take real time. cm-08's own cap (max 5 per source) is enforced by " +
      "cm-08 itself, not here.",
  );
  if (!confirmed) {
    setStatus(discoveryRunStatusEl, "", "cancelled");
    return;
  }

  discoveryResultsTableEl.hidden = true;
  discoveryResultsTbodyEl.textContent = "";
  setStatus(discoveryRunStatusEl, "loading", "running pilot… (this can take a while against live Gemini + Qdrant Cloud)");
  discoveryRunBtn.disabled = true;
  try {
    const res = await fetch("/conversation-memory/pilot/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionPaths, exportKeys }),
    });
    const body = await res.json();
    if (!res.ok) {
      setStatus(discoveryRunStatusEl, "fail", `FAIL — ${body.error || `HTTP ${res.status}`}`);
      discoveryLiveRegionEl.textContent = `Pilot run refused: ${body.error || `HTTP ${res.status}`}`;
      return;
    }
    if (body.refused) {
      // cm-08's own refusal (e.g. its small-sample cap exceeded), surfaced
      // verbatim — never re-worded, never re-capped by this panel.
      setStatus(discoveryRunStatusEl, "fail", `FAIL — cm-08 refused: ${body.reason || "unknown reason"}`);
      discoveryLiveRegionEl.textContent = `Pilot run refused by cm-08: ${body.reason || "unknown reason"}`;
      return;
    }

    const results = Array.isArray(body.results) ? body.results : [];
    for (const r of results) {
      const tr = document.createElement("tr");
      tr.appendChild(discoveryResultCell(r.sourceType));
      tr.appendChild(discoveryResultCell(r.sessionId));
      tr.appendChild(discoveryResultCell(r.stage));
      tr.appendChild(discoveryResultCell(r.ok ? "ok" : "FAILED"));
      tr.appendChild(discoveryResultCell(r.error || ""));
      discoveryResultsTbodyEl.appendChild(tr);
    }
    discoveryResultsTableEl.hidden = results.length === 0;

    setStatus(
      discoveryRunStatusEl,
      body.failureCount ? "fail" : "pass",
      `done — ${body.sessionCount ?? results.length} session(s), ${body.clusterCount ?? "?"} cluster(s), ` +
        `${body.failureCount ?? 0} stage failure(s)`,
    );
    discoveryLiveRegionEl.textContent = `Pilot run complete: ${body.sessionCount ?? results.length} session(s), ${body.failureCount ?? 0} stage failure(s).`;
  } catch (err) {
    setStatus(discoveryRunStatusEl, "fail", `FAIL — ${err && err.message ? err.message : err}`);
  } finally {
    discoveryRunBtn.disabled = false;
  }
});
// ==================== end cm-15-discovery-and-pilot-trigger-ui ====================

// ==================== cm-16-triage-review-and-confirm-ui ====================
// Triage Review panel: GET /conversation-memory/intake-candidates (real
// candidate status per intake entry) + GET /conversation-memory/triage-queue
// (quarantine hits + existing scope-route confirmations) are both pure
// reads, so — unlike Discovery & Pilot's deliberate manual-trigger-only
// exclusion (that panel's own "scan" IS a real write) — both are included in
// refreshAll() below, matching Personas'/Memory Levels' own auto-load
// convention. POST /conversation-memory/scope-route/confirm is the ONE real
// write action here, reached only via the batch confirm strip below —
// exactly Personas' own puf-02-batch-approve-strip idiom (checkboxes + one
// button, no `disabled` attribute).
const triageCandidatesStatusEl = document.getElementById("triage-candidates-status");
const triageQueueStatusEl = document.getElementById("triage-queue-status");
const triageLiveRegionEl = document.getElementById("triage-review-live-region");
const triageConfirmStripEl = document.getElementById("triage-confirm-strip");
const triageConfirmStatusEl = document.getElementById("triage-confirm-status");
const triageConfirmCheckboxesEl = document.getElementById("triage-confirm-checkboxes");
const triageConfirmBtn = document.getElementById("triage-confirm-btn");
const triageCandidatesTbodyEl = document.getElementById("triage-candidates-tbody");
const triageCandidatesEmptyEl = document.getElementById("triage-candidates-empty");
const triageQuarantineTbodyEl = document.getElementById("triage-quarantine-tbody");
const triageQuarantineEmptyEl = document.getElementById("triage-quarantine-empty");
const triageConfirmationsTbodyEl = document.getElementById("triage-confirmations-tbody");
const triageConfirmationsEmptyEl = document.getElementById("triage-confirmations-empty");

// Confirm targets a (cluster_id, scope_key) PAIR, not an individual intake
// entry — multiple candidate rows can share the same pair (every entry in
// the same cluster carries the same resolved_scope_candidate), and
// confirming once resolves all of them. Keyed "clusterId scopeKey",
// mirroring distributeIntakeEntries.ts's own confirmationKey() null-byte
// join (never collides with a real-world field value).
const triageSelectedPairs = new Set();

function triageCell(text) {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}

function triagePairKey(clusterId, scopeKey) {
  return `${clusterId} ${scopeKey}`;
}

// Pure render from the real, already-fetched candidates array — never
// fetches itself (mirrors renderDiscoveryManifest()/renderPersonas()).
function renderTriageCandidates(candidates) {
  triageCandidatesTbodyEl.textContent = "";
  triageSelectedPairs.clear();

  const list = Array.isArray(candidates) ? candidates : [];
  triageCandidatesEmptyEl.hidden = list.length !== 0;
  if (list.length === 0) triageCandidatesEmptyEl.textContent = "No intake entries found.";

  for (const c of list) {
    const tr = document.createElement("tr");
    tr.appendChild(triageCell(c.entryId));
    tr.appendChild(triageCell(c.clusterId ?? "—"));
    tr.appendChild(triageCell(c.scopeKey ?? "—"));
    tr.appendChild(triageCell(c.status));
    tr.appendChild(triageCell(c.distributedToScope ?? "—"));
    triageCandidatesTbodyEl.appendChild(tr);
  }

  // Batch confirm strip: one checkbox per DISTINCT (cluster_id, scope_key)
  // pair among candidate_unconfirmed rows — never one per raw candidate row,
  // since confirming is a cluster-level action (POST .../confirm resolves
  // EVERY intake entry sharing that pair, not just one).
  const unconfirmedPairs = new Map();
  for (const c of list) {
    if (c.status !== "candidate_unconfirmed" || !c.clusterId || !c.scopeKey) continue;
    const key = triagePairKey(c.clusterId, c.scopeKey);
    const existing = unconfirmedPairs.get(key);
    if (existing) existing.count += 1;
    else unconfirmedPairs.set(key, { clusterId: c.clusterId, scopeKey: c.scopeKey, count: 1 });
  }

  triageConfirmCheckboxesEl.textContent = "";
  triageConfirmStripEl.hidden = unconfirmedPairs.size === 0;
  for (const [key, pair] of unconfirmedPairs) {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = key;
    cb.addEventListener("change", () => {
      if (cb.checked) triageSelectedPairs.add(key);
      else triageSelectedPairs.delete(key);
    });
    label.appendChild(cb);
    label.appendChild(
      document.createTextNode(` cluster ${pair.clusterId} → scope "${pair.scopeKey}" (${pair.count} entr${pair.count === 1 ? "y" : "ies"})`),
    );
    triageConfirmCheckboxesEl.appendChild(label);
  }
}

// Read-only render — quarantine rows get ZERO action controls of any kind
// (this story's own explicit instruction; cm-01's own quarantine-retention-
// policy question stays open, not resolved here) and existing confirmations
// render for visibility only (no revoke/undo control exists anywhere).
function renderTriageQueue({ quarantine, confirmations }) {
  triageQuarantineTbodyEl.textContent = "";
  const qList = Array.isArray(quarantine) ? quarantine : [];
  triageQuarantineEmptyEl.hidden = qList.length !== 0;
  if (qList.length === 0) triageQuarantineEmptyEl.textContent = "No quarantine hits.";
  for (const q of qList) {
    const tr = document.createElement("tr");
    tr.appendChild(triageCell(q.entry_id));
    tr.appendChild(triageCell(q.chat_source));
    tr.appendChild(triageCell(q.cluster_id ?? "—"));
    const matches = Array.isArray(q.secretMatches) ? q.secretMatches : [];
    tr.appendChild(triageCell(matches.map((m) => `${m.category}/${m.pattern} (line ${m.line})`).join(", ") || "—"));
    triageQuarantineTbodyEl.appendChild(tr);
  }

  triageConfirmationsTbodyEl.textContent = "";
  const cList = Array.isArray(confirmations) ? confirmations : [];
  triageConfirmationsEmptyEl.hidden = cList.length !== 0;
  if (cList.length === 0) triageConfirmationsEmptyEl.textContent = "No confirmed scope routes yet.";
  for (const c of cList) {
    const tr = document.createElement("tr");
    tr.appendChild(triageCell(c.recordedAt));
    tr.appendChild(triageCell(c.cluster_id));
    tr.appendChild(triageCell(c.scope_key));
    triageConfirmationsTbodyEl.appendChild(tr);
  }
}

async function loadTriageCandidates() {
  setStatus(triageCandidatesStatusEl, "loading", "loading intake candidates…");
  try {
    const res = await fetch("/conversation-memory/intake-candidates");
    const body = await res.json();
    if (!res.ok) {
      setStatus(triageCandidatesStatusEl, "fail", `FAIL — ${body.error || `HTTP ${res.status}`}`);
      return;
    }
    renderTriageCandidates(body.candidates);
    setStatus(triageCandidatesStatusEl, "pass", `${Array.isArray(body.candidates) ? body.candidates.length : 0} intake candidate(s)`);
  } catch (err) {
    setStatus(triageCandidatesStatusEl, "fail", `FAIL — ${err && err.message ? err.message : err}`);
  }
}

async function loadTriageQueue() {
  setStatus(triageQueueStatusEl, "loading", "loading triage queue…");
  try {
    const res = await fetch("/conversation-memory/triage-queue");
    const body = await res.json();
    if (!res.ok) {
      setStatus(triageQueueStatusEl, "fail", `FAIL — ${body.error || `HTTP ${res.status}`}`);
      return;
    }
    renderTriageQueue(body);
    setStatus(
      triageQueueStatusEl,
      "pass",
      `${(body.quarantine || []).length} quarantine hit(s), ${(body.confirmations || []).length} confirmation(s)`,
    );
  } catch (err) {
    setStatus(triageQueueStatusEl, "fail", `FAIL — ${err && err.message ? err.message : err}`);
  }
}

triageConfirmBtn.addEventListener("click", async () => {
  const pairs = Array.from(triageSelectedPairs).map((key) => {
    const [clusterId, scopeKey] = key.split(" ");
    return { clusterId, scopeKey };
  });

  if (pairs.length === 0) {
    setStatus(triageConfirmStatusEl, "fail", "select at least one candidate before confirming");
    return;
  }

  triageConfirmBtn.disabled = true;
  setStatus(triageConfirmStatusEl, "loading", `confirming ${pairs.length} pair(s)…`);
  let okCount = 0;
  let failCount = 0;
  const failures = [];
  for (const { clusterId, scopeKey } of pairs) {
    try {
      const res = await fetch("/conversation-memory/scope-route/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cluster_id: clusterId, scope_key: scopeKey }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        failCount += 1;
        failures.push(`${clusterId}/${scopeKey}: ${body.error || `HTTP ${res.status}`}`);
      } else {
        okCount += 1;
      }
    } catch (err) {
      failCount += 1;
      failures.push(`${clusterId}/${scopeKey}: ${err && err.message ? err.message : err}`);
    }
  }

  if (failCount === 0) {
    setStatus(triageConfirmStatusEl, "pass", `confirmed ${okCount} pair(s)`);
    triageLiveRegionEl.textContent = `Confirmed ${okCount} scope-route pair(s).`;
  } else {
    setStatus(triageConfirmStatusEl, "fail", `confirmed ${okCount}, FAILED ${failCount}: ${failures.join("; ")}`);
    triageLiveRegionEl.textContent = `Confirmed ${okCount} pair(s), ${failCount} failed.`;
  }

  // Real, current state after any real writes — never left showing a stale
  // pre-confirm snapshot (mirrors approveDraft()'s own reload-after-write
  // convention, ui/app.js).
  await Promise.all([loadTriageCandidates(), loadTriageQueue()]);
  triageConfirmBtn.disabled = false;
});
// ==================== end cm-16-triage-review-and-confirm-ui ====================

async function refreshAll() {
  refreshBtn.disabled = true;
  try {
    await Promise.all([
      loadLiveliness(),
      loadSettings(),
      loadLanes(),
      loadSearchScopes(),
      loadGraph(),
      loadReindexLanes(),
      loadPersonas(),
      loadDrafts(),
      loadPersonaLayerStack(),
      loadMemoryLevels(),
      loadTriageCandidates(),
      loadTriageQueue(),
    ]);
    syncJumpChips();
    lastRefreshedEl.textContent = `last refreshed ${new Date().toLocaleTimeString()}`;
  } finally {
    refreshBtn.disabled = false;
  }
}

refreshBtn.addEventListener("click", refreshAll);

// ==================== ui-03-jump-chip-nav-and-status-wiring (part 2) ====================
// Optional progressive-enhancement scroll-spy: highlights whichever chip
// corresponds to the panel currently scrolled into view. Purely cosmetic --
// every chip is already a working <a href="#id"> anchor and every panel is
// already fully visible from ui/index.html's static markup alone (no
// display:none anywhere on .panel, no JS-gated visibility). The guard below
// is the literal first line of this IIFE: if IntersectionObserver isn't
// supported, or this whole <script> fails to load or throws, nothing above
// (chip existence, click-to-jump, panel visibility, or the chip-pass/
// chip-fail rings syncJumpChips() already applied) is affected in any way.
(function initJumpChipScrollSpy() {
  if (!("IntersectionObserver" in window)) return;
  const chipsById = {};
  document.querySelectorAll("#jump-chips a").forEach((a) => {
    const id = (a.getAttribute("href") || "").slice(1);
    if (id) chipsById[id] = a;
  });
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const chip = chipsById[entry.target.id];
        if (!chip) return;
        document.querySelectorAll("#jump-chips a.current").forEach((c) => c.classList.remove("current"));
        chip.classList.add("current");
      });
    },
    { rootMargin: "-120px 0px -70% 0px", threshold: 0 },
  );
  document.querySelectorAll("main > .panel").forEach((p) => io.observe(p));
})();
// ==================== end ui-03-jump-chip-nav-and-status-wiring (part 2) ====================

// Initial load on open. No auto-polling after this — manual refresh only.
refreshAll();
