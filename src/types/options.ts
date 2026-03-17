import type { ContextLimits } from './limits.js';
import type { ContextLifecycleHooks } from './hooks.js';
import type { PersistenceAdapter } from '../PersistenceAdapter.js';

export interface EvaluationContextOptions {
  readonly limits?: ContextLimits;
  readonly hooks?: ContextLifecycleHooks;
  readonly adapter?: PersistenceAdapter;
}
