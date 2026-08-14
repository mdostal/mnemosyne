import { describe, expect, it } from 'vitest';
import { BLOCK_END, BLOCK_START, extractManagedBlockBody, spliceManagedBlock } from '../block.js';

describe('managed block splicing', () => {
  it('creates a new file body wrapped in start/end markers when there is no existing content', () => {
    const result = spliceManagedBlock(null, 'hello world');
    expect(result).toContain(BLOCK_START);
    expect(result).toContain(BLOCK_END);
    expect(result).toContain('hello world');
    expect(result.indexOf(BLOCK_START)).toBeLessThan(result.indexOf('hello world'));
    expect(result.indexOf('hello world')).toBeLessThan(result.indexOf(BLOCK_END));
  });

  it('appends the managed block to existing human-authored content that has no prior block', () => {
    const human = '# My Project\n\nSome human-authored notes here.\n';
    const result = spliceManagedBlock(human, 'managed content v1');
    expect(result).toContain('# My Project');
    expect(result).toContain('Some human-authored notes here.');
    expect(result).toContain('managed content v1');
    // Human content must come before the managed block, and must survive intact.
    expect(result.indexOf('Some human-authored notes here.')).toBeLessThan(result.indexOf(BLOCK_START));
  });

  it('replaces only the content between existing markers on a second run, leaving human content untouched', () => {
    const human = '# My Project\n\nSome human-authored notes here.\n';
    const first = spliceManagedBlock(human, 'managed content v1');
    const second = spliceManagedBlock(first, 'managed content v2');

    expect(second).toContain('# My Project');
    expect(second).toContain('Some human-authored notes here.');
    expect(second).toContain('managed content v2');
    expect(second).not.toContain('managed content v1');

    // Exactly one begin/end marker pair -- no duplication.
    expect(second.split(BLOCK_START)).toHaveLength(2);
    expect(second.split(BLOCK_END)).toHaveLength(2);
  });

  it('preserves human content added AFTER the managed block on re-sync too', () => {
    const human = '# My Project\n';
    const first = spliceManagedBlock(human, 'managed content v1');
    const withTrailer = `${first}\n## Human section added later\n\nMore notes.\n`;
    const second = spliceManagedBlock(withTrailer, 'managed content v2');

    expect(second).toContain('## Human section added later');
    expect(second).toContain('More notes.');
    expect(second).toContain('managed content v2');
    expect(second).not.toContain('managed content v1');
  });

  it('re-running with identical content is idempotent (stable output)', () => {
    const human = '# My Project\n';
    const first = spliceManagedBlock(human, 'stable content');
    const second = spliceManagedBlock(first, 'stable content');
    expect(second).toEqual(first);
  });

  it('extractManagedBlockBody returns null when no block is present', () => {
    expect(extractManagedBlockBody('# Just a human file\n')).toBeNull();
  });

  it('extractManagedBlockBody round-trips the body written by spliceManagedBlock', () => {
    const written = spliceManagedBlock(null, 'round trip body');
    expect(extractManagedBlockBody(written)).toContain('round trip body');
  });
});
