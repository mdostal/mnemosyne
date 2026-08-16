// persona-writer.mjs — pw-11-interview-skill-persona-output.
//
// Wires pw-10's interview-engine.mjs output (a completed interview's
// `persona` record, from runPersonaInterview()) into a REAL call to Slice
// 2's `persona create` write primitive (bin/mnemosyne-persona.mjs, pw-05) —
// the same CLI subcommand pw-06's `personaCreateAction`
// (bin/mnemosyne-skill-helper.mjs) and pw-07's `persona_create` MCP tool
// (bin/mnemosyne-mcp.mjs) themselves wrap. This module is NOT a fourth write
// path: it shells out to the exact same `mnemosyne persona create --file
// <path>` subcommand those two transports also invoke — see
// bin/mnemosyne-skill-helper.mjs's own `personaCliRun` for the precedent
// this mirrors, and test/persona-cross-transport.mjs for the proof all
// three existing transports already funnel through the same
// writeGlobalPersona/writeRepoLocalPersona + withLock code (persona.ts's
// PERSONA_STORE_BY_TIER dispatch).
//
// WHICH SURFACE, AND WHY (pw-11's "research" step): three real write
// surfaces exist after pw-05/06/07 — CLI subprocess, MCP tool, and
// skill-harness action. This module picks the CLI, matching what pw-10's
// SKILL.md step 7 already documented as the primary path: an interview
// skill runs INSIDE a live Claude Code (or similar) agent session, which
// has a direct shell-out primitive (Bash tool) available at all times —
// unlike the MCP transport, which requires a running MCP server connection
// the invoking session may or may not have open, or the skill-harness
// transport, which is really `mnemosyne-standalone`'s own action dispatch
// (bin/mnemosyne-skill-helper.mjs), a different skill's surface. The CLI is
// the one write surface guaranteed reachable from "a Claude Code skill
// session," with zero additional transport setup — the same reasoning
// persona.ts's `resolveRememberScope` doc comment already applies when
// picking `remember()`'s real target for this same caller. Nothing here
// stops a caller from instead driving `personaCreateAction` or the MCP
// `persona_create` tool directly with this module's `personaToYaml` output
// — they accept the identical YAML shape — but the CLI is this module's own
// default and the one SKILL.md documents.
//
// This module deliberately does NOT import writeGlobalPersona/
// writeRepoLocalPersona (persona-store-{global,repo-local}.ts) directly —
// doing so would be a second, in-process write path bypassing the CLI
// entirely, exactly what this story's acceptance criteria rules out ("not a
// new/parallel write path"). The only way this module ever touches disk is
// by spawning the real `mnemosyne persona create` subprocess, the same
// binary an operator or another transport would invoke.

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stringify } from 'yaml';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const PERSONA_CLI = path.join(REPO_ROOT, 'bin', 'mnemosyne-persona.mjs');

/**
 * Serializes a completed interview's Persona record (runPersonaInterview()'s
 * `persona` field — {tier, scopeId, displayName, scope, sections,
 * parentRefs?}) to the exact YAML document shape `mnemosyne persona create
 * --file <path>` expects. Uses the SAME `yaml` package
 * persona-store-global.ts/persona-store-repo-local.ts themselves call
 * (`stringify(candidate)`) for the write side of that pair — one document
 * shape for both directions (bin/mnemosyne-persona.mjs's own --file doc
 * comment), not a second, skill-specific encoding. `sections` (array of
 * {heading, body}) and `parentRefs` (array of {tier, scopeId}), when
 * present, round-trip through `stringify`/`parse` structurally unchanged —
 * no manual line-building, unlike test fixtures elsewhere in this repo that
 * hand-roll a YAML string for candidates they fully control the shape of.
 */
export function personaToYaml(persona) {
  return stringify(persona);
}

/**
 * Extracts the written file path from `mnemosyne persona create`'s own
 * stdout line: `created <global|repo-local> persona <tier>/<scopeId> -> <path>`
 * (bin/mnemosyne-persona.mjs's `runCreate`). Returns null if the line isn't
 * found (e.g. the write failed) — callers should treat that as "unknown,"
 * not synthesize a guessed path.
 */
function parseWrittenPath(stdout) {
  const m = stdout.match(/-> (.+)\s*$/m);
  return m ? m[1].trim() : null;
}

/**
 * Writes a completed interview's Persona record via a REAL `mnemosyne
 * persona create` CLI subprocess (bin/mnemosyne-persona.mjs, pw-05) — a real
 * `tsx`-launched OS process, not a simulated/in-process call. Mirrors
 * test/persona-cross-transport.mjs's and
 * lib/mnemosyne/layer1/__tests__/sync.integration.test.ts's own CLI-
 * subprocess helpers exactly (same `TSX_BIN`/`execFile` shape), reused here
 * as this skill's real output-writing step rather than only a test
 * fixture's private helper.
 *
 * `repo` — required for a code-architect persona (routes the CLI to the
 * repo-local store via its own `--repo`); omit for the 3 global tiers
 * (routes to the global store).
 * `root` — optional global-store root override, passed through as the
 * CLI's own `--root` (test isolation only — mirrors `persona seed`/
 * `persona create`'s own `--root`).
 * `home` — optional `$HOME` override for the spawned subprocess's
 * environment, so a caller (a test, or an isolated agent run) can point the
 * CLI's default global-store root at a throwaway directory instead of the
 * operator's real `~/.mnemosyne` — same convention
 * test/persona-cross-transport.mjs uses for its own fake-$HOME CLI calls.
 *
 * Returns `{ok, stdout, stderr, writtenPath}` — `writtenPath` is the real
 * on-disk path the CLI itself reported writing to (parsed from its own
 * stdout, never independently recomputed), or `null` on failure.
 */
export async function writePersonaViaCli(persona, { repo, root, home } = {}) {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'mnemosyne-persona-interview-'));
  const filePath = path.join(tmpDir, `${persona.tier}-${persona.scopeId}.yaml`);
  try {
    await writeFile(filePath, personaToYaml(persona), 'utf8');

    const args = ['create', '--file', filePath];
    if (repo) args.push('--repo', repo);
    if (root) args.push('--root', root);

    const env = { ...process.env };
    if (home) env.HOME = home;

    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [TSX_BIN, PERSONA_CLI, ...args], {
        cwd: REPO_ROOT,
        env,
      });
      return { ok: true, stdout: stdout.trim(), stderr: stderr.trim(), writtenPath: parseWrittenPath(stdout) };
    } catch (e) {
      return { ok: false, stdout: (e.stdout ?? '').trim(), stderr: (e.stderr ?? '').trim(), writtenPath: null };
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Reads a persona back via the REAL `mnemosyne persona show <tier>
 * <scope-id>` CLI subprocess (bin/mnemosyne-persona.mjs, pf-13) — only
 * valid for the 3 GLOBAL tiers (top-orchestrator/company-director/
 * project-orchestrator), same restriction `show` itself enforces
 * (PERSONA_STORE_BY_TIER). A code-architect (repo-local) persona has no CLI
 * `show` surface today, so callers reading one of those back must read the
 * repo-local store's file directly (e.g. `readRepoLocalPersona`,
 * persona-store-repo-local.ts) — the acceptance criteria's "via persona-show
 * or a direct file read" alternative exists for exactly this asymmetry.
 *
 * Returns `{ok, stdout, stderr}` — `stdout` is `show`'s plain-text
 * rendering (bin/mnemosyne-persona.mjs's `formatPersonaShow`), the same
 * text a real operator running the CLI would see.
 */
export async function showPersonaViaCli(tier, scopeId, { home } = {}) {
  const env = { ...process.env };
  if (home) env.HOME = home;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [TSX_BIN, PERSONA_CLI, 'show', tier, scopeId], {
      cwd: REPO_ROOT,
      env,
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e) {
    return { ok: false, stdout: (e.stdout ?? '').trim(), stderr: (e.stderr ?? '').trim() };
  }
}
