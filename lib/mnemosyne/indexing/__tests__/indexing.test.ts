import { describe, it, expect } from "vitest";
import { runContinuousIndexing } from "../continuous";
import { injectStalenessMarker } from "../staleness";
import { Hit } from "../../interfaces";

describe("continuous indexing", () => {
  it("Given a file change, when continuous indexing runs, then code-graph edges are updated", async () => {
    const result = await runContinuousIndexing("project", "src/file.ts");
    expect(result.indexed).toBe(true);
    expect(result.layers_updated).toContain("code-graph");
  });

  it("Given new markdown in Obsidian vault, when indexing runs, then meta layer includes the new content", async () => {
    const result = await runContinuousIndexing("meta");
    expect(result.indexed).toBe(true);
    expect(result.layers_updated).toContain("meta");
  });

  it("Given staleness detection, when indexed content is out-of-date, then provenance includes staleness marker", () => {
    const hit: Hit = {
      content: "test",
      provenance: {
        layer: "vector",
        source: "test.md",
        chunk_span: null,
        index_timestamp: "2026-08-01T00:00:00Z",
        content_hash: null,
        embedder: null,
        retrieval_time: null
      }
    };
    
    // mtime is newer (Aug 2 vs Aug 1)
    const mtimeMs = new Date("2026-08-02T00:00:00Z").getTime();
    
    const marked = injectStalenessMarker(hit, mtimeMs);
    expect(marked.provenance.stale).toBe(true);
  });
  
  it("Given staleness detection, when indexed content is fresh, then provenance does not include staleness marker", () => {
    const hit: Hit = {
      content: "test",
      provenance: {
        layer: "vector",
        source: "test.md",
        chunk_span: null,
        index_timestamp: "2026-08-03T00:00:00Z",
        content_hash: null,
        embedder: null,
        retrieval_time: null
      }
    };
    
    // mtime is older (Aug 2 vs Aug 3 index time)
    const mtimeMs = new Date("2026-08-02T00:00:00Z").getTime();
    
    const marked = injectStalenessMarker(hit, mtimeMs);
    expect(marked.provenance.stale).toBeUndefined();
  });
});
