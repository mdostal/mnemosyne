/**
 * ro-02-onboard-repo-core-orchestrator (epic: mnemosyne-repo-onboarding).
 *
 * The one piece of genuinely new code both deployment modes share
 * (design-discussion.md §2.1, structured-outline.md §2.1): a
 * mode-parameterized (`'tree' | 'standalone'`) orchestrator that sequences
 * ALREADY-SHIPPED primitives into one repeatable "bring a repo online"
 * action --
 *
 *   1. Layer 1 sync         -- `syncAllHarnesses` (layer1/sync.ts, la-01).
 *   2. Persona seed         -- `writeRepoLocalPersona` (layer1/persona-
 *                               store-repo-local.ts, pf-01), only if no
 *                               persona already exists for this scopeId.
 *   3. First-time index     -- L4 via `writeFileStoreIndex`
 *                               (layers/FileStoreIndex.ts, ml-06/ml-08);
 *                               L2 (graphify) only when the `graphify`
 *                               binary is on PATH (config.ts's own
 *                               `isCommandOnPath` check, reused exactly).
 *   4. Base-level report     -- a scoped `MnemosyneClient({ rootDirectory:
 *                               repoRoot })` fed to ro-01's extracted
 *                               `computeMemoryLevels(client, repoRoot)`.
 *
 * Mode 'tree' additionally carries a vector-index sub-step (ro-07-onboard-
 * new-collection-full-mode-a): once a collection is confirmed to exist
 * (either freshly created via `--create`'s `create_collection_and_scope()`,
 * or pre-existing per `ro-05`'s own existing-collection path -- both
 * callers guarantee this by construction before ever invoking
 * `onboardRepo()` with `mode: 'tree'`), this calls the existing, unmodified
 * `POST /reindex {scope, directory}` contract (`src/server.mjs`,
 * SERVICE.md's "Two reindex paths") against a running Mnemosyne service,
 * `scope` set to this call's own `scopeId` -- the SAME per-repo scope key
 * `create_collection_and_scope()` maps to this repo's own collection
 * (design-discussion.md's "own scope" isolation: scope->collection mapping
 * keyed to this repo's own collection). `POST /reindex` itself is
 * asynchronous (`202 {status:'started',...}` immediately, the real index
 * continues in the background), so `{ ran: true }` here means the reindex
 * was successfully KICKED OFF against a real collection, not that indexing
 * has completed by the time `onboardRepo()` returns -- see
 * `runVectorIndexStep`'s own doc comment below. Mode 'standalone' never
 * attempts it. No other branching exists between the two modes -- every
 * other step above is byte-identical for both.
 *
 * Every sub-step records its own soft failure in its own result field
 * (`{ ran: false, reason }`) rather than throwing -- mirrors
 * `MnemosyneClient`'s own established recordDegradation/layers_skipped
 * convention (client.ts). The ONE exception is Level 0 (step 1's
 * prerequisite): `readLevel0Content` already throws loudly when Level 0 is
 * missing (layer1/level0.ts), and `syncAllHarnesses` lets that propagate --
 * `onboardRepo()` never wraps or swallows it. A half-onboarded repo without
 * Level 0 must never look like a successful run.
 *
 * Amendment (design-discussion.md §7.1, grill round 2 finding 2.5.1):
 * `resolveScopedLayerStack` resolves the layer stack for THIS repoRoot
 * specifically (reusing `layers/config.ts`'s own `resolveLayerStackConfig`,
 * rooted at `repoRoot` rather than `process.cwd()` -- `MnemosyneClient`'s
 * OWN internal default resolution is cwd-anchored, which would silently
 * ignore a repoRoot-local `mnemosyne.layers.json` were this orchestrator to
 * rely on it, defeating the whole point of a repoRoot-scoped onboarding
 * action). When the resolved stack includes `vector`, its per-layer
 * options get `notesDirectory: path.join(repoRoot, 'mnemosyne-notes')`
 * filled in (never overriding an operator-set `notesDirectory`) --
 * colocating the vector layer's note-staging directory under the same
 * `repoRoot` the file layer / persona store / file-index manifest already
 * use, instead of leaking to `VectorLayerAdapter`'s machine-global default
 * (`~/.local/share/mnemosyne/notes`). A repo whose resolved stack never
 * configures `vector` (e.g. Mode B's own default `docs/embedded-
 * layers.json`) sees zero behavior change from this amendment.
 *
 * Story: ro-02-onboard-repo-core-orchestrator (epic: mnemosyne-repo-onboarding).
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { MnemosyneClient } from '../client.js';
import { computeMemoryLevels, type ComputedMemoryLevel } from '../memory-levels/computeMemoryLevels.js';
import { syncAllHarnesses, type SyncResult } from '../layer1/sync.js';
import { repoLocalPersonaPath, writeRepoLocalPersona } from '../layer1/persona-store-repo-local.js';
import { TIER_CONTENT } from '../layer1/tiers.js';
import { writeFileStoreIndex } from '../layers/FileStoreIndex.js';
import { GraphifyLayerAdapter, isCommandOnPath } from '../layers/GraphifyLayerAdapter.js';
import { resolveLayerStackConfig, type LayerStackConfig, type LayerStackEntry } from '../layers/config.js';

export interface OnboardRepoOptions {
  mode: 'tree' | 'standalone';
  repoRoot: string;
  scopeId: string;
  /** Mode 'tree' only -- the swarm-memory collection this repo writes to. Drives the real vector-index sub-step (ro-07). */
  collection?: string;
  /** Skip the L2 graph build even if `graphify` is on PATH (mainly for tests). */
  skipGraph?: boolean;
}

export interface OnboardRepoResult {
  layer1Synced: SyncResult[];
  personaSeeded: { created: boolean; path: string };
  fileIndex: { files: number; areas: number };
  graphIndex: { ran: boolean; reason?: string };
  /** mode:'tree' only -- real once a collection is confirmed to exist (ro-07); mode 'standalone' is always `{ ran: false }`. */
  vectorIndex: { ran: boolean; reason?: string };
  baseLevel: ComputedMemoryLevel[];
}

/** `<repoRoot>/mnemosyne-notes` -- the colocated default this amendment fills in for a configured `vector` layer. */
function colocatedNotesDirectory(repoRoot: string): string {
  return path.join(repoRoot, 'mnemosyne-notes');
}

/**
 * Resolves the layer stack for `repoRoot` specifically (design-discussion.md
 * §7.1) -- reuses `resolveLayerStackConfig` (layers/config.ts) rooted at
 * `repoRoot`, never a re-implementation of its resolution priority
 * (explicit > MNEMOSYNE_LAYERS env > `<repoRoot>/mnemosyne.layers.json` >
 * hardcoded default). When the resolved stack names a `vector` layer, its
 * options get `notesDirectory` filled in with the repoRoot-colocated
 * default UNLESS the resolved config already set one explicitly (an
 * operator's own choice is never overridden). Every other entry, and the
 * whole stack when `vector` is absent, is returned exactly as resolved --
 * this is the single function `onboardRepo()` itself calls to build the
 * `layerStack` its scoped `MnemosyneClient` is constructed with, exported
 * so tests can inspect the exact per-layer options a real adapter would be
 * constructed from without re-deriving this resolution logic themselves
 * (mirrors `sync.ts`'s own `buildManagedBody` export rationale).
 */
export function resolveScopedLayerStack(repoRoot: string): LayerStackConfig {
  const resolved = resolveLayerStackConfig({ root: repoRoot });
  const vectorIndex = resolved.layers.findIndex((entry) => entry.name === 'vector');
  if (vectorIndex === -1) {
    return resolved;
  }

  const vectorEntry = resolved.layers[vectorIndex]!;
  const layers: LayerStackEntry[] = resolved.layers.map((entry, i) =>
    i === vectorIndex
      ? { ...vectorEntry, options: { notesDirectory: colocatedNotesDirectory(repoRoot), ...vectorEntry.options } }
      : entry,
  );
  return { layers };
}

/** The reason text recorded when `graphify` isn't resolvable on PATH -- mirrors config.ts's own soft-fallback reasoning (layers/config.ts's `resolveUnconfiguredDefault`), never a re-implementation of the PATH probe itself (`isCommandOnPath`, reused directly). */
function graphifyNotOnPathReason(command: string): string {
  return (
    `graphify is not installed or not found on PATH (command: "${command}") -- ` +
    'install graphify for repo-scoped graph data: uv tool install graphifyy -- ' +
    'see https://github.com/Graphify-Labs/graphify'
  );
}

/**
 * Builds a starter code-architect persona candidate from the hardcoded
 * `TIER_CONTENT['code-architect']` entry, minus `mandateSections` (never
 * author-storable -- persona.ts's `assertValidPersona`). Mirrors
 * `bin/mnemosyne-persona-seed.mjs`'s `tierContentToPersonaCandidate` shape
 * exactly, applied to the one tier that script deliberately never seeds
 * itself (the repo-local store is this epic's own onboarding concern, not
 * that global-tier seed script's).
 */
function starterPersonaCandidate(scopeId: string) {
  const content = TIER_CONTENT['code-architect'];
  return {
    tier: content.tier,
    scopeId,
    displayName: content.displayName,
    scope: content.scope,
    sections: content.sections,
  };
}

/**
 * L2 graph build sub-step. Never throws -- a missing/failing `graphify`
 * records `{ ran: false, reason }` rather than aborting onboarding.
 * Reuses `GraphifyLayerAdapter`'s own lazy-build behavior (its `recall()`
 * runs `graphify update <repoRoot>` on first call when `graph.json` doesn't
 * exist yet, `GraphifyLayerAdapter.ts`) instead of re-implementing the
 * `graphify update` shell-out itself.
 */
async function runGraphIndexStep(
  repoRoot: string,
  skipGraph: boolean | undefined,
): Promise<{ ran: boolean; reason?: string }> {
  if (skipGraph) {
    return { ran: false, reason: 'skipGraph option set' };
  }

  const command = process.env.GRAPHIFY_BIN || 'graphify';
  if (!isCommandOnPath(command)) {
    return { ran: false, reason: graphifyNotOnPathReason(command) };
  }

  try {
    const adapter = new GraphifyLayerAdapter({ repoRoot });
    const result = await adapter.recall('mnemosyne onboarding graph bootstrap');
    if (result.ok) {
      return { ran: true };
    }
    return { ran: false, reason: result.error.message };
  } catch (error) {
    return { ran: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Default Mnemosyne service base URL -- mirrors bin/mnemosyne-reindex.mjs's / hooks/lib/mnemo-client.mjs's own identical `$MNEMOSYNE_URL || http://127.0.0.1:8477` convention (read at CALL time, not module-load time, so tests can `vi.stubEnv` it per-test without a module reset). */
function mnemosyneServiceUrl(): string {
  return process.env.MNEMOSYNE_URL || 'http://127.0.0.1:8477';
}

/**
 * Real vector-index sub-step (ro-07-onboard-new-collection-full-mode-a):
 * mode 'tree' only, once a collection is confirmed to exist. Calls the
 * existing, unmodified `POST /reindex {scope, directory}` contract
 * (`src/server.mjs`, SERVICE.md's "Two reindex paths" -- the bulk/scope-wide
 * path, reused not reimplemented, exactly the way `bin/mnemosyne-
 * reindex.mjs`'s own CLI wrapper already calls it) against a running
 * Mnemosyne service. `scope` is `scopeId` -- see this module's own doc
 * comment for why that's the correct per-repo scope key to reuse here.
 *
 * `POST /reindex` itself is asynchronous (`202 {status:'started',...}`
 * immediately; the real index continues in the background and logs its own
 * outcome -- SERVICE.md) so a `{ ran: true }` result here means the reindex
 * was successfully KICKED OFF against a real collection, not that indexing
 * has completed by the time `onboardRepo()` returns. The actual first-time-
 * index proof (a subsequent `recall()` returning real hits with full
 * 7-field provenance) is this story's own separate, manual live-Qdrant
 * verification step -- never part of this synchronous return value.
 *
 * Never throws -- mirrors `runGraphIndexStep`'s own soft-failure convention
 * (`{ ran: false, reason }`), including when no Mnemosyne service is
 * reachable at all (e.g. this repo's own automated test suite, which never
 * runs a live server against real Qdrant -- see `onboardRepo.test.ts`'s own
 * local HTTP-stub convention).
 */
async function runVectorIndexStep(
  repoRoot: string,
  scopeId: string,
  collection: string | undefined,
): Promise<{ ran: boolean; reason?: string }> {
  if (!collection) {
    return { ran: false, reason: "mode 'tree' requires a collection to vector-index into" };
  }

  const baseUrl = mnemosyneServiceUrl();
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/reindex`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: scopeId, directory: repoRoot }),
    });
  } catch (error) {
    return {
      ran: false,
      reason: `could not reach Mnemosyne service at ${baseUrl} to start the vector index: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON body -- fall through to the generic status-based message below.
  }

  if (!res.ok) {
    const detail =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : JSON.stringify(body);
    return { ran: false, reason: `POST /reindex failed: ${res.status} ${detail}` };
  }

  return { ran: true };
}

/**
 * Sequences Layer 1 sync + persona seed + first-time index + base-level
 * report (plus mode 'tree''s real vector-index sub-step, ro-07) for
 * `repoRoot`. See this module's own doc comment for the full step-by-step
 * contract.
 */
export async function onboardRepo(options: OnboardRepoOptions): Promise<OnboardRepoResult> {
  const { mode, repoRoot, scopeId } = options;

  // 1. Layer 1 sync -- syncAllHarnesses lets readLevel0Content's own loud
  // failure (Level 0 missing) propagate uncaught. Never wrapped, never
  // swallowed: a half-onboarded repo without Level 0 must never look like
  // a successful run.
  const layer1Synced = syncAllHarnesses(repoRoot, 'code-architect', scopeId);

  // 2. Persona seed -- only if one doesn't already exist. Never overwrite
  // an operator-authored persona.
  const personaPath = repoLocalPersonaPath(repoRoot, scopeId);
  const personaAlreadyExisted = existsSync(personaPath);
  if (!personaAlreadyExisted) {
    writeRepoLocalPersona(repoRoot, starterPersonaCandidate(scopeId));
  }
  const personaSeeded = { created: !personaAlreadyExisted, path: personaPath };

  // 3a. First-time index -- L4, always, via the exact call path
  // bin/mnemosyne-file-index.mjs already uses.
  const { manifest } = await writeFileStoreIndex(repoRoot);
  const fileIndex = { files: manifest.files.length, areas: Object.keys(manifest.areas).length };

  // 3b. L2 graph build -- soft-gated on graphify's own PATH availability.
  const graphIndex = await runGraphIndexStep(repoRoot, options.skipGraph);

  // Mode 'tree' only: real vector-index sub-step (ro-07) once a collection
  // is confirmed to exist. Mode 'standalone' never attempts it -- this is
  // the ONLY branch point between the two modes.
  const vectorIndex: { ran: boolean; reason?: string } =
    mode === 'tree'
      ? await runVectorIndexStep(repoRoot, scopeId, options.collection)
      : { ran: false, reason: "mode 'standalone' never attempts vector indexing" };

  // 4. Base-level report -- a scoped client, fed to ro-01's extracted
  // computeMemoryLevels. §7.1 amendment: the layerStack this client is
  // built with is resolved specifically for repoRoot (not process.cwd()),
  // with vector's notesDirectory colocated under repoRoot when configured.
  const layerStack = resolveScopedLayerStack(repoRoot);
  const scopedClient = new MnemosyneClient({ rootDirectory: repoRoot, layerStack });
  const baseLevel = computeMemoryLevels(scopedClient, repoRoot);

  return { layer1Synced, personaSeeded, fileIndex, graphIndex, vectorIndex, baseLevel };
}
