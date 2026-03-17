import type { ContextSnapshot } from '../types/snapshot.js';

export interface ExecutionRecord {
  readonly executionId: string;
  readonly requestId: string;
  readonly tenantId: string;
  readonly userId?: string;
  readonly graphId: string;
  readonly graphHash: string;
  readonly graphVersion: string;
  readonly startedAt: string;
  status: 'running' | 'completed' | 'failed' | 'partial';
}

export interface ExecutionSummary {
  readonly status: 'completed' | 'failed' | 'partial';
  readonly completedAt: string;
  readonly durationMs: number;
  readonly executed: readonly string[];
  readonly skipped: readonly string[];
  readonly failed: readonly string[];
}

export interface StoredExecution {
  record: ExecutionRecord;
  events: SerializedEvent[];
  snapshots: ContextSnapshot[];
  summary?: ExecutionSummary;
}

export interface SerializedEvent {
  readonly executionId: string;
  readonly sequence: number;
  readonly type: string;
  readonly payload: string;
  readonly recordedAt: string;
}

export interface ExecutionFilters {
  readonly graphId?: string;
  readonly status?: 'running' | 'completed' | 'failed' | 'partial';
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ExecutionStore {
  startExecution(record: ExecutionRecord): Promise<string>;
  recordEvent(executionId: string, event: SerializedEvent): Promise<void>;
  recordSnapshot(executionId: string, snapshot: ContextSnapshot): Promise<void>;
  completeExecution(executionId: string, summary: ExecutionSummary): Promise<void>;
  getExecution(executionId: string): Promise<StoredExecution | null>;
  listExecutions(tenantId: string, filters?: ExecutionFilters): Promise<ExecutionRecord[]>;
}
