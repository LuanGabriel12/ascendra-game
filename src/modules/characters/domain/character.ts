import type { ValidatedCharacterAppearance } from "../../peoples/domain/appearance.js";
import type {
  AttributeBlock,
  CompetitiveNormalizationProfile,
} from "../../peoples/domain/character-snapshot-proposal.js";
import {
  applyAndValidateAttributeAllocation,
  createUniformAttributeBlock,
  createZeroAttributeBlock,
  sumAttributeBlock,
  type ProgressionRulesConfig,
} from "./attributes-and-presets.js";
import {
  AccountInactiveError,
  CharacterBuildConflictError,
  CharacterCompetitiveLockedError,
  CharacterInactiveError,
  CharacterOwnershipForbiddenError,
  GenesisTemporaryStatePersistenceForbiddenError,
} from "./errors.js";
import {
  evaluateExperienceAdvancement,
  type ExperienceAdvancementOutcome,
} from "./progression.js";

export type AccountStatus = "active" | "suspended" | "closed";
export type CharacterStatus = "active" | "locked_for_transfer" | "archived";
export type CompetitiveLockState = "none" | "in_ranked_series";

/**
 * Internal identity principal boundary used by application services.
 * NOTE: Does NOT substitute production network authentication; callers must never construct
 * `authenticated_account` directly from unverified client strings.
 */
export type AuthorityPrincipal =
  | {
      readonly kind: "authenticated_account";
      readonly accountId: string;
    }
  | {
      readonly kind: "internal_system_authority";
      readonly actorId: string;
    };

export interface RespecAuthorizationPolicy {
  assertCanRespec(character: Character, principal: AuthorityPrincipal): void;
}

export class DefaultRespecAuthorizationPolicy implements RespecAuthorizationPolicy {
  public assertCanRespec(character: Character, principal: AuthorityPrincipal): void {
    character.assertOwnedByOrSystem(principal);
    if (character.competitiveLockState === "in_ranked_series") {
      throw new CharacterCompetitiveLockedError(character.id);
    }
  }
}

export interface Account {
  readonly id: string;
  readonly externalSubject: string | null;
  readonly status: AccountStatus;
  readonly maxCharactersOverride: number | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function assertAccountActive(account: Account): void {
  if (account.status !== "active") {
    throw new AccountInactiveError(account.id, account.status);
  }
}

export function assertNotGenesisContext(
  operation: string,
  executionProfile: CompetitiveNormalizationProfile | undefined,
): void {
  if (executionProfile === "genesis_ranked_md3_scratch") {
    throw new GenesisTemporaryStatePersistenceForbiddenError(operation);
  }
}

export interface CharacterProps {
  readonly id: string;
  readonly accountId: string;
  readonly displayName: string;
  readonly canonicalName: string;
  readonly raceCode: string;
  readonly lineageCode: string;
  readonly cultureCode: string;
  readonly backgroundCode: string;
  readonly originRegionId: string;
  readonly hometownSettlementRef: string | null;
  readonly rulesVersion: number;
  readonly level: number;
  readonly experienceTotal: bigint;
  readonly earnedAttributePoints: number;
  readonly allocatedAttributePoints: number;
  readonly unspentAttributePoints: number;
  readonly baseAttributes: AttributeBlock;
  readonly allocatedAttributes: AttributeBlock;
  readonly appearance: ValidatedCharacterAppearance;
  readonly appearanceVersion: number;
  readonly buildVersion: number;
  readonly snapshotVersion: number;
  readonly status: CharacterStatus;
  readonly competitiveLockState: CompetitiveLockState;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class Character {
  public readonly id: string;
  public readonly accountId: string;
  public readonly displayName: string;
  public readonly canonicalName: string;
  public readonly raceCode: string;
  public readonly lineageCode: string;
  public readonly cultureCode: string;
  public readonly backgroundCode: string;
  public readonly originRegionId: string;
  public readonly hometownSettlementRef: string | null;
  public readonly rulesVersion: number;
  public readonly level: number;
  public readonly experienceTotal: bigint;
  public readonly earnedAttributePoints: number;
  public readonly allocatedAttributePoints: number;
  public readonly unspentAttributePoints: number;
  public readonly baseAttributes: AttributeBlock;
  public readonly allocatedAttributes: AttributeBlock;
  public readonly appearance: ValidatedCharacterAppearance;
  public readonly appearanceVersion: number;
  public readonly buildVersion: number;
  public readonly snapshotVersion: number;
  public readonly status: CharacterStatus;
  public readonly competitiveLockState: CompetitiveLockState;
  public readonly createdAt: Date;
  public readonly updatedAt: Date;

  constructor(props: CharacterProps) {
    this.id = props.id;
    this.accountId = props.accountId;
    this.displayName = props.displayName;
    this.canonicalName = props.canonicalName;
    this.raceCode = props.raceCode;
    this.lineageCode = props.lineageCode;
    this.cultureCode = props.cultureCode;
    this.backgroundCode = props.backgroundCode;
    this.originRegionId = props.originRegionId;
    this.hometownSettlementRef = props.hometownSettlementRef;
    this.rulesVersion = props.rulesVersion;
    this.level = props.level;
    this.experienceTotal = props.experienceTotal;
    this.earnedAttributePoints = props.earnedAttributePoints;
    this.allocatedAttributePoints = props.allocatedAttributePoints;
    this.unspentAttributePoints = props.unspentAttributePoints;
    this.baseAttributes = props.baseAttributes;
    this.allocatedAttributes = props.allocatedAttributes;
    this.appearance = props.appearance;
    this.appearanceVersion = props.appearanceVersion;
    this.buildVersion = props.buildVersion;
    this.snapshotVersion = props.snapshotVersion;
    this.status = props.status;
    this.competitiveLockState = props.competitiveLockState;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  public static createInitial(params: {
    readonly id: string;
    readonly accountId: string;
    readonly displayName: string;
    readonly canonicalName: string;
    readonly raceCode: string;
    readonly lineageCode: string;
    readonly cultureCode: string;
    readonly backgroundCode: string;
    readonly originRegionId: string;
    readonly hometownSettlementRef: string | null;
    readonly appearance: ValidatedCharacterAppearance;
    readonly initialAllocationDelta: AttributeBlock | null;
    readonly rules: ProgressionRulesConfig;
    readonly now: Date;
  }): Character {
    const baseAttributes = createUniformAttributeBlock(params.rules.basePointsPerAttribute);
    const zeroAlloc = createZeroAttributeBlock();
    const initialEarned = params.rules.creationAllocatablePoints;

    const allocOutcome = params.initialAllocationDelta
      ? applyAndValidateAttributeAllocation({
          baseAttributes,
          currentAllocated: zeroAlloc,
          deltaToAdd: params.initialAllocationDelta,
          currentUnspentPoints: initialEarned,
          earnedAttributePoints: initialEarned,
          rules: params.rules,
        })
      : {
          nextAllocated: zeroAlloc,
          nextAllocatedTotal: 0,
          nextUnspentPoints: initialEarned,
        };

    return new Character({
      id: params.id,
      accountId: params.accountId,
      displayName: params.displayName,
      canonicalName: params.canonicalName,
      raceCode: params.raceCode,
      lineageCode: params.lineageCode,
      cultureCode: params.cultureCode,
      backgroundCode: params.backgroundCode,
      originRegionId: params.originRegionId,
      hometownSettlementRef: params.hometownSettlementRef,
      rulesVersion: params.rules.rulesVersion,
      level: 1,
      experienceTotal: 0n,
      earnedAttributePoints: initialEarned,
      allocatedAttributePoints: allocOutcome.nextAllocatedTotal,
      unspentAttributePoints: allocOutcome.nextUnspentPoints,
      baseAttributes,
      allocatedAttributes: allocOutcome.nextAllocated,
      appearance: params.appearance,
      appearanceVersion: 1,
      buildVersion: 1,
      snapshotVersion: 1,
      status: "active",
      competitiveLockState: "none",
      createdAt: params.now,
      updatedAt: params.now,
    });
  }

  public assertOwnedByOrSystem(principal: AuthorityPrincipal): void {
    if (principal.kind === "internal_system_authority") {
      return;
    }
    if (principal.accountId.toLowerCase() !== this.accountId.toLowerCase()) {
      throw new CharacterOwnershipForbiddenError(this.id, principal.accountId);
    }
  }

  public assertActiveStatus(): void {
    if (this.status !== "active") {
      throw new CharacterInactiveError(this.id, this.status);
    }
  }

  public assertExpectedBuildVersion(expectedBuildVersion: number | undefined): void {
    if (expectedBuildVersion !== undefined && expectedBuildVersion !== this.buildVersion) {
      throw new CharacterBuildConflictError(this.id, expectedBuildVersion, this.buildVersion);
    }
  }

  public allocateAttributes(params: {
    readonly principal: AuthorityPrincipal;
    readonly deltaToAdd: AttributeBlock;
    readonly expectedBuildVersion: number;
    readonly rules: ProgressionRulesConfig;
    readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
    readonly now: Date;
  }): Character {
    assertNotGenesisContext("allocateAttributes", params.executionProfile);
    this.assertOwnedByOrSystem(params.principal);
    if (this.competitiveLockState === "in_ranked_series") {
      throw new CharacterCompetitiveLockedError(this.id);
    }
    this.assertExpectedBuildVersion(params.expectedBuildVersion);

    const outcome = applyAndValidateAttributeAllocation({
      baseAttributes: this.baseAttributes,
      currentAllocated: this.allocatedAttributes,
      deltaToAdd: params.deltaToAdd,
      currentUnspentPoints: this.unspentAttributePoints,
      earnedAttributePoints: this.earnedAttributePoints,
      rules: params.rules,
    });

    return new Character({
      ...this.toProps(),
      allocatedAttributes: outcome.nextAllocated,
      allocatedAttributePoints: outcome.nextAllocatedTotal,
      unspentAttributePoints: outcome.nextUnspentPoints,
      buildVersion: this.buildVersion + 1,
      snapshotVersion: this.snapshotVersion + 1,
      updatedAt: params.now,
    });
  }

  public respecAttributes(params: {
    readonly principal: AuthorityPrincipal;
    readonly expectedBuildVersion: number;
    readonly policy?: RespecAuthorizationPolicy | undefined;
    readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
    readonly now: Date;
  }): Character {
    assertNotGenesisContext("respecAttributes", params.executionProfile);
    const activePolicy = params.policy ?? new DefaultRespecAuthorizationPolicy();
    activePolicy.assertCanRespec(this, params.principal);
    this.assertExpectedBuildVersion(params.expectedBuildVersion);

    const zeroAlloc = createZeroAttributeBlock();
    const checkZero = sumAttributeBlock(zeroAlloc);

    return new Character({
      ...this.toProps(),
      allocatedAttributes: zeroAlloc,
      allocatedAttributePoints: checkZero,
      unspentAttributePoints: this.earnedAttributePoints,
      buildVersion: this.buildVersion + 1,
      snapshotVersion: this.snapshotVersion + 1,
      updatedAt: params.now,
    });
  }

  public applyExperienceGrant(params: {
    readonly validatedAmount: bigint;
    readonly rules: ProgressionRulesConfig;
    readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
    readonly now: Date;
  }): { readonly updated: Character; readonly advancement: ExperienceAdvancementOutcome } {
    assertNotGenesisContext("grantExperience", params.executionProfile);

    const advancement = evaluateExperienceAdvancement({
      currentExperienceTotal: this.experienceTotal,
      currentLevel: this.level,
      currentEarnedPoints: this.earnedAttributePoints,
      currentAllocatedPoints: this.allocatedAttributePoints,
      currentUnspentPoints: this.unspentAttributePoints,
      validatedGrantAmount: params.validatedAmount,
      rules: params.rules,
    });

    const updated = new Character({
      ...this.toProps(),
      level: advancement.newLevel,
      experienceTotal: advancement.newXp,
      earnedAttributePoints: advancement.newEarnedAttributePoints,
      unspentAttributePoints: advancement.newUnspentAttributePoints,
      snapshotVersion: this.snapshotVersion + 1,
      updatedAt: params.now,
    });

    return { updated, advancement };
  }

  public updateAppearance(params: {
    readonly principal: AuthorityPrincipal;
    readonly validatedAppearance: ValidatedCharacterAppearance;
    readonly expectedAppearanceVersion?: number | undefined;
    readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
    readonly now: Date;
  }): Character {
    assertNotGenesisContext("updateAppearance", params.executionProfile);
    this.assertOwnedByOrSystem(params.principal);
    if (
      params.expectedAppearanceVersion !== undefined &&
      params.expectedAppearanceVersion !== this.appearanceVersion
    ) {
      throw new CharacterBuildConflictError(
        this.id,
        params.expectedAppearanceVersion,
        this.appearanceVersion,
      );
    }

    return new Character({
      ...this.toProps(),
      appearance: params.validatedAppearance,
      appearanceVersion: this.appearanceVersion + 1,
      updatedAt: params.now,
    });
  }

  private toProps(): CharacterProps {
    return {
      id: this.id,
      accountId: this.accountId,
      displayName: this.displayName,
      canonicalName: this.canonicalName,
      raceCode: this.raceCode,
      lineageCode: this.lineageCode,
      cultureCode: this.cultureCode,
      backgroundCode: this.backgroundCode,
      originRegionId: this.originRegionId,
      hometownSettlementRef: this.hometownSettlementRef,
      rulesVersion: this.rulesVersion,
      level: this.level,
      experienceTotal: this.experienceTotal,
      earnedAttributePoints: this.earnedAttributePoints,
      allocatedAttributePoints: this.allocatedAttributePoints,
      unspentAttributePoints: this.unspentAttributePoints,
      baseAttributes: this.baseAttributes,
      allocatedAttributes: this.allocatedAttributes,
      appearance: this.appearance,
      appearanceVersion: this.appearanceVersion,
      buildVersion: this.buildVersion,
      snapshotVersion: this.snapshotVersion,
      status: this.status,
      competitiveLockState: this.competitiveLockState,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
