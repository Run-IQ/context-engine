import { createHash } from 'node:crypto';

export function deepFreeze<T>(obj: T, seen?: WeakSet<object>): Readonly<T> {
  Object.freeze(obj);
  if (obj !== null && typeof obj === 'object') {
    const visited = seen ?? new WeakSet<object>();
    visited.add(obj as object);
    for (const value of Object.values(obj as Record<string, unknown>)) {
      if (
        value !== null &&
        typeof value === 'object' &&
        !Object.isFrozen(value) &&
        !visited.has(value)
      ) {
        deepFreeze(value, visited);
      }
    }
  }
  return obj as Readonly<T>;
}

export function roughSizeKb(value: unknown): number {
  try {
    return JSON.stringify(value).length / 1024;
  } catch {
    return Infinity;
  }
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function getNestedValue(obj: unknown, path: string): unknown {
  if (obj === null || obj === undefined) return undefined;

  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}
