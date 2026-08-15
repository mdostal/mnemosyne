/**
 * LayerStackConfig — which layers a MnemosyneClient builds, in what order,
 * and with what per-layer options. Resolution priority (first match wins):
 *
 *   1. Explicit config passed to resolveLayerStackConfig() (mirrors
 *      MnemosyneClientOptions.layerStack — programmatic/test use).
 *   2. MNEMOSYNE_LAYERS env var — a JSON string of the same shape.
 *   3. mnemosyne.layers.json at the given root (defaults to process.cwd()).
 *   4. The hardcoded default, SOFT-resolved (cr-01-graphify-default-layer):
 *      graphify, vector, file, in that order, when the `graphify` binary
 *      is actually resolvable on PATH; otherwise FALLBACK_LAYER_STACK_CONFIG
 *      (code-graph, vector, file — the old default) with a loud
 *      console.warn(), never a hard failure. See "cr-01" doc block below for
 *      why the default changed and why the fallback exists.
 *
 * cr-01-graphify-default-layer (epic: mnemosyne-crossrepo-defaults):
 * DEFAULT_LAYER_STACK_CONFIG's first entry used to be 'code-graph', and this
 * module's doc comment used to claim an unconfigured install must be
 * "byte-for-byte behaviorally identical to before" pl-01's registry
 * refactor — that promise was correct and scoped to pl-01's OWN change (a
 * pure mechanical extraction, not a behavior change), not a permanent
 * constraint on all future stories. la-10's real A/B benchmark against THIS
 * repo (docs/layer-architecture-v2-plan.md §7) found code-graph's backing
 * store (~/.local/share/swarm-memory/graph.sqlite) had ZERO nodes from this
 * repo — 22 nodes total, all from two unrelated repos, because
 * CodeGraphLayerAdapter has no per-repo scoping at all — while graphify
 * indexed 1470 real nodes / 2484 links from this repo's own source, at 33%
 * lower average latency and never a worse hit count on any benchmarked
 * query. That is the reason to break the old default now: 'code-graph' was
 * never actually going to return anything relevant to THIS repo, no matter
 * what was asked.
 *
 * The soft fallback below is NOT part of la-10's story — it's this story's
 * own addition, required to keep the acceptance criterion "all existing
 * pl-01 registry/config tests still pass" true in an environment without
 * graphify installed. `graphify` requires an external binary
 * (`uv tool install graphifyy`) that a bare Mnemosyne install does not have
 * by default, and this repo's own CI does not install it (see
 * .github/workflows/ci.yml — Node-only setup) — GraphifyLayerAdapter's
 * constructor throws a loud, synchronous error the moment the binary isn't
 * on PATH (by design — see that file), and MnemosyneClient's constructor
 * builds every configured layer eagerly. Without a soft fallback here, an
 * unconfigured `new MnemosyneClient()` — e.g. the one every existing
 * pl-01 test constructs, and the one `lib/mnemosyne/server.ts`'s GET
 * /layers route builds on every request — would start hard-failing in any
 * environment lacking the graphify binary, which directly contradicts the
 * epic's own critical constraint (never compromise pluggability / never
 * hard-require an external binary for an unconfigured, bare install) and
 * the epic's explicit framing of `uv tool install graphifyy` as
 * "recommended, not required" (see SERVICE.md/README.md). This mirrors
 * bin/graphify-bridge.mjs's isGraphifyConfigured() soft-default on the JS
 * zero-dep server side (same story, same reasoning, independently
 * implemented since the two sides don't share code).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isCommandOnPath } from './GraphifyLayerAdapter.js';

export interface LayerStackEntry {
  name: string;
  options?: Record<string, unknown>;
}

export interface LayerStackConfig {
  layers: LayerStackEntry[];
}

export const DEFAULT_LAYER_STACK_CONFIG: LayerStackConfig = {
  layers: [{ name: 'graphify' }, { name: 'vector' }, { name: 'file' }],
};

// Soft-default fallback (cr-01-graphify-default-layer): used ONLY when
// nothing is configured whatsoever AND the `graphify` binary isn't
// resolvable on PATH -- the old default, byte-for-byte, so a bare install
// (or CI, which doesn't install graphify) keeps working exactly as it did
// before this story.
const FALLBACK_LAYER_STACK_CONFIG: LayerStackConfig = {
  layers: [{ name: 'code-graph' }, { name: 'vector' }, { name: 'file' }],
};

function isLayerStackConfig(value: unknown): value is LayerStackConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { layers?: unknown }).layers) &&
    (value as LayerStackConfig).layers.every(
      (entry) => typeof entry === 'object' && entry !== null && typeof entry.name === 'string',
    )
  );
}

export interface ResolveLayerStackConfigOptions {
  explicit?: LayerStackConfig | undefined;
  env?: Record<string, string | undefined>;
  root?: string;
}

/**
 * Resolves the truly-unconfigured (no explicit, no MNEMOSYNE_LAYERS, no
 * mnemosyne.layers.json) default: DEFAULT_LAYER_STACK_CONFIG (graphify
 * first) when the `graphify` binary is resolvable on PATH, else
 * FALLBACK_LAYER_STACK_CONFIG (code-graph first) with a loud
 * console.warn(). Only called from the two "nothing configured" exit
 * points below — never for an explicit/env/file config, which is exactly
 * the pluggability guarantee: a consumer's own configuration is always
 * authoritative and never second-guessed against graphify's availability.
 */
function resolveUnconfiguredDefault(env: Record<string, string | undefined>): LayerStackConfig {
  const command = env.GRAPHIFY_BIN || 'graphify';
  if (isCommandOnPath(command, env.PATH)) {
    return DEFAULT_LAYER_STACK_CONFIG;
  }
  // eslint-disable-next-line no-console
  console.warn(
    `[mnemosyne] WARNING: graphify is not installed or not found on PATH (command: "${command}") -- ` +
      "falling back to the code-graph layer for the unconfigured default. Install graphify for " +
      'repo-scoped graph data: uv tool install graphifyy -- see https://github.com/Graphify-Labs/graphify',
  );
  return FALLBACK_LAYER_STACK_CONFIG;
}

export function resolveLayerStackConfig(options: ResolveLayerStackConfigOptions = {}): LayerStackConfig {
  if (options.explicit) {
    return options.explicit;
  }

  const env = options.env ?? process.env;
  const envValue = env.MNEMOSYNE_LAYERS;
  if (envValue && envValue.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(envValue);
    } catch (error) {
      throw new Error(
        `MNEMOSYNE_LAYERS is set but is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isLayerStackConfig(parsed)) {
      throw new Error(
        'MNEMOSYNE_LAYERS is set but does not match { layers: [{ name: string, options?: object }, ...] }',
      );
    }
    return parsed;
  }

  const root = options.root ?? process.cwd();
  const filePath = path.join(root, 'mnemosyne.layers.json');
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isLayerStackConfig(parsed)) {
      throw new Error(`${filePath} does not match { layers: [{ name: string, options?: object }, ...] }`);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return resolveUnconfiguredDefault(env);
    }
    throw error;
  }
}
