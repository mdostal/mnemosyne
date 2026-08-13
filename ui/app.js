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

async function refreshAll() {
  refreshBtn.disabled = true;
  try {
    await Promise.all([loadLiveliness(), loadSettings(), loadLanes(), loadSearchScopes()]);
    lastRefreshedEl.textContent = `last refreshed ${new Date().toLocaleTimeString()}`;
  } finally {
    refreshBtn.disabled = false;
  }
}

refreshBtn.addEventListener("click", refreshAll);

// Initial load on open. No auto-polling after this — manual refresh only.
refreshAll();
