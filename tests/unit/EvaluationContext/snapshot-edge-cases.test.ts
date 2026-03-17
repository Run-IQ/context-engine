import { describe, it, expect } from 'vitest';
import { EvaluationContext } from '../../../src/EvaluationContext';

const meta = { requestId: 'req-1', tenantId: 'T1', timestamp: '2025-01-01T00:00:00Z' };

describe('EvaluationContext.snapshot() — edge cases', () => {
  it('snapshot of empty context (no inputs, no writes)', () => {
    const ctx = new EvaluationContext({}, meta);
    const snap = ctx.snapshot('empty');
    expect(snap.state).toEqual({});
    expect(snap.meta.requestId).toBe('req-1');
    expect(snap.label).toBe('empty');
  });

  it('snapshot captures inputs set at construction', () => {
    const ctx = new EvaluationContext({ income: 6000000 }, meta);
    const snap = ctx.snapshot();
    expect(snap.state['input.income']).toBe(6000000);
  });

  it('snapshot captures raw data', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.setRaw('node', { breakdown: { TVA: 300 } });
    const snap = ctx.snapshot();
    expect(snap.state['node.__raw']).toEqual({ breakdown: { TVA: 300 } });
  });

  it('three snapshots capture progressive state growth', () => {
    const ctx = new EvaluationContext({}, meta);

    ctx.set('node1', 'val', 1);
    const snap1 = ctx.snapshot('after-node1');

    ctx.set('node2', 'val', 2);
    const snap2 = ctx.snapshot('after-node2');

    ctx.set('node3', 'val', 3);
    const snap3 = ctx.snapshot('after-node3');

    expect(Object.keys(snap1.state)).toHaveLength(1);
    expect(Object.keys(snap2.state)).toHaveLength(2);
    expect(Object.keys(snap3.state)).toHaveLength(3);

    // snap1 should NOT contain node2 or node3
    expect(snap1.state['node2.val']).toBeUndefined();
    expect(snap1.state['node3.val']).toBeUndefined();

    // snap2 should contain node1 and node2 but NOT node3
    expect(snap2.state['node1.val']).toBe(1);
    expect(snap2.state['node3.val']).toBeUndefined();

    // snap3 contains everything
    expect(snap3.state['node1.val']).toBe(1);
    expect(snap3.state['node2.val']).toBe(2);
    expect(snap3.state['node3.val']).toBe(3);
  });

  it('snapshot state is completely isolated from context — deep object', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('node', 'data', { nested: { value: 42 } });
    const snap = ctx.snapshot();

    // Write more data to context
    ctx.set('node2', 'val', 99);

    // Snapshot should not have node2
    expect(snap.state['node2.val']).toBeUndefined();

    // Snapshot state is frozen
    expect(Object.isFrozen(snap.state)).toBe(true);
  });

  it('default label uses incremental counter', () => {
    const ctx = new EvaluationContext({}, meta);
    const snap1 = ctx.snapshot();
    const snap2 = ctx.snapshot();
    expect(snap1.label).toBe('snapshot-1');
    expect(snap2.label).toBe('snapshot-2');
  });

  it('snapshot IDs are sequential and deterministic', () => {
    const ctx = new EvaluationContext({}, meta);
    const ids = Array.from({ length: 5 }, (_, i) => ctx.snapshot(`s${i}`).id);
    expect(ids).toEqual([
      'req-1:snap:0',
      'req-1:snap:1',
      'req-1:snap:2',
      'req-1:snap:3',
      'req-1:snap:4',
    ]);
  });

  it('getSnapshots returns frozen array — push throws', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.snapshot('test');
    const snaps = ctx.getSnapshots();
    expect(() =>
      (snaps as unknown[]).push({
        id: 'fake',
        label: 'injected',
        timestamp: 0,
        state: {},
        meta,
      }),
    ).toThrow();
  });

  it('getSnapshots returns a copy — not the internal array', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.snapshot('first');
    const snaps1 = ctx.getSnapshots();

    ctx.snapshot('second');
    const snaps2 = ctx.getSnapshots();

    // snaps1 should still have length 1
    expect(snaps1).toHaveLength(1);
    expect(snaps2).toHaveLength(2);
  });

  it('snapshot.meta is a copy — not the same reference as context meta', () => {
    const ctx = new EvaluationContext({}, meta);
    const snap = ctx.snapshot();
    expect(snap.meta).toEqual(meta);
    expect(snap.meta).not.toBe(meta); // different object
  });

  it('snapshot with 1000 entries captures all', () => {
    const ctx = new EvaluationContext({}, meta);
    for (let i = 0; i < 1000; i++) {
      ctx.set(`n${i}`, 'v', i);
    }
    const snap = ctx.snapshot('big');
    expect(Object.keys(snap.state)).toHaveLength(1000);
    expect(snap.state['n999.v']).toBe(999);
  });
});
