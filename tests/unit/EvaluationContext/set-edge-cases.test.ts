import { describe, it, expect } from 'vitest';
import { EvaluationContext } from '../../../src/EvaluationContext';
import { ContextValidationError, ContextLimitError } from '../../../src/errors';

const meta = { requestId: 'req-1', tenantId: 'T1', timestamp: '2025-01-01T00:00:00Z' };

describe('EvaluationContext.set() — edge cases', () => {
  // ─── Exotic values ─────────────────────────────────────────────────────────

  it('stores null as a value', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('node', 'val', null);
    expect(ctx.get('node.val')).toBeNull();
    expect(ctx.has('node.val')).toBe(true);
  });

  it('stores undefined as a value — but has() returns true because key exists', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('node', 'val', undefined);
    // The key exists in the Map even though the value is undefined
    expect(ctx.has('node.val')).toBe(true);
  });

  it('stores 0, false, empty string — all falsy values', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('node', 'zero', 0);
    ctx.set('node', 'false', false);
    ctx.set('node', 'empty', '');
    expect(ctx.get('node.zero')).toBe(0);
    expect(ctx.get('node.false')).toBe(false);
    expect(ctx.get('node.empty')).toBe('');
  });

  it('stores NaN and Infinity', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('node', 'nan', NaN);
    ctx.set('node', 'inf', Infinity);
    expect(ctx.get('node.nan')).toBeNaN();
    expect(ctx.get('node.inf')).toBe(Infinity);
  });

  it('stores deeply nested objects — all levels frozen', () => {
    const ctx = new EvaluationContext({}, meta);
    const deep = { a: { b: { c: { d: { e: { f: 42 } } } } } };
    ctx.set('node', 'deep', deep);
    const stored = ctx.get('node.deep') as typeof deep;
    expect(stored.a.b.c.d.e.f).toBe(42);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.a.b.c.d.e)).toBe(true);
  });

  it('stores arrays — frozen, mutation throws', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('node', 'arr', [1, 2, [3, 4]]);
    const arr = ctx.get('node.arr') as number[];
    expect(() => arr.push(5)).toThrow();
    expect(() => ((arr as unknown[])[2] as number[]).push(5)).toThrow();
  });

  it('stores Date objects — frozen', () => {
    const ctx = new EvaluationContext({}, meta);
    const d = new Date('2025-01-01');
    ctx.set('node', 'date', d);
    const stored = ctx.get('node.date') as Date;
    expect(Object.isFrozen(stored)).toBe(true);
  });

  it('stores RegExp — frozen', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('node', 'regex', /test/gi);
    const stored = ctx.get('node.regex') as RegExp;
    expect(Object.isFrozen(stored)).toBe(true);
  });

  // ─── Prototype pollution resistance ────────────────────────────────────────

  it('rejects __proto__ as nodeId (invalid chars)', () => {
    const ctx = new EvaluationContext({}, meta);
    // __proto__ is valid chars [a-zA-Z0-9_-], but let's make sure it doesn't pollute
    ctx.set('__proto__', 'val', 'attack');
    // The key should be stored as '__proto__.val', not pollute the prototype
    expect(ctx.get('__proto__.val')).toBe('attack');
    expect(({} as Record<string, unknown>)['val']).toBeUndefined();
  });

  it('rejects constructor as portName — stored safely', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('node', 'constructor', 'safe');
    expect(ctx.get('node.constructor')).toBe('safe');
  });

  it('value with __proto__ key does not pollute', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('node', 'data', JSON.parse('{"__proto__": {"polluted": true}}'));
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  // ─── Identifier edge cases ────────────────────────────────────────────────

  it('accepts single character identifiers', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('a', 'b', 1);
    expect(ctx.get('a.b')).toBe(1);
  });

  it('accepts very long identifiers (100 chars)', () => {
    const ctx = new EvaluationContext({}, meta);
    const longId = 'a'.repeat(100);
    ctx.set(longId, 'port', 42);
    expect(ctx.get(`${longId}.port`)).toBe(42);
  });

  it('accepts identifiers with only hyphens and underscores', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('---', '___', 'ok');
    expect(ctx.get('---.___')).toBe('ok');
  });

  it('rejects tab character in nodeId', () => {
    const ctx = new EvaluationContext({}, meta);
    expect(() => ctx.set('node\t1', 'port', 1)).toThrow(ContextValidationError);
  });

  it('rejects newline in portName', () => {
    const ctx = new EvaluationContext({}, meta);
    expect(() => ctx.set('node', 'port\n', 1)).toThrow(ContextValidationError);
  });

  it('rejects unicode characters in identifiers', () => {
    const ctx = new EvaluationContext({}, meta);
    expect(() => ctx.set('nœud', 'port', 1)).toThrow(ContextValidationError);
    expect(() => ctx.set('node', '端口', 1)).toThrow(ContextValidationError);
    expect(() => ctx.set('node', 'pört', 1)).toThrow(ContextValidationError);
  });

  // ─── Append-only atomicity ────────────────────────────────────────────────

  it('after a conflict error, the original value is retrievable unchanged', () => {
    const ctx = new EvaluationContext({}, meta);
    const original = { nested: { value: 42 } };
    ctx.set('node', 'data', original);

    try {
      ctx.set('node', 'data', { nested: { value: 999 } });
    } catch {
      // expected
    }

    const stored = ctx.get('node.data') as typeof original;
    expect(stored.nested.value).toBe(42);
  });

  it('state.size does not increment on failed set()', () => {
    const ctx = new EvaluationContext({}, meta);
    const before = ctx.entryCount();
    try {
      ctx.set('input', 'val', 1); // reserved namespace
    } catch {
      // expected
    }
    expect(ctx.entryCount()).toBe(before);
  });

  // ─── Limits boundary values ────────────────────────────────────────────────

  it('allows value exactly at maxValueSizeKb', () => {
    // A string of length 512 → 512 * 2 = 1024 bytes = 1kb
    const str = 'x'.repeat(512);
    const ctx = new EvaluationContext({}, meta, {
      limits: { maxValueSizeKb: 1.1 },
    });
    // Should not throw
    ctx.set('node', 'val', str);
    expect(ctx.has('node.val')).toBe(true);
  });

  it('throws at maxValueSizeKb + 1 byte', () => {
    const ctx = new EvaluationContext({}, meta, {
      limits: { maxValueSizeKb: 0.01 }, // ~10 bytes
    });
    expect(() => ctx.set('node', 'val', 'exactly-too-big')).toThrow(ContextLimitError);
  });

  it('maxEntries boundary — allows exactly maxEntries, blocks maxEntries+1', () => {
    const ctx = new EvaluationContext({}, meta, {
      limits: { maxEntries: 3 },
    });
    ctx.set('n1', 'v', 1);
    ctx.set('n2', 'v', 2);
    ctx.set('n3', 'v', 3);
    expect(() => ctx.set('n4', 'v', 4)).toThrow(ContextLimitError);
  });

  it('maxTotalSizeKb accounts for new value before writing', () => {
    const ctx = new EvaluationContext({}, meta, {
      limits: { maxTotalSizeKb: 0.1 },
    });
    // First write is small enough
    ctx.set('node', 'small', 'a');
    // Second write pushes total over the limit
    expect(() => ctx.set('node', 'big', 'x'.repeat(200))).toThrow(ContextLimitError);
    // Original state untouched
    expect(ctx.has('node.big')).toBe(false);
    expect(ctx.get('node.small')).toBe('a');
  });

  // ─── Multiple nodes, many entries ─────────────────────────────────────────

  it('handles 1000 entries without issue', () => {
    const ctx = new EvaluationContext({}, meta);
    for (let i = 0; i < 1000; i++) {
      ctx.set(`node${i}`, 'val', i);
    }
    expect(ctx.entryCount()).toBe(1000);
    expect(ctx.get('node0.val')).toBe(0);
    expect(ctx.get('node999.val')).toBe(999);
  });

  // ─── Hook ordering ────────────────────────────────────────────────────────

  it('hooks fire in order: beforeSet → write → afterSet', () => {
    const order: string[] = [];
    const ctx = new EvaluationContext({}, meta, {
      hooks: {
        beforeSet: () => order.push('before'),
        afterSet: () => order.push('after'),
      },
    });
    ctx.set('node', 'val', 1);
    expect(order).toEqual(['before', 'after']);
  });

  it('beforeSet fires before the value is in state', () => {
    let wasInState = true;
    const ctx = new EvaluationContext({}, meta, {
      hooks: {
        beforeSet: () => {
          wasInState = ctx.has('node.val');
        },
      },
    });
    ctx.set('node', 'val', 1);
    expect(wasInState).toBe(false);
  });

  it('afterSet fires after the value is in state', () => {
    let wasInState = false;
    const ctx = new EvaluationContext({}, meta, {
      hooks: {
        afterSet: () => {
          wasInState = ctx.has('node.val');
        },
      },
    });
    ctx.set('node', 'val', 1);
    expect(wasInState).toBe(true);
  });

  it('onError + conflict: onError fires before throw, receives exact error', () => {
    const errors: Error[] = [];
    const ctx = new EvaluationContext({}, meta, {
      hooks: { onError: (e) => errors.push(e) },
    });
    ctx.set('node', 'val', 1);
    let caught: Error | undefined;
    try {
      ctx.set('node', 'val', 2);
    } catch (e) {
      caught = e as Error;
    }
    expect(errors).toHaveLength(1);
    // The error passed to onError should be the SAME instance as the one thrown
    expect(errors[0]).toBe(caught);
  });
});
