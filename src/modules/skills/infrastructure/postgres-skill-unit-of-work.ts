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
import type { PrimaryAttributeKey } from "../../peoples/domain/character-snapshot-proposal.js";
import { validateTitleConditionAst } from "../../titles/domain/title-contracts.js";
import {
  DEFAULT_MASTERY_AND_SKILL_RULES_V1,
  INITIAL_ABILITY_DEFINITIONS_CATALOG,
  INITIAL_COMBAT_SCHOOLS_CATALOG,
  INITIAL_SPECIALIZATION_NODES_CATALOG,
  SESSION_06_MASTERY_TITLES_CATALOG,
} from "../catalog/initial-skills-catalog.js";
import { SkillVersionConflictError } from "../domain/errors.js";
import {
  resolveExpectedSlotGroup,
  validateDeclarativePassiveParams,
  validateSpecializationDag,
} from "../domain/mastery-and-dag-rules.js";
import type {
  AbilityCategory,
  AbilityDefinition,
  AbilitySlotGroup,
  CharacterLearnedAbility,
  CharacterSkillHistoryEntry,
  CharacterSpecializationPoints,
  CharacterSpecializationUnlock,
  CharacterWeaponMastery,
  CombatSchoolDefinition,
  DeclarativePassiveParams,
  EquippedAbilityLoadoutSlot,
  MasteryAndSkillRulesConfig,
  MasteryExperienceGrantRecord,
  MasteryExperienceSourceType,
  MasteryWeaponFamilyCode,
  ProficiencyBandDefinition,
  ProficiencyRank,
  SkillHistoryOperationType,
  SpecializationNodeDefinition,
} from "../domain/skill-and-mastery-types.js";

export type SkillOutboxEventType =
  | "WeaponMasteryExperienceGranted"
  | "WeaponMasteryLevelUp"
  | "AbilityLearned"
  | "AbilityRankIncreased"
  | "SpecializationNodeUnlocked"
  | "SpecializationReset"
  | "AbilityEquipped"
  | "AbilityUnequipped"
  | "AbilityLoadoutChanged"
  | "CharacterBuildChanged"
  | "MasteryAchievementRecorded";

function mapRulesRow(r: Record<string, unknown>): MasteryAndSkillRulesConfig {
  return {
    rulesVersion: Number(r["rules_version"]),
    code: String(r["code"]),
    minMasteryLevel: Number(r["min_mastery_level"]),
    maxMasteryLevel: Number(r["max_mastery_level"]),
    xpCurveBase: BigInt(String(r["xp_curve_base"])),
    xpCurveLinear: BigInt(String(r["xp_curve_linear"])),
    xpCurveQuadratic: BigInt(String(r["xp_curve_quadratic"])),
    proficiencyBands: r["proficiency_bands"] as ReadonlyArray<ProficiencyBandDefinition>,
    initialSpecializationPoints: Number(r["initial_specialization_points"]),
    specializationPointsPerLevel: Number(r["specialization_points_per_level"]),
    masteryMilestoneLevels: r["mastery_milestone_levels"] as ReadonlyArray<number>,
    maxActiveAbilitySlots: Number(r["max_active_ability_slots"]),
    maxPassiveAbilitySlots: Number(r["max_passive_ability_slots"]),
    maxUltimateAbilitySlots: Number(r["max_ultimate_ability_slots"]),
    maxTotalEquippedSlots: Number(r["max_total_equipped_slots"]),
    maxBuildEquipmentCost: Number(r["max_build_equipment_cost"]),
    maxTreeDepth: Number(r["max_tree_depth"]),
    maxNodesPerSchool: Number(r["max_nodes_per_school"]),
    antiFarmCooldownSeconds: Number(r["anti_farm_cooldown_seconds"]),
    antiFarmWindowSeconds: Number(r["anti_farm_window_seconds"]),
    antiFarmMaxGrantsPerWindow: Number(r["anti_farm_max_grants_per_window"]),
    diminishingReturnsStepBp: Number(r["diminishing_returns_step_bp"]),
  };
}

function mapSchoolRow(r: Record<string, unknown>): CombatSchoolDefinition {
  return {
    schoolCode: String(r["school_code"]),
    displayName: String(r["display_name"]),
    description: String(r["description"]),
    primaryFocus: String(r["primary_focus"]),
    associatedWeaponFamilies:
      r["associated_weapon_families"] as ReadonlyArray<MasteryWeaponFamilyCode>,
    isEnabled: Boolean(r["is_enabled"]),
    rulesVersion: Number(r["rules_version"]),
  };
}

function mapAbilityRow(r: Record<string, unknown>): AbilityDefinition {
  return {
    abilityCode: String(r["ability_code"]),
    abilityVersion: Number(r["ability_version"]),
    displayName: String(r["display_name"]),
    description: String(r["description"]),
    schoolCode: String(r["school_code"]),
    abilityCategory: r["ability_category"] as AbilityCategory,
    slotGroup: r["slot_group"] as AbilitySlotGroup,
    requiredWeaponFamilies:
      r["required_weapon_families"] as ReadonlyArray<MasteryWeaponFamilyCode>,
    requiredCharacterLevel: Number(r["required_character_level"]),
    requiredMasteryLevel: Number(r["required_mastery_level"]),
    requiredAttributes:
      (r["required_attributes"] as Partial<Record<PrimaryAttributeKey, number>>) ?? {},
    prerequisiteAbilities: r["prerequisite_abilities"] as ReadonlyArray<string>,
    prerequisiteNodes: r["prerequisite_nodes"] as ReadonlyArray<string>,
    maxRank: Number(r["max_rank"]),
    unlockCost: Number(r["unlock_cost"]),
    rankUpgradeCost: Number(r["rank_upgrade_cost"]),
    equipmentCost: Number(r["equipment_cost"]),
    exclusiveGroup: (r["exclusive_group"] as string | null) ?? null,
    declarativePassiveParams:
      (r["declarative_passive_params"] as DeclarativePassiveParams | null) ?? null,
    gameplayEffectRef: String(r["gameplay_effect_ref"]),
    isEnabled: Boolean(r["is_enabled"]),
    rulesVersion: Number(r["rules_version"]),
  };
}

function mapSpecNodeRow(r: Record<string, unknown>): SpecializationNodeDefinition {
  return {
    nodeCode: String(r["node_code"]),
    schoolCode: String(r["school_code"]),
    displayName: String(r["display_name"]),
    description: String(r["description"]),
    abilityCode: (r["ability_code"] as string | null) ?? null,
    abilityVersion:
      r["ability_version"] !== null && r["ability_version"] !== undefined
        ? Number(r["ability_version"])
        : null,
    prerequisiteNodes: r["prerequisite_nodes"] as ReadonlyArray<string>,
    requiredWeaponFamilies:
      r["required_weapon_families"] as ReadonlyArray<MasteryWeaponFamilyCode>,
    requiredMasteryLevel: Number(r["required_mastery_level"]),
    requiredCharacterLevel: Number(r["required_character_level"]),
    requiredAttributes:
      (r["required_attributes"] as Partial<Record<PrimaryAttributeKey, number>>) ?? {},
    pointCost: Number(r["point_cost"]),
    exclusiveGroup: (r["exclusive_group"] as string | null) ?? null,
    tierDepth: Number(r["tier_depth"]),
    isEnabled: Boolean(r["is_enabled"]),
    rulesVersion: Number(r["rules_version"]),
  };
}

function mapMasteryRow(r: Record<string, unknown>): CharacterWeaponMastery {
  return {
    characterId: String(r["character_id"]),
    weaponFamilyCode: r["weapon_family_code"] as MasteryWeaponFamilyCode,
    masteryExperience: BigInt(String(r["mastery_experience"])),
    masteryLevel: Number(r["mastery_level"]),
    proficiencyRank: r["proficiency_rank"] as ProficiencyRank,
    rulesVersion: Number(r["rules_version"]),
    version: Number(r["version"]),
    updatedAt: r["updated_at"] as Date,
  };
}

function mapLearnedAbilityRow(r: Record<string, unknown>): CharacterLearnedAbility {
  return {
    characterId: String(r["character_id"]),
    abilityCode: String(r["ability_code"]),
    abilityVersion: Number(r["ability_version"]),
    currentRank: Number(r["current_rank"]),
    maxRankEverReached: Number(r["max_rank_ever_reached"]),
    isActive: Boolean(r["is_active"]),
    pointsInvested: Number(r["points_invested"]),
    learnedAt: r["learned_at"] as Date,
    updatedAt: r["updated_at"] as Date,
    version: Number(r["version"]),
  };
}

function mapSpecUnlockRow(r: Record<string, unknown>): CharacterSpecializationUnlock {
  return {
    characterId: String(r["character_id"]),
    nodeCode: String(r["node_code"]),
    isActive: Boolean(r["is_active"]),
    pointsInvested: Number(r["points_invested"]),
    unlockedAt: r["unlocked_at"] as Date,
    updatedAt: r["updated_at"] as Date,
    version: Number(r["version"]),
  };
}

function mapSpecPointsRow(r: Record<string, unknown>): CharacterSpecializationPoints {
  return {
    characterId: String(r["character_id"]),
    earnedPoints: Number(r["earned_points"]),
    spentPoints: Number(r["spent_points"]),
    unspentPoints: Number(r["unspent_points"]),
    rulesVersion: Number(r["rules_version"]),
    version: Number(r["version"]),
    updatedAt: r["updated_at"] as Date,
  };
}

export class PgSkillTransactionScope {
  public readonly client: PgPoolClient;

  constructor(client: PgPoolClient) {
    this.client = client;
  }

  public async claimOrVerifyEvent(
    input: ClaimProcessedEventInput,
  ): Promise<ClaimProcessedEventResult> {
    return claimOrVerifyProcessedEvent(this.client, input);
  }

  public async loadRules(
    rulesVersion = 1,
  ): Promise<MasteryAndSkillRulesConfig> {
    const res = await this.client.query(
      "SELECT * FROM mastery_and_skill_rules WHERE rules_version = $1",
      [rulesVersion],
    );
    const r = res.rows[0] as Record<string, unknown> | undefined;
    return r ? mapRulesRow(r) : DEFAULT_MASTERY_AND_SKILL_RULES_V1;
  }

  public async findAccountStatus(accountId: string): Promise<"active" | "suspended" | "closed" | null> {
    const res = await this.client.query<{ status: "active" | "suspended" | "closed" }>(
      "SELECT status FROM accounts WHERE id = $1::uuid",
      [accountId],
    );
    return res.rows[0]?.status ?? null;
  }

  public async findCombatSchool(schoolCode: string): Promise<CombatSchoolDefinition | null> {
    const res = await this.client.query(
      "SELECT * FROM combat_schools WHERE school_code = $1",
      [schoolCode],
    );
    const r = res.rows[0] as Record<string, unknown> | undefined;
    return r ? mapSchoolRow(r) : null;
  }

  public async findAbilityDefinition(
    abilityCode: string,
    abilityVersion?: number | undefined,
  ): Promise<AbilityDefinition | null> {
    const res =
      abilityVersion !== undefined
        ? await this.client.query(
            "SELECT * FROM ability_definitions WHERE ability_code = $1 AND ability_version = $2",
            [abilityCode, abilityVersion],
          )
        : await this.client.query(
            `SELECT * FROM ability_definitions
             WHERE ability_code = $1
             ORDER BY ability_version DESC
             LIMIT 1`,
            [abilityCode],
          );
    const r = res.rows[0] as Record<string, unknown> | undefined;
    return r ? mapAbilityRow(r) : null;
  }

  public async listAllAbilityDefinitions(): Promise<ReadonlyArray<AbilityDefinition>> {
    const res = await this.client.query(
      "SELECT * FROM ability_definitions ORDER BY ability_code ASC, ability_version DESC",
    );
    return res.rows.map((r) => mapAbilityRow(r as Record<string, unknown>));
  }

  public async findSpecializationNode(
    nodeCode: string,
  ): Promise<SpecializationNodeDefinition | null> {
    const res = await this.client.query(
      "SELECT * FROM specialization_nodes WHERE node_code = $1",
      [nodeCode],
    );
    const r = res.rows[0] as Record<string, unknown> | undefined;
    return r ? mapSpecNodeRow(r) : null;
  }

  public async listAllSpecializationNodes(): Promise<ReadonlyArray<SpecializationNodeDefinition>> {
    const res = await this.client.query(
      "SELECT * FROM specialization_nodes ORDER BY school_code ASC, tier_depth ASC, node_code ASC",
    );
    return res.rows.map((r) => mapSpecNodeRow(r as Record<string, unknown>));
  }

  public async ensureAndLockSpecializationPoints(
    characterId: string,
    characterLevel: number,
    rules: MasteryAndSkillRulesConfig,
  ): Promise<CharacterSpecializationPoints> {
    const initialEarned =
      rules.initialSpecializationPoints +
      Math.max(0, characterLevel - 1) * rules.specializationPointsPerLevel;

    await this.client.query(
      `INSERT INTO character_specialization_points (
         character_id, earned_points, spent_points, unspent_points, rules_version, version
       )
       VALUES ($1::uuid, $2, 0, $2, $3, 1)
       ON CONFLICT (character_id) DO NOTHING`,
      [characterId, initialEarned, rules.rulesVersion],
    );

    const res = await this.client.query(
      `SELECT * FROM character_specialization_points
       WHERE character_id = $1::uuid
       FOR UPDATE`,
      [characterId],
    );
    return mapSpecPointsRow(res.rows[0] as Record<string, unknown>);
  }

  public async findSpecializationPointsReadOnly(
    characterId: string,
    characterLevel: number,
    rules: MasteryAndSkillRulesConfig,
  ): Promise<CharacterSpecializationPoints> {
    const res = await this.client.query(
      "SELECT * FROM character_specialization_points WHERE character_id = $1::uuid",
      [characterId],
    );
    if (res.rows[0]) {
      return mapSpecPointsRow(res.rows[0] as Record<string, unknown>);
    }
    const initialEarned =
      rules.initialSpecializationPoints +
      Math.max(0, characterLevel - 1) * rules.specializationPointsPerLevel;
    return {
      characterId,
      earnedPoints: initialEarned,
      spentPoints: 0,
      unspentPoints: initialEarned,
      rulesVersion: rules.rulesVersion,
      version: 1,
      updatedAt: new Date(0),
    };
  }

  public async updateSpecializationPoints(
    updated: CharacterSpecializationPoints,
    expectedVersion: number,
  ): Promise<void> {
    const res = await this.client.query(
      `UPDATE character_specialization_points
       SET earned_points = $1,
           spent_points = $2,
           unspent_points = $3,
           rules_version = $4,
           version = $5,
           updated_at = $6
       WHERE character_id = $7::uuid AND version = $8`,
      [
        updated.earnedPoints,
        updated.spentPoints,
        updated.unspentPoints,
        updated.rulesVersion,
        updated.version,
        updated.updatedAt,
        updated.characterId,
        expectedVersion,
      ],
    );
    if (res.rowCount !== 1) {
      throw new SkillVersionConflictError(
        `CharacterSpecializationPoints(${updated.characterId})`,
        expectedVersion,
        updated.version,
      );
    }
  }

  public async ensureAndLockWeaponMastery(
    characterId: string,
    weaponFamilyCode: MasteryWeaponFamilyCode,
    rulesVersion: number,
  ): Promise<CharacterWeaponMastery> {
    await this.client.query(
      `INSERT INTO character_weapon_masteries (
         character_id, weapon_family_code, mastery_experience, mastery_level,
         proficiency_rank, rules_version, version
       )
       VALUES ($1::uuid, $2, 0, 1, 'novice', $3, 1)
       ON CONFLICT (character_id, weapon_family_code) DO NOTHING`,
      [characterId, weaponFamilyCode, rulesVersion],
    );

    const res = await this.client.query(
      `SELECT * FROM character_weapon_masteries
       WHERE character_id = $1::uuid AND weapon_family_code = $2
       FOR UPDATE`,
      [characterId, weaponFamilyCode],
    );
    return mapMasteryRow(res.rows[0] as Record<string, unknown>);
  }

  public async updateWeaponMastery(
    updated: CharacterWeaponMastery,
    expectedVersion: number,
  ): Promise<void> {
    const res = await this.client.query(
      `UPDATE character_weapon_masteries
       SET mastery_experience = $1::bigint,
           mastery_level = $2,
           proficiency_rank = $3,
           rules_version = $4,
           version = $5,
           updated_at = $6
       WHERE character_id = $7::uuid AND weapon_family_code = $8 AND version = $9`,
      [
        updated.masteryExperience.toString(),
        updated.masteryLevel,
        updated.proficiencyRank,
        updated.rulesVersion,
        updated.version,
        updated.updatedAt,
        updated.characterId,
        updated.weaponFamilyCode,
        expectedVersion,
      ],
    );
    if (res.rowCount !== 1) {
      throw new SkillVersionConflictError(
        `CharacterWeaponMastery(${updated.characterId},${updated.weaponFamilyCode})`,
        expectedVersion,
        updated.version,
      );
    }
  }

  public async listCharacterMasteriesMap(
    characterId: string,
    forUpdate = false,
  ): Promise<Map<MasteryWeaponFamilyCode, CharacterWeaponMastery>> {
    const sql = forUpdate
      ? `SELECT * FROM character_weapon_masteries
         WHERE character_id = $1::uuid
         ORDER BY weapon_family_code ASC
         FOR UPDATE`
      : `SELECT * FROM character_weapon_masteries
         WHERE character_id = $1::uuid
         ORDER BY weapon_family_code ASC`;
    const res = await this.client.query(sql, [characterId]);
    const map = new Map<MasteryWeaponFamilyCode, CharacterWeaponMastery>();
    for (const r of res.rows) {
      const m = mapMasteryRow(r as Record<string, unknown>);
      map.set(m.weaponFamilyCode, m);
    }
    return map;
  }

  public async countMasteryGrantsInWindow(params: {
    readonly characterId: string;
    readonly weaponFamilyCode: MasteryWeaponFamilyCode;
    readonly sourceType: MasteryExperienceSourceType;
    readonly windowSeconds: number;
    readonly now: Date;
  }): Promise<{ readonly countInWindow: number; readonly latestGrantedAt: Date | null }> {
    const windowStart = new Date(params.now.getTime() - params.windowSeconds * 1000);
    const res = await this.client.query<{ cnt: string; latest: Date | null }>(
      `SELECT COUNT(*)::text AS cnt, MAX(granted_at) AS latest
       FROM mastery_experience_grants
       WHERE character_id = $1::uuid
         AND weapon_family_code = $2
         AND source_type = $3
         AND granted_at >= $4`,
      [params.characterId, params.weaponFamilyCode, params.sourceType, windowStart],
    );
    return {
      countInWindow: Number(res.rows[0]?.cnt ?? "0"),
      latestGrantedAt: res.rows[0]?.latest ?? null,
    };
  }

  public async findMasteryGrantByExternalId(
    externalGrantId: string,
  ): Promise<MasteryExperienceGrantRecord | null> {
    const res = await this.client.query(
      "SELECT * FROM mastery_experience_grants WHERE external_grant_id = $1",
      [externalGrantId],
    );
    const r = res.rows[0] as Record<string, unknown> | undefined;
    if (!r) {
      return null;
    }
    return {
      id: String(r["id"]),
      processedEventId: String(r["processed_event_id"]),
      externalGrantId: String(r["external_grant_id"]),
      sourceEventId: String(r["source_event_id"]),
      characterId: String(r["character_id"]),
      counterpartyCharacterId: (r["counterparty_character_id"] as string | null) ?? null,
      counterpartyAccountId: (r["counterparty_account_id"] as string | null) ?? null,
      weaponFamilyCode: r["weapon_family_code"] as MasteryWeaponFamilyCode,
      sourceType: r["source_type"] as MasteryExperienceSourceType,
      requestedAmount: BigInt(String(r["requested_amount"])),
      validatedAmount: BigInt(String(r["validated_amount"])),
      previousXp: BigInt(String(r["previous_xp"])),
      newXp: BigInt(String(r["new_xp"])),
      previousLevel: Number(r["previous_level"]),
      newLevel: Number(r["new_level"]),
      rulesVersion: Number(r["rules_version"]),
      payloadFingerprint: String(r["payload_fingerprint"]),
      grantedAt: r["granted_at"] as Date,
    };
  }

  public async listSpecializationUnlocks(
    characterId: string,
    forUpdate = false,
  ): Promise<ReadonlyArray<CharacterSpecializationUnlock>> {
    const sql = forUpdate
      ? `SELECT * FROM character_specialization_unlocks
         WHERE character_id = $1::uuid
         ORDER BY node_code ASC
         FOR UPDATE`
      : `SELECT * FROM character_specialization_unlocks
         WHERE character_id = $1::uuid
         ORDER BY node_code ASC`;
    const res = await this.client.query(sql, [characterId]);
    return res.rows.map((r) => mapSpecUnlockRow(r as Record<string, unknown>));
  }

  public async listLearnedAbilities(
    characterId: string,
    forUpdate = false,
  ): Promise<ReadonlyArray<CharacterLearnedAbility>> {
    const sql = forUpdate
      ? `SELECT * FROM character_learned_abilities
         WHERE character_id = $1::uuid
         ORDER BY ability_code ASC
         FOR UPDATE`
      : `SELECT * FROM character_learned_abilities
         WHERE character_id = $1::uuid
         ORDER BY ability_code ASC`;
    const res = await this.client.query(sql, [characterId]);
    return res.rows.map((r) => mapLearnedAbilityRow(r as Record<string, unknown>));
  }

  public async listLoadoutAbilitySlots(
    loadoutId: string,
    forUpdate = false,
  ): Promise<ReadonlyArray<EquippedAbilityLoadoutSlot>> {
    const sql = forUpdate
      ? `SELECT * FROM character_ability_loadout_slots
         WHERE loadout_id = $1::uuid
         ORDER BY slot_index ASC
         FOR UPDATE`
      : `SELECT * FROM character_ability_loadout_slots
         WHERE loadout_id = $1::uuid
         ORDER BY slot_index ASC`;
    const res = await this.client.query(sql, [loadoutId]);
    return res.rows.map((r: Record<string, unknown>) => ({
      loadoutId: String(r["loadout_id"]),
      slotIndex: Number(r["slot_index"]),
      characterId: String(r["character_id"]),
      abilityCode: String(r["ability_code"]),
      slotGroup: r["slot_group"] as AbilitySlotGroup,
      equippedAt: r["equipped_at"] as Date,
    }));
  }

  public async replaceLoadoutAbilitySlots(params: {
    readonly loadoutId: string;
    readonly characterId: string;
    readonly slots: ReadonlyArray<{
      readonly slotIndex: number;
      readonly abilityCode: string;
      readonly slotGroup: AbilitySlotGroup;
    }>;
    readonly now: Date;
  }): Promise<void> {
    await this.client.query(
      "DELETE FROM character_ability_loadout_slots WHERE loadout_id = $1::uuid",
      [params.loadoutId],
    );
    for (const s of params.slots) {
      await this.client.query(
        `INSERT INTO character_ability_loadout_slots (
           loadout_id, slot_index, character_id, ability_code, slot_group, equipped_at
         )
         VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6)`,
        [params.loadoutId, s.slotIndex, params.characterId, s.abilityCode, s.slotGroup, params.now],
      );
    }
  }

  public async appendSkillHistory(params: {
    readonly characterId: string;
    readonly operationType: SkillHistoryOperationType;
    readonly abilityCode?: string | null | undefined;
    readonly weaponFamilyCode?: MasteryWeaponFamilyCode | null | undefined;
    readonly nodeCode?: string | null | undefined;
    readonly previousRank?: number | null | undefined;
    readonly newRank?: number | null | undefined;
    readonly previousMasteryLevel?: number | null | undefined;
    readonly newMasteryLevel?: number | null | undefined;
    readonly pointsDelta?: number | null | undefined;
    readonly sourceEventId: string;
    readonly rulesVersion: number;
    readonly metadata?: Readonly<Record<string, unknown>> | undefined;
    readonly recordedAt: Date;
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO character_skill_history (
         id, character_id, operation_type, ability_code, weapon_family_code, node_code,
         previous_rank, new_rank, previous_mastery_level, new_mastery_level, points_delta,
         source_event_id, rules_version, metadata, recorded_at
       )
       VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6,
         $7, $8, $9, $10, $11,
         $12, $13, $14::jsonb, $15
       )`,
      [
        randomUUID(),
        params.characterId,
        params.operationType,
        params.abilityCode ?? null,
        params.weaponFamilyCode ?? null,
        params.nodeCode ?? null,
        params.previousRank ?? null,
        params.newRank ?? null,
        params.previousMasteryLevel ?? null,
        params.newMasteryLevel ?? null,
        params.pointsDelta ?? null,
        params.sourceEventId,
        params.rulesVersion,
        JSON.stringify(params.metadata ?? {}),
        params.recordedAt,
      ],
    );
  }

  public async enqueueOutbox(params: {
    readonly aggregateType: "Character" | "CharacterSkillProgression";
    readonly aggregateId: string;
    readonly eventType: SkillOutboxEventType;
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
}

export class PostgresSkillUnitOfWork {
  private readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  public async executeInTransaction<T>(
    work: (scope: PgSkillTransactionScope) => Promise<T>,
  ): Promise<T> {
    return withPgTransaction(this.pool, async (client) => {
      const scope = new PgSkillTransactionScope(client);
      return work(scope);
    });
  }
}

export class PostgresSkillRepository {
  private readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  /**
   * Seeds `mastery_and_skill_rules`, all 12 `combat_schools` (6 enabled + 6 planned),
   * 28 versioned `ability_definitions` (27 enabled + 1 planned), 18 validated DAG `specialization_nodes`,
   * and upserts Session 06 mastery titles (enabling `master_of_blades` v2 when `title_definitions` is present).
   */
  public async seedInitialSkillCatalogs(
    rules: MasteryAndSkillRulesConfig = DEFAULT_MASTERY_AND_SKILL_RULES_V1,
  ): Promise<void> {
    // Validate specialization DAG & passive metadata before touching PostgreSQL
    for (const ab of INITIAL_ABILITY_DEFINITIONS_CATALOG) {
      if (ab.slotGroup !== resolveExpectedSlotGroup(ab.abilityCategory)) {
        throw new Error(
          `Ability '${ab.abilityCode}' slotGroup '${ab.slotGroup}' mismatches category '${ab.abilityCategory}'.`,
        );
      }
      validateDeclarativePassiveParams(ab.abilityCategory, ab.declarativePassiveParams);
    }
    validateSpecializationDag({
      nodes: INITIAL_SPECIALIZATION_NODES_CATALOG,
      abilities: INITIAL_ABILITY_DEFINITIONS_CATALOG,
      rules,
    });

    await this.pool.query(
      `INSERT INTO mastery_and_skill_rules (
         rules_version, code, min_mastery_level, max_mastery_level,
         xp_curve_base, xp_curve_linear, xp_curve_quadratic,
         proficiency_bands, initial_specialization_points, specialization_points_per_level,
         mastery_milestone_levels, max_active_ability_slots, max_passive_ability_slots,
         max_ultimate_ability_slots, max_total_equipped_slots, max_build_equipment_cost,
         max_tree_depth, max_nodes_per_school, anti_farm_cooldown_seconds,
         anti_farm_window_seconds, anti_farm_max_grants_per_window, diminishing_returns_step_bp, is_active
       )
       VALUES (
         $1, $2, $3, $4,
         $5::bigint, $6::bigint, $7::bigint,
         $8::jsonb, $9, $10,
         $11::jsonb, $12, $13,
         $14, $15, $16,
         $17, $18, $19,
         $20, $21, $22, TRUE
       )
       ON CONFLICT (rules_version) DO UPDATE
         SET max_build_equipment_cost = EXCLUDED.max_build_equipment_cost,
             proficiency_bands = EXCLUDED.proficiency_bands`,
      [
        rules.rulesVersion,
        rules.code,
        rules.minMasteryLevel,
        rules.maxMasteryLevel,
        rules.xpCurveBase.toString(),
        rules.xpCurveLinear.toString(),
        rules.xpCurveQuadratic.toString(),
        JSON.stringify(rules.proficiencyBands),
        rules.initialSpecializationPoints,
        rules.specializationPointsPerLevel,
        JSON.stringify(rules.masteryMilestoneLevels),
        rules.maxActiveAbilitySlots,
        rules.maxPassiveAbilitySlots,
        rules.maxUltimateAbilitySlots,
        rules.maxTotalEquippedSlots,
        rules.maxBuildEquipmentCost,
        rules.maxTreeDepth,
        rules.maxNodesPerSchool,
        rules.antiFarmCooldownSeconds,
        rules.antiFarmWindowSeconds,
        rules.antiFarmMaxGrantsPerWindow,
        rules.diminishingReturnsStepBp,
      ],
    );

    for (const sc of INITIAL_COMBAT_SCHOOLS_CATALOG) {
      await this.pool.query(
        `INSERT INTO combat_schools (
           school_code, display_name, description, primary_focus,
           associated_weapon_families, is_enabled, rules_version
         )
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
         ON CONFLICT (school_code) DO NOTHING`,
        [
          sc.schoolCode,
          sc.displayName,
          sc.description,
          sc.primaryFocus,
          JSON.stringify(sc.associatedWeaponFamilies),
          sc.isEnabled,
          sc.rulesVersion,
        ],
      );
    }

    for (const ab of INITIAL_ABILITY_DEFINITIONS_CATALOG) {
      await this.pool.query(
        `INSERT INTO ability_definitions (
           ability_code, ability_version, display_name, description, school_code,
           ability_category, slot_group, required_weapon_families,
           required_character_level, required_mastery_level, required_attributes,
           prerequisite_abilities, prerequisite_nodes, max_rank,
           unlock_cost, rank_upgrade_cost, equipment_cost, exclusive_group,
           declarative_passive_params, gameplay_effect_ref, is_enabled, rules_version
         )
         VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8::jsonb,
           $9, $10, $11::jsonb,
           $12::jsonb, $13::jsonb, $14,
           $15, $16, $17, $18,
           $19::jsonb, $20, $21, $22
         )
         ON CONFLICT (ability_code, ability_version) DO NOTHING`,
        [
          ab.abilityCode,
          ab.abilityVersion,
          ab.displayName,
          ab.description,
          ab.schoolCode,
          ab.abilityCategory,
          ab.slotGroup,
          JSON.stringify(ab.requiredWeaponFamilies),
          ab.requiredCharacterLevel,
          ab.requiredMasteryLevel,
          JSON.stringify(ab.requiredAttributes),
          JSON.stringify(ab.prerequisiteAbilities),
          JSON.stringify(ab.prerequisiteNodes),
          ab.maxRank,
          ab.unlockCost,
          ab.rankUpgradeCost,
          ab.equipmentCost,
          ab.exclusiveGroup,
          ab.declarativePassiveParams ? JSON.stringify(ab.declarativePassiveParams) : null,
          ab.gameplayEffectRef,
          ab.isEnabled,
          ab.rulesVersion,
        ],
      );
    }

    for (const node of INITIAL_SPECIALIZATION_NODES_CATALOG) {
      await this.pool.query(
        `INSERT INTO specialization_nodes (
           node_code, school_code, display_name, description, ability_code, ability_version,
           prerequisite_nodes, required_weapon_families, required_mastery_level,
           required_character_level, required_attributes, point_cost,
           exclusive_group, tier_depth, is_enabled, rules_version
         )
         VALUES (
           $1, $2, $3, $4, $5, $6,
           $7::jsonb, $8::jsonb, $9,
           $10, $11::jsonb, $12,
           $13, $14, $15, $16
         )
         ON CONFLICT (node_code) DO NOTHING`,
        [
          node.nodeCode,
          node.schoolCode,
          node.displayName,
          node.description,
          node.abilityCode,
          node.abilityVersion,
          JSON.stringify(node.prerequisiteNodes),
          JSON.stringify(node.requiredWeaponFamilies),
          node.requiredMasteryLevel,
          node.requiredCharacterLevel,
          JSON.stringify(node.requiredAttributes),
          node.pointCost,
          node.exclusiveGroup,
          node.tierDepth,
          node.isEnabled,
          node.rulesVersion,
        ],
      );
    }

    // Upgrade `master_of_blades` and register Session 06 mastery titles when `title_definitions` exists
    const hasTitleTable = await this.pool.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = 'title_definitions'
       ) AS present`,
    );
    if (hasTitleTable.rows[0]?.present === true) {
      for (const td of SESSION_06_MASTERY_TITLES_CATALOG) {
        validateTitleConditionAst(td.requirements);
        await this.pool.query(
          `INSERT INTO title_definitions (
             title_code, title_version, display_name, description, category, rarity,
             persistence_mode, exclusivity_scope, visibility, stackability_policy,
             revocable, is_enabled, origin_summary, requirements, rules_version
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)
           ON CONFLICT (title_code) DO UPDATE
             SET title_version = EXCLUDED.title_version,
                 description = EXCLUDED.description,
                 visibility = EXCLUDED.visibility,
                 is_enabled = EXCLUDED.is_enabled,
                 origin_summary = EXCLUDED.origin_summary,
                 requirements = EXCLUDED.requirements,
                 rules_version = EXCLUDED.rules_version`,
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
  }

  public async registerCombatSchool(school: CombatSchoolDefinition): Promise<void> {
    await this.pool.query(
      `INSERT INTO combat_schools (
         school_code, display_name, description, primary_focus,
         associated_weapon_families, is_enabled, rules_version
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [
        school.schoolCode,
        school.displayName,
        school.description,
        school.primaryFocus,
        JSON.stringify(school.associatedWeaponFamilies),
        school.isEnabled,
        school.rulesVersion,
      ],
    );
  }

  /**
   * Inserts a new immutable `(ability_code, ability_version)` row without overwriting prior versions!
   */
  public async registerVersionedAbilityDefinition(ability: AbilityDefinition): Promise<void> {
    if (ability.slotGroup !== resolveExpectedSlotGroup(ability.abilityCategory)) {
      throw new Error(
        `Ability '${ability.abilityCode}' slotGroup '${ability.slotGroup}' mismatches category '${ability.abilityCategory}'.`,
      );
    }
    validateDeclarativePassiveParams(ability.abilityCategory, ability.declarativePassiveParams);

    await this.pool.query(
      `INSERT INTO ability_definitions (
         ability_code, ability_version, display_name, description, school_code,
         ability_category, slot_group, required_weapon_families,
         required_character_level, required_mastery_level, required_attributes,
         prerequisite_abilities, prerequisite_nodes, max_rank,
         unlock_cost, rank_upgrade_cost, equipment_cost, exclusive_group,
         declarative_passive_params, gameplay_effect_ref, is_enabled, rules_version
       )
       VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8::jsonb,
         $9, $10, $11::jsonb,
         $12::jsonb, $13::jsonb, $14,
         $15, $16, $17, $18,
         $19::jsonb, $20, $21, $22
       )`,
      [
        ability.abilityCode,
        ability.abilityVersion,
        ability.displayName,
        ability.description,
        ability.schoolCode,
        ability.abilityCategory,
        ability.slotGroup,
        JSON.stringify(ability.requiredWeaponFamilies),
        ability.requiredCharacterLevel,
        ability.requiredMasteryLevel,
        JSON.stringify(ability.requiredAttributes),
        JSON.stringify(ability.prerequisiteAbilities),
        JSON.stringify(ability.prerequisiteNodes),
        ability.maxRank,
        ability.unlockCost,
        ability.rankUpgradeCost,
        ability.equipmentCost,
        ability.exclusiveGroup,
        ability.declarativePassiveParams ? JSON.stringify(ability.declarativePassiveParams) : null,
        ability.gameplayEffectRef,
        ability.isEnabled,
        ability.rulesVersion,
      ],
    );
  }

  /**
   * Validates the combined specialization graph (existing + incoming) as a cycle-free bounded DAG
   * inside a transaction before inserting any node!
   */
  public async registerSpecializationNodes(
    newNodes: ReadonlyArray<SpecializationNodeDefinition>,
  ): Promise<void> {
    await withPgTransaction(this.pool, async (client) => {
      const scope = new PgSkillTransactionScope(client);
      const rules = await scope.loadRules(1);
      const existingNodes = await scope.listAllSpecializationNodes();
      const existingAbilities = await scope.listAllAbilityDefinitions();

      validateSpecializationDag({
        nodes: [...existingNodes, ...newNodes],
        abilities: existingAbilities,
        rules,
      });

      for (const node of newNodes) {
        await client.query(
          `INSERT INTO specialization_nodes (
             node_code, school_code, display_name, description, ability_code, ability_version,
             prerequisite_nodes, required_weapon_families, required_mastery_level,
             required_character_level, required_attributes, point_cost,
             exclusive_group, tier_depth, is_enabled, rules_version
           )
           VALUES (
             $1, $2, $3, $4, $5, $6,
             $7::jsonb, $8::jsonb, $9,
             $10, $11::jsonb, $12,
             $13, $14, $15, $16
           )`,
          [
            node.nodeCode,
            node.schoolCode,
            node.displayName,
            node.description,
            node.abilityCode,
            node.abilityVersion,
            JSON.stringify(node.prerequisiteNodes),
            JSON.stringify(node.requiredWeaponFamilies),
            node.requiredMasteryLevel,
            node.requiredCharacterLevel,
            JSON.stringify(node.requiredAttributes),
            node.pointCost,
            node.exclusiveGroup,
            node.tierDepth,
            node.isEnabled,
            node.rulesVersion,
          ],
        );
      }
    });
  }

  public async listCatalogCounts(): Promise<{
    readonly totalSchools: number;
    readonly enabledSchools: number;
    readonly disabledSchools: number;
    readonly totalAbilities: number;
    readonly enabledAbilities: number;
    readonly disabledAbilities: number;
    readonly specializationNodes: number;
  }> {
    const scRes = await this.pool.query<{ total: string; enabled: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE is_enabled = TRUE)::text AS enabled
       FROM combat_schools`,
    );
    const abRes = await this.pool.query<{ total: string; enabled: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE is_enabled = TRUE)::text AS enabled
       FROM ability_definitions`,
    );
    const ndRes = await this.pool.query<{ total: string }>(
      "SELECT COUNT(*)::text AS total FROM specialization_nodes",
    );
    const totalSchools = Number(scRes.rows[0]?.total ?? "0");
    const enabledSchools = Number(scRes.rows[0]?.enabled ?? "0");
    const totalAbilities = Number(abRes.rows[0]?.total ?? "0");
    const enabledAbilities = Number(abRes.rows[0]?.enabled ?? "0");
    return {
      totalSchools,
      enabledSchools,
      disabledSchools: totalSchools - enabledSchools,
      totalAbilities,
      enabledAbilities,
      disabledAbilities: totalAbilities - enabledAbilities,
      specializationNodes: Number(ndRes.rows[0]?.total ?? "0"),
    };
  }

  public async listCharacterMasteries(
    characterId: string,
  ): Promise<ReadonlyArray<CharacterWeaponMastery>> {
    const res = await this.pool.query(
      `SELECT * FROM character_weapon_masteries
       WHERE character_id = $1::uuid
       ORDER BY weapon_family_code ASC`,
      [characterId],
    );
    return res.rows.map((r) => mapMasteryRow(r as Record<string, unknown>));
  }

  public async listCharacterLearnedAbilities(
    characterId: string,
  ): Promise<ReadonlyArray<CharacterLearnedAbility>> {
    const res = await this.pool.query(
      `SELECT * FROM character_learned_abilities
       WHERE character_id = $1::uuid
       ORDER BY ability_code ASC`,
      [characterId],
    );
    return res.rows.map((r) => mapLearnedAbilityRow(r as Record<string, unknown>));
  }

  public async getCharacterSpecializationPoints(
    characterId: string,
  ): Promise<CharacterSpecializationPoints | null> {
    const res = await this.pool.query(
      "SELECT * FROM character_specialization_points WHERE character_id = $1::uuid",
      [characterId],
    );
    const r = res.rows[0] as Record<string, unknown> | undefined;
    return r ? mapSpecPointsRow(r) : null;
  }

  public async listCharacterSkillHistory(
    characterId: string,
    options?: { readonly limit?: number | undefined; readonly offset?: number | undefined },
  ): Promise<ReadonlyArray<CharacterSkillHistoryEntry>> {
    const limit = Math.max(1, Math.min(100, options?.limit ?? 50));
    const offset = Math.max(0, options?.offset ?? 0);
    const res = await this.pool.query(
      `SELECT * FROM character_skill_history
       WHERE character_id = $1::uuid
       ORDER BY history_seq ASC
       LIMIT $2 OFFSET $3`,
      [characterId, limit, offset],
    );
    return res.rows.map((r: Record<string, unknown>) => ({
      id: String(r["id"]),
      historySeq: BigInt(String(r["history_seq"])),
      characterId: String(r["character_id"]),
      operationType: r["operation_type"] as SkillHistoryOperationType,
      abilityCode: (r["ability_code"] as string | null) ?? null,
      weaponFamilyCode: (r["weapon_family_code"] as MasteryWeaponFamilyCode | null) ?? null,
      nodeCode: (r["node_code"] as string | null) ?? null,
      previousRank:
        r["previous_rank"] !== null && r["previous_rank"] !== undefined
          ? Number(r["previous_rank"])
          : null,
      newRank:
        r["new_rank"] !== null && r["new_rank"] !== undefined ? Number(r["new_rank"]) : null,
      previousMasteryLevel:
        r["previous_mastery_level"] !== null && r["previous_mastery_level"] !== undefined
          ? Number(r["previous_mastery_level"])
          : null,
      newMasteryLevel:
        r["new_mastery_level"] !== null && r["new_mastery_level"] !== undefined
          ? Number(r["new_mastery_level"])
          : null,
      pointsDelta:
        r["points_delta"] !== null && r["points_delta"] !== undefined
          ? Number(r["points_delta"])
          : null,
      sourceEventId: String(r["source_event_id"]),
      rulesVersion: Number(r["rules_version"]),
      metadata: (r["metadata"] as Readonly<Record<string, unknown>>) ?? {},
      recordedAt: r["recorded_at"] as Date,
    }));
  }
}
