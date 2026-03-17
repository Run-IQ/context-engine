import type {
  ExecutionStore,
  ExecutionRecord,
  ExecutionSummary,
  StoredExecution,
  SerializedEvent,
  ExecutionFilters,
} from '../stores/ExecutionStore.js';
import type { ContextSnapshot } from '../types/snapshot.js';
import { ExecutionNotFoundError } from '../errors.js';

export class InMemoryExecutionStore implements ExecutionStore {
  private readonly executions: Map<string, StoredExecution> = new Map();

  async startExecution(record: ExecutionRecord): Promise<string> {
    if (this.executions.has(record.executionId)) {
      return record.executionId;
    }
    this.executions.set(record.executionId, {
      record: { ...record, status: 'running' },
      events: [],
      snapshots: [],
    });
    return record.executionId;
  }

  async recordEvent(executionId: string, event: SerializedEvent): Promise<void> {
    const exec = this.getOrThrow(executionId);
    exec.events.push(event);
  }

  async recordSnapshot(executionId: string, snapshot: ContextSnapshot): Promise<void> {
    const exec = this.getOrThrow(executionId);
    exec.snapshots.push(snapshot);
  }

  async completeExecution(executionId: string, summary: ExecutionSummary): Promise<void> {
    const exec = this.getOrThrow(executionId);
    exec.record.status = summary.status;
    exec.summary = summary;
  }

  async getExecution(executionId: string): Promise<StoredExecution | null> {
    return this.executions.get(executionId) ?? null;
  }

  async listExecutions(tenantId: string, filters?: ExecutionFilters): Promise<ExecutionRecord[]> {
    let records = [...this.executions.values()]
      .map((e) => e.record)
      .filter((r) => r.tenantId === tenantId);

    if (filters?.graphId) records = records.filter((r) => r.graphId === filters.graphId);
    if (filters?.status) records = records.filter((r) => r.status === filters.status);
    if (filters?.from) records = records.filter((r) => r.startedAt >= filters.from!);
    if (filters?.to) records = records.filter((r) => r.startedAt <= filters.to!);

    const offset = filters?.offset ?? 0;
    const limit = filters?.limit ?? records.length;
    return records.slice(offset, offset + limit);
  }

  private getOrThrow(executionId: string): StoredExecution {
    const exec = this.executions.get(executionId);
    if (!exec) {
      throw new ExecutionNotFoundError(
        `Execution "${executionId}" not found. ` +
          `Was startExecution() called before recordEvent() ?`,
      );
    }
    return exec;
  }
}
