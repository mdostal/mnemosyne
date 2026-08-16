// persona-remember.mjs — pw-13-crawl-and-feed-wiring.
//
// Wires a completed interview's source material (pw-10's
// interview-engine.mjs `buildRememberText(persona)`) into a REAL
// `remember()` call, scoped via pw-09's `resolveRememberScope()` resolver
// (lib/mnemosyne/layer1/persona.ts) — design-discussion.md §3b/§8's
// "initial crawl and feeding" requirement, SKILL.md step 8. This is the
// actual convergence point of pw-09 (remember()-scope mapping) and
// pw-10/11/12 (interview mechanics): it imports interview-engine.mjs's
// `buildRememberText` unchanged (never a second, differently-shaped text
// builder) and never invents its own scope-mapping scheme.
//
// TWO real subprocess calls, mirroring persona-writer.mjs's (pw-11) own
// real-subprocess rigor — never a simulated/in-process call, never a
// hand-rolled write to any store:
//
//   1. resolveRememberScopeViaCli(persona) — spawns a REAL tsx-launched
//      `mnemosyne persona resolve-remember-scope --tier <tier> --scope-id
//      <scopeId>` subprocess (bin/mnemosyne-persona.mjs, extended by this
//      story with that subcommand), which imports and calls persona.ts's
//      `resolveRememberScope()` directly and prints its `{scope, tag}`
//      result as JSON. This is the SAME TS/JS-boundary pattern
//      persona-writer.mjs's `writePersonaViaCli` already uses for
//      `writeGlobalPersona`/`writeRepoLocalPersona`: a plain .mjs module
//      cannot import a .ts module directly (tsconfig's `noEmit: true` means
//      there is no build step), so the real TS function is invoked via a
//      real tsx subprocess rather than reimplemented or hand-copied here.
//      `resolveRememberScope` is pure (no filesystem, no randomness) — this
//      module still calls the REAL function via a real process boundary,
//      never a parallel/inline scope decision of its own.
//
//   2. fireRememberCall({text, scope, tag}, opts) — spawns a REAL
//      `node bin/mnemosyne-skill-helper.mjs remember '{"text":...}'`
//      subprocess (SKILL.md step 8's documented default transport): the
//      skill-harness's own `rememberAction`, which itself makes a real
//      `POST /remember` HTTP call to a running Mnemosyne service
//      (src/server.mjs, default port 8477) -> engine.mjs's `remember()`,
//      the one real target `resolveRememberScope()` was designed for
//      (persona.ts's doc comment, design-discussion.md §8). Chosen over the
//      MCP transport for the exact reason pw-11's own research step already
//      established for the persona-create write primitive: a live Claude
//      Code skill session always has a direct shell-out primitive (Bash
//      tool) available, but may not have an open MCP connection.
//
// `rememberInterviewSource(persona, opts)` composes both: resolve the scope
// via (1), build the text via interview-engine.mjs's `buildRememberText`
// (reused, never reinvented), then fire (2). It NEVER hardcodes or inline-
// decides a scope — every scope value used by the real remember() call
// originates from (1)'s real subprocess call, and is returned back to the
// caller so a test (or an operator) can independently confirm it matches
// `resolveRememberScope()`'s own output for the same {tier, scopeId}.
//
// Deliberately does NOT run even a maximally-skipped interview's crawl-and-
// feed as a no-op: `buildRememberText` always produces a non-empty string
// (persona.sections is never empty — the non-blocking hard-fail rule, pw-10/
// pw-12, guarantees at least the 3 skip-placeholder core sections), so this
// module has no "skip if minimal" branch to accidentally take.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildRememberText } from './interview-engine.mjs';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const PERSONA_CLI = path.join(REPO_ROOT, 'bin', 'mnemosyne-persona.mjs');
const SKILL_HELPER = path.join(REPO_ROOT, 'bin', 'mnemosyne-skill-helper.mjs');

export { buildRememberText };

/**
 * Resolves `{tier, scopeId}` to `{scope, tag}` by spawning a REAL
 * `mnemosyne persona resolve-remember-scope` CLI subprocess — never a
 * hand-copied re-derivation of persona.ts's `PERSONA_REMEMBER_SCOPE_BY_TIER`
 * mapping. Returns `{ok, scope, tag, stdout, stderr}` on success, or
 * `{ok: false, stdout, stderr, error}` if the subprocess fails (e.g. an
 * invalid tier — persona.ts's own guard, surfaced here verbatim, not
 * re-validated by this module).
 */
export async function resolveRememberScopeViaCli(persona) {
  const args = ['resolve-remember-scope', '--tier', persona.tier, '--scope-id', persona.scopeId];
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [TSX_BIN, PERSONA_CLI, ...args], {
      cwd: REPO_ROOT,
      env: process.env,
    });
    const trimmed = stdout.trim();
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      return { ok: false, stdout: trimmed, stderr: stderr.trim(), error: `could not parse resolver output as JSON: ${e.message}` };
    }
    return { ok: true, scope: parsed.scope, tag: parsed.tag, stdout: trimmed, stderr: stderr.trim() };
  } catch (e) {
    return { ok: false, stdout: (e.stdout ?? '').trim(), stderr: (e.stderr ?? '').trim(), error: e.message };
  }
}

/**
 * Fires the REAL `remember()` call by spawning a `node
 * bin/mnemosyne-skill-helper.mjs remember '<json>'` subprocess — the
 * skill-harness's own `rememberAction`, a thin pass-through to a real
 * `POST /remember` against a running Mnemosyne service. Never calls
 * engine.mjs's `remember()` in-process, and never POSTs directly with a
 * hand-rolled fetch() — this module goes through the exact CLI surface
 * SKILL.md step 8 documents as the default transport.
 *
 * `opts.port` — overrides the target service's port (default 8477, via
 * skill-helper's own PORT env convention) — mainly for test isolation
 * against a throwaway server instance.
 * `opts.env` — additional environment variables merged into the spawned
 * subprocess's env (e.g. SWARM_MEMORY_BIN/MNEMOSYNE_NOTES_DIR for pointing
 * a test server's own engine.mjs at a fixture instead of the real
 * swarm-memory install — those only matter to whichever process the
 * already-running server was itself started with, but PORT here is what
 * routes this client subprocess at that server).
 *
 * Returns `{ok, stdout, stderr, result, error}` — `result` is the parsed
 * JSON body skill-helper printed on success (POST /remember's own response
 * shape: `{remembered, scope, collection, file, chunks_upserted,
 * engine_output, status, source_ref, took_ms}`), unchanged.
 */
export async function fireRememberCall({ text, scope, tag }, opts = {}) {
  const argJson = JSON.stringify({ text, scope, tag });
  const env = { ...process.env, ...(opts.port ? { PORT: String(opts.port) } : {}), ...(opts.env || {}) };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SKILL_HELPER, 'remember', argJson], {
      cwd: REPO_ROOT,
      env,
    });
    let result = null;
    try {
      result = JSON.parse(stdout.trim());
    } catch {
      // Left null — caller sees ok:true but result:null if skill-helper's
      // own output shape ever changes; stdout is still returned raw below.
    }
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim(), result, error: null };
  } catch (e) {
    return { ok: false, stdout: (e.stdout ?? '').trim(), stderr: (e.stderr ?? '').trim(), result: null, error: e.message };
  }
}

/**
 * The real crawl-and-feed step (SKILL.md step 8): resolves this persona's
 * `remember()` scope via pw-09's real resolver, builds its remembered text
 * via pw-10's `buildRememberText` (reused unchanged), then fires a real
 * `remember()` call through the skill-harness's `remember` action.
 *
 * Fires unconditionally — there is no "skip if the interview was mostly
 * skipped" branch. A maximally-skipped interview's `persona.sections` still
 * has 3 non-empty skip-placeholder entries (pw-10/pw-12's non-blocking
 * hard-fail rule), so `buildRememberText` always returns real, non-empty
 * text and this function always attempts the real call.
 *
 * Returns `{ok, scope, tag, text, file, chunksUpserted, response, stdout,
 * stderr, error}`:
 *   - `ok` is true only if BOTH the scope resolution AND the remember()
 *     call itself succeeded (`response.remembered === true`).
 *   - `scope`/`tag` are exactly what `resolveRememberScopeViaCli` returned
 *     — never recomputed or overridden here.
 *   - `file` is the real on-disk note path `remember()` itself reported
 *     writing to (POST /remember's own response), for independent
 *     verification (e.g. `readFile(file)`).
 */
export async function rememberInterviewSource(persona, opts = {}) {
  const resolved = await resolveRememberScopeViaCli(persona);
  if (!resolved.ok) {
    return {
      ok: false,
      stage: 'resolve-scope',
      scope: null,
      tag: null,
      text: null,
      file: null,
      chunksUpserted: null,
      response: null,
      stdout: resolved.stdout,
      stderr: resolved.stderr,
      error: resolved.error || resolved.stderr || 'resolveRememberScopeViaCli failed',
    };
  }

  const text = buildRememberText(persona);
  const fired = await fireRememberCall({ text, scope: resolved.scope, tag: resolved.tag }, opts);
  const remembered = fired.ok && fired.result && fired.result.remembered === true;

  return {
    ok: remembered,
    stage: remembered ? 'done' : 'remember-call',
    scope: resolved.scope,
    tag: resolved.tag,
    text,
    file: fired.result?.file ?? null,
    chunksUpserted: fired.result?.chunks_upserted ?? null,
    response: fired.result,
    stdout: fired.stdout,
    stderr: fired.stderr,
    error: remembered ? null : fired.error || fired.stderr || 'remember() did not report remembered:true',
  };
}
