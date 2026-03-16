# `@run-iq/context-engine`
## Architecture Document v1.0

> **Statut** : Référence définitive pour l'implémentation  
> **Version du document** : 1.0.0  
> **Package** : `@run-iq/context-engine`  
> **Dépendances Run-IQ** : **aucune** — ce package est une feuille absolue dans le graphe de dépendances  
> **Consommateurs directs v1** : `@run-iq/dg` uniquement  
> **Consommateurs futurs** : `@run-iq/server`, `@run-iq/mcp-server`, `@run-iq/core`

---

## Table des matières

1. [Pourquoi ce module existe](#1-pourquoi-ce-module-existe)
2. [Ce que le Context Engine n'est pas](#2-ce-que-le-context-engine-nest-pas)
3. [Principe fondamental : la colonne vertébrale](#3-principe-fondamental--la-colonne-vertébrale)
4. [Position dans l'écosystème Run-IQ](#4-position-dans-lécosystème-run-iq)
5. [Vue d'ensemble des composants](#5-vue-densemble-des-composants)
6. [EvaluationContext — le cœur](#6-evaluationcontext--le-cœur)
7. [Namespace & convention de clés](#7-namespace--convention-de-clés)
8. [ExecutionMeta](#8-executionmeta)
9. [ContextLimits & protection mémoire](#9-contextlimits--protection-mémoire)
10. [ContextSnapshot](#10-contextsnapshot)
11. [ContextLifecycleHooks](#11-contextlifecyclehooks)
12. [PersistenceAdapter](#12-persistenceadapter)
13. [GraphStore](#13-graphstore)
14. [RuleStore](#14-rulestore)
15. [ExecutionStore](#15-executionstore)
16. [Implémentations InMemory](#16-implémentations-inmemory)
17. [Erreurs](#17-erreurs)
18. [Utilitaires internes](#18-utilitaires-internes)
19. [Roadmap d'évolution](#19-roadmap-dévolution)
20. [Structure du package](#20-structure-du-package)
21. [Contrats de test](#21-contrats-de-test)

---

## 1. Pourquoi ce module existe

### Le problème sans ce module

Sans `@run-iq/context-engine`, la gestion du contexte d'exécution vit entièrement dans `@run-iq/dg`. Cela crée plusieurs problèmes structurels majeurs qui deviennent irréparables à mesure que l'écosystème grandit.

**Couplage forcé** : tout composant qui veut lire ou écrire dans un contexte d'exécution doit dépendre de `@run-iq/dg` entier. Le `server` qui expose `/execution/:id/state`, le `mcp-server` qui interroge un contexte en live pour un LLM, un futur plugin qui lit le contexte global — tous dépendraient d'un package d'orchestration qui ne les concerne pas.

**Impossible de faire évoluer le contexte sans risquer le DG** : ajouter des snapshots persistants, un système de providers lazy, ou un adapter Redis implique de modifier `@run-iq/dg`, de le re-tester entièrement, et de risquer des régressions dans l'orchestrateur alors qu'on n'a touché qu'au stockage de données.

**Pas de réutilisabilité** : si `@run-iq/core` veut un jour son propre contexte d'exécution léger pour auditer les évaluations de règles, il faudrait soit dépendre du DG (absurde architecturalement), soit réécrire la même logique de namespace, de limits et de snapshots.

**Les contrats de persistance n'ont nulle part où vivre** : `GraphStore`, `RuleStore`, `ExecutionStore` — ces interfaces sont utilisées par le `server`, le `dg`, et l'application host. Elles ne peuvent pas appartenir à un seul de ces packages sans créer des dépendances circulaires.

### La solution

`@run-iq/context-engine` est un **package autonome, zéro dépendance Run-IQ**, qui encapsule :

- Le conteneur de données d'exécution (`EvaluationContext`) avec namespace strict et append-only enforced
- Les contrats de persistance (`GraphStore`, `RuleStore`, `ExecutionStore`) que toute l'architecture partage
- Les implémentations in-memory de référence pour le développement et les tests
- Les hooks d'observation du cycle de vie du contexte

Le DG étend `EvaluationContext` pour y ajouter sa plomberie spécifique (event log, streaming, buildResult). Le contexte évolue sans toucher au DG. Le DG évolue sans toucher au contexte.

### L'argument décisif

Aujourd'hui, seul le DG utilise ce package. La séparation pourrait sembler prématurée. Elle ne l'est pas — pour une raison simple : **le contexte est la colonne vertébrale, et une colonne vertébrale ne peut pas appartenir à un organe**.

Toutes les données d'exécution passent par `EvaluationContext`. C'est vrai aujourd'hui, ça sera encore plus vrai demain. Si ce module n'existe pas en tant qu'entité autonome dès le début, chaque nouveau consommateur force une refonte.

---

## 2. Ce que le Context Engine n'est pas

Ces limites sont aussi importantes que le périmètre. Les violer crée un module incontrôlable.

| Ce que le Context Engine ne fait PAS | Qui le fait |
|---|---|
| Orchestrer l'exécution des nœuds du graphe | `@run-iq/dg` — `DGOrchestrator` |
| Exécuter des règles métier | `@run-iq/core` — `PPEEngine` |
| Émettre des events DG (`node.started`, `level.completed`…) | `DGContext` dans `@run-iq/dg` |
| Persister en base de données | L'application host via `PersistenceAdapter` |
| Valider la structure d'un graphe de décision | `DGCompiler` dans `@run-iq/dg` |
| Résoudre les règles d'un nœud | `RuleResolver` / `RuleStore` dans `@run-iq/dg` ou host |
| Décider quoi faire en cas d'erreur d'exécution | `DGOrchestrator` via `NodePolicy` |
| Gérer le parallélisme ou le scheduling | `DGOrchestrator` |

**Le Context Engine fait uniquement** :
1. Stocker et lire des données d'exécution avec un namespace strict et immuable
2. Protéger contre les dépassements mémoire et les abus de taille
3. Produire des snapshots immuables de l'état courant
4. Exposer des hooks d'observation (jamais de mutation)
5. Définir les contrats de persistance que l'écosystème partage
6. Fournir des implémentations in-memory de référence

---

## 3. Principe fondamental : la colonne vertébrale

### Règle cardinale

Toutes les données d'exécution passent par `EvaluationContext`. Jamais de JSON brut qui circule librement entre composants. Jamais d'accès direct à un objet partagé mutable.

```
Input utilisateur
      │
      ▼
EvaluationContext.input     ← immutable (Object.freeze à la création)
      │
      ▼
Nœud A exécuté
→ ctx.set('node_a', 'taxDue', 2000)
→ ctx.set('node_a', 'regime', 'REEL')
      │
      ▼
Nœud B a besoin du résultat de A
→ ctx.get('node_a.taxDue')             → 2000
→ ctx.get('node_a.__raw.breakdown.TVA') → résolution automatique du sous-champ
      │
      ▼
ctx.snapshot('after-level-0')          → ContextSnapshot immuable
      │
      ▼
adapter.executions?.recordSnapshot(snap) → persistance optionnelle
```

### Les 5 invariants

Ces invariants ne souffrent aucune exception. Toute violation est une `ContextError`.

**Invariant 1 — Append-only** : une clé écrite dans le contexte ne peut jamais être écrasée. Si deux nœuds produisent la même clé, c'est un bug de design du graphe, détecté immédiatement par `ContextConflictError`.

**Invariant 2 — Namespace enforced** : toute clé respecte le format `<namespace>.<identifier>`. Aucun accès direct sans préfixe de namespace n'est possible. `set()` reçoit `(nodeId, portName)` et construit la clé — jamais une clé brute.

**Invariant 3 — Input immutable** : les données initiales passées au constructeur sont `Object.freeze`-ées immédiatement. Aucun nœud ne peut modifier les inputs d'une exécution.

**Invariant 4 — Snapshot immuable** : un snapshot est un `Object.freeze` récursif de l'état complet au moment de l'appel. Modifier le contexte après `snapshot()` ne modifie pas les snapshots existants.

**Invariant 5 — Zéro side-effects dans get/set** : `get()` et `set()` n'appellent jamais de DB, d'API externe, ou de code asynchrone. La persistance passe exclusivement par les hooks et le `PersistenceAdapter` — jamais inline.

---

## 4. Position dans l'écosystème Run-IQ

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          Application Host                                 │
│                                                                           │
│   PostgresGraphStore       PostgresRuleStore      PostgresExecutionStore  │
│   RedisGraphStore          RemoteRuleStore        EventStoreExecStore     │
│                                                                           │
│   → implémentent les interfaces de @run-iq/context-engine                │
└─────────────────────────────┬────────────────────────────────────────────┘
                              │ injecte PersistenceAdapter
                              │
┌─────────────────────────────▼────────────────────────────────────────────┐
│                        @run-iq/server                                     │
│                                                                           │
│   expose : POST /graph/compile, /graph/execute, /graph/run                │
│   expose : GET /execution/:id/state   ← lit EvaluationContext directement │
│   cache  : CompiledGraph via GraphStore                                   │
└──────────────┬─────────────────────────┬────────────────────────────────┘
               │                         │
┌──────────────▼──────────┐  ┌───────────▼───────────────────────────────┐
│     @run-iq/dg           │  │         @run-iq/mcp-server                 │
│                          │  │                                             │
│  DGContext               │  │  peut lire EvaluationContext directement    │
│    extends               │  │  pour qu'un LLM interroge un contexte live  │
│  EvaluationContext       │  └────────────────────────────────────────────┘
│                          │
│  + DGEvent log           │
│  + levelSnapshot()       │
│  + buildResult()         │
│  + streaming events      │
└──────────────┬──────────┘
               │ dépend de
┌──────────────▼──────────────────────────────────────────────────────────┐
│                    @run-iq/context-engine                                 │
│                                                                           │
│   EvaluationContext     PersistenceAdapter    ContextLifecycleHooks       │
│   ContextSnapshot       ContextLimits         ExecutionMeta               │
│   GraphStore (if.)      RuleStore (if.)       ExecutionStore (if.)        │
│   InMemoryGraphStore    InMemoryRuleStore      InMemoryExecutionStore      │
│                                                                           │
│   ←── ZÉRO dépendance Run-IQ ──→                                         │
└──────────────────────────────────────────────────────────────────────────┘

Légende : if. = interface seulement, pas d'implémentation concrète DB
```

### Règle de dépendances (non-négociable)

```
@run-iq/context-engine  →  dépend de : rien dans Run-IQ
@run-iq/dg              →  dépend de : @run-iq/context-engine, @run-iq/core
@run-iq/core            →  dépend de : rien dans Run-IQ (pour l'instant)
@run-iq/server          →  dépend de : @run-iq/dg, @run-iq/context-engine
@run-iq/mcp-server      →  dépend de : @run-iq/context-engine (lecture contexte)
Application host        →  implémente : interfaces de @run-iq/context-engine
```

---

## 5. Vue d'ensemble des composants

```
@run-iq/context-engine
│
├── EvaluationContext              — le conteneur principal
│   ├── state: Map<string, unknown>  — append-only, namespace enforced
│   ├── input: Readonly<...>         — immutable
│   ├── snapshots: ContextSnapshot[] — historique immuable
│   ├── set(nodeId, portName, value) — écriture avec validation
│   ├── setRaw(nodeId, raw)          — raw optionnel (non append-only)
│   ├── get(key)                     — lecture avec résolution en cascade
│   ├── getNodeOutputs(nodeId)       — tous les ports d'un nœud
│   ├── getFullState()               — état complet (pour edge conditions)
│   ├── has(key)                     — existence d'une clé
│   └── snapshot(label?)            — photo immuable de l'état
│
├── Types fondamentaux
│   ├── ExecutionMeta              — identité d'une exécution
│   ├── ContextLimits             — protection mémoire
│   ├── ContextLifecycleHooks     — observation (pas de mutation)
│   └── ContextSnapshot           — photo immuable
│
├── PersistenceAdapter             — wrapper optionnel des 3 stores
│   ├── graphs?:     GraphStore    — stocker/récupérer des graphes
│   ├── rules?:      RuleStore     — résoudre des règles
│   └── executions?: ExecutionStore — auditer des exécutions
│
├── Interfaces des stores (contrats seulement)
│   ├── GraphStore                 — versioning des graphes + cache compiled
│   ├── RuleStore                  — résolution des règles par fingerprint
│   └── ExecutionStore             — audit complet event-sourced
│
├── Implémentations InMemory       — fonctionnelles, pas des stubs
│   ├── InMemoryGraphStore
│   ├── InMemoryRuleStore
│   ├── InMemoryExecutionStore
│   └── createInMemoryAdapter()   — factory de convenance
│
├── Erreurs
│   ├── ContextConflictError      — clé déjà présente
│   ├── ContextLimitError         — dépassement mémoire
│   └── ContextValidationError    — identifiant invalide
│
└── Utilitaires
    ├── roughSizeKb(value)        — estimation taille JSON
    ├── sha256(str)               — hash déterministe
    └── getNestedValue(obj, path) — résolution de sous-chemin
```

---

## 6. EvaluationContext — le cœur

### 6.1 Interface publique complète

```ts
interface EvaluationContextOptions {
  limits?:  ContextLimits
  hooks?:   ContextLifecycleHooks
  adapter?: PersistenceAdapter
}

class EvaluationContext {

  // ─── Constructeur ──────────────────────────────────────────────────────────

  constructor(
    protected readonly input:   Readonly<Record<string, unknown>>,
    protected readonly meta:    ExecutionMeta,
    protected readonly options: EvaluationContextOptions = {}
  )

  // ─── Écriture ─────────────────────────────────────────────────────────────

  set(nodeId: string, portName: string, value: unknown): void
  setRaw(nodeId: string, raw: unknown): void

  // ─── Lecture ──────────────────────────────────────────────────────────────

  get(key: string): unknown
  getNodeOutputs(nodeId: string): Record<string, unknown>
  getFullState(): Readonly<Record<string, unknown>>
  has(key: string): boolean

  // ─── Snapshots ────────────────────────────────────────────────────────────

  snapshot(label?: string): ContextSnapshot
  getSnapshots(): readonly ContextSnapshot[]

  // ─── Métriques ────────────────────────────────────────────────────────────

  sizeKb(): number
  entryCount(): number
}
```

### 6.2 Implémentation complète annotée

```ts
const RESERVED_NAMESPACES = new Set(['input', '__internal', '__meta'])

class EvaluationContext {

  private readonly frozenInput:   Readonly<Record<string, unknown>>
  private readonly state:         Map<string, unknown> = new Map()
  private readonly snapshotStore: ContextSnapshot[]    = []
  private          snapshotCount: number               = 0

  constructor(
    protected readonly input:   Readonly<Record<string, unknown>>,
    protected readonly meta:    ExecutionMeta,
    protected readonly options: EvaluationContextOptions = {}
  ) {
    // Freeze les inputs — immutables pour toute la durée de l'exécution
    this.frozenInput = Object.freeze({ ...input })

    // Initialise le namespace 'input.*' dans le state
    // Les valeurs input sont accessibles directement via ctx.get('input.income')
    for (const [key, value] of Object.entries(input)) {
      this.state.set(`input.${key}`, deepFreeze(value))
    }
  }

  // ─── set() ────────────────────────────────────────────────────────────────

  /**
   * Écrit l'output d'un port dans le contexte.
   *
   * Format de clé produite : '<nodeId>.<portName>'
   * Exemples :
   *   ctx.set('tax_calc', 'taxDue', 2000)   → clé : 'tax_calc.taxDue'
   *   ctx.set('tax_calc', 'regime', 'REEL') → clé : 'tax_calc.regime'
   *
   * Règles :
   *   - nodeId et portName doivent respecter /^[a-zA-Z0-9_-]+$/
   *   - La clé produite ne doit pas exister → ContextConflictError
   *   - La valeur est deepFreeze (récursif) avant stockage
   *   - Les hooks beforeSet/afterSet sont appelés
   *   - Les limites sont vérifiées avant écriture
   */
  set(nodeId: string, portName: string, value: unknown): void {
    this.validateIdentifier(nodeId, 'nodeId')
    this.validateIdentifier(portName, 'portName')

    // Reserved namespace protection
    if (RESERVED_NAMESPACES.has(nodeId)) {
      throw new ContextValidationError(
        `Namespace "${nodeId}" is reserved. ` +
        `Reserved namespaces: ${[...RESERVED_NAMESPACES].join(', ')}. ` +
        `Choose a different nodeId.`
      )
    }

    const key = `${nodeId}.${portName}`

    if (this.state.has(key)) {
      const error = new ContextConflictError(
        `Key "${key}" already written in this execution context. ` +
        `Two nodes cannot produce the same output key. ` +
        `This is a graph design error — check for duplicate port names between nodes.`
      )
      this.options.hooks?.onError?.(error)
      throw error
    }

    this.checkSizeLimits(value, key)

    this.options.hooks?.beforeSet?.(nodeId, portName, value)
    this.state.set(key, deepFreeze(value))
    this.options.hooks?.afterSet?.(nodeId, portName, value)
  }

  // ─── setRaw() ─────────────────────────────────────────────────────────────

  /**
   * Écrit le raw output d'un nœud.
   * Utilisé quand NodePolicy.storeRaw = true.
   *
   * Format de clé : '<nodeId>.__raw'
   * Exemple : ctx.setRaw('tax_calc', { breakdown: { TVA: 300 } })
   *           → clé : 'tax_calc.__raw'
   *
   * DIFFÉRENCE avec set() : le raw n'est PAS append-only par défaut.
   * Un nœud peut mettre à jour son raw sans ContextConflictError.
   * C'est intentionnel — le raw est de la données de debug, pas un output métier.
   *
   * Si ContextLimits.allowRawOverwrite is false, setRaw follows the same
   * append-only invariant as set() — writing twice throws ContextConflictError.
   *
   * Le raw n'est PAS inclus dans getNodeOutputs() — il est accessible
   * uniquement via get('nodeId.__raw') ou get('nodeId.__raw.path.to.value').
   */
  setRaw(nodeId: string, raw: unknown): void {
    this.validateIdentifier(nodeId, 'nodeId')

    if (this.options.limits?.allowRawOverwrite === false && this.state.has(`${nodeId}.__raw`)) {
      throw new ContextConflictError(
        `Raw for node "${nodeId}" already written and allowRawOverwrite is false. ` +
        `In strict mode, raw outputs follow the same append-only rule as regular outputs.`
      )
    }

    this.state.set(`${nodeId}.__raw`, deepFreeze(raw))
  }

  // ─── get() ────────────────────────────────────────────────────────────────

  /**
   * Lit une valeur depuis le contexte par chemin de clé.
   *
   * Résolution en 3 passes :
   *
   * Passe 1 — Clé directe :
   *   get('tax_calc.taxDue')     → cherche 'tax_calc.taxDue' dans state → valeur
   *   get('input.income')        → cherche 'input.income' dans state → valeur
   *
   * Passe 2 — Sous-chemin du raw (résolution en cascade) :
   *   get('tax_calc.__raw.breakdown.TVA')
   *   → cherche 'tax_calc.__raw.breakdown.TVA'                    ✗
   *   → cherche 'tax_calc.__raw.breakdown' (préfixe progressif)   ✗
   *   → cherche 'tax_calc.__raw'                                   ✓
   *   → retourne getNestedValue(rawObject, 'breakdown.TVA')        ✓
   *
   * Passe 3 — Absent :
   *   → retourne undefined (jamais throw — l'absence d'une clé est normale)
   *
   * NOTE : get() est toujours synchrone. Aucun appel réseau, aucune DB.
   */
  get(key: string): unknown {
    this.options.hooks?.beforeGet?.(key)

    // Passe 1 : clé directe
    let value = this.state.get(key)

    // Passe 2 : résolution de sous-chemin pour les raw
    if (value === undefined && key.includes('.__raw.')) {
      value = this.resolveRawSubpath(key)
    }

    this.options.hooks?.afterGet?.(key, value)
    return value
  }

  // ─── getNodeOutputs() ─────────────────────────────────────────────────────

  /**
   * Retourne tous les outputs d'un nœud (sans le raw).
   *
   * Exemple :
   *   ctx.set('tax_calc', 'taxDue', 2000)
   *   ctx.set('tax_calc', 'regime', 'REEL')
   *   ctx.setRaw('tax_calc', { breakdown: {...} })
   *
   *   ctx.getNodeOutputs('tax_calc')
   *   → { taxDue: 2000, regime: 'REEL' }   ← raw EXCLU
   *
   * Utilisé par l'orchestrateur DG pour évaluer les edge conditions
   * en scope 'source-output'.
   */
  getNodeOutputs(nodeId: string): Record<string, unknown> {
    const prefix = `${nodeId}.`
    const result: Record<string, unknown> = {}

    for (const [key, value] of this.state.entries()) {
      if (key.startsWith(prefix) && !key.startsWith(`${nodeId}.__`)) {
        result[key.slice(prefix.length)] = value
      }
    }

    return result
  }

  // ─── getFullState() ───────────────────────────────────────────────────────

  /**
   * Retourne une copie freeze de l'état complet.
   * Inclut inputs, outputs des nœuds, et raw.
   *
   * Utilisé par l'orchestrateur DG pour évaluer les edge conditions
   * en scope 'full-context'.
   *
   * IMPORTANT : retourne une copie — modifier le résultat ne modifie pas le state.
   */
  getFullState(): Readonly<Record<string, unknown>> {
    return deepFreeze(Object.fromEntries(this.state))
  }

  // ─── has() ────────────────────────────────────────────────────────────────

  has(key: string): boolean {
    return this.state.has(key)
  }

  // ─── snapshot() ───────────────────────────────────────────────────────────

  /**
   * Crée et stocke un snapshot immuable de l'état courant.
   *
   * Propriétés :
   *   - Immuable par construction (deepFreeze récursif)
   *   - Non-destructif — peut être appelé à n'importe quel moment
   *   - Indépendant du contexte — une copie complète du state est faite
   *   - Modifier le contexte après snapshot() ne modifie pas le snapshot
   *
   * ID du snapshot : '<requestId>:snap:<N>' où N est incrémental
   *
   * Usage dans DGContext :
   *   const snap = ctx.snapshot(`after-level-${level.index}`)
   *   await adapter?.executions?.recordSnapshot(meta.requestId, snap)
   */
  snapshot(label?: string): ContextSnapshot {
    const id = `${this.meta.requestId}:snap:${this.snapshotCount}`
    this.snapshotCount++

    const snap: ContextSnapshot = deepFreeze({
      id,
      label:     label ?? `snapshot-${this.snapshotCount}`,
      timestamp: Date.now(),
      state:     Object.fromEntries(this.state),
      meta:      { ...this.meta }
    })

    this.snapshotStore.push(snap)
    return snap
  }

  getSnapshots(): readonly ContextSnapshot[] {
    return deepFreeze([...this.snapshotStore])
  }

  // ─── Métriques ────────────────────────────────────────────────────────────

  sizeKb(): number {
    return roughSizeKb(Object.fromEntries(this.state))
  }

  entryCount(): number {
    return this.state.size
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private validateIdentifier(value: string, field: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
      throw new ContextValidationError(
        `Invalid ${field} "${value}". ` +
        `Must match /^[a-zA-Z0-9_-]+$/. ` +
        `No dots, spaces, or special characters allowed. ` +
        `Dots are reserved as namespace separators.`
      )
    }
  }

  private checkSizeLimits(value: unknown, key: string): void {
    const limits = this.options.limits
    if (!limits) return

    // Vérification taille de la valeur
    if (limits.maxValueSizeKb) {
      const valueSize = roughSizeKb(value)
      if (valueSize > limits.maxValueSizeKb) {
        throw new ContextLimitError(
          `Value for key "${key}" is ${valueSize.toFixed(1)}kb, ` +
          `exceeds maxValueSizeKb (${limits.maxValueSizeKb}kb). ` +
          `Consider splitting the output into multiple ports or disabling storeRaw.`
        )
      }
    }

    // Vérification taille totale
    if (limits.maxTotalSizeKb) {
      const totalSize = this.sizeKb()
      if (totalSize > limits.maxTotalSizeKb) {
        throw new ContextLimitError(
          `Total context size ${totalSize.toFixed(1)}kb exceeds maxTotalSizeKb (${limits.maxTotalSizeKb}kb). ` +
          `The graph is producing too much data. Review storeRaw usage.`
        )
      }
    }

    // Vérification nombre d'entrées
    if (limits.maxEntries && this.state.size >= limits.maxEntries) {
      throw new ContextLimitError(
        `Context has ${this.state.size} entries, ` +
        `exceeds maxEntries (${limits.maxEntries}). ` +
        `The graph has too many nodes producing des outputs.`
      )
    }
  }

  private resolveRawSubpath(key: string): unknown {
    // Résout 'tax_calc.__raw.breakdown.TVA'
    // Cherche le plus long préfixe de la forme '<nodeId>.__raw' dans le state
    // puis navigue dans l'objet raw avec le reste du chemin

    const rawMarker = '.__raw.'
    const markerIdx = key.indexOf(rawMarker)
    if (markerIdx === -1) return undefined

    const rawKey      = key.slice(0, markerIdx + rawMarker.length - 1) // 'tax_calc.__raw'
    const subpath     = key.slice(markerIdx + rawMarker.length)         // 'breakdown.TVA'
    const rawValue    = this.state.get(rawKey)

    if (rawValue === undefined) return undefined

    return getNestedValue(rawValue as Record<string, unknown>, subpath)
  }
}
```

---

## 7. Namespace & convention de clés

### 7.1 Tableau complet des formats

| Source | Format de clé | Exemple concret | Écrit par |
|---|---|---|---|
| Input initial | `input.<key>` | `input.income` | Constructeur |
| Input initial (sous-objet) | `input.<key>` | `input.address` | Constructeur |
| Output d'un nœud | `<nodeId>.<portName>` | `tax_calc.taxDue` | `ctx.set()` |
| Raw d'un nœud | `<nodeId>.__raw` | `tax_calc.__raw` | `ctx.setRaw()` |
| Sous-champ du raw | résolu dynamiquement | `tax_calc.__raw.breakdown.TVA` | `ctx.get()` |

### 7.2 Namespaces réservés

```ts
const RESERVED_NAMESPACES = new Set(['input', '__internal', '__meta'])
```

| Namespace | Usage | Pourquoi réservé |
|---|---|---|
| `input` | Inputs initiaux passés au constructeur | Écriture exclusive du constructeur — `set('input', ...)` créerait un conflit avec `input.*` |
| `__internal` | Réservé pour des métadonnées internes futures (ex: timing, diagnostics) | Évite les collisions avec les nœuds utilisateur |
| `__meta` | Réservé pour des métadonnées d'exécution futures | Évite les collisions avec les nœuds utilisateur |

La vérification est faite dans `set()` **avant** le contrôle append-only. Toute tentative d'utiliser un namespace réservé comme `nodeId` lève `ContextValidationError` immédiatement.

### 7.3 Contrainte d'identifiant — la règle du point

```ts
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9_-]+$/
```

Appliquée strictement à **tous** les `nodeId` et `portName`. **Aucun point autorisé.** Le point est le séparateur de namespace — un `nodeId` contenant un point (`tax.calc`) rendrait `tax.calc.taxDue` ambigu entre "nœud `tax.calc`, port `taxDue`" et "nœud `tax`, port `calc.taxDue`".

La validation est faite dans `set()` et `setRaw()`. Toute violation → `ContextValidationError` immédiate.

### 7.4 Résolution en cascade dans `get()`

```
// Cas 1 : clé directe
ctx.get('tax_calc.taxDue')
  Passe 1 : state.has('tax_calc.taxDue') → true → retourne valeur   ✓

// Cas 2 : input initial
ctx.get('input.income')
  Passe 1 : state.has('input.income') → true (initialisé dans constructeur) → retourne valeur   ✓

// Cas 3 : sous-champ du raw
ctx.get('tax_calc.__raw.breakdown.TVA')
  Passe 1 : state.has('tax_calc.__raw.breakdown.TVA') → false
  Passe 2 : détecte '.__raw.' dans la clé
            → rawKey = 'tax_calc.__raw'
            → subpath = 'breakdown.TVA'
            → state.has('tax_calc.__raw') → true
            → getNestedValue(rawObject, 'breakdown.TVA') → 300   ✓

// Cas 4 : absent
ctx.get('node_inexistant.port')
  Passe 1 : state.has(...) → false
  Passe 2 : pas de '.__raw.' → skip
  → retourne undefined   (jamais throw)
```

### 7.5 Exemples de state complet

```json
{
  "input.income":             6000000,
  "input.employeeCount":      5,
  "tax_calc.taxDue":          1200000,
  "tax_calc.regime":          "REEL",
  "tax_calc.__raw":           { "breakdown": { "TVA": 300000, "IRPP": 900000 } },
  "payroll.payrollDue":       450000,
  "report.totalDue":          1650000
}
```

---

## 8. ExecutionMeta

```ts
/**
 * Identité complète d'une exécution.
 * Définie à la création du contexte, jamais mutée.
 * Partagée entre EvaluationContext (context-engine) et DGContext (dg).
 */
interface ExecutionMeta {
  /**
   * UUID unique par exécution de graphe.
   * Utilisé pour :
   *   - Idempotence des nœuds (nodeExecutionId = requestId:nodeId)
   *   - Identification des snapshots (requestId:snap:N)
   *   - Corrélation dans les logs et l'audit
   */
  requestId:      string

  /**
   * Identifiant du tenant (organisation).
   * Utilisé pour la résolution des règles et l'isolation des données.
   */
  tenantId:       string

  /** Identifiant de l'utilisateur à l'origine de l'exécution. */
  userId?:        string

  /**
   * Timestamp ISO 8601 fixé à la création du contexte.
   * JAMAIS muté pendant l'exécution.
   * Toutes les résolutions de règles et conditions DSL qui utilisent une date
   * s'appuient sur ce timestamp — garantie de déterminisme absolu.
   * Deux exécutions avec le même requestId et timestamp produisent le même résultat.
   */
  timestamp:      string

  /**
   * Date effective pour la résolution des règles.
   * Si absent, les resolvers utilisent la date extraite de timestamp.
   * Permet de simuler une exécution à une date passée ou future.
   */
  effectiveDate?: string

  /**
   * Données contextuelles libres passées à la résolution des règles.
   * Exemples : { country: 'TG', regime: 'REEL', currency: 'XOF' }
   */
  context?:       Record<string, unknown>
}
```

---

## 9. ContextLimits & protection mémoire

```ts
interface ContextLimits {
  /**
   * Taille maximale d'une seule valeur écrite via set().
   * Défaut recommandé : 512 KB
   * Erreur : ContextLimitError avant l'écriture.
   *
   * Use case : éviter qu'un nœud produise une Invoice[]
   * de 10 000 lignes qui sature le contexte.
   */
  maxValueSizeKb?: number

  /**
   * Taille totale maximale du state complet.
   * Défaut recommandé : 50 MB
   * Erreur : ContextLimitError avant l'écriture.
   *
   * Use case : éviter qu'un graphe de 100 nœuds avec storeRaw: true
   * accumule des GB de données.
   */
  maxTotalSizeKb?: number

  /**
   * Nombre maximum d'entrées dans le state.
   * Défaut recommandé : 10 000
   * Erreur : ContextLimitError avant l'écriture.
   *
   * Use case : éviter les graphes pathologiques avec des milliers de ports.
   */
  maxEntries?: number

  /**
   * Si false, setRaw() suit le même invariant append-only que set() —
   * écrire un raw deux fois pour le même nodeId lève ContextConflictError.
   * Défaut : true (le raw peut être écrasé, c'est du debug data).
   * Mettre à false en mode strict pour garantir l'append-only total.
   */
  allowRawOverwrite?: boolean  // default: true — set false in strict mode to enforce full append-only
}
```

### Ordre de vérification dans `checkSizeLimits()`

1. `maxValueSizeKb` : vérifié sur la valeur entrante seule
2. `maxTotalSizeKb` : vérifié sur la taille totale **après** calcul de l'état courant
3. `maxEntries` : vérifié sur le count avant écriture

Toutes les vérifications se font **avant** l'écriture dans le state. En cas d'erreur, le state reste inchangé — pas d'état intermédiaire corrompu.

### `roughSizeKb(value)`

```ts
function roughSizeKb(value: unknown): number {
  try {
    return JSON.stringify(value).length / 1024
  } catch {
    // Références circulaires ou valeurs non-sérialisables → estimation conservative
    return Infinity
  }
}
```

Estimation basée sur `JSON.stringify`. Pas exact (UTF-16 vs UTF-8, overhead Map), mais suffisant pour détecter les abus — un objet de 10 MB se détecte à quelques % près. La valeur `Infinity` retournée pour les non-sérialisables garantit que la limite est toujours dépassée, ce qui est le comportement correct (on ne stocke pas de données non-sérialisables dans un contexte d'exécution).

---

## 10. ContextSnapshot

```ts
/**
 * Photo immuable de l'état du contexte à un instant donné.
 *
 * PROPRIÉTÉS ESSENTIELLES :
 *   - Immuable par construction (deepFreeze récursif)
 *   - Indépendant du contexte source (copie complète, pas de référence)
 *   - Persistable via ExecutionStore.recordSnapshot()
 *   - Utilisable pour le replay dans DGInspector
 */
interface ContextSnapshot {
  /**
   * Identifiant unique : '<requestId>:snap:<N>'
   * N est incrémental dans le scope d'une exécution.
   */
  readonly id:        string

  /**
   * Label libre pour identifier l'instant du snapshot.
   * Exemples : 'after-level-0', 'after-node-tax_calc', 'before-merge'
   */
  readonly label:     string

  /** Date.now() au moment de la création du snapshot. */
  readonly timestamp: number

  /**
   * Copie complète et freeze du state au moment du snapshot.
   * Inclut inputs, outputs et raw de tous les nœuds exécutés jusqu'à cet instant.
   */
  readonly state:     Readonly<Record<string, unknown>>

  /** Copie de ExecutionMeta — pour contextualiser le snapshot en audit. */
  readonly meta:      Readonly<ExecutionMeta>
}
```

### Pourquoi pas de rollback en v1

Le rollback complet du contexte (`ctx.rollback(snapshotId)`) n'est pas implémenté en v1 pour deux raisons :

1. **Le besoin est couvert autrement** : `DGInspector.replayUntil()` dans `@run-iq/dg` reconstruit l'état à n'importe quel point en rejouant le log d'events — sans modifier le contexte courant. C'est suffisant pour le debug et l'audit.

2. **Le rollback dans un contexte append-only est conceptuellement problématique** : rollback + nœuds qui ont déjà été exécutés avec les valeurs pré-rollback = état incohérent garanti si l'orchestrateur ne gère pas la reprise. C'est un feature v2 qui nécessite une coordination avec l'orchestrateur.

---

## 11. ContextLifecycleHooks

```ts
/**
 * Hooks d'observation du cycle de vie du contexte.
 *
 * RÈGLE CRITIQUE : les hooks sont OBSERVATEURS, jamais MUTATEURS.
 *
 * Ils ne peuvent PAS :
 *   - Modifier la valeur en transit
 *   - Annuler une opération set() ou get()
 *   - Injecter des données supplémentaires
 *   - Lancer des opérations asynchrones bloquantes
 *
 * Ils PEUVENT :
 *   - Logger
 *   - Mesurer la performance (metrics, traces)
 *   - Déclencher des side-effects externes non-bloquants (alertes, événements)
 *   - Valider et alerter (mais pas bloquer — throw dans un hook = comportement indéfini)
 */
interface ContextLifecycleHooks {
  /**
   * Appelé AVANT chaque set(), après validation des identifiants,
   * avant vérification des limites.
   */
  beforeSet?(nodeId: string, portName: string, value: unknown): void

  /**
   * Appelé APRÈS chaque set() réussi, après écriture dans le state.
   */
  afterSet?(nodeId: string, portName: string, value: unknown): void

  /**
   * Appelé AVANT chaque get(), avec la clé brute demandée.
   */
  beforeGet?(key: string): void

  /**
   * Appelé APRÈS chaque get().
   * value est undefined si la clé n'existe pas — c'est normal.
   */
  afterGet?(key: string, value: unknown): void

  /**
   * Appelé quand une ContextError est levée (ConflictError, LimitError, ValidationError).
   * N'empêche pas le throw — c'est une notification, pas un handler.
   */
  onError?(error: ContextError): void
}
```

### Exemples d'usage

```ts
// Logging structuré
const loggingHooks: ContextLifecycleHooks = {
  afterSet: (nodeId, portName, value) => {
    logger.debug('context.write', {
      key:    `${nodeId}.${portName}`,
      sizeKb: roughSizeKb(value).toFixed(2),
      ts:     Date.now()
    })
  },
  onError: (error) => {
    logger.error('context.error', { type: error.constructor.name, message: error.message })
  }
}

// OpenTelemetry distributed tracing
const tracingHooks: ContextLifecycleHooks = {
  beforeGet: (key) => {
    span.addEvent('context.get', { 'context.key': key })
  },
  afterSet: (nodeId, portName) => {
    span.addEvent('context.set', { 'context.key': `${nodeId}.${portName}` })
  }
}

// Métriques Prometheus
const metricsHooks: ContextLifecycleHooks = {
  afterSet: (nodeId, portName, value) => {
    contextSizeGauge.set(roughSizeKb(value))
    contextWritesCounter.inc({ nodeId })
  },
  onError: (error) => {
    if (error instanceof ContextConflictError) {
      contextConflictsCounter.inc()
    }
  }
}
```

---

## 12. PersistenceAdapter

```ts
/**
 * Wrapper optionnel des trois stores de persistance.
 * Tout est optionnel — si un store est absent, la fonctionnalité correspondante
 * est simplement désactivée (pas d'erreur).
 *
 * INJECTÉ dans EvaluationContext à la création.
 * Le contexte ne sait PAS si c'est Postgres, Redis, S3, ou in-memory.
 * C'est l'application host qui fournit les implémentations concrètes.
 *
 * USAGE :
 *   // Développement / tests
 *   const adapter = createInMemoryAdapter()
 *
 *   // Production
 *   const adapter: PersistenceAdapter = {
 *     graphs:     new PostgresGraphStore(pgClient),
 *     rules:      new PostgresRuleStore(pgClient),
 *     executions: new PostgresExecutionStore(pgClient)
 *   }
 *
 *   // Partiel — seulement l'audit, pas le cache de graphes
 *   const adapter: PersistenceAdapter = {
 *     executions: new PostgresExecutionStore(pgClient)
 *   }
 */
interface PersistenceAdapter {
  graphs?:     GraphStore
  rules?:      RuleStore
  executions?: ExecutionStore
}
```

### Utilisation dans EvaluationContext

`EvaluationContext` lui-même **n'appelle jamais directement** les stores. Il expose l'adapter via `this.options.adapter` pour que les sous-classes (comme `DGContext` dans `@run-iq/dg`) puissent l'utiliser.

```ts
// Dans DGContext (dans @run-iq/dg) — exemple d'usage de l'adapter
class DGContext extends EvaluationContext {

  async persistEvent(event: DGEvent): Promise<void> {
    // L'adapter est optionnel — on vérifie avant d'appeler
    await this.options.adapter?.executions?.recordEvent(
      this.meta.requestId,
      {
        executionId: this.meta.requestId,
        sequence:    this.eventCount,
        type:        event.type,
        payload:     JSON.stringify(event),
        recordedAt:  new Date().toISOString()
      }
    )
  }
}
```

---

## 13. GraphStore

```ts
/**
 * Stocke et récupère les graphes de décision et leurs versions compilées.
 *
 * RESPONSABILITÉS :
 *   - Versioning des graphes (jamais écraser une version existante)
 *   - Cache des CompiledGraph par hash SHA-256
 *   - Listing pour la plateforme (UI, API, CLI)
 *
 * IMPLÉMENTATIONS ATTENDUES :
 *   In-memory  : InMemoryGraphStore (fournie par ce package)
 *   Production : PostgresGraphStore, S3GraphStore, MongoGraphStore
 *                (fournies par l'application host ou run-iq.cloud)
 */
interface GraphStore {

  /**
   * Récupère un graphe par ID.
   * Si version absent → retourne la dernière version publiée.
   * Throw GraphNotFoundError si le graphe n'existe pas.
   */
  getGraph(graphId: string, version?: string): Promise<SerializedGraph>

  /**
   * Persiste un graphe.
   * Versioning strict — ne jamais écraser une version existante.
   * Throw GraphVersionConflictError si graphId + version existe déjà.
   */
  saveGraph(graph: SerializedGraph): Promise<void>

  /**
   * Récupère un CompiledGraph depuis le cache par hash SHA-256.
   * Retourne null si absent (pas une erreur — il faudra compiler).
   */
  getCompiledGraph(hash: string): Promise<SerializedCompiledGraph | null>

  /**
   * Met en cache un CompiledGraph.
   * Si le hash existe déjà, le store peut ignorer silencieusement (idempotent).
   */
  saveCompiledGraph(compiled: SerializedCompiledGraph): Promise<void>

  /**
   * Liste les graphes disponibles pour un tenant.
   * Retourne uniquement les métadonnées — pas le payload complet.
   */
  listGraphs(tenantId: string): Promise<GraphMetadata[]>

  /**
   * Supprime les anciennes versions d'un graphe.
   * Garde les N dernières. Utile pour éviter l'accumulation infinie.
   */
  pruneGraphVersions(graphId: string, keepLast: number): Promise<void>
}
```

### Types associés

```ts
/**
 * Graphe sérialisé pour stockage.
 * Le payload est un JSON.stringify(DGGraph) — les types DGGraph
 * restent dans @run-iq/dg. GraphStore ne les connaît pas.
 */
interface SerializedGraph {
  id:        string
  version:   string
  tenantId:  string
  createdAt: string    // ISO 8601
  payload:   string    // JSON.stringify(DGGraph) — opaque pour le store
  checksum:  string    // sha256(payload) — vérification d'intégrité
}

/**
 * CompiledGraph sérialisé pour cache.
 */
interface SerializedCompiledGraph {
  hash:       string    // SHA-256 du DGGraph source — clé de cache
  graphId:    string
  version:    string
  compiledAt: string    // ISO 8601
  dgVersion:  string    // version de @run-iq/dg qui a compilé
  payload:    string    // JSON.stringify(CompiledGraph) — opaque pour le store
}

/**
 * Métadonnées légères pour listing.
 */
interface GraphMetadata {
  id:           string
  version:      string
  tenantId:     string
  description?: string
  domain?:      string
  tags?:        string[]
  createdAt:    string
}
```

---

## 14. RuleStore

```ts
/**
 * Résout les règles applicables pour un nœud donné.
 * C'est la version "platform-aware" du RuleResolver de @run-iq/dg.
 *
 * RESPONSABILITÉS :
 *   - Résolution des règles par tenant, modèle, date, pays
 *   - Fingerprinting déterministe (cache côté resolver)
 *   - CRUD des règles pour la plateforme
 *
 * NOTE : RuleStore et RuleResolver (@run-iq/dg) ont des rôles complémentaires.
 *   RuleStore   → contrat de persistance, connaît les SerializedRule
 *   RuleResolver → contrat d'exécution dans le DG, connaît les Rule du Core
 *   En production, un RemoteRuleStore peut implémenter les deux via un adapter.
 */
interface RuleStore {

  /**
   * Résout les règles applicables pour une requête donnée.
   * Filtre par tenant, modèle, date effective, pays, tags.
   * Retourne une liste ordonnée par priorité.
   */
  resolveRules(query: RuleQuery): Promise<SerializedRule[]>

  /**
   * Calcule un fingerprint déterministe pour une requête.
   * Même query → même fingerprint → même règles depuis le cache.
   * Le fingerprint encode : model, tenantId, effectiveDate, country.
   */
  fingerprint(query: RuleQuery): string

  /**
   * Persiste une règle.
   * Gère le versioning automatiquement (version = hash du payload).
   */
  saveRule(rule: SerializedRule): Promise<void>

  /**
   * Récupère une règle spécifique par ID et version optionnelle.
   * Si version absent → retourne la version la plus récente.
   * Retourne null si absent.
   */
  getRule(ruleId: string, version?: number): Promise<SerializedRule | null>

  /**
   * Liste les règles disponibles selon des filtres partiels.
   */
  listRules(query: Partial<RuleQuery>): Promise<RuleMetadata[]>
}
```

### Types associés

```ts
interface RuleQuery {
  nodeId?:        string
  model?:         string
  tenantId:       string    // toujours requis — isolation multi-tenant
  effectiveDate?: string    // YYYY-MM-DD
  country?:       string    // ISO 3166-1 alpha-2
  tags?:          string[]
  context?:       Record<string, unknown>
}

interface SerializedRule {
  id:              string
  version:         number    // incrémental par règle
  model:           string
  tenantId:        string
  checksum:        string    // sha256(payload)
  effectiveFrom:   string    // YYYY-MM-DD
  effectiveUntil:  string | null
  tags:            string[]
  payload:         string    // JSON.stringify(Rule) — opaque pour le store
}

interface RuleMetadata {
  id:             string
  model:          string
  tenantId:       string
  effectiveFrom:  string
  effectiveUntil: string | null
  tags:           string[]
  version:        number
}
```

---

## 15. ExecutionStore

```ts
/**
 * Stocke le cycle de vie complet d'une exécution pour audit et replay.
 *
 * RESPONSABILITÉS :
 *   - Traçabilité complète event-sourced de chaque exécution
 *   - Persistance des snapshots de contexte aux points clés
 *   - Récupération pour replay, audit légal, debugging
 *
 * PARADIGME : event-sourced.
 *   Une exécution = un flux d'events ordonné (sequence 0, 1, 2...).
 *   L'état final peut être reconstruit en rejouant les events.
 *   C'est exactement ce que DGInspector.replayUntil() fait en mémoire.
 *   L'ExecutionStore permet de le faire depuis la persistance.
 *
 * IMPLÉMENTATIONS ATTENDUES :
 *   In-memory       : InMemoryExecutionStore (fournie ici)
 *   Production      : PostgresExecutionStore, EventStoreDB, DynamoDB
 *   (fournies par l'application host ou run-iq.cloud)
 */
interface ExecutionStore {

  /**
   * Démarre une nouvelle exécution — crée l'enregistrement initial.
   * Retourne l'executionId (= requestId dans la v1).
   */
  startExecution(record: ExecutionRecord): Promise<string>

  /**
   * Enregistre un event d'exécution.
   * Appelé en streaming pendant l'exécution — doit être rapide.
   * Le sequence doit être croissant pour garantir l'ordre de replay.
   */
  recordEvent(executionId: string, event: SerializedEvent): Promise<void>

  /**
   * Enregistre un snapshot de contexte à un point donné.
   * Optionnel — permet un replay plus rapide sans rejouer depuis le début.
   */
  recordSnapshot(executionId: string, snapshot: ContextSnapshot): Promise<void>

  /**
   * Marque une exécution comme terminée avec son résumé.
   */
  completeExecution(executionId: string, summary: ExecutionSummary): Promise<void>

  /**
   * Récupère une exécution complète avec tous ses events et snapshots.
   * Retourne null si absente.
   */
  getExecution(executionId: string): Promise<StoredExecution | null>

  /**
   * Liste les exécutions pour un tenant avec filtres optionnels.
   * Retourne uniquement les records — pas les events (trop volumineux).
   */
  listExecutions(tenantId: string, filters?: ExecutionFilters): Promise<ExecutionRecord[]>
}
```

### Types associés

```ts
interface ExecutionRecord {
  executionId:  string    // = requestId en v1
  requestId:    string
  tenantId:     string
  userId?:      string
  graphId:      string
  graphHash:    string    // SHA-256 — identifie exactement la version exécutée
  graphVersion: string
  startedAt:    string    // ISO 8601
  status:       'running' | 'completed' | 'failed' | 'partial'
}

interface ExecutionSummary {
  status:      'completed' | 'failed' | 'partial'
  completedAt: string
  durationMs:  number
  executed:    string[]   // nodeIds exécutés avec succès
  skipped:     string[]   // nodeIds skippés
  failed:      string[]   // nodeIds en erreur
}

interface StoredExecution {
  record:    ExecutionRecord
  events:    SerializedEvent[]
  snapshots: ContextSnapshot[]
  summary?:  ExecutionSummary
}

interface SerializedEvent {
  executionId: string
  sequence:    number     // ordre garanti pour replay
  type:        string     // event.type (ex: 'node.completed')
  payload:     string     // JSON.stringify(DGEvent) — opaque pour le store
  recordedAt:  string     // ISO 8601
}

interface ExecutionFilters {
  graphId?: string
  status?:  'running' | 'completed' | 'failed' | 'partial'
  from?:    string    // ISO 8601 — filtre sur startedAt
  to?:      string    // ISO 8601 — filtre sur startedAt
  limit?:   number
  offset?:  number
}
```

---

## 16. Implémentations InMemory

Les implémentations in-memory sont **fonctionnelles et complètes** — pas des stubs. Elles couvrent tous les cas nominaux et les cas d'erreur. Elles sont utilisées en développement, en tests, et en démo.

### 16.1 InMemoryGraphStore

```ts
export class InMemoryGraphStore implements GraphStore {
  private readonly graphs:   Map<string, SerializedGraph>         = new Map()
  private readonly compiled: Map<string, SerializedCompiledGraph> = new Map()

  async getGraph(graphId: string, version?: string): Promise<SerializedGraph> {
    const key = version ? `${graphId}:${version}` : `${graphId}:latest`
    const graph = this.graphs.get(key)
    if (!graph) {
      throw new GraphNotFoundError(
        `Graph "${graphId}"${version ? ` version "${version}"` : ' (latest)'} not found`
      )
    }
    return graph
  }

  async saveGraph(graph: SerializedGraph): Promise<void> {
    const versionKey = `${graph.id}:${graph.version}`
    if (this.graphs.has(versionKey)) {
      throw new GraphVersionConflictError(
        `Graph "${graph.id}" version "${graph.version}" already exists. ` +
        `Versions are immutable — bump the version to publish a new revision.`
      )
    }
    this.graphs.set(versionKey, graph)
    // L'alias 'latest' pointe toujours vers la dernière version sauvegardée
    this.graphs.set(`${graph.id}:latest`, graph)
  }

  async getCompiledGraph(hash: string): Promise<SerializedCompiledGraph | null> {
    return this.compiled.get(hash) ?? null
  }

  async saveCompiledGraph(compiled: SerializedCompiledGraph): Promise<void> {
    // Idempotent — si le hash existe déjà, on ignore silencieusement
    if (!this.compiled.has(compiled.hash)) {
      this.compiled.set(compiled.hash, compiled)
    }
  }

  async listGraphs(tenantId: string): Promise<GraphMetadata[]> {
    return [...this.graphs.entries()]
      .filter(([key, g]) => g.tenantId === tenantId && !key.endsWith(':latest'))
      .map(([, g]) => ({
        id:        g.id,
        version:   g.version,
        tenantId:  g.tenantId,
        createdAt: g.createdAt
      }))
  }

  async pruneGraphVersions(graphId: string, keepLast: number): Promise<void> {
    const versions = [...this.graphs.entries()]
      .filter(([key]) => key.startsWith(`${graphId}:`) && !key.endsWith(':latest'))
      .sort(([, a], [, b]) => b.createdAt.localeCompare(a.createdAt))

    versions.slice(keepLast).forEach(([key]) => this.graphs.delete(key))
  }
}
```

### 16.2 InMemoryRuleStore

```ts
export class InMemoryRuleStore implements RuleStore {
  private readonly rules: Map<string, SerializedRule> = new Map()

  async resolveRules(query: RuleQuery): Promise<SerializedRule[]> {
    const effectiveDate = query.effectiveDate ?? new Date().toISOString().split('T')[0]

    return [...this.rules.values()].filter(rule => {
      if (rule.tenantId !== query.tenantId) return false
      if (query.model && rule.model !== query.model) return false
      if (query.country) {
        const payload = JSON.parse(rule.payload)
        if (payload.country && payload.country !== query.country) return false
      }
      if (rule.effectiveFrom > effectiveDate) return false
      if (rule.effectiveUntil && rule.effectiveUntil < effectiveDate) return false
      if (query.tags?.length) {
        if (!query.tags.some(tag => rule.tags.includes(tag))) return false
      }
      return true
    })
  }

  fingerprint(query: RuleQuery): string {
    return sha256(JSON.stringify({
      model:         query.model         ?? null,
      tenantId:      query.tenantId,
      effectiveDate: query.effectiveDate ?? null,
      country:       query.country       ?? null,
      tags:          query.tags?.sort()  ?? null
    }))
  }

  async saveRule(rule: SerializedRule): Promise<void> {
    this.rules.set(`${rule.id}:${rule.version}`, rule)
  }

  async getRule(ruleId: string, version?: number): Promise<SerializedRule | null> {
    if (version !== undefined) {
      return this.rules.get(`${ruleId}:${version}`) ?? null
    }
    // Version la plus récente
    const matches = [...this.rules.values()]
      .filter(r => r.id === ruleId)
      .sort((a, b) => b.version - a.version)
    return matches[0] ?? null
  }

  async listRules(query: Partial<RuleQuery>): Promise<RuleMetadata[]> {
    return [...this.rules.values()]
      .filter(r => !query.tenantId || r.tenantId === query.tenantId)
      .filter(r => !query.model    || r.model    === query.model)
      .map(r => ({
        id:             r.id,
        model:          r.model,
        tenantId:       r.tenantId,
        effectiveFrom:  r.effectiveFrom,
        effectiveUntil: r.effectiveUntil,
        tags:           r.tags,
        version:        r.version
      }))
  }
}
```

### 16.3 InMemoryExecutionStore

```ts
export class InMemoryExecutionStore implements ExecutionStore {
  private readonly executions: Map<string, StoredExecution> = new Map()

  async startExecution(record: ExecutionRecord): Promise<string> {
    if (this.executions.has(record.executionId)) {
      // Idempotent — si l'exécution existe déjà (retry), on retourne l'ID
      return record.executionId
    }
    this.executions.set(record.executionId, {
      record: { ...record, status: 'running' },
      events: [],
      snapshots: []
    })
    return record.executionId
  }

  async recordEvent(executionId: string, event: SerializedEvent): Promise<void> {
    const exec = this.getOrThrow(executionId)
    exec.events.push(event)
  }

  async recordSnapshot(executionId: string, snapshot: ContextSnapshot): Promise<void> {
    const exec = this.getOrThrow(executionId)
    exec.snapshots.push(snapshot)
  }

  async completeExecution(executionId: string, summary: ExecutionSummary): Promise<void> {
    const exec = this.getOrThrow(executionId)
    exec.record.status = summary.status
    exec.summary = summary
  }

  async getExecution(executionId: string): Promise<StoredExecution | null> {
    return this.executions.get(executionId) ?? null
  }

  async listExecutions(tenantId: string, filters?: ExecutionFilters): Promise<ExecutionRecord[]> {
    let records = [...this.executions.values()]
      .map(e => e.record)
      .filter(r => r.tenantId === tenantId)

    if (filters?.graphId) records = records.filter(r => r.graphId  === filters.graphId)
    if (filters?.status)  records = records.filter(r => r.status   === filters.status)
    if (filters?.from)    records = records.filter(r => r.startedAt >= filters.from!)
    if (filters?.to)      records = records.filter(r => r.startedAt <= filters.to!)

    const offset = filters?.offset ?? 0
    const limit  = filters?.limit  ?? records.length
    return records.slice(offset, offset + limit)
  }

  private getOrThrow(executionId: string): StoredExecution {
    const exec = this.executions.get(executionId)
    if (!exec) {
      throw new ExecutionNotFoundError(
        `Execution "${executionId}" not found. ` +
        `Was startExecution() called before recordEvent() ?`
      )
    }
    return exec
  }
}
```

### 16.4 Factory createInMemoryAdapter

```ts
/**
 * Crée un PersistenceAdapter complet in-memory.
 * Chaque appel crée des instances fraîches — pas de singleton.
 *
 * Usage :
 *   import { createInMemoryAdapter } from '@run-iq/context-engine/adapters'
 *
 *   // En test
 *   const adapter = createInMemoryAdapter()
 *   const ctx = new DGContext(input, meta, { adapter })
 *
 *   // En dev
 *   const orchestrator = new DGOrchestrator(executor, dsls, {
 *     adapter: createInMemoryAdapter()
 *   })
 */
export function createInMemoryAdapter(): PersistenceAdapter {
  return {
    graphs:     new InMemoryGraphStore(),
    rules:      new InMemoryRuleStore(),
    executions: new InMemoryExecutionStore()
  }
}
```

---

## 17. Erreurs

```ts
/**
 * Classe de base pour toutes les erreurs du context-engine.
 * Toutes les erreurs héritent de ContextError pour permettre
 * des catch typés : catch (err) { if (err instanceof ContextError) ... }
 */
export class ContextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = this.constructor.name
    // Fix pour les classes d'erreur custom en TypeScript
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * Levée quand deux nœuds tentent d'écrire la même clé de contexte.
 * C'est une erreur de design du graphe — toujours fatale.
 *
 * Exemple : deux nœuds produisent tous les deux 'result.total'
 */
export class ContextConflictError extends ContextError {}

/**
 * Levée quand une limite de taille ou de count est dépassée.
 * maxValueSizeKb, maxTotalSizeKb, ou maxEntries.
 */
export class ContextLimitError extends ContextError {}

/**
 * Levée quand un identifiant (nodeId ou portName) ne respecte pas
 * le pattern /^[a-zA-Z0-9_-]+$/
 */
export class ContextValidationError extends ContextError {}

/**
 * Levée par InMemoryGraphStore quand un graphe demandé n'existe pas.
 */
export class GraphNotFoundError extends ContextError {}

/**
 * Levée par InMemoryGraphStore quand on tente de sauvegarder
 * une version de graphe qui existe déjà.
 */
export class GraphVersionConflictError extends ContextError {}

/**
 * Levée par InMemoryExecutionStore quand une exécution demandée n'existe pas.
 * Indique souvent que startExecution() n'a pas été appelé.
 */
export class ExecutionNotFoundError extends ContextError {}
```

---

## 18. Utilitaires internes

Ces fonctions sont utilisées en interne par `EvaluationContext` et les stores. Elles sont **exportées** pour permettre aux consommateurs de les réutiliser (DGContext, tests).

```ts
/**
 * Freeze récursif profond — garantit l'immutabilité à tous les niveaux.
 *
 * Object.freeze est shallow : freeze l'objet racine mais pas les sous-objets.
 * deepFreeze parcourt récursivement toutes les valeurs et freeze chaque objet.
 *
 * Usage : toute valeur écrite dans le state (set, setRaw, snapshot, input).
 */
export function deepFreeze<T>(obj: T): Readonly<T> {
  Object.freeze(obj)
  if (obj !== null && typeof obj === 'object') {
    for (const value of Object.values(obj as Record<string, unknown>)) {
      if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        deepFreeze(value)
      }
    }
  }
  return obj as Readonly<T>
}

/**
 * Estimates the JSON-serialized size of a value in kilobytes.
 *
 * APPROXIMATION CONSERVATRICE — not an exact memory measurement.
 * Based on JSON.stringify().length / 1024, which:
 *   - Overestimates for values with short keys (JSON overhead)
 *   - Underestimates for values with Map, Set, closures (not serializable)
 *   - Ignores V8 object overhead (~64 bytes per object)
 *
 * Suitable for protection limits (preventing 100MB context), NOT for precise memory accounting.
 * Limits expressed in ContextLimits should be set with a ~20% safety margin.
 */
export function roughSizeKb(value: unknown): number {
  try {
    return JSON.stringify(value).length / 1024
  } catch {
    return Infinity
  }
}

/**
 * Hash SHA-256 déterministe d'une chaîne.
 * Utilisé pour :
 *   - Hash des graphes (CompiledGraph.hash)
 *   - Fingerprint des règles (RuleStore.fingerprint)
 *   - Checksum des payloads sérialisés
 *
 * Implémentation : Node.js crypto (pas de dépendance externe).
 */
export function sha256(input: string): string {
  const { createHash } = require('crypto')
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/**
 * Navigue dans un objet par un chemin pointé.
 * Exemple : getNestedValue({ a: { b: { c: 42 } } }, 'a.b.c') → 42
 *
 * Retourne undefined si n'importe quelle partie du chemin est absente.
 * Jamais throw — utilisé dans la résolution de sous-chemins raw.
 */
export function getNestedValue(
  obj:  unknown,
  path: string
): unknown {
  if (obj === null || obj === undefined) return undefined

  const parts = path.split('.')
  let current: unknown = obj

  for (const part of parts) {
    if (current === null || current === undefined) return undefined
    if (typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }

  return current
}
```

---

## 19. Roadmap d'évolution

### v1 — Ce document (à implémenter maintenant)

Périmètre exact, rien de plus :

- `EvaluationContext` : append-only, namespace enforced, set/get/setRaw, snapshots immuables
- `ContextLimits` : maxValueSizeKb, maxTotalSizeKb, maxEntries
- `ContextLifecycleHooks` : beforeSet, afterSet, beforeGet, afterGet, onError
- `ExecutionMeta` : interface partagée avec @run-iq/dg
- `PersistenceAdapter` : interface wrapper (tout optionnel)
- `GraphStore` : interface complète + types
- `RuleStore` : interface complète + types
- `ExecutionStore` : interface complète + types
- `InMemoryGraphStore` : implémentation fonctionnelle
- `InMemoryRuleStore` : implémentation fonctionnelle
- `InMemoryExecutionStore` : implémentation fonctionnelle
- `createInMemoryAdapter()` : factory de convenance
- Erreurs : `ContextConflictError`, `ContextLimitError`, `ContextValidationError`, `GraphNotFoundError`, `GraphVersionConflictError`, `ExecutionNotFoundError`
- Utilitaires : `deepFreeze`, `roughSizeKb`, `sha256`, `getNestedValue`

### v2 — Quand un cas concret l'exige

Ne pas anticiper avant d'avoir le besoin réel.

```ts
// ContextProviders — résolution lazy de valeurs absentes
// ctx.get('exchangeRate.USD_XOF') → pas dans le state → ContextProvider résout
interface ContextProvider {
  supports(key: string): boolean
  resolve(key: string, meta: ExecutionMeta): Promise<unknown>
}

// Rollback — revenir à un snapshot précédent
// Nécessite coordination avec l'orchestrateur pour la reprise
ctx.rollback(snapshotId: string): void

// Typed context — generics TypeScript sur les valeurs
class TypedEvaluationContext<Schema extends Record<string, unknown>>
  extends EvaluationContext { ... }
```

### v3 — Plateforme distribuée

```
- Distributed context : contexte partagé entre instances via Redis/Hazelcast
- Persistent snapshots : streaming temps réel vers ExecutionStore sans buffering
- Context replay complet : reconstitution depuis ExecutionStore (pas seulement in-memory)
- TTL par valeur : expiration automatique de certaines clés
```

---

## 20. Structure du package

```
packages/context-engine/
├── src/
│   ├── EvaluationContext.ts          → classe principale — export nommé
│   │
│   ├── types/
│   │   ├── meta.ts                   → ExecutionMeta
│   │   ├── limits.ts                 → ContextLimits
│   │   ├── hooks.ts                  → ContextLifecycleHooks
│   │   ├── snapshot.ts               → ContextSnapshot
│   │   ├── options.ts                → EvaluationContextOptions
│   │   └── index.ts                  → re-export tous les types
│   │
│   ├── stores/
│   │   ├── GraphStore.ts             → interface GraphStore + SerializedGraph
│   │   │                               + SerializedCompiledGraph + GraphMetadata
│   │   ├── RuleStore.ts              → interface RuleStore + RuleQuery
│   │   │                               + SerializedRule + RuleMetadata
│   │   ├── ExecutionStore.ts         → interface ExecutionStore + ExecutionRecord
│   │   │                               + ExecutionSummary + StoredExecution
│   │   │                               + SerializedEvent + ExecutionFilters
│   │   └── index.ts                  → re-export toutes les interfaces
│   │
│   ├── PersistenceAdapter.ts         → interface PersistenceAdapter
│   │
│   ├── adapters/
│   │   ├── InMemoryGraphStore.ts     → implémentation complète
│   │   ├── InMemoryRuleStore.ts      → implémentation complète
│   │   ├── InMemoryExecutionStore.ts → implémentation complète
│   │   └── index.ts                  → export createInMemoryAdapter()
│   │
│   ├── errors.ts                     → ContextError et toutes les sous-classes
│   ├── utils.ts                      → deepFreeze, roughSizeKb, sha256, getNestedValue
│   └── index.ts                      → exports publics du package
│                                        (tout ce qu'un consommateur peut importer)
│
├── tests/
│   ├── unit/
│   │   ├── EvaluationContext/
│   │   │   ├── set.test.ts           → append-only, validation, limits
│   │   │   ├── setRaw.test.ts        → écrasement autorisé, exclusion de getNodeOutputs
│   │   │   ├── get.test.ts           → résolution directe, cascade raw, absent
│   │   │   ├── getNodeOutputs.test.ts → exclusion raw, filtrage par prefix
│   │   │   ├── getFullState.test.ts  → copie freeze, isolation
│   │   │   ├── snapshot.test.ts      → immuabilité, indépendance, ordre
│   │   │   └── limits.test.ts        → maxValueSizeKb, maxTotalSizeKb, maxEntries
│   │   ├── namespace.test.ts         → pattern regex, cas limites
│   │   ├── hooks.test.ts             → ordre d'appel, isolation, onError
│   │   └── utils.test.ts             → deepFreeze, roughSizeKb, sha256, getNestedValue
│   │
│   └── integration/
│       ├── InMemoryGraphStore.test.ts     → CRUD, versioning, alias latest
│       ├── InMemoryRuleStore.test.ts      → résolution, fingerprint, filtres
│       ├── InMemoryExecutionStore.test.ts → cycle de vie, events, snapshots
│       └── adapter-composition.test.ts   → createInMemoryAdapter, usage complet
│
├── package.json
│   {
│     "name": "@run-iq/context-engine",
│     "version": "1.0.0",
│     "dependencies": {},          ← ZÉRO dépendance externe
│     "devDependencies": {
│       "typescript": "...",
│       "vitest": "..."
│     },
│     "exports": {
│       ".":          "./src/index.ts",
│       "./adapters": "./src/adapters/index.ts",
│       "./stores":   "./src/stores/index.ts"
│     }
│   }
│
└── tsconfig.json
```

### index.ts — exports publics

```ts
// Types fondamentaux
export type { ExecutionMeta }               from './types/meta'
export type { ContextLimits }              from './types/limits'
export type { ContextLifecycleHooks }      from './types/hooks'
export type { ContextSnapshot }            from './types/snapshot'
export type { EvaluationContextOptions }   from './types/options'

// Classe principale
export { EvaluationContext }               from './EvaluationContext'

// Stores — interfaces
export type { GraphStore, SerializedGraph, SerializedCompiledGraph, GraphMetadata } from './stores/GraphStore'
export type { RuleStore, RuleQuery, SerializedRule, RuleMetadata }                  from './stores/RuleStore'
export type { ExecutionStore, ExecutionRecord, ExecutionSummary, StoredExecution,
              SerializedEvent, ExecutionFilters }                                    from './stores/ExecutionStore'

// PersistenceAdapter
export type { PersistenceAdapter }         from './PersistenceAdapter'

// Erreurs
export { ContextError, ContextConflictError, ContextLimitError,
         ContextValidationError, GraphNotFoundError,
         GraphVersionConflictError, ExecutionNotFoundError }  from './errors'

// Utilitaires (exportés pour les consommateurs)
export { deepFreeze, roughSizeKb, sha256, getNestedValue }    from './utils'
```

---

## 21. Contrats de test

### EvaluationContext — unitaires

```ts
// ─── set() — append-only & namespace ─────────────────────────────────────────

✓ set('tax_calc', 'taxDue', 2000) écrit 'tax_calc.taxDue' → 2000
✓ set() accepte les identifiants [a-zA-Z0-9_-]
✓ set() throw ContextValidationError pour nodeId 'tax.calc' (point interdit)
✓ set() throw ContextValidationError pour portName 'my port' (espace interdit)
✓ set() throw ContextValidationError pour nodeId vide ''
✓ set() throw ContextConflictError si la même clé est écrite deux fois
✓ set() ne modifie pas le state si ContextConflictError levée (atomique)
✓ set() freeze la valeur (modification externe du tableau ne modifie pas le state)
✓ set() vérifie les limites AVANT d'écrire (state inchangé en cas d'erreur)

// ─── setRaw() ─────────────────────────────────────────────────────────────────

✓ setRaw('tax_calc', raw) écrit 'tax_calc.__raw'
✓ setRaw peut être appelé deux fois pour le même nodeId (pas append-only)
✓ setRaw avec nodeId invalide → ContextValidationError
✓ la clé raw n'apparaît PAS dans getNodeOutputs()

// ─── Inputs initiaux ──────────────────────────────────────────────────────────

✓ les inputs sont accessibles via get('input.income')
✓ les inputs sont immutables (modifier l'objet original ne modifie pas le contexte)
✓ les inputs sont dans getFullState() sous la forme 'input.*'
✓ les inputs ne sont PAS dans getNodeOutputs() d'un nœud

// ─── get() — résolution en cascade ────────────────────────────────────────────

✓ get('tax_calc.taxDue') retourne la valeur écrite
✓ get('input.income') retourne la valeur initiale
✓ get('tax_calc.__raw.breakdown.TVA') résout le sous-champ du raw
✓ get('tax_calc.__raw.deep.nested.path') résout les sous-chemins profonds
✓ get('clé-inexistante') retourne undefined (jamais throw)
✓ get('tax_calc.__raw.champ-inexistant') retourne undefined
✓ get() est synchrone — jamais de Promise retournée

// ─── getNodeOutputs() ─────────────────────────────────────────────────────────

✓ getNodeOutputs('tax_calc') retourne { taxDue: 2000, regime: 'REEL' }
✓ getNodeOutputs exclut le raw ('__raw' non présent)
✓ getNodeOutputs retourne {} si le nœud n'a pas d'output
✓ getNodeOutputs ne retourne pas les clés d'autres nœuds

// ─── getFullState() ───────────────────────────────────────────────────────────

✓ getFullState() retourne tous les inputs + outputs + raw
✓ la valeur retournée est une copie (modifier le résultat ne modifie pas le state)
✓ la valeur retournée est Object.freeze

// ─── has() ────────────────────────────────────────────────────────────────────

✓ has('tax_calc.taxDue') → true après set()
✓ has('inexistant') → false
✓ has('input.income') → true après construction avec input

// ─── Limites ──────────────────────────────────────────────────────────────────

✓ throw ContextLimitError si valeur > maxValueSizeKb
✓ throw ContextLimitError si total state > maxTotalSizeKb
✓ throw ContextLimitError si state.size >= maxEntries
✓ le state est inchangé après un ContextLimitError

// ─── snapshot() ───────────────────────────────────────────────────────────────

✓ snapshot() retourne un ContextSnapshot avec id, label, timestamp, state, meta
✓ snapshot.state est Object.freeze
✓ modifier le contexte après snapshot() ne modifie pas snapshot.state
✓ deux snapshots successifs ont des IDs différents
✓ getSnapshots() retourne tous les snapshots dans l'ordre de création
✓ getSnapshots() retourne une copie freeze (pas de mutation possible)

// ─── Hooks ────────────────────────────────────────────────────────────────────

✓ beforeSet appelé avant chaque set() réussi
✓ afterSet appelé après chaque set() réussi avec (nodeId, portName, value)
✓ beforeGet appelé avant chaque get() avec la clé brute
✓ afterGet appelé après chaque get() avec (key, value) — value peut être undefined
✓ onError appelé quand ContextConflictError est levée
✓ onError appelé quand ContextLimitError est levée
✓ onError appelé quand ContextValidationError est levée
✓ un hook qui throw ne bloque pas le contexte (comportement isolé)

// ─── Métriques ────────────────────────────────────────────────────────────────

✓ sizeKb() retourne une estimation positive
✓ entryCount() retourne le nombre d'entrées dans le state (inputs inclus)
```

### InMemoryGraphStore — intégration

```ts
✓ saveGraph puis getGraph retourne le même graphe
✓ saveGraph deux fois avec même id+version → GraphVersionConflictError
✓ getGraph sans version → retourne l'alias 'latest' (dernière sauvegardée)
✓ getGraph avec version inexistante → GraphNotFoundError
✓ saveCompiledGraph puis getCompiledGraph retourne le même compiled
✓ getCompiledGraph avec hash inexistant → null
✓ saveCompiledGraph est idempotent (deux fois le même hash → pas d'erreur)
✓ listGraphs filtre par tenantId (pas d'alias 'latest' dans la liste)
✓ pruneGraphVersions conserve N versions et supprime les plus anciennes
```

### InMemoryRuleStore — intégration

```ts
✓ saveRule puis getRule retourne la même règle
✓ getRule sans version → retourne la plus récente
✓ getRule avec ruleId inexistant → null
✓ resolveRules filtre par tenantId (isolation stricte)
✓ resolveRules filtre par model
✓ resolveRules filtre par country (via payload parsing)
✓ resolveRules filtre par effectiveDate (effectiveFrom <= date <= effectiveUntil)
✓ resolveRules exclut les règles expirées
✓ resolveRules exclut les règles dont effectiveFrom est dans le futur
✓ fingerprint est déterministe — même query → même hash
✓ fingerprint différent si model change
✓ fingerprint différent si effectiveDate change
✓ listRules filtre par tenantId et model
```

### InMemoryExecutionStore — intégration

```ts
✓ startExecution crée un enregistrement avec status 'running'
✓ startExecution est idempotent (deux fois même ID → pas d'erreur, retourne ID)
✓ recordEvent après startExecution ajoute l'event dans l'ordre
✓ recordEvent sans startExecution → ExecutionNotFoundError
✓ recordSnapshot ajoute le snapshot à l'exécution
✓ completeExecution met à jour status et summary
✓ getExecution retourne record + events + snapshots + summary
✓ getExecution avec ID inexistant → null
✓ listExecutions filtre par tenantId
✓ listExecutions filtre par graphId
✓ listExecutions filtre par status
✓ listExecutions filtre par from/to (startedAt)
✓ listExecutions respecte limit et offset
```

---

*Ce document est la source de vérité pour l'implémentation de `@run-iq/context-engine`.*  
*Ce package ne doit jamais avoir de dépendance Run-IQ — c'est la garantie de son évolutivité.*  
*Implémenter ce package en premier, avant `@run-iq/dg`.*