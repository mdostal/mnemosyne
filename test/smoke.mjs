// smoke.mjs — end-to-end smoke test against a running Mnemosyne.
// Verifies: health PASS, scopes present, remember round-trips (recallable).
// Usage: MNEMOSYNE_URL=http://127.0.0.1:8477 node test/smoke.mjs
const BASE = process.env.MNEMOSYNE_URL || "http://127.0.0.1:8477";

async function j(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

let fails = 0;
const ok = (c, m) => { console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`); if (!c) fails++; };

const health = await j("GET", "/health");
ok(health.status === 200 && health.body.ok, `health -> ${health.body.ok}`);

const scopes = await j("GET", "/scopes");
ok(scopes.status === 200 && scopes.body.scopes && scopes.body.scopes.att,
  `scopes -> ${Object.keys(scopes.body.scopes || {}).length} scopes`);

const recall = await j("POST", "/recall",
  { query: "ATT client offer model retainer pricing", scope: "att", hits: 3 });
ok(recall.status === 200 && recall.body.total_hits >= 1,
  `recall(att) -> total_hits=${recall.body.total_hits}`);

const token = `MNEMO-SMOKE-${Date.now()}`;
const remember = await j("POST", "/remember",
  { text: `Mnemosyne smoke test round-trip token ${token}.`, scope: "personal", tag: "smoke" });
ok(remember.status === 200 && remember.body.remembered,
  `remember -> ${remember.body.collection} (${remember.body.chunks_upserted} chunks)`);

await new Promise((r) => setTimeout(r, 1500));
const back = await j("POST", "/recall", { query: token, scope: "personal", hits: 3 });
const found = JSON.stringify(back.body).includes(token);
ok(found, `recall round-trip finds ${token}`);

console.log(fails ? `\n${fails} check(s) failed` : "\nall smoke checks passed");
process.exit(fails ? 1 : 0);
