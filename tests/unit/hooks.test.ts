import { describe, it, expect, vi } from 'vitest';
import { EvaluationContext } from '../../src/EvaluationContext';
import { ContextConflictError, ContextLimitError, ContextValidationError } from '../../src/errors';
import type { ContextLifecycleHooks } from '../../src/types/hooks';

const meta = { requestId: 'req-1', tenantId: 'T1', timestamp: '2025-01-01T00:00:00Z' };

describe('ContextLifecycleHooks', () => {
  it('calls beforeSet before each successful set()', () => {
    const beforeSet = vi.fn();
    const ctx = new EvaluationContext({}, meta, { hooks: { beforeSet } });
    ctx.set('node', 'port', 42);
    expect(beforeSet).toHaveBeenCalledWith('node', 'port', 42);
  });

  it('calls afterSet after each successful set() with (nodeId, portName, value)', () => {
    const afterSet = vi.fn();
    const ctx = new EvaluationContext({}, meta, { hooks: { afterSet } });
    ctx.set('node', 'port', 42);
    expect(afterSet).toHaveBeenCalledWith('node', 'port', 42);
  });

  it('calls beforeGet before each get() with the raw key', () => {
    const beforeGet = vi.fn();
    const ctx = new EvaluationContext({}, meta, { hooks: { beforeGet } });
    ctx.set('node', 'port', 42);
    ctx.get('node.port');
    expect(beforeGet).toHaveBeenCalledWith('node.port');
  });

  it('calls afterGet after each get() with (key, value) — value may be undefined', () => {
    const afterGet = vi.fn();
    const ctx = new EvaluationContext({}, meta, { hooks: { afterGet } });
    ctx.get('non.existent');
    expect(afterGet).toHaveBeenCalledWith('non.existent', undefined);

    ctx.set('node', 'port', 42);
    ctx.get('node.port');
    expect(afterGet).toHaveBeenCalledWith('node.port', 42);
  });

  it('calls onError when ContextConflictError is thrown', () => {
    const onError = vi.fn();
    const ctx = new EvaluationContext({}, meta, { hooks: { onError } });
    ctx.set('node', 'port', 1);
    try {
      ctx.set('node', 'port', 2);
    } catch {
      // expected
    }
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(ContextConflictError);
  });

  it('calls onError when ContextLimitError is thrown', () => {
    const onError = vi.fn();
    const ctx = new EvaluationContext({}, meta, {
      hooks: { onError },
      limits: { maxValueSizeKb: 0.001 },
    });
    try {
      ctx.set('node', 'big', 'x'.repeat(100));
    } catch {
      // expected
    }
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(ContextLimitError);
  });

  it('calls onError when ContextValidationError is thrown (reserved namespace)', () => {
    const onError = vi.fn();
    const ctx = new EvaluationContext({}, meta, { hooks: { onError } });
    try {
      ctx.set('input', 'val', 1);
    } catch {
      // expected
    }
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(ContextValidationError);
  });

  it('a throwing hook does not prevent the operation from completing', () => {
    const hooks: ContextLifecycleHooks = {
      afterSet: () => {
        throw new Error('hook crash');
      },
    };
    const ctx = new EvaluationContext({}, meta, { hooks });
    // afterSet throws, but set() should still have written the value
    // In current implementation, the throw will propagate. The spec says
    // "throw dans un hook = comportement indéfini" — so we just verify
    // the value was written before the hook was called.
    try {
      ctx.set('node', 'port', 42);
    } catch {
      // expected from hook
    }
    expect(ctx.get('node.port')).toBe(42);
  });
});
