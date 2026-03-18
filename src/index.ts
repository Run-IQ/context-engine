// Types
export type { ExecutionMeta } from './types/meta.js';
export type { ContextLimits } from './types/limits.js';
export type { ContextLifecycleHooks } from './types/hooks.js';
export type { ContextSnapshot } from './types/snapshot.js';
export type { EvaluationContextOptions } from './types/options.js';

// Core class
export { EvaluationContext } from './EvaluationContext.js';

// Store interfaces
export type {
  GraphStore,
  SerializedGraph,
  SerializedCompiledGraph,
  GraphMetadata,
} from './stores/GraphStore.js';
export type {
  RuleStore,
  RuleQuery,
  RuleListQuery,
  RuleInput,
  SerializedRule,
  RuleMetadata,
  RuleStatus,
  RuleScope,
  RuleAuditEvent,
  RuleAuditEventType,
  RuleConflict,
  RuleConflictType,
} from './stores/RuleStore.js';
export type {
  ExecutionStore,
  ExecutionRecord,
  ExecutionSummary,
  StoredExecution,
  SerializedEvent,
  ExecutionFilters,
} from './stores/ExecutionStore.js';

// PersistenceAdapter
export type { PersistenceAdapter } from './PersistenceAdapter.js';

// Errors
export {
  ContextError,
  ContextConflictError,
  ContextLimitError,
  ContextValidationError,
  GraphNotFoundError,
  GraphVersionConflictError,
  ExecutionNotFoundError,
  RuleNotFoundError,
  RuleVersionConflictError,
  RuleTransitionError,
  RulePublishError,
} from './errors.js';

// Utilities
export {
  deepFreeze,
  cloneAndFreeze,
  safeClone,
  roughSizeKb,
  sha256,
  getNestedValue,
} from './utils.js';

// InMemory adapters
export {
  InMemoryGraphStore,
  InMemoryRuleStore,
  InMemoryExecutionStore,
  createInMemoryAdapter,
} from './adapters/index.js';
