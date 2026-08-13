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

  it('defaultRegistry() is a stable singleton across calls', () => {
    expect(defaultRegistry()).toBe(defaultRegistry());
  });
});
