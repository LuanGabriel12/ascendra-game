import { MAX_INT64 } from "../../../shared/contracts/int64-wire.js";
import type { ItemRarityCode, RarityDefinition } from "../../inventory/domain/item-types.js";
import { SplitMix64Rng } from "../../inventory/domain/splitmix64-rng.js";
import type {
  CurrencyDefinition,
  LootTableDefinition,
  LootTableEntryDefinition,
  RegionalTaxPolicy,
} from "./economy-types.js";
import {
  CraftingOrProfessionError,
  InsufficientFundsError,
  LootOrRewardInvalidError,
  MonetaryLedgerImbalanceError,
  MonetaryOverflowOrBoundsError,
  RegionalMarketInvalidError,
} from "./errors.js";

const BASIS_POINTS_SCALE = 10_000n;

export function assertPositiveMonetaryAmount(amount: bigint, fieldName: string): bigint {
  if (typeof amount !== "bigint") {
    throw new MonetaryOverflowOrBoundsError(`${fieldName} must be a bigint.`);
  }
  if (amount <= 0n || amount > MAX_INT64) {
    throw new MonetaryOverflowOrBoundsError(
      `${fieldName} (${amount.toString()}) must be within 1..${MAX_INT64.toString()}.`,
    );
  }
  return amount;
}

export function assertNonNegativeMonetaryAmount(amount: bigint, fieldName: string): bigint {
  if (typeof amount !== "bigint") {
    throw new MonetaryOverflowOrBoundsError(`${fieldName} must be a bigint.`);
  }
  if (amount < 0n || amount > MAX_INT64) {
    throw new MonetaryOverflowOrBoundsError(
      `${fieldName} (${amount.toString()}) must be within 0..${MAX_INT64.toString()}.`,
    );
  }
  return amount;
}

export function checkedAddMonetary(
  currentBalance: bigint,
  delta: bigint,
  currency: CurrencyDefinition,
  isTechnicalCounter = false,
): bigint {
  assertNonNegativeMonetaryAmount(currentBalance, "currentBalance");
  assertPositiveMonetaryAmount(delta, "delta");
  const next = currentBalance + delta;
  if (next > MAX_INT64) {
    throw new MonetaryOverflowOrBoundsError(
      `Monetary int64 overflow adding ${delta.toString()} to ${currentBalance.toString()}.`,
    );
  }
  if (!isTechnicalCounter && next > currency.maximumBalance) {
    throw new MonetaryOverflowOrBoundsError(
      `Resulting '${currency.currencyCode}' balance ${next.toString()} exceeds maximumBalance ${currency.maximumBalance.toString()}.`,
    );
  }
  return next;
}

export function checkedSubMonetary(
  walletId: string,
  currencyCode: string,
  currentBalance: bigint,
  debitAmount: bigint,
): bigint {
  assertNonNegativeMonetaryAmount(currentBalance, "currentBalance");
  assertPositiveMonetaryAmount(debitAmount, "debitAmount");
  if (currentBalance < debitAmount) {
    throw new InsufficientFundsError(walletId, currencyCode, debitAmount, currentBalance);
  }
  return currentBalance - debitAmount;
}

export function checkedMultiplyUnitPrice(unitPrice: bigint, quantity: number): bigint {
  assertPositiveMonetaryAmount(unitPrice, "unitPrice");
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new MonetaryOverflowOrBoundsError(`Invalid quantity '${String(quantity)}'.`);
  }
  const total = unitPrice * BigInt(quantity);
  if (total <= 0n || total > MAX_INT64) {
    throw new MonetaryOverflowOrBoundsError(
      `Gross amount ${unitPrice.toString()} * ${quantity} overflows int64.`,
    );
  }
  return total;
}

export interface TaxSplitBreakdown {
  readonly grossAmount: bigint;
  readonly totalTaxAmount: bigint;
  readonly treasuryAmount: bigint;
  readonly sinkBurnedAmount: bigint;
  readonly sellerNetAmount: bigint;
}

/**
 * Computes deterministic integer-floor basis-point tax & fee splits.
 * Guarantees exact conservation: `sellerNetAmount + treasuryAmount + sinkBurnedAmount === grossAmount`.
 */
export function computeRegionalSaleTaxBreakdown(params: {
  readonly grossAmount: bigint;
  readonly taxRateBp: number;
  readonly maxTaxRateBp: number;
  readonly sinkBurnShareBp: number;
}): TaxSplitBreakdown {
  assertPositiveMonetaryAmount(params.grossAmount, "grossAmount");
  if (
    !Number.isInteger(params.taxRateBp) ||
    params.taxRateBp < 0 ||
    params.taxRateBp > params.maxTaxRateBp ||
    params.taxRateBp > 10_000
  ) {
    throw new RegionalMarketInvalidError(
      `Tax rate ${params.taxRateBp} bp violates configured bounds 0..${params.maxTaxRateBp} bp.`,
    );
  }
  if (
    !Number.isInteger(params.sinkBurnShareBp) ||
    params.sinkBurnShareBp < 0 ||
    params.sinkBurnShareBp > 10_000
  ) {
    throw new RegionalMarketInvalidError(
      `sinkBurnShareBp ${params.sinkBurnShareBp} must be within 0..10000 bp.`,
    );
  }

  const totalTaxAmount = (params.grossAmount * BigInt(params.taxRateBp)) / BASIS_POINTS_SCALE;
  const sinkBurnedAmount =
    (totalTaxAmount * BigInt(params.sinkBurnShareBp)) / BASIS_POINTS_SCALE;
  const treasuryAmount = totalTaxAmount - sinkBurnedAmount;
  const sellerNetAmount = params.grossAmount - totalTaxAmount;

  if (sellerNetAmount + treasuryAmount + sinkBurnedAmount !== params.grossAmount) {
    throw new MonetaryLedgerImbalanceError("Tax split failed exact integer conservation.");
  }

  return {
    grossAmount: params.grossAmount,
    totalTaxAmount,
    treasuryAmount,
    sinkBurnedAmount,
    sellerNetAmount,
  };
}

export function computeRegionalListingFee(params: {
  readonly grossAskValue: bigint;
  readonly policy: RegionalTaxPolicy;
  readonly maxTaxRateBp: number;
}): {
  readonly totalFee: bigint;
  readonly treasuryAmount: bigint;
  readonly sinkBurnedAmount: bigint;
} {
  assertPositiveMonetaryAmount(params.grossAskValue, "grossAskValue");
  if (params.policy.listingFeeBp < 0 || params.policy.listingFeeBp > params.maxTaxRateBp) {
    throw new RegionalMarketInvalidError(
      `Listing fee ${params.policy.listingFeeBp} bp exceeds maxTaxRateBp ${params.maxTaxRateBp}.`,
    );
  }
  const totalFee = (params.grossAskValue * BigInt(params.policy.listingFeeBp)) / BASIS_POINTS_SCALE;
  const sinkBurnedAmount =
    (totalFee * BigInt(params.policy.sinkBurnShareBp)) / BASIS_POINTS_SCALE;
  const treasuryAmount = totalFee - sinkBurnedAmount;
  return { totalFee, treasuryAmount, sinkBurnedAmount };
}

/**
 * Independent non-combat profession mastery XP curve (`1..100`).
 * Strictly decoupled from combat XP and weapon mastery XP (Section 26).
 */
export function minimumXpForProfessionLevel(level: number): bigint {
  if (!Number.isInteger(level) || level < 1 || level > 100) {
    throw new CraftingOrProfessionError(`Invalid profession level ${String(level)} (expected 1..100).`);
  }
  if (level === 1) {
    return 0n;
  }
  const n = BigInt(level - 1);
  // Quadratic curve: L2 = 100, L5 = 880, L10 = 3330, L50 = 96530, L100 = 393030
  return 60n * n + 40n * n * n;
}

export function resolveProfessionLevelForXp(totalXp: bigint, maxLevel = 100): number {
  if (totalXp < 0n || totalXp > MAX_INT64) {
    throw new CraftingOrProfessionError("Invalid profession totalXp.");
  }
  let low = 1;
  let high = maxLevel;
  let best = 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (minimumXpForProfessionLevel(mid) <= totalXp) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/**
 * Provisional versioned crafting quality calculation (Section 27):
 * Combines recipe `[minQualityBp, maxQualityBp]`, material average quality, blacksmithing mastery level,
 * and deterministic RNG roll, strictly clamped to both the recipe's `[minQualityBp, maxQualityBp]` AND
 * the selected rarity's `[minQualityBp, maxQualityBp]` so crafted items NEVER exceed power budgets!
 */
export function rollDeterministicCraftingOutcome(params: {
  readonly recipeCode: string;
  readonly recipeVersion: number;
  readonly recipeMinQualityBp: number;
  readonly recipeMaxQualityBp: number;
  readonly allowedRarities: ReadonlyArray<ItemRarityCode>;
  readonly rarityCatalog: ReadonlyMap<ItemRarityCode, RarityDefinition>;
  readonly professionLevel: number;
  readonly averageMaterialQualityBp: number;
  readonly toolBonusBp: number;
  readonly serverSeed: string;
}): {
  readonly rarityCode: ItemRarityCode;
  readonly qualityBp: number;
} {
  if (params.allowedRarities.length === 0) {
    throw new CraftingOrProfessionError(`Recipe '${params.recipeCode}' has empty allowedRarities.`);
  }
  const seedStr = [
    "ascendra:craft:v1",
    params.recipeCode,
    String(params.recipeVersion),
    String(params.professionLevel),
    String(params.averageMaterialQualityBp),
    String(params.toolBonusBp),
    params.serverSeed.trim(),
  ].join("|");
  const rng = new SplitMix64Rng(seedStr);

  // Provisional rarity weights boosted modestly by profession mastery (never bypassing allowedRarities)
  const masteryBonus = Math.max(0, params.professionLevel - 1);
  const baseWeights: Record<ItemRarityCode, number> = {
    common: 500,
    uncommon: 300 + masteryBonus * 6,
    rare: 140 + masteryBonus * 5,
    epic: 45 + masteryBonus * 3,
    legendary: 12 + masteryBonus,
    mythic: 3,
    relic: 1,
  };

  let totalWeight = 0;
  const weighted: Array<{ rarity: ItemRarityCode; weight: number }> = [];
  for (const r of params.allowedRarities) {
    const w = Math.max(1, baseWeights[r] ?? 1);
    weighted.push({ rarity: r, weight: w });
    totalWeight += w;
  }

  const ticket = rng.nextIntInclusive(1, totalWeight);
  let acc = 0;
  let chosenRarity: ItemRarityCode = weighted[weighted.length - 1]!.rarity;
  for (const item of weighted) {
    acc += item.weight;
    if (ticket <= acc) {
      chosenRarity = item.rarity;
      break;
    }
  }

  const rarityDef = params.rarityCatalog.get(chosenRarity);
  if (!rarityDef) {
    throw new CraftingOrProfessionError(`Rarity '${chosenRarity}' missing from catalog.`);
  }

  const floorBp = Math.max(params.recipeMinQualityBp, rarityDef.minQualityBp);
  const ceilBp = Math.min(params.recipeMaxQualityBp, rarityDef.maxQualityBp);
  const safeMin = Math.min(floorBp, rarityDef.maxQualityBp);
  const safeMax = Math.max(safeMin, ceilBp);

  const baseRoll = rng.nextIntInclusive(safeMin, safeMax);
  // Mastery + material quality shift within [safeMin, safeMax], NEVER exceeding safeMax or 10000
  const masteryShift = Math.min(1200, masteryBonus * 25);
  const matShift = Math.floor(Math.max(0, params.averageMaterialQualityBp - 5000) / 5);
  const rawQuality = baseRoll + Math.floor((masteryShift + matShift + params.toolBonusBp) / 2);
  const qualityBp = Math.min(safeMax, Math.max(safeMin, rawQuality));

  return { rarityCode: chosenRarity, qualityBp };
}

export function validateLootTableDefinition(table: LootTableDefinition): void {
  if (!table.lootTableCode.trim() || table.lootTableVersion < 1) {
    throw new LootOrRewardInvalidError("Invalid lootTableCode or lootTableVersion.");
  }
  if (!Number.isInteger(table.rollsCount) || table.rollsCount < 1 || table.rollsCount > 10) {
    throw new LootOrRewardInvalidError("lootTable rollsCount must be in 1..10.");
  }
  if (table.entries.length === 0) {
    throw new LootOrRewardInvalidError(`Loot table '${table.lootTableCode}' has no entries.`);
  }
  for (const e of table.entries) {
    if (!Number.isInteger(e.weight) || e.weight <= 0) {
      throw new LootOrRewardInvalidError(
        `Loot entry '${e.entryCode}' in '${table.lootTableCode}' must have positive integer weight.`,
      );
    }
    if (
      !Number.isInteger(e.minQuantity) ||
      e.minQuantity <= 0 ||
      !Number.isInteger(e.maxQuantity) ||
      e.maxQuantity < e.minQuantity
    ) {
      throw new LootOrRewardInvalidError(
        `Loot entry '${e.entryCode}' has invalid quantity bounds [${e.minQuantity}, ${e.maxQuantity}].`,
      );
    }
    if (e.entryKind === "procedural_equipment") {
      if (!e.itemDefinitionCode || e.allowedRarities.length === 0) {
        throw new LootOrRewardInvalidError(
          `Equipment loot entry '${e.entryCode}' requires itemDefinitionCode and non-empty allowedRarities.`,
        );
      }
      if (e.minItemLevel < 1 || e.maxItemLevel < e.minItemLevel || e.maxItemLevel > 1000) {
        throw new LootOrRewardInvalidError(
          `Equipment loot entry '${e.entryCode}' has invalid itemLevel bounds.`,
        );
      }
    } else if (e.entryKind === "material_stack") {
      if (!e.itemDefinitionCode) {
        throw new LootOrRewardInvalidError(
          `Material loot entry '${e.entryCode}' requires itemDefinitionCode.`,
        );
      }
    } else if (e.entryKind === "currency_mint") {
      if (!e.currencyCode) {
        throw new LootOrRewardInvalidError(
          `Currency loot entry '${e.entryCode}' requires currencyCode.`,
        );
      }
    }
  }
}

export function selectDeterministicLootEntry(
  entries: ReadonlyArray<LootTableEntryDefinition>,
  rng: SplitMix64Rng,
): LootTableEntryDefinition {
  const sorted = entries
    .slice()
    .sort((a, b) => (a.entryCode < b.entryCode ? -1 : a.entryCode > b.entryCode ? 1 : 0));
  let totalWeight = 0;
  for (const e of sorted) {
    totalWeight += e.weight;
  }
  const ticket = rng.nextIntInclusive(1, totalWeight);
  let cumulative = 0;
  for (const e of sorted) {
    cumulative += e.weight;
    if (ticket <= cumulative) {
      return e;
    }
  }
  return sorted[sorted.length - 1]!;
}
