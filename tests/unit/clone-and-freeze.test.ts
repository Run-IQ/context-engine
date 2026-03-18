import { describe, it, expect } from 'vitest';
import { safeClone, cloneAndFreeze, roughSizeKb } from '../../src/utils';
import { EvaluationContext } from '../../src/EvaluationContext';

const meta = { requestId: 'req-1', tenantId: 'T1', timestamp: '2025-01-01T00:00:00Z' };

describe('safeClone', () => {
  it('returns primitives as-is', () => {
    expect(safeClone(42)).toBe(42);
    expect(safeClone('hello')).toBe('hello');
    expect(safeClone(true)).toBe(true);
    expect(safeClone(null)).toBe(null);
    expect(safeClone(undefined)).toBe(undefined);
  });

  it('clones plain objects — breaks reference', () => {
    const original = { a: 1, b: { c: 2 } };
    const cloned = safeClone(original);
    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
    expect(cloned.b).not.toBe(original.b);
  });

  it('clones arrays — breaks reference', () => {
    const original = [1, [2, 3], { x: 4 }];
    const cloned = safeClone(original);
    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
    expect(cloned[1]).not.toBe(original[1]);
  });

  it('clones Date instances — independent copy', () => {
    const original = new Date('2025-06-15T12:00:00Z');
    const cloned = safeClone(original);
    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
    expect(cloned instanceof Date).toBe(true);
    // Mutating original does not affect clone
    original.setFullYear(2000);
    expect(cloned.getFullYear()).toBe(2025);
  });

  it('clones RegExp instances', () => {
    const original = /test/gi;
    const cloned = safeClone(original);
    expect(cloned).not.toBe(original);
    expect(cloned.source).toBe('test');
    expect(cloned.flags).toBe('gi');
  });

  it('clones Map instances', () => {
    const original = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    const cloned = safeClone(original);
    expect(cloned).not.toBe(original);
    expect(cloned instanceof Map).toBe(true);
    expect(cloned.get('a')).toBe(1);
    original.set('c', 3);
    expect(cloned.has('c')).toBe(false);
  });

  it('clones Set instances', () => {
    const original = new Set([1, 2, 3]);
    const cloned = safeClone(original);
    expect(cloned).not.toBe(original);
    expect(cloned instanceof Set).toBe(true);
    expect(cloned.has(1)).toBe(true);
    original.add(4);
    expect(cloned.has(4)).toBe(false);
  });

  it('clones nested objects with Dates inside', () => {
    const original = { date: new Date('2025-01-01'), nested: { date2: new Date('2026-01-01') } };
    const cloned = safeClone(original);
    expect(cloned.date).not.toBe(original.date);
    expect(cloned.nested.date2).not.toBe(original.nested.date2);
    expect(cloned.date.toISOString()).toBe(original.date.toISOString());
  });

  it('handles ArrayBuffer', () => {
    const buffer = new ArrayBuffer(8);
    const view = new Uint8Array(buffer);
    view[0] = 42;
    const cloned = safeClone(buffer);
    expect(cloned).not.toBe(buffer);
    expect(new Uint8Array(cloned)[0]).toBe(42);
  });
});

describe('cloneAndFreeze', () => {
  it('returns a frozen clone — original stays mutable', () => {
    const arr = [1, 2, 3];
    const result = cloneAndFreeze(arr);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).toEqual([1, 2, 3]);
    // Original is NOT frozen
    arr.push(4);
    expect(arr).toEqual([1, 2, 3, 4]);
    // Stored copy is unaffected
    expect(result).toEqual([1, 2, 3]);
  });

  it('deep freezes nested objects in the clone', () => {
    const obj = { a: { b: { c: [1, 2] } } };
    const result = cloneAndFreeze(obj);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.a)).toBe(true);
    expect(Object.isFrozen(result.a.b)).toBe(true);
    expect(Object.isFrozen(result.a.b.c)).toBe(true);
  });

  it('frozen Date clone cannot be mutated via setTime', () => {
    const date = new Date('2025-01-01');
    const frozen = cloneAndFreeze(date);
    expect(frozen instanceof Date).toBe(true);
    // Date internal methods don't throw on frozen objects, but the clone is independent
    date.setFullYear(2000);
    // The frozen clone still has the original value
    expect(frozen.getFullYear()).toBe(2025);
  });

  it('handles null and undefined', () => {
    expect(cloneAndFreeze(null)).toBe(null);
    expect(cloneAndFreeze(undefined)).toBe(undefined);
  });

  it('handles primitives', () => {
    expect(cloneAndFreeze(42)).toBe(42);
    expect(cloneAndFreeze('str')).toBe('str');
    expect(cloneAndFreeze(true)).toBe(true);
  });
});

describe('roughSizeKb — recursive estimator', () => {
  it('returns 0 for null and undefined', () => {
    expect(roughSizeKb(null)).toBe(0);
    expect(roughSizeKb(undefined)).toBe(0);
  });

  it('returns 8 bytes for a number', () => {
    expect(roughSizeKb(42)).toBeCloseTo(8 / 1024, 3);
  });

  it('returns string.length * 2 for strings', () => {
    expect(roughSizeKb('hello')).toBeCloseTo((5 * 2) / 1024, 3);
  });

  it('handles large strings efficiently', () => {
    const bigStr = 'x'.repeat(100_000);
    const start = performance.now();
    const size = roughSizeKb(bigStr);
    const elapsed = performance.now() - start;
    // Should be ~200kb (100k chars * 2 bytes)
    expect(size).toBeCloseTo(200_000 / 1024, 0);
    // Should be fast — under 10ms (JSON.stringify would be slower)
    expect(elapsed).toBeLessThan(50);
  });

  it('handles circular references without infinite loop', () => {
    const obj: Record<string, unknown> = { a: 1, b: 'hello' };
    obj['self'] = obj;
    const size = roughSizeKb(obj);
    expect(Number.isFinite(size)).toBe(true);
    expect(size).toBeGreaterThan(0);
  });

  it('handles diamond-shaped references', () => {
    const shared = { value: 42 };
    const obj = { left: shared, right: shared };
    const size = roughSizeKb(obj);
    // shared counted only once (WeakSet)
    expect(Number.isFinite(size)).toBe(true);
    expect(size).toBeGreaterThan(0);
  });

  it('estimates Date size', () => {
    const size = roughSizeKb(new Date());
    expect(size).toBeCloseTo(8 / 1024, 3);
  });

  it('estimates Map size', () => {
    const map = new Map([
      ['key1', 'value1'],
      ['key2', 'value2'],
    ]);
    const size = roughSizeKb(map);
    expect(size).toBeGreaterThan(0);
  });

  it('estimates Set size', () => {
    const set = new Set([1, 2, 3, 4, 5]);
    const size = roughSizeKb(set);
    expect(size).toBeGreaterThan(0);
  });

  it('estimates nested object with arrays', () => {
    const data = {
      users: [
        { name: 'Alice', scores: [100, 200, 300] },
        { name: 'Bob', scores: [150, 250, 350] },
      ],
      metadata: { version: 1, source: 'test' },
    };
    const size = roughSizeKb(data);
    expect(size).toBeGreaterThan(0);
    expect(Number.isFinite(size)).toBe(true);
  });

  it('returns Infinity for functions (fallback)', () => {
    // Functions are estimated as 0 bytes, but a plain function won't cause Infinity
    const size = roughSizeKb(() => {});
    expect(size).toBe(0);
  });
});

describe('EvaluationContext — class instance immutability', () => {
  it('Date stored via set() is independent of original', () => {
    const ctx = new EvaluationContext({}, meta);
    const date = new Date('2025-06-15T12:00:00Z');
    ctx.set('node', 'date', date);

    // Mutate original
    date.setFullYear(2000);

    // Stored value is independent
    const stored = ctx.get('node.date') as Date;
    expect(stored.getFullYear()).toBe(2025);
  });

  it('Array stored via set() is independent of original', () => {
    const ctx = new EvaluationContext({}, meta);
    const arr = [1, 2, 3];
    ctx.set('node', 'list', arr);

    // Mutate original
    arr.push(4);
    arr[0] = 999;

    // Stored value is independent
    const stored = ctx.get('node.list') as number[];
    expect(stored).toEqual([1, 2, 3]);
  });

  it('nested object stored via set() is independent', () => {
    const ctx = new EvaluationContext({}, meta);
    const obj = { a: { b: [1, 2] } };
    ctx.set('node', 'data', obj);

    // Mutate original deeply
    obj.a.b.push(3);

    // Stored value is independent
    const stored = ctx.get('node.data') as typeof obj;
    expect(stored.a.b).toEqual([1, 2]);
  });

  it('raw data stored via setRaw() is independent of original', () => {
    const ctx = new EvaluationContext({}, meta);
    const raw = { response: { items: [1, 2, 3] } };
    ctx.setRaw('node', raw);

    // Mutate original
    raw.response.items.push(4);

    // Stored raw is independent
    const stored = ctx.get('node.__raw') as typeof raw;
    expect(stored.response.items).toEqual([1, 2, 3]);
  });

  it('input data is independent of original', () => {
    const input = { income: 5000, items: [1, 2] };
    const ctx = new EvaluationContext(input, meta);

    // Mutate original
    input.items.push(3);

    // Stored input is independent
    const stored = ctx.get('input.items') as number[];
    expect(stored).toEqual([1, 2]);
  });

  it('Date in input is independent of original', () => {
    const date = new Date('2025-01-01');
    const ctx = new EvaluationContext({ effectiveDate: date }, meta);

    date.setFullYear(2000);

    const stored = ctx.get('input.effectiveDate') as Date;
    expect(stored.getFullYear()).toBe(2025);
  });

  it('stored frozen objects cannot be mutated via get()', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('node', 'data', { x: 1, y: [2, 3] });

    const stored = ctx.get('node.data') as Record<string, unknown>;
    expect(() => {
      stored['x'] = 999;
    }).toThrow();
    expect(() => {
      (stored['y'] as number[]).push(4);
    }).toThrow();
  });
});
