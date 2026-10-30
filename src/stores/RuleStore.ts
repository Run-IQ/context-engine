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
/**
 * Input of `saveRule`. `payload` is a JSON object holding the rule definition
 * (`@run-iq/spec` `RuleDefinition`; `params` is required). The store builds the definition
 * from it: `id` (or a generated one), the store's `version`, `model` and the dates of this
 * input take precedence over the payload (`effectiveUntil` absent, `null` or `''` means no
 * end); `priority` and `tags` too when given. `country` goes into `dimensions.country` when
 * the payload has no country dimension, and must agree with it otherwise; `region` stays
 * outside the definition. An invalid payload is refused with `ContextValidationError`.
 */
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
/**
 * A stored rule version. `payload` is the canonical `RuleDefinition`
 * (`canonicalize(normalizeRuleDefinition(definition))` from `@run-iq/spec`, dates in full UTC
 * ISO) and `checksum` its sha256 hex, as `toStoredPayload` returns them: `fromStoredRecord`
 * rebuilds the executable rule from it. The other columns keep the `RuleInput` values as
 * received (dates as `YYYY-MM-DD`, compared as strings by the store).
 */
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
/**
 * `duplicate_checksum`: the candidate has the same content as a published rule, compared with
 * `computeRuleFingerprint` of `@run-iq/spec` (the definition without `id`, `version`,
 * `effectiveFrom` and `effectiveUntil`), not with the checksum. Versions of the candidate's
 * own rule (same `id`) are not duplicates: a new version supersedes them.
 */
export type RuleConflictType =
  'period_overlap' | 'same_priority' | 'effective_date_gap' | 'duplicate_checksum';

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
  /** Throws `ContextValidationError` when the candidate's payload is invalid (as `saveRule`). */
  detectConflicts(candidate: RuleInput): Promise<RuleConflict[]>;

  // ─── Shared scopes ──────────────────────────────────────────────────
  listSharedRules(region: string, model?: string): Promise<SerializedRule[]>;
}
