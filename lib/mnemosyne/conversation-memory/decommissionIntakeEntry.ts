/**
 * cm-14-intake-decommission (epic: mnemosyne-conversation-memory).
 *
 * The epic's ONE, deliberate, narrowly-scoped delete-capable operation --
 * see `.pHive/epics/mnemosyne-conversation-memory/stories/
 * cm-14-intake-decommission.yaml` for the full brief, and its own dedicated
 * `severity: critical` risk entry for why this exception is safe and what
 * structurally prevents it from ever reaching anything else. NEVER built or
 * run automatically as part of this epic's own pipeline -- gated behind a
 * separate, explicit, individually-given operator go-ahead every time this
 * module is actually invoked for real.
 *
 * ---------------------------------------------------------------------------
 * Scope, stated precisely (mirrors the story's own opening framing).
 * ---------------------------------------------------------------------------
 * Removes exactly ONE already-distributed intake entry -- its own original
 * `conversation_memory_intake` point AND its own `distribution_marker`
 * point (both now redundant), and NOTHING else. Never touches the real
 * destination copy (`meta` or a confirmed scope's own collection). Never
 * touches a source transcript. Never touches any entry that has not been
 * independently, live-reconfirmed as both marked distributed AND actually
 * present at its real destination.
 *
 * ---------------------------------------------------------------------------
 * Research findings, real and live, this story's own research step
 * (2026-09-07, this session) -- never assumed from general documentation.
 * ---------------------------------------------------------------------------
 *
 * 1. **The real, live Qdrant `points/delete` REST request/response shape,
 *    confirmed directly against the operator's own live Qdrant Cloud
 *    cluster** by creating a disposable, clearly-named probe collection
 *    (`mnemosyne_decommission_probe_temp`, via `HttpQdrantClient.
 *    create_collection()` -- ro-06's own one existing additive exception,
 *    reused unchanged), upserting synthetic points, and calling the REAL
 *    delete endpoint against them (never any real collection):
 *    `POST /collections/{name}/points/delete?wait=true` with body
 *    `{"points": [<id>, <id>, ...]}` (Qdrant's own by-ID `PointsSelector`
 *    variant -- this story only ever deletes two KNOWN point ids, never a
 *    filter-by-payload selector) returns
 *    `{"result": {"operation_id": <int>, "status": "completed"}, "status":
 *    "ok", "time": <float>}` when `wait=true` is set (confirmed: omitting
 *    `wait=true` instead returns `"status": "acknowledged"`, an async ack
 *    this story's own loud-failure/backup-ordering guarantee should never
 *    have to poll for -- `wait=true` is therefore always used here). See
 *    `makeHttpQdrantDeletePointsFn()` below.
 *
 * 2. **`cm-13`'s own `scroll_points()`/marker contract, re-confirmed live**
 *    against the real, current `conversation_memory_intake` collection
 *    (read-only, this story's own research step, 70 real points, 34
 *    candidates / 34 markers): every real `distribution_marker` point's
 *    parsed provenance carries exactly `{entry_id, entry_type,
 *    marks_entry_id, distributed_to_scope, distributed_at}` -- byte-for-byte
 *    `distributeIntakeEntries.ts`'s own `DistributionMarkerMetadata`
 *    interface, imported and reused directly below, never redefined.
 *
 * 3. **The real Qdrant URL/API-key resolution this module's own Qdrant HTTP
 *    calls reuse** -- the identical two-step fallback `mnemosyne/inventory/
 *    qdrant_inventory.py`'s `read_qdrant_key()`/`load_qdrant_url()` already
 *    implement (a plain key file first, falling back to `config.toml`'s
 *    `[qdrant].api_key_cmd`/`[qdrant].url`), ported to TS below
 *    (`resolveQdrantApiKey()`/`resolveQdrantUrl()`) rather than shelled out
 *    to Python -- this module's own delete call is a direct `fetch()`
 *    against Qdrant's REST API, not a second cross-language bridge. Real,
 *    live-confirmed this session: the operator's own `~/.config/
 *    swarm-memory/config.toml` has no plain `qdrant.key` file, so every
 *    real invocation resolves the key via `[qdrant].api_key_cmd` (a
 *    `gcloud secrets versions access` call) -- confirmed working directly.
 *
 * 4. **The real CLI/operator-invocation surface (this story's own research
 *    step decision, §11.5's open choice, now closed):** a fully separate
 *    verb/binary, `bin/mnemosyne-conversation-decommission.mjs`, mirroring
 *    this epic's own established thin-CLI convention (`bin/mnemosyne-
 *    conversation-triage-review.mjs`) exactly -- never a flag bolted onto
 *    any existing, more general command, so this capability is never one
 *    accidental flag away from a caller that didn't mean to reach it.
 *
 * ---------------------------------------------------------------------------
 * The two independent, live, immediately-pre-delete precondition checks
 * (§11.4(b)) -- either failing means REFUSE loudly, zero delete call made.
 * ---------------------------------------------------------------------------
 *  (1) Marker re-check: `scrollPoints(INTAKE_COLLECTION_NAME)` (cm-13's own
 *      primitive, injected, REQUIRED -- reused, never reimplemented) is
 *      re-read live, right now, and a real `distribution_marker` point
 *      naming this EXACT `entryId` must exist. A stale/cached report from
 *      an earlier `cm-13` run is never trusted -- only this live re-read.
 *  (2) Destination re-check: the marker's own `distributed_to_scope` is
 *      independently queried (via the injected `recall`, this module's own
 *      async-shaped mirror of `MnemosyneClient.recall()`, `lib/mnemosyne/
 *      client.ts` -- REQUIRED, never a default production client
 *      constructed here) for a hit whose OWN embedded provenance header
 *      (`parseProvenanceHeader()`, cm-07's own reused, unchanged reader)
 *      names this EXACT `entryId`, with an exact-match `content_hash`
 *      cross-check (sha256 of the original point's own persisted text,
 *      mirroring `VectorLayerAdapter`'s/`FileLayerAdapter`'s own
 *      `content_hash = sha256(text)` convention) whenever the hit reports
 *      one. Any failure or inconclusive result (recall failure, no
 *      matching hit, a present-but-mismatched hash) REFUSES -- fails
 *      closed, never fuzzy/similarity-based (this story's own `severity:
 *      high` risk register entry).
 *
 * ---------------------------------------------------------------------------
 * Backup (§11.4(c)) -- default ON, before the delete call, never after.
 * ---------------------------------------------------------------------------
 * Writes a timestamped NDJSON file (two lines: the original intake entry's
 * own full text+metadata, and its marker's own full text+metadata -- the
 * exact two points about to be removed) to `~/.mnemosyne/
 * intake-decommission-backups/<timestamp>-<entryId>.ndjson`, mirroring the
 * `~/.mnemosyne/` config-directory family `DEFAULT_TRIAGE_QUEUE_PATH`
 * already lives in. A write failure (disk full, permissions) fails LOUD and
 * aborts BEFORE the delete call -- never a silent proceed-to-delete-anyway.
 * `skipBackup: true` is the ONLY way to reach the no-backup path ("full
 * wipe") -- never the default invocation shape.
 *
 * ---------------------------------------------------------------------------
 * The delete primitive itself -- deliberately NEVER added to
 * `HttpQdrantClient` (mnemosyne/inventory/qdrant_inventory.py). That class's
 * own "no delete/drop method exists anywhere in this module" contract
 * (its own module docstring, ro-06's own risk mitigation) stays true for
 * every OTHER caller, forever, precisely because this story never touches
 * it -- verified by a byte-for-byte diff of that file showing zero changes.
 * `QdrantDeletePointsFn` (below) takes ONLY `pointIds: string[]` -- no
 * collection-name parameter exists anywhere on its signature, so
 * `decommissionIntakeEntry()` itself has no code path capable of ever
 * passing ANY collection value, caller-supplied or otherwise. The real
 * production implementation (`makeHttpQdrantDeletePointsFn()`) binds
 * `INTAKE_COLLECTION_NAME` (imported from `distributeIntakeEntries.ts`,
 * reused byte-for-byte, never redefined) into its request URL at
 * construction time -- structurally, not merely by convention, this
 * primitive can never be redirected against `meta` or any confirmed real
 * scope's own collection.
 *
 * ---------------------------------------------------------------------------
 * Single-entry-only, structurally (§11.4(a)).
 * ---------------------------------------------------------------------------
 * `decommissionIntakeEntry()` accepts exactly one `entryId: string` --
 * never an array, never a filter, never a wildcard. There is no code path
 * anywhere in this file that could delete more than the two points (the
 * one entry's own point + its own marker) belonging to that single,
 * operator-named `entryId`.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { execSync, type ExecSyncOptions } from 'node:child_process';
import type { Intent, Scope } from '../interfaces.js';
import { parseProvenanceHeader, type EntryProvenanceMetadata } from './distillAndRemember.js';
import {
  INTAKE_COLLECTION_NAME,
  type DistributionMarkerMetadata,
  type ScrolledPoint,
  type ScrollPointsFn,
} from './distributeIntakeEntries.js';

// Re-exported so callers (this story's own CLI) never need a second import
// site for the SAME fixed collection name this module's checks and delete
// call both hardcode against.
export { INTAKE_COLLECTION_NAME };
export type { ScrolledPoint, ScrollPointsFn };

// ---------------------------------------------------------------------------
// Result shapes carrying an `entryId`, satisfying "recall()" as this
// module's own minimal shape for the destination check (see module doc
// comment, finding 3-adjacent design note below).
// ---------------------------------------------------------------------------

/** Mirrors `interfaces.ts`'s real `Hit`/`RecallResult` shapes exactly (this module never redefines them) -- imported directly, not redeclared. */
import type { Hit, RecallResult } from '../interfaces.js';

/**
 * This module's OWN async-shaped injectable destination-check primitive --
 * mirrors `MnemosyneClient.recall()`'s REAL signature (`lib/mnemosyne/
 * client.ts`, `async recall(query, scope, intent?)`), not `interfaces.ts`'s
 * `RecallFn` (declared synchronous there for that file's own
 * contract-literalism reasons -- see that file's doc comment). The SAME
 * accepted deviation `distributeIntakeEntries.ts`'s own `ScrollPointsFn`
 * already takes for its own injected primitive, applied here a second time.
 * REQUIRED -- no default production `MnemosyneClient` is constructed by
 * this module itself; a real production implementation is expected to be
 * `client.recall.bind(client)` for a real, wired `MnemosyneClient` (see
 * `bin/mnemosyne-conversation-decommission.mjs`'s own direct-run wiring).
 * Tests MUST supply a fake -- never live Qdrant, never a real recall call.
 */
export type RecallFn = (query: string, scope: Scope, intent?: Intent) => Promise<RecallResult>;

/** Real result of one `POST /collections/{name}/points/delete` call. */
export interface QdrantDeleteResult {
  ok: boolean;
  operationId?: number;
  status?: string;
  error?: string;
  raw?: unknown;
}

/**
 * This module's own injectable delete primitive. Deliberately carries NO
 * collection-name parameter anywhere on its signature -- see module doc
 * comment's "delete primitive itself" section for why this is a
 * structural, not conventional, guarantee that the intake collection can
 * never be redirected. REQUIRED -- no default production implementation is
 * constructed by `decommissionIntakeEntry()` itself (only by this module's
 * own separate `makeHttpQdrantDeletePointsFn()` factory, called explicitly
 * by production wiring, never implicitly). Tests MUST supply a fake --
 * NEVER a live Qdrant delete call in the automated suite (this story's own
 * hard constraint, exceeding every other story's in this epic).
 */
export type QdrantDeletePointsFn = (pointIds: string[]) => Promise<QdrantDeleteResult>;

// ---------------------------------------------------------------------------
// Qdrant URL/API-key resolution -- ports mnemosyne/inventory/
// qdrant_inventory.py's read_qdrant_key()/load_qdrant_url() to TS, same
// two-step fallback, same default paths. Never imports the Python module
// (no such bridge exists) -- a deliberate, small, separate re-implementation
// of the SAME resolution approach, mirroring extract_intake_provenance()'s
// own already-accepted "same format, two small independent
// implementations" precedent (cm-16, docs/design-discussion.md §12.3).
// ---------------------------------------------------------------------------

export const DEFAULT_QDRANT_KEY_PATH = path.join(homedir(), '.config', 'swarm-memory', 'qdrant.key');
export const DEFAULT_QDRANT_CONFIG_PATH = path.join(homedir(), '.config', 'swarm-memory', 'config.toml');
export const DEFAULT_BACKUP_DIR = path.join(homedir(), '.mnemosyne', 'intake-decommission-backups');

/**
 * Reads one `key = "value"` (or bare, unquoted) entry from a fixed
 * `[section]` in a simple INI/TOML-subset config file -- sufficient for
 * `config.toml`'s own real, observed shape (`[qdrant]` / `url` /
 * `api_key_cmd`, quoted string values, `#`-prefixed comment lines). Never a
 * general TOML parser -- mirrors Python's `configparser`-based reading
 * exactly for this narrow, already-confirmed-real shape, not a superset.
 */
function readIniValue(configText: string, section: string, key: string): string | null {
  let currentSection: string | null = null;
  for (const rawLine of configText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      currentSection = sectionMatch[1]!.trim();
      continue;
    }
    if (currentSection !== section) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() !== key) continue;
    return line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return null;
}

/**
 * Resolves the real Qdrant API key: a plain key file first (backward
 * compatible), falling back to `[qdrant].api_key_cmd` from `config.toml`
 * when the file doesn't exist -- byte-for-byte the same fallback
 * `read_qdrant_key()` (mnemosyne/inventory/qdrant_inventory.py) implements,
 * confirmed working live against the operator's own real config this
 * session (no plain key file exists; resolution falls through to a real
 * `gcloud secrets versions access` command). The resolved value is used
 * in-memory for this process's own Qdrant calls only -- never written to
 * disk (same standing rule `read_qdrant_key()`'s own doc comment states).
 */
export function resolveQdrantApiKey(
  options: { keyPath?: string; configPath?: string; runCommand?: (cmd: string, opts: ExecSyncOptions) => string | Buffer } = {},
): string {
  const keyPath = options.keyPath ?? DEFAULT_QDRANT_KEY_PATH;
  const configPath = options.configPath ?? DEFAULT_QDRANT_CONFIG_PATH;
  const run = options.runCommand ?? execSync;

  try {
    const key = readFileSync(keyPath, 'utf8').trim();
    if (!key) {
      throw new Error(`Qdrant API key file is empty: ${keyPath}`);
    }
    return key;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  let configText: string;
  try {
    configText = readFileSync(configPath, 'utf8');
  } catch {
    throw new Error(
      `Qdrant API key file missing: ${keyPath}, and no config found at ${configPath} to resolve [qdrant].api_key_cmd from`,
    );
  }
  const apiKeyCmd = readIniValue(configText, 'qdrant', 'api_key_cmd');
  if (!apiKeyCmd) {
    throw new Error(`Qdrant API key file missing: ${keyPath}, and ${configPath} has no [qdrant].api_key_cmd to fall back to`);
  }
  const stdout = run(apiKeyCmd, { encoding: 'utf8', timeout: 30_000 }).toString().trim();
  if (!stdout) {
    throw new Error(`api_key_cmd from ${configPath} returned an empty key`);
  }
  return stdout;
}

/** Resolves the real Qdrant URL -- `SWARM_MEMORY_QDRANT_URL` env first, then `[qdrant].url` from `config.toml`. Mirrors `load_qdrant_url()` exactly. */
export function resolveQdrantUrl(options: { configPath?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const configPath = options.configPath ?? DEFAULT_QDRANT_CONFIG_PATH;
  const env = options.env ?? process.env;

  const envUrl = env.SWARM_MEMORY_QDRANT_URL;
  if (envUrl) {
    return envUrl.replace(/\/+$/, '');
  }

  let configText: string;
  try {
    configText = readFileSync(configPath, 'utf8');
  } catch {
    throw new Error(`Qdrant URL not configured: set SWARM_MEMORY_QDRANT_URL or create ${configPath}`);
  }
  const url = readIniValue(configText, 'qdrant', 'url');
  if (!url) {
    throw new Error(`Qdrant URL missing from ${configPath}`);
  }
  return url.replace(/\/+$/, '');
}

/**
 * Builds the REAL production `QdrantDeletePointsFn` -- a direct `fetch()`
 * against Qdrant's native `POST /collections/{name}/points/delete?wait=true`
 * endpoint, request/response shape confirmed live this story's own research
 * step (module doc comment, finding 1). `INTAKE_COLLECTION_NAME` is bound
 * into the request URL HERE, at construction time, from this module's own
 * import -- never accepted as a parameter, so no caller of the returned
 * function (including `decommissionIntakeEntry()` itself) has any way to
 * redirect it against a different collection. Never called by this
 * module's own automated test suite (which supplies a hand-written fake
 * `QdrantDeletePointsFn` instead) -- only by real production wiring
 * (`bin/mnemosyne-conversation-decommission.mjs`'s direct-run block).
 */
export function makeHttpQdrantDeletePointsFn(
  options: { apiKey?: string; url?: string; fetchImpl?: typeof fetch } = {},
): QdrantDeletePointsFn {
  const apiKey = options.apiKey ?? resolveQdrantApiKey();
  const url = options.url ?? resolveQdrantUrl();
  const doFetch = options.fetchImpl ?? fetch;

  return async function deletePoints(pointIds: string[]): Promise<QdrantDeleteResult> {
    const endpoint = `${url}/collections/${INTAKE_COLLECTION_NAME}/points/delete?wait=true`;
    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'api-key': apiKey },
        body: JSON.stringify({ points: pointIds }),
      });
    } catch (err) {
      return { ok: false, error: `Qdrant unreachable at ${url}: ${(err as Error).message}` };
    }

    let raw: unknown = null;
    try {
      raw = await response.json();
    } catch {
      // leaves raw: null -- handled as a non-"completed" status below.
    }

    if (!response.ok) {
      return { ok: false, error: `Qdrant POST /collections/${INTAKE_COLLECTION_NAME}/points/delete failed with HTTP ${response.status}`, raw };
    }

    const result = (raw as { result?: { operation_id?: number; status?: string } } | null)?.result;
    const status = result?.status;
    const operationId = result?.operation_id;
    return {
      ok: status === 'completed',
      raw,
      ...(operationId !== undefined ? { operationId } : {}),
      ...(status !== undefined ? { status } : {}),
    };
  };
}

// ---------------------------------------------------------------------------
// decommissionIntakeEntry() -- the public entry point.
// ---------------------------------------------------------------------------

function extractPointText(point: ScrolledPoint): string | null {
  const text = point.payload?.text;
  return typeof text === 'string' ? text : null;
}

export interface DecommissionIntakeEntryOptions {
  /** The ONE entry to decommission -- structurally always a single string, never an array/pattern/wildcard (§11.4(a)). */
  entryId: string;
  /** Injectable, REQUIRED -- cm-13's own read-only intake-enumeration primitive, reused, never reimplemented. Tests MUST supply a stub -- never live Qdrant. */
  scrollPoints: ScrollPointsFn;
  /** Injectable, REQUIRED -- the live destination re-check. Tests MUST supply a fake -- never live Qdrant. */
  recall: RecallFn;
  /** Injectable, REQUIRED -- the Qdrant points/delete primitive. Tests MUST supply a fake -- never a live delete call. */
  deletePoints: QdrantDeletePointsFn;
  /** Explicit, named opt-out ONLY -- default `false` (backup ON). The operator's own "or just full wipe" option (§11.4(c)). */
  skipBackup?: boolean;
  /** Where the backup NDJSON is written. Default `DEFAULT_BACKUP_DIR`. Tests override with a temp-dir path. */
  backupDir?: string;
  /** Injectable directory-creation, for deterministic tests. Default real `mkdirSync(dir, { recursive: true })`. */
  ensureBackupDir?: (dirPath: string) => void;
  /** Injectable backup file write, for deterministic/order-observing tests. Default real `writeFileSync(path, content, 'utf8')`. */
  writeBackupFile?: (filePath: string, content: string) => void;
  /** Injectable clock, for deterministic backup filenames in tests. Default real `() => new Date()`. */
  now?: () => Date;
}

export type DecommissionRefusalReason =
  | 'invalid_entry_id'
  | 'no_marker_found'
  | 'original_point_missing'
  | 'destination_not_confirmed'
  | 'backup_write_failed'
  | 'delete_failed';

/** A refusal (or a post-attempt delete failure) -- `ok: false` in every case, `reason` names exactly why. NO delete call is ever made for `invalid_entry_id`/`no_marker_found`/`original_point_missing`/`destination_not_confirmed`. */
export interface DecommissionRefusal {
  ok: false;
  entryId: string;
  reason: DecommissionRefusalReason;
  detail: string;
}

export interface DecommissionSuccess {
  ok: true;
  entryId: string;
  /** The marker's own real `distributed_to_scope` value (`'meta'` or a confirmed scope key) -- the destination this entry's content was independently reconfirmed present at. */
  destinationScope: string;
  /** Exactly two point ids: the original entry's own point, then its own distribution_marker point -- never a third. */
  deletedPointIds: [string, string];
  /** The real backup file path, or `null` when `skipBackup: true` was explicitly given. */
  backupPath: string | null;
}

export type DecommissionResult = DecommissionRefusal | DecommissionSuccess;

function refuse(entryId: string, reason: DecommissionRefusalReason, detail: string): DecommissionRefusal {
  return { ok: false, entryId, reason, detail };
}

/**
 * Decommissions exactly ONE already-distributed intake entry. See this
 * module's own top-of-file doc comment for the full sequence (live marker
 * re-check -> live destination re-check -> optional backup -> delete). Any
 * precondition failure REFUSES loudly and makes NO delete call at all.
 */
export async function decommissionIntakeEntry(options: DecommissionIntakeEntryOptions): Promise<DecommissionResult> {
  const { entryId, scrollPoints, recall, deletePoints } = options;
  const backupDir = options.backupDir ?? DEFAULT_BACKUP_DIR;
  const now = options.now ?? (() => new Date());
  const ensureBackupDir = options.ensureBackupDir ?? ((dir: string) => mkdirSync(dir, { recursive: true }));
  const writeBackupFile = options.writeBackupFile ?? ((filePath: string, content: string) => writeFileSync(filePath, content, 'utf8'));

  if (typeof entryId !== 'string' || entryId.trim().length === 0) {
    return refuse(entryId, 'invalid_entry_id', 'entry_id must be a non-empty string');
  }

  // (1) Live re-read of the intake collection -- the intake collection's
  // OWN fixed, hardcoded name, never any other, never caller-parameterized
  // (imported constant, reused). Never a cached/stale report.
  const points = await scrollPoints(INTAKE_COLLECTION_NAME);

  let markerPoint: ScrolledPoint | null = null;
  let marker: DistributionMarkerMetadata | null = null;
  let markerText: string | null = null;
  let originalPoint: ScrolledPoint | null = null;
  let originalMetadata: EntryProvenanceMetadata | null = null;
  let originalText: string | null = null;

  for (const point of points) {
    const text = extractPointText(point);
    if (text === null) continue;
    const parsed = parseProvenanceHeader(text);
    if (parsed === null) continue;

    if ((parsed as unknown as { entry_type: string }).entry_type === 'distribution_marker') {
      const candidateMarker = parsed as unknown as DistributionMarkerMetadata;
      if (candidateMarker.marks_entry_id === entryId) {
        markerPoint = point;
        marker = candidateMarker;
        markerText = text;
      }
    } else if (parsed.entry_id === entryId) {
      originalPoint = point;
      originalMetadata = parsed;
      originalText = text;
    }
  }

  if (marker === null || markerPoint === null || markerText === null) {
    return refuse(
      entryId,
      'no_marker_found',
      `precondition not met: entry not marked distributed -- a live re-read of ${INTAKE_COLLECTION_NAME} found no distribution_marker naming entry_id ${entryId}`,
    );
  }

  if (originalPoint === null || originalMetadata === null || originalText === null) {
    return refuse(
      entryId,
      'original_point_missing',
      `entry_id ${entryId} has a distribution_marker, but a live re-read of ${INTAKE_COLLECTION_NAME} found no original intake point for it -- refusing`,
    );
  }

  // (2) Independent live destination re-check -- the marker's own
  // distributed_to_scope, matched by entry_id/content_hash, exact-match
  // only, fails closed on anything inconclusive.
  const destinationScopeLabel = marker.distributed_to_scope;
  const destinationScope = destinationScopeLabel as unknown as Scope; // ONE, well-documented widening assertion, mirrors distributeIntakeEntries.ts's own resolveDestinationScope().
  const expectedContentHash = createHash('sha256').update(originalText).digest('hex');

  const recallResult = await recall(entryId, destinationScope, 'broad');
  if (!recallResult.ok) {
    return refuse(
      entryId,
      'destination_not_confirmed',
      `destination check inconclusive: recall against scope ${destinationScopeLabel} failed: ${recallResult.error.message}`,
    );
  }

  const confirmingHit = recallResult.hits.find((hit: Hit) => {
    const parsedHit = parseProvenanceHeader(hit.content);
    if (parsedHit === null || parsedHit.entry_id !== entryId) return false;
    if (hit.provenance.content_hash !== null && hit.provenance.content_hash !== expectedContentHash) return false;
    return true;
  });

  if (!confirmingHit) {
    return refuse(
      entryId,
      'destination_not_confirmed',
      `destination check failed: no hit in scope ${destinationScopeLabel} independently confirmed entry_id ${entryId} (matched by entry_id/content_hash) -- refusing to delete`,
    );
  }

  // Both live checks passed. Backup (default ON) BEFORE the delete call.
  let backupPath: string | null = null;
  if (!options.skipBackup) {
    const timestamp = now().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(backupDir, `${timestamp}-${entryId}.ndjson`);
    const lines = [
      JSON.stringify({ kind: 'intake_entry', pointId: originalPoint.id, entryId, text: originalText, metadata: originalMetadata }),
      JSON.stringify({
        kind: 'distribution_marker',
        pointId: markerPoint.id,
        entryId: marker.entry_id,
        marksEntryId: entryId,
        text: markerText,
        metadata: marker,
      }),
    ];
    try {
      ensureBackupDir(backupDir);
      writeBackupFile(filePath, lines.join('\n') + '\n');
    } catch (err) {
      return refuse(
        entryId,
        'backup_write_failed',
        `backup write failed BEFORE any delete call was made -- refusing to proceed without the default backup: ${(err as Error).message}`,
      );
    }
    backupPath = filePath;
  }

  // (3) The delete call -- exactly two, already-known point ids. No
  // collection-name argument exists on QdrantDeletePointsFn's own
  // signature (see its doc comment) -- there is no value for this call to
  // pass that could ever redirect it.
  const deletedPointIds: [string, string] = [String(originalPoint.id), String(markerPoint.id)];
  const deleteResult = await deletePoints(deletedPointIds);
  if (!deleteResult.ok) {
    return refuse(entryId, 'delete_failed', `Qdrant points/delete call failed: ${deleteResult.error ?? JSON.stringify(deleteResult.raw)}`);
  }

  return {
    ok: true,
    entryId,
    destinationScope: destinationScopeLabel,
    deletedPointIds,
    backupPath,
  };
}
