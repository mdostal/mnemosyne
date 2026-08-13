import { MnemosyneClient, Scope, RememberResult } from '../mnemosyne/interfaces.js';

export class MinervaDecisions {
  constructor(private client: MnemosyneClient) {}

  /**
   * Records a planning decision using Mnemosyne's remember API
   * @param decision The decision text
   * @param scope The boundary scope (e.g. 'project')
   */
  public recordPlanningDecision(decision: string, scope: Scope = 'project'): RememberResult {
    return this.client.remember(
      {
        text: decision,
        metadata: { type: 'planning_decision' }
      },
      scope,
      'project'
    );
  }
}
