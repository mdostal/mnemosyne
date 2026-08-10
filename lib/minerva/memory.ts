import { MnemosyneClient, Scope, Intent, RecallResult } from '../mnemosyne/interfaces.js';

export class MinervaMemory {
  constructor(private client: MnemosyneClient) {}

  /**
   * Replaces legacy grep/find calls with unified Mnemosyne recall()
   * @param query The search term or semantic concept
   * @param scope The boundary of the search (project, enterprise, meta)
   * @param intent Hint for narrow vs broad search
   */
  public searchContext(query: string, scope: Scope = 'project', intent: Intent = 'broad'): RecallResult {
    return this.client.recall(query, scope, intent);
  }
}
