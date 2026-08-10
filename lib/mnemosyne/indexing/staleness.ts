import { Hit, Provenance } from "../interfaces";

/**
 * Staleness tracking for indexed content.
 * Compares the index_timestamp against the file's modification time (mtime).
 */

export interface StaleProvenance extends Provenance {
  stale?: boolean;
}

export interface StaleHit extends Hit {
  provenance: StaleProvenance;
}

/**
 * Given a hit and its actual file mtime (in milliseconds), determine if it is stale
 * and inject the staleness marker into its provenance if it is out-of-date.
 */
export function injectStalenessMarker(hit: Hit, fileMtimeMs: number): StaleHit {
  const staleHit = { ...hit } as StaleHit;
  staleHit.provenance = { ...hit.provenance };
  
  if (hit.provenance.index_timestamp) {
    const indexTime = new Date(hit.provenance.index_timestamp).getTime();
    if (fileMtimeMs > indexTime) {
      staleHit.provenance.stale = true;
    }
  }
  
  return staleHit;
}
