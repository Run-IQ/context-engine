import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryExecutionStore } from '../../src/adapters/InMemoryExecutionStore';
import { ExecutionNotFoundError } from '../../src/errors';
import type {
  ExecutionRecord,
  SerializedEvent,
  ExecutionSummary,
} from '../../src/stores/ExecutionStore';
import type { ContextSnapshot } from '../../src/types/snapshot';

const makeRecord = (overrides: Partial<ExecutionRecord> = {}): ExecutionRecord => ({
  executionId: 'exec-1',
  requestId: 'req-1',
  tenantId: 'T1',
  graphId: 'graph-1',
  graphHash: 'hash-1',
  graphVersion: '1.0.0',
  startedAt: '2025-01-01T00:00:00Z',
  status: 'running',
  ...overrides,
});

const makeEvent = (seq: number): SerializedEvent => ({
  executionId: 'exec-1',
  sequence: seq,
  type: 'node.completed',
  payload: '{}',
  recordedAt: '2025-01-01T00:00:01Z',
});

const makeSnapshot = (id: string): ContextSnapshot => ({
  id,
  label: 'test',
  timestamp: Date.now(),
  state: {},
  meta: { requestId: 'req-1', tenantId: 'T1', timestamp: '2025-01-01T00:00:00Z' },
});

describe('InMemoryExecutionStore', () => {
  let store: InMemoryExecutionStore;

  beforeEach(() => {
    store = new InMemoryExecutionStore();
  });

  it('startExecution creates a record with status running', async () => {
    const id = await store.startExecution(makeRecord());
    expect(id).toBe('exec-1');
    const exec = await store.getExecution('exec-1');
    expect(exec!.record.status).toBe('running');
  });

  it('startExecution is idempotent — same ID twice returns ID without error', async () => {
    await store.startExecution(makeRecord());
    const id = await store.startExecution(makeRecord());
    expect(id).toBe('exec-1');
  });

  it('recordEvent adds events in order after startExecution', async () => {
    await store.startExecution(makeRecord());
    await store.recordEvent('exec-1', makeEvent(0));
    await store.recordEvent('exec-1', makeEvent(1));
    const exec = await store.getExecution('exec-1');
    expect(exec!.events).toHaveLength(2);
    expect(exec!.events[0]!.sequence).toBe(0);
    expect(exec!.events[1]!.sequence).toBe(1);
  });

  it('recordEvent without startExecution throws ExecutionNotFoundError', async () => {
    await expect(store.recordEvent('nonexistent', makeEvent(0))).rejects.toThrow(
      ExecutionNotFoundError,
    );
  });

  it('recordSnapshot adds the snapshot to the execution', async () => {
    await store.startExecution(makeRecord());
    const snap = makeSnapshot('req-1:snap:0');
    await store.recordSnapshot('exec-1', snap);
    const exec = await store.getExecution('exec-1');
    expect(exec!.snapshots).toHaveLength(1);
    expect(exec!.snapshots[0]!.id).toBe('req-1:snap:0');
  });

  it('completeExecution updates status and summary', async () => {
    await store.startExecution(makeRecord());
    const summary: ExecutionSummary = {
      status: 'completed',
      completedAt: '2025-01-01T00:01:00Z',
      durationMs: 60000,
      executed: ['node-1', 'node-2'],
      skipped: [],
      failed: [],
    };
    await store.completeExecution('exec-1', summary);
    const exec = await store.getExecution('exec-1');
    expect(exec!.record.status).toBe('completed');
    expect(exec!.summary).toEqual(summary);
  });

  it('getExecution returns record + events + snapshots + summary', async () => {
    await store.startExecution(makeRecord());
    await store.recordEvent('exec-1', makeEvent(0));
    await store.recordSnapshot('exec-1', makeSnapshot('snap-1'));
    const summary: ExecutionSummary = {
      status: 'completed',
      completedAt: '2025-01-01T00:01:00Z',
      durationMs: 1000,
      executed: ['n1'],
      skipped: [],
      failed: [],
    };
    await store.completeExecution('exec-1', summary);

    const exec = await store.getExecution('exec-1');
    expect(exec).not.toBeNull();
    expect(exec!.record.executionId).toBe('exec-1');
    expect(exec!.events).toHaveLength(1);
    expect(exec!.snapshots).toHaveLength(1);
    expect(exec!.summary).toEqual(summary);
  });

  it('getExecution with non-existent ID returns null', async () => {
    const result = await store.getExecution('nonexistent');
    expect(result).toBeNull();
  });

  it('listExecutions filters by tenantId', async () => {
    await store.startExecution(makeRecord({ executionId: 'exec-1', tenantId: 'T1' }));
    await store.startExecution(makeRecord({ executionId: 'exec-2', tenantId: 'T2' }));
    const list = await store.listExecutions('T1');
    expect(list).toHaveLength(1);
    expect(list[0]!.tenantId).toBe('T1');
  });

  it('listExecutions filters by graphId', async () => {
    await store.startExecution(makeRecord({ executionId: 'exec-1', graphId: 'g1' }));
    await store.startExecution(makeRecord({ executionId: 'exec-2', graphId: 'g2' }));
    const list = await store.listExecutions('T1', { graphId: 'g1' });
    expect(list).toHaveLength(1);
    expect(list[0]!.graphId).toBe('g1');
  });

  it('listExecutions filters by status', async () => {
    await store.startExecution(makeRecord({ executionId: 'exec-1' }));
    await store.startExecution(makeRecord({ executionId: 'exec-2' }));
    await store.completeExecution('exec-2', {
      status: 'completed',
      completedAt: '2025-01-01T00:01:00Z',
      durationMs: 1000,
      executed: [],
      skipped: [],
      failed: [],
    });
    const list = await store.listExecutions('T1', { status: 'running' });
    expect(list).toHaveLength(1);
    expect(list[0]!.executionId).toBe('exec-1');
  });

  it('listExecutions filters by from/to (startedAt)', async () => {
    await store.startExecution(
      makeRecord({ executionId: 'exec-1', startedAt: '2025-01-01T00:00:00Z' }),
    );
    await store.startExecution(
      makeRecord({ executionId: 'exec-2', startedAt: '2025-06-01T00:00:00Z' }),
    );
    const list = await store.listExecutions('T1', {
      from: '2025-03-01T00:00:00Z',
      to: '2025-12-31T23:59:59Z',
    });
    expect(list).toHaveLength(1);
    expect(list[0]!.executionId).toBe('exec-2');
  });

  it('listExecutions respects limit and offset', async () => {
    await store.startExecution(makeRecord({ executionId: 'exec-1' }));
    await store.startExecution(makeRecord({ executionId: 'exec-2' }));
    await store.startExecution(makeRecord({ executionId: 'exec-3' }));

    const list = await store.listExecutions('T1', { limit: 2, offset: 1 });
    expect(list).toHaveLength(2);
    expect(list[0]!.executionId).toBe('exec-2');
    expect(list[1]!.executionId).toBe('exec-3');
  });
});
