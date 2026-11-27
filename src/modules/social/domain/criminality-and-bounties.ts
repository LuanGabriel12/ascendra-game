import { CriminalBountyInvalidError, CriminalJurisdictionRuleError } from "./errors.js";

export const OFFENSE_CODES = [
  "UnlawfulAttack",
  "UnlawfulKill",
  "Theft",
  "Robbery",
  "Sabotage",
  "Treason",
  "ProtectedNPCViolation",
  "SettlementAssault",
  "Smuggling",
] as const;

export type OffenseCode = (typeof OFFENSE_CODES)[number];

export const COMBAT_LEGAL_CONTEXTS = [
  "unlawful_aggression",
  "consensual_duel",
  "authorized_arena",
  "recognized_faction_war",
  "self_defense",
] as const;

export type CombatLegalContext = (typeof COMBAT_LEGAL_CONTEXTS)[number];

export const CRIME_SEVERITIES = ["minor", "moderate", "major", "capital"] as const;
export type CrimeSeverity = (typeof CRIME_SEVERITIES)[number];

export const CRIMINAL_STATES = [
  "Clear",
  "Suspected",
  "Wanted",
  "Fugitive",
  "Captured",
  "ServingSentence",
  "Pardoned",
] as const;

export type CriminalState = (typeof CRIMINAL_STATES)[number];

export type SafeZoneAccessDecision =
  | "permitted"
  | "monitored"
  | "restricted_arrest_on_sight";

export type CriminalBountyStatus =
  | "Draft"
  | "Active"
  | "Reserved"
  | "Fulfilled"
  | "Expired"
  | "Cancelled";

export type CriminalBountyFundingStatus = "planned_unfunded" | "escrow_committed";

export interface CriminalJurisdictionDefinition {
  readonly jurisdictionId: string;
  readonly displayName: string;
  readonly regionId: string;
  readonly controllingFactionId: string | null;
  readonly settlementId: string | null;
  readonly lawProfile: "civic_protected" | "martial_frontier" | "syndicate_shadow" | "lawless";
  readonly consensualDuelExempt: boolean;
  readonly arenaCombatExempt: boolean;
  readonly recognizedWarExempt: boolean;
  readonly selfDefenseExempt: boolean;
  readonly unlawfulAttackMoralDelta: bigint;
  readonly unlawfulKillMoralDelta: bigint;
  readonly theftMoralDelta: bigint;
  readonly autoWarrantMinSeverity: CrimeSeverity | "never";
  readonly rulesVersion: number;
}

export interface CriminalRecord {
  readonly id: string;
  readonly offenderCharacterId: string;
  readonly victimCharacterId: string | null;
  readonly victimReference: string | null;
  readonly offenseCode: OffenseCode;
  readonly combatContext: CombatLegalContext;
  readonly jurisdictionId: string;
  readonly settlementId: string | null;
  readonly factionId: string | null;
  readonly regionId: string;
  readonly severity: CrimeSeverity;
  readonly legalStatus: "suspected" | "confirmed" | "pardoned" | "sentence_served";
  readonly moralDeltaApplied: bigint;
  readonly notorietyFameGranted: bigint;
  readonly sourceEventId: string;
  readonly evidenceReference: string;
  readonly rulesVersion: number;
  readonly recordedAt: Date;
  readonly updatedAt: Date;
}

export interface CharacterJurisdictionStanding {
  readonly characterId: string;
  readonly jurisdictionId: string;
  readonly criminalState: CriminalState;
  readonly safeZoneAccess: SafeZoneAccessDecision;
  readonly activeWarrantsCount: number;
  readonly version: number;
  readonly updatedAt: Date;
}

export interface CriminalWarrant {
  readonly id: string;
  readonly targetCharacterId: string;
  readonly issuingAuthorityId: string;
  readonly jurisdictionId: string;
  readonly sourceCrimeId: string;
  readonly status: "active" | "captured" | "pardoned" | "expired" | "revoked";
  readonly authorizedExceptions: ReadonlyArray<string>;
  readonly version: number;
  readonly issuedAt: Date;
  readonly resolvedAt: Date | null;
  readonly resolutionReference: string | null;
}

export interface CriminalBounty {
  readonly id: string;
  readonly targetCharacterId: string;
  readonly issuingAuthorityId: string;
  readonly jurisdictionId: string;
  readonly warrantId: string | null;
  readonly sourceCrimeId: string;
  readonly rewardAmount: bigint;
  readonly currencyCode: string;
  readonly fundingStatus: CriminalBountyFundingStatus;
  readonly fundingReference: string | null;
  readonly status: CriminalBountyStatus;
  readonly rulesVersion: number;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CriminalBountyClaim {
  readonly id: string;
  readonly bountyId: string;
  readonly claimantCharacterId: string;
  readonly claimantAccountId: string;
  readonly targetCharacterId: string;
  readonly targetAccountId: string;
  readonly resolutionKind: "confirmed_capture" | "authorized_defeat";
  readonly authorityEventId: string;
  readonly payoutCommitmentStatus: "pending_economy_settlement";
  readonly claimedAt: Date;
}

const SEVERITY_ORDINAL: Readonly<Record<CrimeSeverity, number>> = {
  minor: 1,
  moderate: 2,
  major: 3,
  capital: 4,
};

export interface IncidentLegalEvaluation {
  readonly constitutesCrime: boolean;
  readonly exemptionReason: string | null;
  readonly moralDelta: bigint;
  readonly isSevereMoralOffense: boolean;
  readonly shouldAutoIssueWarrant: boolean;
  readonly nextCriminalState: CriminalState;
  readonly nextSafeZoneAccess: SafeZoneAccessDecision;
}

/**
 * Evaluates an authoritative incident against a jurisdiction's data-driven legal profile.
 * Separates local illegality, moral consequence, and warrant issuance:
 * - Consensual duels, authorized arenas, recognized faction wars, and self-defense are exempted when configured.
 * - Lawless regions (`lawless`) do NOT create local civic crimes or warrants, even when an act has moral weight.
 * - Syndicate/smuggling rules do NOT treat every statutory violation as universally immoral across all cultures.
 * - `suspected` evidence never auto-issues a capture warrant or criminal reward eligibility.
 */
export function evaluateIncidentUnderJurisdiction(params: {
  readonly offenseCode: OffenseCode;
  readonly combatContext: CombatLegalContext;
  readonly confirmationLevel: "suspected" | "confirmed";
  readonly severity: CrimeSeverity;
  readonly currentState: CriminalState;
  readonly jurisdiction: CriminalJurisdictionDefinition;
  readonly explicitMoralDeltaOverride?: bigint | undefined;
}): IncidentLegalEvaluation {
  const { jurisdiction } = params;

  if (params.combatContext === "consensual_duel" && jurisdiction.consensualDuelExempt) {
    return {
      constitutesCrime: false,
      exemptionReason: "consensual_duel_exempt",
      moralDelta: 0n,
      isSevereMoralOffense: false,
      shouldAutoIssueWarrant: false,
      nextCriminalState: params.currentState,
      nextSafeZoneAccess: safeZoneForState(params.currentState),
    };
  }
  if (params.combatContext === "authorized_arena" && jurisdiction.arenaCombatExempt) {
    return {
      constitutesCrime: false,
      exemptionReason: "authorized_arena_exempt",
      moralDelta: 0n,
      isSevereMoralOffense: false,
      shouldAutoIssueWarrant: false,
      nextCriminalState: params.currentState,
      nextSafeZoneAccess: safeZoneForState(params.currentState),
    };
  }
  if (params.combatContext === "recognized_faction_war" && jurisdiction.recognizedWarExempt) {
    return {
      constitutesCrime: false,
      exemptionReason: "recognized_faction_war_exempt",
      moralDelta: 0n,
      isSevereMoralOffense: false,
      shouldAutoIssueWarrant: false,
      nextCriminalState: params.currentState,
      nextSafeZoneAccess: safeZoneForState(params.currentState),
    };
  }
  if (params.combatContext === "self_defense" && jurisdiction.selfDefenseExempt) {
    return {
      constitutesCrime: false,
      exemptionReason: "self_defense_exempt",
      moralDelta: 0n,
      isSevereMoralOffense: false,
      shouldAutoIssueWarrant: false,
      nextCriminalState: params.currentState,
      nextSafeZoneAccess: safeZoneForState(params.currentState),
    };
  }

  if (jurisdiction.lawProfile === "lawless") {
    // Lawless wilds have no civic court/warrants, though extreme acts may still carry moral delta if confirmed
    const wildMoral =
      params.confirmationLevel === "confirmed" && params.offenseCode === "UnlawfulKill"
        ? params.explicitMoralDeltaOverride ?? jurisdiction.unlawfulKillMoralDelta
        : 0n;
    return {
      constitutesCrime: false,
      exemptionReason: "lawless_jurisdiction_no_civic_statute",
      moralDelta: wildMoral,
      isSevereMoralOffense: wildMoral <= -200n,
      shouldAutoIssueWarrant: false,
      nextCriminalState: params.currentState,
      nextSafeZoneAccess: "permitted",
    };
  }

  // Suspected incidents do NOT apply moral penalty or bounty eligibility until confirmed
  if (params.confirmationLevel === "suspected") {
    const nextState: CriminalState =
      params.currentState === "Wanted" || params.currentState === "Fugitive"
        ? params.currentState
        : "Suspected";
    return {
      constitutesCrime: true,
      exemptionReason: null,
      moralDelta: 0n,
      isSevereMoralOffense: false,
      shouldAutoIssueWarrant: false,
      nextCriminalState: nextState,
      nextSafeZoneAccess: safeZoneForState(nextState),
    };
  }

  // Confirmed crime under active jurisdiction:
  // Note: Smuggling is a statutory tariff violation (0 moral bounty by default unless overridden!)
  let defaultMoralDelta = 0n;
  switch (params.offenseCode) {
    case "UnlawfulKill":
    case "SettlementAssault":
    case "ProtectedNPCViolation":
      defaultMoralDelta = jurisdiction.unlawfulKillMoralDelta;
      break;
    case "UnlawfulAttack":
    case "Robbery":
    case "Sabotage":
    case "Treason":
      defaultMoralDelta = jurisdiction.unlawfulAttackMoralDelta;
      break;
    case "Theft":
      defaultMoralDelta = jurisdiction.theftMoralDelta;
      break;
    case "Smuggling":
      defaultMoralDelta = 0n; // Statutory offense, not automatically universally immoral
      break;
  }

  const moralDelta = params.explicitMoralDeltaOverride ?? defaultMoralDelta;
  const isSevere =
    (params.severity === "major" || params.severity === "capital") && moralDelta < 0n;

  const autoWarrant =
    jurisdiction.autoWarrantMinSeverity !== "never" &&
    SEVERITY_ORDINAL[params.severity] >= SEVERITY_ORDINAL[jurisdiction.autoWarrantMinSeverity];

  const nextState: CriminalState = autoWarrant
    ? params.currentState === "Wanted" || params.currentState === "Fugitive"
      ? "Fugitive"
      : "Wanted"
    : params.currentState === "Clear" || params.currentState === "Pardoned"
      ? "Suspected"
      : params.currentState;

  return {
    constitutesCrime: true,
    exemptionReason: null,
    moralDelta,
    isSevereMoralOffense: isSevere,
    shouldAutoIssueWarrant: autoWarrant,
    nextCriminalState: nextState,
    nextSafeZoneAccess: safeZoneForState(nextState),
  };
}

export function safeZoneForState(state: CriminalState): SafeZoneAccessDecision {
  switch (state) {
    case "Wanted":
    case "Fugitive":
      return "restricted_arrest_on_sight";
    case "Suspected":
    case "Captured":
    case "ServingSentence":
      return "monitored";
    case "Clear":
    case "Pardoned":
      return "permitted";
  }
}

export function validateCriminalStateTransition(
  current: CriminalState,
  target: CriminalState,
): SafeZoneAccessDecision {
  const allowed: Readonly<Record<CriminalState, ReadonlyArray<CriminalState>>> = {
    Clear: ["Suspected", "Wanted"],
    Suspected: ["Clear", "Wanted", "Pardoned"],
    Wanted: ["Fugitive", "Captured", "Pardoned"],
    Fugitive: ["Captured", "Pardoned"],
    Captured: ["ServingSentence", "Pardoned"],
    ServingSentence: ["Clear", "Pardoned"],
    Pardoned: ["Suspected", "Wanted"],
  };

  if (current !== target && !allowed[current].includes(target)) {
    throw new CriminalJurisdictionRuleError(
      `Illegal criminal state transition from '${current}' to '${target}'.`,
    );
  }
  return safeZoneForState(target);
}

export function validateCriminalBountyCreation(params: {
  readonly rewardAmount: bigint;
  readonly fundingStatus: CriminalBountyFundingStatus;
  readonly fundingReference: string | null;
  readonly desiredStatus: "Draft" | "Active";
  readonly crimeLegalStatus: "suspected" | "confirmed" | "pardoned" | "sentence_served";
}): void {
  if (params.rewardAmount <= 0n) {
    throw new CriminalBountyInvalidError("Criminal bounty rewardAmount must be > 0.");
  }
  if (params.crimeLegalStatus !== "confirmed") {
    throw new CriminalBountyInvalidError(
      `Cannot create criminal bounty from crime in legal_status '${params.crimeLegalStatus}'; confirmed offense required.`,
    );
  }
  if (params.desiredStatus === "Active") {
    if (
      params.fundingStatus !== "escrow_committed" ||
      !params.fundingReference ||
      !params.fundingReference.trim()
    ) {
      throw new CriminalBountyInvalidError(
        "Active criminal bounty requires fundingStatus='escrow_committed' and a non-blank fundingReference.",
      );
    }
  }
}

export function assertCriminalBountyClaimEligible(params: {
  readonly bounty: CriminalBounty;
  readonly claimantCharacterId: string;
  readonly claimantAccountId: string;
  readonly targetCharacterId: string;
  readonly targetAccountId: string;
  readonly targetJurisdictionState: CriminalState;
}): void {
  if (params.bounty.status !== "Active" && params.bounty.status !== "Reserved") {
    throw new CriminalBountyInvalidError(
      `Criminal bounty '${params.bounty.id}' is '${params.bounty.status}' and cannot be claimed.`,
    );
  }
  if (
    params.bounty.fundingStatus !== "escrow_committed" ||
    !params.bounty.fundingReference
  ) {
    throw new CriminalBountyInvalidError(
      `Criminal bounty '${params.bounty.id}' lacks committed funding and cannot be claimed.`,
    );
  }
  if (params.claimantCharacterId.toLowerCase() === params.targetCharacterId.toLowerCase()) {
    throw new CriminalBountyInvalidError(
      "A character cannot claim a criminal bounty placed on themselves.",
    );
  }
  if (params.claimantAccountId.toLowerCase() === params.targetAccountId.toLowerCase()) {
    throw new CriminalBountyInvalidError(
      "Characters belonging to the same AccountID cannot claim criminal bounties on each other.",
    );
  }
  if (
    params.targetJurisdictionState !== "Wanted" &&
    params.targetJurisdictionState !== "Fugitive" &&
    params.targetJurisdictionState !== "Captured"
  ) {
    throw new CriminalBountyInvalidError(
      `Target character criminal state '${params.targetJurisdictionState}' is not eligible for bounty collection (must be Wanted, Fugitive, or Captured; Suspected is insufficient).`,
    );
  }
}
