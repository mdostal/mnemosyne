/**
 * removeMemoryEntry — general-purpose, single-entry memory maintenance
 * (2026-09-08). Removes ONE memory entry (matched by its own
 * `mnemosyne-intake-provenance`-shaped `entry_id`) from a specific,
 * already-resolved Qdrant collection — any real destination scope
 * (`meta`, a confirmed project scope, etc.), not just the `intake` staging
 * collection `cm-14-intake-decommission`'s own `decommissionIntakeEntry()`
 * is narrowly scoped to.
 *
 * Real context for why this exists, distinct from cm-14: the operator's
 * own framing (this session) is that `intake` is a deliberately SEPARATE,
 * temporary "figuring out where things go" staging area with its own
 * archive/wipe lifecycle (`cm-14`), while the REAL destination scopes need
 * their own ordinary, ongoing "remove and re-index as we go" maintenance
 * capability — this module is that capability. It is held to AT LEAST
 * cm-14's own safety bar, since it touches PERMANENT content, not a
 * redundant staging copy.
 *
 * Design, deliberately simpler than cm-14 in one respect: there is no
 * `distribution_marker` concept here, and no independent semantic-recall
 * destination cross-check is needed, because this module scrolls and
 * matches directly against the SAME collection it would delete from —
 * a live, exact, deterministic scroll-and-match, not a semantic search
 * against a *different* collection (which cm-14's own real use this
 * session found to be genuinely unreliable: a `content_hash` that can
 * structurally never match due to write-time re-wrapping, and a
 * `swarm-memory` context-radius text-stitching quirk that can garble
 * reconstructed hit content for near-duplicate neighbors). Scrolling the
 * SAME collection directly sidesteps both real, live-confirmed issues
 * entirely.
 *
 * Safety properties, matching/exceeding cm-14:
 *  - Single entryId per invocation, structurally — no batch/wildcard.
 *  - Live re-scroll immediately before delete — never a cached/stale
 *    report.
 *  - Backup (NDJSON) defaults ON — an explicit `skipBackup: true` is the
 *    only way to skip it.
 *  - The delete primitive carries NO collection-name parameter on its own
 *    signature — it is bound to exactly ONE collection at construction
 *    time by the caller (mirrors cm-14's own `makeHttpQdrantDeletePointsFn`
 *    pattern), so this module itself has no code path capable of ever
 *    redirecting a delete to a different collection than the one its
 *    caller resolved and bound.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { parseProvenanceHeader } from '../conversation-memory/distillAndRemember.js';
import type { ScrolledPoint, QdrantDeleteResult, QdrantDeletePointsFn } from '../conversation-memory/decommissionIntakeEntry.js';
import { resolveQdrantApiKey, resolveQdrantUrl } from '../conversation-memory/decommissionIntakeEntry.js';

export type { ScrolledPoint, QdrantDeleteResult, QdrantDeletePointsFn };

/**
 * Generalized sibling of `decommissionIntakeEntry.ts`'s own
 * `makeHttpQdrantDeletePointsFn()` — that factory deliberately hardcodes
 * `INTAKE_COLLECTION_NAME` into its request URL (a real, load-bearing
 * safety guarantee for cm-14 specifically, preserved unchanged here by NOT
 * reusing/modifying it). This module's own real use case is different by
 * design: the target collection varies by scope, resolved ONCE by the
 * caller (the CLI's own production wiring) before construction — so
 * `collectionName` is a REQUIRED constructor argument here, not a
 * hardcoded constant, but it is still bound at construction time, never
 * accepted by the returned `deletePoints` function itself (which still
 * carries no collection-name parameter on its own signature).
 */
export function makeHttpQdrantDeletePointsForCollection(
  collectionName: string,
  options: { apiKey?: string; url?: string; fetchImpl?: typeof fetch } = {},
): QdrantDeletePointsFn {
  const apiKey = options.apiKey ?? resolveQdrantApiKey();
  const url = options.url ?? resolveQdrantUrl();
  const doFetch = options.fetchImpl ?? fetch;

  return async function deletePoints(pointIds: string[]): Promise<QdrantDeleteResult> {
    const endpoint = `${url}/collections/${collectionName}/points/delete?wait=true`;
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
      return { ok: false, error: `Qdrant POST /collections/${collectionName}/points/delete failed with HTTP ${response.status}`, raw };
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

export const DEFAULT_BACKUP_DIR = path.join(homedir(), '.mnemosyne', 'memory-remove-backups');

/** No collection-name parameter — bound to exactly ONE, already-resolved collection at construction time by the caller, mirroring `QdrantDeletePointsFn`'s own structural guarantee. */
export type ScrollCollectionFn = () => Promise<ScrolledPoint[]>;

export interface RemoveMemoryEntryOptions {
  /** The ONE entry to remove — structurally always a single string, never an array/pattern/wildcard. */
  entryId: string;
  /** Injectable, REQUIRED — enumerates every point in the ALREADY-RESOLVED target collection (no collection-name parameter of its own — see `ScrollCollectionFn`'s doc comment). Tests MUST supply a stub — never live Qdrant. */
  scrollCollection: ScrollCollectionFn;
  /** Injectable, REQUIRED — the Qdrant points/delete primitive, bound to exactly ONE collection at construction time by the caller. Tests MUST supply a fake — never a live delete call. */
  deletePoints: QdrantDeletePointsFn;
  /** Explicit, named opt-out ONLY — default `false` (backup ON). */
  skipBackup?: boolean;
  /** Where the backup NDJSON is written. Default `DEFAULT_BACKUP_DIR`. Tests override with a temp-dir path. */
  backupDir?: string;
  ensureBackupDir?: (dirPath: string) => void;
  writeBackupFile?: (filePath: string, content: string) => void;
  now?: () => Date;
}

export type RemoveMemoryEntryRefusalReason = 'invalid_entry_id' | 'entry_not_found' | 'backup_write_failed' | 'delete_failed';

export interface RemoveMemoryEntryRefusal {
  ok: false;
  entryId: string;
  reason: RemoveMemoryEntryRefusalReason;
  detail: string;
}

export interface RemoveMemoryEntrySuccess {
  ok: true;
  entryId: string;
  deletedPointId: string;
  backupPath: string | null;
}

export type RemoveMemoryEntryResult = RemoveMemoryEntryRefusal | RemoveMemoryEntrySuccess;

function refuse(entryId: string, reason: RemoveMemoryEntryRefusalReason, detail: string): RemoveMemoryEntryRefusal {
  return { ok: false, entryId, reason, detail };
}

function extractPointText(point: ScrolledPoint): string | null {
  const text = point.payload?.text;
  return typeof text === 'string' ? text : null;
}

export async function removeMemoryEntry(options: RemoveMemoryEntryOptions): Promise<RemoveMemoryEntryResult> {
  const { entryId, scrollCollection, deletePoints } = options;
  const backupDir = options.backupDir ?? DEFAULT_BACKUP_DIR;
  const now = options.now ?? (() => new Date());
  const ensureBackupDir = options.ensureBackupDir ?? ((dir: string) => mkdirSync(dir, { recursive: true }));
  const writeBackupFile = options.writeBackupFile ?? ((filePath: string, content: string) => writeFileSync(filePath, content, 'utf8'));

  if (typeof entryId !== 'string' || entryId.trim().length === 0) {
    return refuse(entryId, 'invalid_entry_id', 'entry_id must be a non-empty string');
  }

  // Live re-scroll of the ALREADY-RESOLVED target collection -- never a
  // cached/stale report. Matches by entry_id parsed from the point's own
  // provenance header, an exact, deterministic match (never fuzzy).
  const points = await scrollCollection();
  let targetPoint: ScrolledPoint | null = null;
  let targetText: string | null = null;
  for (const point of points) {
    const text = extractPointText(point);
    if (text === null) continue;
    const parsed = parseProvenanceHeader(text);
    if (parsed !== null && parsed.entry_id === entryId) {
      targetPoint = point;
      targetText = text;
      break;
    }
  }

  if (targetPoint === null || targetText === null) {
    return refuse(entryId, 'entry_not_found', `a live re-scroll of the target collection found no point whose provenance names entry_id ${entryId}`);
  }

  let backupPath: string | null = null;
  if (!options.skipBackup) {
    const timestamp = now().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(backupDir, `${timestamp}-${entryId}.ndjson`);
    const line = JSON.stringify({ kind: 'memory_entry', pointId: targetPoint.id, entryId, text: targetText });
    try {
      ensureBackupDir(backupDir);
      writeBackupFile(filePath, line + '\n');
    } catch (err) {
      return refuse(entryId, 'backup_write_failed', `backup write failed BEFORE any delete call was made -- refusing to proceed without the default backup: ${(err as Error).message}`);
    }
    backupPath = filePath;
  }

  const deletedPointId = String(targetPoint.id);
  const deleteResult = await deletePoints([deletedPointId]);
  if (!deleteResult.ok) {
    return refuse(entryId, 'delete_failed', `Qdrant points/delete call failed: ${deleteResult.error ?? JSON.stringify(deleteResult.raw)}`);
  }

  return { ok: true, entryId, deletedPointId, backupPath };
}
