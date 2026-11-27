import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import {
  createUniformAttributeBlock,
  createZeroAttributeBlock,
} from "../../src/modules/characters/domain/attributes-and-presets.js";
import { Character } from "../../src/modules/characters/domain/character.js";
import {
  DEFAULT_ITEM_GENERATION_RULES_V1,
  INITIAL_AFFIXES_CATALOG,
  INITIAL_ITEM_DEFINITIONS_CATALOG,
  INITIAL_RARITIES_CATALOG,
} from "../../src/modules/inventory/catalog/initial-item-catalog.js";
import {
  ItemDefinitionInvalidError,
  ItemGenerationInvalidError,
} from "../../src/modules/inventory/domain/errors.js";
import {
  checkIntrinsicCharacterEligibility,
  computeActiveEquipmentModifiers,
  validateItemDefinition,
} from "../../src/modules/inventory/domain/equipment-and-stack-rules.js";
import {
  ITEM_CATEGORIES,
  WEAPON_SUBCATEGORIES,
  type AffixDefinition,
  type ItemDefinition,
  type ItemInstance,
} from "../../src/modules/inventory/domain/item-types.js";
import { generateProceduralItemProperties } from "../../src/modules/inventory/domain/procedural-generator.js";
import { runStandardSession04Simulations } from "../../src/modules/inventory/simulation/procedural-item-simulator.js";

function makeTestCharacter(params: {
  readonly level: number;
  readonly baseStrength: number;
  readonly allocatedStrength: number;
}): Character {
  const base = { ...createUniformAttributeBlock(10), strength: params.baseStrength };
  const alloc = { ...createZeroAttributeBlock(), strength: params.allocatedStrength };
  const now = new Date("2026-11-27T00:00:00Z");
  return new Character({
    id: randomUUID(),
    accountId: randomUUID(),
    displayName: "Teste Intrínseco",
    canonicalName: "teste intrínseco",
    raceCode: "humans",
    lineageCode: "human_ashvale",
    cultureCode: "valewatch_civic",
    backgroundCode: "border_guard",
    originRegionId: "region-ashvale",
    hometownSettlementRef: null,
    rulesVersion: 1,
    level: params.level,
    experienceTotal: 0n,
    earnedAttributePoints: 50,
    allocatedAttributePoints: params.allocatedStrength,
    unspentAttributePoints: 50 - params.allocatedStrength,
    baseAttributes: base,
    allocatedAttributes: alloc,
    appearance: {
      appearanceCatalogVersion: 1,
      bodyPreset: "athletic_medium_a",
      skinTone: "warm_bronze",
      hairStyle: "short_cropped",
      hairColor: "raven_black",
      eyeStyle: "almond_sharp",
      eyeColor: "slate_blue",
      facialFeatures: null,
      beardStyle: null,
      earStyle: null,
      hornStyle: null,
      tailStyle: null,
      scalePattern: null,
      tattoos: [],
      scars: [],
      cosmeticAccessories: [],
      voiceProfile: null,
    },
    appearanceVersion: 1,
    buildVersion: 1,
    snapshotVersion: 1,
    status: "active",
    competitiveLockState: "none",
    createdAt: now,
    updatedAt: now,
  });
}

describe("CARBON Session 04 — Unit: Item Definitions, Procedural Generation, Anti-Circularity & Statistical Simulation", () => {
  it("Scenarios 1 & 2: Validates all 20 initial definitions, 9 categories, 22 weapon families, structural constraints, and definition versioning", () => {
    assert.equal(ITEM_CATEGORIES.length, 9);
    assert.equal(WEAPON_SUBCATEGORIES.length, 22);
    assert.equal(INITIAL_ITEM_DEFINITIONS_CATALOG.length, 20);

    for (const def of INITIAL_ITEM_DEFINITIONS_CATALOG) {
      assert.doesNotThrow(() => validateItemDefinition(def));
    }

    const baseSword = INITIAL_ITEM_DEFINITIONS_CATALOG.find(
      (d) => d.definitionCode === "ironfang_longsword",
    )!;

    // Reject stackable weapon with equipSlotPolicy != 'none' or durability
    assert.throws(
      () =>
        validateItemDefinition({
          ...baseSword,
          stackable: true,
          maxStackSize: 10,
        }),
      ItemDefinitionInvalidError,
    );

    // Reject two-handed weapon declaring off_hand in allowedSlots
    assert.throws(
      () =>
        validateItemDefinition({
          ...baseSword,
          equipSlotPolicy: "two_handed",
          allowedSlots: ["main_hand", "off_hand"],
        }),
      ItemDefinitionInvalidError,
    );

    // Reject definitionVersion < 1
    assert.throws(
      () =>
        validateItemDefinition({
          ...baseSword,
          definitionVersion: 0,
        }),
      ItemDefinitionInvalidError,
    );

    // Versioning: v1 vs v2 of same definitionCode generate version-specific reproducible hashes
    const rare = INITIAL_RARITIES_CATALOG.find((r) => r.rarityCode === "rare")!;
    const v1Roll = generateProceduralItemProperties({
      definition: baseSword,
      rarity: rare,
      rules: DEFAULT_ITEM_GENERATION_RULES_V1,
      candidateAffixes: INITIAL_AFFIXES_CATALOG,
      itemLevel: 15,
      serverSeed: "version-seed-check",
      originReference: "drop:1",
    });
    const v2Roll = generateProceduralItemProperties({
      definition: { ...baseSword, definitionVersion: 2, basePowerBudget: 45 },
      rarity: rare,
      rules: DEFAULT_ITEM_GENERATION_RULES_V1,
      candidateAffixes: INITIAL_AFFIXES_CATALOG,
      itemLevel: 15,
      serverSeed: "version-seed-check",
      originReference: "drop:1",
    });
    assert.notEqual(v1Roll.generationSeedHash, v2Roll.generationSeedHash);
    assert.ok(v2Roll.powerBudgetTotal > v1Roll.powerBudgetTotal);
  });

  it("Scenarios 3 & 4: Generates distinct instances across seeds and bit-identical instances across repeated or shuffled-pool invocations", () => {
    const sword = INITIAL_ITEM_DEFINITIONS_CATALOG.find(
      (d) => d.definitionCode === "ironfang_longsword",
    )!;
    const legendary = INITIAL_RARITIES_CATALOG.find((r) => r.rarityCode === "legendary")!;

    const rollAlpha1 = generateProceduralItemProperties({
      definition: sword,
      rarity: legendary,
      rules: DEFAULT_ITEM_GENERATION_RULES_V1,
      candidateAffixes: INITIAL_AFFIXES_CATALOG,
      itemLevel: 25,
      serverSeed: "alpha-seed-001",
      originReference: "boss:ironfang",
    });

    // Reverse candidateAffixes slice order — canonical sort inside generator MUST keep result bit-identical!
    const reversedAffixes = INITIAL_AFFIXES_CATALOG.slice().reverse();
    const rollAlpha2 = generateProceduralItemProperties({
      definition: sword,
      rarity: legendary,
      rules: DEFAULT_ITEM_GENERATION_RULES_V1,
      candidateAffixes: reversedAffixes,
      itemLevel: 25,
      serverSeed: "alpha-seed-001",
      originReference: "boss:ironfang",
    });
    assert.deepEqual(rollAlpha1, rollAlpha2);

    const rollBeta = generateProceduralItemProperties({
      definition: sword,
      rarity: legendary,
      rules: DEFAULT_ITEM_GENERATION_RULES_V1,
      candidateAffixes: INITIAL_AFFIXES_CATALOG,
      itemLevel: 25,
      serverSeed: "beta-seed-002",
      originReference: "boss:ironfang",
    });
    assert.notEqual(rollAlpha1.generationSeedHash, rollBeta.generationSeedHash);
    assert.notDeepEqual(rollAlpha1.affixes, rollBeta.affixes);
  });

  it("Scenario 5: Enforces affix pool discipline (2H heavy axe never rolls arcane affixes; versatile sword supports arcane-knight builds; low rarities never roll special effects)", () => {
    const greataxe = INITIAL_ITEM_DEFINITIONS_CATALOG.find(
      (d) => d.definitionCode === "crimson_clan_greataxe",
    )!;
    const sword = INITIAL_ITEM_DEFINITIONS_CATALOG.find(
      (d) => d.definitionCode === "ironfang_longsword",
    )!;
    const epic = INITIAL_RARITIES_CATALOG.find((r) => r.rarityCode === "epic")!;
    const rare = INITIAL_RARITIES_CATALOG.find((r) => r.rarityCode === "rare")!;

    for (let i = 0; i < 300; i++) {
      const axeRoll = generateProceduralItemProperties({
        definition: greataxe,
        rarity: epic,
        rules: DEFAULT_ITEM_GENERATION_RULES_V1,
        candidateAffixes: INITIAL_AFFIXES_CATALOG,
        itemLevel: 25,
        serverSeed: `axe-pool-check:${i}`,
        originReference: "drop",
      });
      for (const af of axeRoll.affixes) {
        assert.notEqual(af.affixCode, "arcane_t1");
        assert.notEqual(af.affixCode, "of_wisdom_t1");
      }

      // Rare rarity has allowsSpecialEffects = false -> never rolls special_effect kind
      const rareSwordRoll = generateProceduralItemProperties({
        definition: sword,
        rarity: rare,
        rules: DEFAULT_ITEM_GENERATION_RULES_V1,
        candidateAffixes: INITIAL_AFFIXES_CATALOG,
        itemLevel: 25,
        serverSeed: `rare-no-special:${i}`,
        originReference: "drop",
      });
      for (const af of rareSwordRoll.affixes) {
        assert.notEqual(af.affixKind, "special_effect");
      }
    }

    // Confirm versatile Espada de Ironfang CAN roll arcane affixes for hybrid builds
    let sawArcaneSword = false;
    for (let i = 0; i < 150; i++) {
      const swordRoll = generateProceduralItemProperties({
        definition: sword,
        rarity: epic,
        rules: DEFAULT_ITEM_GENERATION_RULES_V1,
        candidateAffixes: INITIAL_AFFIXES_CATALOG,
        itemLevel: 25,
        serverSeed: `hybrid-sword:${i}`,
        originReference: "drop",
      });
      if (swordRoll.affixes.some((a) => a.affixCode === "arcane_t1" || a.affixCode === "of_wisdom_t1")) {
        sawArcaneSword = true;
        break;
      }
    }
    assert.equal(sawArcaneSword, true);
  });

  it("Scenarios 6, 7, 8, 9, 10, 11 & 12: Rejects invalid weights/rarity/quality, enforces power budget ceiling, blocks exclusive/duplicate affixes, and handles empty pools deterministically", () => {
    const sword = INITIAL_ITEM_DEFINITIONS_CATALOG.find(
      (d) => d.definitionCode === "ironfang_longsword",
    )!;
    const voidRing = INITIAL_ITEM_DEFINITIONS_CATALOG.find(
      (d) => d.definitionCode === "void_signet_ring",
    )!;
    const common = INITIAL_RARITIES_CATALOG.find((r) => r.rarityCode === "common")!;
    const rare = INITIAL_RARITIES_CATALOG.find((r) => r.rarityCode === "rare")!;
    const relic = INITIAL_RARITIES_CATALOG.find((r) => r.rarityCode === "relic")!;

    // #6 Zero and negative weights rejected
    const badWeightAffix: AffixDefinition = {
      ...INITIAL_AFFIXES_CATALOG[0]!,
      weight: 0,
    };
    assert.throws(
      () =>
        generateProceduralItemProperties({
          definition: sword,
          rarity: rare,
          rules: DEFAULT_ITEM_GENERATION_RULES_V1,
          candidateAffixes: [badWeightAffix],
          itemLevel: 10,
          serverSeed: "s1",
          originReference: "o1",
        }),
      ItemGenerationInvalidError,
    );
    assert.throws(
      () =>
        generateProceduralItemProperties({
          definition: sword,
          rarity: rare,
          rules: DEFAULT_ITEM_GENERATION_RULES_V1,
          candidateAffixes: [{ ...INITIAL_AFFIXES_CATALOG[0]!, weight: -10 }],
          itemLevel: 10,
          serverSeed: "s1",
          originReference: "o1",
        }),
      ItemGenerationInvalidError,
    );

    // #7 Invalid rarity for item (void_signet_ring forbids 'common')
    assert.throws(
      () =>
        generateProceduralItemProperties({
          definition: voidRing,
          rarity: common,
          rules: DEFAULT_ITEM_GENERATION_RULES_V1,
          candidateAffixes: INITIAL_AFFIXES_CATALOG,
          itemLevel: 20,
          serverSeed: "s2",
          originReference: "o2",
        }),
      ItemGenerationInvalidError,
    );

    // #8 Invalid qualityBpOverride (< 0, > 10000, float)
    for (const invalidQ of [-1, 10001, 5500.25]) {
      assert.throws(
        () =>
          generateProceduralItemProperties({
            definition: sword,
            rarity: rare,
            rules: DEFAULT_ITEM_GENERATION_RULES_V1,
            candidateAffixes: INITIAL_AFFIXES_CATALOG,
            itemLevel: 10,
            serverSeed: "s3",
            originReference: "o3",
            qualityBpOverride: invalidQ,
          }),
        ItemGenerationInvalidError,
      );
    }

    // #9 Power budget ceiling: tiny budget skips expensive affixes and never overspends
    const tightSword: ItemDefinition = { ...sword, basePowerBudget: 2 };
    const tightRules = {
      ...DEFAULT_ITEM_GENERATION_RULES_V1,
      levelBudgetPerItemLevel: 1,
      emptyPoolPolicy: "allow_fewer_affixes" as const,
    };
    const tightRoll = generateProceduralItemProperties({
      definition: tightSword,
      rarity: relic,
      rules: tightRules,
      candidateAffixes: INITIAL_AFFIXES_CATALOG,
      itemLevel: 2,
      serverSeed: "tight-budget",
      originReference: "o4",
    });
    assert.ok(tightRoll.powerBudgetSpent <= tightRoll.powerBudgetTotal);

    // #10 & #11 Exclusive group & duplicate affix prevention:
    // Pool containing ONLY titanic_t1 and titanic_t2 (both in exclusiveGroup 'attr_strength_prefix')
    const strengthOnlyPool = INITIAL_AFFIXES_CATALOG.filter(
      (a) => a.exclusiveGroup === "attr_strength_prefix",
    );
    assert.equal(strengthOnlyPool.length, 2);

    const exclusiveRoll = generateProceduralItemProperties({
      definition: sword,
      rarity: relic,
      rules: { ...DEFAULT_ITEM_GENERATION_RULES_V1, emptyPoolPolicy: "allow_fewer_affixes" },
      candidateAffixes: strengthOnlyPool,
      itemLevel: 25,
      serverSeed: "exclusive-check",
      originReference: "o5",
    });
    // Can pick at most 1 affix because both share exclusiveGroup 'attr_strength_prefix' and duplicates are forbidden!
    assert.equal(exclusiveRoll.affixes.length, 1);

    // #12 Empty pool with 'reject_if_below_min' throws; with 'allow_fewer_affixes' returns 0 affixes cleanly
    assert.throws(
      () =>
        generateProceduralItemProperties({
          definition: sword,
          rarity: rare, // minExplicitAffixes = 2
          rules: DEFAULT_ITEM_GENERATION_RULES_V1, // reject_if_below_min
          candidateAffixes: [],
          itemLevel: 10,
          serverSeed: "empty-pool",
          originReference: "o6",
        }),
      ItemGenerationInvalidError,
    );

    const allowedEmpty = generateProceduralItemProperties({
      definition: sword,
      rarity: rare,
      rules: { ...DEFAULT_ITEM_GENERATION_RULES_V1, emptyPoolPolicy: "allow_fewer_affixes" },
      candidateAffixes: [],
      itemLevel: 10,
      serverSeed: "empty-pool",
      originReference: "o6",
    });
    assert.equal(allowedEmpty.affixes.length, 0);
  });

  it("Scenario 30 & 35 (Domain): Prevents circular equipment self-buffing and suppresses broken (0 durability) equipment modifiers", () => {
    const greataxe = INITIAL_ITEM_DEFINITIONS_CATALOG.find(
      (d) => d.definitionCode === "crimson_clan_greataxe", // requires STR 18, Lv 3
    )!;
    const ringDef = INITIAL_ITEM_DEFINITIONS_CATALOG.find(
      (d) => d.definitionCode === "void_signet_ring",
    )!;

    // Character has intrinsic STR = 10 (base) + 5 (allocated) = 15 (< 18 required)
    const hero = makeTestCharacter({ level: 5, baseStrength: 10, allocatedStrength: 5 });

    const now = new Date();
    const strengthRingInstance: ItemInstance = {
      id: randomUUID(),
      definitionCode: ringDef.definitionCode,
      definitionVersion: 1,
      ownerAccountId: hero.accountId,
      ownerCharacterId: hero.id,
      locationState: "equipped_active",
      containerId: null,
      containerSlotIndex: null,
      itemLevel: 20,
      rarityCode: "epic",
      qualityBp: 8000,
      powerBudgetTotal: 80,
      powerBudgetSpent: 16,
      implicitAttributes: createZeroAttributeBlock(),
      generatedAttributes: { ...createZeroAttributeBlock(), strength: 10 }, // +10 STR from ring -> effective STR 25 >= 18!
      affixes: [],
      currentDurability: 80,
      maxDurability: 80,
      bindingState: "character_bound",
      boundAccountId: hero.accountId,
      boundCharacterId: hero.id,
      generationRulesVersion: 1,
      generationSeedHash: "abcd1234abcd1234",
      originType: "boss_drop",
      originReference: "b1",
      instanceVersion: 1,
      createdAt: now,
      updatedAt: now,
    };

    const axeInstance: ItemInstance = {
      ...strengthRingInstance,
      id: randomUUID(),
      definitionCode: greataxe.definitionCode,
      generatedAttributes: { ...createZeroAttributeBlock(), strength: 15 },
      currentDurability: 150,
      maxDurability: 150,
    };

    // Even with +10 STR ring equipped (effective 25), intrinsic STR is 15 < 18 -> greataxe MUST be ineligible!
    const elig = checkIntrinsicCharacterEligibility(hero, greataxe, axeInstance);
    assert.equal(elig.eligible, false);

    // If ring breaks (durability = 0), its +10 STR modifier is suppressed to 0!
    const brokenRing: ItemInstance = { ...strengthRingInstance, currentDurability: 0 };
    const mods = computeActiveEquipmentModifiers({
      character: hero,
      equippedEntries: [{ instance: brokenRing, definition: ringDef }],
      rules: DEFAULT_ITEM_GENERATION_RULES_V1,
    });
    assert.equal(mods.equipmentModifiers.strength, 0);
    assert.deepEqual(mods.suppressedInstanceIds, [brokenRing.id]);
  });

  it("Section 37: Executes statistical procedural generation simulations across 1,000, 10,000, and 100,000 samples with zero invariant violations", () => {
    const sim = runStandardSession04Simulations();

    assert.equal(sim.reproducible1kVerified, true);
    for (const batch of [sim.batch1k, sim.batch10k, sim.batch100k]) {
      assert.equal(batch.budgetViolations, 0);
      assert.equal(batch.duplicateAffixViolations, 0);
      assert.equal(batch.exclusiveGroupViolations, 0);
      assert.equal(batch.forbiddenPoolViolations, 0);
      assert.ok(batch.qualityStatsBp.min >= 1000);
      assert.ok(batch.qualityStatsBp.max <= 10000);
      assert.ok(batch.uniqueAffixCombinationCount >= 25);
    }

    // All 7 rarities represented in 100k sample
    for (const count of Object.values(sim.batch100k.rarityCounts)) {
      assert.ok(count > 0);
    }
  });
});
