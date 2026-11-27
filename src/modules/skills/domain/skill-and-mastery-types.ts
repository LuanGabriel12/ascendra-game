import {
  WEAPON_SUBCATEGORIES,
  type WeaponSubcategory,
} from "../../inventory/domain/item-types.js";
import type { PrimaryAttributeKey } from "../../peoples/domain/character-snapshot-proposal.js";

/**
 * Reuses all 22 weapon families registered in Session 04 (`WEAPON_SUBCATEGORIES`) verbatim
 * and adds `'unarmed'` as an explicit martial proficiency without mutating `WEAPON_SUBCATEGORIES`.
 */
export const MASTERY_WEAPON_FAMILIES = [...WEAPON_SUBCATEGORIES, "unarmed"] as const;

export type MasteryWeaponFamilyCode = WeaponSubcategory | "unarmed";

export const MASTERY_WEAPON_FAMILY_SET: ReadonlySet<string> = new Set<string>(
  MASTERY_WEAPON_FAMILIES,
);

export const PROFICIENCY_RANKS = [
  "novice",        // Iniciante
  "apprentice",    // Aprendiz
  "practitioner",  // Praticante
  "specialist",    // Especialista
  "master",        // Mestre
  "grandmaster",   // Grão-Mestre
] as const;

export type ProficiencyRank = (typeof PROFICIENCY_RANKS)[number];

export interface ProficiencyBandDefinition {
  readonly rank: ProficiencyRank;
  readonly displayName: string;
  readonly minLevel: number;
  readonly maxLevel: number;
}

export const ABILITY_CATEGORIES = [
  "active",
  "passive",
  "reactive",
  "mobility",
  "defensive",
  "weapon_technique",
  "magical_technique",
  "ultimate_super",
] as const;

export type AbilityCategory = (typeof ABILITY_CATEGORIES)[number];

export const ABILITY_SLOT_GROUPS = ["active", "passive", "ultimate"] as const;

export type AbilitySlotGroup = (typeof ABILITY_SLOT_GROUPS)[number];

export const MASTERY_EXPERIENCE_SOURCE_TYPES = [
  "validated_combat",
  "weapon_usage",
  "training",
  "quest_reward",
  "creature_defeat",
  "boss_participation",
  "achievement_milestone",
  "master_training",
  "dev_authorized",
] as const;

export type MasteryExperienceSourceType = (typeof MASTERY_EXPERIENCE_SOURCE_TYPES)[number];

export const SPECIALIZATION_POINT_SOURCE_TYPES = [
  "level_progression",
  "mastery_milestone",
  "training_completion",
  "achievement_reward",
  "dev_authorized",
] as const;

export type SpecializationPointSourceType =
  (typeof SPECIALIZATION_POINT_SOURCE_TYPES)[number];

export type SkillHistoryOperationType =
  | "mastery_xp_granted"
  | "mastery_level_up"
  | "spec_points_granted"
  | "spec_node_unlocked"
  | "ability_learned"
  | "ability_rank_upgraded"
  | "ability_equipped"
  | "ability_unequipped"
  | "loadout_abilities_saved"
  | "specialization_reset";

export type AbilitySuppressionReason =
  | "ability_disabled"
  | "inactive_after_specialization_reset"
  | "inactive_prerequisite_node"
  | "insufficient_character_level"
  | "insufficient_attributes"
  | "insufficient_weapon_mastery"
  | "equipped_weapon_broken"
  | "incompatible_equipped_weapon";

export interface MasteryAndSkillRulesConfig {
  readonly rulesVersion: number;
  readonly code: string;
  readonly minMasteryLevel: number;
  readonly maxMasteryLevel: number;
  readonly xpCurveBase: bigint;
  readonly xpCurveLinear: bigint;
  readonly xpCurveQuadratic: bigint;
  readonly proficiencyBands: ReadonlyArray<ProficiencyBandDefinition>;
  readonly initialSpecializationPoints: number;
  readonly specializationPointsPerLevel: number;
  readonly masteryMilestoneLevels: ReadonlyArray<number>;
  readonly maxActiveAbilitySlots: number;
  readonly maxPassiveAbilitySlots: number;
  readonly maxUltimateAbilitySlots: number;
  readonly maxTotalEquippedSlots: number;
  readonly maxBuildEquipmentCost: number;
  readonly maxTreeDepth: number;
  readonly maxNodesPerSchool: number;
  readonly antiFarmCooldownSeconds: number;
  readonly antiFarmWindowSeconds: number;
  readonly antiFarmMaxGrantsPerWindow: number;
  readonly diminishingReturnsStepBp: number;
}

export interface CombatSchoolDefinition {
  readonly schoolCode: string;
  readonly displayName: string;
  readonly description: string;
  readonly primaryFocus: string;
  readonly associatedWeaponFamilies: ReadonlyArray<MasteryWeaponFamilyCode>;
  readonly isEnabled: boolean;
  readonly rulesVersion: number;
}

/**
 * Strictly declarative numeric parameter map for passive references.
 * Execution belongs strictly to NEON's future deterministic Go combat engine (never eval/JS).
 */
export type DeclarativePassiveParams = Readonly<Record<string, number>>;

export interface AbilityDefinition {
  readonly abilityCode: string;
  readonly abilityVersion: number;
  readonly displayName: string;
  readonly description: string;
  readonly schoolCode: string;
  readonly abilityCategory: AbilityCategory;
  readonly slotGroup: AbilitySlotGroup;
  readonly requiredWeaponFamilies: ReadonlyArray<MasteryWeaponFamilyCode>;
  readonly requiredCharacterLevel: number;
  readonly requiredMasteryLevel: number;
  readonly requiredAttributes: Partial<Record<PrimaryAttributeKey, number>>;
  readonly prerequisiteAbilities: ReadonlyArray<string>;
  readonly prerequisiteNodes: ReadonlyArray<string>;
  readonly maxRank: number;
  readonly unlockCost: number;
  readonly rankUpgradeCost: number;
  readonly equipmentCost: number;
  readonly exclusiveGroup: string | null;
  readonly declarativePassiveParams: DeclarativePassiveParams | null;
  readonly gameplayEffectRef: string;
  readonly isEnabled: boolean;
  readonly rulesVersion: number;
}

export interface SpecializationNodeDefinition {
  readonly nodeCode: string;
  readonly schoolCode: string;
  readonly displayName: string;
  readonly description: string;
  readonly abilityCode: string | null;
  readonly abilityVersion: number | null;
  readonly prerequisiteNodes: ReadonlyArray<string>;
  readonly requiredWeaponFamilies: ReadonlyArray<MasteryWeaponFamilyCode>;
  readonly requiredMasteryLevel: number;
  readonly requiredCharacterLevel: number;
  readonly requiredAttributes: Partial<Record<PrimaryAttributeKey, number>>;
  readonly pointCost: number;
  readonly exclusiveGroup: string | null;
  readonly tierDepth: number;
  readonly isEnabled: boolean;
  readonly rulesVersion: number;
}

export interface CharacterWeaponMastery {
  readonly characterId: string;
  readonly weaponFamilyCode: MasteryWeaponFamilyCode;
  readonly masteryExperience: bigint;
  readonly masteryLevel: number;
  readonly proficiencyRank: ProficiencyRank;
  readonly rulesVersion: number;
  readonly version: number;
  readonly updatedAt: Date;
}

export interface MasteryExperienceGrantRecord {
  readonly id: string;
  readonly processedEventId: string;
  readonly externalGrantId: string;
  readonly sourceEventId: string;
  readonly characterId: string;
  readonly counterpartyCharacterId: string | null;
  readonly counterpartyAccountId: string | null;
  readonly weaponFamilyCode: MasteryWeaponFamilyCode;
  readonly sourceType: MasteryExperienceSourceType;
  readonly requestedAmount: bigint;
  readonly validatedAmount: bigint;
  readonly previousXp: bigint;
  readonly newXp: bigint;
  readonly previousLevel: number;
  readonly newLevel: number;
  readonly rulesVersion: number;
  readonly payloadFingerprint: string;
  readonly grantedAt: Date;
}

export interface CharacterSpecializationPoints {
  readonly characterId: string;
  readonly earnedPoints: number;
  readonly spentPoints: number;
  readonly unspentPoints: number;
  readonly rulesVersion: number;
  readonly version: number;
  readonly updatedAt: Date;
}

export interface CharacterSpecializationUnlock {
  readonly characterId: string;
  readonly nodeCode: string;
  readonly isActive: boolean;
  readonly pointsInvested: number;
  readonly unlockedAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

export interface CharacterLearnedAbility {
  readonly characterId: string;
  readonly abilityCode: string;
  readonly abilityVersion: number;
  readonly currentRank: number;
  readonly maxRankEverReached: number;
  readonly isActive: boolean;
  readonly pointsInvested: number;
  readonly learnedAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

export interface EquippedAbilityLoadoutSlot {
  readonly loadoutId: string;
  readonly slotIndex: number;
  readonly characterId: string;
  readonly abilityCode: string;
  readonly slotGroup: AbilitySlotGroup;
  readonly equippedAt: Date;
}

export interface CharacterSkillHistoryEntry {
  readonly id: string;
  readonly historySeq: bigint;
  readonly characterId: string;
  readonly operationType: SkillHistoryOperationType;
  readonly abilityCode: string | null;
  readonly weaponFamilyCode: MasteryWeaponFamilyCode | null;
  readonly nodeCode: string | null;
  readonly previousRank: number | null;
  readonly newRank: number | null;
  readonly previousMasteryLevel: number | null;
  readonly newMasteryLevel: number | null;
  readonly pointsDelta: number | null;
  readonly sourceEventId: string;
  readonly rulesVersion: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly recordedAt: Date;
}
