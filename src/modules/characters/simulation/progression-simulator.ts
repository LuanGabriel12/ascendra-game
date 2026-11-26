import { PRIMARY_ATTRIBUTE_KEYS } from "../../peoples/domain/character-snapshot-proposal.js";
import {
  BUILD_ARCHETYPE_PRESETS,
  DEFAULT_DEV_PROGRESSION_RULES_V1,
  computeDevPreviewSecondaryResources,
  computeEffectiveAttributesBeforeEquipment,
  createUniformAttributeBlock,
  sumAttributeBlock,
  type ProgressionRulesConfig,
} from "../domain/attributes-and-presets.js";
import {
  requiredTotalExperienceForLevel,
  totalEarnedAttributePointsForLevel,
} from "../domain/progression.js";

export interface LevelCurveRow {
  readonly level: number;
  readonly cumulativeXpRequired: string;
  readonly marginalXpFromPrevious: string;
  readonly earnedAllocatablePoints: number;
  readonly totalAttributeBudgetWithBase: number;
  readonly exceedsSingleBuildCapCapacity: boolean;
}

export interface ArchetypeComparisonRow {
  readonly presetCode: string;
  readonly displayName: string;
  readonly allocatedTotal: number;
  readonly effectiveTotalAtLevel1: number;
  readonly effectiveAttributesAtLevel1: Record<string, number>;
  readonly devPreviewResources: {
    readonly maxHealth: number;
    readonly maxMana: number;
    readonly maxStamina: number;
    readonly maxGuard: number;
    readonly maxFocus: number;
  };
}

export interface RateImpactSummary {
  readonly pointsPerLevel: number;
  readonly earnedAtMaxLevel: number;
  readonly maxAllocatableCapacityUnderCap: number;
  readonly capSaturationLevel: number | null;
}

export interface ProgressionSimulationReport {
  readonly rulesVersion: number;
  readonly rulesCode: string;
  readonly maxLevel: number;
  readonly maxAllocatableCapacityUnderCap: number;
  readonly capSaturationLevel: number | null;
  readonly milestoneLevels: ReadonlyArray<LevelCurveRow>;
  readonly fullCurve: ReadonlyArray<LevelCurveRow>;
  readonly archetypesAtCreation: ReadonlyArray<ArchetypeComparisonRow>;
  readonly pointsPerLevelRateComparison: ReadonlyArray<RateImpactSummary>;
}

/**
 * Development simulation harness for inspecting XP curves, attribute budgets,
 * cap saturation thresholds, and emergent build presets across levels 1..maxLevel.
 * Output is purely JSON-serializable for offline playtest analysis.
 */
export function runProgressionSimulationHarness(
  rules: ProgressionRulesConfig = DEFAULT_DEV_PROGRESSION_RULES_V1,
  candidateRates: ReadonlyArray<number> = [1, 2, 3, 4],
): ProgressionSimulationReport {
  const attrCount = PRIMARY_ATTRIBUTE_KEYS.length;
  const maxAllocPerAttr = rules.maxEffectiveBeforeEquipment - rules.basePointsPerAttribute;
  const maxAllocatableCapacityUnderCap = attrCount * maxAllocPerAttr;
  const totalBasePoints = attrCount * rules.basePointsPerAttribute;

  const fullCurve: LevelCurveRow[] = [];
  let prevXp = 0n;
  let capSaturationLevel: number | null = null;

  for (let lvl = rules.minLevel; lvl <= rules.maxLevel; lvl++) {
    const reqXp = requiredTotalExperienceForLevel(lvl, rules);
    const marginal = lvl === 1 ? 0n : reqXp - prevXp;
    const earned = totalEarnedAttributePointsForLevel(lvl, rules);
    const exceedsCap = earned > maxAllocatableCapacityUnderCap;
    if (exceedsCap && capSaturationLevel === null) {
      capSaturationLevel = lvl;
    }

    fullCurve.push({
      level: lvl,
      cumulativeXpRequired: reqXp.toString(),
      marginalXpFromPrevious: marginal.toString(),
      earnedAllocatablePoints: earned,
      totalAttributeBudgetWithBase: totalBasePoints + earned,
      exceedsSingleBuildCapCapacity: exceedsCap,
    });
    prevXp = reqXp;
  }

  const milestoneSet = new Set([1, 2, 5, 10, 20, 30, 50, 75, rules.maxLevel]);
  const milestoneLevels = fullCurve.filter((row) => milestoneSet.has(row.level));

  const baseBlock = createUniformAttributeBlock(rules.basePointsPerAttribute);
  const archetypesAtCreation: ArchetypeComparisonRow[] = Object.values(
    BUILD_ARCHETYPE_PRESETS,
  ).map((preset) => {
    const effective = computeEffectiveAttributesBeforeEquipment(
      baseBlock,
      preset.allocatedAttributes,
    );
    const preview = computeDevPreviewSecondaryResources(effective);
    return {
      presetCode: preset.presetCode,
      displayName: preset.displayName,
      allocatedTotal: sumAttributeBlock(preset.allocatedAttributes),
      effectiveTotalAtLevel1: sumAttributeBlock(effective),
      effectiveAttributesAtLevel1: { ...effective },
      devPreviewResources: {
        maxHealth: preview.maxHealth,
        maxMana: preview.maxMana,
        maxStamina: preview.maxStamina,
        maxGuard: preview.maxGuard,
        maxFocus: preview.maxFocus,
      },
    };
  });

  const pointsPerLevelRateComparison: RateImpactSummary[] = candidateRates.map((rate) => {
    const simulatedRules: ProgressionRulesConfig = { ...rules, pointsPerLevel: rate };
    let firstOverflowLevel: number | null = null;
    for (let lvl = simulatedRules.minLevel; lvl <= simulatedRules.maxLevel; lvl++) {
      const earned = totalEarnedAttributePointsForLevel(lvl, simulatedRules);
      if (earned > maxAllocatableCapacityUnderCap) {
        firstOverflowLevel = lvl;
        break;
      }
    }
    return {
      pointsPerLevel: rate,
      earnedAtMaxLevel: totalEarnedAttributePointsForLevel(
        simulatedRules.maxLevel,
        simulatedRules,
      ),
      maxAllocatableCapacityUnderCap,
      capSaturationLevel: firstOverflowLevel,
    };
  });

  return {
    rulesVersion: rules.rulesVersion,
    rulesCode: rules.code,
    maxLevel: rules.maxLevel,
    maxAllocatableCapacityUnderCap,
    capSaturationLevel,
    milestoneLevels,
    fullCurve,
    archetypesAtCreation,
    pointsPerLevelRateComparison,
  };
}
