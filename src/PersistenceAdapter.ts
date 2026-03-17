import type { GraphStore } from './stores/GraphStore.js';
import type { RuleStore } from './stores/RuleStore.js';
import type { ExecutionStore } from './stores/ExecutionStore.js';

export interface PersistenceAdapter {
  readonly graphs?: GraphStore;
  readonly rules?: RuleStore;
  readonly executions?: ExecutionStore;
}
