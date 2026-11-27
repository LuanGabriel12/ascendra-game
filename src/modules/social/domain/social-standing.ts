import { MAX_INT64, MIN_INT64 } from "../../../shared/contracts/int64-wire.js";
import { SocialNumericOverflowError, SocialValidationError } from "./errors.js";

/**
 * Preserved Session 01 preparatory interfaces (kept backward-compatible for existing imports)
 */
export interface ReputationStanding {
  readonly playerId: string;
  readonly factionId: string;
  readonly value: number;
  readonly updatedAt: Date;
}

export interface BountyStanding {
  readonly playerId: string;
  readonly regionId: string;
  readonly signedAmount: bigint;
  readonly updatedAt: Date;
}

export interface FameStanding {
  readonly playerId: string;
  readonly renownPoints: bigint;
  readonly updatedAt: Date;
}

export interface CriminalRecordEntry {
  readonly id: string;
  readonly playerId: string;
  readonly settlementId: string | null;
  readonly factionId: string | null;
  readonly offenseCode: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
}

/**
 * Session 05 — CharacterID-centered Persistent Social Domains
 * Moral Bounty, Fame, Reputation, Criminality, Criminal Bounty, and Titles are strictly orthogonal.
 */
export const MORAL_BAND_CODES = [
  "legendary_enemy",
  "public_menace",
  "criminal",
  "dishonored",
  "suspected",
  "neutral",
  "well_regarded",
  "respected",
  "protector",
  "revered_hero",
  "heroic_legend",
] as const;

export type MoralBandCode = (typeof MORAL_BAND_CODES)[number];

export interface MoralBandDefinition {
  readonly bandCode: MoralBandCode;
  readonly displayName: string;
  readonly ordinal: number; // -5..+5 (0 = neutral)
  readonly minInclusive: bigint;
  readonly maxInclusive: bigint;
}

export interface SocialRulesConfig {
  readonly rulesVersion: number;
  readonly code: string;
  readonly moralBountyMin: bigint;
  readonly moralBountyMax: bigint;
  readonly moralBandHysteresis: bigint;
  readonly severeCrimeCapBand: MoralBandCode;
  readonly fameMax: bigint;
  readonly reputationMin: number;
  readonly reputationMax: number;
  readonly moralBands: ReadonlyArray<MoralBandDefinition>;
  readonly antiAbuseCooldownSeconds: number;
  readonly antiAbuseWindowSeconds: number;
  readonly antiAbuseMaxEventsPerWindow: number;
  readonly diminishingReturnsStepBp: number;
}

export type ReputationScopeType = "faction" | "settlement" | "region";

export type FactionRelationState =
  | "allied"
  | "friendly"
  | "neutral"
  | "unfriendly"
  | "hostile";

export interface FactionRelationRule {
  readonly sourceFactionId: string;
  readonly targetFactionId: string;
  readonly relationState: FactionRelationState;
  readonly propagationBp: number; // -10000..+10000
  readonly rulesVersion: number;
}

export interface CharacterSocialStandingAggregate {
  readonly characterId: string;
  readonly moralBounty: bigint;
  readonly moralBand: MoralBandCode;
  readonly severeCrimeCount: number;
  readonly globalFame: bigint;
  readonly settlementDefensesCount: number;
  readonly settlementLiberationsCount: number;
  readonly validatedCrimesCount: number;
  readonly bountiesFulfilledCount: number;
  readonly equippedTitleCode: string | null;
  readonly rulesVersion: number;
  readonly socialVersion: number;
  readonly updatedAt: Date;
}

export interface CharacterRegionalStanding {
  readonly characterId: string;
  readonly regionId: string;
  readonly regionalMoralBounty: bigint;
  readonly regionalFame: bigint;
  readonly version: number;
  readonly updatedAt: Date;
}

export interface CharacterScopedReputation {
  readonly id: string;
  readonly characterId: string;
  readonly scopeType: ReputationScopeType;
  readonly scopeId: string;
  readonly factionId: string | null;
  readonly settlementId: string | null;
  readonly regionId: string | null;
  readonly standingValue: number;
  readonly rulesVersion: number;
  readonly version: number;
  readonly updatedAt: Date;
}

export interface SocialRegionDefinition {
  readonly regionId: string;
  readonly displayName: string;
  readonly lawfulnessProfile: "guarded_civil" | "frontier_mixed" | "lawless_wilds";
  readonly description: string;
  readonly isEnabled: boolean;
}

export interface ExternalIdentityLink {
  readonly id: string;
  readonly sourceNamespace: string;
  readonly externalSubjectId: string;
  readonly characterId: string;
  readonly linkStatus: "active" | "revoked";
  readonly linkedByActor: string;
  readonly revocationReason: string | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Performs overflow-checked 64-bit signed addition BEFORE applying domain rule clamping.
 * Throws `SocialNumericOverflowError` if `current + delta` would overflow signed `int64`.
 */
export function checkedAddSignedInt64(current: bigint, delta: bigint, label: string): bigint {
  if (current < MIN_INT64 || current > MAX_INT64 || delta < MIN_INT64 || delta > MAX_INT64) {
    throw new SocialNumericOverflowError(
      `${label} operand outside signed int64 bounds [${MIN_INT64.toString()}, ${MAX_INT64.toString()}].`,
    );
  }
  const sum = current + delta;
  if (sum < MIN_INT64 || sum > MAX_INT64) {
    throw new SocialNumericOverflowError(
      `${label} addition (${current.toString()} + ${delta.toString()}) overflows signed int64.`,
    );
  }
  return sum;
}

export function clampBigInt(value: bigint, min: bigint, max: bigint): bigint {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

export function clampInt32(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw new SocialNumericOverflowError(`Reputation value '${String(value)}' must be a safe integer.`);
  }
  return Math.max(min, Math.min(max, value));
}

/**
 * Evaluates the character's Moral Recognition Band with configurable hysteresis and
 * severe-crime ceiling protection:
 * 1. Finds raw band containing `nextMoralBounty`.
 * 2. Hysteresis: if `previousBand` is adjacent to `rawBand`, requires `nextMoralBounty` to penetrate
 *    into `rawBand` by at least `hysteresis` points before switching bands (preventing boundary flapping).
 * 3. Severe Crime Ceiling: if `severeCrimeCount > 0`, positive common actions cannot elevate the character
 *    above `rules.severeCrimeCapBand` (e.g. `well_regarded`) without formal rehabilitation!
 */
export function evaluateMoralBandWithHysteresis(params: {
  readonly nextMoralBounty: bigint;
  readonly previousBand: MoralBandCode;
  readonly severeCrimeCount: number;
  readonly rules: SocialRulesConfig;
}): MoralBandCode {
  const ordered = params.rules.moralBands
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal);

  let rawDef = ordered.find(
    (b) => params.nextMoralBounty >= b.minInclusive && params.nextMoralBounty <= b.maxInclusive,
  );
  if (!rawDef) {
    rawDef =
      params.nextMoralBounty < ordered[0]!.minInclusive
        ? ordered[0]!
        : ordered[ordered.length - 1]!;
  }

  const prevDef = ordered.find((b) => b.bandCode === params.previousBand);
  let selectedDef = rawDef;

  if (prevDef && prevDef.bandCode !== rawDef.bandCode && params.rules.moralBandHysteresis > 0n) {
    const h = params.rules.moralBandHysteresis;
    if (rawDef.ordinal === prevDef.ordinal + 1) {
      // Moving upward across boundary `prevDef.maxInclusive` -> require `prevDef.maxInclusive + h`
      if (params.nextMoralBounty < prevDef.maxInclusive + h) {
        selectedDef = prevDef;
      }
    } else if (rawDef.ordinal === prevDef.ordinal - 1) {
      // Moving downward across boundary `prevDef.minInclusive` -> require `prevDef.minInclusive - h`
      if (params.nextMoralBounty > prevDef.minInclusive - h) {
        selectedDef = prevDef;
      }
    }
  }

  if (params.severeCrimeCount > 0) {
    const capDef = ordered.find((b) => b.bandCode === params.rules.severeCrimeCapBand);
    if (capDef && selectedDef.ordinal > capDef.ordinal) {
      selectedDef = capDef;
    }
  }

  return selectedDef.bandCode;
}

/**
 * Applies diminishing returns for repeated actions within the same anti-abuse time window.
 * `priorOccurrencesInWindow = 0` => 100% of `rawDelta`.
 * Each prior occurrence reduces magnitude by `diminishingReturnsStepBp` basis points down to 0.
 */
export function applyDiminishingReturnsBigInt(params: {
  readonly rawDelta: bigint;
  readonly priorOccurrencesInWindow: number;
  readonly stepBp: number;
}): bigint {
  if (params.priorOccurrencesInWindow <= 0 || params.stepBp <= 0) {
    return params.rawDelta;
  }
  const reductionBp = Math.min(10000, params.priorOccurrencesInWindow * params.stepBp);
  const multiplierBp = BigInt(10000 - reductionBp);
  return (params.rawDelta * multiplierBp) / 10000n;
}

/**
 * Computes strictly single-hop (`depth = 1`) reputation propagations to directly related factions.
 * Never recurses onto neighbors-of-neighbors, making cycles and runaway multiplication impossible.
 */
export function computeSingleHopFactionPropagations(params: {
  readonly sourceFactionId: string;
  readonly directDelta: number;
  readonly directRelations: ReadonlyArray<FactionRelationRule>;
}): ReadonlyArray<{
  readonly targetFactionId: string;
  readonly propagatedDelta: number;
  readonly relationState: FactionRelationState;
}> {
  if (!Number.isInteger(params.directDelta) || params.directDelta === 0) {
    return [];
  }
  const seenTargets = new Set<string>();
  const results: Array<{
    readonly targetFactionId: string;
    readonly propagatedDelta: number;
    readonly relationState: FactionRelationState;
  }> = [];

  for (const rel of params.directRelations) {
    if (rel.sourceFactionId !== params.sourceFactionId) {
      continue;
    }
    if (rel.targetFactionId === params.sourceFactionId) {
      throw new SocialValidationError("Self-referential faction relation is forbidden.");
    }
    if (seenTargets.has(rel.targetFactionId)) {
      continue;
    }
    seenTargets.add(rel.targetFactionId);

    const scaled = Math.trunc((params.directDelta * rel.propagationBp) / 10000);
    if (scaled !== 0) {
      results.push({
        targetFactionId: rel.targetFactionId,
        propagatedDelta: scaled,
        relationState: rel.relationState,
      });
    }
  }

  return results;
}
