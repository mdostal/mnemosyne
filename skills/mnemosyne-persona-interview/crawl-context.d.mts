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

export function capExcerpt(raw: string): CrawlExcerpt;

export function readParentPersonaSummary(
  parentRef: CrawlParentRef | undefined,
  opts?: { home?: string },
): Promise<CrawlSource | null>;

export function crawlBoundedContext(input: CrawlBoundedContextInput): Promise<CrawlBoundedContextResult>;
