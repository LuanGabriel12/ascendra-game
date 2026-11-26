/**
 * CARBON — Versioned `CharacterSnapshot` Contract (Session 03 Implementation)
 *
 * Evolves the Session 02 proposal into the single authoritative read-only projection
 * contract without introducing contradictory duplicate definitions.
 *
 * Design Invariants:
 * 1. Read-only projection decoupled from internal SQL row shapes; never exposes secrets/credentials.
 * 2. `accountId` is omitted by default and included ONLY when explicitly requested by an authorized internal consumer.
 * 3. Equipment and ability arrays remain empty unless backed by real persistent records (no fake items invented).
 * 4. Genesis Ranked temporary match builds NEVER overwrite persistent character state.
 */

export const PRIMARY_ATTRIBUTE_KEYS = [
  "strength",       // Força
  "fortitude",      // Fortitude
  "vigor",          // Vigor
  "agility",        // Agilidade
  "dexterity",      // Destreza
  "intelligence",   // Inteligência
  "wisdom",         // Sabedoria
  "determination",  // Determinação
  "luck",           // Sorte
  "charisma",       // Carisma
] as const;

export type PrimaryAttributeKey = (typeof PRIMARY_ATTRIBUTE_KEYS)[number];

export type AttributeBlock = {
  readonly [K in PrimaryAttributeKey]: number;
};

export type CompetitiveNormalizationProfile =
  | "open_world_persistent"
  | "legacy_ranked_md3"
  | "genesis_ranked_md3_scratch";

/**
 * Preparatory container for secondary combat/world resources.
 * Definitive combat formulas (damage, frame data, hitstun, crit) belong to joint NEON <-> CARBON contracts.
 */
export interface SecondaryResourcePreview {
  readonly rulesProfile: "dev_preview_v1";
  readonly maxHealth: number;
  readonly maxMana: number;
  readonly maxStamina: number;
  readonly maxGuard: number;
  readonly maxFocus: number;
}

export interface CharacterIdentityRef {
  readonly characterId: string;
  readonly accountId?: string | undefined;
  readonly displayName: string;
  readonly raceCode: string;
  readonly lineageCode: string;
  readonly cultureCode: string;
  readonly backgroundCode: string;
  readonly originRegionId: string;
}

export interface CharacterProgressionState {
  readonly rulesVersion: number;
  readonly level: number;
  readonly experienceTotal: bigint;
  readonly earnedAttributePoints: number;
  readonly allocatedAttributePoints: number;
  readonly unspentAttributePoints: number;
}

export interface CharacterEquipmentSlotSummary {
  readonly slotCode: string;
  readonly itemDefinitionCode: string;
  readonly itemInstanceId: string;
  readonly schemaVersion: number;
}

export interface CharacterAbilitySlotSummary {
  readonly slotIndex: number;
  readonly abilityCode: string;
  readonly rank: number;
}

export interface CharacterSnapshotV1 {
  readonly contractVersion: 1;
  readonly snapshotVersion: number;
  readonly buildVersion: number;
  readonly identity: CharacterIdentityRef;
  readonly baseAttributes: AttributeBlock;
  readonly allocatedAttributes: AttributeBlock;
  readonly progression: CharacterProgressionState;
  readonly equippedItems: ReadonlyArray<CharacterEquipmentSlotSummary>;
  readonly equippedAbilities: ReadonlyArray<CharacterAbilitySlotSummary>;
  readonly normalizationProfile: CompetitiveNormalizationProfile;
}

/**
 * Backward-compatible alias preserving Session 02 imports.
 */
export type CharacterSnapshotProposalV1 = CharacterSnapshotV1;

export interface CharacterSnapshotWireV1 {
  readonly contract_version: 1;
  readonly snapshot_version: number;
  readonly build_version: number;
  readonly character_id: string;
  readonly account_id?: string | undefined;
  readonly display_name: string;
  readonly race_code: string;
  readonly lineage_code: string;
  readonly culture_code: string;
  readonly background_code: string;
  readonly origin_region_id: string;
  readonly rules_version: number;
  readonly level: number;
  readonly experience_total: string;
  readonly earned_attribute_points: number;
  readonly allocated_attribute_points: number;
  readonly unspent_attribute_points: number;
  readonly base_attributes: AttributeBlock;
  readonly allocated_attributes: AttributeBlock;
  readonly equipped_items: ReadonlyArray<CharacterEquipmentSlotSummary>;
  readonly equipped_abilities: ReadonlyArray<CharacterAbilitySlotSummary>;
  readonly normalization_profile: CompetitiveNormalizationProfile;
}
