import { describe, it, expect } from 'vitest';
import { EvaluationContext } from '../../../src/EvaluationContext';

const meta = { requestId: 'req-1', tenantId: 'T1', timestamp: '2025-01-01T00:00:00Z' };

describe('EvaluationContext.get() — edge cases', () => {
  // ─── Raw subpath resolution ────────────────────────────────────────────────

  it('resolves raw array index via dot path', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.setRaw('node', { items: ['a', 'b', 'c'] });
    expect(ctx.get('node.__raw.items.0')).toBe('a');
    expect(ctx.get('node.__raw.items.2')).toBe('c');
  });

  it('returns undefined for raw subpath when raw is null', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.setRaw('node', null);
    expect(ctx.get('node.__raw.anything')).toBeUndefined();
  });

  it('returns undefined for raw subpath when raw is a primitive', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.setRaw('node', 42);
    expect(ctx.get('node.__raw.anything')).toBeUndefined();
  });

  it('returns undefined for raw subpath when no raw was set', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.set('node', 'val', 1);
    expect(ctx.get('node.__raw.anything')).toBeUndefined();
  });

  it('resolves 5-level deep raw subpath', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.setRaw('node', { a: { b: { c: { d: { e: 'deep' } } } } });
    expect(ctx.get('node.__raw.a.b.c.d.e')).toBe('deep');
  });

  it('returns the raw object itself when accessing __raw without subpath', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.setRaw('node', { data: 42 });
    const raw = ctx.get('node.__raw');
    expect(raw).toEqual({ data: 42 });
  });

  // ─── Input edge cases ─────────────────────────────────────────────────────

  it('input with nested object — entire object stored under single key', () => {
    const ctx = new EvaluationContext({ address: { city: 'Lomé', country: 'TG' } }, meta);
    const addr = ctx.get('input.address') as { city: string; country: string };
    expect(addr.city).toBe('Lomé');
    expect(addr.country).toBe('TG');
  });

  it('input values are frozen — cannot mutate nested input', () => {
    const input = { data: { mutable: true } };
    const ctx = new EvaluationContext(input, meta);
    const stored = ctx.get('input.data') as { mutable: boolean };
    expect(() => {
      stored.mutable = false;
    }).toThrow();
  });

  it('get with empty string returns undefined', () => {
    const ctx = new EvaluationContext({}, meta);
    expect(ctx.get('')).toBeUndefined();
  });

  // ─── has() edge cases ─────────────────────────────────────────────────────

  it('has() returns false for raw subpath (not a direct key)', () => {
    const ctx = new EvaluationContext({}, meta);
    ctx.setRaw('node', { nested: 42 });
    // has() only checks direct Map keys — raw subpaths are resolved by get()
    expect(ctx.has('node.__raw')).toBe(true);
    expect(ctx.has('node.__raw.nested')).toBe(false);
  });

  // ─── Hook interaction with get ────────────────────────────────────────────

  it('beforeGet fires for raw subpath resolution', () => {
    const keys: string[] = [];
    const ctx = new EvaluationContext({}, meta, {
      hooks: { beforeGet: (key) => keys.push(key) },
    });
    ctx.setRaw('node', { a: 1 });
    ctx.get('node.__raw.a');
    expect(keys).toContain('node.__raw.a');
  });

  it('afterGet receives resolved raw value', () => {
    const results: [string, unknown][] = [];
    const ctx = new EvaluationContext({}, meta, {
      hooks: { afterGet: (key, value) => results.push([key, value]) },
    });
    ctx.setRaw('node', { a: 42 });
    ctx.get('node.__raw.a');
    expect(results).toEqual([['node.__raw.a', 42]]);
  });

  it('afterGet receives undefined for missing key', () => {
    const results: [string, unknown][] = [];
    const ctx = new EvaluationContext({}, meta, {
      hooks: { afterGet: (key, value) => results.push([key, value]) },
    });
    ctx.get('nonexistent.key');
    expect(results).toEqual([['nonexistent.key', undefined]]);
  });
});
