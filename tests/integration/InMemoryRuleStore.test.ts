import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryRuleStore } from '../../src/adapters/InMemoryRuleStore';
import type { RuleInput, SerializedRule } from '../../src/stores/RuleStore';

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

describe('InMemoryRuleStore', () => {
  let store: InMemoryRuleStore;

  beforeEach(() => {
    store = new InMemoryRuleStore();
  });

  it('saveRule then getRule returns the created rule', async () => {
    const input = makeInput({ id: 'rule-1' });
    const saved = await store.saveRule(input);
    const result = await store.getRule(saved.id, saved.version);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(saved.id);
    expect(result!.model).toBe(input.model);
    expect(result!.tenantId).toBe(input.tenantId);
    expect(result!.scope).toBe(input.scope);
    expect(result!.status).toBe('draft');
    expect(result!.effectiveFrom).toBe(input.effectiveFrom);
    expect(result!.payload).toBe(input.payload);
    expect(result!.createdBy).toBe(input.createdBy);
  });

  it('getRule without version returns the most recent version', async () => {
    const saved1 = await store.saveRule(makeInput({ id: 'rule-1' }));
    const saved2 = await store.saveRule(makeInput({ id: 'rule-1' }));
    expect(saved2.version).toBe(2);
    const result = await store.getRule(saved1.id);
    expect(result!.version).toBe(2);
  });

  it('getRule with non-existent ruleId returns null', async () => {
    const result = await store.getRule('nonexistent');
    expect(result).toBeNull();
  });

  it('resolveRules filters by tenantId (strict isolation)', async () => {
    await saveAndPublish(store, makeInput({ id: 'rule-1', tenantId: 'T1' }));
    await saveAndPublish(store, makeInput({ id: 'rule-2', tenantId: 'T2' }));
    const results = await store.resolveRules({ tenantId: 'T1' });
    expect(results).toHaveLength(1);
    expect(results[0]!.tenantId).toBe('T1');
  });

  it('resolveRules filters by model', async () => {
    await saveAndPublish(store, makeInput({ id: 'rule-1', model: 'FLAT_RATE' }));
    await saveAndPublish(store, makeInput({ id: 'rule-2', model: 'BRACKET' }));
    const results = await store.resolveRules({ tenantId: 'T1', model: 'BRACKET' });
    expect(results).toHaveLength(1);
    expect(results[0]!.model).toBe('BRACKET');
  });

  it('resolveRules filters by country via country field', async () => {
    await saveAndPublish(store, makeInput({ id: 'rule-1', country: 'TG' }));
    await saveAndPublish(store, makeInput({ id: 'rule-2', country: 'SN' }));
    const results = await store.resolveRules({ tenantId: 'T1', country: 'TG' });
    expect(results).toHaveLength(1);
    expect(results[0]!.country).toBe('TG');
  });

  it('resolveRules filters by effectiveDate — excludes future rules', async () => {
    await saveAndPublish(store, makeInput({ id: 'rule-1', effectiveFrom: '2030-01-01' }));
    const results = await store.resolveRules({
      tenantId: 'T1',
      effectiveDate: '2025-06-01',
    });
    expect(results).toHaveLength(0);
  });

  it('resolveRules excludes expired rules', async () => {
    await saveAndPublish(
      store,
      makeInput({ id: 'rule-1', effectiveFrom: '2020-01-01', effectiveUntil: '2020-12-31' }),
    );
    const results = await store.resolveRules({
      tenantId: 'T1',
      effectiveDate: '2025-06-01',
    });
    expect(results).toHaveLength(0);
  });

  it('resolveRules includes rules within effective date range', async () => {
    await saveAndPublish(
      store,
      makeInput({ id: 'rule-1', effectiveFrom: '2025-01-01', effectiveUntil: '2025-12-31' }),
    );
    const results = await store.resolveRules({
      tenantId: 'T1',
      effectiveDate: '2025-06-01',
    });
    expect(results).toHaveLength(1);
  });

  it('fingerprint is deterministic — same query produces same hash', () => {
    const query = { tenantId: 'T1', model: 'FLAT_RATE', effectiveDate: '2025-01-01' };
    expect(store.fingerprint(query)).toBe(store.fingerprint(query));
  });

  it('fingerprint differs when model changes', () => {
    const q1 = { tenantId: 'T1', model: 'FLAT_RATE' };
    const q2 = { tenantId: 'T1', model: 'BRACKET' };
    expect(store.fingerprint(q1)).not.toBe(store.fingerprint(q2));
  });

  it('fingerprint differs when effectiveDate changes', () => {
    const q1 = { tenantId: 'T1', effectiveDate: '2025-01-01' };
    const q2 = { tenantId: 'T1', effectiveDate: '2025-06-01' };
    expect(store.fingerprint(q1)).not.toBe(store.fingerprint(q2));
  });

  it('listRules filters by tenantId and model', async () => {
    await store.saveRule(makeInput({ id: 'rule-1', tenantId: 'T1', model: 'FLAT_RATE' }));
    await store.saveRule(makeInput({ id: 'rule-2', tenantId: 'T1', model: 'BRACKET' }));
    await store.saveRule(makeInput({ id: 'rule-3', tenantId: 'T2' }));

    const results = await store.listRules({ tenantId: 'T1', model: 'FLAT_RATE' });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('rule-1');
  });
});
