import { describe, it, expect } from 'vitest';
import { EvaluationContext } from '../../../src/EvaluationContext';

const meta = { requestId: 'req-1', tenantId: 'T1', timestamp: '2025-01-01T00:00:00Z' };

describe('EvaluationContext.get()', () => {
  it('returns the value written by set()', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('tax_calc', 'taxDue', 2000);
    expect(ctx.get('tax_calc.taxDue')).toBe(2000);
  });

  it('returns the input value via input namespace', () => {
    const ctx = new EvaluationContext({ income: 6000000 }, meta);
    expect(ctx.get('input.income')).toBe(6000000);
  });

  it('resolves raw subpath via cascade', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.setRaw('tax_calc', { breakdown: { TVA: 300 } });
    expect(ctx.get('tax_calc.__raw.breakdown.TVA')).toBe(300);
  });

  it('resolves deep nested raw subpath', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.setRaw('node', { a: { b: { c: { d: 99 } } } });
    expect(ctx.get('node.__raw.a.b.c.d')).toBe(99);
  });

  it('returns undefined for non-existent key (never throws)', () => {
    const ctx = new EvaluationContext({}, meta);
    expect(ctx.get('non_existent.key')).toBeUndefined();
  });

  it('returns undefined for non-existent raw subpath', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.setRaw('tax_calc', { breakdown: { TVA: 300 } });
    expect(ctx.get('tax_calc.__raw.nonexistent')).toBeUndefined();
  });

  it('is synchronous — never returns a Promise', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('node', 'val', 42);
    const result = ctx.get('node.val');
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toBe(42);
  });
});
