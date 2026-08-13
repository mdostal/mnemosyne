/**
 * LayerStackConfig — which layers a MnemosyneClient builds, in what order,
 * and with what per-layer options. Resolution priority (first match wins):
 *
 *   1. Explicit config passed to resolveLayerStackConfig() (mirrors
 *      MnemosyneClientOptions.layerStack — programmatic/test use).
 *   2. MNEMOSYNE_LAYERS env var — a JSON string of the same shape.
 *   3. mnemosyne.layers.json at the given root (defaults to process.cwd()).
 *   4. The hardcoded default: exactly today's behavior, unconfigured —
 *      code-graph, vector, file, in that order. An unconfigured install must
 *      be byte-for-byte behaviorally identical to before this story.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface LayerStackEntry {
  name: string;
  options?: Record<string, unknown>;
}

export interface LayerStackConfig {
  layers: LayerStackEntry[];
}

export const DEFAULT_LAYER_STACK_CONFIG: LayerStackConfig = {
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
      return DEFAULT_LAYER_STACK_CONFIG;
    }
    throw error;
  }
}
