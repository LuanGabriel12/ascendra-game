import { MAX_INT64, MIN_INT64 } from "../../../shared/contracts/int64-wire.js";
import { TitleConditionInvalidError } from "../../social/domain/errors.js";
import type { ReputationScopeType } from "../../social/domain/social-standing.js";

export const TITLE_CATEGORIES = [
  "achievement",
  "reputation",
  "historical",
  "exclusive",
  "criminal",
  "heroic",
  "professional",
  "competitive",
  "exploration",
  "political",
] as const;

export type TitleCategory = (typeof TITLE_CATEGORIES)[number];

export const TITLE_RARITIES = [
  "common",
  "uncommon",
  "rare",
  "epic",
  "legendary",
  "mythic",
] as const;

export type TitleRarity = (typeof TITLE_RARITIES)[number];

export type TitlePersistenceMode =
  | "PermanentAchievement"
  | "ConditionalStanding"
  | "ExclusiveOffice";

export type TitleExclusivityScope =
  | "none"
  | "global"
  | "regional"
  | "seasonal"
  | "event_first";

export type TitleVisibility = "public" | "contextual" | "hidden_until_unlocked";

/**
 * Preserved Session 01 interfaces (backward-compatible)
 */
export interface TitleDefinition {
  readonly id: string;
  readonly code: string;
  readonly displayName: string;
  readonly category: TitleCategory;
  readonly rarity: TitleRarity;
  readonly requirements: Readonly<Record<string, unknown>>;
}

export interface PlayerTitleUnlock {
  readonly id: string;
  readonly playerId: string;
  readonly titleId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly unlockedAt: Date;
}

export interface TitleHistoryEntry {
  readonly id: string;
  readonly playerId: string;
  readonly titleId: string;
  readonly action:
    | "unlocked"
    | "activated"
    | "deactivated_conditional"
    | "revoked"
    | "expired"
    | "equipped"
    | "unequipped";
  readonly correlationId: string;
  readonly recordedAt: Date;
}

/**
 * Declarative, safe, bounded Title Condition AST (ZERO eval / arbitrary JS).
 */
export type TitleConditionNode =
  | { readonly op: "AND"; readonly conditions: ReadonlyArray<TitleConditionNode> }
  | { readonly op: "OR"; readonly conditions: ReadonlyArray<TitleConditionNode> }
  | { readonly op: "MoralBountyAtLeast"; readonly threshold: string }
  | { readonly op: "MoralBountyAtMost"; readonly threshold: string }
  | { readonly op: "FameAtLeast"; readonly threshold: string }
  | {
      readonly op: "ReputationAtLeast";
      readonly scopeType: ReputationScopeType;
      readonly scopeKey: string;
      readonly threshold: number;
    }
  | {
      readonly op: "ReputationAtMost";
      readonly scopeType: ReputationScopeType;
      readonly scopeKey: string;
      readonly threshold: number;
    }
  | {
      readonly op: "SuccessfulSettlementDefenses";
      readonly minCount: number;
      readonly settlementExternalId?: string | undefined;
    }
  | {
      readonly op: "SuccessfulSettlementLiberations";
      readonly minCount: number;
      readonly settlementExternalId?: string | undefined;
    }
  | { readonly op: "ValidatedCrimeCount"; readonly minCount: number }
  | { readonly op: "ValidatedCrimeCountAtMost"; readonly maxCount: number }
  | { readonly op: "CriminalBountiesFulfilled"; readonly minCount: number }
  | {
      readonly op: "HistoricalAchievementRecorded";
      readonly eventType: string;
      readonly settlementExternalId?: string | undefined;
    }
  | { readonly op: "PlannedSystemUnavailable"; readonly systemCode: string };

export interface VersionedTitleDefinition {
  readonly titleCode: string;
  readonly titleVersion: number;
  readonly displayName: string;
  readonly description: string;
  readonly category: TitleCategory;
  readonly rarity: TitleRarity;
  readonly persistenceMode: TitlePersistenceMode;
  readonly exclusivityScope: TitleExclusivityScope;
  readonly visibility: TitleVisibility;
  readonly stackabilityPolicy: "single_unlock";
  readonly revocable: boolean;
  readonly isEnabled: boolean;
  readonly originSummary: string;
  readonly requirements: TitleConditionNode;
  readonly rulesVersion: number;
}

export interface CharacterTitleState {
  readonly id: string;
  readonly characterId: string;
  readonly titleCode: string;
  readonly state: "active" | "inactive_conditional" | "revoked" | "expired";
  readonly exclusivityKey: string | null;
  readonly originEventId: string;
  readonly unlockedAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

export interface TitleEvaluationSnapshot {
  readonly moralBounty: bigint;
  readonly globalFame: bigint;
  readonly settlementDefensesCount: number;
  readonly settlementLiberationsCount: number;
  readonly validatedCrimesCount: number;
  readonly bountiesFulfilledCount: number;
  /** Map keyed by `${scopeType}:${scopeCodeOrExternalIdOrRegionId}` -> standingValue */
  readonly reputationsByLogicalKey: ReadonlyMap<string, number>;
  readonly defensesBySettlementExternalId: ReadonlyMap<string, number>;
  readonly liberationsBySettlementExternalId: ReadonlyMap<string, number>;
  /** Set of `${eventType}` and `${eventType}@${settlementExternalId}` */
  readonly historicalAchievementKeys: ReadonlySet<string>;
}

export const MAX_TITLE_AST_DEPTH = 4;
export const MAX_TITLE_AST_NODES = 16;

const SIGNED_INT64_DECIMAL_RE = /^(0|-?[1-9][0-9]{0,18})$/;

function parseSignedInt64Threshold(raw: string, label: string): bigint {
  if (typeof raw !== "string" || !SIGNED_INT64_DECIMAL_RE.test(raw)) {
    throw new TitleConditionInvalidError(`Invalid int64 threshold '${String(raw)}' in ${label}.`);
  }
  const v = BigInt(raw);
  if (v < MIN_INT64 || v > MAX_INT64) {
    throw new TitleConditionInvalidError(`Threshold '${raw}' overflows int64 in ${label}.`);
  }
  return v;
}

/**
 * Validates depth, node count, operator allowlist, and numeric bounds of a declarative title AST.
 */
export function validateTitleConditionAst(root: TitleConditionNode): void {
  let nodeCount = 0;

  function visit(node: TitleConditionNode, depth: number): void {
    if (depth > MAX_TITLE_AST_DEPTH) {
      throw new TitleConditionInvalidError(
        `Title condition AST exceeds maximum depth of ${MAX_TITLE_AST_DEPTH}.`,
      );
    }
    nodeCount++;
    if (nodeCount > MAX_TITLE_AST_NODES) {
      throw new TitleConditionInvalidError(
        `Title condition AST exceeds maximum node count of ${MAX_TITLE_AST_NODES}.`,
      );
    }
    if (!node || typeof node !== "object" || typeof node.op !== "string") {
      throw new TitleConditionInvalidError("Malformed title condition AST node.");
    }

    switch (node.op) {
      case "AND":
      case "OR":
        if (!Array.isArray(node.conditions) || node.conditions.length === 0) {
          throw new TitleConditionInvalidError(`${node.op} condition requires a non-empty array.`);
        }
        for (const child of node.conditions) {
          visit(child, depth + 1);
        }
        return;

      case "MoralBountyAtLeast":
      case "MoralBountyAtMost":
        parseSignedInt64Threshold(node.threshold, node.op);
        return;

      case "FameAtLeast": {
        const fame = parseSignedInt64Threshold(node.threshold, node.op);
        if (fame < 0n) {
          throw new TitleConditionInvalidError("FameAtLeast threshold must be >= 0.");
        }
        return;
      }

      case "ReputationAtLeast":
      case "ReputationAtMost":
        if (
          node.scopeType !== "faction" &&
          node.scopeType !== "settlement" &&
          node.scopeType !== "region"
        ) {
          throw new TitleConditionInvalidError(`Invalid reputation scopeType '${String(node.scopeType)}'.`);
        }
        if (!node.scopeKey || !node.scopeKey.trim()) {
          throw new TitleConditionInvalidError(`${node.op} requires non-blank scopeKey.`);
        }
        if (!Number.isInteger(node.threshold)) {
          throw new TitleConditionInvalidError(`${node.op} threshold must be an integer.`);
        }
        return;

      case "SuccessfulSettlementDefenses":
      case "SuccessfulSettlementLiberations":
      case "ValidatedCrimeCount":
      case "CriminalBountiesFulfilled":
        if (!Number.isInteger(node.minCount) || node.minCount < 1) {
          throw new TitleConditionInvalidError(`${node.op} minCount must be an integer >= 1.`);
        }
        return;

      case "ValidatedCrimeCountAtMost":
        if (!Number.isInteger(node.maxCount) || node.maxCount < 0) {
          throw new TitleConditionInvalidError("ValidatedCrimeCountAtMost maxCount must be >= 0.");
        }
        return;

      case "HistoricalAchievementRecorded":
        if (!node.eventType || !node.eventType.trim()) {
          throw new TitleConditionInvalidError("HistoricalAchievementRecorded requires eventType.");
        }
        return;

      case "PlannedSystemUnavailable":
        if (!node.systemCode || !node.systemCode.trim()) {
          throw new TitleConditionInvalidError("PlannedSystemUnavailable requires systemCode.");
        }
        return;

      default: {
        const exhaustive: never = node;
        throw new TitleConditionInvalidError(
          `Unsupported title condition operator '${String((exhaustive as { op?: unknown }).op)}'.`,
        );
      }
    }
  }

  visit(root, 1);
}

/**
 * Predictable, O(1)-lookup evaluator for declarative title conditions.
 */
export function evaluateTitleConditionAst(
  node: TitleConditionNode,
  ctx: TitleEvaluationSnapshot,
): boolean {
  validateTitleConditionAst(node);

  function evalNode(curr: TitleConditionNode): boolean {
    switch (curr.op) {
      case "AND":
        return curr.conditions.every(evalNode);
      case "OR":
        return curr.conditions.some(evalNode);
      case "MoralBountyAtLeast":
        return ctx.moralBounty >= BigInt(curr.threshold);
      case "MoralBountyAtMost":
        return ctx.moralBounty <= BigInt(curr.threshold);
      case "FameAtLeast":
        return ctx.globalFame >= BigInt(curr.threshold);
      case "ReputationAtLeast": {
        const val = ctx.reputationsByLogicalKey.get(`${curr.scopeType}:${curr.scopeKey}`) ?? 0;
        return val >= curr.threshold;
      }
      case "ReputationAtMost": {
        const val = ctx.reputationsByLogicalKey.get(`${curr.scopeType}:${curr.scopeKey}`) ?? 0;
        return val <= curr.threshold;
      }
      case "SuccessfulSettlementDefenses": {
        const count = curr.settlementExternalId
          ? (ctx.defensesBySettlementExternalId.get(curr.settlementExternalId) ?? 0)
          : ctx.settlementDefensesCount;
        return count >= curr.minCount;
      }
      case "SuccessfulSettlementLiberations": {
        const count = curr.settlementExternalId
          ? (ctx.liberationsBySettlementExternalId.get(curr.settlementExternalId) ?? 0)
          : ctx.settlementLiberationsCount;
        return count >= curr.minCount;
      }
      case "ValidatedCrimeCount":
        return ctx.validatedCrimesCount >= curr.minCount;
      case "ValidatedCrimeCountAtMost":
        return ctx.validatedCrimesCount <= curr.maxCount;
      case "CriminalBountiesFulfilled":
        return ctx.bountiesFulfilledCount >= curr.minCount;
      case "HistoricalAchievementRecorded":
        if (curr.settlementExternalId) {
          return ctx.historicalAchievementKeys.has(
            `${curr.eventType}@${curr.settlementExternalId}`,
          );
        }
        return ctx.historicalAchievementKeys.has(curr.eventType);
      case "PlannedSystemUnavailable":
        return false;
    }
  }

  return evalNode(node);
}
