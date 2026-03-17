import { describe, it, expect } from 'vitest';
import { EvaluationContext } from '../../../src/EvaluationContext';
import { ContextConflictError, ContextValidationError } from '../../../src/errors';

const meta = { requestId: 'req-1', tenantId: 'T1', timestamp: '2025-01-01T00:00:00Z' };

describe('EvaluationContext.setRaw()', () => {
  it('writes raw at <nodeId>.__raw', () => {
    const ctx = new EvaluationContext({}, meta);
    const raw = { breakdown: { TVA: 300 } };
    ctx.setRaw('tax_calc', raw);
    expect(ctx.get('tax_calc.__raw')).toEqual({ breakdown: { TVA: 300 } });
  });

  it('can be called twice for the same nodeId (default allows overwrite)', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.setRaw('node', { v: 1 });
    ctx.setRaw('node', { v: 2 });
    expect(ctx.get('node.__raw')).toEqual({ v: 2 });
  });

  it('throws ContextConflictError when allowRawOverwrite is false', () => {
    const ctx = new EvaluationContext({}, meta, {
      limits: { allowRawOverwrite: false },
    });
    ctx.setRaw('node', { v: 1 });
    expect(() => ctx.setRaw('node', { v: 2 })).toThrow(ContextConflictError);
  });

  it('throws ContextValidationError for invalid nodeId', () => {
    const ctx = new EvaluationContext({}, meta);
    expect(() => ctx.setRaw('bad.id', {})).toThrow(ContextValidationError);
  });

  it('raw key does NOT appear in getNodeOutputs()', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('tax_calc', 'taxDue', 2000);
    ctx.setRaw('tax_calc', { breakdown: {} });
    const outputs = ctx.getNodeOutputs('tax_calc');
    expect(outputs).toEqual({ taxDue: 2000 });
    expect(outputs).not.toHaveProperty('__raw');
  });
});
