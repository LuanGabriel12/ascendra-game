import { z } from "zod";
import { NonNegativeInt64Schema } from "../../../shared/contracts/int64-wire.js";
import { BoundaryValidationError } from "../../../shared/contracts/world-events.js";
import type { PgPool } from "../../../shared/db/pool.js";
import { checkIntrinsicCharacterEligibility } from "../../inventory/domain/equipment-and-stack-rules.js";
import { PgInventoryTransactionScope } from "../../inventory/infrastructure/postgres-inventory-unit-of-work.js";
import {
  PRIMARY_ATTRIBUTE_KEYS,
  type AttributeBlock,
  type CharacterAbilitySlotSummary,
  type CharacterEquipmentSlotSummary,
  type CharacterSnapshotV1,
  type CharacterSnapshotWireV1,
  type CompetitiveNormalizationProfile,
} from "../../peoples/domain/character-snapshot-proposal.js";
import {
  evaluateRuntimeAbilityUsageEligibility,
  type EquippedHandItemContext,
} from "../../skills/domain/mastery-and-dag-rules.js";
import { PgSkillTransactionScope } from "../../skills/infrastructure/postgres-skill-unit-of-work.js";
import type { AuthorityPrincipal } from "../domain/character.js";
import {
  CharacterNotFoundError,
  GenesisTemporaryStatePersistenceForbiddenError,
} from "../domain/errors.js";
import { PgCharacterTransactionScope } from "../infrastructure/postgres-character-unit-of-work.js";

const AttributeBlockSchema = z
  .object({
    strength: z.number().int().min(0),
    fortitude: z.number().int().min(0),
    vigor: z.number().int().min(0),
    agility: z.number().int().min(0),
    dexterity: z.number().int().min(0),
    intelligence: z.number().int().min(0),
    wisdom: z.number().int().min(0),
    determination: z.number().int().min(0),
    luck: z.number().int().min(0),
    charisma: z.number().int().min(0),
  })
  .strict();

export const CharacterSnapshotWireV1Schema = z
  .object({
    contract_version: z.literal(1),
    snapshot_version: z.number().int().min(1),
    build_version: z.number().int().min(1),
    character_id: z.string().uuid(),
    account_id: z.string().uuid().optional(),
    display_name: z.string().min(3).max(24),
    race_code: z.string().min(2).max(64),
    lineage_code: z.string().min(2).max(64),
    culture_code: z.string().min(2).max(64),
    background_code: z.string().min(2).max(64),
    origin_region_id: z.string().min(1).max(64),
    rules_version: z.number().int().min(1),
    level: z.number().int().min(1).max(1000),
    experience_total: NonNegativeInt64Schema,
    earned_attribute_points: z.number().int().min(0),
    allocated_attribute_points: z.number().int().min(0),
    unspent_attribute_points: z.number().int().min(0),
    base_attributes: AttributeBlockSchema,
    allocated_attributes: AttributeBlockSchema,
    equipped_items: z.array(
      z
        .object({
          slotCode: z.string().min(1).max(64),
          itemDefinitionCode: z.string().min(1).max(128),
          itemInstanceId: z.string().min(1).max(128),
          schemaVersion: z.number().int().min(1),
        })
        .strict(),
    ),
    equipped_abilities: z.array(
      z
        .object({
          slotIndex: z.number().int().min(0).max(31),
          abilityCode: z.string().min(1).max(128),
          rank: z.number().int().min(1).max(99),
        })
        .strict(),
    ),
    normalization_profile: z.enum([
      "open_world_persistent",
      "legacy_ranked_md3",
      "genesis_ranked_md3_scratch",
    ]),
  })
  .strict();

export function serializeCharacterSnapshotWireV1(
  snapshot: CharacterSnapshotV1,
): CharacterSnapshotWireV1 {
  return {
    contract_version: 1,
    snapshot_version: snapshot.snapshotVersion,
    build_version: snapshot.buildVersion,
    character_id: snapshot.identity.characterId,
    ...(snapshot.identity.accountId !== undefined
      ? { account_id: snapshot.identity.accountId }
      : {}),
    display_name: snapshot.identity.displayName,
    race_code: snapshot.identity.raceCode,
    lineage_code: snapshot.identity.lineageCode,
    culture_code: snapshot.identity.cultureCode,
    background_code: snapshot.identity.backgroundCode,
    origin_region_id: snapshot.identity.originRegionId,
    rules_version: snapshot.progression.rulesVersion,
    level: snapshot.progression.level,
    experience_total: snapshot.progression.experienceTotal.toString(),
    earned_attribute_points: snapshot.progression.earnedAttributePoints,
    allocated_attribute_points: snapshot.progression.allocatedAttributePoints,
    unspent_attribute_points: snapshot.progression.unspentAttributePoints,
    base_attributes: snapshot.baseAttributes,
    allocated_attributes: snapshot.allocatedAttributes,
    equipped_items: snapshot.equippedItems,
    equipped_abilities: snapshot.equippedAbilities,
    normalization_profile: snapshot.normalizationProfile,
  };
}

export function parseCharacterSnapshotWireV1(raw: unknown): CharacterSnapshotV1 {
  const parsed = CharacterSnapshotWireV1Schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${i.path.join(".") || "<root>"}: ${i.message}`,
    );
    throw new BoundaryValidationError(
      `Invalid CharacterSnapshotWireV1: ${issues.join("; ")}`,
      issues,
    );
  }
  const d = parsed.data;
  if (d.allocated_attribute_points + d.unspent_attribute_points !== d.earned_attribute_points) {
    throw new BoundaryValidationError(
      "CharacterSnapshotWireV1 violated attribute budget conservation.",
      ["allocated_attribute_points + unspent_attribute_points != earned_attribute_points"],
    );
  }

      let allocSum = 0;
      for (const key of PRIMARY_ATTRIBUTE_KEYS) {
        allocSum += d.allocated_attributes[key];
      }
      if (allocSum !== d.allocated_attribute_points) {
        throw new BoundaryValidationError(
          "CharacterSnapshotWireV1 sum(allocated_attributes) mismatch.",
          ["sum(allocated_attributes) != allocated_attribute_points"],
        );
      }

      const seenAbilitySlots = new Set<number>();
      const seenAbilityCodes = new Set<string>();
      for (const ab of d.equipped_abilities) {
        if (seenAbilitySlots.has(ab.slotIndex)) {
          throw new BoundaryValidationError(
            "CharacterSnapshotWireV1 contains duplicate equipped_abilities slotIndex.",
            [`duplicate slotIndex ${ab.slotIndex}`],
          );
        }
        if (seenAbilityCodes.has(ab.abilityCode)) {
          throw new BoundaryValidationError(
            "CharacterSnapshotWireV1 contains duplicate equipped_abilities abilityCode.",
            [`duplicate abilityCode ${ab.abilityCode}`],
          );
        }
        seenAbilitySlots.add(ab.slotIndex);
        seenAbilityCodes.add(ab.abilityCode);
      }

  return {
    contractVersion: 1,
    snapshotVersion: d.snapshot_version,
    buildVersion: d.build_version,
    identity: {
      characterId: d.character_id,
      ...(d.account_id !== undefined ? { accountId: d.account_id } : {}),
      displayName: d.display_name,
      raceCode: d.race_code,
      lineageCode: d.lineage_code,
      cultureCode: d.culture_code,
      backgroundCode: d.background_code,
      originRegionId: d.origin_region_id,
    },
    baseAttributes: d.base_attributes as AttributeBlock,
    allocatedAttributes: d.allocated_attributes as AttributeBlock,
    progression: {
      rulesVersion: d.rules_version,
      level: d.level,
      experienceTotal: d.experience_total,
      earnedAttributePoints: d.earned_attribute_points,
      allocatedAttributePoints: d.allocated_attribute_points,
      unspentAttributePoints: d.unspent_attribute_points,
    },
    equippedItems: d.equipped_items,
    equippedAbilities: d.equipped_abilities,
    normalizationProfile: d.normalization_profile,
  };
}

export interface GetCharacterSnapshotOptions {
  readonly principal: AuthorityPrincipal;
  readonly normalizationProfile?: "open_world_persistent" | "legacy_ranked_md3" | undefined;
  readonly includeAccountId?: boolean | undefined;
}

export class PostgresCharacterSnapshotReader {
  private readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  /**
   * Projects a validated, read-only `CharacterSnapshotV1` from a consistent `REPEATABLE READ`
   * PostgreSQL snapshot across `characters`, `character_attributes`, and active `equipment_loadouts`.
   * Only active, non-broken (`durability > 0`), intrinsically eligible items are projected as active combat gear.
   */
  public async getCharacterSnapshot(
    characterId: string,
    options: GetCharacterSnapshotOptions,
  ): Promise<CharacterSnapshotV1> {
    const profile: CompetitiveNormalizationProfile =
      options.normalizationProfile ?? "open_world_persistent";

    if ((profile as string) === "genesis_ranked_md3_scratch") {
      throw new GenesisTemporaryStatePersistenceForbiddenError("getCharacterSnapshot");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const charScope = new PgCharacterTransactionScope(this.pool, client);
      const invScope = new PgInventoryTransactionScope(client);

      const character = await charScope.findCharacterById(characterId);
      if (!character) {
        throw new CharacterNotFoundError(characterId);
      }

      character.assertOwnedByOrSystem(options.principal);

      const equippedItems: CharacterEquipmentSlotSummary[] = [];
      const equippedAbilities: CharacterAbilitySlotSummary[] = [];
      const handItemsForAbilityCheck: EquippedHandItemContext[] = [];

      // Check if equipment_loadouts table is present (supports reading cleanly even if queried before 0007 in isolated migration tests)
      const hasLoadoutTableRes = await client.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = current_schema() AND table_name = 'equipment_loadouts'
         ) AS present`,
      );

      let activeLoadoutId: string | undefined;
      if (hasLoadoutTableRes.rows[0]?.present === true) {
        const activeLoadoutRes = await client.query<{ id: string }>(
          `SELECT id FROM equipment_loadouts
           WHERE character_id = $1 AND is_active = TRUE
           LIMIT 1`,
          [character.id],
        );
        activeLoadoutId = activeLoadoutRes.rows[0]?.id;
        if (activeLoadoutId) {
          const slots = await invScope.listLoadoutSlots(activeLoadoutId);
          for (const slot of slots) {
            const inst = await invScope.findItemInstanceById(slot.itemInstanceId);
            if (!inst || inst.locationState !== "equipped_active") {
              continue;
            }
            const def = await invScope.findItemDefinition(
              inst.definitionCode,
              inst.definitionVersion,
            );
            if (!def) {
              continue;
            }
            if (slot.slotCode === "main_hand" || slot.slotCode === "off_hand") {
              handItemsForAbilityCheck.push({
                slotCode: slot.slotCode,
                instance: inst,
                definition: def,
              });
            }
            const elig = checkIntrinsicCharacterEligibility(character, def, inst);
            if (!elig.eligible) {
              // Broken (durability === 0) or post-respec ineligible items do not provide active combat equipment
              continue;
            }
            equippedItems.push({
              slotCode: slot.slotCode,
              itemDefinitionCode: inst.definitionCode,
              itemInstanceId: inst.id,
              schemaVersion: inst.definitionVersion,
            });
          }
        }
      }

      // Project eligible equipped abilities from Session 06 tables inside the SAME REPEATABLE READ snapshot!
      if (activeLoadoutId) {
        const hasAbilityLoadoutRes = await client.query<{ present: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'character_ability_loadout_slots'
           ) AS present`,
        );

        if (hasAbilityLoadoutRes.rows[0]?.present === true) {
          const skillScope = new PgSkillTransactionScope(client);
          const masteryMap = await skillScope.listCharacterMasteriesMap(character.id, false);
          const unlocks = await skillScope.listSpecializationUnlocks(character.id, false);
          const learnedList = await skillScope.listLearnedAbilities(character.id, false);
          const abilitySlots = await skillScope.listLoadoutAbilitySlots(activeLoadoutId, false);

          const learnedByCode = new Map(learnedList.map((l) => [l.abilityCode, l]));
          const activeUnlockedSet = new Set(
            unlocks.filter((u) => u.isActive).map((u) => u.nodeCode),
          );

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
              equippedHandItems: handItemsForAbilityCheck,
            });
            if (!elig.isEligible) {
              // Suppressed abilities (incompatible weapon, broken weapon, post-respec) stay configured in DB
              // and visible in AbilitySnapshotV1, while CharacterSnapshotV1 projects ONLY active eligible combat abilities!
              continue;
            }
            equippedAbilities.push({
              slotIndex: slot.slotIndex,
              abilityCode: def.abilityCode,
              rank: learned.currentRank,
            });
          }

          equippedAbilities.sort((a, b) => a.slotIndex - b.slotIndex);
        }
      }

      await client.query("COMMIT");

      const snapshot: CharacterSnapshotV1 = {
        contractVersion: 1,
        snapshotVersion: character.snapshotVersion,
        buildVersion: character.buildVersion,
        identity: {
          characterId: character.id,
          ...(options.includeAccountId === true ? { accountId: character.accountId } : {}),
          displayName: character.displayName,
          raceCode: character.raceCode,
          lineageCode: character.lineageCode,
          cultureCode: character.cultureCode,
          backgroundCode: character.backgroundCode,
          originRegionId: character.originRegionId,
        },
        baseAttributes: { ...character.baseAttributes },
        allocatedAttributes: { ...character.allocatedAttributes },
        progression: {
          rulesVersion: character.rulesVersion,
          level: character.level,
          experienceTotal: character.experienceTotal,
          earnedAttributePoints: character.earnedAttributePoints,
          allocatedAttributePoints: character.allocatedAttributePoints,
          unspentAttributePoints: character.unspentAttributePoints,
        },
        equippedItems,
        equippedAbilities,
        normalizationProfile: profile,
      };

      const wire = serializeCharacterSnapshotWireV1(snapshot);
      return parseCharacterSnapshotWireV1(wire);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
