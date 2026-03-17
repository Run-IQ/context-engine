import { describe, it, expect } from 'vitest';
import { EvaluationContext } from '../../../src/EvaluationContext';

const meta = { requestId: 'req-1', tenantId: 'T1', timestamp: '2025-01-01T00:00:00Z' };

describe('EvaluationContext.getFullState()', () => {
  it('returns all inputs, outputs, and raw', () => {
    const ctx = new EvaluationContext({ income: 6000000 }, meta);
    ctx.set('tax_calc', 'taxDue', 1200000);
    ctx.setRaw('tax_calc', { breakdown: {} });
    const state = ctx.getFullState();
    expect(state['input.income']).toBe(6000000);
    expect(state['tax_calc.taxDue']).toBe(1200000);
    expect(state['tax_calc.__raw']).toEqual({ breakdown: {} });
  });

  it('returns a copy — modifying the result does not modify state', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('node', 'val', 42);
    const state = ctx.getFullState();
    expect(() => {
      (state as Record<string, unknown>)['node.val'] = 99;
    }).toThrow();
    expect(ctx.get('node.val')).toBe(42);
  });

  it('returns a frozen object', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('node', 'val', 42);
    const state = ctx.getFullState();
    expect(Object.isFrozen(state)).toBe(true);
  });
});
