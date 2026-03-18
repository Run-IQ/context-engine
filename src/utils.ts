import { createHash } from 'node:crypto';

/**
 * Deep-clone a value using structuredClone to break reference chains and
 * correctly copy built-in types (Date, Map, Set, RegExp, ArrayBuffer, etc).
 * Falls back to JSON round-trip for environments that lack structuredClone,
 * and returns the original value as a last resort (primitives, non-cloneable).
 */
export function safeClone<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value)) as T;
    } catch {
      return value;
    }
  }
}

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

/**
 * Clone then freeze — prevents mutation via original reference AND
 * prevents mutation via internal state (Date.setTime, Map.set, etc).
 */
export function cloneAndFreeze<T>(value: T): Readonly<T> {
  return deepFreeze(safeClone(value));
}

/**
 * Estimate the size of a value in kilobytes using a recursive traversal.
 * Much faster than JSON.stringify on large objects because it avoids
 * string allocation. Counts bytes heuristically:
 * - string: length * 2 (UTF-16)
 * - number/boolean: 8 bytes
 * - null/undefined: 0
 * - object/array: sum of keys + values + overhead
 */
export function roughSizeKb(value: unknown): number {
  try {
    const bytes = estimateBytes(value, new WeakSet());
    return bytes / 1024;
  } catch {
    return Infinity;
  }
}

function estimateBytes(value: unknown, seen: WeakSet<object>): number {
  if (value === null || value === undefined) return 0;

  switch (typeof value) {
    case 'string':
      return value.length * 2;
    case 'number':
      return 8;
    case 'boolean':
      return 4;
    case 'bigint':
      return 8;
    case 'symbol':
      return 0;
    case 'function':
      return 0;
    case 'object':
      break;
    default:
      return 0;
  }

  if (seen.has(value as object)) return 0;
  seen.add(value as object);

  if (value instanceof Date) return 8;
  if (value instanceof RegExp) return value.source.length * 2;

  if (Array.isArray(value)) {
    let total = 16; // array overhead
    for (const item of value) {
      total += estimateBytes(item, seen);
    }
    return total;
  }

  if (value instanceof Map) {
    let total = 32;
    for (const [k, v] of value) {
      total += estimateBytes(k, seen) + estimateBytes(v, seen);
    }
    return total;
  }

  if (value instanceof Set) {
    let total = 32;
    for (const item of value) {
      total += estimateBytes(item, seen);
    }
    return total;
  }

  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return (value as ArrayBuffer).byteLength ?? (value as DataView).byteLength ?? 0;
  }

  // Plain object
  let total = 16; // object overhead
  for (const [key, val] of Object.entries(value)) {
    total += key.length * 2 + estimateBytes(val, seen);
  }
  return total;
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
