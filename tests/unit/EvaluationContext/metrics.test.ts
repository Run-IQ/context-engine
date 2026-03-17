import { describe, it, expect } from 'vitest';
import { EvaluationContext } from '../../../src/EvaluationContext';

const meta = { requestId: 'req-1', tenantId: 'T1', timestamp: '2025-01-01T00:00:00Z' };

describe('EvaluationContext metrics', () => {
  it('sizeKb() returns a positive number for non-empty context', () => {
    const ctx = new EvaluationContext({ income: 6000000 }, meta);
    ctx.set('node', 'val', 42);
    expect(ctx.sizeKb()).toBeGreaterThan(0);
  });

  it('sizeKb() returns 0-ish for empty context (just braces)', () => {
    const ctx = new EvaluationContext({}, meta);
    // empty map → "{}" → 2 chars → ~0.002 kb
    expect(ctx.sizeKb()).toBeLessThan(0.01);
  });

  it('sizeKb() grows as entries are added', () => {
    const ctx = new EvaluationContext({}, meta);
    const size0 = ctx.sizeKb();
    ctx.set('node', 'data', 'x'.repeat(1000));
    const size1 = ctx.sizeKb();
    expect(size1).toBeGreaterThan(size0);
  });

  it('entryCount() includes input entries', () => {
    const ctx = new EvaluationContext({ a: 1, b: 2, c: 3 }, meta);
    expect(ctx.entryCount()).toBe(3);
  });

  it('entryCount() includes set() and setRaw() entries', () => {
    const ctx = new EvaluationContext({ a: 1 }, meta);
    ctx.set('node', 'val', 2);
    ctx.setRaw('node', { raw: true });
    expect(ctx.entryCount()).toBe(3); // input.a + node.val + node.__raw
  });

  it('entryCount() does not increment on failed set()', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('node', 'val', 1);
    try {
      ctx.set('node', 'val', 2);
    } catch {
      // expected
    }
    expect(ctx.entryCount()).toBe(1);
  });
});
