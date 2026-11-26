import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BUILD_ARCHETYPE_PRESETS,
  DEFAULT_DEV_PROGRESSION_RULES_V1,
  applyAndValidateAttributeAllocation,
  createUniformAttributeBlock,
  createZeroAttributeBlock,
  parseStrictAttributeDeltaObject,
  sumAttributeBlock,
} from "../../src/modules/characters/domain/attributes-and-presets.js";
import {
  AttributeAllocationInvalidError,
  CharacterNameInvalidError,
  CharacterNameReservedError,
  ExperienceGrantInvalidError,
} from "../../src/modules/characters/domain/errors.js";
import { validateAndNormalizeCharacterName } from "../../src/modules/characters/domain/naming.js";
import {
  evaluateExperienceAdvancement,
  requiredTotalExperienceForLevel,
  resolveLevelForExperience,
} from "../../src/modules/characters/domain/progression.js";
import { runProgressionSimulationHarness } from "../../src/modules/characters/simulation/progression-simulator.js";
import {
  INITIAL_BACKGROUNDS_CATALOG,
  INITIAL_CULTURES_CATALOG,
  INITIAL_LINEAGES_CATALOG,
  INITIAL_PEOPLES_CATALOG,
} from "../../src/modules/peoples/catalog/initial-peoples-catalog.js";
import {
  IncompatibleAppearanceError,
  validateCharacterAppearance,
} from "../../src/modules/peoples/domain/appearance.js";
import { PRIMARY_ATTRIBUTE_KEYS } from "../../src/modules/peoples/domain/character-snapshot-proposal.js";
import { MAX_INT64 } from "../../src/shared/contracts/int64-wire.js";

describe("CARBON Session 03 — Pure Domain Unit Tests & Progression Simulation", () => {
  it("Catalog completeness: defines 26 planned peoples (6 enabled with equal standard_100 budget), compatible lineages, cultures, and 10 backgrounds", () => {
    assert.equal(INITIAL_PEOPLES_CATALOG.length, 26);
    const enabled = INITIAL_PEOPLES_CATALOG.filter((p) => p.isEnabled);
    assert.deepEqual(
      enabled.map((p) => p.raceCode).sort(),
      ["draconians", "dwarves", "elves", "goblins", "humans", "orcs"],
    );
    for (const p of enabled) {
      assert.equal(p.attributeBudgetProfile, "standard_100");
    }

    const raceCodes = new Set(INITIAL_PEOPLES_CATALOG.map((p) => p.raceCode));
    assert.equal(raceCodes.size, 26);
    for (const lin of INITIAL_LINEAGES_CATALOG) {
      assert.equal(raceCodes.has(lin.raceCode), true);
    }
    assert.equal(INITIAL_BACKGROUNDS_CATALOG.length, 10);
    assert.ok(INITIAL_CULTURES_CATALOG.length >= 6);
  });

  it("Character naming: normalizes NFC/NFKD, strips accents for canonical comparison, and blocks control/invisible/reserved/impersonation names", () => {
    const n1 = validateAndNormalizeCharacterName("Zîg O'Brien");
    const n2 = validateAndNormalizeCharacterName("zig o'brien");
    assert.equal(n1.displayName, "Zîg O'Brien");
    assert.equal(n1.canonicalName, "zig o'brien");
    assert.equal(n1.canonicalName, n2.canonicalName);

    // Invalid inputs
    for (const bad of [
      "",
      "   ",
      "ab", // < 3
      "A".repeat(25), // > 24
      " LeadingSpace",
      "TrailingSpace ",
      "Double  Space",
      "Zero\u200BWidth",
      "Ctrl\u0007Char",
      "Kael123",
      "<script>alert</script>",
    ]) {
      assert.throws(() => validateAndNormalizeCharacterName(bad), CharacterNameInvalidError);
    }

    // Reserved / admin impersonation
    for (const reserved of ["Admin", "GM Kael", "Dev-Luan", "Ascendra", "Moderator"]) {
      assert.throws(() => validateAndNormalizeCharacterName(reserved), CharacterNameReservedError);
    }
  });

  it("Appearance validation: enforces people customization profiles and blocks URLs/paths/HTML", () => {
    const humanProfile = INITIAL_PEOPLES_CATALOG.find((p) => p.raceCode === "humans")!
      .customizationProfile;
    const draconianProfile = INITIAL_PEOPLES_CATALOG.find((p) => p.raceCode === "draconians")!
      .customizationProfile;

    const validDraconian = validateCharacterAppearance(
      {
        bodyPreset: "scaled_athletic_a",
        skinTone: "ember_red",
        eyeStyle: "slit_draconic",
        eyeColor: "amber_gold",
        hornStyle: "swept_crown",
        tailStyle: "plated_long",
        scalePattern: "diamond_plates",
      },
      draconianProfile,
    );
    assert.equal(validDraconian.scalePattern, "diamond_plates");

    // Human cannot equip horns or scales
    assert.throws(
      () =>
        validateCharacterAppearance(
          {
            bodyPreset: "athletic_a",
            skinTone: "warm_ivory",
            eyeStyle: "almond_sharp",
            eyeColor: "slate_blue",
            hornStyle: "swept_crown",
          },
          humanProfile,
        ),
      IncompatibleAppearanceError,
    );

    // Draconian requires scalePattern and forbids beardStyle
    assert.throws(
      () =>
        validateCharacterAppearance(
          {
            bodyPreset: "scaled_athletic_a",
            skinTone: "ember_red",
            eyeStyle: "slit_draconic",
            eyeColor: "amber_gold",
            beardStyle: "full_trimmed",
          },
          draconianProfile,
        ),
      IncompatibleAppearanceError,
    );

    // Malicious URL/path injection in cosmetic slot rejected
    assert.throws(
      () =>
        validateCharacterAppearance(
          {
            bodyPreset: "https://evil.example/sprite.png",
            skinTone: "../etc/passwd",
            eyeStyle: "almond_sharp",
            eyeColor: "slate_blue",
          },
          humanProfile,
        ),
      IncompatibleAppearanceError,
    );
  });

  it("Ten attributes, presets, and progression simulation: enforces 50+50=100 creation budget, 30 cap, and exact BigInt XP curve", () => {
    assert.equal(PRIMARY_ATTRIBUTE_KEYS.length, 10);

    // Reject unknown attribute, negative, fractional
    assert.throws(
      () => parseStrictAttributeDeltaObject({ laser_eyes: 5 }, true),
      AttributeAllocationInvalidError,
    );
    assert.throws(
      () => parseStrictAttributeDeltaObject({ strength: -1 }, true),
      AttributeAllocationInvalidError,
    );
    assert.throws(
      () => parseStrictAttributeDeltaObject({ strength: 2.5 }, true),
      AttributeAllocationInvalidError,
    );

    // Verify all 9 presets respect the exact 50-point creation budget and <= 30 effective cap
    const base = createUniformAttributeBlock(5);
    const zero = createZeroAttributeBlock();
    for (const preset of Object.values(BUILD_ARCHETYPE_PRESETS)) {
      assert.equal(sumAttributeBlock(preset.allocatedAttributes), 50);
      const res = applyAndValidateAttributeAllocation({
        baseAttributes: base,
        currentAllocated: zero,
        deltaToAdd: preset.allocatedAttributes,
        currentUnspentPoints: 50,
        earnedAttributePoints: 50,
        rules: DEFAULT_DEV_PROGRESSION_RULES_V1,
      });
      assert.equal(res.nextUnspentPoints, 0);
    }

    // Progression boundaries & overflow
    assert.equal(requiredTotalExperienceForLevel(1, DEFAULT_DEV_PROGRESSION_RULES_V1), 0n);
    const lv100Xp = requiredTotalExperienceForLevel(100, DEFAULT_DEV_PROGRESSION_RULES_V1);
    assert.equal(lv100Xp, 740025n);
    assert.equal(resolveLevelForExperience(lv100Xp, DEFAULT_DEV_PROGRESSION_RULES_V1), 100);
    assert.equal(
      resolveLevelForExperience(lv100Xp + 5000000n, DEFAULT_DEV_PROGRESSION_RULES_V1),
      100,
    );

    assert.throws(
      () =>
        evaluateExperienceAdvancement({
          currentExperienceTotal: MAX_INT64 - 10n,
          currentLevel: 100,
          currentEarnedPoints: 248,
          currentAllocatedPoints: 50,
          currentUnspentPoints: 198,
          validatedGrantAmount: 11n,
          rules: DEFAULT_DEV_PROGRESSION_RULES_V1,
        }),
      ExperienceGrantInvalidError,
    );

    // Simulation harness verifies rate=2 never saturates cap (null) whereas rate=3 saturates at Lv 68
    const sim = runProgressionSimulationHarness();
    assert.equal(sim.fullCurve.length, 100);
    assert.equal(sim.capSaturationLevel, null);
    const rate3 = sim.pointsPerLevelRateComparison.find((r) => r.pointsPerLevel === 3);
    assert.equal(rate3?.capSaturationLevel, 68);
  });
});
