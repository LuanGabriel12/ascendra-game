import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_INT64 } from "../../src/shared/contracts/int64-wire.js";
import { INITIAL_RARITIES_CATALOG } from "../../src/modules/inventory/catalog/initial-item-catalog.js";
import type { ItemRarityCode, RarityDefinition } from "../../src/modules/inventory/domain/item-types.js";
import {
  INITIAL_CURRENCIES_CATALOG,
  INITIAL_LOOT_TABLES_CATALOG,
  SESSION_07_ECONOMY_TITLES_V2,
} from "../../src/modules/economy/catalog/initial-economy-catalog.js";
import {
  InsufficientFundsError,
  LootOrRewardInvalidError,
  MonetaryOverflowOrBoundsError,
  RegionalMarketInvalidError,
} from "../../src/modules/economy/domain/errors.js";
import {
  assertPositiveMonetaryAmount,
  checkedAddMonetary,
  checkedMultiplyUnitPrice,
  checkedSubMonetary,
  computeRegionalListingFee,
  computeRegionalSaleTaxBreakdown,
  minimumXpForProfessionLevel,
  resolveProfessionLevelForXp,
  rollDeterministicCraftingOutcome,
  validateLootTableDefinition,
} from "../../src/modules/economy/domain/monetary-and-tax-rules.js";
import {
  evaluateTitleConditionAst,
  validateTitleConditionAst,
  type TitleEvaluationSnapshot,
} from "../../src/modules/titles/domain/title-contracts.js";

describe("CARBON Session 07 — Unit: Monetary Math, Basis-Point Taxes, Profession Curves, Crafting Quality & Economic Titles", () => {
  const coin = INITIAL_CURRENCIES_CATALOG.find((c) => c.currencyCode === "ascendra_coin")!;
  const rarityMap = new Map<ItemRarityCode, RarityDefinition>(
    INITIAL_RARITIES_CATALOG.map((r) => [r.rarityCode, r]),
  );

  it("enforces integer-only BigInt bounds, maximumBalance ceilings, and non-negative wallet arithmetic", () => {
    assert.equal(assertPositiveMonetaryAmount(1n, "amt"), 1n);
    assert.throws(() => assertPositiveMonetaryAmount(0n, "amt"), MonetaryOverflowOrBoundsError);
    assert.throws(() => assertPositiveMonetaryAmount(-5n, "amt"), MonetaryOverflowOrBoundsError);
    assert.throws(
      () => assertPositiveMonetaryAmount(MAX_INT64 + 1n, "amt"),
      MonetaryOverflowOrBoundsError,
    );

    assert.equal(checkedAddMonetary(500n, 250n, coin), 750n);
    assert.throws(
      () => checkedAddMonetary(coin.maximumBalance, 1n, coin),
      MonetaryOverflowOrBoundsError,
    );
    assert.equal(checkedSubMonetary("w-1", "ascendra_coin", 500n, 500n), 0n);
    assert.throws(
      () => checkedSubMonetary("w-1", "ascendra_coin", 499n, 500n),
      InsufficientFundsError,
    );
    assert.equal(checkedMultiplyUnitPrice(250n, 4), 1000n);
    assert.throws(
      () => checkedMultiplyUnitPrice(MAX_INT64, 2),
      MonetaryOverflowOrBoundsError,
    );
  });

  it("computes exact basis-point regional sale tax and listing fee splits without losing or inventing units", () => {
    // Section 17 exact example: 1,000 units at 5% (500 bp), 0% sink burn -> 950 seller + 50 treasury
    const split1000 = computeRegionalSaleTaxBreakdown({
      grossAmount: 1000n,
      taxRateBp: 500,
      maxTaxRateBp: 2500,
      sinkBurnShareBp: 0,
    });
    assert.equal(split1000.totalTaxAmount, 50n);
    assert.equal(split1000.treasuryAmount, 50n);
    assert.equal(split1000.sinkBurnedAmount, 0n);
    assert.equal(split1000.sellerNetAmount, 950n);

    // Odd prime gross amounts with mixed treasury + sink share always conserve 100%
    const oddSplit = computeRegionalSaleTaxBreakdown({
      grossAmount: 997n,
      taxRateBp: 700,
      maxTaxRateBp: 2500,
      sinkBurnShareBp: 2500,
    });
    assert.equal(
      oddSplit.sellerNetAmount + oddSplit.treasuryAmount + oddSplit.sinkBurnedAmount,
      997n,
    );

    // Reject tax above maxTaxRateBp
    assert.throws(
      () =>
        computeRegionalSaleTaxBreakdown({
          grossAmount: 1000n,
          taxRateBp: 2600,
          maxTaxRateBp: 2500,
          sinkBurnShareBp: 0,
        }),
      RegionalMarketInvalidError,
    );

    const listingFee = computeRegionalListingFee({
      grossAskValue: 1550n,
      policy: {
        settlementId: "st-1",
        policyVersion: 1,
        listingFeeBp: 100,
        saleTaxBp: 500,
        craftingTaxBp: 400,
        repairTaxBp: 200,
        sinkBurnShareBp: 2000,
        roundingMode: "floor_integer",
        isActive: true,
        rulesVersion: 1,
      },
      maxTaxRateBp: 2500,
    });
    assert.equal(listingFee.totalFee, 15n);
    assert.equal(listingFee.treasuryAmount + listingFee.sinkBurnedAmount, listingFee.totalFee);
  });

  it("enforces monotonically increasing non-combat profession mastery curves, deterministic crafting quality bounds, and loot table validation", () => {
    let prevXp = -1n;
    for (let lvl = 1; lvl <= 100; lvl++) {
      const req = minimumXpForProfessionLevel(lvl);
      assert.ok(req > prevXp);
      assert.equal(resolveProfessionLevelForXp(req), lvl);
      prevXp = req;
    }

    for (let i = 0; i < 200; i++) {
      const outcome = rollDeterministicCraftingOutcome({
        recipeCode: "forge_ironfang_longsword",
        recipeVersion: 1,
        recipeMinQualityBp: 2500,
        recipeMaxQualityBp: 9000,
        allowedRarities: ["common", "uncommon", "rare", "epic"],
        rarityCatalog: rarityMap,
        professionLevel: 15,
        averageMaterialQualityBp: 7500,
        toolBonusBp: 300,
        serverSeed: `unit-craft-seed-${i}`,
      });
      const rDef = rarityMap.get(outcome.rarityCode)!;
      assert.ok(["common", "uncommon", "rare", "epic"].includes(outcome.rarityCode));
      assert.ok(outcome.qualityBp >= Math.max(2500, rDef.minQualityBp));
      assert.ok(outcome.qualityBp <= Math.min(9000, rDef.maxQualityBp));
    }

    for (const lt of INITIAL_LOOT_TABLES_CATALOG) {
      validateLootTableDefinition(lt);
    }
    assert.throws(
      () =>
        validateLootTableDefinition({
          ...INITIAL_LOOT_TABLES_CATALOG[0]!,
          entries: [{ ...INITIAL_LOOT_TABLES_CATALOG[0]!.entries[0]!, weight: 0 }],
        }),
      LootOrRewardInvalidError,
    );
  });

  it("validates and evaluates Session 07 declarative economic Title ASTs (legendary_blacksmith & imperial_merchant)", () => {
    for (const td of SESSION_07_ECONOMY_TITLES_V2) {
      validateTitleConditionAst(td.requirements);
    }
    const blacksmithDef = SESSION_07_ECONOMY_TITLES_V2.find(
      (t) => t.titleCode === "legendary_blacksmith",
    )!;
    const merchantDef = SESSION_07_ECONOMY_TITLES_V2.find(
      (t) => t.titleCode === "imperial_merchant",
    )!;

    const baseCtx: TitleEvaluationSnapshot = {
      moralBounty: 0n,
      globalFame: 0n,
      settlementDefensesCount: 0,
      settlementLiberationsCount: 0,
      validatedCrimesCount: 0,
      bountiesFulfilledCount: 0,
      reputationsByLogicalKey: new Map(),
      defensesBySettlementExternalId: new Map(),
      liberationsBySettlementExternalId: new Map(),
      historicalAchievementKeys: new Set(),
      professionsByCode: new Map([["blacksmithing", { level: 5, craftsCompleted: 3 }]]),
      verifiedMarketSalesByCurrency: new Map([
        ["ascendra_coin", { distinctAccountSalesCount: 3, distinctAccountGrossVolume: 2500n }],
      ]),
    };

    assert.equal(evaluateTitleConditionAst(blacksmithDef.requirements, baseCtx), true);
    assert.equal(evaluateTitleConditionAst(merchantDef.requirements, baseCtx), true);

    const unmetCtx: TitleEvaluationSnapshot = {
      ...baseCtx,
      professionsByCode: new Map([["blacksmithing", { level: 4, craftsCompleted: 10 }]]),
      verifiedMarketSalesByCurrency: new Map([
        ["ascendra_coin", { distinctAccountSalesCount: 2, distinctAccountGrossVolume: 99999n }],
      ]),
    };
    assert.equal(evaluateTitleConditionAst(blacksmithDef.requirements, unmetCtx), false);
    assert.equal(evaluateTitleConditionAst(merchantDef.requirements, unmetCtx), false);
  });
});
