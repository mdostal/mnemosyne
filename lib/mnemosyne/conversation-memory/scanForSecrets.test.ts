/**
 * cm-01-secret-credential-scanner (epic: mnemosyne-conversation-memory).
 *
 * Failing-first tests (TDD, per the story's `test-spec` step) for
 * `scanForSecrets()` against every acceptance criterion in
 * `.pHive/epics/mnemosyne-conversation-memory/stories/cm-01-secret-
 * credential-scanner.yaml`:
 *
 *  1. API-key-shaped tokens are detected, categorized, and never appear raw
 *     in the output.
 *  2. PEM private-key blocks are detected and categorized distinctly from
 *     API-key-shaped tokens.
 *  3. Connection strings with embedded credentials are detected, categorized
 *     distinctly, and the credential portion is redacted in the preview.
 *  4. Text with no recognizable secret shape yields zero matches — measured
 *     against the real, checked-in false-positive corpus, with the real
 *     false-positive rate reported as test output.
 *  5. The module's full public API has no bypass flag/option/env-var
 *     anywhere, for any category, for any input — independently re-verified
 *     here by reading the diff (source text), not by trusting the
 *     implementation's own doc comments.
 *  6. Redacted previews never contain the raw fixture secret value verbatim.
 *  7. (Cross-module duplicate-logic check lives in each of cm-03/cm-04/cm-07's
 *     own test suites, once those stories exist — not testable from this
 *     story in isolation since those modules don't exist yet.)
 *
 * Also computes and reports the real, measured false-negative rate
 * (POSITIVE_FIXTURES recall) and false-positive rate (FALSE_POSITIVE_FIXTURES
 * precision) as actual console output — per the story's own `metric` block
 * and its explicit "never claim zero without a corpus proving it" mandate.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanForSecrets, type SecretCategory } from './scanForSecrets.js';
import { FALSE_POSITIVE_FIXTURES, POSITIVE_FIXTURES } from './__fixtures__/secrets-corpus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// AC1 — API-key-shaped tokens: sk-, AKIA, ghp_, xox[bp]-.
// ---------------------------------------------------------------------------

describe('scanForSecrets — API-key-shaped tokens', () => {
  const apiKeyFixtures = POSITIVE_FIXTURES.filter((f) => f.expectedCategory === 'api-key');

  it.each(apiKeyFixtures.map((f) => [f.id, f] as const))('detects %s with category api-key and a redacted preview', (_id, fixture) => {
    const matches = scanForSecrets(fixture.text);
    const hit = matches.find((m) => m.category === 'api-key');
    expect(hit).toBeDefined();
    expect(hit!.category).toBe('api-key');
    expect(hit!.preview).toEqual(expect.any(String));
    expect(hit!.preview.length).toBeGreaterThan(0);
    expect(hit!.preview).not.toContain(fixture.secretValue);
  });

  it('names a specific recognized pattern per provider shape (not one generic label)', () => {
    const patterns = new Set(apiKeyFixtures.map((f) => scanForSecrets(f.text).find((m) => m.category === 'api-key')?.pattern));
    // sk-, AKIA, ghp_, and xox[bp]- are 4 structurally different shapes —
    // expect at least 4 distinct pattern names across the api-key fixtures.
    expect(patterns.size).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// AC2 — PEM private-key blocks, categorized distinctly from API-key tokens.
// ---------------------------------------------------------------------------

describe('scanForSecrets — PEM private-key blocks', () => {
  const pemFixtures = POSITIVE_FIXTURES.filter((f) => f.expectedCategory === 'pem-private-key');

  it.each(pemFixtures.map((f) => [f.id, f] as const))('detects %s as category pem-private-key, distinct from api-key', (_id, fixture) => {
    const matches = scanForSecrets(fixture.text);
    const hit = matches.find((m) => m.category === 'pem-private-key');
    expect(hit).toBeDefined();
    expect(hit!.category).toBe('pem-private-key');
    expect(hit!.category).not.toBe('api-key');
  });

  it('never leaks any line of the PEM body in the preview', () => {
    for (const fixture of pemFixtures) {
      const matches = scanForSecrets(fixture.text);
      const hit = matches.find((m) => m.category === 'pem-private-key')!;
      expect(hit.preview).not.toContain(fixture.secretValue);
      // The base64 body lines themselves must not leak either, not just the
      // BEGIN/END-wrapped whole.
      for (const bodyLine of fixture.secretValue.split('\n').slice(1, -1)) {
        expect(hit.preview).not.toContain(bodyLine);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AC3 — connection strings with embedded credentials.
// ---------------------------------------------------------------------------

describe('scanForSecrets — connection strings with embedded credentials', () => {
  const connFixtures = POSITIVE_FIXTURES.filter((f) => f.expectedCategory === 'connection-string');

  it.each(connFixtures.map((f) => [f.id, f] as const))('detects %s as category connection-string with credentials redacted', (_id, fixture) => {
    const matches = scanForSecrets(fixture.text);
    const hit = matches.find((m) => m.category === 'connection-string');
    expect(hit).toBeDefined();
    expect(hit!.category).toBe('connection-string');
    expect(hit!.category).not.toBe('api-key');
    expect(hit!.category).not.toBe('pem-private-key');
    // The `user:password` portion must never appear in the preview...
    expect(hit!.preview).not.toContain(fixture.secretValue);
    // ...while the preview still contains the literal redaction marker,
    // proving the credential slot was actively masked, not merely omitted.
    expect(hit!.preview).toContain('[REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// AC4 — no recognizable secret shape -> zero matches, measured against the
// real false-positive corpus, rate reported as real test output.
// ---------------------------------------------------------------------------

describe('scanForSecrets — false-positive corpus', () => {
  it('yields zero matches for every legitimate non-secret fixture (measured, reported false-positive rate)', () => {
    const results = FALSE_POSITIVE_FIXTURES.map((f) => ({ id: f.id, matches: scanForSecrets(f.text) }));
    const falsePositives = results.filter((r) => r.matches.length > 0);
    const rate = (falsePositives.length / FALSE_POSITIVE_FIXTURES.length) * 100;

    // eslint-disable-next-line no-console
    console.log(
      `[scanForSecrets] false-positive rate: ${falsePositives.length}/${FALSE_POSITIVE_FIXTURES.length} ` +
        `(${rate.toFixed(2)}%)` +
        (falsePositives.length > 0 ? ` — offending fixtures: ${falsePositives.map((f) => f.id).join(', ')}` : ''),
    );

    expect(falsePositives).toEqual([]);
    expect(rate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Measured false-negative rate (recall) across the full positive corpus —
// reported as real test output, per the story's `metric` block.
// ---------------------------------------------------------------------------

describe('scanForSecrets — measured false-negative rate (positive corpus recall)', () => {
  it('reports and bounds the real false-negative rate across every category', () => {
    const results = POSITIVE_FIXTURES.map((f) => ({
      id: f.id,
      expectedCategory: f.expectedCategory,
      detected: scanForSecrets(f.text).some((m) => m.category === f.expectedCategory),
    }));
    const missed = results.filter((r) => !r.detected);
    const rate = (missed.length / POSITIVE_FIXTURES.length) * 100;

    // eslint-disable-next-line no-console
    console.log(
      `[scanForSecrets] false-negative rate: ${missed.length}/${POSITIVE_FIXTURES.length} ` +
        `(${rate.toFixed(2)}%)` + (missed.length > 0 ? ` — missed fixtures: ${missed.map((f) => f.id).join(', ')}` : ''),
    );

    expect(missed).toEqual([]);
    expect(rate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC6 — raw secret value never appears verbatim anywhere in output, for
// EVERY positive fixture (not just spot-checked categories).
// ---------------------------------------------------------------------------

describe('scanForSecrets — raw secret value never leaks into output', () => {
  it.each(POSITIVE_FIXTURES.map((f) => [f.id, f] as const))('never includes the raw secret value for %s anywhere in the returned matches', (_id, fixture) => {
    const matches = scanForSecrets(fixture.text);
    const serialized = JSON.stringify(matches);
    expect(serialized).not.toContain(fixture.secretValue);
    // Also guard the "high-entropy substring" case for multi-line PEM
    // fixtures: no individual body line should leak either.
    for (const line of fixture.secretValue.split('\n')) {
      if (line.length < 8) continue; // skip short structural lines like BEGIN/END markers' shared words
      expect(serialized).not.toContain(line);
    }
  });
});

// ---------------------------------------------------------------------------
// AC5 — no bypass flag/option/env-var anywhere in the module's public
// surface, for any category, under any circumstance. Independently
// re-verified by reading the diff (source text), mirroring
// crawlAndIngest.test.ts's own "no bypass" static check.
// ---------------------------------------------------------------------------

describe('scanForSecrets — no bypass flag/option/env-var anywhere', () => {
  const source = readFileSync(path.join(__dirname, 'scanForSecrets.ts'), 'utf8');
  // Strip comments first -- the module's own doc comments legitimately
  // DISCUSS the no-bypass posture in prose; what must never exist is a real
  // CODE construct that could actually suppress or skip detection.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('has exactly one exported function, taking exactly one required parameter', () => {
    const exportedFunctionSignatures = [...code.matchAll(/export function (\w+)\(([^)]*)\)/g)];
    expect(exportedFunctionSignatures).toHaveLength(1);
    const [, name, params] = exportedFunctionSignatures[0]!;
    expect(name).toBe('scanForSecrets');
    expect(params).toBeDefined();
    // Exactly one parameter (`text: string`) — no options bag, no second
    // parameter of any kind, optional or otherwise.
    expect(params!.split(',').map((p) => p.trim()).filter(Boolean)).toHaveLength(1);
    expect(params).not.toContain('?');
    expect(params).not.toContain('=');
  });

  it('reads no environment variable anywhere in the module', () => {
    expect(code).not.toMatch(/process\.env/);
  });

  it('contains no bypass/skip/disable/allow-listed-secret construct anywhere in the module', () => {
    expect(code.toLowerCase()).not.toMatch(/bypass/);
    expect(code.toLowerCase()).not.toMatch(/skip[_-]?(scan|detect|secret|check)/);
    expect(code.toLowerCase()).not.toMatch(/disable[_-]?(scan|detect|guard|check)/);
    expect(code.toLowerCase()).not.toMatch(/allow[_-]?list/);
    expect(code.toLowerCase()).not.toMatch(/ignore[_-]?(pattern|category|secret)/);
    expect(code.toLowerCase()).not.toMatch(/\bexclude\b/);
    expect(code.toLowerCase()).not.toMatch(/\bwhitelist\b/);
    expect(code.toLowerCase()).not.toMatch(/\btrusted\b/);
  });

  it('never reads from the filesystem, network, or any other module in this repo (pure module, zero imports)', () => {
    expect(code).not.toMatch(/^\s*import /m);
    expect(code).not.toMatch(/\brequire\(/);
    expect(code).not.toMatch(/\bfetch\(/);
    expect(code).not.toMatch(/readFileSync|readFile\b/);
  });

  // Sanity: confirms the assertions above are actually exercising the real,
  // current implementation file, not an empty/misnamed path.
  it('sanity: the scanned source is the real implementation, not an empty/misnamed file', () => {
    expect(code).toContain('export function scanForSecrets');
    expect(code.length).toBeGreaterThan(500);
  });
});

// ---------------------------------------------------------------------------
// Rough-location reporting (part of AC6's "category and rough location"
// requirement).
// ---------------------------------------------------------------------------

describe('scanForSecrets — rough location reporting', () => {
  it('reports a 1-based line number and a non-negative character index for every match', () => {
    const multiline = ['line one is safe', 'line two has AKIAFAKE00EXAMPLE123 in it', 'line three is safe too'].join('\n');
    const matches = scanForSecrets(multiline);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.line).toBe(2);
    expect(matches[0]!.index).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Category taxonomy sanity: every SecretCategory the module claims to
// support is exercised by at least one positive fixture (keeps the fixture
// corpus honest as the pattern table grows).
// ---------------------------------------------------------------------------

describe('scanForSecrets — category taxonomy coverage', () => {
  it('exercises all four documented categories in the positive corpus', () => {
    const expected: SecretCategory[] = ['api-key', 'bearer-token', 'pem-private-key', 'connection-string'];
    const covered = new Set(POSITIVE_FIXTURES.map((f) => f.expectedCategory));
    for (const category of expected) {
      expect(covered.has(category)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Non-string input fails loudly (loud-failure cross-cutting concern) rather
// than silently returning an empty/wrong result.
// ---------------------------------------------------------------------------

describe('scanForSecrets — loud failure on invalid input', () => {
  it('throws on non-string input rather than silently returning no matches', () => {
    // @ts-expect-error deliberately passing a wrong type to verify runtime behavior
    expect(() => scanForSecrets(null)).toThrow();
    // @ts-expect-error deliberately passing a wrong type to verify runtime behavior
    expect(() => scanForSecrets(undefined)).toThrow();
    // @ts-expect-error deliberately passing a wrong type to verify runtime behavior
    expect(() => scanForSecrets(12345)).toThrow();
  });

  it('returns an empty array (not an error) for an empty string', () => {
    expect(scanForSecrets('')).toEqual([]);
  });
});
