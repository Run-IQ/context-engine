export interface ExecutionMeta {
  readonly requestId: string;
  readonly tenantId: string;
  readonly userId?: string;
  readonly timestamp: string;
  readonly effectiveDate?: string;
  readonly context?: Record<string, unknown>;
}
