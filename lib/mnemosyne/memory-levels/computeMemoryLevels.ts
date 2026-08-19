/**
 * ro-01-memory-levels-scoped-extraction (epic: mnemosyne-repo-onboarding).
 *
 * Extracts `GET /memory-levels`'s per-level `configured`/`activeInCascade`
 * computation (`server.ts`, ml-04-memory-levels-route) into a standalone,
 * repo-scoped function so it can be called against an ARBITRARY repo, not
 * only the running http-api service's own ambient `MnemosyneClient`
 * singleton (scoped to its own `ROOT_DIRECTORY`). This is the "get the base
 * level" primitive `ro-02`'s onboarding orchestrator depends on.
 *
 * Copy-then-parameterize, never a rewrite (design_decisions,
 * ro-01-memory-levels-scoped-extraction.yaml): the computation below is
 * behavior-identical to the route handler it was extracted from —
 * `server.ts`'s `GET /memory-levels` is now a thin caller of this function
 * with its own existing client + `ROOT_DIRECTORY`, byte-identical output to
 * before this extraction.
 *
 * `level0Path` stays a parameter with `DEFAULT_LEVEL0_PATH` as its default,
 * not hardcoded — level 0 is operator-global by design (`layer1/level0.ts`)
 * and every caller (this route and a future onboarding orchestrator alike)
 * should share the same default while still being test-overridable,
 * mirroring `level0.ts`'s own `SyncOptions.level0Path` convention.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { MnemosyneClient } from '../client.js';
import { DEFAULT_LEVEL0_PATH } from '../layer1/level0.js';
import { MEMORY_LEVELS } from './levels.js';

/** One computed memory-level entry — `GET /memory-levels`'s per-level response shape. */
export interface ComputedMemoryLevel {
  id: number;
  label: string;
  storeType: string;
  configured: boolean;
  sourceRef: string;
  /** Only present for levels 2-4 (the levels that participate in a recall() cascade). */
  activeInCascade?: boolean;
}

/**
 * Computes, for each of the 5 canonical memory levels (`MEMORY_LEVELS`),
 * whether it is configured right now for `repoRoot`:
 *
 *   - levels 0/1: a real `existsSync` check against that level's real source
 *     file on disk — level 0 against `level0Path` (operator-global, NOT
 *     scoped to `repoRoot`); level 1 against
 *     `path.join(repoRoot, 'mnemosyne.md')`.
 *   - levels 2-4: is at least one of that level's mapped adapter names
 *     (`levels.ts`'s own `adapterNames`) present in `client`'s ALREADY-
 *     resolved `getConfiguredLayers()` cascade — a READ of that
 *     already-computed output only, never a second, independent
 *     layer-resolution call.
 *
 * `client` must already be constructed scoped to `repoRoot` (e.g.
 * `new MnemosyneClient({ rootDirectory: repoRoot })`, the same constructor
 * option every other consumer of this class already uses) — this function
 * never constructs a client of its own.
 */
export function computeMemoryLevels(
  client: MnemosyneClient,
  repoRoot: string,
  level0Path: string = DEFAULT_LEVEL0_PATH,
): ComputedMemoryLevel[] {
  const activeAdapterNames = new Set<string>(client.getConfiguredLayers().map((l) => l.layer));
  const level0Configured = existsSync(level0Path);
  const level1Configured = existsSync(path.join(repoRoot, 'mnemosyne.md'));

  return MEMORY_LEVELS.map((level) => {
    // levels 0/1: real on-disk existence. levels 2-4: real presence in the
    // already-resolved cascade -- both are "is this level configured right
    // now", just checked two different ways depending on whether the level
    // participates in a recall() cascade at all.
    const configured =
      level.id === 0
        ? level0Configured
        : level.id === 1
          ? level1Configured
          : level.adapterNames.some((name) => activeAdapterNames.has(name));
    const entry: ComputedMemoryLevel = {
      id: level.id,
      label: level.label,
      storeType: level.storeType,
      configured,
      sourceRef: level.sourceRef,
    };
    if (level.id >= 2) {
      // Same underlying value as `configured` for these levels -- exposed
      // under its own, self-documenting name because "active in the
      // resolved cascade" is exactly what it measures for a
      // cascade-participating level.
      entry.activeInCascade = configured;
    }
    return entry;
  });
}
