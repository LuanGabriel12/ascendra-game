import { BUILD_ARCHETYPE_PRESETS } from "../../characters/domain/attributes-and-presets.js";
import { Character } from "../../characters/domain/character.js";
import { DEFAULT_DEV_PROGRESSION_RULES_V1 } from "../../characters/domain/attributes-and-presets.js";
import { INITIAL_ITEM_DEFINITIONS_CATALOG } from "../../inventory/catalog/initial-item-catalog.js";
import type { CombatEquipmentSlot, ItemInstance } from "../../inventory/domain/item-types.js";
import { createZeroAttributeBlock } from "../../characters/domain/attributes-and-presets.js";
import {
  DEFAULT_MASTERY_AND_SKILL_RULES_V1,
  INITIAL_ABILITY_DEFINITIONS_CATALOG,
  INITIAL_COMBAT_SCHOOLS_CATALOG,
  INITIAL_SPECIALIZATION_NODES_CATALOG,
} from "../catalog/initial-skills-catalog.js";
import {
  assertCanLearnAbility,
  assertCanUnlockSpecializationNode,
  cumulativeMasteryXpForLevel,
  evaluateMasteryAdvancement,
  evaluateRuntimeAbilityUsageEligibility,
  resolveProficiencyRank,
  validateAbilityLoadoutConfiguration,
  validateSpecializationDag,
  type EquippedHandItemContext,
} from "../domain/mastery-and-dag-rules.js";
import type {
  AbilityDefinition,
  CharacterLearnedAbility,
  CharacterWeaponMastery,
  MasteryAndSkillRulesConfig,
  MasteryWeaponFamilyCode,
  ProficiencyRank,
  SpecializationNodeDefinition,
} from "../domain/skill-and-mastery-types.js";

export interface MasteryCurveMilestoneSample {
  readonly level: number;
  readonly cumulativeXp: bigint;
  readonly deltaFromPreviousSample: bigint;
  readonly proficiencyRank: ProficiencyRank;
}

export interface ArchetypeBuildSimulationResult {
  readonly archetypeCode:
    | "pure_swordsman"
    | "guardian"
    | "monk"
    | "arcanist"
    | "arcane_knight"
    | "hybrid_assassin";
  readonly displayName: string;
  readonly schoolsCombined: ReadonlyArray<string>;
  readonly simulatedLevel: number;
  readonly specializationPointsEarned: number;
  readonly specializationPointsSpent: number;
  readonly specializationPointsUnspent: number;
  readonly unlockedNodes: ReadonlyArray<string>;
  readonly learnedAbilities: ReadonlyArray<{ readonly abilityCode: string; readonly rank: number }>;
  readonly equippedSlots: ReadonlyArray<{ readonly slotIndex: number; readonly abilityCode: string }>;
  readonly buildEquipmentCostUsed: number;
  readonly buildEquipmentCostMax: number;
  readonly allEquippedEligibleWithPrimaryGear: boolean;
  readonly suppressedCountWhenSwappingToIncompatibleStaff: number;
}

export interface SkillProgressionSimulationReport {
  readonly rulesVersion: number;
  readonly dagValidated: boolean;
  readonly enabledSchoolCount: number;
  readonly enabledAbilityCount: number;
  readonly masteryCurveSamples: ReadonlyArray<MasteryCurveMilestoneSample>;
  readonly archetypeComparisons: ReadonlyArray<ArchetypeBuildSimulationResult>;
}

function makeMockEquippedWeapon(
  slotCode: CombatEquipmentSlot,
  definitionCode: string,
  ownerId: string,
): EquippedHandItemContext {
  const def = INITIAL_ITEM_DEFINITIONS_CATALOG.find((d) => d.definitionCode === definitionCode)!;
  const zero = createZeroAttributeBlock();
  const instance: ItemInstance = {
    id: "00000000-0000-4000-8000-000000000099",
    definitionCode: def.definitionCode,
    definitionVersion: def.definitionVersion,
    ownerAccountId: "00000000-0000-4000-8000-000000000001",
    ownerCharacterId: ownerId,
    locationState: "equipped_active",
    containerId: null,
    containerSlotIndex: null,
    itemLevel: def.baseItemLevel,
    rarityCode: "rare",
    qualityBp: 5000,
    powerBudgetTotal: 50,
    powerBudgetSpent: 20,
    implicitAttributes: zero,
    generatedAttributes: zero,
    affixes: [],
    currentDurability: def.maxDurability ?? 100,
    maxDurability: def.maxDurability ?? 100,
    bindingState: "unbound",
    boundAccountId: null,
    boundCharacterId: null,
    generationRulesVersion: 1,
    generationSeedHash: "0123456789abcdef0123456789abcdef",
    originType: "dev_authorized",
    originReference: "sim",
    instanceVersion: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  return { slotCode, instance, definition: def };
}

/**
 * Deterministic development harness (Section 40) validating mastery curves, specialization DAGs,
 * point conservation, build equipment budgets, and emergent hybrid builds across 6 archetypes.
 * NOTE: Demonstrates structural progression coherence — NOT proven live PvP balance.
 */
export function runSkillProgressionSimulation(
  rules: MasteryAndSkillRulesConfig = DEFAULT_MASTERY_AND_SKILL_RULES_V1,
): SkillProgressionSimulationReport {
  validateSpecializationDag({
    nodes: INITIAL_SPECIALIZATION_NODES_CATALOG,
    abilities: INITIAL_ABILITY_DEFINITIONS_CATALOG,
    rules,
  });

  const sampleLevels = [1, 5, 10, 20, 25, 50, 75, 95, 100];
  const masteryCurveSamples: MasteryCurveMilestoneSample[] = [];
  let prevXp = 0n;
  for (const lvl of sampleLevels) {
    const cum = cumulativeMasteryXpForLevel(lvl, rules);
    masteryCurveSamples.push({
      level: lvl,
      cumulativeXp: cum,
      deltaFromPreviousSample: cum - prevXp,
      proficiencyRank: resolveProficiencyRank(lvl, rules),
    });
    prevXp = cum;
  }

  const nodeMap = new Map<string, SpecializationNodeDefinition>(
    INITIAL_SPECIALIZATION_NODES_CATALOG.map((n) => [n.nodeCode, n]),
  );
  const abilityMap = new Map<string, AbilityDefinition>(
    INITIAL_ABILITY_DEFINITIONS_CATALOG.map((a) => [a.abilityCode, a]),
  );

  interface SimSpec {
    readonly archetypeCode: ArchetypeBuildSimulationResult["archetypeCode"];
    readonly displayName: string;
    readonly presetKey: string;
    readonly simulatedLevel: number;
    readonly masteries: ReadonlyArray<{ family: MasteryWeaponFamilyCode; xpGrant: bigint }>;
    readonly nodesToUnlock: ReadonlyArray<string>;
    readonly abilitiesToLearn: ReadonlyArray<{ code: string; targetRank: number }>;
    readonly loadout: ReadonlyArray<{ slotIndex: number; abilityCode: string }>;
    readonly primaryGear: ReadonlyArray<{ slot: CombatEquipmentSlot; defCode: string }>;
  }

  const scenarios: ReadonlyArray<SimSpec> = [
    {
      archetypeCode: "pure_swordsman",
      displayName: "Espadachim Puro",
      presetKey: "berserker",
      simulatedLevel: 8,
      masteries: [
        { family: "longsword", xpGrant: cumulativeMasteryXpForLevel(25, rules) },
      ],
      nodesToUnlock: [
        "node_sword_foundation",
        "node_sword_duelist_stance",
        "node_sword_sovereign_mastery",
      ],
      abilitiesToLearn: [
        { code: "rising_slash", targetRank: 3 },
        { code: "imperial_thrust", targetRank: 2 },
        { code: "duelist_counter", targetRank: 1 },
        { code: "blade_discipline", targetRank: 1 },
        { code: "sovereign_blade_storm", targetRank: 1 },
      ],
      loadout: [
        { slotIndex: 0, abilityCode: "rising_slash" },
        { slotIndex: 1, abilityCode: "imperial_thrust" },
        { slotIndex: 2, abilityCode: "duelist_counter" },
        { slotIndex: 4, abilityCode: "blade_discipline" },
      ],
      primaryGear: [{ slot: "main_hand", defCode: "ironfang_longsword" }],
    },
    {
      archetypeCode: "guardian",
      displayName: "Guardião",
      presetKey: "paladin",
      simulatedLevel: 6,
      masteries: [
        { family: "shield", xpGrant: cumulativeMasteryXpForLevel(10, rules) },
        { family: "longsword", xpGrant: cumulativeMasteryXpForLevel(6, rules) },
      ],
      nodesToUnlock: ["node_defense_bulwark_core", "node_defense_citadel_capstone"],
      abilitiesToLearn: [
        { code: "guardian_aegis", targetRank: 2 },
        { code: "shield_retaliation", targetRank: 2 },
        { code: "unwavering_stance", targetRank: 1 },
        { code: "guardian_resilience", targetRank: 1 },
      ],
      loadout: [
        { slotIndex: 0, abilityCode: "guardian_aegis" },
        { slotIndex: 1, abilityCode: "shield_retaliation" },
        { slotIndex: 2, abilityCode: "unwavering_stance" },
        { slotIndex: 4, abilityCode: "guardian_resilience" },
      ],
      primaryGear: [
        { slot: "main_hand", defCode: "ironfang_longsword" },
        { slot: "off_hand", defCode: "valewatch_tower_shield" },
      ],
    },
    {
      archetypeCode: "monk",
      displayName: "Monge",
      presetKey: "monk",
      simulatedLevel: 7,
      masteries: [
        { family: "gauntlets", xpGrant: cumulativeMasteryXpForLevel(18, rules) },
      ],
      nodesToUnlock: [
        "node_martial_conditioning",
        "node_martial_inner_breath",
        "node_martial_grand_form",
      ],
      abilitiesToLearn: [
        { code: "iron_fist", targetRank: 2 },
        { code: "resonant_palm", targetRank: 1 },
        { code: "spiritual_flurry", targetRank: 1 },
        { code: "spiritual_flow", targetRank: 1 },
      ],
      loadout: [
        { slotIndex: 0, abilityCode: "iron_fist" },
        { slotIndex: 1, abilityCode: "resonant_palm" },
        { slotIndex: 4, abilityCode: "spiritual_flow" },
        { slotIndex: 6, abilityCode: "spiritual_flurry" },
      ],
      primaryGear: [{ slot: "main_hand", defCode: "wandering_monk_gauntlets" }],
    },
    {
      archetypeCode: "arcanist",
      displayName: "Arcanista",
      presetKey: "arcanist",
      simulatedLevel: 7,
      masteries: [
        { family: "staff_2h", xpGrant: cumulativeMasteryXpForLevel(18, rules) },
      ],
      nodesToUnlock: [
        "node_arcane_initiate",
        "node_arcane_spellblade_bridge",
        "node_arcane_convergence_capstone",
      ],
      abilitiesToLearn: [
        { code: "arcane_lance", targetRank: 2 },
        { code: "mana_pulse", targetRank: 1 },
        { code: "arcane_barrier", targetRank: 1 },
        { code: "arcane_focus", targetRank: 1 },
        { code: "elemental_rupture", targetRank: 1 },
      ],
      loadout: [
        { slotIndex: 0, abilityCode: "arcane_lance" },
        { slotIndex: 1, abilityCode: "mana_pulse" },
        { slotIndex: 4, abilityCode: "arcane_focus" },
        { slotIndex: 6, abilityCode: "elemental_rupture" },
      ],
      primaryGear: [{ slot: "main_hand", defCode: "twilight_staff" }],
    },
    {
      archetypeCode: "arcane_knight",
      displayName: "Cavaleiro Arcano (Híbrido)",
      presetKey: "arcane_knight",
      simulatedLevel: 7,
      masteries: [
        { family: "longsword", xpGrant: cumulativeMasteryXpForLevel(10, rules) },
        { family: "grimoire", xpGrant: cumulativeMasteryXpForLevel(8, rules) },
      ],
      nodesToUnlock: [
        "node_sword_foundation",
        "node_arcane_initiate",
        "node_arcane_spellblade_bridge",
      ],
      abilitiesToLearn: [
        { code: "rising_slash", targetRank: 2 },
        { code: "imperial_thrust", targetRank: 1 },
        { code: "arcane_lance", targetRank: 1 },
        { code: "arcane_barrier", targetRank: 1 },
        { code: "blade_discipline", targetRank: 1 },
      ],
      loadout: [
        { slotIndex: 0, abilityCode: "rising_slash" },
        { slotIndex: 1, abilityCode: "imperial_thrust" },
        { slotIndex: 2, abilityCode: "arcane_lance" },
        { slotIndex: 3, abilityCode: "arcane_barrier" },
      ],
      primaryGear: [
        { slot: "main_hand", defCode: "ironfang_longsword" },
        { slot: "off_hand", defCode: "astral_vigil_grimoire" },
      ],
    },
    {
      archetypeCode: "hybrid_assassin",
      displayName: "Assassino Híbrido (Sombras + Arcano)",
      presetKey: "assassin",
      simulatedLevel: 7,
      masteries: [
        { family: "dagger", xpGrant: cumulativeMasteryXpForLevel(12, rules) },
      ],
      nodesToUnlock: [
        "node_shadow_footwork",
        "node_shadow_opportunist",
        "node_shadow_phantom_capstone",
        "node_arcane_initiate",
      ],
      abilitiesToLearn: [
        { code: "shadow_step", targetRank: 2 },
        { code: "shadow_slash", targetRank: 2 },
        { code: "silent_lunge", targetRank: 1 },
        { code: "mana_pulse", targetRank: 1 },
      ],
      loadout: [
        { slotIndex: 0, abilityCode: "shadow_step" },
        { slotIndex: 1, abilityCode: "shadow_slash" },
        { slotIndex: 2, abilityCode: "silent_lunge" },
        { slotIndex: 3, abilityCode: "mana_pulse" },
      ],
      primaryGear: [{ slot: "main_hand", defCode: "thornveil_dagger" }],
    },
  ];

  const archetypeComparisons: ArchetypeBuildSimulationResult[] = [];

  for (const sc of scenarios) {
    const preset = BUILD_ARCHETYPE_PRESETS[sc.presetKey]!;
    const alloc =
      sc.archetypeCode === "pure_swordsman"
        ? {
            ...preset.allocatedAttributes,
            strength: 16,
            fortitude: 10,
            vigor: 8,
            dexterity: 16,
          }
        : sc.archetypeCode === "guardian"
          ? {
              ...preset.allocatedAttributes,
              strength: 8,
              fortitude: 16,
              vigor: 6,
              wisdom: 6,
              determination: 14,
            }
          : sc.archetypeCode === "arcane_knight"
            ? {
                ...preset.allocatedAttributes,
                strength: 12,
                fortitude: 8,
                dexterity: 8,
                intelligence: 14,
                wisdom: 8,
              }
            : sc.archetypeCode === "hybrid_assassin"
              ? {
                  ...preset.allocatedAttributes,
                  agility: 18,
                  dexterity: 18,
                  intelligence: 10,
                  luck: 4,
                }
              : preset.allocatedAttributes;

    let char = Character.createInitial({
      id: "00000000-0000-4000-8000-000000000010",
      accountId: "00000000-0000-4000-8000-000000000001",
      displayName: "Simulador",
      canonicalName: "simulador",
      raceCode: "humans",
      lineageCode: "human_valorian",
      cultureCode: "valewatch_civic",
      backgroundCode: "veteran_soldier",
      originRegionId: "region-ashvale",
      hometownSettlementRef: null,
      appearance: {
        appearanceCatalogVersion: 1,
        bodyPreset: "athletic_a",
        skinTone: "olive_bronze",
        hairStyle: "short_cropped",
        hairColor: "raven_black",
        eyeStyle: "almond_sharp",
        eyeColor: "slate_blue",
        facialFeatures: null,
        beardStyle: null,
        earStyle: "rounded_standard",
        hornStyle: null,
        tailStyle: null,
        scalePattern: null,
        tattoos: [],
        scars: [],
        cosmeticAccessories: [],
        voiceProfile: null,
      },
      initialAllocationDelta: alloc,
      rules: DEFAULT_DEV_PROGRESSION_RULES_V1,
      now: new Date(0),
    });

    // Advance character level for simulation
    char = char.applyExperienceGrant({
      validatedAmount: 25000n,
      rules: DEFAULT_DEV_PROGRESSION_RULES_V1,
      now: new Date(0),
    }).updated;

    const earnedSpecPoints =
      rules.initialSpecializationPoints +
      Math.max(0, sc.simulatedLevel - 1) * rules.specializationPointsPerLevel +
      6; // Milestone training bonus in harness
    let spentSpecPoints = 0;

    const masteryMap = new Map<MasteryWeaponFamilyCode, CharacterWeaponMastery>();
    for (const m of sc.masteries) {
      const adv = evaluateMasteryAdvancement({
        currentXp: 0n,
        currentLevel: 1,
        validatedGrantAmount: m.xpGrant,
        rules,
      });
      masteryMap.set(m.family, {
        characterId: char.id,
        weaponFamilyCode: m.family,
        masteryExperience: adv.newXp,
        masteryLevel: adv.newLevel,
        proficiencyRank: adv.newRank,
        rulesVersion: rules.rulesVersion,
        version: 1,
        updatedAt: new Date(0),
      });
    }

    const activeNodeCodes = new Set<string>();
    const activeNodes: SpecializationNodeDefinition[] = [];
    for (const nc of sc.nodesToUnlock) {
      const node = nodeMap.get(nc)!;
      assertCanUnlockSpecializationNode({
        character: char,
        node,
        masteryMap,
        activeUnlockedNodeCodes: activeNodeCodes,
        activeUnlockedNodes: activeNodes,
      });
      spentSpecPoints += node.pointCost;
      activeNodeCodes.add(nc);
      activeNodes.push(node);
    }

    const learnedMap = new Map<string, CharacterLearnedAbility>();
    const activeLearnedCodes = new Set<string>();
    const schoolsUsed = new Set<string>();

    for (const ab of sc.abilitiesToLearn) {
      const def = abilityMap.get(ab.code)!;
      assertCanLearnAbility({
        character: char,
        ability: def,
        masteryMap,
        activeLearnedAbilityCodes: activeLearnedCodes,
        activeUnlockedNodeCodes: activeNodeCodes,
      });
      const upgradePoints = (ab.targetRank - 1) * def.rankUpgradeCost;
      const totalPts = def.unlockCost + upgradePoints;
      spentSpecPoints += totalPts;
      schoolsUsed.add(def.schoolCode);
      activeLearnedCodes.add(def.abilityCode);
      learnedMap.set(def.abilityCode, {
        characterId: char.id,
        abilityCode: def.abilityCode,
        abilityVersion: def.abilityVersion,
        currentRank: ab.targetRank,
        maxRankEverReached: ab.targetRank,
        isActive: true,
        pointsInvested: totalPts,
        learnedAt: new Date(0),
        updatedAt: new Date(0),
        version: 1,
      });
    }

    const unspentSpecPoints = earnedSpecPoints - spentSpecPoints;
    if (unspentSpecPoints < 0) {
      throw new Error(`Simulation budget overrun for ${sc.archetypeCode}`);
    }

    const loadoutSummary = validateAbilityLoadoutConfiguration({
      assignments: sc.loadout,
      learnedByCode: learnedMap,
      definitionsByCode: abilityMap,
      rules,
    });

    const primaryHandItems = sc.primaryGear.map((g) =>
      makeMockEquippedWeapon(g.slot, g.defCode, char.id),
    );
    const staffSwapItems = [makeMockEquippedWeapon("main_hand", "twilight_staff", char.id)];

    let allEligiblePrimary = true;
    let suppressedOnStaff = 0;

    for (const slot of loadoutSummary.orderedSlots) {
      const def = abilityMap.get(slot.abilityCode)!;
      const learned = learnedMap.get(slot.abilityCode)!;
      const eligPrimary = evaluateRuntimeAbilityUsageEligibility({
        character: char,
        learned,
        definition: def,
        masteryMap,
        activeUnlockedNodeCodes: activeNodeCodes,
        equippedHandItems: primaryHandItems,
      });
      if (!eligPrimary.isEligible) {
        allEligiblePrimary = false;
      }

      const eligStaff = evaluateRuntimeAbilityUsageEligibility({
        character: char,
        learned,
        definition: def,
        masteryMap,
        activeUnlockedNodeCodes: activeNodeCodes,
        equippedHandItems: staffSwapItems,
      });
      if (!eligStaff.isEligible) {
        suppressedOnStaff++;
      }
    }

    archetypeComparisons.push({
      archetypeCode: sc.archetypeCode,
      displayName: sc.displayName,
      schoolsCombined: Array.from(schoolsUsed),
      simulatedLevel: char.level,
      specializationPointsEarned: earnedSpecPoints,
      specializationPointsSpent: spentSpecPoints,
      specializationPointsUnspent: unspentSpecPoints,
      unlockedNodes: Array.from(activeNodeCodes),
      learnedAbilities: Array.from(learnedMap.values()).map((l) => ({
        abilityCode: l.abilityCode,
        rank: l.currentRank,
      })),
      equippedSlots: loadoutSummary.orderedSlots.map((s) => ({
        slotIndex: s.slotIndex,
        abilityCode: s.abilityCode,
      })),
      buildEquipmentCostUsed: loadoutSummary.totalEquipmentCost,
      buildEquipmentCostMax: rules.maxBuildEquipmentCost,
      allEquippedEligibleWithPrimaryGear: allEligiblePrimary,
      suppressedCountWhenSwappingToIncompatibleStaff: suppressedOnStaff,
    });
  }

  return {
    rulesVersion: rules.rulesVersion,
    dagValidated: true,
    enabledSchoolCount: INITIAL_COMBAT_SCHOOLS_CATALOG.filter((s) => s.isEnabled).length,
    enabledAbilityCount: INITIAL_ABILITY_DEFINITIONS_CATALOG.filter((a) => a.isEnabled).length,
    masteryCurveSamples,
    archetypeComparisons,
  };
}
