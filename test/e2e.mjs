// e2e.mjs — headless memory round-trip probe against a running Mnemosyne.
//
// Verifies (PAN-7547):
//   AC1  GET /health   -> ok:true, with non-zero Qdrant collection + point counts
//   AC2  POST /remember -> writes a tagged marker into the scratch (personal) scope
//   AC3  POST /recall   -> the marker comes back as the TOP hit, with provenance
//                          (location + score)
//   AC4  GET /healthz  -> 200 (alias so external checkers don't 404)
//
// Cleans up the local scratch note file it writes. The Qdrant point itself is
// left in place — swarm-memory's index is additive-only by design (SERVICE.md),
// there is no delete path in the CLI to unwind it.
//
// Usage: MNEMOSYNE_URL=http://127.0.0.1:8477 node test/e2e.mjs
import { unlink } from "node:fs/promises";

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
const ok = (c, m) => {
  console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`);
  if (!c) fails++;
};

// AC1 — health: ok:true + non-zero Qdrant collection/point counts.
const health = await j("GET", "/health");
const collections = /—\s*(\d+)\s+collections/i.exec(health.body.detail || "");
const points = /\(\S+,\s*(\d+)\s*points\)/i.exec(health.body.detail || "");
ok(health.status === 200 && health.body.ok === true, `health -> ok=${health.body.ok}`);
ok(
  !!collections && Number(collections[1]) > 0,
  `health detail reports non-zero Qdrant collections -> ${collections?.[1] ?? "none found"}`
);
ok(
  !!points && Number(points[1]) > 0,
  `health detail reports non-zero point count -> ${points?.[1] ?? "none found"}`
);

// AC4 — /healthz alias, always 200.
const healthz = await j("GET", "/healthz");
ok(healthz.status === 200, `healthz -> ${healthz.status}`);

// AC2 — remember a tagged marker into the scratch (personal) scope.
//
// The marker text needs real semantic separation from earlier probe runs, not
// just a different numeric suffix: nomic-embed-text barely weights digit
// tokens, so two notes sharing the same boilerplate ("e2e round-trip probe
// marker <id>") land within ~0.001 cosine similarity of each other — close
// enough that ranking against a growing pile of the probe's own history (this
// is additive-only; nothing ever gets deleted from Qdrant) flips at random.
// A few random words woven into varied phrasing pushes same-run similarity to
// ~0.94 while prior runs stay ~0.73, which is what makes "top hit" reliable
// run over run.
const WORDS = ["nimbus", "falcon", "orchard", "quartz", "ember", "cobalt", "lichen", "tundra", "basalt", "harbor"];
const pick = () => WORDS[Math.floor(Math.random() * WORDS.length)];
const token = `MNEMO-E2E-${Date.now()}`;
const markerText =
  `Mnemosyne e2e probe checkpoint :: ${pick()}-${pick()}-${pick()} :: correlation id ${token} :: ` +
  "verifying semantic round-trip provenance for the memory god liveness probe.";
const remember = await j("POST", "/remember", {
  text: markerText,
  scope: "personal",
  tag: "e2e-scratch",
});
ok(
  remember.status === 200 && remember.body.remembered === true,
  `remember -> ${remember.body.collection} (${remember.body.chunks_upserted} chunks)`
);

// Give the async embed/upsert a beat to land before recalling it back.
await new Promise((r) => setTimeout(r, 1500));

// AC3 — recall it back as the TOP hit, with provenance (location + score).
// Query with the marker's own text (not the bare token) — semantic recall
// ranks by embedding similarity, and a near-identical query is what reliably
// surfaces a single fresh note above the rest of the personal collection.
const recall = await j("POST", "/recall", { query: markerText, scope: "personal", hits: 3 });
const topHit = recall.body.scopes?.[0]?.hits?.[0];
ok(
  recall.status === 200 && !!topHit && topHit.text.includes(token),
  `recall -> top hit is the remembered marker (score=${topHit?.score})`
);
ok(
  !!topHit?.provenance?.full_path && typeof topHit?.score === "number",
  `recall top hit carries provenance -> location=${topHit?.provenance?.full_path} score=${topHit?.score}`
);

// Cleanup — remove the local scratch note file this run wrote.
if (remember.body.file) {
  try {
    await unlink(remember.body.file);
    ok(true, `cleaned up scratch note file -> ${remember.body.file}`);
  } catch (e) {
    ok(false, `failed to clean up scratch note file -> ${e.message}`);
  }
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall e2e checks passed");
process.exit(fails ? 1 : 0);
