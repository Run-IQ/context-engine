import type { PersistenceAdapter } from '../PersistenceAdapter.js';
import { InMemoryGraphStore } from './InMemoryGraphStore.js';
import { InMemoryRuleStore } from './InMemoryRuleStore.js';
import { InMemoryExecutionStore } from './InMemoryExecutionStore.js';

export { InMemoryGraphStore } from './InMemoryGraphStore.js';
export { InMemoryRuleStore } from './InMemoryRuleStore.js';
export { InMemoryExecutionStore } from './InMemoryExecutionStore.js';

export function createInMemoryAdapter(): PersistenceAdapter {
  return {
    graphs: new InMemoryGraphStore(),
    rules: new InMemoryRuleStore(),
    executions: new InMemoryExecutionStore(),
  };
}
