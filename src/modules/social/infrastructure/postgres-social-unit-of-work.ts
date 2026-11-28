import { randomUUID } from "node:crypto";
import {
  withPgTransaction,
  type PgPool,
  type PgPoolClient,
} from "../../../shared/db/pool.js";
import {
  claimOrVerifyProcessedEvent,
  type ClaimProcessedEventInput,
  type ClaimProcessedEventResult,
} from "../../../shared/db/processed-events-inbox.js";
import {
  evaluateTitleConditionAst,
  validateTitleConditionAst,
  type CharacterTitleState,
  type TitleConditionNode,
  type TitleEvaluationSnapshot,
  type VersionedTitleDefinition,
} from "../../titles/domain/title-contracts.js";
import {
  DEFAULT_SOCIAL_RULES_V1,
  INITIAL_JURISDICTIONS_CATALOG,
  INITIAL_SOCIAL_REGIONS_CATALOG,
  INITIAL_TITLE_DEFINITIONS_CATALOG,
  REPRESENTATIVE_FACTIONS,
  REPRESENTATIVE_SETTLEMENTS,
} from "../catalog/initial-social-catalog.js";
import type {
  CharacterJurisdictionStanding,
  CriminalBounty,
  CriminalBountyClaim,
  CriminalJurisdictionDefinition,
  CriminalRecord,
  CriminalState,
  CriminalWarrant,
  SafeZoneAccessDecision,
} from "../domain/criminality-and-bounties.js";
import {
  SocialReferenceNotFoundError,
  SocialVersionConflictError,
} from "../domain/errors.js";
import type {
  CharacterRegionalStanding,
  CharacterScopedReputation,
  CharacterSocialStandingAggregate,
  ExternalIdentityLink,
  FactionRelationRule,
  MoralBandCode,
  MoralBandDefinition,
  ReputationScopeType,
  SocialRulesConfig,
} from "../domain/social-standing.js";

export type SocialOutboxEventType =
  | "MoralStandingAdjusted"
  | "FameGranted"
  | "ReputationAdjusted"
  | "CrimeRecorded"
  | "WarrantIssued"
  | "WarrantResolved"
  | "CriminalBountyCreated"
  | "CriminalBountyClaimed"
  | "HeroicAchievementRecorded"
  | "TitleUnlocked"
  | "TitleRevoked"
  | "TitleEquipped"
  | "HistoricalRecordCreated";

export type SocialLedgerDomainKind =
  | "moral_bounty"
  | "fame"
  | "reputation"
  | "crime"
  | "warrant"
  | "criminal_bounty"
  | "title"
  | "contribution_recognition"
  | "rehabilitation";

export interface SocialLedgerEntryInput {
  readonly characterId: string;
  readonly counterpartyAccountId?: string | null | undefined;
  readonly counterpartyCharacterId?: string | null | undefined;
  readonly domainKind: SocialLedgerDomainKind;
  readonly actionCode: string;
  readonly scopeKey: string;
  readonly previousValue?: bigint | null | undefined;
  readonly deltaValue?: bigint | null | undefined;
  readonly newValue?: bigint | null | undefined;
  readonly rulesVersion: number;
  readonly sourceEventId: string;
  readonly isCompensated?: boolean | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly occurredAt: Date;
}

export interface SocialLedgerRecord {
  readonly id: string;
  readonly ledgerSeq: bigint;
  readonly characterId: string;
  readonly counterpartyAccountId: string | null;
  readonly counterpartyCharacterId: string | null;
  readonly domainKind: SocialLedgerDomainKind;
  readonly actionCode: string;
  readonly scopeKey: string;
  readonly previousValue: bigint | null;
  readonly deltaValue: bigint | null;
  readonly newValue: bigint | null;
  readonly rulesVersion: number;
  readonly sourceEventId: string;
  readonly isCompensated: boolean;
  readonly metadata: Record<string, unknown>;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
}

export interface HistoricalSocialRecord {
  readonly id: string;
  readonly eventReference: string;
  readonly eventType: string;
  readonly characterId: string | null;
  readonly settlementId: string | null;
  readonly regionId: string | null;
  readonly factionId: string | null;
  readonly contributionRole: string;
  readonly visibility: "public_chronicle" | "regional_lore" | "restricted_archive";
  readonly summary: string;
  readonly rulesVersion: number;
  readonly recordedAt: Date;
}

function mapSocialAggregateRow(r: Record<string, unknown>): CharacterSocialStandingAggregate {
  return {
    characterId: String(r["character_id"]),
    moralBounty: BigInt(String(r["moral_bounty"])),
    moralBand: r["moral_band"] as MoralBandCode,
    severeCrimeCount: Number(r["severe_crime_count"]),
    globalFame: BigInt(String(r["global_fame"])),
    settlementDefensesCount: Number(r["settlement_defenses_count"]),
    settlementLiberationsCount: Number(r["settlement_liberations_count"]),
    validatedCrimesCount: Number(r["validated_crimes_count"]),
    bountiesFulfilledCount: Number(r["bounties_fulfilled_count"]),
    equippedTitleCode: (r["equipped_title_code"] as string | null) ?? null,
    rulesVersion: Number(r["rules_version"]),
    socialVersion: Number(r["social_version"]),
    updatedAt: r["updated_at"] as Date,
  };
}

function mapTitleDefinitionRow(r: Record<string, unknown>): VersionedTitleDefinition {
  return {
    titleCode: String(r["title_code"]),
    titleVersion: Number(r["title_version"]),
    displayName: String(r["display_name"]),
    description: String(r["description"]),
    category: r["category"] as VersionedTitleDefinition["category"],
    rarity: r["rarity"] as VersionedTitleDefinition["rarity"],
    persistenceMode: r["persistence_mode"] as VersionedTitleDefinition["persistenceMode"],
    exclusivityScope: r["exclusivity_scope"] as VersionedTitleDefinition["exclusivityScope"],
    visibility: r["visibility"] as VersionedTitleDefinition["visibility"],
    stackabilityPolicy: "single_unlock",
    revocable: Boolean(r["revocable"]),
    isEnabled: Boolean(r["is_enabled"]),
    originSummary: String(r["origin_summary"]),
    requirements: r["requirements"] as TitleConditionNode,
    rulesVersion: Number(r["rules_version"]),
  };
}

function mapCriminalBountyRow(r: Record<string, unknown>): CriminalBounty {
  return {
    id: String(r["id"]),
    targetCharacterId: String(r["target_character_id"]),
    issuingAuthorityId: String(r["issuing_authority_id"]),
    jurisdictionId: String(r["jurisdiction_id"]),
    warrantId: (r["warrant_id"] as string | null) ?? null,
    sourceCrimeId: String(r["source_crime_id"]),
    rewardAmount: BigInt(String(r["reward_amount"])),
    currencyCode: String(r["currency_code"]),
    fundingStatus: r["funding_status"] as CriminalBounty["fundingStatus"],
    fundingReference: (r["funding_reference"] as string | null) ?? null,
    status: r["status"] as CriminalBounty["status"],
    rulesVersion: Number(r["rules_version"]),
    version: Number(r["version"]),
    createdAt: r["created_at"] as Date,
    updatedAt: r["updated_at"] as Date,
  };
}

export class PgSocialTransactionScope {
  public readonly client: PgPoolClient;

  constructor(client: PgPoolClient) {
    this.client = client;
  }

  public async claimOrVerifyEvent(
    input: ClaimProcessedEventInput,
  ): Promise<ClaimProcessedEventResult> {
    return claimOrVerifyProcessedEvent(this.client, input);
  }

  public async loadSocialRules(rulesVersion: number): Promise<SocialRulesConfig> {
    const res = await this.client.query(
      "SELECT * FROM social_rules_versions WHERE rules_version = $1 AND is_active = TRUE",
      [rulesVersion],
    );
    const r = res.rows[0] as Record<string, unknown> | undefined;
    if (!r) {
      throw new SocialReferenceNotFoundError("SocialRulesVersion", String(rulesVersion));
    }
    const rawBands = r["moral_bands"] as Array<{
      bandCode: MoralBandCode;
      displayName: string;
      ordinal: number;
      minInclusive: string;
      maxInclusive: string;
    }>;
    const moralBands: MoralBandDefinition[] = rawBands.map((b) => ({
      bandCode: b.bandCode,
      displayName: b.displayName,
      ordinal: b.ordinal,
      minInclusive: BigInt(b.minInclusive),
      maxInclusive: BigInt(b.maxInclusive),
    }));

    return {
      rulesVersion: Number(r["rules_version"]),
      code: String(r["code"]),
      moralBountyMin: BigInt(String(r["moral_bounty_min"])),
      moralBountyMax: BigInt(String(r["moral_bounty_max"])),
      moralBandHysteresis: BigInt(String(r["moral_band_hysteresis"])),
      severeCrimeCapBand: r["severe_crime_cap_band"] as MoralBandCode,
      fameMax: BigInt(String(r["fame_max"])),
      reputationMin: Number(r["reputation_min"]),
      reputationMax: Number(r["reputation_max"]),
      moralBands,
      antiAbuseCooldownSeconds: Number(r["anti_abuse_cooldown_seconds"]),
      antiAbuseWindowSeconds: Number(r["anti_abuse_window_seconds"]),
      antiAbuseMaxEventsPerWindow: Number(r["anti_abuse_max_events_per_window"]),
      diminishingReturnsStepBp: Number(r["diminishing_returns_step_bp"]),
    };
  }

  public async assertRegionExists(regionId: string): Promise<void> {
    const res = await this.client.query(
      "SELECT 1 FROM social_regions WHERE region_id = $1 AND is_enabled = TRUE",
      [regionId],
    );
    if ((res.rowCount ?? 0) === 0) {
      throw new SocialReferenceNotFoundError("SocialRegion", regionId);
    }
  }

  public async assertFactionExists(factionId: string): Promise<{ code: string }> {
    const res = await this.client.query<{ code: string }>(
      "SELECT code FROM factions WHERE id = $1",
      [factionId],
    );
    if (!res.rows[0]) {
      throw new SocialReferenceNotFoundError("Faction", factionId);
    }
    return res.rows[0];
  }

  public async assertSettlementExists(
    settlementId: string,
  ): Promise<{ externalId: string; regionId: string; controllingFactionId: string | null }> {
    const res = await this.client.query<{
      external_id: string | null;
      region_id: string;
      controlling_faction_id: string | null;
    }>(
      "SELECT external_id, region_id, controlling_faction_id FROM settlements WHERE id = $1",
      [settlementId],
    );
    const row = res.rows[0];
    if (!row) {
      throw new SocialReferenceNotFoundError("Settlement", settlementId);
    }
    return {
      externalId: row.external_id ?? settlementId,
      regionId: row.region_id,
      controllingFactionId: row.controlling_faction_id,
    };
  }

  public async findJurisdiction(
    jurisdictionId: string,
  ): Promise<CriminalJurisdictionDefinition> {
    const res = await this.client.query(
      "SELECT * FROM criminal_jurisdictions WHERE jurisdiction_id = $1",
      [jurisdictionId],
    );
    const r = res.rows[0] as Record<string, unknown> | undefined;
    if (!r) {
      throw new SocialReferenceNotFoundError("CriminalJurisdiction", jurisdictionId);
    }
    return {
      jurisdictionId: String(r["jurisdiction_id"]),
      displayName: String(r["display_name"]),
      regionId: String(r["region_id"]),
      controllingFactionId: (r["controlling_faction_id"] as string | null) ?? null,
      settlementId: (r["settlement_id"] as string | null) ?? null,
      lawProfile: r["law_profile"] as CriminalJurisdictionDefinition["lawProfile"],
      consensualDuelExempt: Boolean(r["consensual_duel_exempt"]),
      arenaCombatExempt: Boolean(r["arena_combat_exempt"]),
      recognizedWarExempt: Boolean(r["recognized_war_exempt"]),
      selfDefenseExempt: Boolean(r["self_defense_exempt"]),
      unlawfulAttackMoralDelta: BigInt(String(r["unlawful_attack_moral_delta"])),
      unlawfulKillMoralDelta: BigInt(String(r["unlawful_kill_moral_delta"])),
      theftMoralDelta: BigInt(String(r["theft_moral_delta"])),
      autoWarrantMinSeverity:
        r["auto_warrant_min_severity"] as CriminalJurisdictionDefinition["autoWarrantMinSeverity"],
      rulesVersion: Number(r["rules_version"]),
    };
  }

  public async ensureAndLockSocialStanding(
    characterId: string,
  ): Promise<CharacterSocialStandingAggregate> {
    await this.client.query(
      `INSERT INTO character_social_standing (character_id)
       VALUES ($1::uuid)
       ON CONFLICT (character_id) DO NOTHING`,
      [characterId],
    );
    const res = await this.client.query(
      "SELECT * FROM character_social_standing WHERE character_id = $1::uuid FOR UPDATE",
      [characterId],
    );
    return mapSocialAggregateRow(res.rows[0] as Record<string, unknown>);
  }

  public async updateSocialStanding(
    updated: CharacterSocialStandingAggregate,
    expectedPreviousSocialVersion: number,
  ): Promise<void> {
    const res = await this.client.query(
      `UPDATE character_social_standing
       SET moral_bounty = $1::bigint,
           moral_band = $2,
           severe_crime_count = $3,
           global_fame = $4::bigint,
           settlement_defenses_count = $5,
           settlement_liberations_count = $6,
           validated_crimes_count = $7,
           bounties_fulfilled_count = $8,
           equipped_title_code = $9,
           rules_version = $10,
           social_version = $11,
           updated_at = $12
       WHERE character_id = $13::uuid AND social_version = $14`,
      [
        updated.moralBounty.toString(),
        updated.moralBand,
        updated.severeCrimeCount,
        updated.globalFame.toString(),
        updated.settlementDefensesCount,
        updated.settlementLiberationsCount,
        updated.validatedCrimesCount,
        updated.bountiesFulfilledCount,
        updated.equippedTitleCode,
        updated.rulesVersion,
        updated.socialVersion,
        updated.updatedAt,
        updated.characterId,
        expectedPreviousSocialVersion,
      ],
    );
    if (res.rowCount !== 1) {
      throw new SocialVersionConflictError(
        `CharacterSocialStanding(${updated.characterId})`,
        expectedPreviousSocialVersion,
        updated.socialVersion,
      );
    }
  }

  public async ensureAndLockRegionalStanding(
    characterId: string,
    regionId: string,
  ): Promise<CharacterRegionalStanding> {
    await this.assertRegionExists(regionId);
    await this.client.query(
      `INSERT INTO character_regional_standing (character_id, region_id)
       VALUES ($1::uuid, $2)
       ON CONFLICT (character_id, region_id) DO NOTHING`,
      [characterId, regionId],
    );
    const res = await this.client.query(
      `SELECT * FROM character_regional_standing
       WHERE character_id = $1::uuid AND region_id = $2
       FOR UPDATE`,
      [characterId, regionId],
    );
    const r = res.rows[0] as Record<string, unknown>;
    return {
      characterId: String(r["character_id"]),
      regionId: String(r["region_id"]),
      regionalMoralBounty: BigInt(String(r["regional_moral_bounty"])),
      regionalFame: BigInt(String(r["regional_fame"])),
      version: Number(r["version"]),
      updatedAt: r["updated_at"] as Date,
    };
  }

  public async updateRegionalStanding(
    updated: CharacterRegionalStanding,
    expectedVersion: number,
  ): Promise<void> {
    const res = await this.client.query(
      `UPDATE character_regional_standing
       SET regional_moral_bounty = $1::bigint,
           regional_fame = $2::bigint,
           version = $3,
           updated_at = $4
       WHERE character_id = $5::uuid AND region_id = $6 AND version = $7`,
      [
        updated.regionalMoralBounty.toString(),
        updated.regionalFame.toString(),
        updated.version,
        updated.updatedAt,
        updated.characterId,
        updated.regionId,
        expectedVersion,
      ],
    );
    if (res.rowCount !== 1) {
      throw new SocialVersionConflictError(
        `RegionalStanding(${updated.characterId},${updated.regionId})`,
        expectedVersion,
        updated.version,
      );
    }
  }

  public async lockOrInitializeScopedReputation(params: {
    readonly characterId: string;
    readonly scopeType: ReputationScopeType;
    readonly scopeId: string;
    readonly rulesVersion: number;
  }): Promise<CharacterScopedReputation> {
    let factionId: string | null = null;
    let settlementId: string | null = null;
    let regionId: string | null = null;

    if (params.scopeType === "faction") {
      await this.assertFactionExists(params.scopeId);
      factionId = params.scopeId;
    } else if (params.scopeType === "settlement") {
      await this.assertSettlementExists(params.scopeId);
      settlementId = params.scopeId;
    } else {
      await this.assertRegionExists(params.scopeId);
      regionId = params.scopeId;
    }

    await this.client.query(
      `INSERT INTO character_reputations (
         id, character_id, scope_type, scope_id,
         faction_id, settlement_id, region_id,
         standing_value, rules_version, version
       )
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::uuid, $7, 0, $8, 1)
       ON CONFLICT (character_id, scope_type, scope_id) DO NOTHING`,
      [
        randomUUID(),
        params.characterId,
        params.scopeType,
        params.scopeId,
        factionId,
        settlementId,
        regionId,
        params.rulesVersion,
      ],
    );

    const res = await this.client.query(
      `SELECT * FROM character_reputations
       WHERE character_id = $1::uuid AND scope_type = $2 AND scope_id = $3
       FOR UPDATE`,
      [params.characterId, params.scopeType, params.scopeId],
    );
    const r = res.rows[0] as Record<string, unknown>;
    return {
      id: String(r["id"]),
      characterId: String(r["character_id"]),
      scopeType: r["scope_type"] as ReputationScopeType,
      scopeId: String(r["scope_id"]),
      factionId: (r["faction_id"] as string | null) ?? null,
      settlementId: (r["settlement_id"] as string | null) ?? null,
      regionId: (r["region_id"] as string | null) ?? null,
      standingValue: Number(r["standing_value"]),
      rulesVersion: Number(r["rules_version"]),
      version: Number(r["version"]),
      updatedAt: r["updated_at"] as Date,
    };
  }

  public async updateScopedReputation(
    updated: CharacterScopedReputation,
    expectedVersion: number,
  ): Promise<void> {
    const res = await this.client.query(
      `UPDATE character_reputations
       SET standing_value = $1,
           rules_version = $2,
           version = $3,
           updated_at = $4
       WHERE id = $5::uuid AND version = $6`,
      [
        updated.standingValue,
        updated.rulesVersion,
        updated.version,
        updated.updatedAt,
        updated.id,
        expectedVersion,
      ],
    );
    if (res.rowCount !== 1) {
      throw new SocialVersionConflictError(
        `CharacterReputation(${updated.id})`,
        expectedVersion,
        updated.version,
      );
    }
  }

  public async listDirectFactionRelations(
    sourceFactionId: string,
  ): Promise<ReadonlyArray<FactionRelationRule>> {
    const res = await this.client.query(
      `SELECT * FROM faction_relations
       WHERE source_faction_id = $1::uuid
       ORDER BY target_faction_id ASC`,
      [sourceFactionId],
    );
    return res.rows.map((r: Record<string, unknown>) => ({
      sourceFactionId: String(r["source_faction_id"]),
      targetFactionId: String(r["target_faction_id"]),
      relationState: r["relation_state"] as FactionRelationRule["relationState"],
      propagationBp: Number(r["propagation_bp"]),
      rulesVersion: Number(r["rules_version"]),
    }));
  }

  public async ensureAndLockJurisdictionStatus(
    characterId: string,
    jurisdictionId: string,
  ): Promise<CharacterJurisdictionStanding> {
    await this.findJurisdiction(jurisdictionId);
    await this.client.query(
      `INSERT INTO character_jurisdiction_status (character_id, jurisdiction_id)
       VALUES ($1::uuid, $2)
       ON CONFLICT (character_id, jurisdiction_id) DO NOTHING`,
      [characterId, jurisdictionId],
    );
    const res = await this.client.query(
      `SELECT * FROM character_jurisdiction_status
       WHERE character_id = $1::uuid AND jurisdiction_id = $2
       FOR UPDATE`,
      [characterId, jurisdictionId],
    );
    const r = res.rows[0] as Record<string, unknown>;
    return {
      characterId: String(r["character_id"]),
      jurisdictionId: String(r["jurisdiction_id"]),
      criminalState: r["criminal_state"] as CriminalState,
      safeZoneAccess: r["safe_zone_access"] as SafeZoneAccessDecision,
      activeWarrantsCount: Number(r["active_warrants_count"]),
      version: Number(r["version"]),
      updatedAt: r["updated_at"] as Date,
    };
  }

  public async updateJurisdictionStatus(
    updated: CharacterJurisdictionStanding,
    expectedVersion: number,
  ): Promise<void> {
    const res = await this.client.query(
      `UPDATE character_jurisdiction_status
       SET criminal_state = $1,
           safe_zone_access = $2,
           active_warrants_count = $3,
           version = $4,
           updated_at = $5
       WHERE character_id = $6::uuid AND jurisdiction_id = $7 AND version = $8`,
      [
        updated.criminalState,
        updated.safeZoneAccess,
        updated.activeWarrantsCount,
        updated.version,
        updated.updatedAt,
        updated.characterId,
        updated.jurisdictionId,
        expectedVersion,
      ],
    );
    if (res.rowCount !== 1) {
      throw new SocialVersionConflictError(
        `JurisdictionStatus(${updated.characterId},${updated.jurisdictionId})`,
        expectedVersion,
        updated.version,
      );
    }
  }

  public async countWindowEventsAndLatestCooldown(params: {
    readonly characterId: string;
    readonly domainKind: SocialLedgerDomainKind;
    readonly scopeKey: string;
    readonly windowSeconds: number;
    readonly now: Date;
  }): Promise<{
    readonly countInWindow: number;
    readonly latestOccurredAt: Date | null;
  }> {
    const windowStart = new Date(params.now.getTime() - params.windowSeconds * 1000);
    const res = await this.client.query<{
      cnt: string;
      latest: Date | null;
    }>(
      `SELECT
         COUNT(*)::text AS cnt,
         MAX(occurred_at) AS latest
       FROM social_standing_ledger
       WHERE character_id = $1::uuid
         AND domain_kind = $2
         AND scope_key = $3
         AND occurred_at >= $4`,
      [params.characterId, params.domainKind, params.scopeKey, windowStart],
    );
    return {
      countInWindow: Number(res.rows[0]?.cnt ?? "0"),
      latestOccurredAt: res.rows[0]?.latest ?? null,
    };
  }

  public async appendSocialLedger(entry: SocialLedgerEntryInput): Promise<void> {
    await this.client.query(
      `INSERT INTO social_standing_ledger (
         id, character_id, counterparty_account_id, counterparty_character_id,
         domain_kind, action_code, scope_key,
         previous_value, delta_value, new_value,
         rules_version, source_event_id, is_compensated, metadata, occurred_at
       )
       VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         $5, $6, $7,
         $8::bigint, $9::bigint, $10::bigint,
         $11, $12, $13, $14::jsonb, $15
       )`,
      [
        randomUUID(),
        entry.characterId,
        entry.counterpartyAccountId ?? null,
        entry.counterpartyCharacterId ?? null,
        entry.domainKind,
        entry.actionCode,
        entry.scopeKey,
        entry.previousValue !== undefined && entry.previousValue !== null
          ? entry.previousValue.toString()
          : null,
        entry.deltaValue !== undefined && entry.deltaValue !== null
          ? entry.deltaValue.toString()
          : null,
        entry.newValue !== undefined && entry.newValue !== null
          ? entry.newValue.toString()
          : null,
        entry.rulesVersion,
        entry.sourceEventId,
        entry.isCompensated ?? false,
        JSON.stringify(entry.metadata ?? {}),
        entry.occurredAt,
      ],
    );
  }

  public async enqueueOutbox(params: {
    readonly aggregateType: "CharacterSocialStanding" | "CriminalBounty" | "TitleExclusivity" | "WorldHistory";
    readonly aggregateId: string;
    readonly eventType: SocialOutboxEventType;
    readonly correlationUuid: string;
    readonly causationEventUuid: string;
    readonly payload: Record<string, unknown>;
    readonly occurredAt: Date;
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO outbox_events (
         id, aggregate_type, aggregate_id, event_type, event_version,
         correlation_id, causation_event_id, payload, occurred_at
       )
       VALUES ($1::uuid, $2, $3::uuid, $4, 1, $5::uuid, $6::uuid, $7::jsonb, $8)`,
      [
        randomUUID(),
        params.aggregateType,
        params.aggregateId,
        params.eventType,
        params.correlationUuid,
        params.causationEventUuid,
        JSON.stringify(params.payload),
        params.occurredAt,
      ],
    );
  }

  public async findTitleDefinition(titleCode: string): Promise<VersionedTitleDefinition | null> {
    const res = await this.client.query(
      "SELECT * FROM title_definitions WHERE title_code = $1",
      [titleCode],
    );
    const r = res.rows[0] as Record<string, unknown> | undefined;
    return r ? mapTitleDefinitionRow(r) : null;
  }

  public async buildTitleEvaluationSnapshot(
    characterId: string,
    social: CharacterSocialStandingAggregate,
  ): Promise<TitleEvaluationSnapshot> {
    const repMap = new Map<string, number>();

    const repsRes = await this.client.query<{
      scope_type: ReputationScopeType;
      scope_id: string;
      standing_value: number;
      faction_code: string | null;
      settlement_external_id: string | null;
    }>(
      `SELECT
         cr.scope_type,
         cr.scope_id,
         cr.standing_value,
         f.code AS faction_code,
         s.external_id AS settlement_external_id
       FROM character_reputations cr
       LEFT JOIN factions f ON f.id = cr.faction_id
       LEFT JOIN settlements s ON s.id = cr.settlement_id
       WHERE cr.character_id = $1::uuid`,
      [characterId],
    );

    for (const r of repsRes.rows) {
      repMap.set(`${r.scope_type}:${r.scope_id}`, r.standing_value);
      if (r.faction_code) {
        repMap.set(`faction:${r.faction_code}`, r.standing_value);
      }
      if (r.settlement_external_id) {
        repMap.set(`settlement:${r.settlement_external_id}`, r.standing_value);
      }
    }

    const histRes = await this.client.query<{
      event_type: string;
      settlement_external_id: string | null;
    }>(
      `SELECT
         h.event_type,
         s.external_id AS settlement_external_id
       FROM historical_social_records h
       LEFT JOIN settlements s ON s.id = h.settlement_id
       WHERE h.character_id = $1::uuid`,
      [characterId],
    );

    const defensesBySettlement = new Map<string, number>();
    const liberationsBySettlement = new Map<string, number>();
    const histKeys = new Set<string>();

    for (const h of histRes.rows) {
      histKeys.add(h.event_type);
      if (h.settlement_external_id) {
        histKeys.add(`${h.event_type}@${h.settlement_external_id}`);
        if (h.event_type === "SettlementDefended") {
          defensesBySettlement.set(
            h.settlement_external_id,
            (defensesBySettlement.get(h.settlement_external_id) ?? 0) + 1,
          );
        }
        if (h.event_type === "SettlementLiberated") {
          liberationsBySettlement.set(
            h.settlement_external_id,
            (liberationsBySettlement.get(h.settlement_external_id) ?? 0) + 1,
          );
        }
      }
    }

    const weaponMasteryByFamily = new Map<string, number>();
    const activeLearnedAbilitiesBySchool = new Map<string, number>();
    const activeSpecNodesBySchool = new Map<string, number>();
    let activeLearnedAbilitiesCount = 0;

    const hasMasteryTablesRes = await this.client.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = 'character_weapon_masteries'
       ) AS present`,
    );

    if (hasMasteryTablesRes.rows[0]?.present === true) {
      const mastRes = await this.client.query<{
        weapon_family_code: string;
        mastery_level: number;
      }>(
        `SELECT weapon_family_code, mastery_level
         FROM character_weapon_masteries
         WHERE character_id = $1::uuid`,
        [characterId],
      );
      for (const m of mastRes.rows) {
        weaponMasteryByFamily.set(m.weapon_family_code, Number(m.mastery_level));
      }

      const abRes = await this.client.query<{ school_code: string; cnt: string }>(
        `SELECT ad.school_code, COUNT(*)::text AS cnt
         FROM character_learned_abilities cla
         INNER JOIN ability_definitions ad
           ON ad.ability_code = cla.ability_code AND ad.ability_version = cla.ability_version
         WHERE cla.character_id = $1::uuid AND cla.is_active = TRUE
         GROUP BY ad.school_code`,
        [characterId],
      );
      for (const ar of abRes.rows) {
        const c = Number(ar.cnt);
        activeLearnedAbilitiesBySchool.set(ar.school_code, c);
        activeLearnedAbilitiesCount += c;
      }

      const specRes = await this.client.query<{ school_code: string; cnt: string }>(
        `SELECT sn.school_code, COUNT(*)::text AS cnt
         FROM character_specialization_unlocks csu
         INNER JOIN specialization_nodes sn ON sn.node_code = csu.node_code
         WHERE csu.character_id = $1::uuid AND csu.is_active = TRUE
         GROUP BY sn.school_code`,
        [characterId],
      );
      for (const sr of specRes.rows) {
        activeSpecNodesBySchool.set(sr.school_code, Number(sr.cnt));
      }
    }

    const professionsByCode = new Map<
      string,
      { readonly level: number; readonly craftsCompleted: number }
    >();
    const hasProfessionsRes = await this.client.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = 'character_professions'
       ) AS present`,
    );
    if (hasProfessionsRes.rows[0]?.present === true) {
      const profRes = await this.client.query<{
        profession_code: string;
        profession_level: number;
        crafts_completed_count: number;
      }>(
        `SELECT profession_code, profession_level, crafts_completed_count
         FROM character_professions
         WHERE character_id = $1::uuid`,
        [characterId],
      );
      for (const pr of profRes.rows) {
        professionsByCode.set(pr.profession_code, {
          level: Number(pr.profession_level),
          craftsCompleted: Number(pr.crafts_completed_count),
        });
      }
    }

    const verifiedMarketSalesByCurrency = new Map<
      string,
      { readonly distinctAccountSalesCount: number; readonly distinctAccountGrossVolume: bigint }
    >();
    const hasMarketSalesRes = await this.client.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = 'market_sales'
       ) AS present`,
    );
    if (hasMarketSalesRes.rows[0]?.present === true) {
      // Strictly exclude same-account self-dealing (`is_same_account = FALSE`) per Section 28!
      const salesRes = await this.client.query<{
        currency_code: string;
        cnt: string;
        vol: string;
      }>(
        `SELECT
           currency_code,
           COUNT(*)::text AS cnt,
           COALESCE(SUM(gross_amount), 0)::text AS vol
         FROM market_sales
         WHERE seller_character_id = $1::uuid
           AND is_same_account = FALSE
         GROUP BY currency_code`,
        [characterId],
      );
      for (const s of salesRes.rows) {
        verifiedMarketSalesByCurrency.set(s.currency_code, {
          distinctAccountSalesCount: Number(s.cnt),
          distinctAccountGrossVolume: BigInt(s.vol),
        });
      }
    }

    return {
      moralBounty: social.moralBounty,
      globalFame: social.globalFame,
      settlementDefensesCount: social.settlementDefensesCount,
      settlementLiberationsCount: social.settlementLiberationsCount,
      validatedCrimesCount: social.validatedCrimesCount,
      bountiesFulfilledCount: social.bountiesFulfilledCount,
      reputationsByLogicalKey: repMap,
      defensesBySettlementExternalId: defensesBySettlement,
      liberationsBySettlementExternalId: liberationsBySettlement,
      historicalAchievementKeys: histKeys,
      weaponMasteryByFamily,
      activeLearnedAbilitiesCount,
      activeLearnedAbilitiesBySchool,
      activeSpecNodesBySchool,
      professionsByCode,
      verifiedMarketSalesByCurrency,
    };
  }

  /**
   * Reconciles all `ConditionalStanding` titles already unlocked by `characterId`.
   * If a condition ceases to hold (e.g. exemplary citizen commits a crime), transitions
   * the title to `'inactive_conditional'` (never erasing history!) and unequips it if worn.
   */
  public async reconcileConditionalTitles(params: {
    readonly social: CharacterSocialStandingAggregate;
    readonly causeEventId: string;
    readonly correlationUuid: string;
    readonly causationEventUuid: string;
    readonly now: Date;
  }): Promise<CharacterSocialStandingAggregate> {
    const unlockedRes = await this.client.query<{
      id: string;
      title_code: string;
      state: CharacterTitleState["state"];
      version: number;
    }>(
      `SELECT ct.id, ct.title_code, ct.state, ct.version
       FROM character_titles ct
       INNER JOIN title_definitions td ON td.title_code = ct.title_code
       WHERE ct.character_id = $1::uuid
         AND td.persistence_mode = 'ConditionalStanding'
         AND ct.state IN ('active', 'inactive_conditional')
       FOR UPDATE OF ct`,
      [params.social.characterId],
    );

    if (unlockedRes.rows.length === 0) {
      return params.social;
    }

    const evalSnap = await this.buildTitleEvaluationSnapshot(
      params.social.characterId,
      params.social,
    );
    let currentSocial = params.social;

    for (const row of unlockedRes.rows) {
      const def = await this.findTitleDefinition(row.title_code);
      if (!def || !def.isEnabled) {
        continue;
      }
      const holds = evaluateTitleConditionAst(def.requirements, evalSnap);

      if (row.state === "active" && !holds) {
        await this.client.query(
          `UPDATE character_titles
           SET state = 'inactive_conditional', version = version + 1, updated_at = $1
           WHERE id = $2::uuid`,
          [params.now, row.id],
        );
        await this.client.query(
          `INSERT INTO character_title_history (id, character_id, title_code, action, cause_event_id, correlation_id, recorded_at)
           VALUES ($1::uuid, $2::uuid, $3, 'deactivated_conditional', $4, $5::uuid, $6)`,
          [
            randomUUID(),
            currentSocial.characterId,
            row.title_code,
            params.causeEventId,
            params.correlationUuid,
            params.now,
          ],
        );

        if (currentSocial.equippedTitleCode === row.title_code) {
          const prevVer = currentSocial.socialVersion;
          currentSocial = {
            ...currentSocial,
            equippedTitleCode: null,
            socialVersion: prevVer + 1,
            updatedAt: params.now,
          };
          await this.updateSocialStanding(currentSocial, prevVer);
          await this.client.query(
            `INSERT INTO character_title_history (id, character_id, title_code, action, cause_event_id, correlation_id, recorded_at)
             VALUES ($1::uuid, $2::uuid, $3, 'unequipped', $4, $5::uuid, $6)`,
            [
              randomUUID(),
              currentSocial.characterId,
              row.title_code,
              params.causeEventId,
              params.correlationUuid,
              params.now,
            ],
          );
        }

        await this.enqueueOutbox({
          aggregateType: "CharacterSocialStanding",
          aggregateId: currentSocial.characterId,
          eventType: "TitleRevoked",
          correlationUuid: params.correlationUuid,
          causationEventUuid: params.causationEventUuid,
          occurredAt: params.now,
          payload: {
            character_id: currentSocial.characterId,
            title_code: row.title_code,
            reason: "conditional_standing_unmet",
          },
        });
      } else if (row.state === "inactive_conditional" && holds) {
        await this.client.query(
          `UPDATE character_titles
           SET state = 'active', version = version + 1, updated_at = $1
           WHERE id = $2::uuid`,
          [params.now, row.id],
        );
        await this.client.query(
          `INSERT INTO character_title_history (id, character_id, title_code, action, cause_event_id, correlation_id, recorded_at)
           VALUES ($1::uuid, $2::uuid, $3, 'activated', $4, $5::uuid, $6)`,
          [
            randomUUID(),
            currentSocial.characterId,
            row.title_code,
            params.causeEventId,
            params.correlationUuid,
            params.now,
          ],
        );
      }
    }

    return currentSocial;
  }

  public async lockCriminalBounty(bountyId: string): Promise<CriminalBounty | null> {
    const res = await this.client.query(
      "SELECT * FROM criminal_bounties WHERE id = $1::uuid FOR UPDATE",
      [bountyId],
    );
    const r = res.rows[0] as Record<string, unknown> | undefined;
    return r ? mapCriminalBountyRow(r) : null;
  }
}

export class PostgresSocialUnitOfWork {
  private readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  public async executeInTransaction<T>(
    work: (scope: PgSocialTransactionScope) => Promise<T>,
  ): Promise<T> {
    return withPgTransaction(this.pool, async (client) => {
      const scope = new PgSocialTransactionScope(client);
      return work(scope);
    });
  }
}

export class PostgresSocialRepository {
  private readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  public async seedInitialSocialCatalogs(
    rules: SocialRulesConfig = DEFAULT_SOCIAL_RULES_V1,
  ): Promise<void> {
    const serializedBands = rules.moralBands.map((b) => ({
      bandCode: b.bandCode,
      displayName: b.displayName,
      ordinal: b.ordinal,
      minInclusive: b.minInclusive.toString(),
      maxInclusive: b.maxInclusive.toString(),
    }));

    await this.pool.query(
      `INSERT INTO social_rules_versions (
         rules_version, code, moral_bounty_min, moral_bounty_max,
         moral_band_hysteresis, severe_crime_cap_band,
         fame_max, reputation_min, reputation_max, moral_bands,
         anti_abuse_cooldown_seconds, anti_abuse_window_seconds,
         anti_abuse_max_events_per_window, diminishing_returns_step_bp, is_active
       )
       VALUES ($1, $2, $3::bigint, $4::bigint, $5::bigint, $6, $7::bigint, $8, $9, $10::jsonb, $11, $12, $13, $14, TRUE)
       ON CONFLICT (rules_version) DO UPDATE
         SET moral_bounty_min = EXCLUDED.moral_bounty_min,
             moral_bounty_max = EXCLUDED.moral_bounty_max,
             moral_band_hysteresis = EXCLUDED.moral_band_hysteresis,
             moral_bands = EXCLUDED.moral_bands`,
      [
        rules.rulesVersion,
        rules.code,
        rules.moralBountyMin.toString(),
        rules.moralBountyMax.toString(),
        rules.moralBandHysteresis.toString(),
        rules.severeCrimeCapBand,
        rules.fameMax.toString(),
        rules.reputationMin,
        rules.reputationMax,
        JSON.stringify(serializedBands),
        rules.antiAbuseCooldownSeconds,
        rules.antiAbuseWindowSeconds,
        rules.antiAbuseMaxEventsPerWindow,
        rules.diminishingReturnsStepBp,
      ],
    );

    for (const reg of INITIAL_SOCIAL_REGIONS_CATALOG) {
      await this.pool.query(
        `INSERT INTO social_regions (region_id, display_name, lawfulness_profile, description, is_enabled)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (region_id) DO NOTHING`,
        [reg.regionId, reg.displayName, reg.lawfulnessProfile, reg.description, reg.isEnabled],
      );
    }

    for (const fac of Object.values(REPRESENTATIVE_FACTIONS)) {
      await this.pool.query(
        `INSERT INTO factions (id, code, name, is_playable)
         VALUES ($1::uuid, $2, $3, $4)
         ON CONFLICT (code) DO NOTHING`,
        [fac.id, fac.code, fac.name, fac.isPlayable],
      );
    }

    // Resolve actual faction IDs by code (in case test DB already created one with same code)
    const facIdByCode = new Map<string, string>();
    const facRows = await this.pool.query<{ id: string; code: string }>(
      "SELECT id, code FROM factions",
    );
    for (const fr of facRows.rows) {
      facIdByCode.set(fr.code, fr.id);
    }

    const vwId = facIdByCode.get("valewatch_guard")!;
    const ifId = facIdByCode.get("ironforge_artisans")!;
    const tvId = facIdByCode.get("thornveil_syndicate")!;

    // Explicit single-hop faction relations:
    // Valewatch Guard <-> Ironforge Artisans (allied +25% propagation)
    // Valewatch Guard <-> Thornveil Syndicate (hostile -30% propagation)
    const defaultRelations: Array<{
      src: string;
      dst: string;
      state: FactionRelationRule["relationState"];
      bp: number;
    }> = [
      { src: vwId, dst: ifId, state: "allied", bp: 2500 },
      { src: ifId, dst: vwId, state: "allied", bp: 2500 },
      { src: vwId, dst: tvId, state: "hostile", bp: -3000 },
      { src: tvId, dst: vwId, state: "hostile", bp: -3000 },
    ];
    for (const rel of defaultRelations) {
      await this.pool.query(
        `INSERT INTO faction_relations (source_faction_id, target_faction_id, relation_state, propagation_bp, rules_version)
         VALUES ($1::uuid, $2::uuid, $3, $4, 1)
         ON CONFLICT (source_faction_id, target_faction_id) DO NOTHING`,
        [rel.src, rel.dst, rel.state, rel.bp],
      );
    }

    for (const st of Object.values(REPRESENTATIVE_SETTLEMENTS)) {
      const resolvedCtrl =
        st.externalId === "settlement-valewatch"
          ? vwId
          : st.externalId === "settlement-ironfang"
            ? ifId
            : tvId;
      await this.pool.query(
        `INSERT INTO settlements (id, external_id, name, region_id, state, defense_state, max_defense_hp, controlling_faction_id, version)
         VALUES ($1::uuid, $2, $3, $4, 'peaceful', 'Secure', 1000, $5::uuid, 1)
         ON CONFLICT (external_id) DO NOTHING`,
        [st.id, st.externalId, st.name, st.regionId, resolvedCtrl],
      );
    }

    const stIdByExt = new Map<string, string>();
    const stRows = await this.pool.query<{ id: string; external_id: string }>(
      "SELECT id, external_id FROM settlements WHERE external_id IS NOT NULL",
    );
    for (const sr of stRows.rows) {
      stIdByExt.set(sr.external_id, sr.id);
    }

    for (const jur of INITIAL_JURISDICTIONS_CATALOG) {
      const ctrlId =
        jur.jurisdictionId === "jur-ashvale-civic"
          ? vwId
          : jur.jurisdictionId === "jur-granite-guild"
            ? ifId
            : jur.jurisdictionId === "jur-thornveil-frontier"
              ? tvId
              : null;
      const stId =
        jur.jurisdictionId === "jur-ashvale-civic"
          ? (stIdByExt.get("settlement-valewatch") ?? null)
          : jur.jurisdictionId === "jur-granite-guild"
            ? (stIdByExt.get("settlement-ironfang") ?? null)
            : jur.jurisdictionId === "jur-thornveil-frontier"
              ? (stIdByExt.get("settlement-thornveil") ?? null)
              : null;

      await this.pool.query(
        `INSERT INTO criminal_jurisdictions (
           jurisdiction_id, display_name, region_id, controlling_faction_id, settlement_id,
           law_profile, consensual_duel_exempt, arena_combat_exempt, recognized_war_exempt,
           self_defense_exempt, unlawful_attack_moral_delta, unlawful_kill_moral_delta,
           theft_moral_delta, auto_warrant_min_severity, rules_version
         )
         VALUES ($1, $2, $3, $4::uuid, $5::uuid, $6, $7, $8, $9, $10, $11::bigint, $12::bigint, $13::bigint, $14, $15)
         ON CONFLICT (jurisdiction_id) DO NOTHING`,
        [
          jur.jurisdictionId,
          jur.displayName,
          jur.regionId,
          ctrlId,
          stId,
          jur.lawProfile,
          jur.consensualDuelExempt,
          jur.arenaCombatExempt,
          jur.recognizedWarExempt,
          jur.selfDefenseExempt,
          jur.unlawfulAttackMoralDelta.toString(),
          jur.unlawfulKillMoralDelta.toString(),
          jur.theftMoralDelta.toString(),
          jur.autoWarrantMinSeverity,
          jur.rulesVersion,
        ],
      );
    }

    for (const td of INITIAL_TITLE_DEFINITIONS_CATALOG) {
      validateTitleConditionAst(td.requirements);
      await this.pool.query(
        `INSERT INTO title_definitions (
           title_code, title_version, display_name, description, category, rarity,
           persistence_mode, exclusivity_scope, visibility, stackability_policy,
           revocable, is_enabled, origin_summary, requirements, rules_version
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)
         ON CONFLICT (title_code) DO NOTHING`,
        [
          td.titleCode,
          td.titleVersion,
          td.displayName,
          td.description,
          td.category,
          td.rarity,
          td.persistenceMode,
          td.exclusivityScope,
          td.visibility,
          td.stackabilityPolicy,
          td.revocable,
          td.isEnabled,
          td.originSummary,
          JSON.stringify(td.requirements),
          td.rulesVersion,
        ],
      );
    }
  }

  public async findFactionByCode(code: string): Promise<{ id: string; code: string; name: string } | null> {
    const res = await this.pool.query<{ id: string; code: string; name: string }>(
      "SELECT id, code, name FROM factions WHERE code = $1",
      [code],
    );
    return res.rows[0] ?? null;
  }

  public async findSettlementByExternalId(
    externalId: string,
  ): Promise<{ id: string; externalId: string; regionId: string; controllingFactionId: string | null } | null> {
    const res = await this.pool.query<{
      id: string;
      external_id: string;
      region_id: string;
      controlling_faction_id: string | null;
    }>(
      "SELECT id, external_id, region_id, controlling_faction_id FROM settlements WHERE external_id = $1",
      [externalId],
    );
    const r = res.rows[0];
    return r
      ? {
          id: r.id,
          externalId: r.external_id,
          regionId: r.region_id,
          controllingFactionId: r.controlling_faction_id,
        }
      : null;
  }

  public async listActiveCriminalBounties(options?: {
    readonly jurisdictionId?: string | undefined;
    readonly limit?: number | undefined;
    readonly offset?: number | undefined;
  }): Promise<ReadonlyArray<CriminalBounty>> {
    // Legacy Active / escrow_committed rows have no verifiable reservation.
    // Do not advertise them as funded opportunities; retain them in storage.
    void options;
    return [];
  }

  public async listCharacterTitles(characterId: string): Promise<ReadonlyArray<CharacterTitleState>> {
    const res = await this.pool.query(
      "SELECT * FROM character_titles WHERE character_id = $1::uuid ORDER BY unlocked_at ASC",
      [characterId],
    );
    return res.rows.map((r: Record<string, unknown>) => ({
      id: String(r["id"]),
      characterId: String(r["character_id"]),
      titleCode: String(r["title_code"]),
      state: r["state"] as CharacterTitleState["state"],
      exclusivityKey: (r["exclusivity_key"] as string | null) ?? null,
      originEventId: String(r["origin_event_id"]),
      unlockedAt: r["unlocked_at"] as Date,
      updatedAt: r["updated_at"] as Date,
      version: Number(r["version"]),
    }));
  }

  public async listCharacterTitleHistory(characterId: string): Promise<
    ReadonlyArray<{
      readonly id: string;
      readonly titleCode: string;
      readonly action: string;
      readonly causeEventId: string;
      readonly recordedAt: Date;
    }>
  > {
    const res = await this.pool.query<{
      id: string;
      title_code: string;
      action: string;
      cause_event_id: string;
      recorded_at: Date;
    }>(
      `SELECT id, title_code, action, cause_event_id, recorded_at
       FROM character_title_history
       WHERE character_id = $1::uuid
       ORDER BY recorded_at ASC, id ASC`,
      [characterId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      titleCode: r.title_code,
      action: r.action,
      causeEventId: r.cause_event_id,
      recordedAt: r.recorded_at,
    }));
  }

  public async listCharacterCriminalRecords(
    characterId: string,
    options?: { readonly limit?: number | undefined; readonly offset?: number | undefined },
  ): Promise<ReadonlyArray<CriminalRecord>> {
    const limit = Math.max(1, Math.min(100, options?.limit ?? 50));
    const offset = Math.max(0, options?.offset ?? 0);
    const res = await this.pool.query(
      `SELECT * FROM criminal_records
       WHERE offender_character_id = $1::uuid
       ORDER BY recorded_at ASC
       LIMIT $2 OFFSET $3`,
      [characterId, limit, offset],
    );
    return res.rows.map((r: Record<string, unknown>) => ({
      id: String(r["id"]),
      offenderCharacterId: String(r["offender_character_id"]),
      victimCharacterId: (r["victim_character_id"] as string | null) ?? null,
      victimReference: (r["victim_reference"] as string | null) ?? null,
      offenseCode: r["offense_code"] as CriminalRecord["offenseCode"],
      combatContext: r["combat_context"] as CriminalRecord["combatContext"],
      jurisdictionId: String(r["jurisdiction_id"]),
      settlementId: (r["settlement_id"] as string | null) ?? null,
      factionId: (r["faction_id"] as string | null) ?? null,
      regionId: String(r["region_id"]),
      severity: r["severity"] as CriminalRecord["severity"],
      legalStatus: r["legal_status"] as CriminalRecord["legalStatus"],
      moralDeltaApplied: BigInt(String(r["moral_delta_applied"])),
      notorietyFameGranted: BigInt(String(r["notoriety_fame_granted"])),
      sourceEventId: String(r["source_event_id"]),
      evidenceReference: String(r["evidence_reference"]),
      rulesVersion: Number(r["rules_version"]),
      recordedAt: r["recorded_at"] as Date,
      updatedAt: r["updated_at"] as Date,
    }));
  }

  public async listCharacterSocialLedger(
    characterId: string,
    options?: { readonly limit?: number | undefined; readonly offset?: number | undefined },
  ): Promise<ReadonlyArray<SocialLedgerRecord>> {
    const limit = Math.max(1, Math.min(100, options?.limit ?? 50));
    const offset = Math.max(0, options?.offset ?? 0);
    const res = await this.pool.query(
      `SELECT * FROM social_standing_ledger
       WHERE character_id = $1::uuid
       ORDER BY ledger_seq ASC
       LIMIT $2 OFFSET $3`,
      [characterId, limit, offset],
    );
    return res.rows.map((r: Record<string, unknown>) => ({
      id: String(r["id"]),
      ledgerSeq: BigInt(String(r["ledger_seq"])),
      characterId: String(r["character_id"]),
      counterpartyAccountId: (r["counterparty_account_id"] as string | null) ?? null,
      counterpartyCharacterId: (r["counterparty_character_id"] as string | null) ?? null,
      domainKind: r["domain_kind"] as SocialLedgerDomainKind,
      actionCode: String(r["action_code"]),
      scopeKey: String(r["scope_key"]),
      previousValue:
        r["previous_value"] !== null ? BigInt(String(r["previous_value"])) : null,
      deltaValue: r["delta_value"] !== null ? BigInt(String(r["delta_value"])) : null,
      newValue: r["new_value"] !== null ? BigInt(String(r["new_value"])) : null,
      rulesVersion: Number(r["rules_version"]),
      sourceEventId: String(r["source_event_id"]),
      isCompensated: Boolean(r["is_compensated"]),
      metadata: r["metadata"] as Record<string, unknown>,
      occurredAt: r["occurred_at"] as Date,
      recordedAt: r["recorded_at"] as Date,
    }));
  }

  public async listCharacterBountyClaims(
    claimantCharacterId: string,
  ): Promise<ReadonlyArray<CriminalBountyClaim>> {
    const res = await this.pool.query(
      `SELECT * FROM criminal_bounty_claims
       WHERE claimant_character_id = $1::uuid
       ORDER BY claimed_at ASC`,
      [claimantCharacterId],
    );
    return res.rows.map((r: Record<string, unknown>) => ({
      id: String(r["id"]),
      bountyId: String(r["bounty_id"]),
      claimantCharacterId: String(r["claimant_character_id"]),
      claimantAccountId: String(r["claimant_account_id"]),
      targetCharacterId: String(r["target_character_id"]),
      targetAccountId: String(r["target_account_id"]),
      resolutionKind: r["resolution_kind"] as CriminalBountyClaim["resolutionKind"],
      authorityEventId: String(r["authority_event_id"]),
      payoutCommitmentStatus: "pending_economy_settlement",
      claimedAt: r["claimed_at"] as Date,
    }));
  }

  public async findActiveExternalIdentityLink(
    sourceNamespace: string,
    externalSubjectId: string,
  ): Promise<ExternalIdentityLink | null> {
    const res = await this.pool.query(
      `SELECT * FROM external_identity_links
       WHERE source_namespace = $1 AND external_subject_id = $2 AND link_status = 'active'`,
      [sourceNamespace, externalSubjectId],
    );
    const r = res.rows[0] as Record<string, unknown> | undefined;
    if (!r) {
      return null;
    }
    return {
      id: String(r["id"]),
      sourceNamespace: String(r["source_namespace"]),
      externalSubjectId: String(r["external_subject_id"]),
      characterId: String(r["character_id"]),
      linkStatus: r["link_status"] as "active" | "revoked",
      linkedByActor: String(r["linked_by_actor"]),
      revocationReason: (r["revocation_reason"] as string | null) ?? null,
      version: Number(r["version"]),
      createdAt: r["created_at"] as Date,
      updatedAt: r["updated_at"] as Date,
    };
  }

  public async listTitleCatalogCounts(): Promise<{
    readonly total: number;
    readonly enabled: number;
    readonly disabledPlanned: number;
  }> {
    const res = await this.pool.query<{ total: string; enabled: string }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE is_enabled = TRUE)::text AS enabled
       FROM title_definitions`,
    );
    const total = Number(res.rows[0]?.total ?? "0");
    const enabled = Number(res.rows[0]?.enabled ?? "0");
    return { total, enabled, disabledPlanned: total - enabled };
  }
}
