// merge.mjs - Merges results from multiple layers (e.g., vector + code-graph)

export function mergeLayerResults(vectorResults, graphHits) {
  if (!graphHits || graphHits.length === 0) {
    return vectorResults;
  }

  const merged = JSON.parse(JSON.stringify(vectorResults));

  if (merged.scopes && merged.scopes.length > 0) {
    // Merge into the first scope
    merged.scopes[0].hits.push(...graphHits);
    merged.scopes[0].hits.sort((a, b) => b.score - a.score);
  } else {
    merged.scopes = [
      {
        scope: "code-graph",
        collection: "graph",
        fallback_used: false,
        below_floor: 0,
        error: "",
        hits: [...graphHits].sort((a, b) => b.score - a.score)
      }
    ];
  }

  merged.total_hits = (merged.total_hits || 0) + graphHits.length;
  return merged;
}
