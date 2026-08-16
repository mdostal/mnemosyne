import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Persona } from '../persona.js';
import {
  globalPersonaPath,
  readGlobalPersona,
  writeGlobalPersona,
} from '../persona-store-global.js';

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempGlobalRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-persona-store-global-'));
  tempRoots.push(root);
  return root;
}

function validCompanyDirectorPersona(overrides: Partial<Persona> = {}): Persona {
  return {
    tier: 'company-director',
    scopeId: 'pantheon',
    displayName: 'Company Director — Pantheon',
    scope: "Pantheon's product/business context and coordination across its project orchestrators.",
    sections: [{ heading: 'What this tier owns', body: "Pantheon's product and business context." }],
    ...overrides,
  };
}

describe('globalPersonaPath', () => {
  it('resolves to <root>/<tier>/<scopeId>.yaml', async () => {
    const root = await makeTempGlobalRoot();
    expect(globalPersonaPath('company-director', 'pantheon', root)).toBe(
      path.join(root, 'company-director', 'pantheon.yaml'),
    );
  });

  it('defaults to ~/.mnemosyne/personas/<tier>/<scopeId>.yaml when no root is given', () => {
    const resolved = globalPersonaPath('top-orchestrator', 'auriga');
    expect(resolved.endsWith(path.join('.mnemosyne', 'personas', 'top-orchestrator', 'auriga.yaml'))).toBe(true);
  });
});

describe('writeGlobalPersona / readGlobalPersona', () => {
  it('round-trips a valid company-director persona through write then read, unchanged', async () => {
    const root = await makeTempGlobalRoot();
    const persona = validCompanyDirectorPersona();

    writeGlobalPersona(persona, root);
    const readBack = readGlobalPersona('company-director', persona.scopeId, root);

    expect(readBack).toEqual(persona);
  });

  it('round-trips top-orchestrator and project-orchestrator personas too', async () => {
    const root = await makeTempGlobalRoot();
    const top = validCompanyDirectorPersona({
      tier: 'top-orchestrator',
      scopeId: 'auriga',
      displayName: 'Top Orchestrator (Auriga)',
    });
    const project = validCompanyDirectorPersona({
      tier: 'project-orchestrator',
      scopeId: 'mnemosyne',
      displayName: 'Project Orchestrator — mnemosyne',
    });

    writeGlobalPersona(top, root);
    writeGlobalPersona(project, root);

    expect(readGlobalPersona('top-orchestrator', 'auriga', root)).toEqual(top);
    expect(readGlobalPersona('project-orchestrator', 'mnemosyne', root)).toEqual(project);
  });

  it('writes to <root>/<tier>/<scopeId>.yaml as real YAML, not JSON', async () => {
    const root = await makeTempGlobalRoot();
    const persona = validCompanyDirectorPersona();

    const filePath = writeGlobalPersona(persona, root);
    expect(filePath).toBe(path.join(root, 'company-director', `${persona.scopeId}.yaml`));
    expect(existsSync(filePath)).toBe(true);

    const raw = await readFile(filePath, 'utf8');
    expect(raw.trim().startsWith('{')).toBe(false); // not JSON
    expect(raw).toContain('tier: company-director');
    expect(raw).toContain('scopeId: pantheon');
  });

  it('throws when writing a persona with tier=code-architect -- the global store never holds code-architect', async () => {
    const root = await makeTempGlobalRoot();
    const persona = validCompanyDirectorPersona({ tier: 'code-architect' as Persona['tier'] });

    expect(() => writeGlobalPersona(persona, root)).toThrow(/code-architect/i);
  });

  it('rejects tier=code-architect BEFORE touching disk -- no directory or file is created', async () => {
    const root = await makeTempGlobalRoot();
    const persona = validCompanyDirectorPersona({ tier: 'code-architect' as Persona['tier'] });

    expect(() => writeGlobalPersona(persona, root)).toThrow();
    expect(existsSync(path.join(root, 'code-architect'))).toBe(false);

    const { readdir } = await import('node:fs/promises');
    // The temp root itself was created by the test fixture, not by writeGlobalPersona -- assert
    // it stayed empty, i.e. the rejected write created nothing under it at all.
    expect(await readdir(root)).toEqual([]);
  });

  it('throws when writing a candidate with mandateSections present', async () => {
    const root = await makeTempGlobalRoot();
    const candidate = { ...validCompanyDirectorPersona(), mandateSections: [] };

    expect(() => writeGlobalPersona(candidate, root)).toThrow(/mandateSections/);
    expect(existsSync(path.join(root, 'company-director'))).toBe(false);
  });

  it('read throws a clear error when no persona file exists for the tier/scopeId', async () => {
    const root = await makeTempGlobalRoot();
    expect(() => readGlobalPersona('company-director', 'nonexistent-scope', root)).toThrow(/no global persona/i);
  });

  it('overwrites an existing persona file for the same tier/scopeId on re-write', async () => {
    const root = await makeTempGlobalRoot();
    const persona = validCompanyDirectorPersona({ scopeId: 'overwrite-check', displayName: 'v1' });
    writeGlobalPersona(persona, root);
    writeGlobalPersona({ ...persona, displayName: 'v2' }, root);

    const readBack = readGlobalPersona('company-director', 'overwrite-check', root);
    expect(readBack.displayName).toBe('v2');
  });
});

describe('read-fresh contract (mirrors level0.ts -- no module-level caching)', () => {
  it('a second read after an external edit to the file reflects the change', async () => {
    const root = await makeTempGlobalRoot();
    const persona = validCompanyDirectorPersona({ scopeId: 'freshness-check' });
    writeGlobalPersona(persona, root);

    const first = readGlobalPersona('company-director', 'freshness-check', root);
    expect(first.displayName).toBe(persona.displayName);

    // Simulate an external edit (an operator hand-editing the file, or a separate process) --
    // NOT going through writeGlobalPersona, to prove the read path itself has no cache.
    const filePath = globalPersonaPath('company-director', 'freshness-check', root);
    const { writeFile } = await import('node:fs/promises');
    const { stringify } = await import('yaml');
    await writeFile(filePath, stringify({ ...persona, displayName: 'Externally Edited' }), 'utf8');

    const second = readGlobalPersona('company-director', 'freshness-check', root);
    expect(second.displayName).toBe('Externally Edited');
  });
});
