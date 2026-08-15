import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Persona } from '../persona.js';
import {
  readRepoLocalPersona,
  repoLocalPersonaPath,
  writeRepoLocalPersona,
} from '../persona-store-repo-local.js';

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempRepoRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-persona-store-'));
  tempRoots.push(root);
  return root;
}

function validCodeArchitectPersona(overrides: Partial<Persona> = {}): Persona {
  return {
    tier: 'code-architect',
    scopeId: 'mnemosyne',
    displayName: 'Code/Area Architect — mnemosyne',
    scope: 'Deep per-repo implementation detail for this repo only.',
    sections: [{ heading: 'What this tier owns', body: 'Repo-specific conventions and patterns.' }],
    ...overrides,
  };
}

describe('repoLocalPersonaPath', () => {
  it('resolves to <repoRoot>/.mnemosyne/personas/<scopeId>.yaml', async () => {
    const root = await makeTempRepoRoot();
    expect(repoLocalPersonaPath(root, 'mnemosyne')).toBe(
      path.join(root, '.mnemosyne', 'personas', 'mnemosyne.yaml'),
    );
  });
});

describe('writeRepoLocalPersona / readRepoLocalPersona', () => {
  it('round-trips a valid code-architect persona through write then read, unchanged', async () => {
    const root = await makeTempRepoRoot();
    const persona = validCodeArchitectPersona();

    writeRepoLocalPersona(root, persona);
    const readBack = readRepoLocalPersona(root, persona.scopeId);

    expect(readBack).toEqual(persona);
  });

  it('round-trips a persona with an optional parentRefs array unchanged', async () => {
    const root = await makeTempRepoRoot();
    const parentRefs = [{ tier: 'project-orchestrator' as const, scopeId: 'project-x' }];
    const persona = validCodeArchitectPersona({ parentRefs });

    writeRepoLocalPersona(root, persona);
    const readBack = readRepoLocalPersona(root, persona.scopeId);

    expect(readBack).toEqual(persona);
    expect(readBack.parentRefs).toEqual(parentRefs);
  });

  it('writes to <repoRoot>/.mnemosyne/personas/<scopeId>.yaml as real YAML, not JSON', async () => {
    const root = await makeTempRepoRoot();
    const persona = validCodeArchitectPersona();

    const filePath = writeRepoLocalPersona(root, persona);
    expect(filePath).toBe(path.join(root, '.mnemosyne', 'personas', `${persona.scopeId}.yaml`));
    expect(existsSync(filePath)).toBe(true);

    const raw = await readFile(filePath, 'utf8');
    expect(raw.trim().startsWith('{')).toBe(false); // not JSON
    expect(raw).toContain('tier: code-architect');
    expect(raw).toContain('scopeId: mnemosyne');
  });

  it('throws when writing a persona with tier=company-director -- repo-local store only ever holds code-architect', async () => {
    const root = await makeTempRepoRoot();
    const persona = validCodeArchitectPersona({ tier: 'company-director' as Persona['tier'] });

    expect(() => writeRepoLocalPersona(root, persona)).toThrow(/repo-local/i);
    expect(existsSync(path.join(root, '.mnemosyne', 'personas'))).toBe(false);
  });

  it('throws when writing a persona with tier=top-orchestrator', async () => {
    const root = await makeTempRepoRoot();
    const persona = validCodeArchitectPersona({ tier: 'top-orchestrator' as Persona['tier'] });

    expect(() => writeRepoLocalPersona(root, persona)).toThrow(/repo-local/i);
  });

  it('throws when writing a persona with tier=project-orchestrator', async () => {
    const root = await makeTempRepoRoot();
    const persona = validCodeArchitectPersona({ tier: 'project-orchestrator' as Persona['tier'] });

    expect(() => writeRepoLocalPersona(root, persona)).toThrow(/repo-local/i);
  });

  it('throws when writing a candidate with mandateSections present', async () => {
    const root = await makeTempRepoRoot();
    const candidate = { ...validCodeArchitectPersona(), mandateSections: [] };

    expect(() => writeRepoLocalPersona(root, candidate)).toThrow(/mandateSections/);
    expect(existsSync(path.join(root, '.mnemosyne', 'personas'))).toBe(false);
  });

  it('read throws a clear error when no persona file exists for the scopeId', async () => {
    const root = await makeTempRepoRoot();
    expect(() => readRepoLocalPersona(root, 'nonexistent-scope')).toThrow(/no repo-local persona/i);
  });

  it('reads fresh from disk on every call -- no module-level caching (mirrors level0.ts contract)', async () => {
    const root = await makeTempRepoRoot();
    const persona = validCodeArchitectPersona({ scopeId: 'freshness-check' });
    writeRepoLocalPersona(root, persona);

    const first = readRepoLocalPersona(root, 'freshness-check');
    expect(first.displayName).toBe(persona.displayName);

    const updated = { ...persona, displayName: 'Updated Display Name' };
    writeRepoLocalPersona(root, updated);
    const second = readRepoLocalPersona(root, 'freshness-check');
    expect(second.displayName).toBe('Updated Display Name');
  });

  it('overwrites an existing persona file for the same scopeId on re-write', async () => {
    const root = await makeTempRepoRoot();
    const persona = validCodeArchitectPersona({ scopeId: 'overwrite-check', displayName: 'v1' });
    writeRepoLocalPersona(root, persona);
    writeRepoLocalPersona(root, { ...persona, displayName: 'v2' });

    const readBack = readRepoLocalPersona(root, 'overwrite-check');
    expect(readBack.displayName).toBe('v2');
  });
});

describe('repo-local store policy', () => {
  it('the .mnemosyne/personas path is not gitignored in this repo -- personas are meant to be git-committed', () => {
    const repoRoot = process.cwd();
    if (!existsSync(path.join(repoRoot, '.git'))) {
      // Not running from inside a git checkout (e.g. packaged/CI context that
      // doesn't include .git) -- nothing meaningful to assert here.
      return;
    }
    let ignored = false;
    try {
      execFileSync('git', ['check-ignore', '.mnemosyne/personas/example-scope.yaml'], {
        cwd: repoRoot,
        stdio: 'pipe',
      });
      ignored = true; // exit code 0 means the path IS ignored
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 1) {
        throw err; // exit 1 = not ignored (expected); anything else is a real error
      }
      ignored = false;
    }
    expect(ignored).toBe(false);
  });
});
