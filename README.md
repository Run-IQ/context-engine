# @run-iq/context-engine

Shared execution context, persistence contracts, and in-memory adapters for the Run-IQ ecosystem.

## What it does

Context Engine is the **state backbone** of Run-IQ. Every evaluation — whether a single rule calculation or a multi-graph orchestration — runs inside an `EvaluationContext` that tracks inputs, outputs, metadata, and lifecycle events.

It also defines the **persistence contracts** (store interfaces) that hosts implement to plug in their own database.

## Install

```bash
npm install @run-iq/context-engine
```

## Core concepts

### EvaluationContext

Immutable execution container. Holds input data, metadata, and accumulated state. Supports snapshots, limits, and lifecycle hooks.

```typescript
import { EvaluationContext } from '@run-iq/context-engine';

const ctx = new EvaluationContext(
  { income: 5_000_000, taxType: 'IRPP' },       // input data
  { requestId: 'req-1', tenantId: 't-1', timestamp: new Date().toISOString() },
  { limits: { maxStateSizeKb: 512 } },
);

ctx.set('irpp', 425_000);
ctx.get('irpp');               // 425000
ctx.snapshot('after-irpp');    // frozen point-in-time copy
```

### Persistence contracts

Context Engine defines store interfaces — the host provides implementations.

| Interface | Purpose |
|---|---|
| `RuleStore` | CRUD + versioning + audit for rules |
| `GraphStore` | Storage for decision graph definitions |
| `ExecutionStore` | Execution history and event log |
| `PersistenceAdapter` | Bundles all three stores |

```typescript
import type { RuleStore, PersistenceAdapter } from '@run-iq/context-engine';

// Host implements against their database
class PostgresRuleStore implements RuleStore {
  async getRule(id, version?) { /* SELECT FROM rules ... */ }
  async saveRule(rule)        { /* INSERT INTO rules ... */ }
  // ...
}

// Bundle into adapter
const adapter: PersistenceAdapter = {
  rules: new PostgresRuleStore(db),
  graphs: new PostgresGraphStore(db),
  executions: new PostgresExecutionStore(db),
};
```

### In-memory adapters (testing)

```typescript
import { createInMemoryAdapter } from '@run-iq/context-engine';

const adapter = createInMemoryAdapter();
// Ready to use — no database required
```

## API surface

| Export | Kind | Description |
|---|---|---|
| `EvaluationContext` | class | Core execution context |
| `ExecutionMeta` | type | Request metadata (requestId, tenantId, timestamp) |
| `RuleStore` | type | Rule persistence contract |
| `GraphStore` | type | Graph persistence contract |
| `ExecutionStore` | type | Execution log persistence contract |
| `PersistenceAdapter` | type | Bundles all stores |
| `InMemoryRuleStore` | class | In-memory rule store for testing |
| `InMemoryGraphStore` | class | In-memory graph store for testing |
| `InMemoryExecutionStore` | class | In-memory execution store for testing |
| `createInMemoryAdapter` | function | Creates a complete in-memory adapter |
| `deepFreeze`, `cloneAndFreeze`, `safeClone` | function | Immutability utilities |
| `sha256` | function | SHA-256 hashing |

## Used by

- `@run-iq/core` — evaluation pipeline context
- `@run-iq/decision-graph` — DGContext extends EvaluationContext
- `@run-iq/rule-registry` — rule lifecycle management

## License

All rights reserved. See LICENSE for details.

---

*Run-IQ implements the PPE specification.*
*github.com/Run-IQ*
