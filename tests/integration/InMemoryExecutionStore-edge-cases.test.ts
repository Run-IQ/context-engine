import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryExecutionStore } from '../../src/adapters/InMemoryExecutionStore';
import { ExecutionNotFoundError } from '../../src/errors';
import type { ExecutionRecord, ExecutionSummary } from '../../src/stores/ExecutionStore';

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

const makeSummary = (overrides: Partial<ExecutionSummary> = {}): ExecutionSummary => ({
  status: 'completed',
  completedAt: '2025-01-01T00:01:00Z',
  durationMs: 60000,
  executed: ['node-1'],
  skipped: [],
  failed: [],
  ...overrides,
});

describe('InMemoryExecutionStore — edge cases', () => {
  let store: InMemoryExecutionStore;

  beforeEach(() => {
    store = new InMemoryExecutionStore();
  });

  it('recordSnapshot without startExecution throws ExecutionNotFoundError', async () => {
    await expect(
      store.recordSnapshot('nonexistent', {
        id: 'snap-1',
        label: 'test',
        timestamp: Date.now(),
        state: {},
        meta: { requestId: 'req-1', tenantId: 'T1', timestamp: '2025-01-01T00:00:00Z' },
      }),
    ).rejects.toThrow(ExecutionNotFoundError);
  });

  it('completeExecution without startExecution throws ExecutionNotFoundError', async () => {
    await expect(store.completeExecution('nonexistent', makeSummary())).rejects.toThrow(
      ExecutionNotFoundError,
    );
  });

  it('listExecutions on empty store returns empty array', async () => {
    expect(await store.listExecutions('T1')).toEqual([]);
  });

  it('listExecutions with all filters combined', async () => {
    await store.startExecution(
      makeRecord({
        executionId: 'e1',
        graphId: 'g1',
        startedAt: '2025-03-01T00:00:00Z',
      }),
    );
    await store.startExecution(
      makeRecord({
        executionId: 'e2',
        graphId: 'g1',
        startedAt: '2025-06-01T00:00:00Z',
      }),
    );
    await store.startExecution(
      makeRecord({
        executionId: 'e3',
        graphId: 'g2',
        startedAt: '2025-06-15T00:00:00Z',
      }),
    );
    await store.completeExecution('e1', makeSummary());
    await store.completeExecution('e2', makeSummary());

    // Filter: graphId=g1, status=completed, from 2025-05-01 to 2025-12-31
    const results = await store.listExecutions('T1', {
      graphId: 'g1',
      status: 'completed',
      from: '2025-05-01T00:00:00Z',
      to: '2025-12-31T23:59:59Z',
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.executionId).toBe('e2');
  });

  it('multiple events maintain insertion order', async () => {
    await store.startExecution(makeRecord());
    for (let i = 0; i < 100; i++) {
      await store.recordEvent('exec-1', {
        executionId: 'exec-1',
        sequence: i,
        type: `event-${i}`,
        payload: `{"i":${i}}`,
        recordedAt: new Date(Date.now() + i).toISOString(),
      });
    }
    const exec = await store.getExecution('exec-1');
    expect(exec!.events).toHaveLength(100);
    for (let i = 0; i < 100; i++) {
      expect(exec!.events[i]!.sequence).toBe(i);
    }
  });

  it('multiple snapshots maintain insertion order', async () => {
    await store.startExecution(makeRecord());
    for (let i = 0; i < 10; i++) {
      await store.recordSnapshot('exec-1', {
        id: `req-1:snap:${i}`,
        label: `snap-${i}`,
        timestamp: Date.now() + i,
        state: { [`key${i}`]: i },
        meta: { requestId: 'req-1', tenantId: 'T1', timestamp: '2025-01-01T00:00:00Z' },
      });
    }
    const exec = await store.getExecution('exec-1');
    expect(exec!.snapshots).toHaveLength(10);
    expect(exec!.snapshots[0]!.label).toBe('snap-0');
    expect(exec!.snapshots[9]!.label).toBe('snap-9');
  });

  it('completeExecution with failed status', async () => {
    await store.startExecution(makeRecord());
    await store.completeExecution(
      'exec-1',
      makeSummary({ status: 'failed', failed: ['node-1'], executed: [] }),
    );
    const exec = await store.getExecution('exec-1');
    expect(exec!.record.status).toBe('failed');
    expect(exec!.summary!.failed).toEqual(['node-1']);
  });

  it('completeExecution with partial status', async () => {
    await store.startExecution(makeRecord());
    await store.completeExecution(
      'exec-1',
      makeSummary({
        status: 'partial',
        executed: ['node-1'],
        skipped: ['node-2'],
        failed: ['node-3'],
      }),
    );
    const exec = await store.getExecution('exec-1');
    expect(exec!.record.status).toBe('partial');
  });

  it('listExecutions with limit=0 returns empty', async () => {
    await store.startExecution(makeRecord());
    const results = await store.listExecutions('T1', { limit: 0 });
    expect(results).toEqual([]);
  });

  it('listExecutions with offset beyond count returns empty', async () => {
    await store.startExecution(makeRecord());
    const results = await store.listExecutions('T1', { offset: 100 });
    expect(results).toEqual([]);
  });

  it('stress test — 100 executions with events and snapshots', async () => {
    for (let i = 0; i < 100; i++) {
      const id = `exec-${i}`;
      await store.startExecution(makeRecord({ executionId: id, requestId: `req-${i}` }));
      await store.recordEvent(id, {
        executionId: id,
        sequence: 0,
        type: 'node.completed',
        payload: '{}',
        recordedAt: '2025-01-01T00:00:01Z',
      });
      await store.completeExecution(id, makeSummary());
    }
    const all = await store.listExecutions('T1');
    expect(all).toHaveLength(100);

    const limited = await store.listExecutions('T1', { limit: 10, offset: 50 });
    expect(limited).toHaveLength(10);
  });
});
