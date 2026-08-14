// app.js — Mnemosyne standalone UI shell (s-01: liveliness + read-only settings).
// Zero third-party deps: vanilla fetch + DOM. Loads once on open, then only on
// manual refresh — no auto-polling in v1 (see design-discussion.md).

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

async function refreshAll() {
  refreshBtn.disabled = true;
  try {
    await Promise.all([loadLiveliness(), loadSettings(), loadLanes(), loadSearchScopes(), loadGraph(), loadReindexLanes()]);
    lastRefreshedEl.textContent = `last refreshed ${new Date().toLocaleTimeString()}`;
  } finally {
    refreshBtn.disabled = false;
  }
}

refreshBtn.addEventListener("click", refreshAll);

// Initial load on open. No auto-polling after this — manual refresh only.
refreshAll();
