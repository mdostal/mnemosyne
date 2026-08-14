/**
 * LayerRegistry — the actual swap mechanism (pl-01-layer-registry).
 *
 * Maps a layer NAME to a FACTORY function that produces a `LayerAdapter`
 * instance. Registration is explicit (`register(name, factory)`), never
 * auto-discovered/globbed — traceable, testable, no import-order surprises.
 *
 * This is deliberately dumb: it does not know about config resolution
 * (see `config.ts`) or about MnemosyneClient's cascade semantics (see
 * `client.ts`). It only answers "given a name, build me that layer."
 */
import { CodeGraphLayerAdapter } from './CodeGraphLayerAdapter.js';
import { FileLayerAdapter } from './FileLayerAdapter.js';
import { GraphifyLayerAdapter } from './GraphifyLayerAdapter.js';
import type { LayerAdapter } from './LayerAdapter.js';
import { VectorLayerAdapter } from './VectorLayerAdapter.js';

export interface LayerFactoryContext {
  /** Passed through from MnemosyneClientOptions.rootDirectory — only the file layer uses it today. */
  rootDirectory?: string | undefined;
}

export type LayerFactory = (options: Record<string, unknown>, ctx: LayerFactoryContext) => LayerAdapter;

export class LayerRegistry {
  private readonly factories = new Map<string, LayerFactory>();

  register(name: string, factory: LayerFactory): void {
    this.factories.set(name, factory);
  }

  has(name: string): boolean {
    return this.factories.has(name);
  }

  /** @throws if `name` was never registered — unknown layer names fail loudly, never a silent no-op. */
  create(name: string, options: Record<string, unknown> = {}, ctx: LayerFactoryContext = {}): LayerAdapter {
    const factory = this.factories.get(name);
    if (!factory) {
      throw new Error(
        `unknown layer '${name}' — no factory registered. Known layers: ${[...this.factories.keys()].join(', ') || '(none)'}`,
      );
    }
    return factory(options, ctx);
  }
}

// A shared, module-level default registry pre-populated with the three
// built-in layers (matching today's MnemosyneClient defaults exactly) plus
// whatever else gets registered against it (e.g. pl-02's "hive-memory").
// Tests that want full isolation should construct their own `new
// LayerRegistry()` and pass it via `MnemosyneClientOptions.registry`.
let _defaultRegistry: LayerRegistry | null = null;

export function defaultRegistry(): LayerRegistry {
  if (!_defaultRegistry) {
    _defaultRegistry = new LayerRegistry();
    registerBuiltinLayers(_defaultRegistry);
  }
  return _defaultRegistry;
}

// Split out so tests/other consumers can populate a fresh LayerRegistry with
// the same built-ins without going through the module-level singleton.
// "hive-memory" (pl-02) registers itself into `defaultRegistry()` from its
// own module rather than being listed here, so this file has no dependency
// on it — HiveMemoryLayerAdapter.ts calls `defaultRegistry().register(...)`
// at import time (see that file's bottom).
export function registerBuiltinLayers(registry: LayerRegistry): void {
  registry.register('code-graph', () => new CodeGraphLayerAdapter());
  registry.register('vector', (options) => new VectorLayerAdapter(options as ConstructorParameters<typeof VectorLayerAdapter>[0]));
  registry.register('file', (_options, ctx) => new FileLayerAdapter(ctx.rootDirectory ?? process.cwd()));
  // "graphify" (la-02-graphify-adapter): a NEW layer name, registered
  // alongside "code-graph" rather than replacing it -- la-10 does the A/B
  // comparison before any retirement. rootDirectory flows through as
  // graphify's repoRoot (the directory it indexes) when the caller doesn't
  // override it via per-layer options.
  registry.register('graphify', (options, ctx) => {
    const adapterOptions = options as ConstructorParameters<typeof GraphifyLayerAdapter>[0];
    return new GraphifyLayerAdapter({
      ...adapterOptions,
      repoRoot: adapterOptions?.repoRoot ?? ctx.rootDirectory ?? process.cwd(),
    });
  });
}
