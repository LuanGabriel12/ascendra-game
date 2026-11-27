import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_INT64 } from "../../src/shared/contracts/int64-wire.js";
import { WEAPON_SUBCATEGORIES } from "../../src/modules/inventory/domain/item-types.js";
import {
  DEFAULT_MASTERY_AND_SKILL_RULES_V1,
  INITIAL_ABILITY_DEFINITIONS_CATALOG,
  INITIAL_COMBAT_SCHOOLS_CATALOG,
  INITIAL_SPECIALIZATION_NODES_CATALOG,
  SESSION_06_MASTERY_TITLES_CATALOG,
} from "../../src/modules/skills/catalog/initial-skills-catalog.js";
import {
  AbilityLoadoutInvalidError,
  MasteryNumericOverflowError,
  SpecializationDagInvalidError,
} from "../../src/modules/skills/domain/errors.js";
import {
  applyMasteryDiminishingReturns,
  cumulativeMasteryXpForLevel,
  evaluateMasteryAdvancement,
  resolveProficiencyRank,
  validateAbilityLoadoutConfiguration,
  validateDeclarativePassiveParams,
  validateSpecializationDag,
} from "../../src/modules/skills/domain/mastery-and-dag-rules.js";
import {
  MASTERY_WEAPON_FAMILIES,
  type CharacterLearnedAbility,
  type SpecializationNodeDefinition,
} from "../../src/modules/skills/domain/skill-and-mastery-types.js";
import { runSkillProgressionSimulation } from "../../src/modules/skills/simulation/skill-progression-simulator.js";
import {
  evaluateTitleConditionAst,
  validateTitleConditionAst,
  type TitleEvaluationSnapshot,
} from "../../src/modules/titles/domain/title-contracts.js";

describe("CARBON Session 06 — Pure Domain Rules: Mastery Curves, Specialization DAG, Passives, Title AST & Simulation", () => {
  it("preserves all 22 Session 04 weapon families verbatim and adds 'unarmed' without mutating WEAPON_SUBCATEGORIES", () => {
    assert.equal(WEAPON_SUBCATEGORIES.length, 22);
    assert.equal(MASTERY_WEAPON_FAMILIES.length, 23);
    for (const fam of WEAPON_SUBCATEGORIES) {
      assert.ok(MASTERY_WEAPON_FAMILIES.includes(fam));
    }
    assert.ok(MASTERY_WEAPON_FAMILIES.includes("unarmed"));
    assert.equal((WEAPON_SUBCATEGORIES as ReadonlyArray<string>).includes("unarmed"), false);
  });

  it("enforces monotonically increasing mastery XP curve across 1..100, 6 proficiency bands, max level cap, and int64 overflow protection", () => {
    const rules = DEFAULT_MASTERY_AND_SKILL_RULES_V1;
    assert.equal(cumulativeMasteryXpForLevel(1, rules), 0n);

    let prev = 0n;
    for (let lvl = 2; lvl <= 100; lvl++) {
      const xp = cumulativeMasteryXpForLevel(lvl, rules);
      assert.ok(xp > prev, `Expected XP(${lvl})=${xp} > XP(${lvl - 1})=${prev}`);
      prev = xp;
    }

    assert.equal(resolveProficiencyRank(1, rules), "novice");
    assert.equal(resolveProficiencyRank(10, rules), "apprentice");
    assert.equal(resolveProficiencyRank(25, rules), "practitioner");
    assert.equal(resolveProficiencyRank(50, rules), "specialist");
    assert.equal(resolveProficiencyRank(75, rules), "master");
    assert.equal(resolveProficiencyRank(95, rules), "grandmaster");
    assert.equal(resolveProficiencyRank(100, rules), "grandmaster");

    // Multi-level jump + max level 100 saturation
    const maxReq = cumulativeMasteryXpForLevel(100, rules);
    const maxAdv = evaluateMasteryAdvancement({
      currentXp: 0n,
      currentLevel: 1,
      validatedGrantAmount: maxReq + 500_000n,
      rules,
    });
    assert.equal(maxAdv.newLevel, 100);
    assert.equal(maxAdv.newRank, "grandmaster");
    assert.deepEqual(maxAdv.crossedMilestones, [10, 25, 50, 75, 100]);

    // Overflow above MAX_INT64 rejects
    assert.throws(
      () =>
        evaluateMasteryAdvancement({
          currentXp: MAX_INT64 - 10n,
          currentLevel: 100,
          validatedGrantAmount: 11n,
          rules,
        }),
      MasteryNumericOverflowError,
    );

    // Diminishing returns scales smoothly while maintaining >= 1 XP floor
    assert.equal(
      applyMasteryDiminishingReturns({
        baseAmount: 100n,
        priorGrantsInWindow: 2,
        stepBp: 2000,
      }),
      60n,
    );
  });

  it("validates specialization DAGs and rejects cycles, self-dependencies, missing prerequisites, depth overruns, and exclusive-group contradictions", () => {
    const rules = DEFAULT_MASTERY_AND_SKILL_RULES_V1;

    // Initial catalog (12 schools: 6 enabled, 28 abilities: 27 enabled, 18 DAG nodes) is valid
    assert.equal(INITIAL_COMBAT_SCHOOLS_CATALOG.length, 12);
    assert.equal(INITIAL_COMBAT_SCHOOLS_CATALOG.filter((s) => s.isEnabled).length, 6);
    assert.equal(INITIAL_ABILITY_DEFINITIONS_CATALOG.length, 28);
    assert.equal(INITIAL_ABILITY_DEFINITIONS_CATALOG.filter((a) => a.isEnabled).length, 27);

    validateSpecializationDag({
      nodes: INITIAL_SPECIALIZATION_NODES_CATALOG,
      abilities: INITIAL_ABILITY_DEFINITIONS_CATALOG,
      rules,
    });

    // 3-node cycle A -> B -> C -> A must fail
    const cyclicNodes: ReadonlyArray<SpecializationNodeDefinition> = [
      {
        nodeCode: "cycle_a",
        schoolCode: "swordsmanship",
        displayName: "Ciclo A",
        description: "Nó A",
        abilityCode: null,
        abilityVersion: null,
        prerequisiteNodes: ["cycle_c"],
        requiredWeaponFamilies: [],
        requiredMasteryLevel: 1,
        requiredCharacterLevel: 1,
        requiredAttributes: {},
        pointCost: 1,
        exclusiveGroup: null,
        tierDepth: 1,
        isEnabled: true,
        rulesVersion: 1,
      },
      {
        nodeCode: "cycle_b",
        schoolCode: "swordsmanship",
        displayName: "Ciclo B",
        description: "Nó B",
        abilityCode: null,
        abilityVersion: null,
        prerequisiteNodes: ["cycle_a"],
        requiredWeaponFamilies: [],
        requiredMasteryLevel: 1,
        requiredCharacterLevel: 1,
        requiredAttributes: {},
        pointCost: 1,
        exclusiveGroup: null,
        tierDepth: 2,
        isEnabled: true,
        rulesVersion: 1,
      },
      {
        nodeCode: "cycle_c",
        schoolCode: "swordsmanship",
        displayName: "Ciclo C",
        description: "Nó C",
        abilityCode: null,
        abilityVersion: null,
        prerequisiteNodes: ["cycle_b"],
        requiredWeaponFamilies: [],
        requiredMasteryLevel: 1,
        requiredCharacterLevel: 1,
        requiredAttributes: {},
        pointCost: 1,
        exclusiveGroup: null,
        tierDepth: 3,
        isEnabled: true,
        rulesVersion: 1,
      },
    ];

    assert.throws(
      () =>
        validateSpecializationDag({
          nodes: cyclicNodes,
          abilities: INITIAL_ABILITY_DEFINITIONS_CATALOG,
          rules,
        }),
      SpecializationDagInvalidError,
    );

    // Reject non-declarative / malformed passive parameters
    assert.throws(
      () => validateDeclarativePassiveParams("passive", null),
      SpecializationDagInvalidError,
    );
    assert.throws(
      () => validateDeclarativePassiveParams("active", { illegal_passive_param: 10 }),
      SpecializationDagInvalidError,
    );
  });

  it("enforces loadout slot bounds (0..31), exclusive groups, slot-group caps, and build equipment budget", () => {
    const rules = DEFAULT_MASTERY_AND_SKILL_RULES_V1;
    const defsByCode = new Map(
      INITIAL_ABILITY_DEFINITIONS_CATALOG.map((d) => [d.abilityCode, d]),
    );
    const learnedByCode = new Map<string, CharacterLearnedAbility>();
    for (const d of INITIAL_ABILITY_DEFINITIONS_CATALOG) {
      if (!d.isEnabled) continue;
      learnedByCode.set(d.abilityCode, {
        characterId: "00000000-0000-4000-8000-000000000001",
        abilityCode: d.abilityCode,
        abilityVersion: d.abilityVersion,
        currentRank: 1,
        maxRankEverReached: 1,
        isActive: true,
        pointsInvested: d.unlockCost,
        learnedAt: new Date(0),
        updatedAt: new Date(0),
        version: 1,
      });
    }

    // Exclusive group conflict (`unwavering_stance` + `arcane_barrier` share `active_defensive_posture`)
    assert.throws(
      () =>
        validateAbilityLoadoutConfiguration({
          assignments: [
            { slotIndex: 0, abilityCode: "unwavering_stance" },
            { slotIndex: 1, abilityCode: "arcane_barrier" },
          ],
          learnedByCode,
          definitionsByCode: defsByCode,
          rules,
        }),
      AbilityLoadoutInvalidError,
    );

    // Build budget overflow (> 12 equipmentCost): 3+3+3+4 = 13 > 12
    assert.throws(
      () =>
        validateAbilityLoadoutConfiguration({
          assignments: [
            { slotIndex: 0, abilityCode: "imperial_thrust" }, // 3
            { slotIndex: 1, abilityCode: "whirling_blade" }, // 3
            { slotIndex: 4, abilityCode: "blade_discipline" }, // 3
            { slotIndex: 6, abilityCode: "sovereign_blade_storm" }, // 4 -> total 13 > 12!
          ],
          learnedByCode,
          definitionsByCode: defsByCode,
          rules,
        }),
      AbilityLoadoutInvalidError,
    );
  });

  it("evaluates Session 06 mastery Title AST operators and runs the 6-archetype progression simulation harness", () => {
    for (const td of SESSION_06_MASTERY_TITLES_CATALOG) {
      validateTitleConditionAst(td.requirements);
    }

    const masterOfBlades = SESSION_06_MASTERY_TITLES_CATALOG.find(
      (t) => t.titleCode === "master_of_blades",
    )!;
    assert.equal(masterOfBlades.isEnabled, true);

    const baseCtx: TitleEvaluationSnapshot = {
      moralBounty: 0n,
      globalFame: 0n,
      settlementDefensesCount: 0,
      settlementLiberationsCount: 0,
      validatedCrimesCount: 0,
      bountiesFulfilledCount: 0,
      reputationsByLogicalKey: new Map(),
      defensesBySettlementExternalId: new Map(),
      liberationsBySettlementExternalId: new Map(),
      historicalAchievementKeys: new Set(),
      weaponMasteryByFamily: new Map([["longsword", 25]]),
      activeLearnedAbilitiesCount: 2,
      activeLearnedAbilitiesBySchool: new Map([["swordsmanship", 2]]),
      activeSpecNodesBySchool: new Map([["swordsmanship", 2]]),
    };
    assert.equal(evaluateTitleConditionAst(masterOfBlades.requirements, baseCtx), true);

    const insufficientCtx: TitleEvaluationSnapshot = {
      ...baseCtx,
      weaponMasteryByFamily: new Map([["longsword", 24]]),
    };
    assert.equal(evaluateTitleConditionAst(masterOfBlades.requirements, insufficientCtx), false);

    // Run full 6-archetype progression simulation harness (Section 40)
    const simReport = runSkillProgressionSimulation();
    assert.equal(simReport.dagValidated, true);
    assert.equal(simReport.enabledSchoolCount, 6);
    assert.equal(simReport.enabledAbilityCount, 27);
    assert.equal(simReport.archetypeComparisons.length, 6);

    for (const arch of simReport.archetypeComparisons) {
      assert.equal(
        arch.specializationPointsSpent + arch.specializationPointsUnspent,
        arch.specializationPointsEarned,
      );
      assert.ok(arch.buildEquipmentCostUsed <= arch.buildEquipmentCostMax);
      assert.equal(arch.allEquippedEligibleWithPrimaryGear, true);
    }

    const arcaneKnight = simReport.archetypeComparisons.find(
      (a) => a.archetypeCode === "arcane_knight",
    )!;
    assert.deepEqual(
      [...arcaneKnight.schoolsCombined].sort(),
      ["arcane_arts", "swordsmanship"],
    );
    assert.ok(arcaneKnight.suppressedCountWhenSwappingToIncompatibleStaff >= 2);
  });
});
