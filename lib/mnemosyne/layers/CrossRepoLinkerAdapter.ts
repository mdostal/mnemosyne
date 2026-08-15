/**
 * CrossRepoLinkerAdapter — multi-repo shared-identifier cross-referencer
 * (cr-02-crossrepo-identifier-linker).
 *
 * Real, validated finding this layer exists to act on (see
 * docs/layer-architecture-v2-plan.md and
 * .pHive/epics/mnemosyne-crossrepo-defaults/epic.yaml): Graphify's AST-based
 * cross-repo graph merge (`graphify global`/`merge-graphs`) finds ZERO
 * cross-repo edges whenever two repos' real relationship is a network API or
 * shared external SaaS backend rather than a shared imported package —
 * confirmed on 3 separate real repo pairings. A hand-written prototype
 * proved an alternative works: cross-referencing schema/type DEFINITION
 * sites against QUERY/USAGE sites by shared string identifier correctly
 * found a real link Graphify's merge missed entirely (Sanity's `tool`
 * document type, defined in mdostal/personal-site's
 * sanity/schemas/tool.ts, queried via a GROQ string in
 * mdostal/mdostal-tools-hub's src/lib/sanity.ts).
 *
 * Genuinely different shape from every other layer in this repo: every
 * other LayerAdapter (vector/file/code-graph/graphify) operates on ONE
 * repoRoot. This layer's entire purpose is finding relationships BETWEEN
 * repos, so its config is deliberately a LIST of repo roots, not a
 * single-root config bolted on after the fact — see
 * CrossRepoLinkerAdapterOptions.repos below.
 *
 * "Scheme" concept: a pluggable pattern-pair (findDefinitions/findUsages)
 * so this isn't hardcoded to Sanity's specific syntax. Exactly ONE built-in
 * scheme ships today ("sanity" — see SANITY_SCHEME below), proven against
 * the real prototype case. A future story can register another scheme
 * (e.g. "api-routes") without redesigning this adapter — CrossRefScheme is
 * the seam — but no speculative extra schemes are built now (see cr-02's
 * risk/mitigation: keep the scheme interface to the minimum two functions
 * the Sanity case actually needs).
 *
 * Registered under the NEW layer name "crossref-linker" (see registry.ts) —
 * an OPT-IN layer like every other one. A consumer that doesn't list
 * "crossref-linker" in MNEMOSYNE_LAYERS never constructs this adapter and is
 * completely unaffected by its existence in the registry.
 *
 * Story: cr-02-crossrepo-identifier-linker (epic: mnemosyne-crossrepo-defaults)
 */
import { existsSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Hit, RecallFailure, RecallResult, RecallSuccess } from '../interfaces.js';
import type { LayerAdapter, RecallOptions } from './LayerAdapter.js';

// --- the "scheme" seam -------------------------------------------------------

/** One identifier occurrence, with real file:line provenance (line is 1-based). */
export interface IdentifierMatch {
  identifier: string;
  line: number;
}

/**
 * A pluggable pattern-pair: where an identifier is DEFINED vs. where it's
 * USED/QUERIED. Deliberately just two functions — the minimum the validated
 * "sanity" scheme actually needs (see this file's header and cr-02's risk
 * mitigation). Both functions run against one file's full content at a
 * time and return every match found in that file (usually zero).
 */
export interface CrossRefScheme {
  readonly name: string;
  findDefinitions(filePath: string, content: string): IdentifierMatch[];
  findUsages(filePath: string, content: string): IdentifierMatch[];
}

// --- built-in scheme: "sanity" -----------------------------------------------
//
// Definition shape (real example: personal-site/sanity/schemas/tool.ts):
//   export default {
//     name: 'tool',
//     title: 'Tool',
//     type: 'document',
//     fields: [...],
//   };
// A `name: 'X'` key followed (within a bounded window, allowing intervening
// keys like `title`) by a `type: 'document'` key is treated as a document
// schema definition of identifier X. The lazy [\s\S]{0,400}? window plus the
// literal "document" requirement means an intervening nested `type: 'string'`
// (e.g. inside a `fields: [...]` entry) does not falsely terminate the
// search -- the engine keeps expanding past a non-matching "type:" until it
// finds the real "type: 'document'", or gives up after 400 chars.
//
// Usage shape (real example: mdostal-tools-hub/src/lib/sanity.ts's GROQ
// template string): `*[_type == "tool" && hidden != true] | order(...)`, or
// the list form `_type in ["tool", "project"]`.

const SANITY_DEFINITION_PATTERN =
  /\bname\s*:\s*(['"`])([A-Za-z0-9_-]+)\1[\s\S]{0,400}?\btype\s*:\s*(['"`])document\3/g;
const SANITY_USAGE_EQUALITY_PATTERN = /\b_type\s*==\s*(['"`])([A-Za-z0-9_-]+)\1/g;
const SANITY_USAGE_IN_LIST_PATTERN = /\b_type\s+in\s*\[([^\]]*)\]/g;
const QUOTED_IDENTIFIER_PATTERN = /(['"`])([A-Za-z0-9_-]+)\1/g;

function lineNumberAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (content.charCodeAt(i) === 10 /* \n */) line += 1;
  }
  return line;
}

function sanityFindDefinitions(_filePath: string, content: string): IdentifierMatch[] {
  const matches: IdentifierMatch[] = [];
  for (const m of content.matchAll(SANITY_DEFINITION_PATTERN)) {
    matches.push({ identifier: m[2]!, line: lineNumberAt(content, m.index!) });
  }
  return matches;
}

function sanityFindUsages(_filePath: string, content: string): IdentifierMatch[] {
  const matches: IdentifierMatch[] = [];

  for (const m of content.matchAll(SANITY_USAGE_EQUALITY_PATTERN)) {
    matches.push({ identifier: m[2]!, line: lineNumberAt(content, m.index!) });
  }

  for (const m of content.matchAll(SANITY_USAGE_IN_LIST_PATTERN)) {
    const listBody = m[1] ?? '';
    const listStart = m.index! + m[0].indexOf(listBody);
    for (const im of listBody.matchAll(QUOTED_IDENTIFIER_PATTERN)) {
      matches.push({ identifier: im[2]!, line: lineNumberAt(content, listStart + im.index!) });
    }
  }

  return matches;
}

const SANITY_SCHEME: CrossRefScheme = {
  name: 'sanity',
  findDefinitions: sanityFindDefinitions,
  findUsages: sanityFindUsages,
};

const BUILTIN_SCHEMES: Record<string, CrossRefScheme> = {
  sanity: SANITY_SCHEME,
};

// --- multi-repo config --------------------------------------------------------
//
// Deliberately its own shape, not the single-repoRoot pattern every other
// layer uses (see this file's header) -- a LIST of repo roots, each
// optionally given a human-readable `name` for legible cross-repo hit
// content (defaults to the resolved path's basename).

export interface CrossRepoLinkerRepoConfig {
  path: string;
  /** Human-readable label for hit content, e.g. "personal-site". Defaults to path.basename(path). */
  name?: string;
}

export type CrossRepoLinkerRepoEntry = string | CrossRepoLinkerRepoConfig;

interface NormalizedRepo {
  path: string;
  name: string;
}

export interface CrossRepoLinkerAdapterOptions {
  /**
   * Repo roots to scan for identifier definitions/usages. REQUIRED, and
   * must contain at least 2 entries -- the entire point of this layer is
   * finding relationships BETWEEN repos, which is structurally impossible
   * with fewer than 2. Fails loudly at construction time; never a silent
   * empty layer (see constructor).
   */
  repos: CrossRepoLinkerRepoEntry[];
  /**
   * Which scheme(s) to run, by built-in name or a directly-supplied
   * CrossRefScheme (for tests/future extension without touching this file).
   * Defaults to `['sanity']`, the one scheme this story validated.
   */
  schemes?: Array<string | CrossRefScheme>;
  /** File extensions to scan. Defaults to common JS/TS source extensions -- where both real Sanity schemas and GROQ query strings live. */
  extensions?: string[];
  /** Directory names to never descend into. Defaults to node_modules/.git/dist/build/.next/out. */
  ignoredDirectories?: string[];
  /** Default cap on hits returned by recall() when the caller doesn't pass options.limit. */
  limit?: number;
}

const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];
const DEFAULT_IGNORED_DIRECTORIES = ['node_modules', '.git', 'dist', 'build', '.next', 'out'];
const DEFAULT_LIMIT = 50;

interface FoundIdentifier {
  identifier: string;
  line: number;
  file: string;
  repo: NormalizedRepo;
  scheme: string;
}

export class CrossRepoLinkerAdapter implements LayerAdapter {
  readonly layer = 'crossref-linker' as const;

  private readonly repos: NormalizedRepo[];
  private readonly schemes: CrossRefScheme[];
  private readonly extensions: Set<string>;
  private readonly ignoredDirectories: Set<string>;
  private readonly defaultLimit: number;

  constructor(options: CrossRepoLinkerAdapterOptions) {
    const rawRepos = options?.repos ?? [];

    // Loud failure per this repo's whole ethos: zero (or one) repos, or any
    // repo path that doesn't exist/isn't a directory, fails HERE -- at
    // construction time -- never a silent layer that just returns empty
    // results forever.
    if (!Array.isArray(rawRepos) || rawRepos.length === 0) {
      throw new Error(
        'crossref-linker requires `repos`: a list of 2+ repo root paths -- got none. ' +
          'This layer only exists to find relationships BETWEEN repos, so it cannot be ' +
          'configured with zero roots.',
      );
    }
    if (rawRepos.length < 2) {
      throw new Error(
        `crossref-linker requires at least 2 repo roots to ever find a cross-repo relationship ` +
          `(got ${rawRepos.length}). Configure \`repos\` with 2+ paths.`,
      );
    }

    this.repos = rawRepos.map((entry) => normalizeRepo(entry));
    this.schemes = (options.schemes ?? ['sanity']).map((entry) => resolveScheme(entry));
    this.extensions = new Set(options.extensions ?? DEFAULT_EXTENSIONS);
    this.ignoredDirectories = new Set(options.ignoredDirectories ?? DEFAULT_IGNORED_DIRECTORIES);
    this.defaultLimit = options.limit ?? DEFAULT_LIMIT;
  }

  async recall(query: string, options: RecallOptions = {}): Promise<RecallResult> {
    const normalizedQuery = query.trim();
    const scope = options.scope ?? 'project';
    const intent = options.intent ?? 'narrow';

    if (!normalizedQuery) {
      return this.failure(query, scope, intent, 'invalid_query', 'query must not be empty');
    }

    const limit = options.limit ?? this.defaultLimit;
    const retrievalTime = new Date().toISOString();

    let defs: FoundIdentifier[];
    let usages: FoundIdentifier[];
    try {
      [defs, usages] = await this.scanAllRepos();
    } catch (error) {
      return this.failure(
        query,
        scope,
        intent,
        'scan_failed',
        `crossref-linker scan failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const hits: Hit[] = [];
    const matchingDefs = filterByIdentifier(defs, normalizedQuery);

    for (const def of matchingDefs) {
      if (hits.length >= limit) break;
      hits.push(definitionHit(def, retrievalTime));

      const usagesForIdentifier = usages.filter((u) => u.identifier === def.identifier);
      for (const use of usagesForIdentifier) {
        if (hits.length >= limit) break;
        const crossRepo = use.repo.path !== def.repo.path;
        hits.push(usageHit(use, def, crossRepo, retrievalTime));
      }
    }

    // No matching definition anywhere -- still surface direct usage matches
    // (can't claim cross-repo-ness without a definition anchor, so these are
    // reported plainly, not framed as cross-repo).
    if (matchingDefs.length === 0) {
      const matchingUsages = filterByIdentifier(usages, normalizedQuery);
      for (const use of matchingUsages) {
        if (hits.length >= limit) break;
        hits.push(usageOnlyHit(use, retrievalTime));
      }
    }

    return this.success(query, scope, intent, hits.slice(0, limit));
  }

  private async scanAllRepos(): Promise<[FoundIdentifier[], FoundIdentifier[]]> {
    const defs: FoundIdentifier[] = [];
    const usages: FoundIdentifier[] = [];

    for (const repo of this.repos) {
      for await (const filePath of this.walk(repo.path)) {
        let content: string;
        try {
          content = await readFile(filePath, 'utf8');
        } catch {
          continue; // vanished between listing and read, or unreadable -- skip, don't fail the whole scan
        }

        for (const scheme of this.schemes) {
          for (const def of scheme.findDefinitions(filePath, content)) {
            defs.push({ ...def, file: filePath, repo, scheme: scheme.name });
          }
          for (const use of scheme.findUsages(filePath, content)) {
            usages.push({ ...use, file: filePath, repo, scheme: scheme.name });
          }
        }
      }
    }

    return [defs, usages];
  }

  private async *walk(directory: string): AsyncGenerator<string> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (!this.ignoredDirectories.has(entry.name)) {
          yield* this.walk(entryPath);
        }
        continue;
      }

      if (entry.isFile() && this.extensions.has(path.extname(entry.name))) {
        yield entryPath;
      }
    }
  }

  private success(query: string, scope: RecallSuccess['scope'], intent: RecallSuccess['intent'], hits: Hit[]): RecallSuccess {
    return {
      ok: true,
      query,
      scope,
      intent,
      hits,
      layers_queried: ['crossref-linker'],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    };
  }

  private failure(
    query: string,
    scope: RecallFailure['scope'],
    intent: RecallFailure['intent'],
    code: string,
    message: string,
  ): RecallFailure {
    return {
      ok: false,
      query,
      scope,
      intent,
      error: { layer: 'crossref-linker', message, code },
    };
  }
}

// --- construction-time helpers -----------------------------------------------

function normalizeRepo(entry: CrossRepoLinkerRepoEntry): NormalizedRepo {
  const rawPath = typeof entry === 'string' ? entry : entry.path;
  if (!rawPath) {
    throw new Error('crossref-linker repo entry is missing `path`');
  }

  const resolved = path.resolve(rawPath);
  if (!existsSync(resolved)) {
    throw new Error(
      `crossref-linker repo path does not exist: ${resolved} -- check the \`repos\` config (this fails ` +
        'at construction time by design, never a silent empty layer).',
    );
  }
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`crossref-linker repo path is not a directory: ${resolved}`);
  }

  const name = (typeof entry === 'object' && entry.name) || path.basename(resolved);
  return { path: resolved, name };
}

function resolveScheme(entry: string | CrossRefScheme): CrossRefScheme {
  if (typeof entry === 'string') {
    const builtin = BUILTIN_SCHEMES[entry];
    if (!builtin) {
      throw new Error(
        `crossref-linker: unknown scheme "${entry}" -- known built-in schemes: ${Object.keys(BUILTIN_SCHEMES).join(', ') || '(none)'}`,
      );
    }
    return builtin;
  }
  return entry;
}

// --- recall() matching/hit-building helpers -----------------------------------

/** Exact case-insensitive identifier match first; falls back to substring — mirrors GraphifyLayerAdapter's matchNodes(). */
function filterByIdentifier<T extends { identifier: string }>(items: T[], query: string): T[] {
  const needle = query.toLowerCase();
  const exact = items.filter((item) => item.identifier.toLowerCase() === needle);
  if (exact.length > 0) return exact;
  return items.filter((item) => item.identifier.toLowerCase().includes(needle));
}

function definitionHit(def: FoundIdentifier, retrievalTime: string): Hit {
  return {
    content: `Definition: "${def.identifier}" (${def.scheme} document type) in ${def.repo.name}`,
    provenance: {
      layer: 'crossref-linker',
      source: `${def.file}:${def.line}`,
      chunk_span: { index: def.line },
      index_timestamp: null,
      content_hash: null,
      embedder: null,
      retrieval_time: retrievalTime,
    },
  };
}

function usageHit(use: FoundIdentifier, def: FoundIdentifier, crossRepo: boolean, retrievalTime: string): Hit {
  const content = crossRepo
    ? `Cross-repo usage: "${use.identifier}" used in ${use.repo.name} (defined in ${def.repo.name})`
    : `Same-repo usage: "${use.identifier}" used in ${use.repo.name} (not cross-repo -- also defined here)`;

  return {
    content,
    provenance: {
      layer: 'crossref-linker',
      source: `${use.file}:${use.line}`,
      chunk_span: { index: use.line },
      index_timestamp: null,
      content_hash: null,
      embedder: null,
      retrieval_time: retrievalTime,
    },
  };
}

function usageOnlyHit(use: FoundIdentifier, retrievalTime: string): Hit {
  return {
    content: `Usage: "${use.identifier}" used in ${use.repo.name} (no matching definition found in configured repos)`,
    provenance: {
      layer: 'crossref-linker',
      source: `${use.file}:${use.line}`,
      chunk_span: { index: use.line },
      index_timestamp: null,
      content_hash: null,
      embedder: null,
      retrieval_time: retrievalTime,
    },
  };
}
