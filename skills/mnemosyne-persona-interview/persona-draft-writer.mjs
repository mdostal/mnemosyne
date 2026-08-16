// persona-draft-writer.mjs — pu-08-draft-first-interview-flow.
//
// The DEFAULT write target for a completed interview (SKILL.md step 7,
// post-pu-08): wires interview-engine.mjs's `runPersonaInterview()` output
// into a REAL call to pu-04's `mnemosyne persona draft propose --file <path>
// [--repo <repo>]` subcommand (bin/mnemosyne-persona.mjs) — never `persona
// create`. This is a SEPARATE, sibling module to persona-writer.mjs, not a
// parameterized version of it: persona-writer.mjs's own `--commit-directly`
// escape-hatch path must stay LITERALLY unchanged, by construction, so it can
// never accidentally diverge just because this file's own behavior evolves
// (pu-08's own risk mitigation, .pHive/epics/mnemosyne-persona-ux/stories/
// pu-08-draft-first-interview-flow.yaml).
//
// Mirrors persona-writer.mjs's `writePersonaViaCli`'s exact real-subprocess-
// spawn shape (same `TSX_BIN`/`execFile` mechanics, same throwaway-tmpfile-
// then-subprocess pattern) — deliberately duplicated here rather than
// imported from persona-writer.mjs, for the same "structurally separate, not
// a shared parameterized helper" reason above.
//
// WHY THE CLI, CONCRETELY: identical reasoning to persona-writer.mjs's own
// doc comment — this skill runs INSIDE a live Claude Code (or similar) agent
// session, which always has a direct shell-out primitive (Bash tool)
// available, unlike the MCP transport (needs an open MCP connection the
// session may or may not have) or the skill-harness transport (a different
// skill's own action dispatch). The CLI is the one write surface guaranteed
// reachable with zero additional transport setup.
//
// This module deliberately does NOT import writeGlobalPersona/
// writeRepoLocalPersona (persona-store-{global,repo-local}.ts) directly, and
// does NOT import persona-writer.mjs's writePersonaViaCli or
// persona-remember.mjs's rememberInterviewSource — the only way it ever
// touches disk is by spawning the real `mnemosyne persona draft propose`
// subprocess, and it never calls `persona create` or fires `remember()`
// itself. A human-approval step (pu-03's HTTP approve route / pu-04's CLI
// `draft approve`) is what eventually commits an approved draft and fires
// remember() — out of this module's own scope entirely.

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
 * Builds the draft candidate `persona draft propose --file <path>` expects:
 * a completed interview's `persona` record (runPersonaInterview()'s own
 * output shape — {tier, scopeId, displayName, scope, sections,
 * parentRefs?}) PLUS three draft-only metadata keys
 * (persona-draft-store.ts's own doc comment; test/persona-cli.mjs's
 * `personaCandidateYaml` helper documents the identical three-key
 * convention):
 *   - `proposedBy` — who/what proposed this draft. Defaults to `'agent'`
 *     (this skill always proposes as an agent, never a human typing
 *     directly through some other path).
 *   - `proposedAt` — an ISO 8601 timestamp. Defaults to `new
 *     Date().toISOString()` at call time if not supplied.
 *   - `sourceSummary` — pu-07's bounded crawl-context summary
 *     (`crawl-context.mjs`'s `crawlBoundedContext()` result), attached
 *     unchanged so a later human reviewer can see *why* the agent proposed
 *     what it proposed (design-discussion.md §3c). Omitted entirely (not set
 *     to an empty string) when not supplied.
 *
 * These three keys are ONLY valid on a draft candidate — `create`'s own
 * candidates (persona-writer.mjs's `personaToYaml`) never carry them.
 */
export function personaToDraftCandidate(persona, { proposedBy = 'agent', proposedAt, sourceSummary } = {}) {
  const candidate = {
    ...persona,
    proposedBy,
    proposedAt: proposedAt ?? new Date().toISOString(),
  };
  if (sourceSummary !== undefined) candidate.sourceSummary = sourceSummary;
  return candidate;
}

/**
 * Serializes a draft candidate (persona + draft-only metadata) with the SAME
 * `yaml` package call (`stringify(candidate)`) persona-writer.mjs's
 * `personaToYaml` and persona-draft-store.ts's own `writeDraftPersona` use —
 * one document shape, not a second, skill-specific encoding.
 */
export function personaDraftToYaml(persona, opts = {}) {
  return stringify(personaToDraftCandidate(persona, opts));
}

/**
 * Extracts the written file path from `mnemosyne persona draft propose`'s
 * own stdout line: `proposed draft <tier>/<scopeId> -> <path>`
 * (bin/mnemosyne-persona.mjs's `runDraftPropose`). Returns null if the line
 * isn't found (e.g. the write failed) — same convention persona-writer.mjs's
 * own `parseWrittenPath` uses for `create`'s `created ... -> <path>` line;
 * both share the trailing `-> <path>` shape, so this is the identical
 * regex, deliberately re-declared here rather than imported (this module
 * stays a self-contained sibling, never a parameterized wrapper around
 * persona-writer.mjs).
 */
function parseWrittenPath(stdout) {
  const m = stdout.match(/-> (.+)\s*$/m);
  return m ? m[1].trim() : null;
}

/**
 * Proposes a completed interview's Persona record as a DRAFT via a REAL
 * `mnemosyne persona draft propose` CLI subprocess (bin/mnemosyne-persona.mjs,
 * pu-04) — a real `tsx`-launched OS process, not a simulated/in-process call.
 * Mirrors persona-writer.mjs's `writePersonaViaCli` almost exactly: same
 * throwaway-tmpfile-then-subprocess shape, same `{repo, home}` options — with
 * one deliberate difference: `draft propose` has no `--root` flag (only
 * `create`/`seed` do, bin/mnemosyne-persona.mjs's own USAGE_DRAFT), so this
 * function accepts no `root` option; global-tier test isolation goes through
 * `home` (an overridden `$HOME` for the spawned subprocess), exactly like
 * test/persona-cli.mjs's own draft-propose fixtures already do.
 *
 * `repo` — required for a code-architect candidate (routes the CLI to the
 * repo-local draft subtree via its own `--repo`); omit for the 3 global
 * tiers.
 * `home` — optional `$HOME` override for the spawned subprocess's
 * environment, so a caller (a test, or an isolated agent run) can point the
 * CLI's default global-tier draft root (`~/.mnemosyne/persona-drafts`) at a
 * throwaway directory instead of the operator's real `~/.mnemosyne`.
 * `proposedBy`/`proposedAt`/`sourceSummary` — draft-only metadata, see
 * `personaToDraftCandidate` above.
 *
 * Returns `{ok, stdout, stderr, writtenPath}` — `writtenPath` is the real
 * on-disk draft path the CLI itself reported writing to (parsed from its own
 * stdout, never independently recomputed), or `null` on failure.
 */
export async function writeDraftPersonaViaCli(
  persona,
  { repo, home, proposedBy, proposedAt, sourceSummary } = {},
) {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'mnemosyne-persona-interview-draft-'));
  const filePath = path.join(tmpDir, `${persona.tier}-${persona.scopeId}.yaml`);
  try {
    await writeFile(filePath, personaDraftToYaml(persona, { proposedBy, proposedAt, sourceSummary }), 'utf8');

    const args = ['draft', 'propose', '--file', filePath];
    if (repo) args.push('--repo', repo);

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
