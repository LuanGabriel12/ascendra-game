import type { PgPool } from "../../../shared/db/pool.js";
import type {
  AttributeBlock,
  CompetitiveNormalizationProfile,
} from "../../peoples/domain/character-snapshot-proposal.js";
import type { AuthorityPrincipal } from "../../characters/domain/character.js";
import {
  CharacterNotFoundError,
  GenesisTemporaryStatePersistenceForbiddenError,
} from "../../characters/domain/errors.js";
import { PgCharacterTransactionScope } from "../../characters/infrastructure/postgres-character-unit-of-work.js";
import { DEFAULT_ITEM_GENERATION_RULES_V1 } from "../catalog/initial-item-catalog.js";
import {
  checkIntrinsicCharacterEligibility,
  computeActiveEquipmentModifiers,
} from "../domain/equipment-and-stack-rules.js";
import type { CombatEquipmentSlot, ItemRarityCode } from "../domain/item-types.js";
import { PgInventoryTransactionScope } from "../infrastructure/postgres-inventory-unit-of-work.js";

export interface EquippedProceduralItemDetailV1 {
  readonly slotCode: CombatEquipmentSlot;
  readonly occupiesOffHand: boolean;
  readonly itemInstanceId: string;
  readonly definitionCode: string;
  readonly definitionVersion: number;
  readonly itemLevel: number;
  readonly rarityCode: ItemRarityCode;
  readonly qualityBp: number;
  readonly currentDurability: number | null;
  readonly maxDurability: number | null;
  readonly isActiveForCombat: boolean;
  readonly suppressionReason: string | null;
  readonly implicitAttributes: AttributeBlock;
  readonly generatedAttributes: AttributeBlock;
  readonly specialEffects: ReadonlyArray<{
    readonly effectCode: string;
    readonly params: Readonly<Record<string, number>> | null;
  }>;
}

/**
 * Proposed companion projection (`EquipmentSnapshotV1`) carrying full procedural equipment
 * modifiers and passive references for joint review with NEON, keeping `CharacterSnapshotV1`
 * 100% backward-compatible.
 */
export interface EquipmentSnapshotProposalV1 {
  readonly contractVersion: 1;
  readonly characterId: string;
  readonly buildVersion: number;
  readonly snapshotVersion: number;
  readonly activeLoadoutId: string | null;
  readonly normalizationProfile: CompetitiveNormalizationProfile;
  readonly equipmentModifiers: AttributeBlock;
  readonly aggregatedEffectiveAttributes: AttributeBlock;
  readonly equippedDetails: ReadonlyArray<EquippedProceduralItemDetailV1>;
}

export class PostgresEquipmentSnapshotReader {
  private readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  public async getEquipmentSnapshot(
    characterId: string,
    options: {
      readonly principal: AuthorityPrincipal;
      readonly normalizationProfile?: "open_world_persistent" | "legacy_ranked_md3" | undefined;
    },
  ): Promise<EquipmentSnapshotProposalV1> {
    const profile: CompetitiveNormalizationProfile =
      options.normalizationProfile ?? "open_world_persistent";
    if ((profile as string) === "genesis_ranked_md3_scratch") {
      throw new GenesisTemporaryStatePersistenceForbiddenError("getEquipmentSnapshot");
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

      const rules =
        (await invScope.loadGenerationRules(1)) ?? DEFAULT_ITEM_GENERATION_RULES_V1;

      const loadoutRes = await client.query<{ id: string }>(
        `SELECT id FROM equipment_loadouts
         WHERE character_id = $1 AND is_active = TRUE
         LIMIT 1`,
        [character.id],
      );
      const activeLoadoutId = loadoutRes.rows[0]?.id ?? null;
      const slots = activeLoadoutId ? await invScope.listLoadoutSlots(activeLoadoutId) : [];

      const equippedEntries: Array<{
        slot: (typeof slots)[number];
        instance: NonNullable<Awaited<ReturnType<typeof invScope.findItemInstanceById>>>;
        definition: NonNullable<Awaited<ReturnType<typeof invScope.findItemDefinition>>>;
      }> = [];

      for (const s of slots) {
        const inst = await invScope.findItemInstanceById(s.itemInstanceId);
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
        equippedEntries.push({ slot: s, instance: inst, definition: def });
      }

      const aggregated = computeActiveEquipmentModifiers({
        character,
        equippedEntries: equippedEntries.map((e) => ({
          instance: e.instance,
          definition: e.definition,
        })),
        rules,
      });

      const details: EquippedProceduralItemDetailV1[] = equippedEntries.map((e) => {
        const elig = checkIntrinsicCharacterEligibility(character, e.definition, e.instance);
        return {
          slotCode: e.slot.slotCode,
          occupiesOffHand: e.slot.occupiesOffHand,
          itemInstanceId: e.instance.id,
          definitionCode: e.instance.definitionCode,
          definitionVersion: e.instance.definitionVersion,
          itemLevel: e.instance.itemLevel,
          rarityCode: e.instance.rarityCode,
          qualityBp: e.instance.qualityBp,
          currentDurability: e.instance.currentDurability,
          maxDurability: e.instance.maxDurability,
          isActiveForCombat: elig.eligible,
          suppressionReason: elig.failureReason,
          implicitAttributes: e.instance.implicitAttributes,
          generatedAttributes: e.instance.generatedAttributes,
          specialEffects: e.instance.affixes
            .filter((a) => a.specialEffectCode !== null)
            .map((a) => ({
              effectCode: a.specialEffectCode!,
              params: a.specialEffectParams,
            })),
        };
      });

      await client.query("COMMIT");

      return {
        contractVersion: 1,
        characterId: character.id,
        buildVersion: character.buildVersion,
        snapshotVersion: character.snapshotVersion,
        activeLoadoutId,
        normalizationProfile: profile,
        equipmentModifiers: aggregated.equipmentModifiers,
        aggregatedEffectiveAttributes: aggregated.aggregatedEffectiveAttributes,
        equippedDetails: details,
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
