import { describe, it, expect } from 'vitest';
import { EvaluationContext } from '../../../src/EvaluationContext';

const meta = { requestId: 'req-1', tenantId: 'T1', timestamp: '2025-01-01T00:00:00Z' };

describe('EvaluationContext.snapshot()', () => {
  it('returns a ContextSnapshot with id, label, timestamp, state, meta', () => {
    const ctx = new EvaluationContext({ income: 100 }, meta);
    ctx.set('node', 'val', 42);
    const snap = ctx.snapshot('test-snapshot');
    expect(snap.id).toBe('req-1:snap:0');
    expect(snap.label).toBe('test-snapshot');
    expect(typeof snap.timestamp).toBe('number');
    expect(snap.state['node.val']).toBe(42);
    expect(snap.state['input.income']).toBe(100);
    expect(snap.meta.requestId).toBe('req-1');
  });

  it('snapshot.state is Object.freeze', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('node', 'val', 42);
    const snap = ctx.snapshot();
    expect(Object.isFrozen(snap.state)).toBe(true);
  });

  it('modifying context after snapshot does not modify snapshot.state', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('node', 'val', 42);
    const snap = ctx.snapshot();
    ctx.set('node2', 'val', 99);
    expect(snap.state['node2.val']).toBeUndefined();
  });

  it('two successive snapshots have different IDs', () => {
    const ctx = new EvaluationContext({}, meta);
    const snap1 = ctx.snapshot('first');
    const snap2 = ctx.snapshot('second');
    expect(snap1.id).not.toBe(snap2.id);
    expect(snap1.id).toBe('req-1:snap:0');
    expect(snap2.id).toBe('req-1:snap:1');
  });

  it('getSnapshots() returns all snapshots in creation order', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.snapshot('first');
    ctx.snapshot('second');
    ctx.snapshot('third');
    const snaps = ctx.getSnapshots();
    expect(snaps).toHaveLength(3);
    expect(snaps[0]!.label).toBe('first');
    expect(snaps[1]!.label).toBe('second');
    expect(snaps[2]!.label).toBe('third');
  });

  it('getSnapshots() returns a frozen copy — no mutation possible', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.snapshot('test');
    const snaps = ctx.getSnapshots();
    expect(Object.isFrozen(snaps)).toBe(true);
  });
});
