# Research Brief — mnemosyne-persona-wizard

## 1. Layer 1 tier content (`lib/mnemosyne/layer1/`)

`TierContent` (`tiers.ts:38-54`):
```ts
export interface TierContentSection { heading: string; body: string; }
export interface TierContent {
  tier: Tier;                            // 'top-orchestrator'|'company-director'|'project-orchestrator'|'code-architect'
  displayName: string;
  scope: string;                         // one-line "what this tier is/isn't"
  sections: TierContentSection[];        // tier-specific content
  mandateSections: TierContentSection[]; // IDENTICAL across all tiers — la-07's universal lifecycle mandate
}
```
`TIER_CONTENT: Record<Tier, TierContent>` (`tiers.ts:116-189`) is a hardcoded literal object — the thing this epic needs to make authorable. `mandateSections` is not persona content; it's a shared, universal policy block and should stay out of whatever a wizard authors.

**Sync mechanism** (`sync.ts`): `syncHarnessFile(targetFilePath, tier, harnessId, options)` builds `level0Content.trim() + '\n\n---\n\n' + tierMarkdown.trim()` and writes it via `spliceManagedBlock`. `syncAllHarnesses(repoRoot, tier, options)` does this for all 3 harness files at once.

**Idempotency** (`block.ts`): HTML-comment markers `<!-- mnemosyne:layer1:begin ... -->` / `<!-- mnemosyne:layer1:end -->`. No file → block is the whole file. File with no markers → block appended, human content preserved. File with markers → only the block is replaced.

**Level 0 prepend** (`level0.ts` + `sync.ts:53-56`): `DEFAULT_LEVEL0_PATH = ~/.mnemosyne/level0-rules.md`, read fresh on every sync call (no caching), throws loudly if missing. Always placed first, verbatim, ahead of tier markdown, separated by `---`.

**No production entrypoint exists today.** `syncAllHarnesses`/`syncHarnessFile` are exercised only by `lib/mnemosyne/layer1/__tests__/sync.test.ts`. No CLI subcommand, no hook, no HTTP route triggers a real sync. Any wizard whose output must land in `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` needs this missing invocation surface built (CLI verb, hook, or UI-triggered server action).

**Extension point:** `getTierContent(tier)` and `TIER_CONTENT` are the only things `sync.ts` touches. Swapping the hardcoded object for a function reading from disk/DB (same `Record<Tier, TierContent>` shape) is a drop-in replacement — no changes needed to `sync.ts`, `block.ts`, or `level0.ts`.

## 2. Layer registry + config system (the "memory levels")

Registry (`registry.ts`): `LayerRegistry.register(name, factory)`. `defaultRegistry()` pre-populated with `code-graph`, `vector`, `file`, `graphify`, `crossref-linker`, `keyword` (`hive-memory` self-registers from its own module). `create()` throws loudly listing known layers on an unknown name.

`DEFAULT_LAYER_STACK_CONFIG` (`config.ts:68-70`): `{ layers: [{name:'graphify'},{name:'vector'},{name:'file'}] }`, with a soft PATH-dependent fallback to `code-graph` (never a hard failure) when nothing is explicitly configured.

`resolveLayerStackConfig` priority (`config.ts:122-161`): (1) `options.explicit`, (2) `MNEMOSYNE_LAYERS` env var (JSON string), (3) `mnemosyne.layers.json` at repo root, (4) hardcoded soft default.

Real shape:
```json
// mnemosyne.layers.json
{ "layers": [{ "name": "hive-memory" }, { "name": "file" }] }
```
`LayerStackEntry = { name: string; options?: Record<string, unknown> }` — per-layer options supported (e.g. `crossref-linker` needs `options.repos`).

**7 known layer names today**: `code-graph`, `vector`, `file`, `graphify`, `crossref-linker`, `keyword`, `hive-memory`. This maps directly onto what a "walk the memory levels" UI needs to visualize/select — but it is a genuinely separate config surface from Layer 1 tier content (layer stack = which recall/remember backends are active; Layer 1 = static text injected into harness files). The epic wants to unify these visually, but they are not the same data model today.

## 3. The `remember()` write path (for "initial crawl and feeding")

`src/engine.mjs remember(text, scope, opts)` (`engine.mjs:429`): `opts = {status?, sourceRef?, cwd?, defaultBranch?, tag?}`. `scope` defaults to `"personal"`, must map to a configured collection or throws 400. `status`/`sourceRef` must be provided together or both omitted (auto-detected via git context; throws loudly — a 422 — if unresolvable and neither given). Writes a timestamped `.md` note with a provenance header, then shells to `swarm-memory index <collection> --no-prune <file>`, requiring `chunks_upserted > 0` in stdout or throws 500.

`lib/mnemosyne/client.ts remember(content, scope, layer?)` (`client.ts:447`): `Scope = 'project'|'enterprise'|'meta'` — a **narrower, different vocabulary** than engine.mjs's free-string scope. `layer` defaults to `'vector'`. Resolves the adapter by name; fails soft (`{ok:false, error:{...,code:'layer_not_writable'}}`) rather than throwing. Notably, this call site only forwards `{scope}` to the adapter today — `status`/`sourceRef`/`cwd`/`defaultBranch` are declared on `RememberOptions` but not threaded through here.

**Implication:** a wizard doing initial indexing has two real entry points (`POST /remember` over HTTP, or `MnemosyneClient.remember()`), and they are not the same contract — scope vocabularies differ. Pick one path deliberately.

## 4. Current standalone UI

`ui/index.html` (203 lines): 6 `<section class="panel">` blocks (Liveliness, Settings, Lanes, Search, Graph, Operations), fixed DOM ids. `ui/app.js` (1165 lines): vanilla JS/DOM, zero framework, zero build step, explicitly no auto-polling. Pattern per panel: `getElementById` + one `async function loadX()` doing `fetch()` + direct DOM writes; two panels (Lanes, Operations) have write forms.

Endpoints: Liveliness→`GET /health`, Settings→`GET /config`, Lanes→`GET /scopes`+`POST /lanes`, Search→`GET /search`, Graph→`GET /graph/{stats,edges,impact/:node,deps/:node}`, Operations→`POST /index`, `POST /cache/refresh` (a `POST /reindex` route exists server-side with no UI panel wired to it).

**No wizard/chat pattern exists anywhere in this codebase.** `skills/mnemosyne-standalone/SKILL.md`, `bin/mnemosyne-skill-helper.mjs`, and `bin/mnemosyne-mcp.mjs` are all stateless one-shot pass-throughs to server routes — no multi-turn interview logic anywhere. An LLM-interview wizard is new UI infrastructure, not a reuse of an existing pattern.

## 5. Level 1 sync invocation gap

Confirmed via repo-wide grep: the only real invocation path for `syncAllHarnesses`/`syncHarnessFile` is the Vitest suite. No CLI verb (`bin/mnemosyne` supports only bare server-start and `reindex`), no hook, no HTTP route. This is a real, pre-existing gap independent of this epic, but this epic's wizard makes it load-bearing — persona content a human authors needs *something* to actually push it into a harness file.

## 6. Git-context / scoping detection

`detectGitContext({cwd})` (`flight-status.mjs:75-107`) resolves only `{branch, commit_sha, pr_url:null}` via `git rev-parse`. `detectDefaultBranchName` best-effort resolves `origin/HEAD`, falling back to `'main'`. `resolveDefaultStatus` is `branch === defaultBranch ? 'confirmed' : 'provisional'`.

**Gap: there is no repo-name or company-name detection anywhere in this codebase.** Zero hits for `company`/`repoName`/`repo_name` across `flight-status.mjs`, `engine.mjs`, `client.ts`. `SourceRef` (`interfaces.ts:341-355`) is `{branch, commit_sha, pr_url}` only — no repo field. "Which repo am I in" is implicit in `cwd`, never an explicit identifier. A persona system scoped to "company/project/repo" needs new identification logic — today's system identifies branch/commit only, nothing above the repo level.

## 7. Prior design decisions (do not contradict/duplicate)

`docs/layer-architecture-v2-plan.md` §0/§1 is the canonical prior design:
- Level 0's canonical source is deliberately outside `~/.claude/` so it applies across Claude Code/Codex/Gemini/etc, not just one harness.
- §1 already frames Layer 1 as "generate/sync the right content into each harness's native file per tier" — content-*generation* was always the stated intent; it was just never wired to a human-facing authoring flow. This epic is a natural continuation, not new direction.
- The 4-tier hierarchy and "query up, never assume locally" rule for cross-tier impact is settled — `tiers.ts`'s hardcoded content already mirrors it exactly.
- §1a (`la-09`): real, already-run experiments found Graphify's cross-repo graph merge produces **zero** cross-repo edges (confirmed twice) — explicitly rejected as a company-director data source; only the cheap `global-manifest.json` (repo tag/size/freshness) was judged adoptable. Any wizard-authored company-tier content must not silently reintroduce the rejected merged-graph approach as its default data source.
- No prior mention anywhere (`docs/layer-architecture-v2-plan.md`, `docs/architecture.md`) of making `TIERS`/`TIER_CONTENT` data-driven or of a persona/wizard concept — this is genuinely new scope, not a re-litigation.
