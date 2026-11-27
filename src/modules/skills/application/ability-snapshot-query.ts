import { z } from "zod";
import { NonNegativeInt64Schema } from "../../../shared/contracts/int64-wire.js";
import { BoundaryValidationError } from "../../../shared/contracts/world-events.js";
import type { PgPool } from "../../../shared/db/pool.js";
import type { AuthorityPrincipal } from "../../characters/domain/character.js";
import {
  CharacterBuildConflictError,
  CharacterNotFoundError,
  GenesisTemporaryStatePersistenceForbiddenError,
} from "../../characters/domain/errors.js";
import { PgCharacterTransactionScope } from "../../characters/infrastructure/postgres-character-unit-of-work.js";
import { PgInventoryTransactionScope } from "../../inventory/infrastructure/postgres-inventory-unit-of-work.js";
import type {
  CharacterSnapshotV1,
  CompetitiveNormalizationProfile,
} from "../../peoples/domain/character-snapshot-proposal.js";
import type { EquipmentSnapshotProposalV1 } from "../../inventory/application/equipment-snapshot-query.js";
import { evaluateRuntimeAbilityUsageEligibility } from "../domain/mastery-and-dag-rules.js";
import {
  ABILITY_CATEGORIES,
  ABILITY_SLOT_GROUPS,
  MASTERY_WEAPON_FAMILIES,
  PROFICIENCY_RANKS,
  type AbilityCategory,
  type AbilitySlotGroup,
  type AbilitySuppressionReason,
  type DeclarativePassiveParams,
  type MasteryWeaponFamilyCode,
  type ProficiencyRank,
} from "../domain/skill-and-mastery-types.js";
import { PgSkillTransactionScope } from "../infrastructure/postgres-skill-unit-of-work.js";

export interface WeaponMasterySummaryV1 {
  readonly weaponFamilyCode: MasteryWeaponFamilyCode;
  readonly masteryExperience: bigint;
  readonly masteryLevel: number;
  readonly proficiencyRank: ProficiencyRank;
}

export interface EquippedAbilityDetailV1 {
  readonly slotIndex: number;
  readonly slotGroup: AbilitySlotGroup;
  readonly abilityCode: string;
  readonly abilityDefinitionVersion: number;
  readonly schoolCode: string;
  readonly abilityCategory: AbilityCategory;
  readonly abilityRank: number;
  readonly effectiveCompetitiveRank: number;
  readonly equipmentCost: number;
  readonly requiredWeaponFamilies: ReadonlyArray<MasteryWeaponFamilyCode>;
  readonly resolvedWeaponFamily: MasteryWeaponFamilyCode | null;
  readonly gameplayEffectReference: string;
  readonly declarativePassiveParams: DeclarativePassiveParams | null;
  readonly masteryLevel: number;
  readonly isEligible: boolean;
  readonly suppressionReason: AbilitySuppressionReason | null;
}

export interface AbilitySnapshotV1 {
  readonly contractVersion: 1;
  readonly characterId: string;
  readonly buildVersion: number;
  readonly snapshotVersion: number;
  readonly activeLoadoutId: string | null;
  readonly rulesVersion: number;
  readonly normalizationProfile: "open_world_persistent" | "legacy_ranked_md3";
  readonly competitiveBuildLocked: boolean;
  readonly specializationBudget: {
    readonly earnedPoints: number;
    readonly spentPoints: number;
    readonly unspentPoints: number;
  };
  readonly buildBudget: {
    readonly usedEquipmentCost: number;
    readonly maxEquipmentCost: number;
    readonly activeSlotsUsed: number;
    readonly maxActiveSlots: number;
    readonly passiveSlotsUsed: number;
    readonly maxPassiveSlots: number;
    readonly ultimateSlotsUsed: number;
    readonly maxUltimateSlots: number;
  };
  readonly weaponMasteries: ReadonlyArray<WeaponMasterySummaryV1>;
  readonly equippedAbilities: ReadonlyArray<EquippedAbilityDetailV1>;
}

/**
 * Preparatory non-persistent contract for ephemeral Genesis Ranked MD3 match builds (Section 31).
 * Uses the same immutable `(abilityCode, abilityDefinitionVersion)` catalog references without
 * reading or writing persistent `character_learned_abilities` or `character_weapon_masteries`.
 */
export interface EphemeralGenesisAbilityBuildV1 {
  readonly contractVersion: 1;
  readonly normalizationProfile: "genesis_ranked_md3_scratch";
  readonly matchSeriesId: string;
  readonly stageNumber: 1 | 2 | 3;
  readonly cosmeticSourceCharacterId: string;
  readonly temporaryAbilities: ReadonlyArray<{
    readonly slotIndex: number;
    readonly abilityCode: string;
    readonly abilityDefinitionVersion: number;
    readonly temporaryRank: number;
    readonly gameplayEffectReference: string;
  }>;
}

export const AbilitySnapshotWireV1Schema = z
  .object({
    contract_version: z.literal(1),
    character_id: z.string().uuid(),
    build_version: z.number().int().min(1),
    snapshot_version: z.number().int().min(1),
    active_loadout_id: z.string().uuid().nullable(),
    rules_version: z.number().int().min(1),
    normalization_profile: z.enum(["open_world_persistent", "legacy_ranked_md3"]),
    competitive_build_locked: z.boolean(),
    specialization_budget: z
      .object({
        earned_points: z.number().int().min(0),
        spent_points: z.number().int().min(0),
        unspent_points: z.number().int().min(0),
      })
      .strict(),
    build_budget: z
      .object({
        used_equipment_cost: z.number().int().min(0),
        max_equipment_cost: z.number().int().min(1),
        active_slots_used: z.number().int().min(0),
        max_active_slots: z.number().int().min(1),
        passive_slots_used: z.number().int().min(0),
        max_passive_slots: z.number().int().min(1),
        ultimate_slots_used: z.number().int().min(0),
        max_ultimate_slots: z.number().int().min(0),
      })
      .strict(),
    weapon_masteries: z.array(
      z
        .object({
          weapon_family_code: z.enum(MASTERY_WEAPON_FAMILIES),
          mastery_experience: NonNegativeInt64Schema,
          mastery_level: z.number().int().min(1).max(100),
          proficiency_rank: z.enum(PROFICIENCY_RANKS),
        })
        .strict(),
    ),
    equipped_abilities: z.array(
      z
        .object({
          slot_index: z.number().int().min(0).max(31),
          slot_group: z.enum(ABILITY_SLOT_GROUPS),
          ability_code: z.string().min(1).max(64),
          ability_definition_version: z.number().int().min(1),
          school_code: z.string().min(1).max(64),
          ability_category: z.enum(ABILITY_CATEGORIES),
          ability_rank: z.number().int().min(1).max(99),
          effective_competitive_rank: z.number().int().min(1).max(99),
          equipment_cost: z.number().int().min(0),
          required_weapon_families: z.array(z.enum(MASTERY_WEAPON_FAMILIES)),
          resolved_weapon_family: z.enum(MASTERY_WEAPON_FAMILIES).nullable(),
          gameplay_effect_reference: z.string().min(1).max(128),
          declarative_passive_params: z.record(z.string(), z.number().int()).nullable(),
          mastery_level: z.number().int().min(1).max(100),
          is_eligible: z.boolean(),
          suppression_reason: z
            .enum([
              "ability_disabled",
              "inactive_after_specialization_reset",
              "inactive_prerequisite_node",
              "insufficient_character_level",
              "insufficient_attributes",
              "insufficient_weapon_mastery",
              "equipped_weapon_broken",
              "incompatible_equipped_weapon",
            ])
            .nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export type AbilitySnapshotWireV1 = {
  readonly contract_version: 1;
  readonly character_id: string;
  readonly build_version: number;
  readonly snapshot_version: number;
  readonly active_loadout_id: string | null;
  readonly rules_version: number;
  readonly normalization_profile: "open_world_persistent" | "legacy_ranked_md3";
  readonly competitive_build_locked: boolean;
  readonly specialization_budget: {
    readonly earned_points: number;
    readonly spent_points: number;
    readonly unspent_points: number;
  };
  readonly build_budget: {
    readonly used_equipment_cost: number;
    readonly max_equipment_cost: number;
    readonly active_slots_used: number;
    readonly max_active_slots: number;
    readonly passive_slots_used: number;
    readonly max_passive_slots: number;
    readonly ultimate_slots_used: number;
    readonly max_ultimate_slots: number;
  };
  readonly weapon_masteries: ReadonlyArray<{
    readonly weapon_family_code: MasteryWeaponFamilyCode;
    readonly mastery_experience: string;
    readonly mastery_level: number;
    readonly proficiency_rank: ProficiencyRank;
  }>;
  readonly equipped_abilities: ReadonlyArray<{
    readonly slot_index: number;
    readonly slot_group: AbilitySlotGroup;
    readonly ability_code: string;
    readonly ability_definition_version: number;
    readonly school_code: string;
    readonly ability_category: AbilityCategory;
    readonly ability_rank: number;
    readonly effective_competitive_rank: number;
    readonly equipment_cost: number;
    readonly required_weapon_families: ReadonlyArray<MasteryWeaponFamilyCode>;
    readonly resolved_weapon_family: MasteryWeaponFamilyCode | null;
    readonly gameplay_effect_reference: string;
    readonly declarative_passive_params: DeclarativePassiveParams | null;
    readonly mastery_level: number;
    readonly is_eligible: boolean;
    readonly suppression_reason: AbilitySuppressionReason | null;
  }>;
};

export function serializeAbilitySnapshotWireV1(snapshot: AbilitySnapshotV1): AbilitySnapshotWireV1 {
  return {
    contract_version: 1,
    character_id: snapshot.characterId,
    build_version: snapshot.buildVersion,
    snapshot_version: snapshot.snapshotVersion,
    active_loadout_id: snapshot.activeLoadoutId,
    rules_version: snapshot.rulesVersion,
    normalization_profile: snapshot.normalizationProfile,
    competitive_build_locked: snapshot.competitiveBuildLocked,
    specialization_budget: {
      earned_points: snapshot.specializationBudget.earnedPoints,
      spent_points: snapshot.specializationBudget.spentPoints,
      unspent_points: snapshot.specializationBudget.unspentPoints,
    },
    build_budget: {
      used_equipment_cost: snapshot.buildBudget.usedEquipmentCost,
      max_equipment_cost: snapshot.buildBudget.maxEquipmentCost,
      active_slots_used: snapshot.buildBudget.activeSlotsUsed,
      max_active_slots: snapshot.buildBudget.maxActiveSlots,
      passive_slots_used: snapshot.buildBudget.passiveSlotsUsed,
      max_passive_slots: snapshot.buildBudget.maxPassiveSlots,
      ultimate_slots_used: snapshot.buildBudget.ultimateSlotsUsed,
      max_ultimate_slots: snapshot.buildBudget.maxUltimateSlots,
    },
    weapon_masteries: snapshot.weaponMasteries.map((m) => ({
      weapon_family_code: m.weaponFamilyCode,
      mastery_experience: m.masteryExperience.toString(),
      mastery_level: m.masteryLevel,
      proficiency_rank: m.proficiencyRank,
    })),
    equipped_abilities: snapshot.equippedAbilities.map((a) => ({
      slot_index: a.slotIndex,
      slot_group: a.slotGroup,
      ability_code: a.abilityCode,
      ability_definition_version: a.abilityDefinitionVersion,
      school_code: a.schoolCode,
      ability_category: a.abilityCategory,
      ability_rank: a.abilityRank,
      effective_competitive_rank: a.effectiveCompetitiveRank,
      equipment_cost: a.equipmentCost,
      required_weapon_families: a.requiredWeaponFamilies,
      resolved_weapon_family: a.resolvedWeaponFamily,
      gameplay_effect_reference: a.gameplayEffectReference,
      declarative_passive_params: a.declarativePassiveParams,
      mastery_level: a.masteryLevel,
      is_eligible: a.isEligible,
      suppression_reason: a.suppressionReason,
    })),
  };
}

export function parseAbilitySnapshotWireV1(raw: unknown): AbilitySnapshotV1 {
  const parsed = AbilitySnapshotWireV1Schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${i.path.join(".") || "<root>"}: ${i.message}`,
    );
    throw new BoundaryValidationError(
      `Invalid AbilitySnapshotWireV1: ${issues.join("; ")}`,
      issues,
    );
  }
  const d = parsed.data;
  if (
    d.specialization_budget.spent_points + d.specialization_budget.unspent_points !==
    d.specialization_budget.earned_points
  ) {
    throw new BoundaryValidationError(
      "AbilitySnapshotWireV1 violated specialization point conservation.",
      ["spent_points + unspent_points != earned_points"],
    );
  }

  return {
    contractVersion: 1,
    characterId: d.character_id,
    buildVersion: d.build_version,
    snapshotVersion: d.snapshot_version,
    activeLoadoutId: d.active_loadout_id,
    rulesVersion: d.rules_version,
    normalizationProfile: d.normalization_profile,
    competitiveBuildLocked: d.competitive_build_locked,
    specializationBudget: {
      earnedPoints: d.specialization_budget.earned_points,
      spentPoints: d.specialization_budget.spent_points,
      unspentPoints: d.specialization_budget.unspent_points,
    },
    buildBudget: {
      usedEquipmentCost: d.build_budget.used_equipment_cost,
      maxEquipmentCost: d.build_budget.max_equipment_cost,
      activeSlotsUsed: d.build_budget.active_slots_used,
      maxActiveSlots: d.build_budget.max_active_slots,
      passiveSlotsUsed: d.build_budget.passive_slots_used,
      maxPassiveSlots: d.build_budget.max_passive_slots,
      ultimateSlotsUsed: d.build_budget.ultimate_slots_used,
      maxUltimateSlots: d.build_budget.max_ultimate_slots,
    },
    weaponMasteries: d.weapon_masteries.map((m) => ({
      weaponFamilyCode: m.weapon_family_code,
      masteryExperience: m.mastery_experience,
      masteryLevel: m.mastery_level,
      proficiencyRank: m.proficiency_rank,
    })),
    equippedAbilities: d.equipped_abilities.map((a) => ({
      slotIndex: a.slot_index,
      slotGroup: a.slot_group,
      abilityCode: a.ability_code,
      abilityDefinitionVersion: a.ability_definition_version,
      schoolCode: a.school_code,
      abilityCategory: a.ability_category,
      abilityRank: a.ability_rank,
      effectiveCompetitiveRank: a.effective_competitive_rank,
      equipmentCost: a.equipment_cost,
      requiredWeaponFamilies: a.required_weapon_families,
      resolvedWeaponFamily: a.resolved_weapon_family,
      gameplayEffectReference: a.gameplay_effect_reference,
      declarativePassiveParams: a.declarative_passive_params,
      masteryLevel: a.mastery_level,
      isEligible: a.is_eligible,
      suppressionReason: a.suppression_reason,
    })),
  };
}

/**
 * Verifies cross-snapshot `characterId`, `buildVersion`, and `snapshotVersion` parity
 * when NEON queries `CharacterSnapshotV1`, `EquipmentSnapshotProposalV1`, and `AbilitySnapshotV1`
 * across separate transactions, preventing skew/torn-build consumption (Section 27).
 */
export function assertConsistentCombatSnapshots(params: {
  readonly characterSnapshot: CharacterSnapshotV1;
  readonly equipmentSnapshot?: EquipmentSnapshotProposalV1 | undefined;
  readonly abilitySnapshot: AbilitySnapshotV1;
}): void {
  const cid = params.characterSnapshot.identity.characterId;
  if (params.abilitySnapshot.characterId !== cid) {
    throw new BoundaryValidationError("Cross-snapshot characterId mismatch.", [
      "characterSnapshot.characterId != abilitySnapshot.characterId",
    ]);
  }
  if (
    params.abilitySnapshot.buildVersion !== params.characterSnapshot.buildVersion ||
    params.abilitySnapshot.snapshotVersion !== params.characterSnapshot.snapshotVersion
  ) {
    throw new CharacterBuildConflictError(
      cid,
      params.characterSnapshot.snapshotVersion,
      params.abilitySnapshot.snapshotVersion,
    );
  }
  if (params.equipmentSnapshot) {
    if (
      params.equipmentSnapshot.characterId !== cid ||
      params.equipmentSnapshot.buildVersion !== params.characterSnapshot.buildVersion ||
      params.equipmentSnapshot.snapshotVersion !== params.characterSnapshot.snapshotVersion
    ) {
      throw new CharacterBuildConflictError(
        cid,
        params.characterSnapshot.snapshotVersion,
        params.equipmentSnapshot.snapshotVersion,
      );
    }
  }
}

export class PostgresAbilitySnapshotReader {
  private readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  public async getAbilitySnapshot(
    characterId: string,
    options: {
      readonly principal: AuthorityPrincipal;
      readonly normalizationProfile?: CompetitiveNormalizationProfile | undefined;
    },
  ): Promise<AbilitySnapshotV1> {
    const profile = options.normalizationProfile ?? "open_world_persistent";
    if (profile === "genesis_ranked_md3_scratch") {
      throw new GenesisTemporaryStatePersistenceForbiddenError("getAbilitySnapshot");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const charScope = new PgCharacterTransactionScope(this.pool, client);
      const invScope = new PgInventoryTransactionScope(client);
      const skillScope = new PgSkillTransactionScope(client);

      const character = await charScope.findCharacterById(characterId);
      if (!character) {
        throw new CharacterNotFoundError(characterId);
      }
      character.assertOwnedByOrSystem(options.principal);

      const rules = await skillScope.loadRules(1);
      const specBudget = await skillScope.findSpecializationPointsReadOnly(
        character.id,
        character.level,
        rules,
      );
      const masteryMap = await skillScope.listCharacterMasteriesMap(character.id, false);
      const unlocks = await skillScope.listSpecializationUnlocks(character.id, false);
      const learnedList = await skillScope.listLearnedAbilities(character.id, false);

      const activeLoadoutRes = await client.query<{ id: string }>(
        `SELECT id FROM equipment_loadouts
         WHERE character_id = $1::uuid AND is_active = TRUE
         LIMIT 1`,
        [character.id],
      );
      const activeLoadoutId = activeLoadoutRes.rows[0]?.id ?? null;

      const eqSlots = activeLoadoutId ? await invScope.listLoadoutSlots(activeLoadoutId) : [];
      const handItems = [];
      for (const s of eqSlots) {
        if (s.slotCode !== "main_hand" && s.slotCode !== "off_hand") {
          continue;
        }
        const inst = await invScope.findItemInstanceById(s.itemInstanceId);
        if (!inst || inst.locationState !== "equipped_active") {
          continue;
        }
        const def = await invScope.findItemDefinition(inst.definitionCode, inst.definitionVersion);
        if (!def) {
          continue;
        }
        handItems.push({ slotCode: s.slotCode, instance: inst, definition: def });
      }

      const abilitySlots = activeLoadoutId
        ? await skillScope.listLoadoutAbilitySlots(activeLoadoutId, false)
        : [];
      const learnedByCode = new Map(learnedList.map((l) => [l.abilityCode, l]));
      const activeUnlockedSet = new Set(unlocks.filter((u) => u.isActive).map((u) => u.nodeCode));

      const equippedDetails: EquippedAbilityDetailV1[] = [];
      let usedEquipCost = 0;
      let activeUsed = 0;
      let passiveUsed = 0;
      let ultimateUsed = 0;

      for (const slot of abilitySlots) {
        const learned = learnedByCode.get(slot.abilityCode);
        if (!learned) {
          continue;
        }
        const def = await skillScope.findAbilityDefinition(
          learned.abilityCode,
          learned.abilityVersion,
        );
        if (!def) {
          continue;
        }

        const elig = evaluateRuntimeAbilityUsageEligibility({
          character,
          learned,
          definition: def,
          masteryMap,
          activeUnlockedNodeCodes: activeUnlockedSet,
          equippedHandItems: handItems,
        });

        usedEquipCost += def.equipmentCost;
        if (def.slotGroup === "active") activeUsed++;
        else if (def.slotGroup === "passive") passiveUsed++;
        else ultimateUsed++;

        equippedDetails.push({
          slotIndex: slot.slotIndex,
          slotGroup: def.slotGroup,
          abilityCode: def.abilityCode,
          abilityDefinitionVersion: learned.abilityVersion,
          schoolCode: def.schoolCode,
          abilityCategory: def.abilityCategory,
          abilityRank: learned.currentRank,
          // Provisional v1: identical until joint NEON <-> CARBON Legacy Ranked cap is ratified
          effectiveCompetitiveRank: learned.currentRank,
          equipmentCost: def.equipmentCost,
          requiredWeaponFamilies: def.requiredWeaponFamilies,
          resolvedWeaponFamily: elig.resolvedWeaponFamily,
          gameplayEffectReference: def.gameplayEffectRef,
          declarativePassiveParams: def.declarativePassiveParams,
          masteryLevel: elig.effectiveMasteryLevel,
          isEligible: elig.isEligible,
          suppressionReason: elig.suppressionReason,
        });
      }

      await client.query("COMMIT");

      const masteriesOrdered: WeaponMasterySummaryV1[] = Array.from(masteryMap.values()).map(
        (m) => ({
          weaponFamilyCode: m.weaponFamilyCode,
          masteryExperience: m.masteryExperience,
          masteryLevel: m.masteryLevel,
          proficiencyRank: m.proficiencyRank,
        }),
      );

      const snapshot: AbilitySnapshotV1 = {
        contractVersion: 1,
        characterId: character.id,
        buildVersion: character.buildVersion,
        snapshotVersion: character.snapshotVersion,
        activeLoadoutId,
        rulesVersion: rules.rulesVersion,
        normalizationProfile: profile,
        competitiveBuildLocked: character.competitiveLockState === "in_ranked_series",
        specializationBudget: {
          earnedPoints: specBudget.earnedPoints,
          spentPoints: specBudget.spentPoints,
          unspentPoints: specBudget.unspentPoints,
        },
        buildBudget: {
          usedEquipmentCost: usedEquipCost,
          maxEquipmentCost: rules.maxBuildEquipmentCost,
          activeSlotsUsed: activeUsed,
          maxActiveSlots: rules.maxActiveAbilitySlots,
          passiveSlotsUsed: passiveUsed,
          maxPassiveSlots: rules.maxPassiveAbilitySlots,
          ultimateSlotsUsed: ultimateUsed,
          maxUltimateSlots: rules.maxUltimateAbilitySlots,
        },
        weaponMasteries: masteriesOrdered,
        equippedAbilities: equippedDetails,
      };

      const wire = serializeAbilitySnapshotWireV1(snapshot);
      return parseAbilitySnapshotWireV1(wire);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
