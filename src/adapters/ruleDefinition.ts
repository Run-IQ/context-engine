import { validateRuleDefinition } from '@run-iq/spec';
import type { RuleDefinitionInput } from '@run-iq/spec';
import { ContextValidationError } from '../errors.js';
import type { RuleInput } from '../stores/RuleStore.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * End of the window of a `RuleInput`: absent, `null` and `''` all mean no end (`null`).
 * rule-registry's validator accepts `''` for an open-ended rule.
 */
export function effectiveUntilOf(input: RuleInput): string | null {
  const until = input.effectiveUntil;
  return until == null || until === '' ? null : until;
}

/**
 * Country column of a rule: `RuleInput.country` when given, else the definition's
 * `dimensions.country`, so the column and the definition agree.
 */
export function countryOf(input: RuleInput, definition: RuleDefinitionInput): string | undefined {
  if (input.country !== undefined) return input.country;
  const country = definition.dimensions?.['country'];
  return typeof country === 'string' ? country : undefined;
}

/**
 * The rule definition a store saves for `input` under `id` and `version`, without validating it.
 *
 * - `input.payload` is parsed: it must be a JSON object.
 * - `id`, `version`, `model` and the dates (`effectiveFrom`, `effectiveUntil`; absent, `null` or
 *   `''` meaning no end) always come from the store and the `RuleInput`, never the payload;
 *   `priority` and `tags` come from the `RuleInput` when it gives them, else from the payload
 *   (`priority` defaults to 0).
 * - `input.country` is copied into `dimensions.country` when the payload has no country
 *   dimension. A different `dimensions.country` is kept as is: `buildRuleDefinition` refuses it.
 *   `region` stays outside the definition.
 *
 * Throws `ContextValidationError`, naming the rule, only when the payload is not a JSON object.
 * Use it to check a candidate exactly as the store will see it (rule-registry does).
 */
export function ruleDefinitionOf(
  input: RuleInput,
  id: string,
  version: number,
): RuleDefinitionInput {
  const name = `${id}@${version}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.payload);
  } catch (error) {
    throw new ContextValidationError(
      `Rule ${name}: payload is not valid JSON (${messageOf(error)})`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new ContextValidationError(`Rule ${name}: payload must be a JSON object`);
  }

  const definition: Record<string, unknown> = {
    ...parsed,
    id,
    version,
    model: input.model,
    effectiveFrom: input.effectiveFrom,
    effectiveUntil: effectiveUntilOf(input),
  };
  if (input.priority !== undefined) definition['priority'] = input.priority;
  else if (definition['priority'] == null) definition['priority'] = 0;
  if (input.tags !== undefined) definition['tags'] = [...input.tags];
  if (input.country !== undefined) {
    const dimensions = definition['dimensions'];
    if (dimensions == null) definition['dimensions'] = { country: input.country };
    else if (isPlainObject(dimensions) && dimensions['country'] == null) {
      definition['dimensions'] = { ...dimensions, country: input.country };
    }
  }
  return definition as RuleDefinitionInput;
}

/**
 * Builds the rule definition a store saves for `input` under `id` and `version`
 * (`ruleDefinitionOf`), and checks it.
 *
 * Throws `ContextValidationError`, naming the rule, when the payload is not a JSON object,
 * when `input.country` and `dimensions.country` differ, or when the definition fails
 * `validateRuleDefinition`.
 */
export function buildRuleDefinition(
  input: RuleInput,
  id: string,
  version: number,
): RuleDefinitionInput {
  const name = `${id}@${version}`;
  const definition = ruleDefinitionOf(input, id, version);
  const country = definition.dimensions?.['country'];
  if (input.country !== undefined && country != null && country !== input.country) {
    throw new ContextValidationError(
      `Rule ${name}: RuleInput.country "${input.country}" differs from the payload's ` +
        `dimensions.country "${String(country)}"`,
    );
  }

  const { valid, errors } = validateRuleDefinition(definition);
  if (!valid) {
    const hint = errors.some((e) => e.startsWith('effectiveUntil must be after effectiveFrom'))
      ? ' (the window is [effectiveFrom, effectiveUntil): effectiveUntil is excluded, so a one-day rule ends the next day)'
      : '';
    throw new ContextValidationError(
      `Rule ${name}: invalid definition: ${errors.join('; ')}${hint}`,
    );
  }
  return definition;
}
