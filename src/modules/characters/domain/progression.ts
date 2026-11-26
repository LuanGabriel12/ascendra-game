import { MAX_INT64 } from "../../../shared/contracts/int64-wire.js";
import type { ProgressionRulesConfig } from "./attributes-and-presets.js";
import { ExperienceGrantInvalidError } from "./errors.js";

export const AUTHORIZED_EXPERIENCE_SOURCE_TYPES = [
  "quest",
  "boss",
  "exploration",
  "world_event",
  "invasion_reward_policy",
  "discovery",
  "achievement",
  "dev_authorized",
] as const;

export type ExperienceSourceType = (typeof AUTHORIZED_EXPERIENCE_SOURCE_TYPES)[number];

/**
 * Cumulative total XP required to reach `targetLevel` (`>= 1`) under `quadratic_polynomial_v1`:
 *   RequiredTotalXP(L) = d * base + d * (d - 1) * linear + d^2 * quadratic, where d = L - 1.
 * Strictly 0 at Level 1 and monotonically increasing for all L > 1.
 */
export function requiredTotalExperienceForLevel(
  targetLevel: number,
  rules: ProgressionRulesConfig,
): bigint {
  if (!Number.isInteger(targetLevel) || targetLevel < rules.minLevel || targetLevel > rules.maxLevel) {
    throw new ExperienceGrantInvalidError(
      `targetLevel ${targetLevel} is outside configured bounds [${rules.minLevel}, ${rules.maxLevel}].`,
    );
  }
  if (targetLevel === 1) {
    return 0n;
  }

  const d = BigInt(targetLevel - 1);
  return (
    d * rules.xpCurveBase +
    d * (d - 1n) * rules.xpCurveLinear +
    d * d * rules.xpCurveQuadratic
  );
}

export function totalEarnedAttributePointsForLevel(
  level: number,
  rules: ProgressionRulesConfig,
): number {
  if (!Number.isInteger(level) || level < rules.minLevel || level > rules.maxLevel) {
    throw new ExperienceGrantInvalidError(
      `Level ${level} is outside configured bounds [${rules.minLevel}, ${rules.maxLevel}].`,
    );
  }
  return rules.creationAllocatablePoints + (level - 1) * rules.pointsPerLevel;
}

/**
 * Resolves the authoritative level in `[rules.minLevel, rules.maxLevel]` corresponding to
 * `experienceTotal` via exact BigInt binary search.
 */
export function resolveLevelForExperience(
  experienceTotal: bigint,
  rules: ProgressionRulesConfig,
): number {
  if (experienceTotal < 0n || experienceTotal > MAX_INT64) {
    throw new ExperienceGrantInvalidError(
      `experienceTotal ${experienceTotal.toString()} is outside valid int64 non-negative range.`,
    );
  }

  let low = rules.minLevel;
  let high = rules.maxLevel;
  let best = rules.minLevel;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const req = requiredTotalExperienceForLevel(mid, rules);
    if (req <= experienceTotal) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best;
}

export interface ExperienceAdvancementOutcome {
  readonly previousXp: bigint;
  readonly newXp: bigint;
  readonly previousLevel: number;
  readonly newLevel: number;
  readonly levelsGained: number;
  readonly attributePointsAwarded: number;
  readonly newEarnedAttributePoints: number;
  readonly newUnspentAttributePoints: number;
}

export function evaluateExperienceAdvancement(params: {
  readonly currentExperienceTotal: bigint;
  readonly currentLevel: number;
  readonly currentEarnedPoints: number;
  readonly currentAllocatedPoints: number;
  readonly currentUnspentPoints: number;
  readonly validatedGrantAmount: bigint;
  readonly rules: ProgressionRulesConfig;
}): ExperienceAdvancementOutcome {
  if (params.validatedGrantAmount <= 0n) {
    throw new ExperienceGrantInvalidError(
      `Experience grant amount must be > 0, got ${params.validatedGrantAmount.toString()}.`,
    );
  }

  if (params.validatedGrantAmount > MAX_INT64 - params.currentExperienceTotal) {
    throw new ExperienceGrantInvalidError(
      `Experience overflow: ${params.currentExperienceTotal.toString()} + ${params.validatedGrantAmount.toString()} exceeds int64 max (${MAX_INT64.toString()}).`,
    );
  }

  const newXp = params.currentExperienceTotal + params.validatedGrantAmount;
  const resolvedLevel = resolveLevelForExperience(newXp, params.rules);
  const newLevel = Math.max(params.currentLevel, resolvedLevel);
  const expectedEarnedForNewLevel = totalEarnedAttributePointsForLevel(newLevel, params.rules);
  const attributePointsAwarded = expectedEarnedForNewLevel - params.currentEarnedPoints;

  if (attributePointsAwarded < 0) {
    throw new ExperienceGrantInvalidError(
      `Inconsistent character point state during progression (currentEarned=${params.currentEarnedPoints}, expectedEarned=${expectedEarnedForNewLevel}).`,
    );
  }

  const newUnspent = params.currentUnspentPoints + attributePointsAwarded;
  if (params.currentAllocatedPoints + newUnspent !== expectedEarnedForNewLevel) {
    throw new ExperienceGrantInvalidError(
      "Attribute point conservation invariant failed during level advancement.",
    );
  }

  return {
    previousXp: params.currentExperienceTotal,
    newXp,
    previousLevel: params.currentLevel,
    newLevel,
    levelsGained: newLevel - params.currentLevel,
    attributePointsAwarded,
    newEarnedAttributePoints: expectedEarnedForNewLevel,
    newUnspentAttributePoints: newUnspent,
  };
}
