import { describe, it, expect } from 'vitest';
import { EvaluationContext } from '../../src/EvaluationContext';
import { ContextValidationError } from '../../src/errors';

const meta = { requestId: 'req-1', tenantId: 'T1', timestamp: '2025-01-01T00:00:00Z' };

describe('Namespace & identifier validation', () => {
  it('accepts alphanumeric, underscore, and hyphen identifiers', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('abc123', 'XYZ_0-9', 'ok');
    expect(ctx.get('abc123.XYZ_0-9')).toBe('ok');
  });

  it('rejects nodeId with dots', () => {
    const ctx = new EvaluationContext({}, meta);
    expect(() => ctx.set('a.b', 'port', 1)).toThrow(ContextValidationError);
  });

  it('rejects portName with spaces', () => {
    const ctx = new EvaluationContext({}, meta);
    expect(() => ctx.set('node', 'my port', 1)).toThrow(ContextValidationError);
  });

  it('rejects empty nodeId', () => {
    const ctx = new EvaluationContext({}, meta);
    expect(() => ctx.set('', 'port', 1)).toThrow(ContextValidationError);
  });

  it('rejects empty portName', () => {
    const ctx = new EvaluationContext({}, meta);
    expect(() => ctx.set('node', '', 1)).toThrow(ContextValidationError);
  });

  it('rejects special characters in nodeId', () => {
    const ctx = new EvaluationContext({}, meta);
    expect(() => ctx.set('node@1', 'port', 1)).toThrow(ContextValidationError);
    expect(() => ctx.set('node/1', 'port', 1)).toThrow(ContextValidationError);
    expect(() => ctx.set('node#1', 'port', 1)).toThrow(ContextValidationError);
  });

  it('blocks reserved namespace "input"', () => {
    const ctx = new EvaluationContext({}, meta);
    expect(() => ctx.set('input', 'val', 1)).toThrow(ContextValidationError);
  });

  it('blocks reserved namespace "__internal"', () => {
    const ctx = new EvaluationContext({}, meta);
    expect(() => ctx.set('__internal', 'val', 1)).toThrow(ContextValidationError);
  });

  it('blocks reserved namespace "__meta"', () => {
    const ctx = new EvaluationContext({}, meta);
    expect(() => ctx.set('__meta', 'val', 1)).toThrow(ContextValidationError);
  });

  it('inputs are accessible via input namespace', () => {
    const ctx = new EvaluationContext({ income: 6000000 }, meta);
    expect(ctx.get('input.income')).toBe(6000000);
    expect(ctx.has('input.income')).toBe(true);
  });

  it('inputs are immutable — modifying the original does not affect context', () => {
    const input = { income: 6000000 };
    const ctx = new EvaluationContext(input, meta);
    input.income = 0;
    expect(ctx.get('input.income')).toBe(6000000);
  });

  it('inputs appear in getFullState() but not in another node getNodeOutputs()', () => {
    const ctx = new EvaluationContext({ income: 100 }, meta);
    ctx.set('tax_calc', 'taxDue', 500);
    const state = ctx.getFullState();
    expect(state['input.income']).toBe(100);
    // inputs do not leak into a node's outputs
    expect(ctx.getNodeOutputs('tax_calc')).toEqual({ taxDue: 500 });
    expect(ctx.getNodeOutputs('tax_calc')).not.toHaveProperty('income');
  });
});
