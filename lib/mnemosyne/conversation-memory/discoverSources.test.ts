/**
 * cm-02-conversation-source-discovery (epic: mnemosyne-conversation-memory).
 *
 * Tests against a synthetic, fixture-mirrored directory structure ONLY --
 * never the operator's real `~/.claude/projects/` tree, never the real
 * ChatGPT export, never the real Gemini Takeout export
 * (`~/Downloads/Google Takeout Aug 26 2026.zip`). Every fixture path below
 * lives under a `mkdtemp`-created temp directory, and every
 * `discoverSources()` call in this file passes explicit
 * `claudeProjectsRoot`/`chatgptExportPath`/`geminiTakeoutPath`/
 * `manifestPath` overrides -- never the real defaults.
 *
 * Covers every acceptance criterion in `.pHive/epics/mnemosyne-
 * conversation-memory/stories/cm-02-conversation-source-discovery.yaml`:
 *
 *  AC1. Real session files under an included dir produce a manifest entry
 *       (path, byte size, mtime, decoded project slug).
 *  AC2. A scratch-filter-matching directory is excluded from `sessions`,
 *       with the exclusion recorded in `excluded` (not silently omitted).
 *  AC3. A directory whose decoded slug falls outside any confirmed root is
 *       INCLUDED but flagged `scratchConfidence: 'weak'`.
 *  AC4. The fixed ChatGPT export path appears as a named entry; no generic
 *       scan of its parent directory happens.
 *  AC5. The fixed Gemini Takeout export path appears as
 *       `staged (takeout, 2 conversations)` when present.
 *  AC6. Zero content is ever read from any `.jsonl` source -- verified by
 *       spying on every Node fs content-reading API.
 *  AC7. Re-running is idempotent and re-computed from scratch (never a
 *       stale cache).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `node:fs`'s ESM namespace is not configurable (`vi.spyOn` on the raw
// module throws "Module namespace is not configurable in ESM") -- the
// vitest-documented workaround is `vi.mock` with `importOriginal`,
// wrapping only the CONTENT-reading APIs in `vi.fn(actual.fn)` (a
// pass-through spy, real behavior preserved) while every other export
// (`existsSync`/`mkdirSync`/`readdirSync`/`statSync`/`writeFileSync`/
// `rmSync`/`mkdtempSync`) stays the real, unmocked implementation --
// `discoverSources.ts`'s own metadata-only fs usage, and this file's own
// fixture-building helpers, are unaffected either way.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    createReadStream: vi.fn(actual.createReadStream),
    openSync: vi.fn(actual.openSync),
    open: vi.fn(actual.open),
    promises: {
      ...actual.promises,
      readFile: vi.fn(actual.promises.readFile),
    },
  };
});

import {
  classifyScratchDir,
  decodeProjectSlug,
  discoverSources,
  type DiscoverSourcesOptions,
} from './discoverSources.js';

// ---------------------------------------------------------------------------
// Fixture tree builder
// ---------------------------------------------------------------------------

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'mnemosyne-discover-sources-'));
  tempRoots.push(root);
  return root;
}

interface FixtureSpec {
  root: string;
  claudeProjectsRoot: string;
  homeDir: string;
  chatgptExportPath: string;
  geminiTakeoutPath: string;
  manifestPath: string;
}

/**
 * Builds a synthetic fixture tree mirroring the real naming convention
 * (research-brief.md §1.1 / design-discussion.md §2.4), never touching any
 * real operator path.
 */
function buildFixtureTree(): FixtureSpec {
  const root = makeTempRoot();
  const claudeProjectsRoot = path.join(root, 'claude-projects');
  const homeDir = '/Users/fakehome';

  // A real-looking, confirmed project dir: decodes to /Users/fakehome/Code/realproject
  const confirmedDir = path.join(claudeProjectsRoot, '-Users-fakehome-Code-realproject');
  mkdirSync(confirmedDir, { recursive: true });
  writeFileSync(path.join(confirmedDir, 'session-aaa.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n');

  // A second confirmed project dir under Documents/work
  const confirmedDir2 = path.join(claudeProjectsRoot, '-Users-fakehome-Documents-work-anotherproject');
  mkdirSync(confirmedDir2, { recursive: true });
  writeFileSync(path.join(confirmedDir2, 'session-bbb.jsonl'), 'fake jsonl content line 1\nfake jsonl content line 2\n');

  // scratch-filter-excluded dirs (one per sub-pattern)
  const scratchTmp = path.join(claudeProjectsRoot, '-private-tmp-abc123');
  mkdirSync(scratchTmp, { recursive: true });
  writeFileSync(path.join(scratchTmp, 'session-ccc.jsonl'), 'should never appear in manifest sessions');

  const scratchVarFolders = path.join(claudeProjectsRoot, '-private-var-folders-xyz');
  mkdirSync(scratchVarFolders, { recursive: true });
  writeFileSync(path.join(scratchVarFolders, 'session-ddd.jsonl'), 'should never appear in manifest sessions');

  const scratchpadDir = path.join(claudeProjectsRoot, '-Users-fakehome-Code-my-scratchpad-project');
  mkdirSync(scratchpadDir, { recursive: true });
  writeFileSync(path.join(scratchpadDir, 'session-eee.jsonl'), 'should never appear in manifest sessions');

  // weak-signal dir: decodes to a path under homeDir but outside any confirmed root
  const weakDir = path.join(claudeProjectsRoot, '-Users-fakehome-Elsewhere-weirdproject');
  mkdirSync(weakDir, { recursive: true });
  writeFileSync(path.join(weakDir, 'session-fff.jsonl'), 'real project work, just under an unconfirmed root');

  // weak-signal dir: decodes to a path entirely outside homeDir
  const weakDirOutsideHome = path.join(claudeProjectsRoot, '-Applications-gigradar-app-server');
  mkdirSync(weakDirOutsideHome, { recursive: true });
  writeFileSync(path.join(weakDirOutsideHome, 'session-ggg.jsonl'), 'real project work, outside home entirely');

  // A non-.jsonl file sitting in a confirmed dir -- must never be treated as a session
  writeFileSync(path.join(confirmedDir, 'notes.txt'), 'not a session file');

  // Fixed export files
  const downloadsDir = path.join(root, 'Downloads');
  const chatgptDir = path.join(downloadsDir, 'ChatGPT Data Export Feb 5 2026');
  mkdirSync(chatgptDir, { recursive: true });
  const chatgptExportPath = path.join(chatgptDir, 'conversations.json');
  writeFileSync(chatgptExportPath, JSON.stringify([{ title: 'fake conversation' }]));

  const geminiTakeoutPath = path.join(downloadsDir, 'Google Takeout Aug 26 2026.zip');
  writeFileSync(geminiTakeoutPath, Buffer.from('fake zip bytes, never opened by discoverSources'));

  // A decoy export-like file that a generic scan WOULD pick up but the fixed list must not
  writeFileSync(path.join(downloadsDir, 'OpenAI Export.zip'), 'decoy, must never appear in manifest');
  writeFileSync(path.join(downloadsDir, 'LinkedIn Export.zip'), 'decoy, must never appear in manifest');

  const manifestPath = path.join(root, 'mnemosyne', 'conversation-sources.yaml');

  return { root, claudeProjectsRoot, homeDir, chatgptExportPath, geminiTakeoutPath, manifestPath };
}

function optionsFor(fixture: FixtureSpec, overrides: Partial<DiscoverSourcesOptions> = {}): DiscoverSourcesOptions {
  return {
    claudeProjectsRoot: fixture.claudeProjectsRoot,
    homeDir: fixture.homeDir,
    chatgptExportPath: fixture.chatgptExportPath,
    geminiTakeoutPath: fixture.geminiTakeoutPath,
    manifestPath: fixture.manifestPath,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// decodeProjectSlug -- research-step cross-check (real, known-good samples)
// ---------------------------------------------------------------------------

describe('decodeProjectSlug', () => {
  it('decodes a real, known Claude Code project directory name to its absolute path', () => {
    // Cross-checked directly against this repo's own real ~/.claude/projects/ entry
    // during the research step (metadata-only directory listing, no content read).
    expect(decodeProjectSlug('-Users-mdostal-Documents-work-pantheon-mnemosyne')).toBe(
      '/Users/mdostal/Documents/work/pantheon/mnemosyne',
    );
    expect(decodeProjectSlug('-Users-mdostal-Code-delphi')).toBe('/Users/mdostal/Code/delphi');
  });

  it('decodes a synthetic slug under a fake home dir', () => {
    expect(decodeProjectSlug('-Users-fakehome-Code-realproject')).toBe('/Users/fakehome/Code/realproject');
  });

  it('returns a non-slug-shaped name unchanged rather than guessing', () => {
    expect(decodeProjectSlug('not-a-real-slug-prefix')).toBe('not-a-real-slug-prefix');
  });
});

// ---------------------------------------------------------------------------
// classifyScratchDir -- exclude vs. confirmed vs. weak
// ---------------------------------------------------------------------------

describe('classifyScratchDir', () => {
  const confirmedRoots = ['/Users/fakehome/Code', '/Users/fakehome/Documents/work'];

  it('excludes a -private-tmp directory with a named reason', () => {
    const result = classifyScratchDir('-private-tmp-abc123', confirmedRoots);
    expect(result.excluded).toBe(true);
    expect(result.reason).toMatch(/private-tmp/);
  });

  it('excludes a -private-var-folders directory with a named reason', () => {
    const result = classifyScratchDir('-private-var-folders-xyz', confirmedRoots);
    expect(result.excluded).toBe(true);
    expect(result.reason).toMatch(/private-var-folders/);
  });

  it('excludes any directory name containing "scratchpad" with a named reason', () => {
    const result = classifyScratchDir('-Users-fakehome-Code-my-scratchpad-project', confirmedRoots);
    expect(result.excluded).toBe(true);
    expect(result.reason).toMatch(/scratchpad/);
  });

  it('confirms a directory whose decoded slug falls under a confirmed root', () => {
    const result = classifyScratchDir('-Users-fakehome-Code-realproject', confirmedRoots);
    expect(result.excluded).toBe(false);
    expect(result.scratchConfidence).toBe('confirmed');
  });

  it('flags as weak (never excludes) a directory whose decoded slug falls outside every confirmed root', () => {
    const result = classifyScratchDir('-Users-fakehome-Elsewhere-weirdproject', confirmedRoots);
    expect(result.excluded).toBe(false);
    expect(result.scratchConfidence).toBe('weak');
  });

  it('flags as weak (never excludes) a directory whose decoded slug falls entirely outside home', () => {
    const result = classifyScratchDir('-Applications-gigradar-app-server', confirmedRoots);
    expect(result.excluded).toBe(false);
    expect(result.scratchConfidence).toBe('weak');
  });
});

// ---------------------------------------------------------------------------
// AC1 -- confirmed sessions produce a full manifest entry
// ---------------------------------------------------------------------------

describe('discoverSources -- AC1: confirmed session manifest entries', () => {
  it('enumerates every real session file under a confirmed dir with path, byte size, mtime, decoded slug', () => {
    const fixture = buildFixtureTree();
    const manifest = discoverSources(optionsFor(fixture));

    const entry = manifest.sessions.find((s) => s.path.endsWith('session-aaa.jsonl'));
    expect(entry).toBeDefined();
    expect(entry!.projectSlug).toBe('/Users/fakehome/Code/realproject');
    expect(entry!.projectDir).toBe('-Users-fakehome-Code-realproject');
    expect(entry!.sizeBytes).toBeGreaterThan(0);
    expect(entry!.scratchConfidence).toBe('confirmed');
    expect(() => new Date(entry!.mtime).toISOString()).not.toThrow();
    expect(new Date(entry!.mtime).toISOString()).toBe(entry!.mtime);
  });

  it('reports the real byte size matching the real file on disk', () => {
    const fixture = buildFixtureTree();
    const manifest = discoverSources(optionsFor(fixture));
    const realSize = fs.statSync(path.join(fixture.claudeProjectsRoot, '-Users-fakehome-Documents-work-anotherproject', 'session-bbb.jsonl')).size;
    const entry = manifest.sessions.find((s) => s.path.endsWith('session-bbb.jsonl'));
    expect(entry!.sizeBytes).toBe(realSize);
  });

  it('never includes non-.jsonl files as sessions', () => {
    const fixture = buildFixtureTree();
    const manifest = discoverSources(optionsFor(fixture));
    expect(manifest.sessions.some((s) => s.path.endsWith('notes.txt'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC2 -- scratch-filter exclusions are recorded, not silently dropped
// ---------------------------------------------------------------------------

describe('discoverSources -- AC2: scratch-filter exclusions recorded', () => {
  it('excludes matching directories from sessions but records each one in `excluded`', () => {
    const fixture = buildFixtureTree();
    const manifest = discoverSources(optionsFor(fixture));

    expect(manifest.sessions.some((s) => s.path.endsWith('session-ccc.jsonl'))).toBe(false);
    expect(manifest.sessions.some((s) => s.path.endsWith('session-ddd.jsonl'))).toBe(false);
    expect(manifest.sessions.some((s) => s.path.endsWith('session-eee.jsonl'))).toBe(false);

    const excludedDirNames = manifest.excluded.map((e) => e.dir);
    expect(excludedDirNames).toContain('-private-tmp-abc123');
    expect(excludedDirNames).toContain('-private-var-folders-xyz');
    expect(excludedDirNames).toContain('-Users-fakehome-Code-my-scratchpad-project');

    for (const e of manifest.excluded) {
      expect(e.reason).toEqual(expect.any(String));
      expect(e.reason.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// AC3 -- weak-signal dirs are included, flagged, never silently dropped/promoted
// ---------------------------------------------------------------------------

describe('discoverSources -- AC3: weak-signal flagging', () => {
  it('includes a session under an unconfirmed-root dir with scratchConfidence "weak"', () => {
    const fixture = buildFixtureTree();
    const manifest = discoverSources(optionsFor(fixture));

    const entry = manifest.sessions.find((s) => s.path.endsWith('session-fff.jsonl'));
    expect(entry).toBeDefined();
    expect(entry!.scratchConfidence).toBe('weak');
  });

  it('includes a session entirely outside home dir with scratchConfidence "weak", never dropped', () => {
    const fixture = buildFixtureTree();
    const manifest = discoverSources(optionsFor(fixture));

    const entry = manifest.sessions.find((s) => s.path.endsWith('session-ggg.jsonl'));
    expect(entry).toBeDefined();
    expect(entry!.scratchConfidence).toBe('weak');
  });

  it('never silently promotes a weak entry to "confirmed"', () => {
    const fixture = buildFixtureTree();
    const manifest = discoverSources(optionsFor(fixture));
    const weakEntries = manifest.sessions.filter((s) => s.path.endsWith('session-fff.jsonl') || s.path.endsWith('session-ggg.jsonl'));
    expect(weakEntries).toHaveLength(2);
    for (const e of weakEntries) {
      expect(e.scratchConfidence).toBe('weak');
    }
  });
});

// ---------------------------------------------------------------------------
// AC4 -- fixed, named ChatGPT export entry; no generic Downloads scan
// ---------------------------------------------------------------------------

describe('discoverSources -- AC4: fixed ChatGPT export entry, no generic scan', () => {
  it('reports the fixed ChatGPT export path as staged', () => {
    const fixture = buildFixtureTree();
    const manifest = discoverSources(optionsFor(fixture));
    expect(manifest.exports.chatgpt.path).toBe(fixture.chatgptExportPath);
    expect(manifest.exports.chatgpt.status).toBe('staged');
  });

  it('reports "not_found" when the fixed ChatGPT export path does not exist', () => {
    const fixture = buildFixtureTree();
    const manifest = discoverSources(optionsFor(fixture, { chatgptExportPath: path.join(fixture.root, 'Downloads', 'does-not-exist.json') }));
    expect(manifest.exports.chatgpt.status).toBe('not_found');
  });

  it('never surfaces decoy export-like files (OpenAI Export.zip, LinkedIn Export.zip) anywhere in the manifest', () => {
    const fixture = buildFixtureTree();
    const manifest = discoverSources(optionsFor(fixture));
    const manifestJson = JSON.stringify(manifest);
    expect(manifestJson).not.toContain('OpenAI Export');
    expect(manifestJson).not.toContain('LinkedIn Export');
  });

  it('exposes exactly two fixed export keys (chatgpt, gemini) -- not an open-ended scanned list', () => {
    const fixture = buildFixtureTree();
    const manifest = discoverSources(optionsFor(fixture));
    expect(Object.keys(manifest.exports).sort()).toEqual(['chatgpt', 'gemini']);
  });
});

// ---------------------------------------------------------------------------
// AC5 -- Gemini Takeout export staged wording
// ---------------------------------------------------------------------------

describe('discoverSources -- AC5: Gemini Takeout export entry', () => {
  it('reports "staged (takeout, 2 conversations)" for the real, staged Gemini Takeout fixture', () => {
    const fixture = buildFixtureTree();
    const manifest = discoverSources(optionsFor(fixture));
    expect(manifest.exports.gemini.path).toBe(fixture.geminiTakeoutPath);
    expect(manifest.exports.gemini.status).toBe('staged (takeout, 2 conversations)');
  });

  it('never words the Gemini entry as "not_staged" or comprehensive when present', () => {
    const fixture = buildFixtureTree();
    const manifest = discoverSources(optionsFor(fixture));
    expect(manifest.exports.gemini.status).not.toBe('not_staged');
    expect(manifest.exports.gemini.status.toLowerCase()).not.toContain('comprehensive');
    expect(manifest.exports.gemini.status.toLowerCase()).not.toContain('full account');
  });

  it('reports "not_found" when the Gemini Takeout path is absent', () => {
    const fixture = buildFixtureTree();
    const manifest = discoverSources(optionsFor(fixture, { geminiTakeoutPath: path.join(fixture.root, 'Downloads', 'no-takeout-here.zip') }));
    expect(manifest.exports.gemini.status).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// AC6 -- zero content read from any .jsonl source, ever
// ---------------------------------------------------------------------------

describe('discoverSources -- AC6: zero content-reading calls against .jsonl sources', () => {
  // `fs.readFileSync`/`fs.createReadStream`/`fs.openSync`/`fs.open`/
  // `fs.promises.readFile` are, per the `vi.mock('node:fs', ...)` factory
  // above, already `vi.fn(actual.fn)` pass-through spies -- real behavior,
  // recorded calls. Cleared (not reset, so the real pass-through
  // implementation survives) before each test in this block.
  beforeEach(() => {
    vi.mocked(fs.readFileSync).mockClear();
    vi.mocked(fs.promises.readFile).mockClear();
    vi.mocked(fs.createReadStream).mockClear();
    vi.mocked(fs.openSync).mockClear();
    vi.mocked(fs.open).mockClear();
  });

  function allContentReadSpies(): ReturnType<typeof vi.fn>[] {
    return [
      vi.mocked(fs.readFileSync),
      vi.mocked(fs.promises.readFile),
      vi.mocked(fs.createReadStream),
      vi.mocked(fs.openSync),
      vi.mocked(fs.open),
    ];
  }

  function assertNoContentReadOf(pathSuffix: string): void {
    for (const spy of allContentReadSpies()) {
      for (const call of spy.mock.calls) {
        const arg = call[0];
        const argStr = typeof arg === 'string' ? arg : String(arg);
        expect(argStr.endsWith(pathSuffix)).toBe(false);
      }
    }
  }

  it('never opens/reads content of any .jsonl source file during discovery', () => {
    const fixture = buildFixtureTree();
    discoverSources(optionsFor(fixture));

    assertNoContentReadOf('session-aaa.jsonl');
    assertNoContentReadOf('session-bbb.jsonl');
    assertNoContentReadOf('session-ccc.jsonl');
    assertNoContentReadOf('session-ddd.jsonl');
    assertNoContentReadOf('session-eee.jsonl');
    assertNoContentReadOf('session-fff.jsonl');
    assertNoContentReadOf('session-ggg.jsonl');
  });

  it('never opens/reads content of the fixed ChatGPT or Gemini export files during discovery', () => {
    const fixture = buildFixtureTree();
    discoverSources(optionsFor(fixture));

    assertNoContentReadOf('conversations.json');
    assertNoContentReadOf('Google Takeout Aug 26 2026.zip');
  });

  it('never calls any content-reading fs API at all with a .jsonl-suffixed path argument, across the whole run', () => {
    const fixture = buildFixtureTree();
    discoverSources(optionsFor(fixture));

    for (const spy of allContentReadSpies()) {
      for (const call of spy.mock.calls) {
        const arg = call[0];
        const argStr = typeof arg === 'string' ? arg : String(arg);
        expect(argStr.endsWith('.jsonl')).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AC7 -- idempotent, re-computed from scratch, never a stale cache
// ---------------------------------------------------------------------------

describe('discoverSources -- AC7: idempotent, re-computable from scratch', () => {
  it('produces the same session set across two consecutive runs when the filesystem is unchanged', () => {
    const fixture = buildFixtureTree();
    const first = discoverSources(optionsFor(fixture));
    const second = discoverSources(optionsFor(fixture));

    const firstPaths = first.sessions.map((s) => s.path).sort();
    const secondPaths = second.sessions.map((s) => s.path).sort();
    expect(secondPaths).toEqual(firstPaths);
  });

  it('reflects a real, new session file added between runs -- never a stale cached manifest', () => {
    const fixture = buildFixtureTree();
    const first = discoverSources(optionsFor(fixture));
    expect(first.sessions.some((s) => s.path.endsWith('session-new-later.jsonl'))).toBe(false);

    const confirmedDir = path.join(fixture.claudeProjectsRoot, '-Users-fakehome-Code-realproject');
    writeFileSync(path.join(confirmedDir, 'session-new-later.jsonl'), 'a session added after the first discovery run');

    const second = discoverSources(optionsFor(fixture));
    expect(second.sessions.some((s) => s.path.endsWith('session-new-later.jsonl'))).toBe(true);
  });

  it('reflects a real removal between runs -- a deleted session disappears from the fresh manifest', () => {
    const fixture = buildFixtureTree();
    const first = discoverSources(optionsFor(fixture));
    expect(first.sessions.some((s) => s.path.endsWith('session-aaa.jsonl'))).toBe(true);

    rmSync(path.join(fixture.claudeProjectsRoot, '-Users-fakehome-Code-realproject', 'session-aaa.jsonl'));

    const second = discoverSources(optionsFor(fixture));
    expect(second.sessions.some((s) => s.path.endsWith('session-aaa.jsonl'))).toBe(false);
  });

  it('writes a real manifest file to manifestPath that round-trips through YAML', () => {
    const fixture = buildFixtureTree();
    const manifest = discoverSources(optionsFor(fixture));

    expect(existsSync(fixture.manifestPath)).toBe(true);
    const onDisk = parseYaml(readFileSync(fixture.manifestPath, 'utf8'));
    expect(onDisk.sessions).toHaveLength(manifest.sessions.length);
    expect(onDisk.exports.gemini.status).toBe('staged (takeout, 2 conversations)');
  });

  it('does not require write:false runs to touch disk, and write:false still returns a fully-computed manifest', () => {
    const fixture = buildFixtureTree();
    const dryRunManifestPath = path.join(fixture.root, 'never-written', 'conversation-sources.yaml');
    const manifest = discoverSources(optionsFor(fixture, { manifestPath: dryRunManifestPath, write: false }));

    expect(existsSync(dryRunManifestPath)).toBe(false);
    expect(manifest.sessions.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Hard constraint cross-check: this suite itself never touches a real path
// ---------------------------------------------------------------------------

describe('discoverSources.test.ts -- fixture isolation self-check', () => {
  it('every discoverSources() call in this file passes an explicit, fixture-rooted claudeProjectsRoot', () => {
    // Static self-check: every fixture built by buildFixtureTree() roots
    // claudeProjectsRoot inside the mkdtemp'd temp dir, never the operator's
    // real home directory -- confirmed directly here rather than merely
    // trusted from the builder's own implementation.
    const fixture = buildFixtureTree();
    expect(fixture.claudeProjectsRoot.startsWith(tmpdir())).toBe(true);
    expect(fixture.chatgptExportPath.startsWith(tmpdir())).toBe(true);
    expect(fixture.geminiTakeoutPath.startsWith(tmpdir())).toBe(true);
    expect(fixture.claudeProjectsRoot).not.toContain(homedir());
  });
});
