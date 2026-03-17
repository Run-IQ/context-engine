// ─── RuleStatus — lifecycle ────────────────────────────────────────────────
export type RuleStatus = 'draft' | 'review' | 'published' | 'deprecated' | 'archived';

// ─── RuleScope ────────────────────────────────────────────────────────────
export type RuleScope = 'tenant-specific' | 'shared';

// ─── RuleQuery — resolution hot path ──────────────────────────────────────
export interface RuleQuery {
  readonly tenantId: string;
  readonly model?: string;
  readonly effectiveDate?: string;
  readonly country?: string;
  readonly region?: string;
  readonly tags?: readonly string[];
  readonly nodeId?: string;
  readonly includeShared?: boolean;
  readonly context?: Record<string, unknown>;
}

// ─── RuleListQuery — listing management ──────────────────────────────────
export interface RuleListQuery {
  readonly tenantId?: string;
  readonly model?: string;
  readonly country?: string;
  readonly status?: RuleStatus | RuleStatus[];
  readonly scope?: RuleScope;
  readonly tags?: readonly string[];
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly orderBy?: 'version' | 'effectiveFrom' | 'createdAt' | 'priority';
  readonly orderDir?: 'asc' | 'desc';
}

// ─── RuleInput — creation/modification ───────────────────────────────────
export interface RuleInput {
  readonly id?: string;
  readonly model: string;
  readonly tenantId: string;
  readonly country?: string;
  readonly region?: string;
  readonly scope: RuleScope;
  readonly effectiveFrom: string;
  readonly effectiveUntil?: string | null;
  readonly priority?: number;
  readonly tags?: readonly string[];
  readonly description?: string;
  readonly source?: string;
  readonly payload: string;
  readonly createdBy: string;
  readonly metadata?: Record<string, unknown>;
}

// ─── SerializedRule — full storage ───────────────────────────────────────
export interface SerializedRule {
  readonly id: string;
  readonly version: number;
  readonly model: string;
  readonly tenantId: string;
  readonly country?: string;
  readonly region?: string;
  readonly scope: RuleScope;
  readonly status: RuleStatus;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly priority: number;
  readonly tags: readonly string[];
  readonly description?: string;
  readonly source?: string;
  readonly checksum: string;
  readonly payload: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly publishedAt?: string;
  readonly publishedBy?: string;
  readonly deprecatedAt?: string;
  readonly deprecatedBy?: string;
  readonly metadata?: Record<string, unknown>;
}

// ─── RuleMetadata — lightweight listing ─────────────────────────────────
export interface RuleMetadata {
  readonly id: string;
  readonly version: number;
  readonly model: string;
  readonly tenantId: string;
  readonly country?: string;
  readonly scope: RuleScope;
  readonly status: RuleStatus;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly priority: number;
  readonly tags: readonly string[];
  readonly description?: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly publishedAt?: string;
}

// ─── RuleAuditEvent — append-only audit trail ───────────────────────────
export type RuleAuditEventType =
  | 'rule.created'
  | 'rule.updated'
  | 'rule.submitted_for_review'
  | 'rule.sent_back_to_draft'
  | 'rule.approved'
  | 'rule.published'
  | 'rule.deprecated'
  | 'rule.archived'
  | 'rule.rollback'
  | 'rule.emergency_rollback'
  | 'rule.conflict_detected'
  | 'rule.conflict_acknowledged';

export interface RuleAuditEvent {
  readonly id: string;
  readonly ruleId: string;
  readonly version: number;
  readonly tenantId: string;
  readonly type: RuleAuditEventType;
  readonly actor: string;
  readonly reason?: string;
  readonly before?: Partial<SerializedRule>;
  readonly after?: Partial<SerializedRule>;
  readonly metadata?: Record<string, unknown>;
  readonly recordedAt: string;
}

// ─── RuleConflict — overlap detection ──────────────────────────────────
export type RuleConflictType =
  | 'period_overlap'
  | 'same_priority'
  | 'effective_date_gap'
  | 'duplicate_checksum';

export interface RuleConflict {
  readonly existingRuleId: string;
  readonly existingVersion: number;
  readonly existingStatus: RuleStatus;
  readonly overlapFrom: string;
  readonly overlapUntil?: string;
  readonly conflictType: RuleConflictType;
  readonly severity: 'warning' | 'critical';
  readonly description: string;
}

// ─── RuleStore interface (v2.0) ─────────────────────────────────────────
export interface RuleStore {
  // ─── Resolution (hot path) ────────────────────────────────────────────
  resolveRules(query: RuleQuery): Promise<SerializedRule[]>;
  fingerprint(query: RuleQuery): string;

  // ─── Read ────────────────────────────────────────────────────────────
  getRule(ruleId: string, version?: number): Promise<SerializedRule | null>;
  listRules(query: RuleListQuery): Promise<RuleMetadata[]>;
  getRuleHistory(ruleId: string): Promise<SerializedRule[]>;
  getRulesAtDate(tenantId: string, atDate: string, model?: string): Promise<SerializedRule[]>;

  // ─── Write ────────────────────────────────────────────────────────────
  saveRule(rule: RuleInput): Promise<SerializedRule>;
  updateRuleStatus(
    ruleId: string,
    version: number,
    status: RuleStatus,
    actor: string,
    reason?: string,
  ): Promise<SerializedRule>;
  publishRule(
    ruleId: string,
    version: number,
    actor: string,
  ): Promise<{ published: SerializedRule; deprecated: SerializedRule[] }>;
  rollbackRule(
    ruleId: string,
    targetVersion: number,
    actor: string,
    reason: string,
  ): Promise<{ restored: SerializedRule; deprecated: SerializedRule }>;

  // ─── Audit trail ─────────────────────────────────────────────────────
  recordAuditEvent(event: RuleAuditEvent): Promise<void>;
  getAuditTrail(ruleId: string): Promise<RuleAuditEvent[]>;

  // ─── Conflicts ───────────────────────────────────────────────────────
  detectConflicts(candidate: RuleInput): Promise<RuleConflict[]>;

  // ─── Shared scopes ──────────────────────────────────────────────────
  listSharedRules(region: string, model?: string): Promise<SerializedRule[]>;
}
