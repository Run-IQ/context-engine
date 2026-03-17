import type { ContextError } from '../errors.js';

export interface ContextLifecycleHooks {
  beforeSet?(nodeId: string, portName: string, value: unknown): void;
  afterSet?(nodeId: string, portName: string, value: unknown): void;
  beforeGet?(key: string): void;
  afterGet?(key: string, value: unknown): void;
  onError?(error: ContextError): void;
}
