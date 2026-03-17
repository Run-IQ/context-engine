import { describe, it, expect } from 'vitest';
import { EvaluationContext } from '../../src/EvaluationContext';
import { createInMemoryAdapter } from '../../src/adapters/index';
import { ContextConflictError, ContextLimitError, ContextValidationError } from '../../src/errors';
import type { ContextLifecycleHooks } from '../../src/types/hooks';

describe('Full execution lifecycle — simulates a DG execution', () => {
  it('complete lifecycle: input → nodes → snapshots → audit → verify', async () => {
    const adapter = createInMemoryAdapter();

    // ─── Phase 1: Setup rules ───────────────────────────────────────────────
    const irppSaved = await adapter.rules!.saveRule({
      id: 'irpp-rule',
      model: 'PROGRESSIVE_BRACKET',
      tenantId: 'TG-001',
      scope: 'tenant-specific',
      effectiveFrom: '2025-01-01',
      tags: ['fiscal', 'irpp'],
      createdBy: 'test-user',
      payload: JSON.stringify({ brackets: [{ from: 0, to: 900000, rate: 0 }] }),
    });
    await adapter.rules!.updateRuleStatus(irppSaved.id, irppSaved.version, 'review', 'test-user');
    await adapter.rules!.publishRule(irppSaved.id, irppSaved.version, 'test-user');

    const tvaSaved = await adapter.rules!.saveRule({
      id: 'tva-rule',
      model: 'FLAT_RATE',
      tenantId: 'TG-001',
      scope: 'tenant-specific',
      effectiveFrom: '2025-01-01',
      tags: ['fiscal', 'tva'],
      createdBy: 'test-user',
      payload: JSON.stringify({ rate: 0.18 }),
    });
    await adapter.rules!.updateRuleStatus(tvaSaved.id, tvaSaved.version, 'review', 'test-user');
    await adapter.rules!.publishRule(tvaSaved.id, tvaSaved.version, 'test-user');

    // ─── Phase 2: Save graph ─────────────────────────────────────────────────
    await adapter.graphs!.saveGraph({
      id: 'fiscal-graph',
      version: '1.0.0',
      tenantId: 'TG-001',
      createdAt: '2025-01-01T00:00:00Z',
      payload: '{"nodes":["irpp","tva","report"]}',
      checksum: 'graph-hash-1',
    });

    // ─── Phase 3: Create context and start execution ─────────────────────────
    const hookLog: string[] = [];
    const hooks: ContextLifecycleHooks = {
      beforeSet: (nodeId, portName) => hookLog.push(`before:${nodeId}.${portName}`),
      afterSet: (nodeId, portName) => hookLog.push(`after:${nodeId}.${portName}`),
      beforeGet: (key) => hookLog.push(`get:${key}`),
    };

    const ctx = new EvaluationContext(
      { income: 6000000, employeeCount: 5 },
      {
        requestId: 'exec-2025-001',
        tenantId: 'TG-001',
        timestamp: '2025-06-01T10:00:00Z',
        effectiveDate: '2025-06-01',
        context: { country: 'TG', regime: 'REEL' },
      },
      { hooks, adapter, limits: { maxValueSizeKb: 512, maxTotalSizeKb: 50000, maxEntries: 10000 } },
    );

    // Start execution in store
    await adapter.executions!.startExecution({
      executionId: 'exec-2025-001',
      requestId: 'exec-2025-001',
      tenantId: 'TG-001',
      graphId: 'fiscal-graph',
      graphHash: 'graph-hash-1',
      graphVersion: '1.0.0',
      startedAt: '2025-06-01T10:00:00Z',
      status: 'running',
    });

    // ─── Phase 4: Resolve rules ─────────────────────────────────────────────
    const rules = await adapter.rules!.resolveRules({
      tenantId: 'TG-001',
      effectiveDate: '2025-06-01',
    });
    expect(rules).toHaveLength(2);

    // ─── Phase 5: Execute nodes ──────────────────────────────────────────────

    // Node: irpp_calc
    const irppResult = 1200000;
    ctx.set('irpp_calc', 'taxDue', irppResult);
    ctx.set('irpp_calc', 'regime', 'REEL');
    ctx.setRaw('irpp_calc', {
      brackets: [
        { from: 0, to: 900000, rate: 0, tax: 0 },
        { from: 900001, to: 6000000, rate: 0.235, tax: 1198500 },
      ],
      total: irppResult,
    });

    // Record event
    await adapter.executions!.recordEvent('exec-2025-001', {
      executionId: 'exec-2025-001',
      sequence: 0,
      type: 'node.completed',
      payload: JSON.stringify({ nodeId: 'irpp_calc', duration: 12 }),
      recordedAt: '2025-06-01T10:00:01Z',
    });

    // Snapshot after level 0
    const snap0 = ctx.snapshot('after-level-0');
    await adapter.executions!.recordSnapshot('exec-2025-001', snap0);

    // Node: tva_calc
    const tvaResult = 1080000;
    ctx.set('tva_calc', 'taxDue', tvaResult);
    ctx.setRaw('tva_calc', { base: 6000000, rate: 0.18, total: tvaResult });

    // Record event
    await adapter.executions!.recordEvent('exec-2025-001', {
      executionId: 'exec-2025-001',
      sequence: 1,
      type: 'node.completed',
      payload: JSON.stringify({ nodeId: 'tva_calc', duration: 5 }),
      recordedAt: '2025-06-01T10:00:02Z',
    });

    // Snapshot after level 1
    const snap1 = ctx.snapshot('after-level-1');
    await adapter.executions!.recordSnapshot('exec-2025-001', snap1);

    // Node: report (reads from previous nodes)
    const irppVal = ctx.get('irpp_calc.taxDue') as number;
    const tvaVal = ctx.get('tva_calc.taxDue') as number;
    ctx.set('report', 'totalDue', irppVal + tvaVal);

    // ─── Phase 6: Complete execution ─────────────────────────────────────────
    await adapter.executions!.completeExecution('exec-2025-001', {
      status: 'completed',
      completedAt: '2025-06-01T10:00:03Z',
      durationMs: 3000,
      executed: ['irpp_calc', 'tva_calc', 'report'],
      skipped: [],
      failed: [],
    });

    // ─── Phase 7: Verify everything ──────────────────────────────────────────

    // Context state
    expect(ctx.get('input.income')).toBe(6000000);
    expect(ctx.get('input.employeeCount')).toBe(5);
    expect(ctx.get('irpp_calc.taxDue')).toBe(1200000);
    expect(ctx.get('tva_calc.taxDue')).toBe(1080000);
    expect(ctx.get('report.totalDue')).toBe(2280000);
    expect(ctx.get('irpp_calc.__raw.brackets.0.rate')).toBe(0);
    expect(ctx.get('tva_calc.__raw.rate')).toBe(0.18);

    // getNodeOutputs
    expect(ctx.getNodeOutputs('irpp_calc')).toEqual({ taxDue: 1200000, regime: 'REEL' });
    expect(ctx.getNodeOutputs('tva_calc')).toEqual({ taxDue: 1080000 });
    expect(ctx.getNodeOutputs('report')).toEqual({ totalDue: 2280000 });

    // Metrics
    // input.income, input.employeeCount, irpp_calc.taxDue, irpp_calc.regime,
    // irpp_calc.__raw, tva_calc.taxDue, tva_calc.__raw, report.totalDue = 8
    expect(ctx.entryCount()).toBe(8);
    expect(ctx.sizeKb()).toBeGreaterThan(0);

    // Snapshots
    const snapshots = ctx.getSnapshots();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]!.label).toBe('after-level-0');
    expect(snapshots[1]!.label).toBe('after-level-1');

    // snap0 should NOT contain tva_calc or report
    expect(snapshots[0]!.state['tva_calc.taxDue']).toBeUndefined();
    expect(snapshots[0]!.state['report.totalDue']).toBeUndefined();

    // snap1 should contain irpp and tva but NOT report
    expect(snapshots[1]!.state['irpp_calc.taxDue']).toBe(1200000);
    expect(snapshots[1]!.state['tva_calc.taxDue']).toBe(1080000);
    expect(snapshots[1]!.state['report.totalDue']).toBeUndefined();

    // Hooks fired — 4 set() calls (setRaw does NOT trigger beforeSet/afterSet)
    // irpp_calc.taxDue, irpp_calc.regime, tva_calc.taxDue, report.totalDue
    expect(hookLog.filter((h) => h.startsWith('before:'))).toHaveLength(4);
    expect(hookLog.filter((h) => h.startsWith('after:'))).toHaveLength(4);

    // Execution store
    const exec = await adapter.executions!.getExecution('exec-2025-001');
    expect(exec).not.toBeNull();
    expect(exec!.record.status).toBe('completed');
    expect(exec!.events).toHaveLength(2);
    expect(exec!.snapshots).toHaveLength(2);
    expect(exec!.summary!.durationMs).toBe(3000);
    expect(exec!.summary!.executed).toEqual(['irpp_calc', 'tva_calc', 'report']);

    // Graph store
    const graph = await adapter.graphs!.getGraph('fiscal-graph', '1.0.0');
    expect(graph.id).toBe('fiscal-graph');

    // Rule store fingerprint
    const fp1 = adapter.rules!.fingerprint({ tenantId: 'TG-001', effectiveDate: '2025-06-01' });
    const fp2 = adapter.rules!.fingerprint({ tenantId: 'TG-001', effectiveDate: '2025-06-01' });
    expect(fp1).toBe(fp2); // deterministic
  });

  it('error scenario: conflicting node outputs detected immediately', () => {
    const ctx = new EvaluationContext(
      { income: 100 },
      {
        requestId: 'req-err',
        tenantId: 'T1',
        timestamp: '2025-01-01T00:00:00Z',
      },
    );

    ctx.set('node_a', 'result', 42);

    // Another node tries to write to the same key — graph design error
    expect(() => ctx.set('node_a', 'result', 99)).toThrow(ContextConflictError);

    // Original value preserved
    expect(ctx.get('node_a.result')).toBe(42);
  });

  it('error scenario: runaway node producing too much data', () => {
    const ctx = new EvaluationContext(
      {},
      {
        requestId: 'req-runaway',
        tenantId: 'T1',
        timestamp: '2025-01-01T00:00:00Z',
      },
      {
        limits: { maxEntries: 5 },
      },
    );

    ctx.set('n1', 'v', 1);
    ctx.set('n2', 'v', 2);
    ctx.set('n3', 'v', 3);
    ctx.set('n4', 'v', 4);
    ctx.set('n5', 'v', 5);
    expect(() => ctx.set('n6', 'v', 6)).toThrow(ContextLimitError);

    // State is clean — only 5 entries
    expect(ctx.entryCount()).toBe(5);
  });

  it('error scenario: injection attempt via nodeId', () => {
    const ctx = new EvaluationContext(
      {},
      {
        requestId: 'req-inject',
        tenantId: 'T1',
        timestamp: '2025-01-01T00:00:00Z',
      },
    );

    // Various injection attempts
    expect(() => ctx.set('node;DROP TABLE', 'port', 1)).toThrow(ContextValidationError);
    expect(() => ctx.set('node<script>', 'port', 1)).toThrow(ContextValidationError);
    expect(() => ctx.set('../etc/passwd', 'port', 1)).toThrow(ContextValidationError);
    expect(() => ctx.set('node\x00null', 'port', 1)).toThrow(ContextValidationError);

    // State untouched
    expect(ctx.entryCount()).toBe(0);
  });
});
