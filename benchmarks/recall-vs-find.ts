import { MnemosyneClient, RecallResult } from '../lib/mnemosyne/interfaces.js';

export function estimateTokens(text: string): number {
  // Rough heuristic: 4 chars per token
  return Math.ceil(text.length / 4);
}

export function compareTokenCost(client: MnemosyneClient, query: string, scope: 'project' | 'enterprise' | 'meta') {
  // Simulate standard find/grep token cost for baseline comparison
  // In reality this would measure token cost of reading multiple matched files in full.
  const baselineGrepTokens = 2000;
  
  const result = client.recall(query, scope, 'broad');
  
  let recallTokens = 0;
  
  if (result.ok) {
    for (const hit of result.hits) {
      recallTokens += estimateTokens(hit.content);
    }
  }
  
  const ratio = baselineGrepTokens > 0 ? recallTokens / baselineGrepTokens : 0;
  
  return {
    recallTokens,
    findTokens: baselineGrepTokens,
    ratio,
    beatsFind: recallTokens <= baselineGrepTokens
  };
}
