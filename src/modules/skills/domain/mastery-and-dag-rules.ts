import { MAX_INT64 } from "../../../shared/contracts/int64-wire.js";
import type { Character } from "../../characters/domain/character.js";
import { checkIntrinsicCharacterEligibility } from "../../inventory/domain/equipment-and-stack-rules.js";
import type {
  CombatEquipmentSlot,
  ItemDefinition,
  ItemInstance,
} from "../../inventory/domain/item-types.js";
import {
  PRIMARY_ATTRIBUTE_KEYS,
  type AttributeBlock,
  type PrimaryAttributeKey,
} from "../../peoples/domain/character-snapshot-proposal.js";
import {
  AbilityLoadoutInvalidError,
  MasteryNumericOverflowError,
  SkillPrerequisiteUnmetError,
  SpecializationDagInvalidError,
} from "./errors.js";
import {
  MASTERY_WEAPON_FAMILY_SET,
  type AbilityCategory,
  type AbilityDefinition,
  type AbilitySlotGroup,
  type AbilitySuppressionReason,
  type CharacterLearnedAbility,
  type CharacterWeaponMastery,
  type DeclarativePassiveParams,
  type MasteryAndSkillRulesConfig,
  type MasteryWeaponFamilyCode,
  type ProficiencyRank,
  type SpecializationNodeDefinition,
} from "./skill-and-mastery-types.js";

const IDENTIFIER_PARAM_KEY_RE = /^[a-z][a-z0-9_]{1,47}$/;

export function assertValidMasteryWeaponFamily(
  code: string,
): asserts code is MasteryWeaponFamilyCode {
  if (!MASTERY_WEAPON_FAMILY_SET.has(code)) {
    throw new SkillPrerequisiteUnmetError(
      `Unsupported weapon mastery family '${code}'. Must be one of the 22 Session 04 weapon families or 'unarmed'.`,
    );
  }
}

export function resolveExpectedSlotGroup(category: AbilityCategory): AbilitySlotGroup {
  if (category === "passive") {
    return "passive";
  }
  if (category === "ultimate_super") {
    return "ultimate";
  }
  return "active";
}

/**
 * Validates declarative passive parameters to guarantee ZERO arbitrary code/script storage.
 */
export function validateDeclarativePassiveParams(
  category: AbilityCategory,
  params: DeclarativePassiveParams | null,
): void {
  if (category === "passive") {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new SpecializationDagInvalidError(
        "Passive abilities must provide a non-empty declarative parameter map.",
      );
    }
    const entries = Object.entries(params);
    if (entries.length === 0 || entries.length > 8) {
      throw new SpecializationDagInvalidError(
        "Passive declarative parameter map must contain 1..8 bounded numeric parameters.",
      );
    }
    for (const [k, v] of entries) {
      if (!IDENTIFIER_PARAM_KEY_RE.test(k)) {
        throw new SpecializationDagInvalidError(
          `Invalid passive parameter identifier '${k}'.`,
        );
      }
      if (typeof v !== "number" || !Number.isSafeInteger(v) || Math.abs(v) > 1_000_000) {
        throw new SpecializationDagInvalidError(
          `Passive parameter '${k}' must be a bounded integer within [-1000000, 1000000].`,
        );
      }
    }
    return;
  }

  if (params !== null) {
    throw new SpecializationDagInvalidError(
      `Non-passive ability category '${category}' must have declarativePassiveParams = null.`,
    );
  }
}

/**
 * Monotonically increasing cumulative mastery XP required to reach `targetLevel` (`1..maxMasteryLevel`).
 * Level 1 requires 0 XP. For level L > 1:
 *   sum_{k = 1..L-1} (xpCurveBase + xpCurveLinear * k + xpCurveQuadratic * k^2)
 */
export function cumulativeMasteryXpForLevel(
  targetLevel: number,
  rules: MasteryAndSkillRulesConfig,
): bigint {
  if (
    !Number.isInteger(targetLevel) ||
    targetLevel < rules.minMasteryLevel ||
    targetLevel > rules.maxMasteryLevel
  ) {
    throw new RangeError(
      `targetLevel (${targetLevel}) out of mastery bounds [${rules.minMasteryLevel}..${rules.maxMasteryLevel}].`,
    );
  }
  if (targetLevel === 1) {
    return 0n;
  }
  const n = BigInt(targetLevel - 1);
  // Sum_{k=1..n} 1 = n
  // Sum_{k=1..n} k = n(n+1)/2
  // Sum_{k=1..n} k^2 = n(n+1)(2n+1)/6
  const baseTerm = rules.xpCurveBase * n;
  const linearTerm = (rules.xpCurveLinear * n * (n + 1n)) / 2n;
  const quadTerm = (rules.xpCurveQuadratic * n * (n + 1n) * (2n * n + 1n)) / 6n;
  return baseTerm + linearTerm + quadTerm;
}

export function resolveProficiencyRank(
  masteryLevel: number,
  rules: MasteryAndSkillRulesConfig,
): ProficiencyRank {
  for (const band of rules.proficiencyBands) {
    if (masteryLevel >= band.minLevel && masteryLevel <= band.maxLevel) {
      return band.rank;
    }
  }
  return masteryLevel >= rules.maxMasteryLevel ? "grandmaster" : "novice";
}

export function applyMasteryDiminishingReturns(params: {
  readonly baseAmount: bigint;
  readonly priorGrantsInWindow: number;
  readonly stepBp: number;
}): bigint {
  if (params.baseAmount <= 0n) {
    throw new MasteryNumericOverflowError("Mastery XP grant amount must be > 0.");
  }
  if (params.priorGrantsInWindow <= 0 || params.stepBp <= 0) {
    return params.baseAmount;
  }
  // Minimum 10% (1000 bp) floor while within window cap so validated grants remain > 0
  const reductionBp = Math.min(9000, params.priorGrantsInWindow * params.stepBp);
  const multiplierBp = BigInt(10000 - reductionBp);
  const scaled = (params.baseAmount * multiplierBp) / 10000n;
  return scaled >= 1n ? scaled : 1n;
}

export interface MasteryAdvancementOutcome {
  readonly previousXp: bigint;
  readonly newXp: bigint;
  readonly previousLevel: number;
  readonly newLevel: number;
  readonly levelsGained: number;
  readonly previousRank: ProficiencyRank;
  readonly newRank: ProficiencyRank;
  readonly crossedMilestones: ReadonlyArray<number>;
}

export function evaluateMasteryAdvancement(params: {
  readonly currentXp: bigint;
  readonly currentLevel: number;
  readonly validatedGrantAmount: bigint;
  readonly rules: MasteryAndSkillRulesConfig;
}): MasteryAdvancementOutcome {
  if (params.validatedGrantAmount <= 0n) {
    throw new MasteryNumericOverflowError("Validated mastery XP amount must be > 0.");
  }
  if (params.currentXp < 0n) {
    throw new MasteryNumericOverflowError("Current mastery XP cannot be negative.");
  }
  if (MAX_INT64 - params.currentXp < params.validatedGrantAmount) {
    throw new MasteryNumericOverflowError(
      `Mastery experience addition (${params.currentXp} + ${params.validatedGrantAmount}) overflows signed 64-bit integer.`,
    );
  }

  const newXp = params.currentXp + params.validatedGrantAmount;
  let newLevel = params.currentLevel;

  // Binary search or bounded scan across 1..100
  let lo = params.currentLevel;
  let hi = params.rules.maxMasteryLevel;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const req = cumulativeMasteryXpForLevel(mid, params.rules);
    if (newXp >= req) {
      newLevel = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const previousRank = resolveProficiencyRank(params.currentLevel, params.rules);
  const newRank = resolveProficiencyRank(newLevel, params.rules);
  const crossedMilestones = params.rules.masteryMilestoneLevels.filter(
    (m) => m > params.currentLevel && m <= newLevel,
  );

  return {
    previousXp: params.currentXp,
    newXp,
    previousLevel: params.currentLevel,
    newLevel,
    levelsGained: newLevel - params.currentLevel,
    previousRank,
    newRank,
    crossedMilestones,
  };
}

/**
 * Computes strictly non-circular intrinsic character attributes (`Base + Allocated`),
 * deliberately excluding equipment modifiers and passive ability effects to prevent circular eligibility!
 */
export function computeIntrinsicCharacterAttributes(character: Character): AttributeBlock {
  return {
    strength: character.baseAttributes.strength + character.allocatedAttributes.strength,
    fortitude: character.baseAttributes.fortitude + character.allocatedAttributes.fortitude,
    vigor: character.baseAttributes.vigor + character.allocatedAttributes.vigor,
    agility: character.baseAttributes.agility + character.allocatedAttributes.agility,
    dexterity: character.baseAttributes.dexterity + character.allocatedAttributes.dexterity,
    intelligence:
      character.baseAttributes.intelligence + character.allocatedAttributes.intelligence,
    wisdom: character.baseAttributes.wisdom + character.allocatedAttributes.wisdom,
    determination:
      character.baseAttributes.determination + character.allocatedAttributes.determination,
    luck: character.baseAttributes.luck + character.allocatedAttributes.luck,
    charisma: character.baseAttributes.charisma + character.allocatedAttributes.charisma,
  };
}

export function resolveHighestMasteryForRequirement(
  requiredFamilies: ReadonlyArray<MasteryWeaponFamilyCode>,
  masteryMap: ReadonlyMap<MasteryWeaponFamilyCode, CharacterWeaponMastery>,
): number {
  if (requiredFamilies.length === 0) {
    let best = 1;
    for (const m of masteryMap.values()) {
      if (m.masteryLevel > best) {
        best = m.masteryLevel;
      }
    }
    return best;
  }
  let best = 1;
  for (const fam of requiredFamilies) {
    const m = masteryMap.get(fam);
    const lvl = m ? m.masteryLevel : 1;
    if (lvl > best) {
      best = lvl;
    }
  }
  return best;
}

/**
 * Validates that a set of specialization nodes forms a bounded, cycle-free Directed Acyclic Graph (DAG)
 * with valid references, bounded depth, bounded school node counts, and satisfiable conditions.
 */
export function validateSpecializationDag(params: {
  readonly nodes: ReadonlyArray<SpecializationNodeDefinition>;
  readonly abilities: ReadonlyArray<AbilityDefinition>;
  readonly rules: MasteryAndSkillRulesConfig;
  readonly maxIntrinsicAttributeCap?: number | undefined;
}): void {
  const maxAttrCap = params.maxIntrinsicAttributeCap ?? 30;
  const nodeMap = new Map<string, SpecializationNodeDefinition>();
  const schoolCounts = new Map<string, number>();
  const abilityKeySet = new Set<string>(
    params.abilities.map((a) => `${a.abilityCode}@${a.abilityVersion}`),
  );

  for (const n of params.nodes) {
    if (nodeMap.has(n.nodeCode)) {
      throw new SpecializationDagInvalidError(`Duplicate specialization node '${n.nodeCode}'.`);
    }
    if (!Number.isInteger(n.pointCost) || n.pointCost < 0) {
      throw new SpecializationDagInvalidError(
        `Specialization node '${n.nodeCode}' has invalid negative pointCost (${n.pointCost}).`,
      );
    }
    if (
      !Number.isInteger(n.tierDepth) ||
      n.tierDepth < 1 ||
      n.tierDepth > params.rules.maxTreeDepth
    ) {
      throw new SpecializationDagInvalidError(
        `Specialization node '${n.nodeCode}' tierDepth (${n.tierDepth}) exceeds maxTreeDepth (${params.rules.maxTreeDepth}).`,
      );
    }
    if (n.requiredCharacterLevel < 1 || n.requiredCharacterLevel > 1000) {
      throw new SpecializationDagInvalidError(
        `Specialization node '${n.nodeCode}' has impossible requiredCharacterLevel (${n.requiredCharacterLevel}).`,
      );
    }
    if (
      n.requiredMasteryLevel < params.rules.minMasteryLevel ||
      n.requiredMasteryLevel > params.rules.maxMasteryLevel
    ) {
      throw new SpecializationDagInvalidError(
        `Specialization node '${n.nodeCode}' has impossible requiredMasteryLevel (${n.requiredMasteryLevel}).`,
      );
    }
    for (const fam of n.requiredWeaponFamilies) {
      if (!MASTERY_WEAPON_FAMILY_SET.has(fam)) {
        throw new SpecializationDagInvalidError(
          `Specialization node '${n.nodeCode}' references unknown weapon family '${fam}'.`,
        );
      }
    }
    for (const key of PRIMARY_ATTRIBUTE_KEYS) {
      const req = n.requiredAttributes[key];
      if (req !== undefined && (!Number.isInteger(req) || req < 0 || req > maxAttrCap)) {
        throw new SpecializationDagInvalidError(
          `Specialization node '${n.nodeCode}' has impossible intrinsic attribute requirement ${key}=${String(req)} (cap ${maxAttrCap}).`,
        );
      }
    }
    if (n.abilityCode !== null || n.abilityVersion !== null) {
      const key = `${String(n.abilityCode)}@${String(n.abilityVersion)}`;
      if (!abilityKeySet.has(key)) {
        throw new SpecializationDagInvalidError(
          `Specialization node '${n.nodeCode}' references missing ability definition '${key}'.`,
        );
      }
    }

    const nextCount = (schoolCounts.get(n.schoolCode) ?? 0) + 1;
    if (nextCount > params.rules.maxNodesPerSchool) {
      throw new SpecializationDagInvalidError(
        `School '${n.schoolCode}' exceeds maxNodesPerSchool (${params.rules.maxNodesPerSchool}).`,
      );
    }
    schoolCounts.set(n.schoolCode, nextCount);
    nodeMap.set(n.nodeCode, n);
  }

  // Three-color DFS cycle detection + longest prerequisite chain depth verification
  const visitState = new Map<string, "visiting" | "visited">();
  const computedDepth = new Map<string, number>();

  function dfs(code: string): number {
    const st = visitState.get(code);
    if (st === "visiting") {
      throw new SpecializationDagInvalidError(
        `Cycle detected in specialization graph involving node '${code}'.`,
      );
    }
    if (st === "visited") {
      return computedDepth.get(code)!;
    }

    visitState.set(code, "visiting");
    const node = nodeMap.get(code)!;
    let maxParentDepth = 0;

    for (const prereqCode of node.prerequisiteNodes) {
      if (prereqCode === code) {
        throw new SpecializationDagInvalidError(
          `Self-dependency detected on specialization node '${code}'.`,
        );
      }
      const parent = nodeMap.get(prereqCode);
      if (!parent) {
        throw new SpecializationDagInvalidError(
          `Specialization node '${code}' depends on non-existent prerequisite node '${prereqCode}'.`,
        );
      }
      if (
        node.exclusiveGroup !== null &&
        parent.exclusiveGroup !== null &&
        node.exclusiveGroup === parent.exclusiveGroup
      ) {
        throw new SpecializationDagInvalidError(
          `Impossible condition on '${code}': prerequisite '${prereqCode}' shares exclusiveGroup '${node.exclusiveGroup}'.`,
        );
      }
      const d = dfs(prereqCode);
      if (d > maxParentDepth) {
        maxParentDepth = d;
      }
    }

    const myDepth = maxParentDepth + 1;
    if (myDepth > params.rules.maxTreeDepth) {
      throw new SpecializationDagInvalidError(
        `Specialization path ending at '${code}' has depth ${myDepth}, exceeding maxTreeDepth (${params.rules.maxTreeDepth}).`,
      );
    }

    computedDepth.set(code, myDepth);
    visitState.set(code, "visited");
    return myDepth;
  }

  for (const code of nodeMap.keys()) {
    dfs(code);
  }
}

export function assertCanUnlockSpecializationNode(params: {
  readonly character: Character;
  readonly node: SpecializationNodeDefinition;
  readonly masteryMap: ReadonlyMap<MasteryWeaponFamilyCode, CharacterWeaponMastery>;
  readonly activeUnlockedNodeCodes: ReadonlySet<string>;
  readonly activeUnlockedNodes: ReadonlyArray<SpecializationNodeDefinition>;
}): void {
  if (params.character.level < params.node.requiredCharacterLevel) {
    throw new SkillPrerequisiteUnmetError(
      `Node '${params.node.nodeCode}' requires character level ${params.node.requiredCharacterLevel} (current: ${params.character.level}).`,
    );
  }

  const intrinsic = computeIntrinsicCharacterAttributes(params.character);
  for (const key of PRIMARY_ATTRIBUTE_KEYS) {
    const req = params.node.requiredAttributes[key];
    if (req !== undefined && intrinsic[key] < req) {
      throw new SkillPrerequisiteUnmetError(
        `Node '${params.node.nodeCode}' requires intrinsic ${key} >= ${req} (current: ${intrinsic[key]}).`,
      );
    }
  }

  const masteryLvl = resolveHighestMasteryForRequirement(
    params.node.requiredWeaponFamilies,
    params.masteryMap,
  );
  if (masteryLvl < params.node.requiredMasteryLevel) {
    throw new SkillPrerequisiteUnmetError(
      `Node '${params.node.nodeCode}' requires weapon mastery level >= ${params.node.requiredMasteryLevel} (current: ${masteryLvl}).`,
    );
  }

  for (const prereq of params.node.prerequisiteNodes) {
    if (!params.activeUnlockedNodeCodes.has(prereq)) {
      throw new SkillPrerequisiteUnmetError(
        `Node '${params.node.nodeCode}' requires prerequisite specialization node '${prereq}'.`,
      );
    }
  }

  if (params.node.exclusiveGroup !== null) {
    const conflict = params.activeUnlockedNodes.find(
      (u) => u.nodeCode !== params.node.nodeCode && u.exclusiveGroup === params.node.exclusiveGroup,
    );
    if (conflict) {
      throw new SkillPrerequisiteUnmetError(
        `Node '${params.node.nodeCode}' conflicts with active exclusive specialization node '${conflict.nodeCode}' (group '${params.node.exclusiveGroup}').`,
      );
    }
  }
}

export function assertCanLearnAbility(params: {
  readonly character: Character;
  readonly ability: AbilityDefinition;
  readonly masteryMap: ReadonlyMap<MasteryWeaponFamilyCode, CharacterWeaponMastery>;
  readonly activeLearnedAbilityCodes: ReadonlySet<string>;
  readonly activeUnlockedNodeCodes: ReadonlySet<string>;
}): void {
  if (params.character.level < params.ability.requiredCharacterLevel) {
    throw new SkillPrerequisiteUnmetError(
      `Ability '${params.ability.abilityCode}' requires character level ${params.ability.requiredCharacterLevel} (current: ${params.character.level}).`,
    );
  }

  const intrinsic = computeIntrinsicCharacterAttributes(params.character);
  for (const key of PRIMARY_ATTRIBUTE_KEYS) {
    const req = params.ability.requiredAttributes[key];
    if (req !== undefined && intrinsic[key] < req) {
      throw new SkillPrerequisiteUnmetError(
        `Ability '${params.ability.abilityCode}' requires intrinsic ${key} >= ${req} (current: ${intrinsic[key]}).`,
      );
    }
  }

  const masteryLvl = resolveHighestMasteryForRequirement(
    params.ability.requiredWeaponFamilies,
    params.masteryMap,
  );
  if (masteryLvl < params.ability.requiredMasteryLevel) {
    throw new SkillPrerequisiteUnmetError(
      `Ability '${params.ability.abilityCode}' requires mastery level >= ${params.ability.requiredMasteryLevel} in [${params.ability.requiredWeaponFamilies.join(", ") || "any"}] (current: ${masteryLvl}).`,
    );
  }

  for (const prereqAb of params.ability.prerequisiteAbilities) {
    if (!params.activeLearnedAbilityCodes.has(prereqAb)) {
      throw new SkillPrerequisiteUnmetError(
        `Ability '${params.ability.abilityCode}' requires learned prerequisite ability '${prereqAb}'.`,
      );
    }
  }

  for (const prereqNode of params.ability.prerequisiteNodes) {
    if (!params.activeUnlockedNodeCodes.has(prereqNode)) {
      throw new SkillPrerequisiteUnmetError(
        `Ability '${params.ability.abilityCode}' requires unlocked specialization node '${prereqNode}'.`,
      );
    }
  }
}

export interface EquippedHandItemContext {
  readonly slotCode: CombatEquipmentSlot;
  readonly instance: ItemInstance;
  readonly definition: ItemDefinition;
}

export interface AbilityUsageEligibilityResult {
  readonly isEligible: boolean;
  readonly suppressionReason: AbilitySuppressionReason | null;
  readonly resolvedWeaponFamily: MasteryWeaponFamilyCode | null;
  readonly effectiveMasteryLevel: number;
}

/**
 * Evaluates runtime usage eligibility of a learned ability against the character's
 * current intrinsic attributes, specialization state, mastery, and equipped weapons/durability.
 * Never mutates or deletes learned progress!
 */
export function evaluateRuntimeAbilityUsageEligibility(params: {
  readonly character: Character;
  readonly learned: CharacterLearnedAbility;
  readonly definition: AbilityDefinition;
  readonly masteryMap: ReadonlyMap<MasteryWeaponFamilyCode, CharacterWeaponMastery>;
  readonly activeUnlockedNodeCodes: ReadonlySet<string>;
  readonly equippedHandItems: ReadonlyArray<EquippedHandItemContext>;
}): AbilityUsageEligibilityResult {
  const effectiveMasteryLevel = resolveHighestMasteryForRequirement(
    params.definition.requiredWeaponFamilies,
    params.masteryMap,
  );

  if (!params.definition.isEnabled) {
    return {
      isEligible: false,
      suppressionReason: "ability_disabled",
      resolvedWeaponFamily: null,
      effectiveMasteryLevel,
    };
  }

  if (!params.learned.isActive) {
    return {
      isEligible: false,
      suppressionReason: "inactive_after_specialization_reset",
      resolvedWeaponFamily: null,
      effectiveMasteryLevel,
    };
  }

  for (const prereqNode of params.definition.prerequisiteNodes) {
    if (!params.activeUnlockedNodeCodes.has(prereqNode)) {
      return {
        isEligible: false,
        suppressionReason: "inactive_prerequisite_node",
        resolvedWeaponFamily: null,
        effectiveMasteryLevel,
      };
    }
  }

  if (params.character.level < params.definition.requiredCharacterLevel) {
    return {
      isEligible: false,
      suppressionReason: "insufficient_character_level",
      resolvedWeaponFamily: null,
      effectiveMasteryLevel,
    };
  }

  const intrinsic = computeIntrinsicCharacterAttributes(params.character);
  for (const key of PRIMARY_ATTRIBUTE_KEYS) {
    const req = params.definition.requiredAttributes[key];
    if (req !== undefined && intrinsic[key] < req) {
      return {
        isEligible: false,
        suppressionReason: "insufficient_attributes",
        resolvedWeaponFamily: null,
        effectiveMasteryLevel,
      };
    }
  }

  if (effectiveMasteryLevel < params.definition.requiredMasteryLevel) {
    return {
      isEligible: false,
      suppressionReason: "insufficient_weapon_mastery",
      resolvedWeaponFamily: null,
      effectiveMasteryLevel,
    };
  }

  // Evaluate weapon compatibility & durability on main_hand / off_hand
  const handEntries = params.equippedHandItems.filter(
    (e) => e.slotCode === "main_hand" || e.slotCode === "off_hand",
  );
  const mainHandOccupied = handEntries.some((e) => e.slotCode === "main_hand");

  const usableFamilies: MasteryWeaponFamilyCode[] = [];
  const brokenFamilies = new Set<string>();

  if (!mainHandOccupied) {
    usableFamilies.push("unarmed");
  }

  for (const entry of handEntries) {
    const subcat = entry.definition.subcategory;
    if (!MASTERY_WEAPON_FAMILY_SET.has(subcat)) {
      continue;
    }
    const itemElig = checkIntrinsicCharacterEligibility(
      params.character,
      entry.definition,
      entry.instance,
    );
    if (itemElig.eligible) {
      usableFamilies.push(subcat as MasteryWeaponFamilyCode);
    } else if (entry.instance.currentDurability === 0) {
      brokenFamilies.add(subcat);
    }
  }

  if (params.definition.requiredWeaponFamilies.length === 0) {
    return {
      isEligible: true,
      suppressionReason: null,
      resolvedWeaponFamily: usableFamilies[0] ?? null,
      effectiveMasteryLevel,
    };
  }

  const matchedFamily = params.definition.requiredWeaponFamilies.find((reqFam) =>
    usableFamilies.includes(reqFam),
  );
  if (matchedFamily) {
    const specificMastery = params.masteryMap.get(matchedFamily)?.masteryLevel ?? 1;
    return {
      isEligible: true,
      suppressionReason: null,
      resolvedWeaponFamily: matchedFamily,
      effectiveMasteryLevel: Math.max(specificMastery, effectiveMasteryLevel),
    };
  }

  const failedDueToBrokenWeapon = params.definition.requiredWeaponFamilies.some((reqFam) =>
    brokenFamilies.has(reqFam),
  );
  if (failedDueToBrokenWeapon) {
    return {
      isEligible: false,
      suppressionReason: "equipped_weapon_broken",
      resolvedWeaponFamily: null,
      effectiveMasteryLevel,
    };
  }

  return {
    isEligible: false,
    suppressionReason: "incompatible_equipped_weapon",
    resolvedWeaponFamily: null,
    effectiveMasteryLevel,
  };
}

export interface DesiredAbilitySlotInput {
  readonly slotIndex: number;
  readonly abilityCode: string;
}

export interface ValidatedAbilityLoadoutSummary {
  readonly orderedSlots: ReadonlyArray<{
    readonly slotIndex: number;
    readonly abilityCode: string;
    readonly slotGroup: AbilitySlotGroup;
    readonly equipmentCost: number;
  }>;
  readonly activeCount: number;
  readonly passiveCount: number;
  readonly ultimateCount: number;
  readonly totalEquipmentCost: number;
}

export function validateAbilityLoadoutConfiguration(params: {
  readonly assignments: ReadonlyArray<DesiredAbilitySlotInput>;
  readonly learnedByCode: ReadonlyMap<string, CharacterLearnedAbility>;
  readonly definitionsByCode: ReadonlyMap<string, AbilityDefinition>;
  readonly rules: MasteryAndSkillRulesConfig;
}): ValidatedAbilityLoadoutSummary {
  const seenSlots = new Set<number>();
  const seenAbilities = new Set<string>();
  const seenExclusiveGroups = new Map<string, string>();

  let activeCount = 0;
  let passiveCount = 0;
  let ultimateCount = 0;
  let totalEquipmentCost = 0;

  const validated: Array<{
    readonly slotIndex: number;
    readonly abilityCode: string;
    readonly slotGroup: AbilitySlotGroup;
    readonly equipmentCost: number;
  }> = [];

  for (const item of params.assignments) {
    if (!Number.isInteger(item.slotIndex) || item.slotIndex < 0 || item.slotIndex > 31) {
      throw new AbilityLoadoutInvalidError(
        `Ability slotIndex (${item.slotIndex}) must be an integer within wire contract bounds 0..31.`,
      );
    }
    if (seenSlots.has(item.slotIndex)) {
      throw new AbilityLoadoutInvalidError(
        `Ability slot ${item.slotIndex} is already occupied in this loadout.`,
      );
    }
    if (seenAbilities.has(item.abilityCode)) {
      throw new AbilityLoadoutInvalidError(
        `Ability '${item.abilityCode}' cannot be equipped in multiple slots simultaneously.`,
      );
    }
    seenSlots.add(item.slotIndex);
    seenAbilities.add(item.abilityCode);

    const learned = params.learnedByCode.get(item.abilityCode);
    if (!learned) {
      throw new AbilityLoadoutInvalidError(
        `Cannot equip unlearned ability '${item.abilityCode}'.`,
      );
    }
    if (!learned.isActive) {
      throw new AbilityLoadoutInvalidError(
        `Cannot equip ability '${item.abilityCode}': inactive after specialization reset.`,
      );
    }

    const def = params.definitionsByCode.get(item.abilityCode);
    if (!def || !def.isEnabled) {
      throw new AbilityLoadoutInvalidError(
        `Ability definition '${item.abilityCode}' is missing or disabled.`,
      );
    }

    if (def.exclusiveGroup !== null) {
      const prior = seenExclusiveGroups.get(def.exclusiveGroup);
      if (prior) {
        throw new AbilityLoadoutInvalidError(
          `Cannot equip '${def.abilityCode}' alongside '${prior}': mutually exclusive group '${def.exclusiveGroup}'.`,
        );
      }
      seenExclusiveGroups.set(def.exclusiveGroup, def.abilityCode);
    }

    if (def.slotGroup === "active") {
      activeCount++;
      if (activeCount > params.rules.maxActiveAbilitySlots) {
        throw new AbilityLoadoutInvalidError(
          `Active ability slot limit exceeded (${activeCount}/${params.rules.maxActiveAbilitySlots}).`,
        );
      }
    } else if (def.slotGroup === "passive") {
      passiveCount++;
      if (passiveCount > params.rules.maxPassiveAbilitySlots) {
        throw new AbilityLoadoutInvalidError(
          `Passive ability slot limit exceeded (${passiveCount}/${params.rules.maxPassiveAbilitySlots}).`,
        );
      }
    } else {
      ultimateCount++;
      if (ultimateCount > params.rules.maxUltimateAbilitySlots) {
        throw new AbilityLoadoutInvalidError(
          `Ultimate/Super ability slot limit exceeded (${ultimateCount}/${params.rules.maxUltimateAbilitySlots}).`,
        );
      }
    }

    totalEquipmentCost += def.equipmentCost;
    if (totalEquipmentCost > params.rules.maxBuildEquipmentCost) {
      throw new AbilityLoadoutInvalidError(
        `Build equipment budget exceeded (${totalEquipmentCost}/${params.rules.maxBuildEquipmentCost}) when equipping '${def.abilityCode}'.`,
      );
    }

    validated.push({
      slotIndex: item.slotIndex,
      abilityCode: def.abilityCode,
      slotGroup: def.slotGroup,
      equipmentCost: def.equipmentCost,
    });
  }

  if (validated.length > params.rules.maxTotalEquippedSlots) {
    throw new AbilityLoadoutInvalidError(
      `Total equipped abilities (${validated.length}) exceeds maxTotalEquippedSlots (${params.rules.maxTotalEquippedSlots}).`,
    );
  }

  validated.sort((a, b) => a.slotIndex - b.slotIndex);

  return {
    orderedSlots: validated,
    activeCount,
    passiveCount,
    ultimateCount,
    totalEquipmentCost,
  };
}
