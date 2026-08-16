# Research Brief — mnemosyne-persona-wizard (Epic 2 of 2)

All research done on `dev` (`082c659`, where Epic 1's v0.6.0/v0.7.0 actually lives).

## 1. Persona data model — exact

```ts
// lib/mnemosyne/layer1/persona.ts
export const PERSONA_STORE_BY_TIER: Record<Tier, 'global' | 'repo-local'> = {
  'top-orchestrator': 'global', 'company-director': 'global',
  'project-orchestrator': 'global', 'code-architect': 'repo-local',
};
export interface Persona {
  tier: Tier; scopeId: string; displayName: string; scope: string;
  sections: TierContentSection[];
  parentRefs?: { tier: Tier; scopeId: string }[]; // query-up pointers, global tiers only
}
```

`mandateSections` is never part of `Persona` — `assertValidPersona` throws on mere presence of the key. `getPersonaContent(tier, scopeId, ctx)` is the sole content-resolution entry point: global tiers → `persona-store-global.ts` (`~/.mnemosyne/personas/<tier>/<scopeId>.yaml`); `code-architect` → `persona-store-repo-local.ts` (`<repoRoot>/.mnemosyne/personas/<scopeId>.yaml`, git-committed). Missing persona → falls back to hardcoded `TIER_CONTENT[tier]` with a `console.warn`. A `code-architect` persona's `parentRefs` render as a pointer-only "Parent context (query up)" section — never the parent's real content. Both stores read fresh off disk (no caching), guard writes with `lock.ts`'s advisory lock, and validate via `assertValidPersona` before ever touching disk.

**No `listGlobalPersonas`/`listRepoLocalPersonas` enumeration function exists in either store.** A caller must already know the `(tier, scopeId)` pair.

CLI (`bin/mnemosyne-persona.mjs`, tsx-launched): `sync --repo <path> --tier <tier> --scope-id <id> [--dry-run]`, `seed [--root <path>] [--scope-id <id>]`, `show <tier> <scope-id>`. `sync`'s `--repo` is always the harness-file write target; only the content source for `code-architect`. `--dry-run` is provably zero-write. `show` is read-only, global tiers only, renders the raw persona record (no mandate, no parent-context pointers — that's harness-sync-time rendering only).

**Implication for this epic:** the wizard's write target is `writeGlobalPersona`/`writeRepoLocalPersona` — both real, tested, already validate/lock/reject-mandate. `parentRefs` needs no schema change. A "view existing personas" UI needs either a new enumeration primitive or to be built without one (e.g. requiring the operator to know what to look for).

## 2. MCP / skill-harness surface (v0.7.0) — the write-tool gap, confirmed precisely

Three tools/actions exist end-to-end (MCP `persona_sync`/`persona_seed`/`persona_show`; skill-harness `persona-sync`/`persona-seed`/`persona-show`; CLI `sync`/`seed`/`show`) — **all read or sync, none create/write new persona content**. `writeGlobalPersona`/`writeRepoLocalPersona` have zero CLI/MCP/skill-harness wrapper anywhere. This exactly matches design-discussion.md §5 of Epic 1: *"Out of this epic: persona-content write route... (all Epic 2)."*

**Implication:** a wizard's output has no existing write surface to call through any transport layer today — this epic must build one (a new MCP tool / skill action / CLI verb, or a UI-driven HTTP route), not just wire into something already there.

## 3. Standalone UI — exact panel/route conventions

`ui/index.html`: 6 `<section class="panel[ panel-wide]" id="...">` blocks (Liveliness, Settings, Lanes, Search, Graph, Operations), each with `<h2>` + `<p class="panel-status" id="<panel>-status">`. `ui/app.js` (zero-dep vanilla fetch+DOM): one `load<Panel>()` function per panel, `refreshAll()` runs all of them via `Promise.all`, no auto-polling. `ui/style.css`: dark-only CSS custom properties, consistent `.panel`/table/button/monospace conventions.

`src/server.mjs`'s route table has **no `/persona/*` route at all** — confirmed directly (grepped every `route ===` match). Persona operations are CLI/MCP/skill-harness only, exactly as Epic 1 documented.

**Implication:** a new "Personas" UI panel needs new HTTP routes (`GET/POST /persona/*`, mirroring how `/graph/*` wraps `graph*Action`) wrapping `writeGlobalPersona`/`writeRepoLocalPersona`/`readGlobalPersona`/`readRepoLocalPersona` — a real, structural gap, not a detail — plus (per §1) a new listing primitive if the panel is meant to show "existing personas" rather than requiring the operator to already know what to look up.

## 4. `remember()` write paths — scope-vocabulary mismatch reconfirmed

`src/engine.mjs remember(text, scope, opts)`: `scope` is a free-form lane name (must match a configured collection). `lib/mnemosyne/client.ts MnemosyneClient.remember(content, scope, layer?)`: `Scope = 'project'|'enterprise'|'meta'`, a closed type union. **Neither vocabulary maps onto persona `{tier, scopeId}` today.**

**Implication:** an "initial crawl and feeding" step calling `remember()` needs the wizard's own design to decide how a persona's `{tier, scopeId}` maps to a `remember()` scope — this association doesn't pre-exist.

## 5. Multi-turn interview pattern — none in this repo, but a real precedent exists in plugin-hive

This repo has no interview/conversational pattern anywhere (`skills/mnemosyne-standalone/SKILL.md` is stateless, table-driven, one action per call). But the externally-installed `plugin-hive` marketplace plugin this repo's own Hive workflow already depends on (`.pHive/`, `hive.config.yaml`) has a directly comparable, already-battle-tested pattern: **`kickoff-protocol.md`'s "Phase 3b: Discovery Questions"** — 4 core questions + 2 optional follow-ups, each individually skippable, adaptive skip rules (don't re-ask what's already known), explicit persistence rules for skipped fields, a non-blocking hard-fail rule, and a documented structured-output schema (`.pHive/project-profile.yaml`'s `north_star` block). This is plain agent-driven prompt sequencing (markdown instructions executed by whatever agent is reading the skill) — not a bespoke chat backend, not literal `AskUserQuestion` tool-forcing (that's `design`'s wireframe-protocol pattern instead, used for a different, options-driven flow).

**Implication:** design-discussion.md §3a of Epic 1 already called this "genuinely new territory" for *this codebase* — true — but it is not a novel pattern for the plugin-hive ecosystem this repo already leans on for its own planning. `kickoff-protocol.md` Phase 3b is a real, working reference shape to ground this epic's interview-skill design against, rather than inventing the mechanics from scratch.

## 6. `docs/layer-architecture-v2-plan.md` — no contradiction found

The "query up, never hold locally" principle (line 35) is already code-enforced by Epic 1's `pf-12` (`buildParentContextSections`, schema-restricted to global tiers, structurally unable to read parent content) and explicitly cross-referenced in `persona.ts`/`tiers.ts`'s own doc comments. Nothing in this epic's likely scope (an interview wizard authoring persona YAML + `remember()` writes; a UI showing existing personas and the layer stack) requires revisiting this — a UI panel showing a code-architect persona's `parentRefs` would naturally render the same pointer-only information `getPersonaContent` already produces.
