import { describe, it, expect } from 'vitest';
import { createInMemoryAdapter } from '../../src/adapters/index';
import type { SerializedGraph } from '../../src/stores/GraphStore';
import type { RuleInput } from '../../src/stores/RuleStore';
import { sha256 } from '../../src/utils';

describe('createInMemoryAdapter — full lifecycle', () => {
  it('creates an adapter with all three stores', () => {
    const adapter = createInMemoryAdapter();
    expect(adapter.graphs).toBeDefined();
    expect(adapter.rules).toBeDefined();
    expect(adapter.executions).toBeDefined();
  });

  it('graph store lifecycle — save, retrieve, list', async () => {
    const adapter = createInMemoryAdapter();
    const graph: SerializedGraph = {
      id: 'g1',
      version: '1.0.0',
      tenantId: 'T1',
      createdAt: '2025-01-01T00:00:00Z',
      payload: '{}',
      checksum: sha256('{}'),
    };
    await adapter.graphs!.saveGraph(graph);
    const retrieved = await adapter.graphs!.getGraph('g1', '1.0.0');
    expect(retrieved).toEqual(graph);
    const list = await adapter.graphs!.listGraphs('T1');
    expect(list).toHaveLength(1);
  });

  it('rule store lifecycle — save, resolve, fingerprint', async () => {
    const adapter = createInMemoryAdapter();
    const ruleInput: RuleInput = {
      model: 'FLAT_RATE',
      tenantId: 'T1',
      scope: 'tenant-specific',
      effectiveFrom: '2025-01-01',
      payload: '{}',
      createdBy: 'test-user',
    };
    const saved = await adapter.rules!.saveRule(ruleInput);

    // Publish: draft → review → published
    await adapter.rules!.updateRuleStatus(saved.id, saved.version, 'review', 'test-user');
    await adapter.rules!.publishRule(saved.id, saved.version, 'test-user');

    const resolved = await adapter.rules!.resolveRules({
      tenantId: 'T1',
      effectiveDate: '2025-06-01',
    });
    expect(resolved).toHaveLength(1);
    const fp = adapter.rules!.fingerprint({ tenantId: 'T1', effectiveDate: '2025-06-01' });
    expect(typeof fp).toBe('string');
    expect(fp).toHaveLength(64);
  });

  it('execution store lifecycle — start, event, snapshot, complete, get', async () => {
    const adapter = createInMemoryAdapter();
    const id = await adapter.executions!.startExecution({
      executionId: 'exec-1',
      requestId: 'req-1',
      tenantId: 'T1',
      graphId: 'g1',
      graphHash: 'h1',
      graphVersion: '1.0.0',
      startedAt: '2025-01-01T00:00:00Z',
      status: 'running',
    });
    expect(id).toBe('exec-1');

    await adapter.executions!.recordEvent('exec-1', {
      executionId: 'exec-1',
      sequence: 0,
      type: 'node.started',
      payload: '{}',
      recordedAt: '2025-01-01T00:00:01Z',
    });

    await adapter.executions!.recordSnapshot('exec-1', {
      id: 'req-1:snap:0',
      label: 'test',
      timestamp: Date.now(),
      state: {},
      meta: { requestId: 'req-1', tenantId: 'T1', timestamp: '2025-01-01T00:00:00Z' },
    });

    await adapter.executions!.completeExecution('exec-1', {
      status: 'completed',
      completedAt: '2025-01-01T00:01:00Z',
      durationMs: 60000,
      executed: ['node-1'],
      skipped: [],
      failed: [],
    });

    const exec = await adapter.executions!.getExecution('exec-1');
    expect(exec).not.toBeNull();
    expect(exec!.record.status).toBe('completed');
    expect(exec!.events).toHaveLength(1);
    expect(exec!.snapshots).toHaveLength(1);
    expect(exec!.summary!.status).toBe('completed');
  });

  it('each createInMemoryAdapter call creates fresh instances — no singleton', async () => {
    const adapter1 = createInMemoryAdapter();
    const adapter2 = createInMemoryAdapter();

    await adapter1.graphs!.saveGraph({
      id: 'g1',
      version: '1.0.0',
      tenantId: 'T1',
      createdAt: '2025-01-01T00:00:00Z',
      payload: '{}',
      checksum: 'abc',
    });

    const list = await adapter2.graphs!.listGraphs('T1');
    expect(list).toHaveLength(0);
  });
});
