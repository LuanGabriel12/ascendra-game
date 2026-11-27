import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_INT64, MIN_INT64 } from "../../src/shared/contracts/int64-wire.js";
import {
  DEFAULT_SOCIAL_RULES_V1,
  INITIAL_JURISDICTIONS_CATALOG,
  INITIAL_TITLE_DEFINITIONS_CATALOG,
} from "../../src/modules/social/catalog/initial-social-catalog.js";
import { evaluateIncidentUnderJurisdiction } from "../../src/modules/social/domain/criminality-and-bounties.js";
import {
  SocialNumericOverflowError,
  TitleConditionInvalidError,
} from "../../src/modules/social/domain/errors.js";
import {
  applyDiminishingReturnsBigInt,
  checkedAddSignedInt64,
  clampBigInt,
  computeSingleHopFactionPropagations,
  evaluateMoralBandWithHysteresis,
} from "../../src/modules/social/domain/social-standing.js";
import { evaluateContextualWorldRecognition } from "../../src/modules/social/domain/world-recognition.js";
import {
  evaluateTitleConditionAst,
  validateTitleConditionAst,
  type TitleConditionNode,
  type TitleEvaluationSnapshot,
} from "../../src/modules/titles/domain/title-contracts.js";

describe("CARBON Session 05 — Unit: Moral Bands, Hysteresis, Jurisdictions, Title AST & Contextual Recognition", () => {
  it("Scenarios 1..5: Signed MoralBounty arithmetic, 11-band transitions with hysteresis, severe-crime band cap, clamping, and int64 overflow protection", () => {
    // Overflow checks (#5)
    assert.throws(
      () => checkedAddSignedInt64(MAX_INT64, 1n, "moralBounty"),
      SocialNumericOverflowError,
    );
    assert.throws(
      () => checkedAddSignedInt64(MIN_INT64, -1n, "moralBounty"),
      SocialNumericOverflowError,
    );

    // Clamping (#4)
    assert.equal(
      clampBigInt(5000000n, DEFAULT_SOCIAL_RULES_V1.moralBountyMin, DEFAULT_SOCIAL_RULES_V1.moralBountyMax),
      DEFAULT_SOCIAL_RULES_V1.moralBountyMax,
    );
    assert.equal(
      clampBigInt(-5000000n, DEFAULT_SOCIAL_RULES_V1.moralBountyMin, DEFAULT_SOCIAL_RULES_V1.moralBountyMax),
      DEFAULT_SOCIAL_RULES_V1.moralBountyMin,
    );

    // Hysteresis (#3): neutral is [-24..49], well_regarded starts at 50, hysteresis = 15 => needs >= 49 + 15 = 64 to leave neutral!
    const staysNeutral = evaluateMoralBandWithHysteresis({
      nextMoralBounty: 55n,
      previousBand: "neutral",
      severeCrimeCount: 0,
      rules: DEFAULT_SOCIAL_RULES_V1,
    });
    assert.equal(staysNeutral, "neutral");

    const crossesIntoWellRegarded = evaluateMoralBandWithHysteresis({
      nextMoralBounty: 65n,
      previousBand: "neutral",
      severeCrimeCount: 0,
      rules: DEFAULT_SOCIAL_RULES_V1,
    });
    assert.equal(crossesIntoWellRegarded, "well_regarded");

    // Severe crime rehabilitation ceiling: even at +3000 MoralBounty, un-rehabilitated severe crime caps band at 'well_regarded'
    const cappedBySevereCrime = evaluateMoralBandWithHysteresis({
      nextMoralBounty: 3000n,
      previousBand: "well_regarded",
      severeCrimeCount: 1,
      rules: DEFAULT_SOCIAL_RULES_V1,
    });
    assert.equal(cappedBySevereCrime, "well_regarded");

    // Diminishing returns
    assert.equal(
      applyDiminishingReturnsBigInt({ rawDelta: 100n, priorOccurrencesInWindow: 0, stepBp: 2500 }),
      100n,
    );
    assert.equal(
      applyDiminishingReturnsBigInt({ rawDelta: 100n, priorOccurrencesInWindow: 2, stepBp: 2500 }),
      50n,
    );
    assert.equal(
      applyDiminishingReturnsBigInt({ rawDelta: 100n, priorOccurrencesInWindow: 5, stepBp: 2500 }),
      0n,
    );
  });

  it("Scenario 12: Enforces single-hop non-recursive faction reputation propagation without cycles", () => {
    const props = computeSingleHopFactionPropagations({
      sourceFactionId: "fac-a",
      directDelta: 400,
      directRelations: [
        {
          sourceFactionId: "fac-a",
          targetFactionId: "fac-b",
          relationState: "allied",
          propagationBp: 2500,
          rulesVersion: 1,
        },
        {
          sourceFactionId: "fac-b", // Neighbor-of-neighbor ignored (depth=1 only!)
          targetFactionId: "fac-c",
          relationState: "allied",
          propagationBp: 5000,
          rulesVersion: 1,
        },
        {
          sourceFactionId: "fac-a",
          targetFactionId: "fac-d",
          relationState: "hostile",
          propagationBp: -3000,
          rulesVersion: 1,
        },
      ],
    });
    assert.deepEqual(props, [
      { targetFactionId: "fac-b", propagatedDelta: 100, relationState: "allied" },
      { targetFactionId: "fac-d", propagatedDelta: -120, relationState: "hostile" },
    ]);
  });

  it("Scenarios 16 & 17: Evaluates data-driven jurisdictions separating consensual duel, arena, war, self-defense, statutory smuggling, and lawless wilds", () => {
    const civic = INITIAL_JURISDICTIONS_CATALOG.find(
      (j) => j.jurisdictionId === "jur-ashvale-civic",
    )!;
    const lawless = INITIAL_JURISDICTIONS_CATALOG.find(
      (j) => j.jurisdictionId === "jur-shadowfen-lawless",
    )!;

    // Consensual duel in civic city -> NOT a crime, 0 moral penalty
    const duel = evaluateIncidentUnderJurisdiction({
      offenseCode: "UnlawfulAttack",
      combatContext: "consensual_duel",
      confirmationLevel: "confirmed",
      severity: "moderate",
      currentState: "Clear",
      jurisdiction: civic,
    });
    assert.equal(duel.constitutesCrime, false);
    assert.equal(duel.moralDelta, 0n);

    // Suspected theft -> Suspected/monitored, NO auto warrant, 0 moral delta until confirmed
    const suspected = evaluateIncidentUnderJurisdiction({
      offenseCode: "Theft",
      combatContext: "unlawful_aggression",
      confirmationLevel: "suspected",
      severity: "major",
      currentState: "Clear",
      jurisdiction: civic,
    });
    assert.equal(suspected.constitutesCrime, true);
    assert.equal(suspected.shouldAutoIssueWarrant, false);
    assert.equal(suspected.nextCriminalState, "Suspected");
    assert.equal(suspected.moralDelta, 0n);

    // Statutory smuggling -> local crime, 0 automatic moral negativity
    const smuggling = evaluateIncidentUnderJurisdiction({
      offenseCode: "Smuggling",
      combatContext: "unlawful_aggression",
      confirmationLevel: "confirmed",
      severity: "moderate",
      currentState: "Clear",
      jurisdiction: civic,
    });
    assert.equal(smuggling.constitutesCrime, true);
    assert.equal(smuggling.moralDelta, 0n);
    assert.equal(smuggling.shouldAutoIssueWarrant, true);

    // Lawless region -> no local civic crime or warrant
    const wildKill = evaluateIncidentUnderJurisdiction({
      offenseCode: "UnlawfulKill",
      combatContext: "unlawful_aggression",
      confirmationLevel: "confirmed",
      severity: "major",
      currentState: "Clear",
      jurisdiction: lawless,
    });
    assert.equal(wildKill.constitutesCrime, false);
    assert.equal(wildKill.shouldAutoIssueWarrant, false);
    assert.ok(wildKill.moralDelta < 0n);
  });

  it("Section 24: Validates all 18 catalog Title ASTs, evaluates AND/OR predicates, and rejects excessive depth or node counts", () => {
    assert.equal(INITIAL_TITLE_DEFINITIONS_CATALOG.length, 18);
    for (const td of INITIAL_TITLE_DEFINITIONS_CATALOG) {
      assert.doesNotThrow(() => validateTitleConditionAst(td.requirements));
    }

    // Depth > 4 rejected
    const tooDeep: TitleConditionNode = {
      op: "AND",
      conditions: [
        {
          op: "OR",
          conditions: [
            {
              op: "AND",
              conditions: [
                {
                  op: "OR",
                  conditions: [{ op: "FameAtLeast", threshold: "100" }],
                },
              ],
            },
          ],
        },
      ],
    };
    assert.throws(() => validateTitleConditionAst(tooDeep), TitleConditionInvalidError);

    const sampleSnap: TitleEvaluationSnapshot = {
      moralBounty: 450n,
      globalFame: 900n,
      settlementDefensesCount: 3,
      settlementLiberationsCount: 0,
      validatedCrimesCount: 0,
      bountiesFulfilledCount: 1,
      reputationsByLogicalKey: new Map([["region:region-ashvale", 500]]),
      defensesBySettlementExternalId: new Map([["settlement-valewatch", 2]]),
      liberationsBySettlementExternalId: new Map(),
      historicalAchievementKeys: new Set(["SettlementDefended@settlement-valewatch"]),
    };

    const shieldDef = INITIAL_TITLE_DEFINITIONS_CATALOG.find(
      (t) => t.titleCode === "shield_of_the_realm",
    )!;
    assert.equal(evaluateTitleConditionAst(shieldDef.requirements, sampleSnap), true);

    const disabledDef = INITIAL_TITLE_DEFINITIONS_CATALOG.find(
      (t) => t.titleCode === "master_of_blades",
    )!;
    assert.equal(evaluateTitleConditionAst(disabledDef.requirements, sampleSnap), false);
  });

  it("Scenarios 34, 35, 36 & 37: Evaluates contextual NPC recognition across Local Hero, Legendary Hero, Non-Omniscient Unknown Criminal, Famous Outlaw, and Syndicate", () => {
    // Scenario A: Local Hero in defended city
    const localHero = evaluateContextualWorldRecognition({
      moralBounty: 250n,
      moralBand: "respected",
      globalFame: 200n,
      regionalFame: 200n,
      settlementReputation: 350,
      factionReputation: 300,
      jurisdictionCriminalState: "Clear",
      safeZoneAccess: "permitted",
      hasActiveWarrantInJurisdiction: false,
      equippedTitleCode: "protector_of_valewatch",
      equippedTitleCategory: "heroic",
      historicalRolesInContext: ["settlement_defender"],
      npcSocialRole: "civic_citizen",
    });
    assert.equal(localHero.disposition, "Respectful");
    assert.equal(localHero.isRecognizedByName, true);

    // Scenario B: Legendary Hero
    const legendaryHero = evaluateContextualWorldRecognition({
      moralBounty: 1800n,
      moralBand: "revered_hero",
      globalFame: 2200n,
      regionalFame: 800n,
      settlementReputation: 500,
      factionReputation: 500,
      jurisdictionCriminalState: "Clear",
      safeZoneAccess: "permitted",
      hasActiveWarrantInJurisdiction: false,
      equippedTitleCode: "living_legend",
      equippedTitleCategory: "historical",
      historicalRolesInContext: [],
      npcSocialRole: "civic_citizen",
    });
    assert.equal(legendaryHero.disposition, "Reverent");

    // Scenario C: Unknown petty criminal in distant city (low fame, no local warrant -> Unknown, NOT omniscient!)
    const unknownCriminal = evaluateContextualWorldRecognition({
      moralBounty: -120n,
      moralBand: "dishonored",
      globalFame: 20n,
      regionalFame: 0n,
      settlementReputation: 0,
      factionReputation: 0,
      jurisdictionCriminalState: "Clear",
      safeZoneAccess: "permitted",
      hasActiveWarrantInJurisdiction: false,
      equippedTitleCode: null,
      equippedTitleCategory: null,
      historicalRolesInContext: [],
      npcSocialRole: "merchant",
    });
    assert.equal(unknownCriminal.disposition, "Unknown");
    assert.equal(unknownCriminal.isRecognizedByName, false);

    // Scenario D: Famous dreaded criminal -> Guard is Hostile (arrest), Citizen is Fearful, Syndicate is Admiring!
    const dreadedGuard = evaluateContextualWorldRecognition({
      moralBounty: -1200n,
      moralBand: "public_menace",
      globalFame: 1500n,
      regionalFame: 900n,
      settlementReputation: -600,
      factionReputation: -600,
      jurisdictionCriminalState: "Wanted",
      safeZoneAccess: "restricted_arrest_on_sight",
      hasActiveWarrantInJurisdiction: true,
      equippedTitleCode: "terror_of_the_realms",
      equippedTitleCategory: "criminal",
      historicalRolesInContext: [],
      npcSocialRole: "town_guard",
      authoritativePowerStanding: 850,
    });
    assert.equal(dreadedGuard.disposition, "Hostile");
    assert.equal(dreadedGuard.safeZoneEnforcement, "deny_access_and_arrest");

    const dreadedCitizen = evaluateContextualWorldRecognition({
      moralBounty: -1200n,
      moralBand: "public_menace",
      globalFame: 1500n,
      regionalFame: 900n,
      settlementReputation: -400,
      factionReputation: -400,
      jurisdictionCriminalState: "Wanted",
      safeZoneAccess: "restricted_arrest_on_sight",
      hasActiveWarrantInJurisdiction: true,
      equippedTitleCode: "terror_of_the_realms",
      equippedTitleCategory: "criminal",
      historicalRolesInContext: [],
      npcSocialRole: "civic_citizen",
      authoritativePowerStanding: 850,
    });
    assert.equal(dreadedCitizen.disposition, "Fearful");

    const dreadedSyndicate = evaluateContextualWorldRecognition({
      moralBounty: -1200n,
      moralBand: "public_menace",
      globalFame: 1500n,
      regionalFame: 900n,
      settlementReputation: 300,
      factionReputation: 350,
      jurisdictionCriminalState: "Clear",
      safeZoneAccess: "permitted",
      hasActiveWarrantInJurisdiction: false,
      equippedTitleCode: "terror_of_the_realms",
      equippedTitleCategory: "criminal",
      historicalRolesInContext: [],
      npcSocialRole: "criminal_syndicate",
    });
    assert.equal(dreadedSyndicate.disposition, "Admiring");
  });
});
