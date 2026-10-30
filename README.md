# @run-iq/context-engine

The shared state and storage contracts for Run-IQ. It provides `EvaluationContext`, an append-only store for the values produced during one execution, and the interfaces (`RuleStore`, `GraphStore`, `ExecutionStore`) that a host implements to plug in its own database.

It is used by [`@run-iq/dg`](https://github.com/Run-IQ/decision-graph), whose nodes read and write their outputs through the context, and by [`@run-iq/rule-registry`](https://github.com/Run-IQ/rule-registry), which manages rules on top of a `RuleStore`. In-memory implementations of every store are included for tests and prototypes.

## Install

```bash
npm install @run-iq/context-engine@next
```

The 1.0 line, built on the rule contract of [`@run-iq/spec`](https://github.com/Run-IQ/spec), is published under the `next` tag. Requires Node.js 20 or later.

## Example

```ts
import { EvaluationContext } from '@run-iq/context-engine';

const ctx = new EvaluationContext(
  { orderTotal: 200 },
  { requestId: 'order-42', tenantId: 'acme', timestamp: new Date().toISOString() },
  { limits: { maxTotalSizeKb: 512 } },
);

ctx.get('input.orderTotal');    // 200
ctx.set('shipping', 'fee', 10); // stored under "shipping.fee"
ctx.get('shipping.fee');        // 10
ctx.getNodeOutputs('shipping'); // { fee: 10 }
ctx.snapshot('after-shipping'); // frozen copy of the current state

ctx.set('shipping', 'fee', 12); // throws ContextConflictError
```

## EvaluationContext

- Input values are frozen and readable under `input.<key>`.
- `set(nodeId, portName, value)` writes `nodeId.portName`. Each key can be written once; writing it again throws `ContextConflictError`. Identifiers must match `/^[a-zA-Z0-9_-]+$/`, and `input`, `__internal` and `__meta` are reserved.
- Stored values are deep-cloned and frozen, so they cannot be changed after the fact.
- `setRaw(nodeId, raw)` keeps a node's raw output. Its fields can be read with `get('nodeId.__raw.some.path')`.
- `snapshot(label?)` records the full state; `getSnapshots()` returns all of them.
- `getFullState()`, `has(key)`, `sizeKb()` and `entryCount()` inspect the context.

Options passed as the third argument:

| Option | |
|---|---|
| `limits.maxValueSizeKb` | Maximum size of one value |
| `limits.maxTotalSizeKb` | Maximum size of the whole context |
| `limits.maxEntries` | Maximum number of keys |
| `limits.allowRawOverwrite` | Set to `false` to make `setRaw` append-only too |
| `hooks` | `beforeSet`, `afterSet`, `beforeGet`, `afterGet`, `onError` |

Exceeding a limit throws `ContextLimitError`. No limit is applied by default.

## Storage contracts

| Interface | Stores |
|---|---|
| `RuleStore` | Versioned rules, their status (`draft`, `review`, `published`, `deprecated`, `archived`), audit trail and conflict detection |
| `GraphStore` | Decision graph definitions and their compiled form |
| `ExecutionStore` | Execution records, events, snapshots and summaries |
| `PersistenceAdapter` | `{ rules?, graphs?, executions? }` |

To use your own database, implement these interfaces. For tests, `createInMemoryAdapter()` returns an adapter backed by `InMemoryRuleStore`, `InMemoryGraphStore` and `InMemoryExecutionStore` (also available from `@run-iq/context-engine/adapters`).

```ts
import { createInMemoryAdapter } from '@run-iq/context-engine';

const { rules } = createInMemoryAdapter();

const rule = await rules.saveRule({
  id: 'shipping-fee',
  model: 'PERCENTAGE',
  tenantId: 'acme',
  scope: 'tenant-specific',
  effectiveFrom: '2025-01-01',
  payload: JSON.stringify({ params: { base: 'orderTotal', rate: 0.05 } }),
  createdBy: 'alice',
});
await rules.updateRuleStatus('shipping-fee', rule.version, 'review', 'alice');
await rules.publishRule('shipping-fee', rule.version, 'bob');

await rules.resolveRules({ tenantId: 'acme', effectiveDate: '2025-06-01' });
// [{ id: 'shipping-fee', version: 1, status: 'published', ... }]
```

`resolveRules` returns only published rules in force at the given date, sorted by priority. A rule is either `tenant-specific` or `shared` across tenants, and can carry an optional `country` and `region` that queries filter on. The in-memory store does not write audit events itself; `@run-iq/rule-registry` does that.

## Stored rules

`saveRule` stores the payload as the canonical rule definition of `@run-iq/spec`. The definition is the payload overridden by the rule's `id`, `version`, `model` and dates, and by `priority` and `tags` when the input gives them. `country` is copied into `dimensions.country`. The stored `checksum` is the sha256 of that payload, the value `@run-iq/core` checks. `fromStoredRecord`, re-exported from spec, turns a stored rule back into a rule core can evaluate:

```ts
import { fromStoredRecord } from '@run-iq/context-engine';

const stored = await rules.getRule('shipping-fee', 1);
const executable = fromStoredRecord(stored);
executable.effectiveFrom; // Date 2025-01-01T00:00:00.000Z
executable.checksum === stored.checksum; // true
```

- A payload that is not a JSON object, or that spec's `validateRuleDefinition` refuses (for example without `params`), throws `ContextValidationError`. So does a `country` that differs from the payload's `dimensions.country`.
- `ruleDefinitionOf(input, id, version)` builds the definition without saving it.
- The `effectiveFrom` and `effectiveUntil` columns keep the `YYYY-MM-DD` values you give; only the payload holds full ISO dates. `effectiveUntil` must be after `effectiveFrom`, because spec's validity window is `[effectiveFrom, effectiveUntil)`: a one-day rule ends the next day.
- `resolveRules` still compares the columns with `effectiveUntil` inclusive. It moves to spec's window in a later release.
- `detectConflicts(candidate)` reports a `duplicate_checksum` conflict when a published rule has the same content as the candidate. Content is compared with `computeRuleFingerprint` of spec, which leaves out `id`, `version` and dates, so the same rule under another id or period is caught however its JSON is written.

## License

MIT License. See [LICENSE](LICENSE).
