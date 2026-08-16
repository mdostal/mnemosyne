import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  disposeDraftPersona,
  draftPersonaPath,
  listDraftPersonas,
  readDraftPersona,
  writeDraftPersona,
} from '../persona-draft-store.js';

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempDraftRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-persona-draft-store-'));
  tempRoots.push(root);
  return root;
}

async function makeTempRepoRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-persona-draft-repo-'));
  tempRoots.push(root);
  return root;
}

function draftGlobalCandidate(overrides: Record<string, unknown> = {}) {
  return {
    tier: 'company-director' as const,
    scopeId: 'pantheon',
    displayName: 'Company Director — Pantheon (draft)',
    scope: 'Draft under review.',
    sections: [{ heading: 'Proposed', body: 'Proposed by an agent, not yet reviewed.' }],
    proposedBy: 'agent',
    ...overrides,
  };
}

function draftRepoLocalCandidate(overrides: Record<string, unknown> = {}) {
  return {
    tier: 'code-architect' as const,
    scopeId: 'mnemosyne',
    displayName: 'Code/Area Architect — mnemosyne (draft)',
    scope: 'Draft under review.',
    sections: [{ heading: 'Proposed', body: 'Proposed by an agent, not yet reviewed.' }],
    proposedBy: 'agent',
    ...overrides,
  };
}

describe('draftPersonaPath', () => {
  it('resolves global tiers to <draftRoot>/<tier>/<scopeId>.yaml', async () => {
    const draftRoot = await makeTempDraftRoot();
    expect(draftPersonaPath('company-director', 'pantheon', { draftRoot })).toBe(
      path.join(draftRoot, 'company-director', 'pantheon.yaml'),
    );
  });

  it('resolves code-architect to <draftRoot>/repo-local/<sanitized-repoRoot>/<scopeId>.yaml', async () => {
    const draftRoot = await makeTempDraftRoot();
    const repoRoot = await makeTempRepoRoot();
    const expectedSlug = path.resolve(repoRoot).replace(/[^a-zA-Z0-9_-]/g, '-');
    expect(draftPersonaPath('code-architect', 'mnemosyne', { draftRoot, repoRoot })).toBe(
      path.join(draftRoot, 'repo-local', expectedSlug, 'mnemosyne.yaml'),
    );
  });

  it('defaults to ~/.mnemosyne/persona-drafts/<tier>/<scopeId>.yaml when no draftRoot is given', () => {
    const resolved = draftPersonaPath('top-orchestrator', 'auriga');
    expect(resolved.endsWith(path.join('.mnemosyne', 'persona-drafts', 'top-orchestrator', 'auriga.yaml'))).toBe(
      true,
    );
  });
});

describe('writeDraftPersona / readDraftPersona -- global tier round-trip', () => {
  it('creates a new active draft at the correct home-rooted path and reads it back unchanged', async () => {
    const draftRoot = await makeTempDraftRoot();
    const candidate = draftGlobalCandidate();

    const filePath = writeDraftPersona(candidate, { draftRoot });
    expect(filePath).toBe(path.join(draftRoot, 'company-director', 'pantheon.yaml'));
    expect(existsSync(filePath)).toBe(true);

    const readBack = readDraftPersona('company-director', 'pantheon', { draftRoot });
    expect(readBack).toEqual(candidate);
  });

  it('overwrites the existing active draft in place on a second write for the same identity -- never a second file', async () => {
    const draftRoot = await makeTempDraftRoot();
    writeDraftPersona(draftGlobalCandidate({ scope: 'First draft.' }), { draftRoot });
    writeDraftPersona(draftGlobalCandidate({ scope: 'Second, revised draft.' }), { draftRoot });

    const tierDir = path.join(draftRoot, 'company-director');
    expect(readdirSync(tierDir)).toEqual(['pantheon.yaml']);

    const readBack = readDraftPersona('company-director', 'pantheon', { draftRoot });
    expect(readBack.scope).toBe('Second, revised draft.');
  });

  it('throws when reading a draft that does not exist', async () => {
    const draftRoot = await makeTempDraftRoot();
    expect(() => readDraftPersona('company-director', 'nobody', { draftRoot })).toThrow();
  });
});

describe('writeDraftPersona / readDraftPersona -- repo-local tier round-trip', () => {
  it('creates a new active draft under the home-rooted repo-local subtree and reads it back unchanged', async () => {
    const draftRoot = await makeTempDraftRoot();
    const repoRoot = await makeTempRepoRoot();
    const candidate = draftRepoLocalCandidate();

    const filePath = writeDraftPersona(candidate, { draftRoot, repoRoot });
    expect(existsSync(filePath)).toBe(true);
    expect(filePath.startsWith(path.join(draftRoot, 'repo-local'))).toBe(true);

    const readBack = readDraftPersona('code-architect', 'mnemosyne', { draftRoot, repoRoot });
    expect(readBack).toEqual(candidate);
  });

  it('never writes anything under <repoRoot>/.mnemosyne/ for a repo-local draft', async () => {
    const draftRoot = await makeTempDraftRoot();
    const repoRoot = await makeTempRepoRoot();

    writeDraftPersona(draftRepoLocalCandidate(), { draftRoot, repoRoot });

    expect(existsSync(path.join(repoRoot, '.mnemosyne'))).toBe(false);
  });

  it('overwrites the existing active repo-local draft in place on a second write', async () => {
    const draftRoot = await makeTempDraftRoot();
    const repoRoot = await makeTempRepoRoot();

    writeDraftPersona(draftRepoLocalCandidate({ scope: 'First draft.' }), { draftRoot, repoRoot });
    writeDraftPersona(draftRepoLocalCandidate({ scope: 'Second, revised draft.' }), { draftRoot, repoRoot });

    const entries = listDraftPersonas({ draftRoot, repoRoot }).filter((e) => e.tier === 'code-architect');
    expect(entries).toEqual([{ tier: 'code-architect', scopeId: 'mnemosyne' }]);

    const readBack = readDraftPersona('code-architect', 'mnemosyne', { draftRoot, repoRoot });
    expect(readBack.scope).toBe('Second, revised draft.');
  });
});

describe('listDraftPersonas', () => {
  it('lists active drafts across global tiers and, when repoRoot is given, the repo-local tier too', async () => {
    const draftRoot = await makeTempDraftRoot();
    const repoRoot = await makeTempRepoRoot();

    writeDraftPersona(draftGlobalCandidate({ tier: 'top-orchestrator', scopeId: 'auriga' }), { draftRoot });
    writeDraftPersona(draftGlobalCandidate({ tier: 'company-director', scopeId: 'pantheon' }), { draftRoot });
    writeDraftPersona(draftRepoLocalCandidate(), { draftRoot, repoRoot });

    const entries = listDraftPersonas({ draftRoot, repoRoot });
    expect(entries).toEqual(
      expect.arrayContaining([
        { tier: 'top-orchestrator', scopeId: 'auriga' },
        { tier: 'company-director', scopeId: 'pantheon' },
        { tier: 'code-architect', scopeId: 'mnemosyne' },
      ]),
    );
    expect(entries).toHaveLength(3);
  });

  it('omits repo-local drafts entirely when no repoRoot is given', async () => {
    const draftRoot = await makeTempDraftRoot();
    const repoRoot = await makeTempRepoRoot();

    writeDraftPersona(draftGlobalCandidate(), { draftRoot });
    writeDraftPersona(draftRepoLocalCandidate(), { draftRoot, repoRoot });

    const entries = listDraftPersonas({ draftRoot });
    expect(entries).toEqual([{ tier: 'company-director', scopeId: 'pantheon' }]);
  });

  it('returns an empty list against a never-seeded draftRoot', async () => {
    const draftRoot = await makeTempDraftRoot();
    expect(listDraftPersonas({ draftRoot })).toEqual([]);
  });
});

describe('disposeDraftPersona', () => {
  it('moves an approved global draft into the approved/ archive subtree, never fs.unlink -- and it drops out of the active listing', async () => {
    const draftRoot = await makeTempDraftRoot();
    const candidate = draftGlobalCandidate();
    const activePath = writeDraftPersona(candidate, { draftRoot });

    const archivePath = disposeDraftPersona('company-director', 'pantheon', 'approved', { draftRoot });

    expect(existsSync(activePath)).toBe(false);
    expect(existsSync(archivePath)).toBe(true);
    expect(archivePath.startsWith(path.join(draftRoot, 'approved'))).toBe(true);
    expect(archivePath).not.toBe(activePath);

    expect(listDraftPersonas({ draftRoot })).toEqual([]);
  });

  it('moves a discarded global draft into the discarded/ archive subtree', async () => {
    const draftRoot = await makeTempDraftRoot();
    writeDraftPersona(draftGlobalCandidate(), { draftRoot });

    const archivePath = disposeDraftPersona('company-director', 'pantheon', 'discarded', { draftRoot });

    expect(existsSync(archivePath)).toBe(true);
    expect(archivePath.startsWith(path.join(draftRoot, 'discarded'))).toBe(true);
    expect(listDraftPersonas({ draftRoot })).toEqual([]);
  });

  it('archived content is byte-identical to the disposed draft -- moved, not rewritten', async () => {
    const draftRoot = await makeTempDraftRoot();
    const candidate = draftGlobalCandidate();
    writeDraftPersona(candidate, { draftRoot });

    const archivePath = disposeDraftPersona('company-director', 'pantheon', 'approved', { draftRoot });
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(archivePath, 'utf8');
    expect(raw).toContain('scopeId: pantheon');
  });

  it('moves a repo-local draft into the home-rooted repo-local archive subtree, never into the repo tree', async () => {
    const draftRoot = await makeTempDraftRoot();
    const repoRoot = await makeTempRepoRoot();
    writeDraftPersona(draftRepoLocalCandidate(), { draftRoot, repoRoot });

    const archivePath = disposeDraftPersona('code-architect', 'mnemosyne', 'approved', { draftRoot, repoRoot });

    expect(existsSync(archivePath)).toBe(true);
    expect(archivePath.startsWith(path.join(draftRoot, 'approved'))).toBe(true);
    expect(existsSync(path.join(repoRoot, '.mnemosyne'))).toBe(false);
    expect(listDraftPersonas({ draftRoot, repoRoot }).filter((e) => e.tier === 'code-architect')).toEqual([]);
  });

  it('throws when disposing a {tier, scopeId} with no active draft', async () => {
    const draftRoot = await makeTempDraftRoot();
    expect(() => disposeDraftPersona('company-director', 'nobody', 'approved', { draftRoot })).toThrow();
  });
});

describe('structural validation -- not full assertValidPersona strength', () => {
  it('throws and writes nothing for a candidate with an invalid tier', async () => {
    const draftRoot = await makeTempDraftRoot();
    expect(() =>
      writeDraftPersona({ tier: 'not-a-real-tier', scopeId: 'x' }, { draftRoot }),
    ).toThrow();
    expect(existsSync(draftRoot) && readdirSync(draftRoot).length > 0).toBe(false);
  });

  it('throws and writes nothing for a candidate with an empty scopeId', async () => {
    const draftRoot = await makeTempDraftRoot();
    expect(() =>
      writeDraftPersona({ tier: 'company-director', scopeId: '' }, { draftRoot }),
    ).toThrow();
    expect(existsSync(path.join(draftRoot, 'company-director'))).toBe(false);
  });

  it('throws and writes nothing for a candidate missing scopeId entirely', async () => {
    const draftRoot = await makeTempDraftRoot();
    expect(() => writeDraftPersona({ tier: 'company-director' }, { draftRoot })).toThrow();
    expect(existsSync(path.join(draftRoot, 'company-director'))).toBe(false);
  });

  it('does NOT reject a structurally-valid but otherwise-incomplete draft (missing displayName/scope/sections)', async () => {
    const draftRoot = await makeTempDraftRoot();
    // Deliberately missing displayName/scope/sections -- assertValidPersona-strength
    // validation is NOT applied at this layer (design-discussion.md §3b / §9 #3).
    const incomplete = { tier: 'company-director' as const, scopeId: 'pantheon' };
    expect(() => writeDraftPersona(incomplete, { draftRoot })).not.toThrow();
    expect(readDraftPersona('company-director', 'pantheon', { draftRoot })).toEqual(incomplete);
  });
});
