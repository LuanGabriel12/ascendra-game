/**
 * CARBON — Preparatory Proposal for `CharacterSnapshot` (Cycle 03+ Discussion Artifact)
 *
 * STATUS: DESIGN PROPOSAL ONLY — NOT IMPLEMENTED AS PERSISTENT TABLES IN SESSION 02.
 * Combat formulas, competitive normalization coefficients, and equipment scaling MUST NOT
 * be frozen unilaterally without joint NEON <-> CARBON alignment.
 *
 * Design Principles:
 * 1. Original ASCENDRA worldbuilding (~26 potential playable peoples long-term).
 * 2. Race, Lineage, and Culture NEVER lock morality, faction allegiance, or combat class/specialization.
 * 3. Ten canonical primary attributes separated into `baseAttributes` and `allocatedAttributes`.
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

export interface CharacterIdentityRef {
  readonly characterId: string;
  readonly accountId: string;
  readonly raceCode: string;
  readonly lineageCode: string | null;
  readonly cultureCode: string;
  readonly originRegionId: string;
}

export interface CharacterProgressionState {
  readonly level: number;
  readonly experienceTotal: bigint;
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

/**
 * Read-only snapshot candidate that CARBON will project for NEON's simulation/combat
 * boundaries once character persistence is implemented in Cycle 03+.
 */
export interface CharacterSnapshotProposalV1 {
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
