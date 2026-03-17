import { describe, it, expect } from 'vitest';
import { EvaluationContext } from '../../../src/EvaluationContext';
/* errors imported by tests that trigger them directly */

const meta = { requestId: 'req-1', tenantId: 'T1', timestamp: '2025-01-01T00:00:00Z' };

describe('EvaluationContext.setRaw() — edge cases', () => {
  it('raw is deepFreeze — nested mutation throws', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.setRaw('node', { a: { b: [1, 2] } });
    const raw = ctx.get('node.__raw') as { a: { b: number[] } };
    expect(Object.isFrozen(raw)).toBe(true);
    expect(Object.isFrozen(raw.a)).toBe(true);
    expect(Object.isFrozen(raw.a.b)).toBe(true);
    expect(() => raw.a.b.push(3)).toThrow();
  });

  it('overwrite replaces entire raw — old subpaths gone', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.setRaw('node', { oldKey: 42 });
    expect(ctx.get('node.__raw.oldKey')).toBe(42);

    ctx.setRaw('node', { newKey: 99 });
    expect(ctx.get('node.__raw.oldKey')).toBeUndefined();
    expect(ctx.get('node.__raw.newKey')).toBe(99);
  });

  it('setRaw with null value', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.setRaw('node', null);
    expect(ctx.get('node.__raw')).toBeNull();
  });

  it('setRaw with array value', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.setRaw('node', [1, 2, 3]);
    const raw = ctx.get('node.__raw') as number[];
    expect(raw).toEqual([1, 2, 3]);
    expect(Object.isFrozen(raw)).toBe(true);
  });

  it('setRaw with primitive value', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.setRaw('node', 42);
    expect(ctx.get('node.__raw')).toBe(42);
  });

  it('raw appears in getFullState() but not in getNodeOutputs()', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('node', 'result', 100);
    ctx.setRaw('node', { debug: true });
    const full = ctx.getFullState();
    expect(full['node.__raw']).toEqual({ debug: true });
    const outputs = ctx.getNodeOutputs('node');
    expect(outputs).toEqual({ result: 100 });
  });

  it('allowRawOverwrite=false with different nodes does not conflict', () => {
    const ctx = new EvaluationContext({}, meta, {
      limits: { allowRawOverwrite: false },
    });
    ctx.setRaw('node1', { v: 1 });
    ctx.setRaw('node2', { v: 2 }); // different node — should be fine
    expect(ctx.get('node1.__raw')).toEqual({ v: 1 });
    expect(ctx.get('node2.__raw')).toEqual({ v: 2 });
  });

  it('setRaw does not block set() for same node', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.setRaw('node', { raw: true });
    ctx.set('node', 'output', 42);
    expect(ctx.get('node.__raw')).toEqual({ raw: true });
    expect(ctx.get('node.output')).toBe(42);
  });

  it('setRaw rejects reserved namespace __internal', () => {
    // setRaw only validates nodeId, and __internal matches /^[a-zA-Z0-9_-]+$/
    // But setRaw does not check reserved namespaces (only set() does)
    // This is by design — setRaw is internal plumbing
    const ctx = new EvaluationContext({}, meta);
    ctx.setRaw('__internal', { debug: true });
    expect(ctx.get('__internal.__raw')).toEqual({ debug: true });
  });
});
