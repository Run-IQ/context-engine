import { describe, it, expect } from 'vitest';
import { ContextValidationError, InMemoryRuleStore, ruleDefinitionOf } from '../../src/index.js';
import type { RuleInput } from '../../src/index.js';

function input(overrides?: Partial<RuleInput>): RuleInput {
  return {
    model: 'FLAT_RATE',
    tenantId: 't1',
    scope: 'tenant-specific',
    effectiveFrom: '2025-01-01',
    payload: JSON.stringify({ model: 'OTHER', params: { rate: 0.18 }, priority: 3, tags: ['p'] }),
    createdBy: 'alice',
    ...overrides,
  };
}

describe('ruleDefinitionOf', () => {
  it('merges the payload with the id, version, model and dates of the RuleInput', () => {
    expect(ruleDefinitionOf(input({ effectiveUntil: '' }), 'r1', 4)).toEqual({
      id: 'r1',
      version: 4,
      model: 'FLAT_RATE',
      params: { rate: 0.18 },
      priority: 3,
      tags: ['p'],
      effectiveFrom: '2025-01-01',
      effectiveUntil: null,
    });
  });

  it('takes priority and tags from the RuleInput when given, priority defaulting to 0', () => {
    const def = ruleDefinitionOf(input({ priority: 9, tags: ['a'] }), 'r1', 1);
    expect(def.priority).toBe(9);
    expect(def.tags).toEqual(['a']);
    const noPriority = ruleDefinitionOf(input({ payload: '{"params":{}}' }), 'r1', 1);
    expect(noPriority.priority).toBe(0);
  });

  it('copies the country into dimensions when the payload has none', () => {
    const def = ruleDefinitionOf(
      input({ country: 'TG', payload: '{"params":{},"dimensions":{"sector":"retail"}}' }),
      'r1',
      1,
    );
    expect(def.dimensions).toEqual({ sector: 'retail', country: 'TG' });
  });

  it('does not validate: an invalid definition is returned as built', () => {
    const def = ruleDefinitionOf(input({ payload: '{"model":"FLAT_RATE"}' }), 'r1', 1);
    expect(def.params).toBeUndefined();
    const mismatch = ruleDefinitionOf(
      input({ country: 'TG', payload: '{"params":{},"dimensions":{"country":"BJ"}}' }),
      'r1',
      1,
    );
    expect(mismatch.dimensions).toEqual({ country: 'BJ' });
  });

  it('throws ContextValidationError when the payload is not a JSON object', () => {
    expect(() => ruleDefinitionOf(input({ payload: '{bad' }), 'r1', 1)).toThrow(
      ContextValidationError,
    );
    expect(() => ruleDefinitionOf(input({ payload: '[]' }), 'r1', 1)).toThrow(
      ContextValidationError,
    );
  });

  it('is the definition saveRule stores', async () => {
    const store = new InMemoryRuleStore();
    const saved = await store.saveRule(input({ id: 'r1', country: 'TG' }));
    const stored = JSON.parse(saved.payload) as Record<string, unknown>;
    const built = ruleDefinitionOf(input({ id: 'r1', country: 'TG' }), 'r1', 1);
    expect(stored['params']).toEqual(built.params);
    expect(stored['dimensions']).toEqual(built.dimensions);
    expect(stored['priority']).toBe(built.priority);
  });
});
