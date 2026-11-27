import {
  DEFAULT_ITEM_GENERATION_RULES_V1,
  INITIAL_AFFIXES_CATALOG,
  INITIAL_ITEM_DEFINITIONS_CATALOG,
  INITIAL_RARITIES_CATALOG,
} from "../catalog/initial-item-catalog.js";
import type {
  AffixDefinition,
  ItemDefinition,
  ItemGenerationRulesConfig,
  ItemRarityCode,
  RarityDefinition,
} from "../domain/item-types.js";
import { generateProceduralItemProperties } from "../domain/procedural-generator.js";

export interface ProceduralSimulationBatchSummary {
  readonly batchSeedPrefix: string;
  readonly sampleSize: number;
  readonly definitionCode: string;
  readonly itemLevel: number;
  readonly rarityCounts: Readonly<Record<ItemRarityCode, number>>;
  readonly affixCounts: Readonly<Record<string, number>>;
  readonly tierFrequencies: Readonly<Record<number, number>>;
  readonly qualityStatsBp: {
    readonly min: number;
    readonly max: number;
    readonly averageFloor: number;
    readonly quartileBuckets: {
      readonly q0_2499: number;
      readonly q2500_4999: number;
      readonly q5000_7499: number;
      readonly q7500_10000: number;
    };
  };
  readonly uniqueAffixCombinationCount: number;
  readonly maxPowerBudgetTotalObserved: number;
  readonly maxPowerBudgetSpentObserved: number;
  readonly budgetViolations: number;
  readonly duplicateAffixViolations: number;
  readonly exclusiveGroupViolations: number;
  readonly forbiddenPoolViolations: number;
  readonly deterministicChecksum: string;
}

const DEFAULT_RARITY_WEIGHTS: ReadonlyArray<{
  readonly rarityCode: ItemRarityCode;
  readonly weight: number;
}> = [
  { rarityCode: "common", weight: 4200 },
  { rarityCode: "uncommon", weight: 2800 },
  { rarityCode: "rare", weight: 1650 },
  { rarityCode: "epic", weight: 850 },
  { rarityCode: "legendary", weight: 350 },
  { rarityCode: "mythic", weight: 120 },
  { rarityCode: "relic", weight: 30 },
];

/**
 * Deterministic statistical harness for analyzing procedural item generation batches
 * (e.g., 1,000 / 10,000 / 100,000 samples) under fixed, reproducible seeds.
 *
 * NOTE: This harness verifies mathematical bounds, pool discipline, budget conservation,
 * and absence of duplicate/incompatible affix combinations. It does NOT claim final live-economy balance.
 */
export function runProceduralGenerationSimulation(params: {
  readonly sampleSize: number;
  readonly batchSeedPrefix: string;
  readonly definition?: ItemDefinition | undefined;
  readonly itemLevel?: number | undefined;
  readonly rules?: ItemGenerationRulesConfig | undefined;
  readonly rarities?: ReadonlyArray<RarityDefinition> | undefined;
  readonly affixes?: ReadonlyArray<AffixDefinition> | undefined;
}): ProceduralSimulationBatchSummary {
  const definition =
    params.definition ??
    INITIAL_ITEM_DEFINITIONS_CATALOG.find((d) => d.definitionCode === "ironfang_longsword")!;
  const itemLevel = params.itemLevel ?? 20;
  const rules = params.rules ?? DEFAULT_ITEM_GENERATION_RULES_V1;
  const rarities = params.rarities ?? INITIAL_RARITIES_CATALOG;
  const affixes = params.affixes ?? INITIAL_AFFIXES_CATALOG;

  const rarityByCode = new Map<ItemRarityCode, RarityDefinition>();
  for (const r of rarities) {
    rarityByCode.set(r.rarityCode, r);
  }
  const affixByCode = new Map<string, AffixDefinition>();
  for (const a of affixes) {
    affixByCode.set(a.affixCode, a);
  }

  const eligibleRarityWeights = DEFAULT_RARITY_WEIGHTS.filter((rw) =>
    definition.allowedRarities.includes(rw.rarityCode),
  );
  let rarityWeightSum = 0;
  for (const rw of eligibleRarityWeights) {
    rarityWeightSum += rw.weight;
  }

  const rarityCounts: Record<ItemRarityCode, number> = {
    common: 0,
    uncommon: 0,
    rare: 0,
    epic: 0,
    legendary: 0,
    mythic: 0,
    relic: 0,
  };
  const affixCounts: Record<string, number> = {};
  const tierFrequencies: Record<number, number> = {};
  const combinationSet = new Set<string>();
  const allowedPools = new Set(definition.allowedAffixPools);

  let minQuality = 10000;
  let maxQuality = 0;
  let qualitySum = 0n;
  let q0_2499 = 0;
  let q2500_4999 = 0;
  let q5000_7499 = 0;
  let q7500_10000 = 0;

  let maxPowerBudgetTotalObserved = 0;
  let maxPowerBudgetSpentObserved = 0;
  let budgetViolations = 0;
  let duplicateAffixViolations = 0;
  let exclusiveGroupViolations = 0;
  let forbiddenPoolViolations = 0;
  let rollingHash = 0xcbf29ce484222325n; // FNV-1a 64-bit offset basis

  for (let i = 0; i < params.sampleSize; i++) {
    // Deterministic ticket cycle across rarity weights
    const ticket = ((i * 7919 + 104729) % rarityWeightSum) + 1;
    let acc = 0;
    let chosenRarityCode: ItemRarityCode = eligibleRarityWeights[0]!.rarityCode;
    for (const rw of eligibleRarityWeights) {
      acc += rw.weight;
      if (ticket <= acc) {
        chosenRarityCode = rw.rarityCode;
        break;
      }
    }
    const rarity = rarityByCode.get(chosenRarityCode)!;
    rarityCounts[chosenRarityCode]++;

    const item = generateProceduralItemProperties({
      definition,
      rarity,
      rules,
      candidateAffixes: affixes,
      itemLevel,
      serverSeed: `${params.batchSeedPrefix}:${i}`,
      originReference: `sim-drop:${i}`,
    });

    if (item.qualityBp < minQuality) {
      minQuality = item.qualityBp;
    }
    if (item.qualityBp > maxQuality) {
      maxQuality = item.qualityBp;
    }
    qualitySum += BigInt(item.qualityBp);
    if (item.qualityBp < 2500) {
      q0_2499++;
    } else if (item.qualityBp < 5000) {
      q2500_4999++;
    } else if (item.qualityBp < 7500) {
      q5000_7499++;
    } else {
      q7500_10000++;
    }

    if (item.powerBudgetTotal > maxPowerBudgetTotalObserved) {
      maxPowerBudgetTotalObserved = item.powerBudgetTotal;
    }
    if (item.powerBudgetSpent > maxPowerBudgetSpentObserved) {
      maxPowerBudgetSpentObserved = item.powerBudgetSpent;
    }
    if (item.powerBudgetSpent > item.powerBudgetTotal) {
      budgetViolations++;
    }

    const seenCodes = new Set<string>();
    const seenGroups = new Set<string>();
    for (const rolled of item.affixes) {
      affixCounts[rolled.affixCode] = (affixCounts[rolled.affixCode] ?? 0) + 1;
      const defAffix = affixByCode.get(rolled.affixCode);
      if (defAffix) {
        tierFrequencies[defAffix.tier] = (tierFrequencies[defAffix.tier] ?? 0) + 1;
        if (!allowedPools.has(defAffix.poolCode)) {
          forbiddenPoolViolations++;
        }
      }
      if (seenCodes.has(rolled.affixCode)) {
        duplicateAffixViolations++;
      }
      if (seenGroups.has(rolled.exclusiveGroup)) {
        exclusiveGroupViolations++;
      }
      seenCodes.add(rolled.affixCode);
      seenGroups.add(rolled.exclusiveGroup);
    }

    const comboSignature = item.affixes
      .map((a) => a.affixCode)
      .slice()
      .sort()
      .join("+");
    combinationSet.add(`${item.rarityCode}|${comboSignature}`);

    // Fold deterministic outcome into 64-bit FNV-1a checksum
    const summaryStr = `${item.rarityCode}:${item.qualityBp}:${item.powerBudgetSpent}:${comboSignature}`;
    for (let c = 0; c < summaryStr.length; c++) {
      rollingHash ^= BigInt(summaryStr.charCodeAt(c));
      rollingHash = BigInt.asUintN(64, rollingHash * 0x100000001b3n);
    }
  }

  return {
    batchSeedPrefix: params.batchSeedPrefix,
    sampleSize: params.sampleSize,
    definitionCode: definition.definitionCode,
    itemLevel,
    rarityCounts,
    affixCounts,
    tierFrequencies,
    qualityStatsBp: {
      min: params.sampleSize > 0 ? minQuality : 0,
      max: maxQuality,
      averageFloor:
        params.sampleSize > 0 ? Number(qualitySum / BigInt(params.sampleSize)) : 0,
      quartileBuckets: {
        q0_2499,
        q2500_4999,
        q5000_7499,
        q7500_10000,
      },
    },
    uniqueAffixCombinationCount: combinationSet.size,
    maxPowerBudgetTotalObserved,
    maxPowerBudgetSpentObserved,
    budgetViolations,
    duplicateAffixViolations,
    exclusiveGroupViolations,
    forbiddenPoolViolations,
    deterministicChecksum: rollingHash.toString(16).padStart(16, "0"),
  };
}

/**
 * Executes the 3 standard development sample sizes (1,000 / 10,000 / 100,000) and verifies
 * exact bit-level reproducibility on the 1,000-item batch.
 */
export function runStandardSession04Simulations(): {
  readonly batch1k: ProceduralSimulationBatchSummary;
  readonly batch10k: ProceduralSimulationBatchSummary;
  readonly batch100k: ProceduralSimulationBatchSummary;
  readonly reproducible1kVerified: boolean;
} {
  const batch1k = runProceduralGenerationSimulation({
    sampleSize: 1000,
    batchSeedPrefix: "carbon-s04-sim-1k",
  });
  const batch1kReplay = runProceduralGenerationSimulation({
    sampleSize: 1000,
    batchSeedPrefix: "carbon-s04-sim-1k",
  });
  const batch10k = runProceduralGenerationSimulation({
    sampleSize: 10000,
    batchSeedPrefix: "carbon-s04-sim-10k",
  });
  const batch100k = runProceduralGenerationSimulation({
    sampleSize: 100000,
    batchSeedPrefix: "carbon-s04-sim-100k",
  });

  return {
    batch1k,
    batch10k,
    batch100k,
    reproducible1kVerified: batch1k.deterministicChecksum === batch1kReplay.deterministicChecksum,
  };
}
