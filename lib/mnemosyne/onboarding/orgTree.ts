/**
 * ro-04-org-tree-registry (epic: mnemosyne-repo-onboarding).
 *
 * Mode A's "where it sits as a whole so that we can build and create our
 * tree and mapping logic" needs a durable, queryable answer, not just a
 * one-off classification printed to stdout by `placement_engine.py`.
 * `placement_engine.py`'s own default write location (`.pHive/epics/
 * ingest-a10ab2c1/inventory/qdrant-placement.yaml`) is epic-scratch, not a
 * permanent home. This module is the canonical, operator-global registry --
 * `~/.mnemosyne/org-tree.yaml` -- mirroring the already-established
 * "operator-global, not per-repo" convention `~/.mnemosyne/level0-rules.md`
 * (layer1/level0.ts's `DEFAULT_LEVEL0_PATH`) already uses, rather than
 * inventing a new home convention (structured-outline.md §2.3).
 *
 * Schema (structured-outline.md §2.3):
 *
 *   # ~/.mnemosyne/org-tree.yaml
 *   entries:
 *     - repo_path: /Users/mdostal/Documents/work/pantheon/mnemosyne
 *       collection: project-mnemosyne
 *       scope: project
 *       org_tree_path: org/project/mnemosyne
 *       needs_override: false
 *       onboarded_at: "2026-08-19T00:00:00Z"
 *
 * `appendOrgTreeEntry` dedupes on `repo_path`, last-write-wins on
 * re-onboard (a repo can be re-onboarded -- collection renamed, scope
 * corrected -- the registry should reflect current placement, not
 * accumulate stale historical entries for the same repo). Both functions
 * read fresh off disk every call, no module-level caching -- mirrors
 * level0.ts's and persona-store-repo-local.ts's own established "read
 * fresh" contract for operator-global state. Concurrent-write safety
 * reuses `layer1/lock.ts`'s existing `withLock` helper around the
 * read-modify-write, the same pattern already proven for
 * `syncHarnessFile`/`writeRepoLocalPersona`.
 *
 * Format is YAML, not JSON (persona-store-repo-local.ts's own established
 * convention, direct operator correction: "we define our own yaml") --
 * reuses the `yaml` package already in package.json's dependencies.
 *
 * Story: ro-04-org-tree-registry (epic: mnemosyne-repo-onboarding).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { withLock } from '../layer1/lock.js';

/** `~/.mnemosyne/org-tree.yaml` -- mirrors level0.ts's `DEFAULT_LEVEL0_PATH` convention exactly. */
export const DEFAULT_ORG_TREE_PATH = path.join(homedir(), '.mnemosyne', 'org-tree.yaml');

export interface OrgTreeEntry {
  repo_path: string;
  collection: string;
  scope: string;
  org_tree_path: string;
  needs_override: boolean;
  onboarded_at: string;
}

interface OrgTreeFile {
  entries: OrgTreeEntry[];
}

/** Missing file (or malformed/empty content) reads as `{ entries: [] }` -- never throws. */
function readOrgTreeFile(orgTreePath: string): OrgTreeFile {
  if (!existsSync(orgTreePath)) {
    return { entries: [] };
  }
  const raw = readFileSync(orgTreePath, 'utf8');
  const parsed = parse(raw) as OrgTreeFile | null | undefined;
  if (!parsed || !Array.isArray(parsed.entries)) {
    return { entries: [] };
  }
  return parsed;
}

/**
 * Writes `entry` into the registry at `orgTreePath` (default
 * `DEFAULT_ORG_TREE_PATH`), deduped on `repo_path`: an existing entry for
 * the same `repo_path` is replaced in place (same array position, not
 * moved to the end and not duplicated); a new `repo_path` is appended.
 * Every other existing entry is left byte-for-byte untouched -- the
 * read-modify-write only ever rewrites the one changed (or newly added)
 * entry's own object, so re-serializing the whole file reproduces every
 * other entry's YAML text identically.
 *
 * The read-modify-write is wrapped in `withLock` (layer1/lock.ts) around
 * the shared `orgTreePath`, mirroring `writeRepoLocalPersona`'s own
 * TOCTOU-safe pattern -- two concurrent `appendOrgTreeEntry` calls (e.g.
 * two repos being onboarded at once) serialize rather than racing a lost
 * update.
 */
export function appendOrgTreeEntry(entry: OrgTreeEntry, orgTreePath: string = DEFAULT_ORG_TREE_PATH): void {
  // The lock file lives alongside orgTreePath, so its directory must exist before we can even
  // attempt to acquire the lock -- create it up front, outside the locked section (mirrors
  // writeRepoLocalPersona's own ordering, persona-store-repo-local.ts).
  mkdirSync(path.dirname(orgTreePath), { recursive: true });
  withLock(orgTreePath, () => {
    const file = readOrgTreeFile(orgTreePath);
    const existingIndex = file.entries.findIndex((existing) => existing.repo_path === entry.repo_path);
    const entries =
      existingIndex === -1
        ? [...file.entries, entry]
        : file.entries.map((existing, i) => (i === existingIndex ? entry : existing));
    writeFileSync(orgTreePath, stringify({ entries } satisfies OrgTreeFile), 'utf8');
  });
}

/**
 * Reads every entry back from the registry at `orgTreePath` (default
 * `DEFAULT_ORG_TREE_PATH`), fresh off disk (never cached). A machine with
 * no org-tree.yaml at all returns an empty array, never throws --
 * mirrors `listRepoLocalPersonas`' own missing-directory-is-not-an-error
 * contract (persona-store-repo-local.ts).
 */
export function listOrgTreeEntries(orgTreePath: string = DEFAULT_ORG_TREE_PATH): OrgTreeEntry[] {
  return readOrgTreeFile(orgTreePath).entries;
}
