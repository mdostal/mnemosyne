/**
 * cm-05-usefulness-trash-triage (epic: mnemosyne-conversation-memory).
 *
 * Shared, low-level Gemini Developer API primitive (design-discussion.md
 * §9.6) — resolves the `dostal-shared-gemini` credential via Portunus's own
 * `{{secret:personalsites-487021-dostal-shared-gemini}}` reference AT CALL
 * TIME ONLY, enforces a caller-supplied bounded-input character cap BEFORE
 * any network call is made, parses the model's structured-JSON response,
 * and retries a rate-limited (429) response with bounded exponential
 * backoff before failing loudly. `cm-07`'s own, SEPARATE bounded call
 * imports this module UNCHANGED (design-discussion.md §9.6) — this is the
 * ONE shared Gemini call path, never reimplemented per-caller (`[grill
 * 4.1]`'s established convention, mirrored from `cm-04` importing `cm-03`'s
 * `types.ts` unchanged).
 *
 * Provider/credential, confirmed real this story's own research step
 * (design-discussion.md §9.1, §9.7): `dostal-shared-gemini`, resolved via
 * `gcloud secrets versions access latest --secret=dostal-shared-gemini
 * --project=personalsites-487021` — the SAME shared-swarm credential
 * family/access pattern as the already-proven-working `dostal-shared-
 * qdrant` key. `GOOGLE_GENERATIVE_AI_API_KEY` (a distinct, unrelated
 * production secret with its own rotation policy) is NEVER used here.
 * Confirmed live against the real API this story's research step (a real,
 * one-off `generateContent` call against `gemini-2.5-flash`, resolved via
 * the SAME `gcloud`/Portunus path below, key value never printed to any
 * tool output): `x-gemini-service-tier: standard` on the response —
 * `personalsites-487021`'s billing is enabled (confirmed via `gcloud
 * billing projects describe`), so this key sits on the paid, not free,
 * tier. The Gemini Developer API does not return an explicit RPM/TPM quota
 * in response headers, so this module does not hard-pin a request-rate
 * number anywhere — it handles rate limiting REACTIVELY, off the real
 * HTTP 429 status the API itself returns (see the retry/backoff below),
 * which is the correct mechanism regardless of the exact live quota.
 *
 * ---------------------------------------------------------------------------
 * Credential handling — the hard constraint this module exists to satisfy.
 * ---------------------------------------------------------------------------
 * The real, resolved API key is used ONLY as an in-memory outbound-request
 * credential (an `x-goog-api-key` HTTP header) for the single `fetch()`
 * call it authenticates. Concretely:
 *  - It is NEVER written to any file anywhere in this module (there is no
 *    file I/O in this module at all).
 *  - It is NEVER passed to `console.log`/`console.error`/any logging call
 *    (this module performs no logging of any kind).
 *  - It is NEVER interpolated into any thrown `Error`'s `message` string —
 *    every `GeminiClientError` constructed below is built exclusively from
 *    (a) caller-supplied, non-secret parameters (model id, char counts,
 *    attempt counts), (b) the HTTP response's own STATUS CODE, or (c) the
 *    HTTP response's own BODY text (which is Google's response to OUR
 *    request — it structurally cannot echo back a header WE sent). No
 *    catch block below reads `err.message` from a credential-resolution
 *    failure and forwards it verbatim; `resolveGeminiApiKey()`'s own catch
 *    block deliberately constructs a static, generic message instead (see
 *    below) rather than risk forwarding subprocess output.
 *  - It is NEVER placed in a request URL — a query-string `?key=...` would
 *    put the key at real risk of ending up in a logged/cached URL; the
 *    `x-goog-api-key` HEADER form is used instead, deliberately.
 *  - It is NEVER cached at module scope across calls: `resolveApiKey()` is
 *    invoked fresh on every single `callGemini()` call (the real default,
 *    `resolveGeminiApiKey()`, shells out to `gcloud` via `execFile` — an
 *    ARGUMENT ARRAY, never a shell string built via interpolation, mirrors
 *    this repo's own established `execFile`-only discipline, e.g.
 *    `lib/mnemosyne/onboarding/classify.ts`).
 * This story's own review step independently re-reads every catch/error-
 * construction path in this file specifically to confirm none of them can
 * ever include the resolved key value.
 *
 * ---------------------------------------------------------------------------
 * Testability.
 * ---------------------------------------------------------------------------
 * `fetchImpl` and `resolveApiKey` are both injectable (mirror
 * `ingestDocument.ts`'s `IngestClient` minimal-structural-interface
 * convention) so `geminiClient.test.ts` never makes a live network call or
 * shells out to `gcloud` — every test in that file stubs both.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Named constants — every one of these is a real, load-bearing value a test
// can assert against, never a scattered magic number.
// ---------------------------------------------------------------------------

/** Portunus/GCP secret name this module resolves — never `GOOGLE_GENERATIVE_AI_API_KEY` (see module doc comment). */
export const GEMINI_SECRET_NAME = 'dostal-shared-gemini';

/** The GCP project this story's research step confirmed has billing enabled (paid tier, not the more restrictive free tier). */
export const GEMINI_SECRET_PROJECT = 'personalsites-487021';

/** Gemini Developer API base URL (`generativelanguage.googleapis.com`, disambiguated from the unrelated consumer chat app and Gemini CLI — design-discussion.md §9.1 `[grill 2.1.1]`). */
export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Confirmed live and reachable this story's own research step (real `generateContent` call, `gemini-2.5-flash`) — a large-context (1,048,576 input tokens), billed-tier, non-preview model, appropriate for bounded classification/extraction work. */
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

/** Total HTTP attempts (including the first) before a persistent 429 fails loudly. */
export const DEFAULT_MAX_ATTEMPTS = 4;

/** Base for exponential backoff between 429 retries (`baseBackoffMs * 2^(attempt-1)`), in milliseconds. */
export const DEFAULT_BASE_BACKOFF_MS = 500;

/** Per-HTTP-attempt timeout (AbortController/signal, mirrors `crawlAndIngest.ts`'s own established `guardedFetch` pattern — never hangs indefinitely). */
export const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type GeminiClientErrorCode =
  | 'input_too_large'
  | 'rate_limited'
  | 'http_error'
  | 'malformed_response'
  | 'credential_resolution_failed'
  | 'timeout';

/** Raised for every failure this module can produce. `message` is ALWAYS safe to log/print in full — see module doc comment's credential-handling discipline. */
export class GeminiClientError extends Error {
  code: GeminiClientErrorCode;
  constructor(code: GeminiClientErrorCode, message: string) {
    super(message);
    this.name = 'GeminiClientError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Injectable HTTP / credential-resolution shapes (testability, see module
// doc comment).
// ---------------------------------------------------------------------------

export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

export interface FetchResponseLike {
  status: number;
  text(): Promise<string>;
}

/** Minimal structural slice of `fetch()` this module needs — real `globalThis.fetch` satisfies this directly; tests pass a scripted fake instead. */
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponseLike>;

export interface CallGeminiOptions {
  /** The full prompt text to send. Checked against `maxInputChars` BEFORE any network call (AC2). */
  prompt: string;
  /** Hard character-count ceiling on `prompt`. Caller-supplied — this module never assumes a default, so a caller can never accidentally omit its own bound. */
  maxInputChars: number;
  /** Gemini model id. Default `DEFAULT_GEMINI_MODEL`. */
  model?: string;
  /** Total attempts (including the first) before a persistent 429 fails loudly. Default `DEFAULT_MAX_ATTEMPTS`. */
  maxAttempts?: number;
  /** Base backoff (ms) for the exponential 429 retry schedule. Default `DEFAULT_BASE_BACKOFF_MS`. */
  baseBackoffMs?: number;
  /** Per-attempt timeout (ms). Default `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Injectable HTTP layer. Default real `globalThis.fetch`. Tests MUST supply a stub — see module doc comment. */
  fetchImpl?: FetchLike;
  /** Injectable credential resolver. Default `resolveGeminiApiKey` (real `gcloud`/Portunus resolution). Tests MUST supply a stub — see module doc comment. */
  resolveApiKey?: () => Promise<string>;
  /** Injectable backoff-sleep implementation. Default real `setTimeout`-based sleep. Tests inject an instant no-op so retry tests never incur real wall-clock delay. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface CallGeminiResult {
  /** The model's own response text, `JSON.parse`d (the model is asked for `responseMimeType: 'application/json'`). */
  raw: unknown;
  /** The model's own raw text response, pre-`JSON.parse` — never the API key; this is Gemini's OUTPUT, not our request. */
  rawText: string;
  /** How many HTTP attempts this call took (>= 1; > 1 only after one or more 429 retries). */
  attempts: number;
}

// ---------------------------------------------------------------------------
// Credential resolution (real default — see module doc comment for the
// full never-logged/never-persisted discipline).
// ---------------------------------------------------------------------------

/**
 * Resolves `dostal-shared-gemini` via `gcloud secrets versions access
 * latest --secret=dostal-shared-gemini --project=personalsites-487021`,
 * called via `execFile` with an ARGUMENT ARRAY (never a shell string built
 * via interpolation — no shell is invoked at all). The real key is
 * returned to the caller ONLY; this function never logs it, never writes
 * it anywhere, and on failure never forwards `gcloud`'s own stdout/stderr
 * into the thrown error (a deliberately conservative choice — see module
 * doc comment).
 */
export async function resolveGeminiApiKey(): Promise<string> {
  let stdout: string;
  try {
    const result = await execFileAsync('gcloud', [
      'secrets',
      'versions',
      'access',
      'latest',
      `--secret=${GEMINI_SECRET_NAME}`,
      `--project=${GEMINI_SECRET_PROJECT}`,
    ]);
    stdout = result.stdout;
  } catch {
    // Deliberately does NOT interpolate the caught error at all -- gcloud's
    // own stderr on failure describes ITS failure (auth/permission/not-
    // found), never a resolved secret value (resolution never succeeded
    // here), but forwarding subprocess output into an Error message is an
    // unnecessary risk surface this module chooses not to take.
    throw new GeminiClientError(
      'credential_resolution_failed',
      `Failed to resolve the '${GEMINI_SECRET_NAME}' secret via Portunus/gcloud (project ${GEMINI_SECRET_PROJECT}) -- confirm gcloud is authenticated and the secret is accessible. (Underlying gcloud output is intentionally never included in this message.)`,
    );
  }
  const key = stdout.trim();
  if (key.length === 0) {
    throw new GeminiClientError(
      'credential_resolution_failed',
      `Resolved an EMPTY value for the '${GEMINI_SECRET_NAME}' secret -- refusing to make an authenticated call with a blank credential.`,
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// Backoff sleep
// ---------------------------------------------------------------------------

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Response parsing — structured-JSON-response parsing (files_to_modify's
// own description of this module's job).
// ---------------------------------------------------------------------------

function extractCandidateText(envelope: unknown): string | null {
  if (!envelope || typeof envelope !== 'object') return null;
  const candidates = (envelope as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const first = candidates[0] as { content?: { parts?: unknown } } | undefined;
  const parts = first?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) return null;
  const text = (parts[0] as { text?: unknown } | undefined)?.text;
  return typeof text === 'string' ? text : null;
}

/** `responseText` is the HTTP response BODY only (Google's reply to OUR request) -- it can never contain the API key WE sent, so it is always safe to fold into a thrown error's message. */
function parseGeminiResponse(responseText: string, attempts: number): CallGeminiResult {
  let envelope: unknown;
  try {
    envelope = JSON.parse(responseText);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new GeminiClientError(
      'malformed_response',
      `Gemini API response was not valid JSON (${reason}) -- real response body (first 500 chars): ${responseText.slice(0, 500)}`,
    );
  }

  const text = extractCandidateText(envelope);
  if (text === null) {
    throw new GeminiClientError(
      'malformed_response',
      `Gemini API response did not contain a candidates[0].content.parts[0].text field -- real response body (first 500 chars): ${responseText.slice(0, 500)}`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new GeminiClientError(
      'malformed_response',
      `Gemini model's own response text was not valid JSON (${reason}), despite requesting responseMimeType: 'application/json' -- real model text (first 500 chars): ${text.slice(0, 500)}`,
    );
  }

  return { raw, rawText: text, attempts };
}

// ---------------------------------------------------------------------------
// HTTP call with timeout (AbortController/signal, mirrors crawlAndIngest.ts's
// established `guardedFetch` pattern).
// ---------------------------------------------------------------------------

async function fetchWithTimeout(fetchImpl: FetchLike, url: string, init: FetchInit, timeoutMs: number): Promise<FetchResponseLike> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new GeminiClientError(
        'timeout',
        `Gemini API call exceeded the ${timeoutMs}ms timeout -- aborted, never hangs indefinitely.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Calls Gemini's `generateContent` once (or, on a 429, up to `maxAttempts`
 * times total with bounded exponential backoff between attempts), and
 * returns the model's structured-JSON response, parsed.
 *
 * Enforcement order, matching this story's own AC2 exactly: `prompt.length`
 * is checked against `maxInputChars` BEFORE `resolveApiKey()` is even
 * called and BEFORE any network activity — an oversized prompt never
 * reaches the network layer at all.
 *
 * A persistent 429 (rate limited on every attempt) fails loudly with
 * `code: 'rate_limited'` — this function NEVER returns a guessed/default
 * value in place of a real response.
 */
export async function callGemini(options: CallGeminiOptions): Promise<CallGeminiResult> {
  const {
    prompt,
    maxInputChars,
    model = DEFAULT_GEMINI_MODEL,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch as unknown as FetchLike,
    resolveApiKey = resolveGeminiApiKey,
    sleepImpl = defaultSleep,
  } = options;

  if (prompt.length > maxInputChars) {
    throw new GeminiClientError(
      'input_too_large',
      `Prompt is ${prompt.length} chars, exceeding the ${maxInputChars}-char bounded-input cap -- rejected before any network call, never a silent truncate-then-send.`,
    );
  }

  const apiKey = await resolveApiKey();
  const url = `${GEMINI_API_BASE}/models/${model}:generateContent`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json' },
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetchWithTimeout(
      fetchImpl,
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body },
      timeoutMs,
    );

    if (response.status === 429) {
      if (attempt < maxAttempts) {
        const backoffMs = baseBackoffMs * 2 ** (attempt - 1);
        await sleepImpl(backoffMs);
        continue;
      }
      throw new GeminiClientError(
        'rate_limited',
        `Gemini API returned HTTP 429 (rate limited) on all ${maxAttempts} attempt(s), with exponential backoff between each -- failing loudly rather than returning a guessed/default verdict.`,
      );
    }

    if (response.status < 200 || response.status >= 300) {
      throw new GeminiClientError(
        'http_error',
        `Gemini API returned HTTP ${response.status} (non-429, non-2xx) on attempt ${attempt}/${maxAttempts} -- not retried.`,
      );
    }

    const responseText = await response.text();
    return parseGeminiResponse(responseText, attempt);
  }

  // Unreachable given maxAttempts >= 1 (every loop iteration above either
  // returns or throws) -- named loudly rather than silently falling
  // through if a future edit ever changes that invariant.
  throw new GeminiClientError(
    'rate_limited',
    `callGemini() exhausted ${maxAttempts} attempt(s) without returning or throwing -- this should be unreachable.`,
  );
}
