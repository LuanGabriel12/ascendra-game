import type { CriminalState, SafeZoneAccessDecision } from "./criminality-and-bounties.js";
import type { MoralBandCode } from "./social-standing.js";
import type { TitleCategory } from "../../titles/domain/title-contracts.js";

export const NPC_SOCIAL_ROLES = [
  "town_guard",
  "civic_citizen",
  "merchant",
  "criminal_syndicate",
  "mercenary_broker",
  "scholar",
] as const;

export type NpcSocialRole = (typeof NPC_SOCIAL_ROLES)[number];

export const RECOGNITION_DISPOSITIONS = [
  "Unknown",
  "Neutral",
  "Friendly",
  "Respectful",
  "Admiring",
  "Reverent",
  "Suspicious",
  "Fearful",
  "Contemptuous",
  "Hostile",
] as const;

export type ContextualRecognitionDisposition = (typeof RECOGNITION_DISPOSITIONS)[number];

/**
 * Inputs for data-driven contextual NPC recognition.
 *
 * ARCHITECTURAL ANTI-BIAS INVARIANT:
 * Character biological `raceCode` / `lineageCode` is intentionally NOT an input to this function.
 * Morality, lawfulness, and recognition depend strictly on persistent deeds, reputations,
 * criminal warrants, fame, and titles — never on species.
 */
export interface WorldRecognitionEvaluationInput {
  readonly moralBounty: bigint;
  readonly moralBand: MoralBandCode;
  readonly globalFame: bigint;
  readonly regionalFame: bigint;
  readonly settlementReputation: number; // 0 when no relationship exists (neutral default)
  readonly factionReputation: number; // 0 when no relationship exists (neutral default)
  readonly jurisdictionCriminalState: CriminalState;
  readonly safeZoneAccess: SafeZoneAccessDecision;
  readonly hasActiveWarrantInJurisdiction: boolean;
  readonly equippedTitleCode: string | null;
  readonly equippedTitleCategory: TitleCategory | null;
  readonly historicalRolesInContext: ReadonlyArray<string>;
  readonly npcSocialRole: NpcSocialRole;
  readonly recognitionFameThreshold?: bigint | undefined;
  /** Optional authoritative combat assessment from NEON; NEVER auto-derived from Fame or Bounty! */
  readonly authoritativePowerStanding?: number | null | undefined;
}

export interface WorldRecognitionEvaluationResult {
  readonly disposition: ContextualRecognitionDisposition;
  readonly isRecognizedByName: boolean;
  readonly safeZoneEnforcement: "none" | "watch_closely" | "deny_access_and_arrest";
  readonly reasonCodes: ReadonlyArray<string>;
}

/**
 * Pure, deterministic contextual world recognition classifier for NEON NPC consumption.
 * Implements Scenarios A..E (Local Hero, Legendary Hero, Unknown Criminal, Legendary Criminal, Mercenary)
 * without simulating NPC movement, combat AI, or omniscient knowledge.
 */
export function evaluateContextualWorldRecognition(
  input: WorldRecognitionEvaluationInput,
): WorldRecognitionEvaluationResult {
  const fameThreshold = input.recognitionFameThreshold ?? 150n;
  const effectiveNotoriety =
    input.regionalFame * 2n + input.globalFame;
  const hasLocalHistory = input.historicalRolesInContext.length > 0;
  const hasStrongLocalStanding =
    Math.abs(input.settlementReputation) >= 150 || Math.abs(input.factionReputation) >= 150;

  const isRecognizedByName =
    effectiveNotoriety >= fameThreshold ||
    hasLocalHistory ||
    hasStrongLocalStanding ||
    input.hasActiveWarrantInJurisdiction;

  const safeZoneEnforcement: "none" | "watch_closely" | "deny_access_and_arrest" =
    input.safeZoneAccess === "restricted_arrest_on_sight"
      ? "deny_access_and_arrest"
      : input.safeZoneAccess === "monitored"
        ? "watch_closely"
        : "none";

  const reasons: string[] = [];

  // 1. Criminal Syndicate NPCs evaluate characters through underworld lens!
  if (input.npcSocialRole === "criminal_syndicate") {
    if (input.factionReputation <= -300) {
      reasons.push("hostile_to_syndicate");
      return {
        disposition: "Hostile",
        isRecognizedByName: true,
        safeZoneEnforcement: "none",
        reasonCodes: reasons,
      };
    }
    if (input.moralBounty <= -500n && isRecognizedByName) {
      reasons.push("infamous_outlaw_renowned_in_underworld");
      if (input.factionReputation >= 200) {
        reasons.push("trusted_syndicate_associate");
        return {
          disposition: "Admiring",
          isRecognizedByName: true,
          safeZoneEnforcement: "none",
          reasonCodes: reasons,
        };
      }
      return {
        disposition: "Respectful",
        isRecognizedByName: true,
        safeZoneEnforcement: "none",
        reasonCodes: reasons,
      };
    }
    if (!isRecognizedByName) {
      return {
        disposition: "Unknown",
        isRecognizedByName: false,
        safeZoneEnforcement: "none",
        reasonCodes: ["unrecognized_by_syndicate"],
      };
    }
    return {
      disposition: input.factionReputation >= 150 ? "Friendly" : "Neutral",
      isRecognizedByName,
      safeZoneEnforcement: "none",
      reasonCodes: ["syndicate_pragmatic_standing"],
    };
  }

  // 2. Active Warrant / Wanted / Fugitive in this specific Jurisdiction
  if (
    input.hasActiveWarrantInJurisdiction ||
    input.jurisdictionCriminalState === "Wanted" ||
    input.jurisdictionCriminalState === "Fugitive"
  ) {
    reasons.push("active_jurisdictional_warrant");
    if (input.npcSocialRole === "town_guard") {
      return {
        disposition: "Hostile",
        isRecognizedByName: true,
        safeZoneEnforcement: "deny_access_and_arrest",
        reasonCodes: reasons,
      };
    }
    if (input.npcSocialRole === "mercenary_broker") {
      reasons.push("broker_neutral_contract_stance");
      return {
        disposition: "Suspicious",
        isRecognizedByName: true,
        safeZoneEnforcement,
        reasonCodes: reasons,
      };
    }
    // Civilian / Merchant / Scholar facing a notorious outlaw:
    // High combat power or extreme infamy inspires Fear; lower power inspires Contempt/Hostility!
    const highThreat =
      (input.authoritativePowerStanding !== undefined &&
        input.authoritativePowerStanding !== null &&
        input.authoritativePowerStanding >= 700) ||
      input.moralBounty <= -800n;
    return {
      disposition: highThreat ? "Fearful" : "Contemptuous",
      isRecognizedByName: true,
      safeZoneEnforcement,
      reasonCodes: [...reasons, highThreat ? "intimidating_threat" : "wanted_offender"],
    };
  }

  // 3. Severe Faction Hostility in Context
  if (input.factionReputation <= -500 || input.settlementReputation <= -500) {
    reasons.push("hostile_local_reputation");
    return {
      disposition: "Hostile",
      isRecognizedByName: true,
      safeZoneEnforcement,
      reasonCodes: reasons,
    };
  }

  // 4. Scenario C — Unrecognized Stranger (including Unknown Criminal from distant region with low fame!)
  // NPCs are NOT omniscient: if the character has no local warrant, low fame, and no local reputation,
  // distant crimes do NOT magically trigger omniscient hostility!
  if (!isRecognizedByName) {
    if (input.jurisdictionCriminalState === "Suspected") {
      return {
        disposition: "Suspicious",
        isRecognizedByName: false,
        safeZoneEnforcement,
        reasonCodes: ["local_suspicion_watch"],
      };
    }
    return {
      disposition: "Unknown",
      isRecognizedByName: false,
      safeZoneEnforcement,
      reasonCodes: ["below_recognition_threshold"],
    };
  }

  // 5. Recognized Character WITHOUT Local Warrant, but with Notorious Global Criminal History (Scenario D abroad)
  if (input.moralBounty <= -500n) {
    reasons.push("known_global_infamy");
    if (input.npcSocialRole === "mercenary_broker") {
      return {
        disposition: input.factionReputation >= 100 ? "Friendly" : "Neutral",
        isRecognizedByName: true,
        safeZoneEnforcement,
        reasonCodes: [...reasons, "mercenary_pragmatism"],
      };
    }
    if (input.npcSocialRole === "town_guard") {
      return {
        disposition: "Suspicious",
        isRecognizedByName: true,
        safeZoneEnforcement,
        reasonCodes: [...reasons, "guard_watching_known_outlaw"],
      };
    }
    const inspiresFear =
      (input.authoritativePowerStanding ?? 0) >= 700 || input.globalFame >= 1000n;
    return {
      disposition: inspiresFear ? "Fearful" : "Contemptuous",
      isRecognizedByName: true,
      safeZoneEnforcement,
      reasonCodes: [...reasons, inspiresFear ? "dreaded_reputation" : "disliked_infamy"],
    };
  }

  // 6. Scenario B — Legendary Hero (High global fame + exalted moral standing)
  if (input.globalFame >= 1500n && input.moralBounty >= 1000n) {
    reasons.push("legendary_heroic_renown");
    return {
      disposition: "Reverent",
      isRecognizedByName: true,
      safeZoneEnforcement,
      reasonCodes: reasons,
    };
  }

  // 7. Scenario A — Local Hero / Settlement Defender
  if (
    hasLocalHistory ||
    (input.settlementReputation >= 300 && input.moralBounty >= 100n)
  ) {
    reasons.push("recognized_local_protector");
    return {
      disposition: input.settlementReputation >= 600 || input.moralBounty >= 500n ? "Admiring" : "Respectful",
      isRecognizedByName: true,
      safeZoneEnforcement,
      reasonCodes: reasons,
    };
  }

  // 8. Scenario E — Mercenary / Pragmatic Veteran (High fame, mixed/neutral morality, varying faction ties)
  if (input.factionReputation <= -200 || input.settlementReputation <= -200) {
    return {
      disposition: "Suspicious",
      isRecognizedByName: true,
      safeZoneEnforcement,
      reasonCodes: ["unfavorable_faction_standing"],
    };
  }
  if (input.factionReputation >= 400 || input.settlementReputation >= 400) {
    return {
      disposition: "Respectful",
      isRecognizedByName: true,
      safeZoneEnforcement,
      reasonCodes: ["strong_allied_standing"],
    };
  }
  if (input.factionReputation >= 150 || input.settlementReputation >= 150 || input.moralBounty >= 150n) {
    return {
      disposition: "Friendly",
      isRecognizedByName: true,
      safeZoneEnforcement,
      reasonCodes: ["favorable_standing"],
    };
  }

  if (input.equippedTitleCategory === "criminal") {
    return {
      disposition: "Suspicious",
      isRecognizedByName: true,
      safeZoneEnforcement,
      reasonCodes: ["displaying_criminal_title"],
    };
  }

  return {
    disposition: "Neutral",
    isRecognizedByName: true,
    safeZoneEnforcement,
    reasonCodes: ["recognized_neutral_standing"],
  };
}
