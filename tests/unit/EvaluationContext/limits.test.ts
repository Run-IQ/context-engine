import { describe, it, expect } from 'vitest';
import { EvaluationContext } from '../../../src/EvaluationContext';
import { ContextLimitError } from '../../../src/errors';

const meta = { requestId: 'req-1', tenantId: 'T1', timestamp: '2025-01-01T00:00:00Z' };

describe('EvaluationContext limits', () => {
  it('throws ContextLimitError if value exceeds maxValueSizeKb', () => {
    const ctx = new EvaluationContext({}, meta, {
      limits: { maxValueSizeKb: 0.01 },
    });
    const bigValue = 'x'.repeat(200);
    expect(() => ctx.set('node', 'big', bigValue)).toThrow(ContextLimitError);
  });

  it('throws ContextLimitError if total state exceeds maxTotalSizeKb', () => {
    const ctx = new EvaluationContext({}, meta, {
      limits: { maxTotalSizeKb: 0.05 },
    });
    ctx.set('node', 'small', 'abc');
    const bigValue = 'x'.repeat(200);
    expect(() => ctx.set('node', 'big', bigValue)).toThrow(ContextLimitError);
  });

  it('throws ContextLimitError if entry count exceeds maxEntries', () => {
    const ctx = new EvaluationContext({ a: 1 }, meta, {
      limits: { maxEntries: 2 },
    });
    // 1 entry from input, 1 from set -> total 2 -> next set should fail
    ctx.set('node', 'val', 1);
    expect(() => ctx.set('node2', 'val', 2)).toThrow(ContextLimitError);
  });

  it('state is unchanged after a ContextLimitError', () => {
    const ctx = new EvaluationContext({}, meta, {
      limits: { maxValueSizeKb: 0.01 },
    });
    const bigValue = 'x'.repeat(200);
    try {
      ctx.set('node', 'big', bigValue);
    } catch {
      // expected
    }
    expect(ctx.has('node.big')).toBe(false);
    expect(ctx.entryCount()).toBe(0);
  });
});
