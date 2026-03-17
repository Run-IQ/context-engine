import { describe, it, expect } from 'vitest';
import { EvaluationContext } from '../../../src/EvaluationContext';
import {
  ContextConflictError,
  ContextValidationError,
  ContextLimitError,
} from '../../../src/errors';

const meta = { requestId: 'req-1', tenantId: 'T1', timestamp: '2025-01-01T00:00:00Z' };

describe('EvaluationContext.set()', () => {
  it('writes a value with key <nodeId>.<portName>', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('tax_calc', 'taxDue', 2000);
    expect(ctx.get('tax_calc.taxDue')).toBe(2000);
  });

  it('accepts valid identifiers [a-zA-Z0-9_-]', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('node-1', 'port_A', 'value');
    ctx.set('Node2', 'Port3', 'value2');
    expect(ctx.get('node-1.port_A')).toBe('value');
    expect(ctx.get('Node2.Port3')).toBe('value2');
  });

  it('throws ContextValidationError for nodeId with dot', () => {
    const ctx = new EvaluationContext({}, meta);
    expect(() => ctx.set('tax.calc', 'taxDue', 2000)).toThrow(ContextValidationError);
  });

  it('throws ContextValidationError for portName with space', () => {
    const ctx = new EvaluationContext({}, meta);
    expect(() => ctx.set('node', 'my port', 2000)).toThrow(ContextValidationError);
  });

  it('throws ContextValidationError for empty nodeId', () => {
    const ctx = new EvaluationContext({}, meta);
    expect(() => ctx.set('', 'port', 2000)).toThrow(ContextValidationError);
  });

  it('throws ContextConflictError if the same key is written twice', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('node', 'port', 1);
    expect(() => ctx.set('node', 'port', 2)).toThrow(ContextConflictError);
  });

  it('does not modify state when ContextConflictError is thrown', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('node', 'port', 1);
    try {
      ctx.set('node', 'port', 2);
    } catch {
      // expected
    }
    expect(ctx.get('node.port')).toBe(1);
  });

  it('freezes the value — external mutation does not affect state', () => {
    const ctx = new EvaluationContext({}, meta);
    const arr = [1, 2, 3];
    ctx.set('node', 'data', arr);
    expect(() => {
      arr.push(4);
    }).toThrow();
    const stored = ctx.get('node.data') as number[];
    expect(stored).toEqual([1, 2, 3]);
  });

  it('checks limits BEFORE writing — state unchanged on error', () => {
    const ctx = new EvaluationContext({}, meta, {
      limits: { maxValueSizeKb: 0.001 },
    });
    const bigValue = 'x'.repeat(100);
    expect(() => ctx.set('node', 'big', bigValue)).toThrow(ContextLimitError);
    expect(ctx.has('node.big')).toBe(false);
  });
});
