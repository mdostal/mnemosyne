import { describe, expect, it } from 'vitest';
import { LayerRegistry, defaultRegistry } from '../registry.js';

describe('LayerRegistry', () => {
  it('creates a layer from a registered factory', () => {
    const registry = new LayerRegistry();
    registry.register('fake', () => ({ layer: 'file', recall: async () => ({ ok: true, query: '', scope: 'project', intent: 'narrow', hits: [], layers_queried: [], layers_skipped: [], escalated: false, degraded: false }) }));

    const adapter = registry.create('fake');
    expect(adapter.layer).toBe('file');
  });

  it('passes options and context through to the factory', () => {
    const registry = new LayerRegistry();
    let seenOptions: unknown;
    let seenCtx: unknown;
    registry.register('fake', (options, ctx) => {
      seenOptions = options;
      seenCtx = ctx;
      return { layer: 'file', recall: async () => ({ ok: true, query: '', scope: 'project', intent: 'narrow', hits: [], layers_queried: [], layers_skipped: [], escalated: false, degraded: false }) };
    });

    registry.create('fake', { foo: 'bar' }, { rootDirectory: '/tmp/x' });

    expect(seenOptions).toEqual({ foo: 'bar' });
    expect(seenCtx).toEqual({ rootDirectory: '/tmp/x' });
  });

  it('throws a clear error for an unregistered layer name — never a silent no-op', () => {
    const registry = new LayerRegistry();
    expect(() => registry.create('does-not-exist')).toThrow(/unknown layer 'does-not-exist'/);
  });

  it('has() reports registration status', () => {
    const registry = new LayerRegistry();
    expect(registry.has('fake')).toBe(false);
    registry.register('fake', () => ({ layer: 'file', recall: async () => ({ ok: true, query: '', scope: 'project', intent: 'narrow', hits: [], layers_queried: [], layers_skipped: [], escalated: false, degraded: false }) }));
    expect(registry.has('fake')).toBe(true);
  });

  it('defaultRegistry() has the three built-in layers pre-registered', () => {
    const registry = defaultRegistry();
    expect(registry.has('code-graph')).toBe(true);
    expect(registry.has('vector')).toBe(true);
    expect(registry.has('file')).toBe(true);
  });

  it('defaultRegistry() also has "graphify" (la-02) registered alongside "code-graph", not replacing it', () => {
    const registry = defaultRegistry();
    expect(registry.has('graphify')).toBe(true);
    expect(registry.has('code-graph')).toBe(true);
  });

  it('creates a real GraphifyLayerAdapter from the registry, resolvable purely by name (no client.ts changes needed)', () => {
    const registry = defaultRegistry();
    // command: process.execPath -- always resolvable on PATH, so this
    // assertion doesn't depend on the real `graphify` CLI being installed
    // in whatever environment runs this test (see GraphifyLayerAdapter's
    // constructor-time loud-failure check on the binary).
    const adapter = registry.create('graphify', { command: process.execPath }, { rootDirectory: '/tmp' });
    expect(adapter.layer).toBe('graphify');
  });

  it('defaultRegistry() is a stable singleton across calls', () => {
    expect(defaultRegistry()).toBe(defaultRegistry());
  });

  it('defaultRegistry() also has "crossref-linker" (cr-02) registered', () => {
    const registry = defaultRegistry();
    expect(registry.has('crossref-linker')).toBe(true);
  });

  it('creates a real CrossRepoLinkerAdapter from the registry, resolvable purely by name', () => {
    const registry = defaultRegistry();
    // /tmp and process.cwd() are always real directories -- 2 real repo
    // roots, satisfying CrossRepoLinkerAdapter's own construction-time
    // loud-failure checks without depending on any external fixture.
    const adapter = registry.create('crossref-linker', { repos: ['/tmp', process.cwd()] });
    expect(adapter.layer).toBe('crossref-linker');
  });

  it('"crossref-linker" being registered has zero effect on the unconfigured default layer stack', async () => {
    const { DEFAULT_LAYER_STACK_CONFIG } = await import('../config.js');
    // cr-01-graphify-default-layer: the unconfigured default's first entry
    // is 'graphify' now (was 'code-graph') -- see config.ts's doc comment.
    // This test's actual point (registering a new, unrelated layer name
    // has zero effect on the hardcoded default) is unaffected by that
    // change, so only the asserted layer name itself needs updating.
    expect(DEFAULT_LAYER_STACK_CONFIG.layers.map((l) => l.name)).toEqual(['graphify', 'vector', 'file']);
    expect(DEFAULT_LAYER_STACK_CONFIG.layers.map((l) => l.name)).not.toContain('crossref-linker');
  });
});
