import type { ExecutionMeta } from './meta.js';

export interface ContextSnapshot {
  readonly id: string;
  readonly label: string;
  readonly timestamp: number;
  readonly state: Readonly<Record<string, unknown>>;
  readonly meta: Readonly<ExecutionMeta>;
}
