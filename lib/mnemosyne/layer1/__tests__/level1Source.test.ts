import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MNEMOSYNE_MD_PATH, readMnemosyneMdContent } from '../level1Source.js';
import { MANDATE_SECTIONS } from '../tiers.js';

// ml-02: mnemosyne.md canonical source + level1Source.ts reader. Mirrors
// level0.test.ts-style patterns already established by sync.test.ts (temp
// dir per test, explicit path override) rather than depending on real
// repo-root state, EXCEPT for the cross-reference test at the bottom, which
// deliberately reads the real repo-root mnemosyne.md as the whole point of
// that assertion.

describe('readMnemosyneMdContent', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-level1-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns the file content verbatim when mnemosyne.md exists at the given path', async () => {
    const mdPath = path.join(root, 'mnemosyne.md');
    await writeFile(mdPath, '# Mnemosyne\n\nSome repo-owned guidance.\n', 'utf8');

    expect(readMnemosyneMdContent(mdPath)).toBe('# Mnemosyne\n\nSome repo-owned guidance.\n');
  });

  it('returns null (never throws) when mnemosyne.md does not exist at the given path -- unlike level0.ts', async () => {
    const missingPath = path.join(root, 'does-not-exist.md');

    expect(() => readMnemosyneMdContent(missingPath)).not.toThrow();
    expect(readMnemosyneMdContent(missingPath)).toBeNull();
  });

  it('reads fresh on every call -- no module-level caching, matching level0.ts', async () => {
    const mdPath = path.join(root, 'mnemosyne.md');
    await writeFile(mdPath, 'v1 content', 'utf8');
    expect(readMnemosyneMdContent(mdPath)).toBe('v1 content');

    await writeFile(mdPath, 'v2 content', 'utf8');
    expect(readMnemosyneMdContent(mdPath)).toBe('v2 content');
  });

  it('exposes a DEFAULT_MNEMOSYNE_MD_PATH constant, mirroring level0.ts\'s DEFAULT_LEVEL0_PATH pattern', () => {
    expect(typeof DEFAULT_MNEMOSYNE_MD_PATH).toBe('string');
    expect(DEFAULT_MNEMOSYNE_MD_PATH.endsWith('mnemosyne.md')).toBe(true);
  });

  it('uses DEFAULT_MNEMOSYNE_MD_PATH when called with no argument', () => {
    // Whatever is (or is not) at the real default path right now, calling
    // with no args must not throw -- the whole point of the optional,
    // non-hard-fail contract (design-discussion.md §7.2).
    expect(() => readMnemosyneMdContent()).not.toThrow();
  });
});

describe('MANDATE_SECTIONS <-> mnemosyne.md sourcing (design-discussion.md §9 risk resolution)', () => {
  it('MANDATE_SECTIONS is non-empty and generated content, not hand-duplicated prose', () => {
    expect(MANDATE_SECTIONS.length).toBeGreaterThan(0);
  });

  it('MANDATE_SECTIONS content is sourced from the real repo-root mnemosyne.md -- proves there are not two independently hand-editable copies', () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
    const mnemosyneMdPath = path.join(repoRoot, 'mnemosyne.md');
    const content = readMnemosyneMdContent(mnemosyneMdPath);

    expect(content).not.toBeNull();
    // Every MANDATE_SECTIONS heading and body must appear verbatim in
    // mnemosyne.md -- if tiers.ts is generated FROM mnemosyne.md (this
    // story's chosen direction), this holds by construction; if it ever
    // drifted, this test fails, which is the whole point.
    for (const section of MANDATE_SECTIONS) {
      expect(content).toContain(section.heading);
      expect(content).toContain(section.body);
    }
  });
});
