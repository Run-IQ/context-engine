import type {
  RuleStore,
  RuleQuery,
  RuleListQuery,
  RuleInput,
  SerializedRule,
  RuleMetadata,
  RuleStatus,
  RuleAuditEvent,
  RuleConflict,
} from '../stores/RuleStore.js';
import { RuleNotFoundError, RuleTransitionError, RulePublishError } from '../errors.js';
import { sha256 } from '../utils.js';

// ─── Allowed transitions ──────────────────────────────────────────────────
const ALLOWED_TRANSITIONS: Record<RuleStatus, RuleStatus[]> = {
  draft: ['review', 'archived'],
  review: ['published', 'draft'],
  published: ['deprecated'],
  deprecated: ['archived'],
  archived: [],
};

// ─── Helpers ──────────────────────────────────────────────────────────────

function periodsOverlap(
  a: { effectiveFrom: string; effectiveUntil: string | null },
  b: { effectiveFrom: string; effectiveUntil?: string | null },
): boolean {
  const aEnd = a.effectiveUntil ?? '9999-12-31';
  const bEnd = b.effectiveUntil ?? '9999-12-31';
  return a.effectiveFrom <= bEnd && b.effectiveFrom <= aEnd;
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

function minDate(a: string | null | undefined, b: string | null | undefined): string | undefined {
  if (!a && !b) return undefined;
  if (!a) return b!;
  if (!b) return a;
  return a < b ? a : b;
}

function today(): string {
  return new Date().toISOString().split('T')[0]!;
}

function toMetadata(r: SerializedRule): RuleMetadata {
  const meta: RuleMetadata = {
    id: r.id,
    version: r.version,
    model: r.model,
    tenantId: r.tenantId,
    scope: r.scope,
    status: r.status,
    effectiveFrom: r.effectiveFrom,
    effectiveUntil: r.effectiveUntil,
    priority: r.priority,
    tags: r.tags,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  };
  if (r.country !== undefined) (meta as unknown as Record<string, unknown>)['country'] = r.country;
  if (r.description !== undefined)
    (meta as unknown as Record<string, unknown>)['description'] = r.description;
  if (r.publishedAt !== undefined)
    (meta as unknown as Record<string, unknown>)['publishedAt'] = r.publishedAt;
  return meta;
}

let idCounter = 0;
function generateId(): string {
  idCounter++;
  return `rule-${Date.now()}-${idCounter}`;
}

/**
 * InMemoryRuleStore — reference implementation of RuleStore v2.0.
 *
 * AUDIT RESPONSIBILITY: The RuleStore does NOT write audit events internally.
 * Audit trail is the exclusive responsibility of @run-iq/rule-registry's
 * RuleManager — which wraps every mutation with proper audit logging.
 * This separation prevents double-logging when RuleManager calls store methods.
 *
 * Direct users of RuleStore (without RuleManager) are responsible for
 * their own audit trail if needed.
 */
export class InMemoryRuleStore implements RuleStore {
  private readonly rules: Map<string, SerializedRule> = new Map();
  private readonly auditTrail: Map<string, RuleAuditEvent[]> = new Map();

  // ─── Resolution ──────────────────────────────────────────────────────

  async resolveRules(query: RuleQuery): Promise<SerializedRule[]> {
    const effectiveDate = query.effectiveDate ?? today();
    const includeShared = query.includeShared !== false;

    return [...this.rules.values()]
      .filter((rule) => {
        // Status: published only
        if (rule.status !== 'published') return false;

        // Scope: tenant-specific for this tenant OR shared if included
        if (rule.scope === 'tenant-specific' && rule.tenantId !== query.tenantId) return false;
        if (rule.scope === 'shared' && !includeShared) return false;
        if (rule.scope === 'shared' && query.region && rule.region !== query.region) return false;

        // Model
        if (query.model && rule.model !== query.model) return false;

        // Country
        if (query.country && rule.country && rule.country !== query.country) return false;

        // Effective period
        if (rule.effectiveFrom > effectiveDate) return false;
        if (rule.effectiveUntil && rule.effectiveUntil < effectiveDate) return false;

        // Tags
        if (query.tags?.length) {
          if (!query.tags.some((tag) => rule.tags.includes(tag))) return false;
        }

        return true;
      })
      .sort((a, b) => {
        // Priority descending, then version descending
        if (b.priority !== a.priority) return b.priority - a.priority;
        return b.version - a.version;
      });
  }

  fingerprint(query: RuleQuery): string {
    return sha256(
      JSON.stringify({
        tenantId: query.tenantId,
        model: query.model ?? null,
        effectiveDate: query.effectiveDate ?? today(),
        country: query.country ?? null,
        region: query.region ?? null,
        tags: query.tags ? [...query.tags].sort() : null,
        includeShared: query.includeShared !== false,
      }),
    );
  }

  // ─── Read ────────────────────────────────────────────────────────────

  async getRule(ruleId: string, version?: number): Promise<SerializedRule | null> {
    if (version !== undefined) {
      return this.rules.get(`${ruleId}:${version}`) ?? null;
    }
    const matches = [...this.rules.values()]
      .filter((r) => r.id === ruleId)
      .sort((a, b) => b.version - a.version);
    return matches[0] ?? null;
  }

  async listRules(query: RuleListQuery): Promise<RuleMetadata[]> {
    const statuses = query.status
      ? Array.isArray(query.status)
        ? query.status
        : [query.status]
      : undefined;

    let results = [...this.rules.values()].filter((r) => {
      if (query.tenantId && r.tenantId !== query.tenantId) return false;
      if (query.model && r.model !== query.model) return false;
      if (query.country && r.country !== query.country) return false;
      if (query.scope && r.scope !== query.scope) return false;
      if (statuses && !statuses.includes(r.status)) return false;
      if (query.tags?.length && !query.tags.some((t) => r.tags.includes(t))) return false;
      if (query.effectiveFrom && r.effectiveFrom < query.effectiveFrom) return false;
      if (query.effectiveTo && r.effectiveFrom > query.effectiveTo) return false;
      return true;
    });

    // Ordering
    if (query.orderBy) {
      const dir = query.orderDir === 'desc' ? -1 : 1;
      results = results.sort((a, b) => {
        const aVal = a[query.orderBy!];
        const bVal = b[query.orderBy!];
        if (typeof aVal === 'number' && typeof bVal === 'number') return (aVal - bVal) * dir;
        return String(aVal ?? '').localeCompare(String(bVal ?? '')) * dir;
      });
    }

    const offset = query.offset ?? 0;
    const limit = query.limit ?? results.length;
    return results.slice(offset, offset + limit).map(toMetadata);
  }

  async getRuleHistory(ruleId: string): Promise<SerializedRule[]> {
    return [...this.rules.values()]
      .filter((r) => r.id === ruleId)
      .sort((a, b) => a.version - b.version);
  }

  async getRulesAtDate(
    tenantId: string,
    atDate: string,
    model?: string,
  ): Promise<SerializedRule[]> {
    const query: RuleQuery = { tenantId, effectiveDate: atDate };
    if (model !== undefined) (query as unknown as Record<string, unknown>)['model'] = model;
    return this.resolveRules(query);
  }

  // ─── Write ───────────────────────────────────────────────────────────

  async saveRule(input: RuleInput): Promise<SerializedRule> {
    const id = input.id ?? generateId();
    const existing = [...this.rules.values()].filter((r) => r.id === id);
    const version = existing.length > 0 ? Math.max(...existing.map((r) => r.version)) + 1 : 1;
    const now = new Date().toISOString();

    const rule: SerializedRule = {
      id,
      version,
      model: input.model,
      tenantId: input.tenantId,
      scope: input.scope,
      status: 'draft',
      effectiveFrom: input.effectiveFrom,
      effectiveUntil: input.effectiveUntil ?? null,
      priority: input.priority ?? 0,
      tags: input.tags ? [...input.tags] : [],
      checksum: sha256(input.payload),
      payload: input.payload,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };

    // Only set optional properties if defined (exactOptionalPropertyTypes)
    const mutable = rule as unknown as Record<string, unknown>;
    if (input.country !== undefined) mutable['country'] = input.country;
    if (input.region !== undefined) mutable['region'] = input.region;
    if (input.description !== undefined) mutable['description'] = input.description;
    if (input.source !== undefined) mutable['source'] = input.source;
    if (input.metadata !== undefined) mutable['metadata'] = input.metadata;

    this.rules.set(`${id}:${version}`, rule);
    return rule;
  }

  async updateRuleStatus(
    ruleId: string,
    version: number,
    status: RuleStatus,
    actor: string,
    reason?: string,
  ): Promise<SerializedRule> {
    const key = `${ruleId}:${version}`;
    const rule = this.rules.get(key);
    if (!rule) throw new RuleNotFoundError(`Rule "${ruleId}" version ${version} not found`);

    // Validate transitions
    const allowed = ALLOWED_TRANSITIONS[rule.status];
    if (!allowed?.includes(status)) {
      throw new RuleTransitionError(
        `Cannot transition rule "${ruleId}" from "${rule.status}" to "${status}". ` +
          `Allowed transitions: ${allowed?.join(', ') ?? 'none'}.`,
      );
    }

    // Reason required for certain transitions
    if (status === 'archived' && !reason) {
      throw new RuleTransitionError(`Reason is required for transition to "${status}"`);
    }

    const now = new Date().toISOString();
    const updated: SerializedRule = { ...rule, status, updatedAt: now };
    if (status === 'deprecated') {
      const m = updated as unknown as Record<string, unknown>;
      m['deprecatedAt'] = now;
      m['deprecatedBy'] = actor;
    }

    this.rules.set(key, updated);
    return updated;
  }

  async publishRule(
    ruleId: string,
    version: number,
    actor: string,
  ): Promise<{ published: SerializedRule; deprecated: SerializedRule[] }> {
    const rule = this.rules.get(`${ruleId}:${version}`);
    if (!rule) throw new RuleNotFoundError(`Rule "${ruleId}" version ${version} not found`);
    if (rule.status !== 'review') {
      throw new RulePublishError(
        `Cannot publish rule "${ruleId}" version ${version}: ` +
          `status is "${rule.status}", expected "review".`,
      );
    }

    const now = new Date().toISOString();

    // Auto-deprecate overlapping published rules
    const toDeprecate = [...this.rules.values()].filter(
      (r) =>
        r.id !== ruleId &&
        r.status === 'published' &&
        r.tenantId === rule.tenantId &&
        r.model === rule.model &&
        (r.country ?? null) === (rule.country ?? null) &&
        periodsOverlap(r, rule),
    );

    const deprecated: SerializedRule[] = [];
    for (const r of toDeprecate) {
      const dep = await this.updateRuleStatus(
        r.id,
        r.version,
        'deprecated',
        'system',
        `Automatically deprecated: replaced by ${ruleId} v${version}`,
      );
      deprecated.push(dep);
    }

    // Publish
    const published: SerializedRule = {
      ...rule,
      status: 'published',
      publishedAt: now,
      publishedBy: actor,
      updatedAt: now,
    };
    this.rules.set(`${ruleId}:${version}`, published);

    return { published, deprecated };
  }

  async rollbackRule(
    ruleId: string,
    targetVersion: number,
    actor: string,
    reason: string,
  ): Promise<{ restored: SerializedRule; deprecated: SerializedRule }> {
    const target = this.rules.get(`${ruleId}:${targetVersion}`);
    if (!target) {
      throw new RuleNotFoundError(`Rule "${ruleId}" version ${targetVersion} not found`);
    }

    // Find currently published version
    const current = [...this.rules.values()].find(
      (r) => r.id === ruleId && r.status === 'published',
    );
    if (!current) {
      throw new RuleNotFoundError(`No published version of rule "${ruleId}" found`);
    }

    const now = new Date().toISOString();

    const deprecated: SerializedRule = {
      ...current,
      status: 'deprecated',
      deprecatedAt: now,
      deprecatedBy: actor,
      updatedAt: now,
    };
    this.rules.set(`${current.id}:${current.version}`, deprecated);

    const restored: SerializedRule = {
      ...target,
      status: 'published',
      publishedAt: now,
      publishedBy: actor,
      updatedAt: now,
    };
    this.rules.set(`${ruleId}:${targetVersion}`, restored);

    // Audit: NOT logged here — RuleManager.emergencyRollback() handles audit logging.
    void reason; // used by RuleManager for audit

    return { restored, deprecated };
  }

  // ─── Audit trail ────────────────────────────────────────────────────

  async recordAuditEvent(event: RuleAuditEvent): Promise<void> {
    const trail = this.auditTrail.get(event.ruleId) ?? [];
    trail.push(event);
    this.auditTrail.set(event.ruleId, trail);
  }

  async getAuditTrail(ruleId: string): Promise<RuleAuditEvent[]> {
    return [...(this.auditTrail.get(ruleId) ?? [])];
  }

  // ─── Conflicts ──────────────────────────────────────────────────────

  async detectConflicts(candidate: RuleInput): Promise<RuleConflict[]> {
    const conflicts: RuleConflict[] = [];

    for (const existing of this.rules.values()) {
      if (existing.status !== 'published') continue;
      if (existing.tenantId !== candidate.tenantId) continue;
      if (existing.model !== candidate.model) continue;
      if ((existing.country ?? null) !== (candidate.country ?? null)) continue;

      if (
        !periodsOverlap(existing, {
          effectiveFrom: candidate.effectiveFrom,
          effectiveUntil: candidate.effectiveUntil ?? null,
        })
      )
        continue;

      const overlapFrom = maxDate(existing.effectiveFrom, candidate.effectiveFrom);
      const overlapUntil = minDate(existing.effectiveUntil, candidate.effectiveUntil);

      const makeConflict = (
        conflictType: RuleConflict['conflictType'],
        severity: RuleConflict['severity'],
        description: string,
      ): RuleConflict => {
        const c: RuleConflict = {
          existingRuleId: existing.id,
          existingVersion: existing.version,
          existingStatus: existing.status,
          overlapFrom,
          conflictType,
          severity,
          description,
        };
        if (overlapUntil !== undefined)
          (c as unknown as Record<string, unknown>)['overlapUntil'] = overlapUntil;
        return c;
      };

      // Exact duplicate
      if (sha256(existing.payload) === sha256(candidate.payload)) {
        conflicts.push(
          makeConflict(
            'duplicate_checksum',
            'critical',
            `Identical payload detected — possible duplicate of rule "${existing.id}" v${existing.version}`,
          ),
        );
        continue;
      }

      // Same priority → non-deterministic arbitration
      if (existing.priority === (candidate.priority ?? 0)) {
        conflicts.push(
          makeConflict(
            'same_priority',
            'warning',
            `Both rules have priority ${existing.priority} on overlapping period. Core dominance resolver will arbitrate.`,
          ),
        );
      } else {
        conflicts.push(
          makeConflict(
            'period_overlap',
            'warning',
            `Period overlap with rule "${existing.id}" v${existing.version}. Higher priority rule will take precedence.`,
          ),
        );
      }
    }

    return conflicts;
  }

  // ─── Shared scopes ──────────────────────────────────────────────────

  async listSharedRules(region: string, model?: string): Promise<SerializedRule[]> {
    return [...this.rules.values()].filter(
      (r) =>
        r.scope === 'shared' &&
        r.region === region &&
        r.status === 'published' &&
        (!model || r.model === model),
    );
  }
}
