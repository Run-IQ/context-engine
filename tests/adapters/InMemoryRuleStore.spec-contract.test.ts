import { describe, it, expect } from 'vitest';
import {
  canonicalize,
  computeRuleChecksum,
  computeRuleFingerprint,
  fromStoredRecord,
} from '@run-iq/spec';
import { InMemoryRuleStore } from '../../src/adapters/InMemoryRuleStore';
import { ContextValidationError } from '../../src/errors';
import type { RuleInput, SerializedRule } from '../../src/stores/RuleStore';

const makeInput = (overrides: Partial<RuleInput> = {}): RuleInput => ({
  model: 'FLAT_RATE',
  tenantId: 'T1',
  scope: 'tenant-specific',
  effectiveFrom: '2025-01-01',
  payload: JSON.stringify({ params: { rate: 0.18, base: 'revenue' } }),
  createdBy: 'test-user',
  ...overrides,
});

async function saveAndPublish(store: InMemoryRuleStore, input: RuleInput): Promise<SerializedRule> {
  const saved = await store.saveRule(input);
  await store.updateRuleStatus(saved.id, saved.version, 'review', 'test-user');
  const { published } = await store.publishRule(saved.id, saved.version, 'test-user');
  return published;
}

describe('InMemoryRuleStore — @run-iq/spec contract', () => {
  it('stores a canonical definition that fromStoredRecord accepts', async () => {
    const store = new InMemoryRuleStore();
    await saveAndPublish(
      store,
      makeInput({
        id: 'tva',
        priority: 5,
        tags: ['tva', 'fiscal', 'tva'],
        effectiveUntil: '2025-12-31',
      }),
    );

    const [record] = await store.resolveRules({ tenantId: 'T1', effectiveDate: '2025-06-01' });
    expect(record).toBeDefined();
    const rule = fromStoredRecord(record!);
    expect(record!.checksum).toBe(computeRuleChecksum(JSON.parse(record!.payload)));
    expect(rule.id).toBe('tva');
    expect(rule.version).toBe(1);
    expect(rule.model).toBe('FLAT_RATE');
    expect(rule.priority).toBe(5);
    expect(rule.tags).toEqual(['fiscal', 'tva']);
    expect(rule.params).toEqual({ rate: 0.18, base: 'revenue' });
    expect(rule.effectiveFrom.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    expect(rule.effectiveUntil!.toISOString()).toBe('2025-12-31T00:00:00.000Z');
  });

  it('keeps the store columns as received (YYYY-MM-DD dates)', async () => {
    const store = new InMemoryRuleStore();
    const saved = await store.saveRule(
      makeInput({ id: 'cols', effectiveFrom: '2025-01-01', effectiveUntil: '2025-12-31' }),
    );
    expect(saved.effectiveFrom).toBe('2025-01-01');
    expect(saved.effectiveUntil).toBe('2025-12-31');
    const payload = JSON.parse(saved.payload) as Record<string, unknown>;
    expect(payload['effectiveFrom']).toBe('2025-01-01T00:00:00.000Z');
    expect(payload['effectiveUntil']).toBe('2025-12-31T00:00:00.000Z');
    expect(saved.payload).toBe(canonicalize(payload));
  });

  it('the RuleInput fields take precedence over the payload', async () => {
    const store = new InMemoryRuleStore();
    const saved = await store.saveRule(
      makeInput({
        id: 'prec',
        model: 'FLAT_RATE',
        priority: 3,
        tags: ['a'],
        effectiveFrom: '2025-01-01',
        payload: JSON.stringify({
          id: 'other',
          version: 9,
          model: 'BRACKET',
          priority: 99,
          tags: ['z'],
          effectiveFrom: '2020-01-01',
          effectiveUntil: '2021-01-01',
          params: { rate: 0.1 },
        }),
      }),
    );
    const rule = fromStoredRecord(saved);
    expect(rule.id).toBe('prec');
    expect(rule.version).toBe(1);
    expect(rule.model).toBe('FLAT_RATE');
    expect(rule.priority).toBe(3);
    expect(rule.tags).toEqual(['a']);
    expect(rule.effectiveFrom.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    expect(rule.effectiveUntil).toBeNull();
  });

  it('includes a store-generated id and version in the payload and checksum', async () => {
    const store = new InMemoryRuleStore();
    const v1 = await store.saveRule(makeInput());
    const v2 = await store.saveRule(makeInput({ id: v1.id }));
    expect(fromStoredRecord(v1).id).toBe(v1.id);
    expect(fromStoredRecord(v2).version).toBe(2);
    expect(v1.checksum).not.toBe(v2.checksum);
  });

  it('copies RuleInput.country into dimensions.country when absent', async () => {
    const store = new InMemoryRuleStore();
    const withCountry = await store.saveRule(makeInput({ id: 'c1', country: 'TG' }));
    expect(fromStoredRecord(withCountry).dimensions).toEqual({ country: 'TG' });
    expect(withCountry.country).toBe('TG');

    const explicit = await store.saveRule(
      makeInput({
        id: 'c2',
        country: 'TG',
        payload: JSON.stringify({ params: {}, dimensions: { country: 'SN', sector: 'retail' } }),
      }),
    );
    expect(fromStoredRecord(explicit).dimensions).toEqual({ country: 'SN', sector: 'retail' });

    const noCountry = await store.saveRule(makeInput({ id: 'c3', region: 'UEMOA' }));
    expect(fromStoredRecord(noCountry).dimensions).toEqual({});
  });

  it('same id and version with dates written differently give the same checksum', async () => {
    const a = await new InMemoryRuleStore().saveRule(
      makeInput({ id: 'same', effectiveFrom: '2025-01-01', effectiveUntil: '2026-01-01' }),
    );
    const b = await new InMemoryRuleStore().saveRule(
      makeInput({
        id: 'same',
        effectiveFrom: '2025-01-01T00:00:00Z',
        effectiveUntil: '2026-01-01T01:00:00+01:00',
      }),
    );
    expect(a.version).toBe(b.version);
    expect(a.checksum).toBe(b.checksum);
    expect(computeRuleChecksum(JSON.parse(a.payload))).toBe(
      computeRuleChecksum(JSON.parse(b.payload)),
    );
  });

  it('detects a duplicate (other id and dates, same content) through the fingerprint', async () => {
    const store = new InMemoryRuleStore();
    const existing = await saveAndPublish(
      store,
      makeInput({ id: 'dup-a', effectiveFrom: '2025-01-01', tags: ['x', 'y'] }),
    );
    const candidate = makeInput({
      id: 'dup-b',
      effectiveFrom: '2025-06-01',
      effectiveUntil: '2026-01-01',
      tags: ['y', 'x', 'y'],
      payload: JSON.stringify({ params: { base: 'revenue', rate: 0.18 } }),
    });

    const conflicts = await store.detectConflicts(candidate);
    const dup = conflicts.find((c) => c.conflictType === 'duplicate_checksum');
    expect(dup).toBeDefined();
    expect(dup!.existingRuleId).toBe('dup-a');
    expect(dup!.severity).toBe('critical');
    expect(computeRuleFingerprint(JSON.parse(existing.payload))).toBe(
      computeRuleFingerprint({
        id: 'dup-b',
        version: 1,
        model: 'FLAT_RATE',
        priority: 0,
        effectiveFrom: '2025-06-01',
        tags: ['x', 'y'],
        params: { rate: 0.18, base: 'revenue' },
      }),
    );
  });

  it('a different content is not a duplicate', async () => {
    const store = new InMemoryRuleStore();
    await saveAndPublish(store, makeInput({ id: 'dup-a' }));
    const conflicts = await store.detectConflicts(
      makeInput({ id: 'dup-b', payload: JSON.stringify({ params: { rate: 0.2 } }) }),
    );
    expect(conflicts.map((c) => c.conflictType)).toEqual(['same_priority']);
  });

  it('a different country is not a duplicate (it enters the definition)', async () => {
    const store = new InMemoryRuleStore();
    await saveAndPublish(store, makeInput({ id: 'dup-a' }));
    const conflicts = await store.detectConflicts(makeInput({ id: 'dup-b', country: 'TG' }));
    // The store filter already skips rules whose country column differs.
    expect(conflicts).toEqual([]);
  });

  it.each([
    ['not JSON', 'not-json-at-all{{{'],
    ['not an object', '[1, 2]'],
    ['without params', JSON.stringify({ model: 'TAX' })],
    ['an empty object', '{}'],
    ['a non-string dimension', JSON.stringify({ params: {}, dimensions: { a: 1 } })],
  ])('saveRule refuses a payload that is %s with ContextValidationError', async (_, payload) => {
    const store = new InMemoryRuleStore();
    const save = store.saveRule(makeInput({ id: 'bad-rule', payload }));
    await expect(save).rejects.toThrow(ContextValidationError);
    await expect(save).rejects.toThrow(/bad-rule/);
    expect(await store.getRule('bad-rule')).toBeNull();
  });

  it('saveRule refuses an empty validity window', async () => {
    const store = new InMemoryRuleStore();
    await expect(
      store.saveRule(
        makeInput({ id: 'empty', effectiveFrom: '2025-06-01', effectiveUntil: '2025-06-01' }),
      ),
    ).rejects.toThrow(ContextValidationError);
  });

  it('detectConflicts refuses an invalid candidate payload', async () => {
    const store = new InMemoryRuleStore();
    await expect(store.detectConflicts(makeInput({ payload: '{}' }))).rejects.toThrow(
      ContextValidationError,
    );
  });
});
