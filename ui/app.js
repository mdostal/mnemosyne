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

async function refreshAll() {
  refreshBtn.disabled = true;
  try {
    await Promise.all([loadLiveliness(), loadSettings(), loadLanes()]);
    lastRefreshedEl.textContent = `last refreshed ${new Date().toLocaleTimeString()}`;
  } finally {
    refreshBtn.disabled = false;
  }
}

refreshBtn.addEventListener("click", refreshAll);

// Initial load on open. No auto-polling after this — manual refresh only.
refreshAll();
