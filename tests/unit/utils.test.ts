import { describe, it, expect } from 'vitest';
import { deepFreeze, roughSizeKb, sha256, getNestedValue } from '../../src/utils';

describe('deepFreeze', () => {
  it('freezes a simple object', () => {
    const obj = { a: 1, b: 'hello' };
    const frozen = deepFreeze(obj);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(() => {
      (frozen as Record<string, unknown>).a = 2;
    }).toThrow();
  });

  it('freezes nested objects recursively', () => {
    const obj = { a: { b: { c: 42 } } };
    const frozen = deepFreeze(obj);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.a)).toBe(true);
    expect(Object.isFrozen(frozen.a.b)).toBe(true);
  });

  it('freezes arrays', () => {
    const arr = [1, { x: 2 }, [3]];
    const frozen = deepFreeze(arr);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen[1])).toBe(true);
    expect(Object.isFrozen(frozen[2])).toBe(true);
  });

  it('handles null and primitives without error', () => {
    expect(deepFreeze(null)).toBe(null);
    expect(deepFreeze(42)).toBe(42);
    expect(deepFreeze('hello')).toBe('hello');
    expect(deepFreeze(undefined)).toBe(undefined);
  });

  it('handles circular references without hanging', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj['self'] = obj;
    // Should not hang or throw — just freeze what it can
    const frozen = deepFreeze(obj);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(frozen['self']).toBe(frozen); // circular ref preserved
  });

  it('handles diamond-shaped object graphs', () => {
    const shared = { value: 42 };
    const obj = { left: shared, right: shared };
    const frozen = deepFreeze(obj);
    expect(Object.isFrozen(frozen.left)).toBe(true);
    expect(Object.isFrozen(frozen.right)).toBe(true);
    expect(frozen.left).toBe(frozen.right); // same reference preserved
  });
});

describe('roughSizeKb', () => {
  it('returns a positive number for a simple object', () => {
    const size = roughSizeKb({ name: 'test', value: 123 });
    expect(size).toBeGreaterThan(0);
  });

  it('returns Infinity for circular references', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj['self'] = obj;
    expect(roughSizeKb(obj)).toBe(Infinity);
  });

  it('estimates based on JSON.stringify length', () => {
    const data = 'x'.repeat(1024);
    const size = roughSizeKb(data);
    // JSON.stringify adds quotes: '"xxx..."' = 1024 + 2 chars
    expect(size).toBeCloseTo(1.002, 1);
  });
});

describe('sha256', () => {
  it('produces a 64-char hex string', () => {
    const hash = sha256('hello');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic — same input produces same output', () => {
    expect(sha256('test')).toBe(sha256('test'));
  });

  it('produces different hashes for different inputs', () => {
    expect(sha256('a')).not.toBe(sha256('b'));
  });
});

describe('getNestedValue', () => {
  it('resolves a simple path', () => {
    expect(getNestedValue({ a: 1 }, 'a')).toBe(1);
  });

  it('resolves a nested path', () => {
    expect(getNestedValue({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
  });

  it('returns undefined for missing path', () => {
    expect(getNestedValue({ a: 1 }, 'b')).toBeUndefined();
    expect(getNestedValue({ a: { b: 1 } }, 'a.c')).toBeUndefined();
  });

  it('returns undefined for null/undefined input', () => {
    expect(getNestedValue(null, 'a')).toBeUndefined();
    expect(getNestedValue(undefined, 'a')).toBeUndefined();
  });

  it('returns undefined when traversing a primitive', () => {
    expect(getNestedValue({ a: 42 }, 'a.b')).toBeUndefined();
  });
});
