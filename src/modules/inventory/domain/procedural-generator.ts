import {
  PRIMARY_ATTRIBUTE_KEYS,
  type AttributeBlock,
  type PrimaryAttributeKey,
} from "../../peoples/domain/character-snapshot-proposal.js";
import { createZeroAttributeBlock } from "../../characters/domain/attributes-and-presets.js";
import { ItemDefinitionInvalidError, ItemGenerationInvalidError } from "./errors.js";
import type {
  AffixDefinition,
  ItemDefinition,
  ItemGenerationRulesConfig,
  ItemRarityCode,
  RarityDefinition,
  RolledItemAffix,
} from "./item-types.js";
import { SplitMix64Rng } from "./splitmix64-rng.js";

const BASIS_POINTS_SCALE = 10000n;

export interface GenerateProceduralItemInput {
  readonly definition: ItemDefinition;
  readonly rarity: RarityDefinition;
  readonly rules: ItemGenerationRulesConfig;
  readonly candidateAffixes: ReadonlyArray<AffixDefinition>;
  readonly itemLevel: number;
  readonly serverSeed: string;
  readonly originReference: string;
  readonly qualityBpOverride?: number | undefined;
}

export interface GeneratedProceduralItemProperties {
  readonly itemLevel: number;
  readonly rarityCode: ItemRarityCode;
  readonly qualityBp: number;
  readonly powerBudgetTotal: number;
  readonly powerBudgetSpent: number;
  readonly implicitAttributes: AttributeBlock;
  readonly generatedAttributes: AttributeBlock;
  readonly affixes: ReadonlyArray<RolledItemAffix>;
  readonly maxDurability: number | null;
  readonly currentDurability: number | null;
  readonly generationSeedHash: string;
}

export function materializePartialAttributeBlock(
  partial: Partial<Record<PrimaryAttributeKey, number>>,
): AttributeBlock {
  const block: Record<PrimaryAttributeKey, number> = {
    strength: 0,
    fortitude: 0,
    vigor: 0,
    agility: 0,
    dexterity: 0,
    intelligence: 0,
    wisdom: 0,
    determination: 0,
    luck: 0,
    charisma: 0,
  };
  for (const key of PRIMARY_ATTRIBUTE_KEYS) {
    const val = partial[key];
    if (val !== undefined) {
      if (!Number.isInteger(val) || val < 0) {
        throw new ItemDefinitionInvalidError(
          `Invalid attribute value '${String(val)}' for '${key}'.`,
        );
      }
      block[key] = val;
    }
  }
  return block;
}

/**
 * Pure, deterministic, integer-only procedural item generator.
 * Same `(definition, rarity, rules, candidateAffixes, itemLevel, serverSeed, originReference)`
 * ALWAYS produces bit-identical quality, affixes, magnitudes, and power budget expenditure.
 */
export function generateProceduralItemProperties(
  input: GenerateProceduralItemInput,
): GeneratedProceduralItemProperties {
  const { definition, rarity, rules } = input;

  if (!definition.isEnabled) {
    throw new ItemGenerationInvalidError(
      `Item definition '${definition.definitionCode}' is disabled.`,
    );
  }
  if (definition.stackable) {
    throw new ItemGenerationInvalidError(
      `Stackable item '${definition.definitionCode}' cannot be generated as a unique procedural ItemInstance.`,
    );
  }
  if (!Number.isInteger(input.itemLevel) || input.itemLevel < 1 || input.itemLevel > 1000) {
    throw new ItemGenerationInvalidError(
      `Invalid itemLevel '${String(input.itemLevel)}'; expected integer in 1..1000.`,
    );
  }
  if (!definition.allowedRarities.includes(rarity.rarityCode)) {
    throw new ItemGenerationInvalidError(
      `Rarity '${rarity.rarityCode}' is not permitted for item '${definition.definitionCode}'.`,
    );
  }
  if (!input.serverSeed.trim()) {
    throw new ItemGenerationInvalidError("Server generation seed cannot be blank.");
  }
  if (!input.originReference.trim()) {
    throw new ItemGenerationInvalidError("originReference cannot be blank.");
  }

  // Validate all candidate affix weights up front (reject zero or negative weights)
  for (const affix of input.candidateAffixes) {
    if (!Number.isInteger(affix.weight) || affix.weight <= 0) {
      throw new ItemGenerationInvalidError(
        `Affix '${affix.affixCode}' has invalid non-positive weight ${String(affix.weight)}.`,
      );
    }
    if (affix.maxModifier < affix.minModifier || affix.minModifier < 0) {
      throw new ItemGenerationInvalidError(
        `Affix '${affix.affixCode}' has invalid modifier bounds [${affix.minModifier}, ${affix.maxModifier}].`,
      );
    }
    if (affix.powerBudgetCost < 0) {
      throw new ItemGenerationInvalidError(
        `Affix '${affix.affixCode}' has negative powerBudgetCost ${affix.powerBudgetCost}.`,
      );
    }
  }

  const canonicalSeedMaterial = [
    "ascendra:itemgen:v1",
    definition.definitionCode,
    String(definition.definitionVersion),
    String(rules.rulesVersion),
    String(input.itemLevel),
    rarity.rarityCode,
    input.originReference.trim(),
    input.serverSeed.trim(),
  ].join("|");

  const rng = new SplitMix64Rng(canonicalSeedMaterial);

  let qualityBp: number;
  if (input.qualityBpOverride !== undefined) {
    if (
      !Number.isInteger(input.qualityBpOverride) ||
      input.qualityBpOverride < 0 ||
      input.qualityBpOverride > 10000
    ) {
      throw new ItemGenerationInvalidError(
        `Invalid qualityBpOverride '${String(input.qualityBpOverride)}'; expected 0..10000 basis points.`,
      );
    }
    qualityBp = input.qualityBpOverride;
  } else {
    qualityBp = rng.nextIntInclusive(rarity.minQualityBp, rarity.maxQualityBp);
  }

  // Integer fixed-point power budget calculation (zero floats!)
  const rawBaseBudget =
    BigInt(definition.basePowerBudget) +
    BigInt(input.itemLevel) * BigInt(rules.levelBudgetPerItemLevel);
  const rarityScaledBudget =
    (rawBaseBudget * BigInt(rarity.powerBudgetMultiplierBp)) / BASIS_POINTS_SCALE;
  const qualityBonusBp =
    (BigInt(qualityBp) * BigInt(rules.qualityBonusMaxBp)) / BASIS_POINTS_SCALE;
  const totalBudgetBig =
    (rarityScaledBudget * (BASIS_POINTS_SCALE + qualityBonusBp)) / BASIS_POINTS_SCALE;
  const powerBudgetTotal = Number(totalBudgetBig);

  // Canonical sort of candidate affixes so input slice ordering never changes RNG selection
  const allowedPoolSet = new Set(definition.allowedAffixPools);
  const baseEligiblePool = input.candidateAffixes
    .filter(
      (a) =>
        a.isEnabled &&
        allowedPoolSet.has(a.poolCode) &&
        a.allowedCategories.includes(definition.category) &&
        input.itemLevel >= a.minItemLevel &&
        a.allowedRarities.includes(rarity.rarityCode),
    )
    .slice()
    .sort((a, b) =>
      a.affixCode !== b.affixCode
        ? a.affixCode < b.affixCode
          ? -1
          : 1
        : a.affixVersion - b.affixVersion,
    );

  // Non-combat instances (e.g. cosmetic_only cloaks or quest items) never roll combat affixes
  const isNonCombatInstance =
    definition.equipSlotPolicy === "cosmetic_only" || definition.equipSlotPolicy === "none";

  const targetAffixCount = isNonCombatInstance
    ? 0
    : rng.nextIntInclusive(rarity.minExplicitAffixes, rarity.maxExplicitAffixes);

  const usedAffixCodes = new Set<string>();
  const usedExclusiveGroups = new Set<string>();
  let prefixCount = 0;
  let suffixCount = 0;
  let specialCount = 0;
  let powerBudgetSpent = 0;
  const rolledAffixes: RolledItemAffix[] = [];

  // Strictly bounded loop (`<= targetAffixCount` steps) — impossible to loop infinitely
  for (let step = 0; step < targetAffixCount; step++) {
    const remainingBudget = powerBudgetTotal - powerBudgetSpent;
    const stepCandidates = baseEligiblePool.filter((cand) => {
      if (usedAffixCodes.has(cand.affixCode)) {
        return false;
      }
      if (usedExclusiveGroups.has(cand.exclusiveGroup)) {
        return false;
      }
      if (cand.powerBudgetCost > remainingBudget) {
        return false;
      }
      if (cand.affixKind === "prefix" && prefixCount >= rules.maxPrefixes) {
        return false;
      }
      if (cand.affixKind === "suffix" && suffixCount >= rules.maxSuffixes) {
        return false;
      }
      if (cand.affixKind === "special_effect") {
        if (!rarity.allowsSpecialEffects || specialCount >= rules.maxSpecialEffects) {
          return false;
        }
      }
      return true;
    });

    if (stepCandidates.length === 0) {
      break;
    }

    let totalWeight = 0;
    for (const c of stepCandidates) {
      totalWeight += c.weight;
    }

    const ticket = rng.nextIntInclusive(1, totalWeight);
    let cumulative = 0;
    let chosen: AffixDefinition = stepCandidates[stepCandidates.length - 1]!;
    for (const c of stepCandidates) {
      cumulative += c.weight;
      if (ticket <= cumulative) {
        chosen = c;
        break;
      }
    }

    // Roll magnitude within [minModifier, maxModifier]:
    // 50% random roll + 50% qualityBp contribution, strictly clamped inside [minModifier, maxModifier]!
    let rolledMagnitude = 0;
    if (chosen.affixKind !== "special_effect") {
      const span = chosen.maxModifier - chosen.minModifier;
      if (span === 0) {
        rolledMagnitude = chosen.minModifier;
      } else {
        const rngBp = rng.nextIntInclusive(0, 10000);
        const blendedBp = Math.floor((rngBp + qualityBp) / 2);
        const offset = Math.floor((span * blendedBp) / 10000);
        rolledMagnitude = Math.min(
          chosen.maxModifier,
          Math.max(chosen.minModifier, chosen.minModifier + offset),
        );
      }
    }

    usedAffixCodes.add(chosen.affixCode);
    usedExclusiveGroups.add(chosen.exclusiveGroup);
    if (chosen.affixKind === "prefix") {
      prefixCount++;
    } else if (chosen.affixKind === "suffix") {
      suffixCount++;
    } else {
      specialCount++;
    }
    powerBudgetSpent += chosen.powerBudgetCost;

    rolledAffixes.push({
      affixCode: chosen.affixCode,
      affixVersion: chosen.affixVersion,
      affixKind: chosen.affixKind,
      exclusiveGroup: chosen.exclusiveGroup,
      rolledMagnitude,
      attributeKey: chosen.attributeKey,
      specialEffectCode: chosen.specialEffectCode,
      specialEffectParams: chosen.specialEffectParams,
      powerBudgetCost: chosen.powerBudgetCost,
      slotOrdinal: rolledAffixes.length,
    });
  }

  if (
    !isNonCombatInstance &&
    rolledAffixes.length < rarity.minExplicitAffixes &&
    rules.emptyPoolPolicy === "reject_if_below_min"
  ) {
    throw new ItemGenerationInvalidError(
      `Insufficient compatible affixes in pool for '${definition.definitionCode}' (${rarity.rarityCode}): required >= ${rarity.minExplicitAffixes}, rolled ${rolledAffixes.length}.`,
    );
  }

  const implicitAttributes = materializePartialAttributeBlock(definition.implicitModifiers);
  const generatedMutable: Record<PrimaryAttributeKey, number> = {
    ...createZeroAttributeBlock(),
  };
  for (const rolled of rolledAffixes) {
    if (rolled.attributeKey !== null) {
      generatedMutable[rolled.attributeKey] += rolled.rolledMagnitude;
    }
  }

  return {
    itemLevel: input.itemLevel,
    rarityCode: rarity.rarityCode,
    qualityBp,
    powerBudgetTotal,
    powerBudgetSpent,
    implicitAttributes,
    generatedAttributes: generatedMutable,
    affixes: rolledAffixes,
    maxDurability: definition.maxDurability,
    currentDurability: definition.maxDurability,
    generationSeedHash: rng.seedHashHex,
  };
}
