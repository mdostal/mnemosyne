// Type declarations for crawl-context.mjs — kept as a thin, hand-written
// companion (no build step for this skill's helper scripts), same
// convention as interview-engine.d.mts / persona-writer.d.mts. Source of
// truth for behavior is crawl-context.mjs itself; this file must stay in
// lockstep with it.

export interface CrawlParentRef {
  tier: string;
  scopeId: string;
}

export interface CrawlExcerpt {
  excerpt: string;
  truncated: boolean;
}

export interface CrawlSource extends CrawlExcerpt {
  name: string;
  path?: string;
}

export interface CrawlBoundedContextInput {
  repoRoot: string;
  parentRef?: CrawlParentRef;
  home?: string;
}

export interface CrawlBoundedContextResult {
  sourceSummary: string;
  sourcesRead: string[];
  sourcesMissing: string[];
}

export const MAX_LINES_PER_SOURCE: number;
export const MAX_CHARS_PER_SOURCE: number;
export const MAX_SOURCE_SUMMARY_CHARS: number;
export const README_CANDIDATES: string[];
export const MANIFEST_CANDIDATES: string[];
export const AGENT_FILE_CANDIDATES: string[];
export const MAX_EXPLICIT_FILES: number;

export function capExcerpt(raw: string): CrawlExcerpt;

export function readParentPersonaSummary(
  parentRef: CrawlParentRef | undefined,
  opts?: { home?: string },
): Promise<CrawlSource | null>;

export function crawlBoundedContext(input: CrawlBoundedContextInput): Promise<CrawlBoundedContextResult>;

/** Thrown by crawlExplicitFiles() when more file paths are supplied than `maxFiles` allows. */
export class TooManyExplicitFilesError extends Error {
  readonly count: number;
  readonly max: number;
  constructor(count: number, max: number);
}

export interface CrawlExplicitFilesInput {
  filePaths: string[];
  repoRoot: string;
  parentRef?: CrawlParentRef;
  home?: string;
  maxFiles?: number;
}

export interface CrawlExplicitFilesResult {
  sourceSummary: string;
  sourcesRead: string[];
}

/**
 * Sibling to crawlBoundedContext() — reads an explicit, caller-supplied list
 * of file paths (instead of the fixed named source list) as source material,
 * reusing the same capExcerpt()/assembleSourceSummary() caps and the same
 * parent-ref CLI-subprocess mechanism. Throws TooManyExplicitFilesError when
 * `filePaths.length` exceeds `maxFiles` (default MAX_EXPLICIT_FILES).
 */
export function crawlExplicitFiles(input: CrawlExplicitFilesInput): Promise<CrawlExplicitFilesResult>;
