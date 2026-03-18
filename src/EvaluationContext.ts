import type { ExecutionMeta } from './types/meta.js';
import type { EvaluationContextOptions } from './types/options.js';
import type { ContextSnapshot } from './types/snapshot.js';
import { ContextConflictError, ContextLimitError, ContextValidationError } from './errors.js';
import { deepFreeze, cloneAndFreeze, roughSizeKb, getNestedValue } from './utils.js';

const RESERVED_NAMESPACES = new Set(['input', '__internal', '__meta']);
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9_-]+$/;

export class EvaluationContext {
  private readonly frozenInput: Readonly<Record<string, unknown>>;
  private readonly state: Map<string, unknown> = new Map();
  private readonly snapshotStore: ContextSnapshot[] = [];
  private snapshotCount: number = 0;

  constructor(
    protected readonly input: Readonly<Record<string, unknown>>,
    protected readonly meta: ExecutionMeta,
    protected readonly options: EvaluationContextOptions = {},
  ) {
    this.frozenInput = Object.freeze({ ...input });

    for (const [key, value] of Object.entries(input)) {
      this.state.set(`input.${key}`, cloneAndFreeze(value));
    }
  }

  set(nodeId: string, portName: string, value: unknown): void {
    this.validateIdentifier(nodeId, 'nodeId');
    this.validateIdentifier(portName, 'portName');

    if (RESERVED_NAMESPACES.has(nodeId)) {
      const error = new ContextValidationError(
        `Namespace "${nodeId}" is reserved. ` +
          `Reserved namespaces: ${[...RESERVED_NAMESPACES].join(', ')}. ` +
          `Choose a different nodeId.`,
      );
      this.options.hooks?.onError?.(error);
      throw error;
    }

    const key = `${nodeId}.${portName}`;

    if (this.state.has(key)) {
      const error = new ContextConflictError(
        `Key "${key}" already written in this execution context. ` +
          `Two nodes cannot produce the same output key. ` +
          `This is a graph design error — check for duplicate port names between nodes.`,
      );
      this.options.hooks?.onError?.(error);
      throw error;
    }

    this.checkSizeLimits(value, key);

    this.options.hooks?.beforeSet?.(nodeId, portName, value);
    this.state.set(key, cloneAndFreeze(value));
    this.options.hooks?.afterSet?.(nodeId, portName, value);
  }

  setRaw(nodeId: string, raw: unknown): void {
    this.validateIdentifier(nodeId, 'nodeId');

    if (this.options.limits?.allowRawOverwrite === false && this.state.has(`${nodeId}.__raw`)) {
      throw new ContextConflictError(
        `Raw for node "${nodeId}" already written and allowRawOverwrite is false. ` +
          `In strict mode, raw outputs follow the same append-only rule as regular outputs.`,
      );
    }

    this.state.set(`${nodeId}.__raw`, cloneAndFreeze(raw));
  }

  get(key: string): unknown {
    this.options.hooks?.beforeGet?.(key);

    let value = this.state.get(key);

    if (value === undefined && key.includes('.__raw.')) {
      value = this.resolveRawSubpath(key);
    }

    this.options.hooks?.afterGet?.(key, value);
    return value;
  }

  getNodeOutputs(nodeId: string): Record<string, unknown> {
    const prefix = `${nodeId}.`;
    const result: Record<string, unknown> = {};

    for (const [key, value] of this.state.entries()) {
      if (key.startsWith(prefix) && !key.startsWith(`${nodeId}.__`)) {
        result[key.slice(prefix.length)] = value;
      }
    }

    return result;
  }

  getFullState(): Readonly<Record<string, unknown>> {
    return deepFreeze(Object.fromEntries(this.state));
  }

  has(key: string): boolean {
    return this.state.has(key);
  }

  snapshot(label?: string): ContextSnapshot {
    const id = `${this.meta.requestId}:snap:${this.snapshotCount}`;
    this.snapshotCount++;

    const snap: ContextSnapshot = deepFreeze({
      id,
      label: label ?? `snapshot-${this.snapshotCount}`,
      timestamp: Date.now(),
      state: Object.fromEntries(this.state),
      meta: { ...this.meta },
    });

    this.snapshotStore.push(snap);
    return snap;
  }

  getSnapshots(): readonly ContextSnapshot[] {
    return deepFreeze([...this.snapshotStore]);
  }

  sizeKb(): number {
    return roughSizeKb(Object.fromEntries(this.state));
  }

  entryCount(): number {
    return this.state.size;
  }

  private validateIdentifier(value: string, field: string): void {
    if (!IDENTIFIER_PATTERN.test(value)) {
      throw new ContextValidationError(
        `Invalid ${field} "${value}". ` +
          `Must match /^[a-zA-Z0-9_-]+$/. ` +
          `No dots, spaces, or special characters allowed. ` +
          `Dots are reserved as namespace separators.`,
      );
    }
  }

  private checkSizeLimits(value: unknown, key: string): void {
    const limits = this.options.limits;
    if (!limits) return;

    if (limits.maxValueSizeKb !== undefined) {
      const valueSize = roughSizeKb(value);
      if (valueSize > limits.maxValueSizeKb) {
        const error = new ContextLimitError(
          `Value for key "${key}" is ${valueSize.toFixed(1)}kb, ` +
            `exceeds maxValueSizeKb (${limits.maxValueSizeKb}kb). ` +
            `Consider splitting the output into multiple ports or disabling storeRaw.`,
        );
        this.options.hooks?.onError?.(error);
        throw error;
      }
    }

    if (limits.maxTotalSizeKb !== undefined) {
      const totalSize = this.sizeKb() + roughSizeKb(value);
      if (totalSize > limits.maxTotalSizeKb) {
        const error = new ContextLimitError(
          `Total context size ${totalSize.toFixed(1)}kb exceeds maxTotalSizeKb (${limits.maxTotalSizeKb}kb). ` +
            `The graph is producing too much data. Review storeRaw usage.`,
        );
        this.options.hooks?.onError?.(error);
        throw error;
      }
    }

    if (limits.maxEntries !== undefined && this.state.size >= limits.maxEntries) {
      const error = new ContextLimitError(
        `Context has ${this.state.size} entries, ` +
          `exceeds maxEntries (${limits.maxEntries}). ` +
          `The graph has too many nodes producing outputs.`,
      );
      this.options.hooks?.onError?.(error);
      throw error;
    }
  }

  private resolveRawSubpath(key: string): unknown {
    const rawMarker = '.__raw.';
    const markerIdx = key.indexOf(rawMarker);
    if (markerIdx === -1) return undefined;

    const rawKey = key.slice(0, markerIdx + rawMarker.length - 1);
    const subpath = key.slice(markerIdx + rawMarker.length);
    const rawValue = this.state.get(rawKey);

    if (rawValue === undefined) return undefined;

    return getNestedValue(rawValue as Record<string, unknown>, subpath);
  }
}
