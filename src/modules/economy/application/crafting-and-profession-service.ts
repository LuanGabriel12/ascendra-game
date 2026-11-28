import {
  computeCanonicalFingerprintV1,
  deriveDeterministicEventUuid,
} from "../../../shared/contracts/canonical-fingerprint.js";
import type { PgPool } from "../../../shared/db/pool.js";
import type { Logger } from "../../../shared/observability/logger.js";
import type { IdempotentCommandOutcome } from "../../characters/application/character-engine-service.js";
import {
  assertAccountActive,
  assertNotGenesisContext,
  type AuthorityPrincipal,
} from "../../characters/domain/character.js";
import { CharacterCompetitiveLockedError } from "../../characters/domain/errors.js";
import { INITIAL_RARITIES_CATALOG } from "../../inventory/catalog/initial-item-catalog.js";
import {
  InventoryCapacityExceededError,
  ItemDefinitionNotFoundError,
} from "../../inventory/domain/errors.js";
import { resolveInitialBindingOnGrant } from "../../inventory/domain/equipment-and-stack-rules.js";
import type {
  ItemInstance,
  ItemRarityCode,
  RarityDefinition,
} from "../../inventory/domain/item-types.js";
import { generateProceduralItemProperties } from "../../inventory/domain/procedural-generator.js";
import type { CompetitiveNormalizationProfile } from "../../peoples/domain/character-snapshot-proposal.js";
import type {
  CharacterProfessionState,
  CraftingMaterialRequirement,
  CraftingOperationRecord,
  CraftingRecipeDefinition,
  ProfessionCode,
} from "../domain/economy-types.js";
import {
  CraftingOrProfessionError,
  CurrencyOperationForbiddenError,
} from "../domain/errors.js";
import {
  assertPositiveMonetaryAmount,
  resolveProfessionLevelForXp,
  rollDeterministicCraftingOutcome,
} from "../domain/monetary-and-tax-rules.js";
import type { BalancedLedgerLegInput } from "../domain/value-ledger.js";
import {
  PostgresEconomyUnitOfWork,
  type PgEconomyTransactionScope,
} from "../infrastructure/postgres-economy-unit-of-work.js";

export interface GrantProfessionExperienceCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly professionCode: ProfessionCode;
  readonly experienceAmount: bigint;
  readonly sourceReference: string;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface CraftRecipeCommand {
  readonly operationId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly recipeCode: string;
  readonly recipeVersion?: number | undefined;
  readonly stationCode: string;
  readonly settlementId?: string | null | undefined;
  readonly serverEntropySecret: string;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface CraftingEngineDependencies {
  readonly pool: PgPool;
  readonly logger: Logger;
  readonly beforeCommitHook?:
    | ((context: { operation: string; commandId: string }) => Promise<void>)
    | undefined;
}

export class CraftingAndProfessionService {
  private readonly pool: PgPool;
  private readonly uow: PostgresEconomyUnitOfWork;
  private readonly logger: Logger;
  private readonly beforeCommitHook:
    | ((context: { operation: string; commandId: string }) => Promise<void>)
    | undefined;

  constructor(deps: CraftingEngineDependencies) {
    this.pool = deps.pool;
    this.uow = new PostgresEconomyUnitOfWork(deps.pool);
    this.logger = deps.logger;
    this.beforeCommitHook = deps.beforeCommitHook;
  }

  public async listCraftingRecipes(options?: {
    readonly professionCode?: ProfessionCode | undefined;
    readonly onlyEnabled?: boolean | undefined;
  }): Promise<ReadonlyArray<CraftingRecipeDefinition>> {
    const onlyEnabled = options?.onlyEnabled ?? true;
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (onlyEnabled) {
      clauses.push("is_enabled = TRUE");
    }
    if (options?.professionCode) {
      params.push(options.professionCode);
      clauses.push(`required_profession_code = $${params.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM crafting_recipes ${where} ORDER BY recipe_code ASC, recipe_version DESC`,
      params,
    );
    return res.rows.map((r) => ({
      recipeCode: String(r["recipe_code"]),
      recipeVersion: Number(r["recipe_version"]),
      displayName: String(r["display_name"]),
      requiredProfessionCode: r["required_profession_code"] as ProfessionCode,
      requiredMasteryLevel: Number(r["required_mastery_level"]),
      requiredStationCode: String(r["required_station_code"]),
      requiredMaterials: r["required_materials"] as ReadonlyArray<CraftingMaterialRequirement>,
      currencyCode: String(r["currency_code"]),
      currencyCost: BigInt(String(r["currency_cost"])),
      outputDefinitionCode: String(r["output_definition_code"]),
      outputDefinitionVersion: Number(r["output_definition_version"]),
      outputQuantity: Number(r["output_quantity"]),
      allowedRarities: r["allowed_rarities"] as ReadonlyArray<ItemRarityCode>,
      minQualityBp: Number(r["min_quality_bp"]),
      maxQualityBp: Number(r["max_quality_bp"]),
      professionXpGranted: BigInt(String(r["profession_xp_granted"])),
      isEnabled: Boolean(r["is_enabled"]),
      rulesVersion: Number(r["rules_version"]),
    }));
  }

  public async getCharacterProfessions(
    characterId: string,
  ): Promise<ReadonlyArray<CharacterProfessionState>> {
    const res = await this.pool.query<{
      character_id: string;
      profession_code: ProfessionCode;
      profession_level: number;
      profession_experience: string;
      crafts_completed_count: number;
      rules_version: number;
      version: number;
    }>(
      `SELECT * FROM character_professions
       WHERE character_id = $1::uuid
       ORDER BY profession_code ASC`,
      [characterId],
    );
    return res.rows.map((r) => ({
      characterId: r.character_id,
      professionCode: r.profession_code,
      professionLevel: r.profession_level,
      professionExperience: BigInt(r.profession_experience),
      craftsCompletedCount: r.crafts_completed_count,
      rulesVersion: r.rules_version,
      version: r.version,
    }));
  }

  private async ensureAndLockProfessionState(
    scope: PgEconomyTransactionScope,
    characterId: string,
    professionCode: ProfessionCode,
  ): Promise<{ readonly state: CharacterProfessionState; readonly maxLevel: number }> {
    const defRes = await scope.client.query<{ max_level: number; is_enabled: boolean }>(
      "SELECT max_level, is_enabled FROM profession_definitions WHERE profession_code = $1",
      [professionCode],
    );
    const def = defRes.rows[0];
    if (!def || !def.is_enabled) {
      throw new CraftingOrProfessionError(
        `Profession '${professionCode}' is planned/disabled or does not exist.`,
      );
    }

    await scope.client.query(
      `INSERT INTO character_professions (
         character_id, profession_code, profession_level, profession_experience,
         crafts_completed_count, rules_version, version
       )
       VALUES ($1::uuid, $2, 1, 0, 0, 1, 1)
       ON CONFLICT (character_id, profession_code) DO NOTHING`,
      [characterId, professionCode],
    );

    const lockedRes = await scope.client.query<{
      character_id: string;
      profession_code: ProfessionCode;
      profession_level: number;
      profession_experience: string;
      crafts_completed_count: number;
      rules_version: number;
      version: number;
    }>(
      `SELECT * FROM character_professions
       WHERE character_id = $1::uuid AND profession_code = $2
       FOR UPDATE`,
      [characterId, professionCode],
    );
    const r = lockedRes.rows[0]!;
    return {
      state: {
        characterId: r.character_id,
        professionCode: r.profession_code,
        professionLevel: r.profession_level,
        professionExperience: BigInt(r.profession_experience),
        craftsCompletedCount: r.crafts_completed_count,
        rulesVersion: r.rules_version,
        version: r.version,
      },
      maxLevel: def.max_level,
    };
  }

  public async grantProfessionExperience(
    cmd: GrantProfessionExperienceCommand,
  ): Promise<IdempotentCommandOutcome<CharacterProfessionState>> {
    assertNotGenesisContext("grantProfessionExperience", cmd.executionProfile);
    if (cmd.principal.kind !== "internal_system_authority") {
      throw new CurrencyOperationForbiddenError(
        "grantProfessionExperience requires internal_system_authority.",
      );
    }
    const sysActorId = cmd.principal.actorId;
    assertPositiveMonetaryAmount(cmd.experienceAmount, "experienceAmount");
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "GrantProfessionExperience",
      character_id: cmd.characterId.toLowerCase(),
      profession_code: cmd.professionCode,
      experience_amount: cmd.experienceAmount.toString(),
      source_reference: cmd.sourceReference.trim(),
    });

    return this.uow.executeInTransaction(async (scope) => {
      const { characters, accounts } = await scope.lockCharactersAndAccountsCanonical([
        cmd.characterId,
      ]);
      const ch = characters.get(cmd.characterId.toLowerCase())!;
      ch.assertActiveStatus();
      assertAccountActive(accounts.get(ch.accountId.toLowerCase())!);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "CraftingCompleted",
        eventVersion: 1,
        source: `carbon.economy.professions:${sysActorId}`,
        correlationUuid: eventUuid,
        aggregateUuid: ch.id,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const { state, maxLevel } = await this.ensureAndLockProfessionState(
        scope,
        ch.id,
        cmd.professionCode,
      );
      if (claim.status === "duplicate_verified") {
        return { status: "duplicate_idempotent", duplicate: true, data: state };
      }

      const nextXp = state.professionExperience + cmd.experienceAmount;
      const nextLvl = resolveProfessionLevelForXp(nextXp, maxLevel);
      await scope.client.query(
        `UPDATE character_professions
         SET profession_experience = $1::bigint,
             profession_level = $2,
             version = version + 1,
             updated_at = $3
         WHERE character_id = $4::uuid AND profession_code = $5 AND version = $6`,
        [nextXp.toString(), nextLvl, now, ch.id, cmd.professionCode, state.version],
      );

      return {
        status: "applied",
        duplicate: false,
        data: {
          ...state,
          professionExperience: nextXp,
          professionLevel: nextLvl,
          version: state.version + 1,
        },
      };
    });
  }

  /**
   * Executes an atomic crafting operation:
   * 1. Verifies active character/account, recipe eligibility, station match, and profession mastery level.
   * 2. Consumes all required materials from `character_inventory` (rolls back everything if any material is missing).
   * 3. Charges crafting fee (splitting between `settlement_treasury` and `system_sink`).
   * 4. Generates procedural equipment (recording `crafted_by_character_id` and `crafting_recipe_code` provenance).
   * 5. Advances independent profession XP & completed crafts counter.
   */
  public async craftRecipe(
    cmd: CraftRecipeCommand,
  ): Promise<IdempotentCommandOutcome<CraftingOperationRecord>> {
    assertNotGenesisContext("craftRecipe", cmd.executionProfile);
    if (!cmd.serverEntropySecret.trim() || cmd.serverEntropySecret.trim().length < 8) {
      throw new CraftingOrProfessionError("serverEntropySecret must be at least 8 characters.");
    }
    const opKey = cmd.operationId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(opKey);
    const craftRowId = deriveDeterministicEventUuid(`craft-op:${opKey}`);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "CraftRecipe",
      operation_id: opKey,
      character_id: cmd.characterId.toLowerCase(),
      recipe_code: cmd.recipeCode,
      recipe_version: cmd.recipeVersion ?? null,
      station_code: cmd.stationCode.trim(),
      settlement_id: cmd.settlementId?.toLowerCase() ?? null,
      server_entropy_secret: cmd.serverEntropySecret.trim(),
    });

    return this.uow.executeInTransaction(async (scope) => {
      const { characters, accounts } = await scope.lockCharactersAndAccountsCanonical([
        cmd.characterId,
      ]);
      const crafter = characters.get(cmd.characterId.toLowerCase())!;
      crafter.assertOwnedByOrSystem(cmd.principal);
      crafter.assertActiveStatus();
      assertAccountActive(accounts.get(crafter.accountId.toLowerCase())!);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: opKey,
        idempotencyKey: opKey,
        eventType: "CraftingCompleted",
        eventVersion: 1,
        source: "carbon.economy.crafting",
        correlationUuid: eventUuid,
        aggregateUuid: crafter.id,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      if (claim.status === "duplicate_verified") {
        const exRes = await scope.client.query<Record<string, unknown>>(
          "SELECT * FROM crafting_operations WHERE operation_id = $1",
          [opKey],
        );
        const ex = exRes.rows[0]!;
        const prodInst = ex["produced_item_instance_id"]
          ? await scope.inventory.findItemInstanceById(String(ex["produced_item_instance_id"]))
          : null;
        const profs = await this.getCharacterProfessions(crafter.id);
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: {
            id: String(ex["id"]),
            operationId: String(ex["operation_id"]),
            characterId: String(ex["character_id"]),
            settlementId: (ex["settlement_id"] as string | null) ?? null,
            recipeCode: String(ex["recipe_code"]),
            recipeVersion: Number(ex["recipe_version"]),
            stationCode: String(ex["station_code"]),
            consumedMaterials: ex["consumed_materials"] as CraftingOperationRecord["consumedMaterials"],
            currencyPaid: BigInt(String(ex["currency_paid"])),
            ledgerTxId: (ex["ledger_tx_id"] as string | null) ?? null,
            producedItemInstance: prodInst,
            rolledRarityCode: ex["rolled_rarity_code"] as ItemRarityCode,
            rolledQualityBp: Number(ex["rolled_quality_bp"]),
            professionXpAwarded: BigInt(String(ex["profession_xp_awarded"])),
            resultingProfessionState: profs[0]!,
            rulesVersion: Number(ex["rules_version"]),
            craftedAt: ex["crafted_at"] as Date,
          },
        };
      }

      if (crafter.competitiveLockState === "in_ranked_series") {
        throw new CharacterCompetitiveLockedError(crafter.id);
      }

      const recRes =
        cmd.recipeVersion !== undefined
          ? await scope.client.query<Record<string, unknown>>(
              "SELECT * FROM crafting_recipes WHERE recipe_code = $1 AND recipe_version = $2",
              [cmd.recipeCode, cmd.recipeVersion],
            )
          : await scope.client.query<Record<string, unknown>>(
              `SELECT * FROM crafting_recipes
               WHERE recipe_code = $1 AND is_enabled = TRUE
               ORDER BY recipe_version DESC LIMIT 1`,
              [cmd.recipeCode],
            );
      const rRow = recRes.rows[0];
      if (!rRow || !rRow["is_enabled"]) {
        throw new CraftingOrProfessionError(`Crafting recipe '${cmd.recipeCode}' unavailable.`);
      }
      const recipe: CraftingRecipeDefinition = {
        recipeCode: String(rRow["recipe_code"]),
        recipeVersion: Number(rRow["recipe_version"]),
        displayName: String(rRow["display_name"]),
        requiredProfessionCode: rRow["required_profession_code"] as ProfessionCode,
        requiredMasteryLevel: Number(rRow["required_mastery_level"]),
        requiredStationCode: String(rRow["required_station_code"]),
        requiredMaterials: rRow["required_materials"] as ReadonlyArray<CraftingMaterialRequirement>,
        currencyCode: String(rRow["currency_code"]),
        currencyCost: BigInt(String(rRow["currency_cost"])),
        outputDefinitionCode: String(rRow["output_definition_code"]),
        outputDefinitionVersion: Number(rRow["output_definition_version"]),
        outputQuantity: Number(rRow["output_quantity"]),
        allowedRarities: rRow["allowed_rarities"] as ReadonlyArray<ItemRarityCode>,
        minQualityBp: Number(rRow["min_quality_bp"]),
        maxQualityBp: Number(rRow["max_quality_bp"]),
        professionXpGranted: BigInt(String(rRow["profession_xp_granted"])),
        isEnabled: Boolean(rRow["is_enabled"]),
        rulesVersion: Number(rRow["rules_version"]),
      };

      if (cmd.stationCode.trim() !== recipe.requiredStationCode) {
        throw new CraftingOrProfessionError(
          `Recipe '${recipe.recipeCode}' requires station '${recipe.requiredStationCode}', got '${cmd.stationCode}'.`,
        );
      }

      const { state: profState, maxLevel } = await this.ensureAndLockProfessionState(
        scope,
        crafter.id,
        recipe.requiredProfessionCode,
      );
      if (profState.professionLevel < recipe.requiredMasteryLevel) {
        throw new CraftingOrProfessionError(
          `Character '${crafter.id}' has '${recipe.requiredProfessionCode}' level ${profState.professionLevel}, below required level ${recipe.requiredMasteryLevel}.`,
        );
      }

      const genRules = (await scope.inventory.loadGenerationRules(1))!;
      const { bag, activeLoadout } = await scope.inventory.ensureAndLockPrimaryContainers(
        crafter.id,
        genRules.defaultInventoryCapacity,
      );

      // Consume required materials atomically first (frees full stacks if consumed completely!)
      const consumedMaterials = await scope.consumeMaterialsFromCharacterBag({
        character: crafter,
        bag,
        requirements: recipe.requiredMaterials,
        operationId: opKey,
        causeReference: `craft:${recipe.recipeCode}:v${recipe.recipeVersion}`,
      });

      // Charge crafting fee (split between settlement treasury & system_sink)
      let ledgerTxId: string | null = null;
      if (recipe.currencyCost > 0n) {
        const econRules = await scope.loadEconomicRules(1);
        const walletId = await scope.ensurePlayerWalletId(crafter.id, recipe.currencyCode);
        const legs: BalancedLedgerLegInput[] = [];

        if (cmd.settlementId) {
          const stExists = await scope.client.query<{ id: string }>(
            "SELECT id FROM settlements WHERE id = $1::uuid",
            [cmd.settlementId],
          );
          if (!stExists.rows[0]) {
            throw new CraftingOrProfessionError(`Settlement '${cmd.settlementId}' not found.`);
          }
          const treasuryPart =
            (recipe.currencyCost * BigInt(econRules.craftingStationTaxTreasuryShareBp)) / 10_000n;
          const sinkPart = recipe.currencyCost - treasuryPart;
          if (treasuryPart > 0n) {
            const trId = await scope.ensureSettlementTreasuryId(
              cmd.settlementId,
              recipe.currencyCode,
            );
            legs.push({
              debitAccountId: walletId,
              creditAccountId: trId,
              amount: treasuryPart,
              memo: `Crafting station fee (treasury) for ${recipe.recipeCode}`,
            });
          }
          if (sinkPart > 0n) {
            const sinkId = await scope.ensureCanonicalTechnicalAccountId(
              "system_sink",
              recipe.currencyCode,
            );
            legs.push({
              debitAccountId: walletId,
              creditAccountId: sinkId,
              amount: sinkPart,
              memo: `Crafting station fee (sink) for ${recipe.recipeCode}`,
            });
          }
        } else {
          const sinkId = await scope.ensureCanonicalTechnicalAccountId(
            "system_sink",
            recipe.currencyCode,
          );
          legs.push({
            debitAccountId: walletId,
            creditAccountId: sinkId,
            amount: recipe.currencyCost,
            memo: `Crafting fee (sink) for ${recipe.recipeCode}`,
          });
        }

        const feeTx = await scope.executeBalancedLedgerTransaction({
          idempotencyKey: `${opKey}:craft-fee`,
          processedEventId: claim.eventUuid,
          operationType: "crafting_fee",
          currencyCode: recipe.currencyCode,
          correlationId: eventUuid,
          sourceEventId: opKey,
          actorType: cmd.principal.kind,
          actorId: crafter.id,
          legs,
        });
        ledgerTxId = feeTx.id;
      }

      const outputDef = await scope.inventory.findItemDefinition(
        recipe.outputDefinitionCode,
        recipe.outputDefinitionVersion,
      );
      if (!outputDef) {
        throw new ItemDefinitionNotFoundError(
          recipe.outputDefinitionCode,
          recipe.outputDefinitionVersion,
        );
      }

      // Check optional equipped smithing tool bonus (`craftingTags.includes('tool_smithing')`)
      let toolBonusBp = 0;
      const mainHandSlot = activeLoadout.slots.find((s) => s.slotCode === "main_hand");
      if (mainHandSlot) {
        const mhInst = await scope.inventory.findItemInstanceById(mainHandSlot.itemInstanceId);
        if (mhInst && (mhInst.currentDurability === null || mhInst.currentDurability > 0)) {
          const mhDef = await scope.inventory.findItemDefinition(
            mhInst.definitionCode,
            mhInst.definitionVersion,
          );
          if (mhDef?.craftingTags.includes("tool_smithing")) {
            toolBonusBp = 250;
          }
        }
      }

      const avgMatQuality =
        consumedMaterials.length > 0
          ? Math.floor(
              consumedMaterials.reduce((acc, m) => acc + m.averageQualityBp, 0) /
                consumedMaterials.length,
            )
          : 5000;

      const rarityMap = new Map<ItemRarityCode, RarityDefinition>(
        INITIAL_RARITIES_CATALOG.map((r) => [r.rarityCode, r]),
      );
      const rolled = rollDeterministicCraftingOutcome({
        recipeCode: recipe.recipeCode,
        recipeVersion: recipe.recipeVersion,
        recipeMinQualityBp: recipe.minQualityBp,
        recipeMaxQualityBp: recipe.maxQualityBp,
        allowedRarities: recipe.allowedRarities,
        rarityCatalog: rarityMap,
        professionLevel: profState.professionLevel,
        averageMaterialQualityBp: avgMatQuality,
        toolBonusBp,
        serverSeed: `${cmd.serverEntropySecret.trim()}:${opKey}:${crafter.id}`,
      });

      const freeSlots = await scope.inventory.findFreeContainerSlots(bag, 1);
      if (freeSlots.length < 1) {
        throw new InventoryCapacityExceededError(
          `Character '${crafter.id}' inventory is full; cannot place crafted item '${outputDef.definitionCode}'.`,
        );
      }

      const rarityDef = (await scope.inventory.findRarity(rolled.rarityCode))!;
      const affixes = await scope.inventory.listAffixesForPools(outputDef.allowedAffixPools);
      const gen = generateProceduralItemProperties({
        definition: outputDef,
        rarity: rarityDef,
        rules: genRules,
        candidateAffixes: affixes,
        itemLevel: outputDef.baseItemLevel,
        serverSeed: `${cmd.serverEntropySecret.trim()}:item:${opKey}`,
        originReference: `craft:${recipe.recipeCode}:crafter:${crafter.id}`,
        qualityBpOverride: rolled.qualityBp,
      });

      const bind = resolveInitialBindingOnGrant({
        policy: outputDef.bindingPolicy,
        recipientAccountId: crafter.accountId,
        recipientCharacterId: crafter.id,
      });

      const producedId = deriveDeterministicEventUuid(`crafted-item:${opKey}`);
      const craftedInst: ItemInstance = {
        id: producedId,
        definitionCode: outputDef.definitionCode,
        definitionVersion: outputDef.definitionVersion,
        ownerAccountId: crafter.accountId,
        ownerCharacterId: crafter.id,
        locationState: "in_container",
        containerId: bag.id,
        containerSlotIndex: freeSlots[0]!,
        itemLevel: gen.itemLevel,
        rarityCode: gen.rarityCode,
        qualityBp: gen.qualityBp,
        powerBudgetTotal: gen.powerBudgetTotal,
        powerBudgetSpent: gen.powerBudgetSpent,
        implicitAttributes: gen.implicitAttributes,
        generatedAttributes: gen.generatedAttributes,
        affixes: gen.affixes,
        currentDurability: gen.currentDurability,
        maxDurability: gen.maxDurability,
        bindingState: bind.bindingState,
        boundAccountId: bind.boundAccountId,
        boundCharacterId: bind.boundCharacterId,
        generationRulesVersion: genRules.rulesVersion,
        generationSeedHash: gen.generationSeedHash,
        originType: "crafting",
        originReference: `craft:${recipe.recipeCode}:by:${crafter.id}`,
        craftedByCharacterId: crafter.id,
        craftingRecipeCode: recipe.recipeCode,
        instanceVersion: 1,
        createdAt: now,
        updatedAt: now,
      };
      await scope.inventory.insertItemInstance(craftedInst);

      // Record crafter provenance columns added in migration 0015
      await scope.client.query(
        `UPDATE item_instances
         SET crafted_by_character_id = $1::uuid, crafting_recipe_code = $2
         WHERE id = $3::uuid`,
        [crafter.id, recipe.recipeCode, craftedInst.id],
      );

      await scope.inventory.appendLedger({
        operationId: opKey,
        operationType: "craft",
        characterId: crafter.id,
        itemInstanceId: craftedInst.id,
        definitionCode: craftedInst.definitionCode,
        definitionVersion: craftedInst.definitionVersion,
        sourceLocation: `station:${recipe.requiredStationCode}`,
        destinationLocation: `container:${bag.id}:slot:${freeSlots[0]!}`,
        quantity: 1,
        entityVersion: 1,
        causeReference: opKey,
        metadata: {
          recipe_code: recipe.recipeCode,
          crafted_by_character_id: crafter.id,
          quality_bp: craftedInst.qualityBp,
          rarity_code: craftedInst.rarityCode,
        },
      });

      const nextXp = profState.professionExperience + recipe.professionXpGranted;
      const nextLvl = resolveProfessionLevelForXp(nextXp, maxLevel);
      const nextCrafts = profState.craftsCompletedCount + 1;
      await scope.client.query(
        `UPDATE character_professions
         SET profession_experience = $1::bigint,
             profession_level = $2,
             crafts_completed_count = $3,
             version = version + 1,
             updated_at = $4
         WHERE character_id = $5::uuid AND profession_code = $6 AND version = $7`,
        [
          nextXp.toString(),
          nextLvl,
          nextCrafts,
          now,
          crafter.id,
          recipe.requiredProfessionCode,
          profState.version,
        ],
      );

      const nextProfState: CharacterProfessionState = {
        ...profState,
        professionExperience: nextXp,
        professionLevel: nextLvl,
        craftsCompletedCount: nextCrafts,
        version: profState.version + 1,
      };

      await scope.client.query(
        `INSERT INTO crafting_operations (
           id, processed_event_id, operation_id, character_id, settlement_id,
           recipe_code, recipe_version, station_code, consumed_materials,
           currency_paid, ledger_tx_id, produced_item_instance_id, produced_stack_id,
           rolled_rarity_code, rolled_quality_bp, profession_xp_awarded, rules_version, crafted_at
         )
         VALUES (
           $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid,
           $6, $7, $8, $9::jsonb,
           $10::bigint, $11::uuid, $12::uuid, NULL,
           $13, $14, $15::bigint, $16, $17
         )`,
        [
          craftRowId,
          claim.eventUuid,
          opKey,
          crafter.id,
          cmd.settlementId ?? null,
          recipe.recipeCode,
          recipe.recipeVersion,
          recipe.requiredStationCode,
          JSON.stringify(consumedMaterials),
          recipe.currencyCost.toString(),
          ledgerTxId,
          craftedInst.id,
          craftedInst.rarityCode,
          craftedInst.qualityBp,
          recipe.professionXpGranted.toString(),
          recipe.rulesVersion,
          now,
        ],
      );

      await scope.enqueueEconomyOutbox({
        aggregateType: "CraftingOperation",
        aggregateId: craftRowId,
        eventType: "CraftingCompleted",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          crafting_operation_id: craftRowId,
          character_id: crafter.id,
          recipe_code: recipe.recipeCode,
          produced_item_instance_id: craftedInst.id,
          rarity_code: craftedInst.rarityCode,
          quality_bp: craftedInst.qualityBp,
          profession_level_after: nextLvl,
        },
      });

      if (this.beforeCommitHook) {
        await this.beforeCommitHook({ operation: "craftRecipe", commandId: opKey });
      }

      this.logger.info("Completed atomic item crafting operation", {
        event_id: opKey,
        aggregate_id: craftRowId,
        operation: "craftRecipe",
      });

      return {
        status: "applied",
        duplicate: false,
        data: {
          id: craftRowId,
          operationId: opKey,
          characterId: crafter.id,
          settlementId: cmd.settlementId ?? null,
          recipeCode: recipe.recipeCode,
          recipeVersion: recipe.recipeVersion,
          stationCode: recipe.requiredStationCode,
          consumedMaterials,
          currencyPaid: recipe.currencyCost,
          ledgerTxId,
          producedItemInstance: craftedInst,
          rolledRarityCode: craftedInst.rarityCode,
          rolledQualityBp: craftedInst.qualityBp,
          professionXpAwarded: recipe.professionXpGranted,
          resultingProfessionState: nextProfState,
          rulesVersion: recipe.rulesVersion,
          craftedAt: now,
        },
      };
    });
  }
}
