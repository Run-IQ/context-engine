import { describe, it, expect } from 'vitest';
import { EvaluationContext } from '../../../src/EvaluationContext';

const meta = { requestId: 'req-1', tenantId: 'T1', timestamp: '2025-01-01T00:00:00Z' };

describe('EvaluationContext.getNodeOutputs()', () => {
  it('returns all ports of a node', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('tax_calc', 'taxDue', 2000);
    ctx.set('tax_calc', 'regime', 'REEL');
    expect(ctx.getNodeOutputs('tax_calc')).toEqual({ taxDue: 2000, regime: 'REEL' });
  });

  it('excludes raw from outputs', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('tax_calc', 'taxDue', 2000);
    ctx.setRaw('tax_calc', { breakdown: {} });
    const outputs = ctx.getNodeOutputs('tax_calc');
    expect(outputs).toEqual({ taxDue: 2000 });
  });

  it('returns empty object if node has no outputs', () => {
    const ctx = new EvaluationContext({}, meta);
    expect(ctx.getNodeOutputs('unknown_node')).toEqual({});
  });

  it('does not return keys from other nodes', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('node_a', 'val', 1);
    ctx.set('node_b', 'val', 2);
    expect(ctx.getNodeOutputs('node_a')).toEqual({ val: 1 });
    expect(ctx.getNodeOutputs('node_b')).toEqual({ val: 2 });
  });
});
