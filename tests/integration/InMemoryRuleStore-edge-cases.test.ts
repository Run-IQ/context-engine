import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryRuleStore } from '../../src/adapters/InMemoryRuleStore';
import type { RuleInput, SerializedRule, RuleAuditEvent } from '../../src/stores/RuleStore';
import { RuleNotFoundError, RuleTransitionError, RulePublishError } from '../../src/errors';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const makeInput = (overrides: Partial<RuleInput> = {}): RuleInput => ({
  model: 'FLAT_RATE',
  tenantId: 'T1',
  scope: 'tenant-specific',
  effectiveFrom: '2025-01-01',
  payload: JSON.stringify({ country: 'TG' }),
  createdBy: 'test-user',
  ...overrides,
});

async function saveAndPublish(store: InMemoryRuleStore, input: RuleInput): Promise<SerializedRule> {
  const saved = await store.saveRule(input);
  await store.updateRuleStatus(saved.id, saved.version, 'review', 'test-user');
  const { published } = await store.publishRule(saved.id, saved.version, 'test-user');
  return published;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('InMemoryRuleStore — edge cases (V2)', () => {
  let store: InMemoryRuleStore;

  beforeEach(() => {
    store = new InMemoryRuleStore();
  });

  // ─── resolveRules edge cases ──────────────────────────────────────────────

  it('resolveRules returns empty array on empty store', async () => {
    const results = await store.resolveRules({ tenantId: 'T1' });
    expect(results).toEqual([]);
  });

  it('resolveRules with tags — returns rules matching ANY tag (must be published)', async () => {
    // Use different models to avoid auto-deprecation of overlapping published rules
    await saveAndPublish(
      store,
      makeInput({ id: 'r1', model: 'MODEL_A', tags: ['tax', 'fiscal'], payload: '{"r":1}' }),
    );
    await saveAndPublish(
      store,
      makeInput({ id: 'r2', model: 'MODEL_B', tags: ['payroll'], payload: '{"r":2}' }),
    );
    await saveAndPublish(
      store,
      makeInput({ id: 'r3', model: 'MODEL_C', tags: ['fiscal', 'report'], payload: '{"r":3}' }),
    );

    const results = await store.resolveRules({ tenantId: 'T1', tags: ['payroll'] });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('r2');

    const results2 = await store.resolveRules({ tenantId: 'T1', tags: ['fiscal'] });
    expect(results2).toHaveLength(2);
    const ids = results2.map((r) => r.id).sort();
    expect(ids).toEqual(['r1', 'r3']);
  });

  it('resolveRules with effectiveUntil=null means no expiration', async () => {
    await saveAndPublish(store, makeInput({ effectiveFrom: '2020-01-01', effectiveUntil: null }));
    const results = await store.resolveRules({
      tenantId: 'T1',
      effectiveDate: '2099-12-31',
    });
    expect(results).toHaveLength(1);
  });

  it('resolveRules at exact effectiveFrom date — inclusive', async () => {
    await saveAndPublish(store, makeInput({ effectiveFrom: '2025-06-15' }));
    const results = await store.resolveRules({
      tenantId: 'T1',
      effectiveDate: '2025-06-15',
    });
    expect(results).toHaveLength(1);
  });

  it('resolveRules at exact effectiveUntil date — inclusive', async () => {
    await saveAndPublish(
      store,
      makeInput({ effectiveFrom: '2025-01-01', effectiveUntil: '2025-06-15' }),
    );
    const results = await store.resolveRules({
      tenantId: 'T1',
      effectiveDate: '2025-06-15',
    });
    expect(results).toHaveLength(1);
  });

  it('resolveRules one day after effectiveUntil — excluded', async () => {
    await saveAndPublish(
      store,
      makeInput({ effectiveFrom: '2025-01-01', effectiveUntil: '2025-06-15' }),
    );
    const results = await store.resolveRules({
      tenantId: 'T1',
      effectiveDate: '2025-06-16',
    });
    expect(results).toHaveLength(0);
  });

  it('resolveRules one day before effectiveFrom — excluded', async () => {
    await saveAndPublish(store, makeInput({ effectiveFrom: '2025-06-15' }));
    const results = await store.resolveRules({
      tenantId: 'T1',
      effectiveDate: '2025-06-14',
    });
    expect(results).toHaveLength(0);
  });

  it('resolveRules with country filter (using rule.country field, NOT payload)', async () => {
    await saveAndPublish(store, makeInput({ id: 'r-tg', country: 'TG' }));
    await saveAndPublish(
      store,
      makeInput({ id: 'r-sn', country: 'SN', payload: JSON.stringify({ x: 1 }) }),
    );
    await saveAndPublish(store, makeInput({ id: 'r-none', payload: JSON.stringify({ y: 2 }) }));

    const tgRules = await store.resolveRules({ tenantId: 'T1', country: 'TG' });
    // r-tg matches (country=TG), r-none matches (no country filter on rule), r-sn excluded
    const tgIds = tgRules.map((r) => r.id).sort();
    expect(tgIds).toContain('r-tg');
    expect(tgIds).toContain('r-none');
    expect(tgIds).not.toContain('r-sn');

    const snRules = await store.resolveRules({ tenantId: 'T1', country: 'SN' });
    const snIds = snRules.map((r) => r.id).sort();
    expect(snIds).toContain('r-sn');
    expect(snIds).toContain('r-none');
    expect(snIds).not.toContain('r-tg');
  });

  it('resolveRules only returns published rules — draft/review are excluded', async () => {
    // Save a draft (not published)
    await store.saveRule(makeInput({ id: 'draft-rule' }));

    // Save a rule in review (not published)
    const reviewRule = await store.saveRule(makeInput({ id: 'review-rule' }));
    await store.updateRuleStatus(reviewRule.id, reviewRule.version, 'review', 'test-user');

    // Save and publish one
    await saveAndPublish(store, makeInput({ id: 'published-rule' }));

    const results = await store.resolveRules({ tenantId: 'T1' });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('published-rule');
  });

  // ─── Multi-version rules ──────────────────────────────────────────────────

  it('saveRule auto-increments version when same id is given', async () => {
    const v1 = await store.saveRule(makeInput({ id: 'mv-rule', payload: '{"v":1}' }));
    expect(v1.version).toBe(1);
    expect(v1.status).toBe('draft');

    const v2 = await store.saveRule(makeInput({ id: 'mv-rule', payload: '{"v":2}' }));
    expect(v2.version).toBe(2);

    const v3 = await store.saveRule(makeInput({ id: 'mv-rule', payload: '{"v":3}' }));
    expect(v3.version).toBe(3);

    // getRule without version returns latest
    const latest = await store.getRule('mv-rule');
    expect(latest!.version).toBe(3);

    // getRule with version returns specific
    const specific = await store.getRule('mv-rule', 1);
    expect(specific!.version).toBe(1);
  });

  // ─── Fingerprint edge cases ───────────────────────────────────────────────

  it('fingerprint with tags sorts them — order independent', () => {
    const q1 = { tenantId: 'T1', tags: ['b', 'a', 'c'] as string[] };
    const q2 = { tenantId: 'T1', tags: ['c', 'a', 'b'] as string[] };
    expect(store.fingerprint(q1)).toBe(store.fingerprint(q2));
  });

  it('fingerprint with empty tags vs no tags — different', () => {
    const q1 = { tenantId: 'T1', tags: [] as string[] };
    const q2 = { tenantId: 'T1' };
    expect(store.fingerprint(q1)).not.toBe(store.fingerprint(q2));
  });

  it('fingerprint with different tenantId — different', () => {
    const q1 = { tenantId: 'T1' };
    const q2 = { tenantId: 'T2' };
    expect(store.fingerprint(q1)).not.toBe(store.fingerprint(q2));
  });

  it('fingerprint with different country — different', () => {
    const q1 = { tenantId: 'T1', country: 'TG' };
    const q2 = { tenantId: 'T1', country: 'SN' };
    expect(store.fingerprint(q1)).not.toBe(store.fingerprint(q2));
  });

  // ─── listRules edge cases ─────────────────────────────────────────────────

  it('listRules with empty query returns all rules', async () => {
    await store.saveRule(makeInput({ id: 'r1' }));
    await store.saveRule(makeInput({ id: 'r2', tenantId: 'T2' }));
    const results = await store.listRules({});
    expect(results).toHaveLength(2);
  });

  it('listRules returns metadata — no payload', async () => {
    await store.saveRule(makeInput());
    const results = await store.listRules({});
    const meta = results[0]!;
    expect(meta).toHaveProperty('id');
    expect(meta).toHaveProperty('model');
    expect(meta).toHaveProperty('tenantId');
    expect(meta).toHaveProperty('version');
    expect(meta).toHaveProperty('status');
    expect(meta).toHaveProperty('scope');
    expect(meta).not.toHaveProperty('payload');
    expect(meta).not.toHaveProperty('checksum');
  });

  // ─── Stress test ──────────────────────────────────────────────────────────

  it('handles 500 rules across 10 tenants (published)', async () => {
    // Use unique model per rule to avoid auto-deprecation of overlapping published rules
    for (let t = 0; t < 10; t++) {
      for (let r = 0; r < 50; r++) {
        await saveAndPublish(
          store,
          makeInput({
            id: `rule-t${t}-r${r}`,
            tenantId: `T${t}`,
            model: `MODEL_${r}`,
            payload: JSON.stringify({ t, r }),
          }),
        );
      }
    }

    const t5Rules = await store.resolveRules({ tenantId: 'T5' });
    expect(t5Rules).toHaveLength(50);

    const model0Rules = await store.resolveRules({ tenantId: 'T5', model: 'MODEL_0' });
    expect(model0Rules).toHaveLength(1);

    const all = await store.listRules({});
    expect(all).toHaveLength(500);
  });

  // ─── updateRuleStatus — valid transitions ─────────────────────────────────

  it('updateRuleStatus: draft → review', async () => {
    const saved = await store.saveRule(makeInput());
    expect(saved.status).toBe('draft');

    const updated = await store.updateRuleStatus(saved.id, saved.version, 'review', 'test-user');
    expect(updated.status).toBe('review');
  });

  it('updateRuleStatus: review → published via publishRule', async () => {
    const saved = await store.saveRule(makeInput());
    await store.updateRuleStatus(saved.id, saved.version, 'review', 'test-user');
    const { published } = await store.publishRule(saved.id, saved.version, 'test-user');
    expect(published.status).toBe('published');
    expect(published.publishedBy).toBe('test-user');
    expect(published.publishedAt).toBeDefined();
  });

  it('updateRuleStatus: published → deprecated', async () => {
    const published = await saveAndPublish(store, makeInput());
    const deprecated = await store.updateRuleStatus(
      published.id,
      published.version,
      'deprecated',
      'test-user',
    );
    expect(deprecated.status).toBe('deprecated');
    expect(deprecated.deprecatedAt).toBeDefined();
    expect(deprecated.deprecatedBy).toBe('test-user');
  });

  it('updateRuleStatus: draft → archived (with reason)', async () => {
    const saved = await store.saveRule(makeInput());
    const archived = await store.updateRuleStatus(
      saved.id,
      saved.version,
      'archived',
      'test-user',
      'No longer needed',
    );
    expect(archived.status).toBe('archived');
  });

  it('updateRuleStatus: review → draft (send back)', async () => {
    const saved = await store.saveRule(makeInput());
    await store.updateRuleStatus(saved.id, saved.version, 'review', 'test-user');
    const draft = await store.updateRuleStatus(saved.id, saved.version, 'draft', 'test-user');
    expect(draft.status).toBe('draft');
  });

  // ─── updateRuleStatus — invalid transitions ──────────────────────────────

  it('updateRuleStatus: published → draft throws RuleTransitionError', async () => {
    const published = await saveAndPublish(store, makeInput());
    await expect(
      store.updateRuleStatus(published.id, published.version, 'draft', 'test-user'),
    ).rejects.toThrow(RuleTransitionError);
  });

  it('updateRuleStatus: archived → anything throws RuleTransitionError', async () => {
    const saved = await store.saveRule(makeInput());
    await store.updateRuleStatus(saved.id, saved.version, 'archived', 'test-user', 'Cleanup');

    await expect(
      store.updateRuleStatus(saved.id, saved.version, 'draft', 'test-user'),
    ).rejects.toThrow(RuleTransitionError);

    await expect(
      store.updateRuleStatus(saved.id, saved.version, 'review', 'test-user'),
    ).rejects.toThrow(RuleTransitionError);

    await expect(
      store.updateRuleStatus(saved.id, saved.version, 'published', 'test-user'),
    ).rejects.toThrow(RuleTransitionError);
  });

  // ─── publishRule ──────────────────────────────────────────────────────────

  it('publishRule: status is not review throws RulePublishError', async () => {
    const saved = await store.saveRule(makeInput());
    // Attempt to publish a draft
    await expect(store.publishRule(saved.id, saved.version, 'test-user')).rejects.toThrow(
      RulePublishError,
    );
  });

  it('publishRule: auto-deprecates overlapping published rules', async () => {
    const first = await saveAndPublish(
      store,
      makeInput({
        id: 'overlap-a',
        effectiveFrom: '2025-01-01',
        effectiveUntil: '2025-12-31',
      }),
    );
    expect(first.status).toBe('published');

    // Publish a second rule with overlapping period, same model+tenant+country
    const { published, deprecated } = await (async () => {
      const saved = await store.saveRule(
        makeInput({
          id: 'overlap-b',
          effectiveFrom: '2025-06-01',
          effectiveUntil: '2026-06-30',
        }),
      );
      await store.updateRuleStatus(saved.id, saved.version, 'review', 'test-user');
      return store.publishRule(saved.id, saved.version, 'test-user');
    })();

    expect(published.status).toBe('published');
    expect(deprecated).toHaveLength(1);
    expect(deprecated[0]!.id).toBe('overlap-a');
    expect(deprecated[0]!.status).toBe('deprecated');

    // Verify the first rule is now deprecated in the store
    const firstNow = await store.getRule('overlap-a', first.version);
    expect(firstNow!.status).toBe('deprecated');
  });

  // ─── rollbackRule ─────────────────────────────────────────────────────────

  it('rollbackRule: restores target version and deprecates current', async () => {
    // Publish v1
    const v1 = await saveAndPublish(store, makeInput({ id: 'rb-rule', payload: '{"v":1}' }));

    // Deprecate v1 manually, then publish v2
    await store.updateRuleStatus(v1.id, v1.version, 'deprecated', 'test-user');

    const v2saved = await store.saveRule(makeInput({ id: 'rb-rule', payload: '{"v":2}' }));
    await store.updateRuleStatus(v2saved.id, v2saved.version, 'review', 'test-user');
    const { published: v2 } = await store.publishRule(v2saved.id, v2saved.version, 'test-user');

    expect(v2.status).toBe('published');
    expect(v2.version).toBe(2);

    // Rollback to v1
    const { restored, deprecated } = await store.rollbackRule(
      'rb-rule',
      v1.version,
      'admin',
      'Reverting to v1 due to error',
    );

    expect(restored.version).toBe(v1.version);
    expect(restored.status).toBe('published');
    expect(deprecated.version).toBe(v2.version);
    expect(deprecated.status).toBe('deprecated');
  });

  it('rollbackRule: target not found throws RuleNotFoundError', async () => {
    await saveAndPublish(store, makeInput({ id: 'rb-missing' }));
    await expect(
      store.rollbackRule('rb-missing', 999, 'admin', 'Rollback attempt'),
    ).rejects.toThrow(RuleNotFoundError);
  });

  // ─── detectConflicts ──────────────────────────────────────────────────────

  it('detectConflicts: finds overlapping published rules', async () => {
    await saveAndPublish(
      store,
      makeInput({
        id: 'conf-a',
        effectiveFrom: '2025-01-01',
        effectiveUntil: '2025-12-31',
        priority: 10,
        payload: '{"a":1}',
      }),
    );

    const candidate = makeInput({
      effectiveFrom: '2025-06-01',
      effectiveUntil: '2026-06-30',
      priority: 20,
      payload: '{"b":2}',
    });

    const conflicts = await store.detectConflicts(candidate);
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    expect(conflicts[0]!.existingRuleId).toBe('conf-a');
    expect(conflicts[0]!.conflictType).toBe('period_overlap');
  });

  it('detectConflicts: no conflicts when no overlap', async () => {
    await saveAndPublish(
      store,
      makeInput({
        id: 'noconf',
        effectiveFrom: '2025-01-01',
        effectiveUntil: '2025-06-30',
        payload: '{"x":1}',
      }),
    );

    const candidate = makeInput({
      effectiveFrom: '2025-07-01',
      effectiveUntil: '2025-12-31',
      payload: '{"y":2}',
    });

    const conflicts = await store.detectConflicts(candidate);
    expect(conflicts).toHaveLength(0);
  });

  it('detectConflicts: duplicate_checksum for identical payloads', async () => {
    const sharedPayload = JSON.stringify({ rate: 0.18, base: 'revenue' });
    await saveAndPublish(
      store,
      makeInput({
        id: 'dup-a',
        effectiveFrom: '2025-01-01',
        payload: sharedPayload,
      }),
    );

    const candidate = makeInput({
      effectiveFrom: '2025-06-01',
      payload: sharedPayload,
    });

    const conflicts = await store.detectConflicts(candidate);
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    const dupConflict = conflicts.find((c) => c.conflictType === 'duplicate_checksum');
    expect(dupConflict).toBeDefined();
    expect(dupConflict!.severity).toBe('critical');
  });

  // ─── getRuleHistory ───────────────────────────────────────────────────────

  it('getRuleHistory: returns all versions ordered chronologically', async () => {
    await store.saveRule(makeInput({ id: 'hist-rule', payload: '{"v":1}' }));
    await store.saveRule(makeInput({ id: 'hist-rule', payload: '{"v":2}' }));
    await store.saveRule(makeInput({ id: 'hist-rule', payload: '{"v":3}' }));

    const history = await store.getRuleHistory('hist-rule');
    expect(history).toHaveLength(3);
    expect(history[0]!.version).toBe(1);
    expect(history[1]!.version).toBe(2);
    expect(history[2]!.version).toBe(3);
  });

  // ─── getRulesAtDate ───────────────────────────────────────────────────────

  it('getRulesAtDate: equivalent to resolveRules at that date', async () => {
    await saveAndPublish(
      store,
      makeInput({
        id: 'date-a',
        effectiveFrom: '2025-01-01',
        effectiveUntil: '2025-06-30',
        payload: '{"a":1}',
      }),
    );
    await saveAndPublish(
      store,
      makeInput({
        id: 'date-b',
        effectiveFrom: '2025-04-01',
        effectiveUntil: '2025-12-31',
        payload: '{"b":2}',
      }),
    );

    const atDate = await store.getRulesAtDate('T1', '2025-05-01');
    const resolved = await store.resolveRules({
      tenantId: 'T1',
      effectiveDate: '2025-05-01',
    });

    expect(atDate.map((r) => r.id).sort()).toEqual(resolved.map((r) => r.id).sort());
  });

  // ─── includeShared filtering ─────────────────────────────────────────────

  it('resolveRules with includeShared=false excludes shared rules', async () => {
    await saveAndPublish(
      store,
      makeInput({
        id: 'shared-rule',
        scope: 'shared',
        region: 'UEMOA',
        model: 'SHARED_MODEL',
        payload: '{"shared":true}',
      }),
    );
    await saveAndPublish(
      store,
      makeInput({
        id: 'tenant-rule',
        scope: 'tenant-specific',
        model: 'TENANT_MODEL',
        payload: '{"tenant":true}',
      }),
    );

    // Default: includeShared is true
    const withShared = await store.resolveRules({ tenantId: 'T1' });
    expect(withShared).toHaveLength(2);

    // Explicit false: excludes shared rules
    const withoutShared = await store.resolveRules({ tenantId: 'T1', includeShared: false });
    expect(withoutShared).toHaveLength(1);
    expect(withoutShared[0]!.scope).toBe('tenant-specific');
  });

  it('resolveRules with region filter only returns shared rules from that region', async () => {
    await saveAndPublish(
      store,
      makeInput({
        id: 'uemoa-rule',
        scope: 'shared',
        region: 'UEMOA',
        model: 'UEMOA_MODEL',
        payload: '{"r":"uemoa"}',
      }),
    );
    await saveAndPublish(
      store,
      makeInput({
        id: 'ohada-rule',
        scope: 'shared',
        region: 'OHADA',
        model: 'OHADA_MODEL',
        payload: '{"r":"ohada"}',
      }),
    );

    const uemoa = await store.resolveRules({ tenantId: 'T1', region: 'UEMOA' });
    // Only the UEMOA shared rule + tenant-specific if any (none here since we didn't save one)
    const sharedIds = uemoa.filter((r) => r.scope === 'shared').map((r) => r.id);
    expect(sharedIds).toEqual(['uemoa-rule']);
  });

  // ─── listSharedRules ──────────────────────────────────────────────────────

  it('listSharedRules: returns published shared rules for a region', async () => {
    // Use different models to avoid auto-deprecation of overlapping published rules
    await saveAndPublish(
      store,
      makeInput({
        id: 'shared-1',
        scope: 'shared',
        region: 'WEST_AFRICA',
        model: 'FLAT_RATE',
        payload: '{"s":1}',
      }),
    );
    await saveAndPublish(
      store,
      makeInput({
        id: 'shared-2',
        scope: 'shared',
        region: 'WEST_AFRICA',
        model: 'BRACKET',
        payload: '{"s":2}',
      }),
    );
    await saveAndPublish(
      store,
      makeInput({
        id: 'shared-3',
        scope: 'shared',
        region: 'EAST_AFRICA',
        model: 'THRESHOLD',
        payload: '{"s":3}',
      }),
    );
    // tenant-specific rule should not appear
    await saveAndPublish(
      store,
      makeInput({
        id: 'private-1',
        scope: 'tenant-specific',
        model: 'COMPOSITE',
        payload: '{"p":1}',
      }),
    );

    const westAfrica = await store.listSharedRules('WEST_AFRICA');
    expect(westAfrica).toHaveLength(2);
    const ids = westAfrica.map((r) => r.id).sort();
    expect(ids).toEqual(['shared-1', 'shared-2']);

    const westAfricaFlat = await store.listSharedRules('WEST_AFRICA', 'FLAT_RATE');
    expect(westAfricaFlat).toHaveLength(1);
    expect(westAfricaFlat[0]!.id).toBe('shared-1');

    const eastAfrica = await store.listSharedRules('EAST_AFRICA');
    expect(eastAfrica).toHaveLength(1);
    expect(eastAfrica[0]!.id).toBe('shared-3');
  });

  it('listSharedRules: draft shared rules are not returned', async () => {
    await store.saveRule(makeInput({ id: 'shared-draft', scope: 'shared', region: 'WEST_AFRICA' }));
    const results = await store.listSharedRules('WEST_AFRICA');
    expect(results).toHaveLength(0);
  });

  // ─── recordAuditEvent and getAuditTrail ───────────────────────────────────

  it('recordAuditEvent and getAuditTrail: append-only audit trail', async () => {
    const event1: RuleAuditEvent = {
      id: 'evt-1',
      ruleId: 'audit-rule',
      version: 1,
      tenantId: 'T1',
      type: 'rule.created',
      actor: 'test-user',
      recordedAt: new Date().toISOString(),
    };

    const event2: RuleAuditEvent = {
      id: 'evt-2',
      ruleId: 'audit-rule',
      version: 1,
      tenantId: 'T1',
      type: 'rule.submitted_for_review',
      actor: 'test-user',
      reason: 'Ready for review',
      recordedAt: new Date().toISOString(),
    };

    const event3: RuleAuditEvent = {
      id: 'evt-3',
      ruleId: 'audit-rule',
      version: 1,
      tenantId: 'T1',
      type: 'rule.published',
      actor: 'admin',
      recordedAt: new Date().toISOString(),
    };

    await store.recordAuditEvent(event1);
    await store.recordAuditEvent(event2);
    await store.recordAuditEvent(event3);

    const trail = await store.getAuditTrail('audit-rule');
    expect(trail).toHaveLength(3);
    expect(trail[0]!.type).toBe('rule.created');
    expect(trail[1]!.type).toBe('rule.submitted_for_review');
    expect(trail[2]!.type).toBe('rule.published');

    // Append-only: trail is a copy, not a reference
    trail.push(event1);
    const trailAgain = await store.getAuditTrail('audit-rule');
    expect(trailAgain).toHaveLength(3);
  });

  it('getAuditTrail: returns empty array for unknown ruleId', async () => {
    const trail = await store.getAuditTrail('nonexistent');
    expect(trail).toEqual([]);
  });

  // ─── updateRuleStatus: non-existent rule ──────────────────────────────────

  it('updateRuleStatus: non-existent rule throws RuleNotFoundError', async () => {
    await expect(store.updateRuleStatus('ghost-rule', 1, 'review', 'test-user')).rejects.toThrow(
      RuleNotFoundError,
    );
  });

  // ─── publishRule: non-existent rule ───────────────────────────────────────

  it('publishRule: non-existent rule throws RuleNotFoundError', async () => {
    await expect(store.publishRule('ghost-rule', 1, 'test-user')).rejects.toThrow(
      RuleNotFoundError,
    );
  });
});
