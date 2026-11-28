import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { PgPool } from "../../../shared/db/pool.js";
import { StructuredLogger } from "../../../shared/observability/logger.js";
import { CharacterEngineService } from "../../characters/application/character-engine-service.js";
import type { AuthorityPrincipal } from "../../characters/domain/character.js";
import {
  PostgresCharacterRepository,
  PostgresCharacterUnitOfWork,
} from "../../characters/infrastructure/postgres-character-unit-of-work.js";
import { InventoryEngineService } from "../../inventory/application/inventory-engine-service.js";
import type { ItemRarityCode } from "../../inventory/domain/item-types.js";
import { CraftingAndProfessionService } from "../application/crafting-and-profession-service.js";
import { MonetaryAndEscrowService } from "../application/monetary-and-escrow-service.js";
import { RegionalMarketAndMerchantService } from "../application/regional-market-and-merchant-service.js";
import { PostgresEconomyRepository } from "../infrastructure/postgres-economy-unit-of-work.js";

export interface EconomySimulationScenarioConfig {
  readonly characterCount: number;
  readonly transfersCount: number;
  readonly craftsCount: number;
  readonly marketSalesCount: number;
  readonly settlementId: string;
}

export interface EconomySimulationReport {
  readonly config: EconomySimulationScenarioConfig;
  readonly elapsedMs: number;
  readonly isLedgerReconciled: boolean;
  readonly totalMinted: string;
  readonly totalDestroyed: string;
  readonly circulatingSupply: string;
  readonly transferVolume: string;
  readonly regionalTaxCollected: string;
  readonly settlementTreasuryBalance: string;
  readonly craftedItemsCount: number;
  readonly materialsConsumedUnits: number;
  readonly rarityDistribution: Readonly<Partial<Record<ItemRarityCode, number>>>;
}

/**
 * Development transactional simulation harness (Section 35).
 * Measures real PostgreSQL ledger conservation, regional taxes, crafting output, and elapsed latency.
 * NOTE: Development stress/invariant harness only — NOT proof of player-behavior economic balance or production throughput.
 */
export async function runEconomyDevelopmentSimulation(
  pool: PgPool,
  config: EconomySimulationScenarioConfig,
): Promise<EconomySimulationReport> {
  const t0 = performance.now();
  const silent = new StructuredLogger("silent");
  const charRepo = new PostgresCharacterRepository(pool);
  const charEngine = new CharacterEngineService({
    unitOfWork: new PostgresCharacterUnitOfWork(pool),
    logger: silent,
  });
  const invEngine = new InventoryEngineService({ pool, logger: silent });
  const econRepo = new PostgresEconomyRepository(pool);
  const monetary = new MonetaryAndEscrowService({ pool, logger: silent });
  const market = new RegionalMarketAndMerchantService({ pool, logger: silent });
  const crafting = new CraftingAndProfessionService({ pool, logger: silent });

  const sysAuth: AuthorityPrincipal = {
    kind: "internal_system_authority",
    actorId: "economy-sim-harness",
  };
  const runPrefix = `sim-${randomUUID().slice(0, 8)}`;
  const toAlpha = (n: number): string => {
    let x = n + 1;
    let out = "";
    while (x > 0) {
      out = String.fromCharCode(97 + ((x - 1) % 26)) + out;
      x = Math.floor((x - 1) / 26);
    }
    return out;
  };
  const runAlpha = Array.from(runPrefix.replaceAll("-", ""))
    .map((ch) => String.fromCharCode(97 + (ch.charCodeAt(0) % 26)))
    .join("");

  const participants: Array<{ charId: string; principal: AuthorityPrincipal }> = [];
  for (let i = 0; i < config.characterCount; i++) {
    const acc = await charRepo.createAccount({
      id: randomUUID(),
      externalSubject: `${runPrefix}-acc-${i}`,
    });
    const principal: AuthorityPrincipal = { kind: "authenticated_account", accountId: acc.id };
    const ch = (
      await charEngine.createCharacter({
        commandId: `${runPrefix}:char:${i}`,
        principal,
        accountId: acc.id,
        characterName: `Mercador ${runAlpha}${toAlpha(i)}`,
        raceCode: "humans",
        lineageCode: "human_frontier",
        cultureCode: "valewatch_civic",
        backgroundCode: "veteran_soldier",
        originRegionId: "region-ashvale",
        presetCode: "berserker",
        appearance: {
          bodyPreset: "athletic_a",
          skinTone: "olive_bronze",
          hairStyle: "short_cropped",
          hairColor: "raven_black",
          eyeStyle: "almond_sharp",
          eyeColor: "slate_blue",
          earStyle: "rounded_standard",
        },
      })
    ).data;
    participants.push({ charId: ch.id, principal });

    await monetary.mintAuthorizedCurrency({
      commandId: `${runPrefix}:mint:${i}`,
      principal: sysAuth,
      recipientCharacterId: ch.id,
      currencyCode: "ascendra_coin",
      amount: 5_000n,
      sourceCategory: "dev_seed",
      sourceReference: `${runPrefix}:seed`,
    });

    await invEngine.grantStackableMaterial({
      grantId: `${runPrefix}:ore:${i}`,
      principal: sysAuth,
      recipientCharacterId: ch.id,
      definitionCode: "iron_ore",
      quantity: 60,
      originType: "gathering",
      originReference: `${runPrefix}:ore`,
    });
    await invEngine.grantStackableMaterial({
      grantId: `${runPrefix}:wood:${i}`,
      principal: sysAuth,
      recipientCharacterId: ch.id,
      definitionCode: "ancient_wood",
      quantity: 30,
      originType: "gathering",
      originReference: `${runPrefix}:wood`,
    });
  }

  let transferVolume = 0n;
  for (let t = 0; t < config.transfersCount; t++) {
    const from = participants[t % participants.length]!;
    const to = participants[(t + 1) % participants.length]!;
    const amt = BigInt(50 + (t % 5) * 25);
    await monetary.transferCurrencyBetweenCharacters({
      commandId: `${runPrefix}:xfer:${t}`,
      principal: from.principal,
      fromCharacterId: from.charId,
      toCharacterId: to.charId,
      currencyCode: "ascendra_coin",
      amount: amt,
      reason: "sim transfer",
    });
    transferVolume += amt;
  }

  const rarityCounts: Partial<Record<ItemRarityCode, number>> = {};
  const craftedItems: Array<{ ownerIdx: number; itemId: string }> = [];
  for (let c = 0; c < config.craftsCount; c++) {
    const idx = c % participants.length;
    const crafter = participants[idx]!;
    const res = await crafting.craftRecipe({
      operationId: `${runPrefix}:craft:${c}`,
      principal: crafter.principal,
      characterId: crafter.charId,
      recipeCode: "forge_ironfang_longsword",
      stationCode: "station_anvil_t1",
      settlementId: config.settlementId,
      serverEntropySecret: `sim-entropy-secret-${runPrefix}`,
    });
    const rCode = res.data.rolledRarityCode;
    rarityCounts[rCode] = (rarityCounts[rCode] ?? 0) + 1;
    if (res.data.producedItemInstance) {
      craftedItems.push({ ownerIdx: idx, itemId: res.data.producedItemInstance.id });
    }
  }

  const salesToRun = Math.min(config.marketSalesCount, craftedItems.length);
  for (let m = 0; m < salesToRun; m++) {
    const entry = craftedItems[m]!;
    const seller = participants[entry.ownerIdx]!;
    const buyer = participants[(entry.ownerIdx + 1) % participants.length]!;
    const listing = (
      await market.createMarketListing({
        commandId: `${runPrefix}:list:${m}`,
        principal: seller.principal,
        sellerCharacterId: seller.charId,
        settlementId: config.settlementId,
        itemInstanceId: entry.itemId,
        unitPrice: 600n,
      })
    ).data;
    await market.buyMarketListing({
      commandId: `${runPrefix}:buy:${m}`,
      principal: buyer.principal,
      buyerCharacterId: buyer.charId,
      listingId: listing.id,
    });
  }

  const obs = await econRepo.getEconomicObservabilityReport();
  const coinRec = obs.currencies.find((c) => c.currencyCode === "ascendra_coin")!;
  const treasury = await econRepo.getSettlementTreasury(config.settlementId, "ascendra_coin");

  return {
    config,
    elapsedMs: Number((performance.now() - t0).toFixed(2)),
    isLedgerReconciled: coinRec.isBalanced,
    totalMinted: coinRec.totalMinted.toString(),
    totalDestroyed: coinRec.totalDestroyed.toString(),
    circulatingSupply: coinRec.actualCirculatingSupply.toString(),
    transferVolume: transferVolume.toString(),
    regionalTaxCollected: obs.regionalTaxCollectedByCurrency["ascendra_coin"] ?? "0",
    settlementTreasuryBalance: (treasury?.balance ?? 0n).toString(),
    craftedItemsCount: obs.equipmentGeneratedByCraftingCount,
    materialsConsumedUnits: obs.totalMaterialsConsumedInCrafting,
    rarityDistribution: rarityCounts,
  };
}
