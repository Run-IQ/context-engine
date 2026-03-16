# `@run-iq/context-engine` — RuleStore v2.0
## Mise à jour du contrat RuleStore (section 14 remplacée)

> **Contexte** : Cette mise à jour étend le contrat `RuleStore` pour supporter
> `@run-iq/rule-registry` comme implémentation de référence. Les sections 1–13
> et 15–21 du document v1.0 restent inchangées.
>
> **Changement principal** : `RuleStore` passe d'un contrat de résolution simple
> à un contrat complet couvrant le cycle de vie des règles — tout en restant
> une interface pure dans context-engine (zéro logique métier).

---

## Section 14 — RuleStore (v2.0, remplace v1.0)

### 14.1 Positionnement et séparation des responsabilités

```
@run-iq/context-engine
└── RuleStore (interface)          ← contrat pur, zéro logique métier
    ├── Résolution des règles      ← "quelles règles s'appliquent maintenant ?"
    ├── Lecture du cycle de vie    ← "quel est le statut de cette règle ?"
    ├── Fingerprinting             ← "cache déterministe"
    └── CRUD de base               ← "créer, lire, lister"

@run-iq/rule-registry
└── implémente RuleStore           ← logique métier complète
    ├── Workflow Draft→Review→Published
    ├── Détection de conflits
    ├── Rollback d'urgence
    ├── Audit trail complet
    └── Scopes partagés (UEMOA)
```

**Règle invariante** : `RuleStore` dans context-engine ne connaît pas les
concepts de "draft", "reviewer", "conflit", "approbation". Il expose uniquement
ce dont le DG et le Core ont besoin pour résoudre et exécuter des règles.
La logique de cycle de vie reste dans `@run-iq/rule-registry`.

```
AUDIT RESPONSIBILITY:
  RuleStore exposes recordAuditEvent() and getAuditTrail() — but never calls them internally.
  @run-iq/rule-registry's RuleManager is the sole writer of audit events.
  This prevents double-logging when RuleManager delegates to RuleStore.
```

---

### 14.2 Interface RuleStore complète

```ts
/**
 * Contrat de persistance des règles.
 *
 * CONSOMMATEURS :
 *   @run-iq/dg          → RuleStoreResolver utilise resolveRules() + fingerprint()
 *   @run-iq/server      → expose les endpoints de gestion des règles
 *   @run-iq/rule-registry → implémentation de référence complète
 *   Application host    → peut fournir sa propre implémentation
 *
 * CE QUE RULESTORE SAIT :
 *   - Une règle a un ID, une version, un modèle, un tenant
 *   - Une règle a une période de validité (effectiveFrom / effectiveUntil)
 *   - Une règle a un statut (draft | review | published | deprecated | archived)
 *   - Une règle a un scope (tenant-specific | shared)
 *   - Une règle a un payload opaque (JSON.stringify(Rule) du Core)
 *
 * CE QUE RULESTORE NE SAIT PAS :
 *   - Ce que signifie "approuver" une règle (c'est rule-registry)
 *   - Comment détecter un conflit entre deux règles (c'est rule-registry)
 *   - Comment générer une règle depuis du texte (c'est mcp-server + LLM)
 */
interface RuleStore {

  // ─── Résolution (hot path — appelé à chaque exécution DG) ──────────────────

  /**
   * Résout les règles applicables pour une requête donnée.
   *
   * FILTRE OBLIGATOIRE : tenantId (isolation multi-tenant stricte)
   * FILTRES OPTIONNELS : model, effectiveDate, country, tags, scope
   *
   * RÈGLE DE RÉSOLUTION :
   *   1. status = 'published' uniquement (jamais draft/review/deprecated)
   *   2. effectiveFrom <= effectiveDate <= effectiveUntil (ou null = pas d'expiration)
   *   3. scope: 'tenant-specific' pour le tenant demandé
   *      + scope: 'shared' pour tous les tenants (règles UEMOA, par exemple)
   *   4. Retourne une liste ordonnée par priorité (priority DESC, version DESC)
   *
   * PERFORMANCE : cette méthode est sur le hot path d'exécution.
   * Les implémentations doivent indexer sur (tenantId, model, status, effectiveFrom).
   */
  resolveRules(query: RuleQuery): Promise<SerializedRule[]>

  /**
   * Calcule un fingerprint déterministe pour une requête.
   *
   * PROPRIÉTÉ CRITIQUE : même query → même fingerprint → même règles.
   * Utilisé par CachedRuleResolver pour invalider le cache quand les règles changent.
   *
   * Le fingerprint encode : tenantId, model, effectiveDate, country, tags, scope.
   * Il NE encode PAS : userId, requestId, timestamp (ces champs varient par appel).
   *
   * INVALIDATION : quand une règle est publiée ou dépréciée, le fingerprint
   * des queries affectées change automatiquement → le cache est naturellement invalidé.
   */
  fingerprint(query: RuleQuery): string

  // ─── Lecture (lecture seule — pas de modification d'état) ──────────────────

  /**
   * Récupère une règle spécifique par ID et version optionnelle.
   *
   * Si version absent → retourne la version la plus récente (tout statut confondu).
   * Retourne null si absente — jamais throw sur une règle manquante.
   *
   * NOTE : retourne aussi les drafts et reviews — pas seulement les published.
   * C'est intentionnel : les outils de management ont besoin de lire toutes les versions.
   */
  getRule(ruleId: string, version?: number): Promise<SerializedRule | null>

  /**
   * Liste les règles selon des filtres partiels.
   *
   * Retourne RuleMetadata uniquement — pas le payload complet.
   * Pour le payload, utiliser getRule().
   *
   * Usage : UI de management, CLI, audit.
   */
  listRules(query: RuleListQuery): Promise<RuleMetadata[]>

  /**
   * Récupère l'historique complet d'une règle (toutes les versions).
   *
   * Retourne toutes les versions dans l'ordre chronologique (v1, v2, v3...).
   * Inclut les versions archivées — pour l'audit complet.
   *
   * Usage : "quelles règles s'appliquaient le 15 mars 2024 ?"
   */
  getRuleHistory(ruleId: string): Promise<SerializedRule[]>

  /**
   * Récupère le snapshot des règles actives à une date donnée.
   *
   * Équivalent de resolveRules() mais pour une date passée ou future.
   * Résout les règles comme elles étaient (ou seront) à atDate.
   *
   * Usage : audit réglementaire, simulation de scénarios futurs.
   * "Quelles règles étaient actives le 1er janvier 2024 pour le tenant TG-001 ?"
   */
  getRulesAtDate(tenantId: string, atDate: string, model?: string): Promise<SerializedRule[]>

  // ─── Écriture (cycle de vie géré par rule-registry, pas directement) ───────

  /**
   * Crée ou met à jour une règle.
   *
   * VERSIONING AUTOMATIQUE :
   *   - Si ruleId n'existe pas → crée version 1
   *   - Si ruleId existe → crée version N+1 (jamais écraser une version existante)
   *
   * STATUT INITIAL : toujours 'draft' — jamais 'published' directement.
   * La publication passe par publishRule() après approbation.
   *
   * Retourne la règle créée avec son numéro de version assigné.
   */
  saveRule(rule: RuleInput): Promise<SerializedRule>

  /**
   * Met à jour le statut d'une règle.
   *
   * TRANSITIONS AUTORISÉES :
   *   draft      → review     (soumission pour approbation)
   *   draft      → archived   (abandon d'un draft)
   *   review     → published  (approbation)
   *   review     → draft      (renvoi en révision)
   *   published  → deprecated (nouvelle version la remplace)
   *   deprecated → archived   (fin de cycle de vie)
   *
   * TRANSITIONS INTERDITES (throw RuleTransitionError) :
   *   published → draft     (jamais rétrograder une règle publiée)
   *   archived  → *         (un archivé ne revient jamais)
   *   * → published directement sans passer par review
   *
   * actor : qui effectue la transition (pour l'audit trail)
   * reason : justification obligatoire pour published → deprecated et * → archived
   */
  updateRuleStatus(
    ruleId:  string,
    version: number,
    status:  RuleStatus,
    actor:   string,
    reason?: string
  ): Promise<SerializedRule>

  /**
   * Publie une règle approuvée.
   *
   * EFFET DE BORD CRITIQUE :
   *   Si une règle publiée avec le même (tenantId, model, country, scope)
   *   et une période effective qui chevauche existe déjà →
   *   l'ancienne règle passe automatiquement en 'deprecated'.
   *
   * C'est le seul endroit où une transition automatique de statut se produit.
   * Toutes les autres transitions sont explicites via updateRuleStatus().
   *
   * Retourne la liste des règles automatiquement dépréciées.
   */
  publishRule(
    ruleId:  string,
    version: number,
    actor:   string
  ): Promise<{ published: SerializedRule; deprecated: SerializedRule[] }>

  /**
   * Rollback d'urgence — restaure une version précédente comme active.
   *
   * EFFET :
   *   1. La règle courante publiée passe en 'deprecated'
   *   2. La version cible repasse en 'published'
   *   3. Un RuleAuditEvent 'emergency_rollback' est enregistré
   *
   * Ne supprime jamais rien — tout est tracé.
   * actor et reason sont obligatoires pour un rollback (audit réglementaire).
   */
  rollbackRule(
    ruleId:        string,
    targetVersion: number,
    actor:         string,
    reason:        string
  ): Promise<{ restored: SerializedRule; deprecated: SerializedRule }>

  // ─── Audit trail ───────────────────────────────────────────────────────────

  /**
   * Enregistre un événement d'audit pour une règle.
   *
   * Appelé par rule-registry à chaque transition de statut, approbation,
   * rollback, ou modification. L'audit trail est append-only — jamais modifié.
   *
   * Le RuleStore expose cette méthode pour que rule-registry puisse écrire
   * les events sans connaître le détail de la persistance.
   */
  recordAuditEvent(event: RuleAuditEvent): Promise<void>

  /**
   * Récupère l'audit trail complet d'une règle.
   *
   * Retourne tous les événements dans l'ordre chronologique.
   * Ne filtre jamais — l'audit trail est toujours complet.
   */
  getAuditTrail(ruleId: string): Promise<RuleAuditEvent[]>

  // ─── Conflits ──────────────────────────────────────────────────────────────

  /**
   * Détecte les conflits potentiels entre une règle candidate et les règles existantes.
   *
   * Un conflit existe quand deux règles publiées (ou la candidate vs une publiée)
   * couvrent le même (tenantId, model, country) sur une période qui se chevauche.
   *
   * NE BLOQUE PAS — retourne les conflits pour que rule-registry décide.
   * Si conflicts est vide → pas de chevauchement détecté.
   * Si conflicts est non-vide → rule-registry avertit avant publication.
   */
  detectConflicts(candidate: RuleInput): Promise<RuleConflict[]>

  // ─── Scopes partagés (UEMOA, OHADA…) ──────────────────────────────────────

  /**
   * Liste les règles partagées applicables à un pays/région.
   *
   * Les règles shared (scope: 'shared') ne sont pas liées à un tenant spécifique.
   * Elles s'appliquent à tous les tenants d'une région (ex: taux UEMOA communs).
   *
   * resolveRules() les inclut automatiquement — cette méthode est pour la gestion.
   */
  listSharedRules(region: string, model?: string): Promise<SerializedRule[]>
}
```

---

### 14.3 Types complets

```ts
// ─── RuleQuery — résolution hot path ─────────────────────────────────────────

interface RuleQuery {
  tenantId:       string           // OBLIGATOIRE — isolation multi-tenant
  model?:         string           // modèle de calcul (ex: 'PROGRESSIVE_BRACKET')
  effectiveDate?: string           // YYYY-MM-DD — défaut: aujourd'hui
  country?:       string           // ISO 3166-1 alpha-2 (ex: 'TG', 'SN', 'CI')
  region?:        string           // pour inclure les règles shared (ex: 'UEMOA')
  tags?:          string[]         // filtrage par tags
  nodeId?:        string           // pour traçabilité dans les logs
  includeShared?: boolean          // inclure les règles scope:'shared' — défaut: true
}

// ─── RuleListQuery — listing management ───────────────────────────────────────

interface RuleListQuery {
  tenantId?:      string
  model?:         string
  country?:       string
  status?:        RuleStatus | RuleStatus[]
  scope?:         RuleScope
  tags?:          string[]
  effectiveFrom?: string           // filtre: règles actives après cette date
  effectiveTo?:   string           // filtre: règles actives avant cette date
  limit?:         number
  offset?:        number
  orderBy?:       'version' | 'effectiveFrom' | 'createdAt' | 'priority'
  orderDir?:      'asc' | 'desc'
}

// ─── RuleStatus — cycle de vie ────────────────────────────────────────────────

type RuleStatus =
  | 'draft'        // en cours de rédaction — non visible en exécution
  | 'review'       // soumise pour approbation — non visible en exécution
  | 'published'    // active — visible en exécution selon effectiveDate
  | 'deprecated'   // remplacée par une version plus récente — non visible
  | 'archived'     // fin de vie — non visible, jamais supprimée

// ─── RuleScope ────────────────────────────────────────────────────────────────

type RuleScope =
  | 'tenant-specific'  // appartient à un tenant précis
  | 'shared'           // partagée entre tenants d'une région (UEMOA, OHADA…)

// ─── RuleInput — création/modification ───────────────────────────────────────

interface RuleInput {
  id?:             string           // absent = généré automatiquement (UUID)
  model:           string
  tenantId:        string
  country?:        string
  region?:         string           // pour les règles shared
  scope:           RuleScope
  effectiveFrom:   string           // YYYY-MM-DD
  effectiveUntil?: string           // YYYY-MM-DD | null = pas d'expiration
  priority?:       number           // défaut: 0 — plus haut = priorité supérieure
  tags?:           string[]
  description?:    string           // description humaine de la règle
  source?:         string           // origine: 'manual' | 'loi-finances-2024' | 'llm-import'
  payload:         string           // JSON.stringify(Rule) — opaque pour le store
  createdBy:       string           // acteur qui crée la règle
  metadata?:       Record<string, unknown>  // données libres (référence légale, etc.)
}

// ─── SerializedRule — stockage complet ────────────────────────────────────────

interface SerializedRule {
  id:              string
  version:         number           // incrémental par ruleId — immutable
  model:           string
  tenantId:        string
  country?:        string
  region?:         string
  scope:           RuleScope
  status:          RuleStatus
  effectiveFrom:   string
  effectiveUntil:  string | null
  priority:        number
  tags:            string[]
  description?:    string
  source?:         string
  checksum:        string           // sha256(payload) — vérification d'intégrité
  payload:         string           // JSON.stringify(Rule) — opaque
  createdBy:       string
  createdAt:       string           // ISO 8601
  updatedAt:       string           // ISO 8601
  publishedAt?:    string           // ISO 8601 — absent si pas encore publié
  publishedBy?:    string
  deprecatedAt?:   string
  deprecatedBy?:   string
  metadata?:       Record<string, unknown>
}

// ─── RuleMetadata — listing léger ─────────────────────────────────────────────

interface RuleMetadata {
  id:              string
  version:         number
  model:           string
  tenantId:        string
  country?:        string
  scope:           RuleScope
  status:          RuleStatus
  effectiveFrom:   string
  effectiveUntil:  string | null
  priority:        number
  tags:            string[]
  description?:    string
  createdBy:       string
  createdAt:       string
  publishedAt?:    string
}

// ─── RuleAuditEvent — audit trail append-only ─────────────────────────────────

interface RuleAuditEvent {
  id:         string           // UUID
  ruleId:     string
  version:    number
  tenantId:   string
  type:       RuleAuditEventType
  actor:      string           // userId ou system
  reason?:    string           // obligatoire pour certains types
  before?:    Partial<SerializedRule>   // état avant
  after?:     Partial<SerializedRule>   // état après
  metadata?:  Record<string, unknown>
  recordedAt: string           // ISO 8601
}

type RuleAuditEventType =
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
  | 'rule.conflict_acknowledged'

// ─── RuleConflict — détection de chevauchements ───────────────────────────────

interface RuleConflict {
  existingRuleId:      string
  existingVersion:     number
  existingStatus:      RuleStatus
  overlapFrom:         string      // début du chevauchement de période
  overlapUntil?:       string      // fin du chevauchement (null = indéfini)
  conflictType:        RuleConflictType
  severity:            'warning' | 'critical'
  description:         string      // explication humaine du conflit
}

type RuleConflictType =
  | 'period_overlap'        // deux règles actives sur la même période
  | 'same_priority'         // même priorité → arbitrage indéterministe possible
  | 'effective_date_gap'    // trou dans la couverture temporelle
  | 'duplicate_checksum'    // payload identique → probablement un doublon
```

---

### 14.4 Erreurs RuleStore

```ts
// Ajout à la hiérarchie d'erreurs de context-engine

export class RuleNotFoundError        extends ContextError {}
// Levée par getRule() quand ruleId + version n'existe pas

export class RuleVersionConflictError extends ContextError {}
// Levée si on tente de créer une version déjà existante

export class RuleTransitionError      extends ContextError {}
// Levée par updateRuleStatus() pour une transition interdite
// Message : 'Cannot transition rule "X" from published to draft.
//            Published rules cannot be retrograded.'

export class RulePublishError         extends ContextError {}
// Levée par publishRule() si la règle n'est pas en statut 'review'
// Message : 'Cannot publish rule "X" version 3: status is "draft", expected "review".'
```

---

### 14.5 InMemoryRuleStore v2 — implémentation de référence mise à jour

```ts
/**
 * InMemoryRuleStore — reference implementation of RuleStore.
 *
 * AUDIT RESPONSIBILITY: The RuleStore does NOT write audit events.
 * Audit trail is the exclusive responsibility of @run-iq/rule-registry's
 * RuleManager — which wraps every mutation with proper audit logging.
 * This separation prevents double-logging when RuleManager calls store methods.
 *
 * Direct users of RuleStore (without RuleManager) are responsible for
 * their own audit trail if needed.
 */
export class InMemoryRuleStore implements RuleStore {
  private readonly rules:      Map<string, SerializedRule>   = new Map()
  private readonly auditTrail: Map<string, RuleAuditEvent[]> = new Map()

  // ─── Résolution ─────────────────────────────────────────────────────────────

  async resolveRules(query: RuleQuery): Promise<SerializedRule[]> {
    const effectiveDate  = query.effectiveDate ?? today()
    const includeShared  = query.includeShared !== false

    return [...this.rules.values()]
      .filter(rule => {
        // Statut : published uniquement
        if (rule.status !== 'published') return false

        // Scope : tenant-specific pour ce tenant OU shared si inclus
        if (rule.scope === 'tenant-specific' && rule.tenantId !== query.tenantId) return false
        if (rule.scope === 'shared' && !includeShared) return false
        if (rule.scope === 'shared' && query.region && rule.region !== query.region) return false

        // Modèle
        if (query.model && rule.model !== query.model) return false

        // Pays
        if (query.country && rule.country && rule.country !== query.country) return false

        // Période effective
        if (rule.effectiveFrom > effectiveDate) return false
        if (rule.effectiveUntil && rule.effectiveUntil < effectiveDate) return false

        // Tags
        if (query.tags?.length) {
          if (!query.tags.some(tag => rule.tags.includes(tag))) return false
        }

        return true
      })
      .sort((a, b) => {
        // Priorité décroissante, puis version décroissante
        if (b.priority !== a.priority) return b.priority - a.priority
        return b.version - a.version
      })
  }

  fingerprint(query: RuleQuery): string {
    return sha256(JSON.stringify({
      tenantId:       query.tenantId,
      model:          query.model         ?? null,
      effectiveDate:  query.effectiveDate ?? today(),
      country:        query.country       ?? null,
      region:         query.region        ?? null,
      tags:           query.tags?.sort()  ?? null,
      includeShared:  query.includeShared !== false
    }))
  }

  // ─── Lecture ────────────────────────────────────────────────────────────────

  async getRule(ruleId: string, version?: number): Promise<SerializedRule | null> {
    if (version !== undefined) {
      return this.rules.get(`${ruleId}:${version}`) ?? null
    }
    const matches = [...this.rules.values()]
      .filter(r => r.id === ruleId)
      .sort((a, b) => b.version - a.version)
    return matches[0] ?? null
  }

  async listRules(query: RuleListQuery): Promise<RuleMetadata[]> {
    const statuses = query.status
      ? Array.isArray(query.status) ? query.status : [query.status]
      : undefined

    return [...this.rules.values()]
      .filter(r => {
        if (query.tenantId && r.tenantId !== query.tenantId) return false
        if (query.model    && r.model    !== query.model)    return false
        if (query.country  && r.country  !== query.country)  return false
        if (query.scope    && r.scope    !== query.scope)     return false
        if (statuses       && !statuses.includes(r.status))  return false
        if (query.tags?.length && !query.tags.some(t => r.tags.includes(t))) return false
        return true
      })
      .map(toMetadata)
  }

  async getRuleHistory(ruleId: string): Promise<SerializedRule[]> {
    return [...this.rules.values()]
      .filter(r => r.id === ruleId)
      .sort((a, b) => a.version - b.version)
  }

  async getRulesAtDate(tenantId: string, atDate: string, model?: string): Promise<SerializedRule[]> {
    return this.resolveRules({ tenantId, model, effectiveDate: atDate })
  }

  // ─── Écriture ───────────────────────────────────────────────────────────────

  async saveRule(input: RuleInput): Promise<SerializedRule> {
    const id         = input.id ?? generateId()
    const existing   = [...this.rules.values()].filter(r => r.id === id)
    const version    = existing.length > 0
      ? Math.max(...existing.map(r => r.version)) + 1
      : 1
    const now        = new Date().toISOString()

    const rule: SerializedRule = {
      id, version,
      model:         input.model,
      tenantId:      input.tenantId,
      country:       input.country,
      region:        input.region,
      scope:         input.scope,
      status:        'draft',               // toujours draft à la création
      effectiveFrom: input.effectiveFrom,
      effectiveUntil: input.effectiveUntil ?? null,
      priority:      input.priority ?? 0,
      tags:          input.tags ?? [],
      description:   input.description,
      source:        input.source,
      checksum:      sha256(input.payload),
      payload:       input.payload,
      createdBy:     input.createdBy,
      createdAt:     now,
      updatedAt:     now,
      metadata:      input.metadata
    }

    this.rules.set(`${id}:${version}`, rule)

    return rule
  }

  async updateRuleStatus(
    ruleId:  string,
    version: number,
    status:  RuleStatus,
    actor:   string,
    reason?: string
  ): Promise<SerializedRule> {
    const key  = `${ruleId}:${version}`
    const rule = this.rules.get(key)
    if (!rule) throw new RuleNotFoundError(`Rule "${ruleId}" version ${version} not found`)

    // Validation des transitions
    const allowed = ALLOWED_TRANSITIONS[rule.status]
    if (!allowed?.includes(status)) {
      throw new RuleTransitionError(
        `Cannot transition rule "${ruleId}" from "${rule.status}" to "${status}". ` +
        `Allowed transitions: ${allowed?.join(', ') ?? 'none'}.`
      )
    }

    // Reason obligatoire pour certaines transitions
    if (['published', 'archived'].includes(status) && !reason && status !== 'published') {
      throw new RuleTransitionError(`Reason is required for transition to "${status}"`)
    }

    const now     = new Date().toISOString()
    const before  = { ...rule }
    const updated: SerializedRule = {
      ...rule,
      status,
      updatedAt:     now,
      deprecatedAt:  status === 'deprecated' ? now : rule.deprecatedAt,
      deprecatedBy:  status === 'deprecated' ? actor : rule.deprecatedBy
    }

    this.rules.set(key, updated)

    return updated
  }

  async publishRule(ruleId: string, version: number, actor: string): Promise<{
    published: SerializedRule
    deprecated: SerializedRule[]
  }> {
    const rule = this.rules.get(`${ruleId}:${version}`)
    if (!rule) throw new RuleNotFoundError(`Rule "${ruleId}" version ${version} not found`)
    if (rule.status !== 'review') {
      throw new RulePublishError(
        `Cannot publish rule "${ruleId}" version ${version}: ` +
        `status is "${rule.status}", expected "review".`
      )
    }

    const now = new Date().toISOString()

    // Dépréciation automatique des règles chevauchantes
    const toDeprecate = [...this.rules.values()].filter(r =>
      r.id !== ruleId &&
      r.status === 'published' &&
      r.tenantId === rule.tenantId &&
      r.model === rule.model &&
      (r.country ?? null) === (rule.country ?? null) &&
      periodsOverlap(r, rule)
    )

    const deprecated: SerializedRule[] = []
    for (const r of toDeprecate) {
      const dep = await this.updateRuleStatus(
        r.id, r.version, 'deprecated', 'system',
        `Automatically deprecated: replaced by ${ruleId} v${version}`
      )
      deprecated.push(dep)
    }

    // Publication
    const published: SerializedRule = {
      ...rule,
      status:      'published',
      publishedAt: now,
      publishedBy: actor,
      updatedAt:   now
    }
    this.rules.set(`${ruleId}:${version}`, published)

    return { published, deprecated }
  }

  async rollbackRule(ruleId: string, targetVersion: number, actor: string, reason: string): Promise<{
    restored: SerializedRule
    deprecated: SerializedRule
  }> {
    const target  = this.rules.get(`${ruleId}:${targetVersion}`)
    if (!target) throw new RuleNotFoundError(`Rule "${ruleId}" version ${targetVersion} not found`)

    // Déprécier la version courante publiée
    const current = [...this.rules.values()]
      .find(r => r.id === ruleId && r.status === 'published')
    if (!current) throw new RuleNotFoundError(`No published version of rule "${ruleId}" found`)

    const now = new Date().toISOString()

    const deprecated: SerializedRule = {
      ...current, status: 'deprecated',
      deprecatedAt: now, deprecatedBy: actor, updatedAt: now
    }
    this.rules.set(`${current.id}:${current.version}`, deprecated)

    const restored: SerializedRule = {
      ...target, status: 'published',
      publishedAt: now, publishedBy: actor, updatedAt: now
    }
    this.rules.set(`${ruleId}:${targetVersion}`, restored)

    // Audit: NOT logged here — RuleManager.emergencyRollback() handles audit logging.
    // See audit responsibility note at class level.

    return { restored, deprecated }
  }

  // ─── Audit trail ────────────────────────────────────────────────────────────

  async recordAuditEvent(event: RuleAuditEvent): Promise<void> {
    const trail = this.auditTrail.get(event.ruleId) ?? []
    trail.push(event)
    this.auditTrail.set(event.ruleId, trail)
  }

  async getAuditTrail(ruleId: string): Promise<RuleAuditEvent[]> {
    return [...(this.auditTrail.get(ruleId) ?? [])]
  }

  // ─── Conflits ───────────────────────────────────────────────────────────────

  async detectConflicts(candidate: RuleInput): Promise<RuleConflict[]> {
    const conflicts: RuleConflict[] = []

    for (const existing of this.rules.values()) {
      if (existing.status !== 'published') continue
      if (existing.tenantId !== candidate.tenantId) continue
      if (existing.model !== candidate.model) continue
      if (existing.country !== candidate.country) continue

      if (!periodsOverlap(existing, candidate)) continue

      const overlapFrom  = maxDate(existing.effectiveFrom, candidate.effectiveFrom)
      const overlapUntil = minDate(existing.effectiveUntil, candidate.effectiveUntil)

      // Doublon exact
      if (sha256(existing.payload) === sha256(candidate.payload)) {
        conflicts.push({
          existingRuleId: existing.id, existingVersion: existing.version,
          existingStatus: existing.status, overlapFrom, overlapUntil,
          conflictType: 'duplicate_checksum', severity: 'critical',
          description: `Identical payload detected — possible duplicate of rule "${existing.id}" v${existing.version}`
        })
        continue
      }

      // Même priorité → arbitrage indéterministe
      if (existing.priority === (candidate.priority ?? 0)) {
        conflicts.push({
          existingRuleId: existing.id, existingVersion: existing.version,
          existingStatus: existing.status, overlapFrom, overlapUntil,
          conflictType: 'same_priority', severity: 'warning',
          description: `Both rules have priority ${existing.priority} on overlapping period. Core dominance resolver will arbitrate.`
        })
      } else {
        conflicts.push({
          existingRuleId: existing.id, existingVersion: existing.version,
          existingStatus: existing.status, overlapFrom, overlapUntil,
          conflictType: 'period_overlap', severity: 'warning',
          description: `Period overlap with rule "${existing.id}" v${existing.version}. Higher priority rule will take precedence.`
        })
      }
    }

    return conflicts
  }

  // ─── Scopes partagés ────────────────────────────────────────────────────────

  async listSharedRules(region: string, model?: string): Promise<SerializedRule[]> {
    return [...this.rules.values()].filter(r =>
      r.scope === 'shared' &&
      r.region === region &&
      r.status === 'published' &&
      (!model || r.model === model)
    )
  }
}

// ─── Constantes internes ──────────────────────────────────────────────────────

const ALLOWED_TRANSITIONS: Record<RuleStatus, RuleStatus[]> = {
  draft:      ['review', 'archived'],
  review:     ['published', 'draft'],
  published:  ['deprecated'],
  deprecated: ['archived'],
  archived:   []
}

const STATUS_TO_AUDIT_EVENT: Record<RuleStatus, RuleAuditEventType> = {
  draft:      'rule.sent_back_to_draft',
  review:     'rule.submitted_for_review',
  published:  'rule.published',
  deprecated: 'rule.deprecated',
  archived:   'rule.archived'
}

// ─── Utilitaires ──────────────────────────────────────────────────────────────

function periodsOverlap(
  a: { effectiveFrom: string; effectiveUntil: string | null },
  b: { effectiveFrom: string; effectiveUntil?: string | null }
): boolean {
  const aEnd = a.effectiveUntil ?? '9999-12-31'
  const bEnd = b.effectiveUntil ?? '9999-12-31'
  return a.effectiveFrom <= bEnd && b.effectiveFrom <= aEnd
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b
}

function minDate(a: string | null | undefined, b: string | null | undefined): string | undefined {
  if (!a && !b) return undefined
  if (!a) return b!
  if (!b) return a
  return a < b ? a : b
}

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function toMetadata(r: SerializedRule): RuleMetadata {
  return {
    id: r.id, version: r.version, model: r.model,
    tenantId: r.tenantId, country: r.country, scope: r.scope,
    status: r.status, effectiveFrom: r.effectiveFrom,
    effectiveUntil: r.effectiveUntil, priority: r.priority,
    tags: r.tags, description: r.description,
    createdBy: r.createdBy, createdAt: r.createdAt,
    publishedAt: r.publishedAt
  }
}
```

---

### 14.6 Erreurs supplémentaires à ajouter dans `errors.ts`

```ts
// Ajouter à la liste existante dans context-engine/src/errors.ts

export class RuleNotFoundError        extends ContextError {}
export class RuleVersionConflictError extends ContextError {}
export class RuleTransitionError      extends ContextError {}
export class RulePublishError         extends ContextError {}
```

---

### 14.7 Exports à ajouter dans `index.ts`

```ts
// Ajouter aux exports existants de context-engine/src/index.ts

// RuleStore — types étendus (ajouts v2.0)
export type {
  RuleStore,
  RuleQuery,
  RuleListQuery,
  SerializedRule,
  RuleMetadata,
  RuleInput,
  RuleStatus,
  RuleScope,
  RuleAuditEvent,
  RuleAuditEventType,
  RuleConflict,
  RuleConflictType
} from './stores/RuleStore'

// Erreurs supplémentaires
export {
  RuleNotFoundError,
  RuleVersionConflictError,
  RuleTransitionError,
  RulePublishError
} from './errors'
```

---

*Cette section remplace la section 14 du document context-engine-ARCHITECTURE v1.0.*
*Toutes les autres sections restent inchangées.*