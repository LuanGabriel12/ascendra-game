import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CharacterSnapshotWireV1Schema } from "../../src/modules/characters/application/character-snapshot-query.js";
import {
  DirectContributionSubmissionV1Schema,
  parseContributionWireJson,
} from "../../src/modules/contributions/contracts/contribution-contracts.js";
import { EquipmentSnapshotWireV1Schema } from "../../src/modules/inventory/application/equipment-snapshot-query.js";
import {
  DEFAULT_ITEM_GENERATION_RULES_V1,
  INITIAL_AFFIXES_CATALOG,
  INITIAL_ITEM_DEFINITIONS_CATALOG,
  INITIAL_RARITIES_CATALOG,
} from "../../src/modules/inventory/catalog/initial-item-catalog.js";
import { ItemGenerationInvalidError } from "../../src/modules/inventory/domain/errors.js";
import { generateProceduralItemProperties } from "../../src/modules/inventory/domain/procedural-generator.js";
import { SettlementSnapshotWireV1Schema } from "../../src/modules/settlements/application/settlement-snapshot-query.js";
import { AbilitySnapshotWireV1Schema } from "../../src/modules/skills/application/ability-snapshot-query.js";
import { SocialStandingSnapshotWireV1Schema } from "../../src/modules/social/application/social-snapshot-query.js";
import { TitleConditionInvalidError } from "../../src/modules/social/domain/errors.js";
import {
  validateTitleConditionAst,
  type TitleConditionNode,
} from "../../src/modules/titles/domain/title-contracts.js";
import {
  MAX_INT64,
  MAX_UINT64,
  MAX_WIRE_PAYLOAD_BYTES,
  MIN_INT64,
  decodeWireJsonLossless,
} from "../../src/shared/contracts/int64-wire.js";
import {
  validateAgainstJsonSchema,
  type JsonSchemaNode,
} from "../helpers/json-schema-assertion.js";
import { assertSafeTestDatabaseUrl } from "../helpers/postgres-test-harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = path.resolve(__dirname, "../../contracts/neon-carbon");

async function loadSchema(fileName: string): Promise<JsonSchemaNode> {
  const raw = await readFile(path.join(CONTRACTS_DIR, fileName), "utf8");
  return JSON.parse(raw) as JsonSchemaNode;
}

describe("CARBON Full Audit — Differential Contracts, Procedural 100k Scale & Static Guards", () => {
  it("[CARBON-AUD-008] enforces strict Zod <-> JSON Schema parity across all 6 NEON-CARBON v1 contracts on 64-bit integer bounds and malformed shapes", async () => {
    const settlementSchema = await loadSchema("settlement-snapshot.v1.schema.json");
    const contribSchema = await loadSchema("contribution-result.v1.schema.json");
    const charSchema = await loadSchema("character-snapshot.v1.schema.json");
    const equipSchema = await loadSchema("equipment-snapshot.v1.schema.json");
    const socialSchema = await loadSchema("social-standing-snapshot.v1.schema.json");
    const abilitySchema = await loadSchema("ability-snapshot.v1.schema.json");

    // 1. SettlementSnapshot: MAX_INT64 valid, MAX_INT64 + 1 invalid in BOTH
    const validSettlement = {
      contract_version: 1,
      settlement_id: "settlement-valewatch",
      region_id: "region-ashvale",
      defense_state: "Fortified",
      max_defense_hp: MAX_INT64.toString(),
      settlement_version: 3,
    };
    assert.equal(SettlementSnapshotWireV1Schema.safeParse(validSettlement).success, true);
    assert.equal(validateAgainstJsonSchema(settlementSchema, validSettlement).valid, true);

    for (const badHp of ["0", "-1", (MAX_INT64 + 1n).toString(), "9999999999999999999", "01", "10.5"]) {
      const candidate = { ...validSettlement, max_defense_hp: badHp };
      assert.equal(
        SettlementSnapshotWireV1Schema.safeParse(candidate).success,
        false,
        `Zod should reject settlement max_defense_hp=${badHp}`,
      );
      assert.equal(
        validateAgainstJsonSchema(settlementSchema, candidate).valid,
        false,
        `JSON Schema should reject settlement max_defense_hp=${badHp}`,
      );
    }

    // 2. ContributionResult: MAX_UINT64 tick & MAX_INT64 damage valid; +1 rejected in BOTH
    const validContrib = {
      contract_version: 1,
      event_id: "sim:01:inv:01:player:01",
      simulation_id: "sim-01",
      invasion_id: "inv-01",
      settlement_id: "settlement-valewatch",
      tick: MAX_UINT64.toString(),
      player_id: "player-01",
      damage: MAX_INT64.toString(),
      support: "0",
      objectives: 4,
      eligible: true,
      outcome: "Defended",
    };
    assert.equal(DirectContributionSubmissionV1Schema.safeParse(validContrib).success, true);
    assert.equal(validateAgainstJsonSchema(contribSchema, validContrib).valid, true);

    for (const badTick of [(MAX_UINT64 + 1n).toString(), "99999999999999999999", "-1", "00"]) {
      const cand = { ...validContrib, tick: badTick };
      assert.equal(DirectContributionSubmissionV1Schema.safeParse(cand).success, false);
      assert.equal(validateAgainstJsonSchema(contribSchema, cand).valid, false);
    }
    for (const badDamage of [(MAX_INT64 + 1n).toString(), "-5", "1e4"]) {
      const cand = { ...validContrib, damage: badDamage };
      assert.equal(DirectContributionSubmissionV1Schema.safeParse(cand).success, false);
      assert.equal(validateAgainstJsonSchema(contribSchema, cand).valid, false);
    }

    // 3. CharacterSnapshot & AbilitySnapshot & SocialSnapshot & EquipmentSnapshot parity
    const zeroAttrs = {
      strength: 10,
      fortitude: 10,
      vigor: 10,
      agility: 10,
      dexterity: 10,
      intelligence: 10,
      wisdom: 10,
      determination: 10,
      luck: 10,
      charisma: 10,
    };
    const charUuid = "11111111-1111-4111-8111-111111111111";

    const validCharSnap = {
      contract_version: 1,
      snapshot_version: 1,
      build_version: 1,
      character_id: charUuid,
      display_name: "Kaelen Vex",
      race_code: "humans",
      lineage_code: "human_valorian",
      culture_code: "valewatch_civic",
      background_code: "veteran_soldier",
      origin_region_id: "region-ashvale",
      rules_version: 1,
      level: 10,
      experience_total: MAX_INT64.toString(),
      earned_attribute_points: 30,
      allocated_attribute_points: 0,
      unspent_attribute_points: 30,
      base_attributes: zeroAttrs,
      allocated_attributes: zeroAttrs,
      equipped_items: [],
      equipped_abilities: [],
      normalization_profile: "open_world_persistent",
    };
    assert.equal(CharacterSnapshotWireV1Schema.safeParse(validCharSnap).success, true);
    assert.equal(validateAgainstJsonSchema(charSchema, validCharSnap).valid, true);

    const overflowCharSnap = { ...validCharSnap, experience_total: (MAX_INT64 + 1n).toString() };
    assert.equal(CharacterSnapshotWireV1Schema.safeParse(overflowCharSnap).success, false);
    assert.equal(validateAgainstJsonSchema(charSchema, overflowCharSnap).valid, false);

    // SocialStandingSnapshot: MIN_INT64 and MAX_INT64 accepted, outside rejected in BOTH
    const validSocialSnap = {
      contract_version: 1,
      projection_scope: "self_character",
      character_id: charUuid,
      display_name: "Kaelen Vex",
      social_version: 2,
      moral_band: "legendary_enemy",
      moral_bounty: MIN_INT64.toString(),
      global_fame: MAX_INT64.toString(),
      regional_fame: [
        {
          region_id: "region-ashvale",
          fame: "0",
          regional_moral_bounty: MAX_INT64.toString(),
        },
      ],
      faction_reputations: [],
      settlement_reputations: [],
      criminal_status_summary: [],
      active_warrant_summary: [],
      equipped_title: null,
      recognition_flags: [],
    };
    assert.equal(SocialStandingSnapshotWireV1Schema.safeParse(validSocialSnap).success, true);
    assert.equal(validateAgainstJsonSchema(socialSchema, validSocialSnap).valid, true);

    for (const badBounty of [(MIN_INT64 - 1n).toString(), (MAX_INT64 + 1n).toString(), "-0"]) {
      const cand = { ...validSocialSnap, moral_bounty: badBounty };
      assert.equal(SocialStandingSnapshotWireV1Schema.safeParse(cand).success, false);
      assert.equal(validateAgainstJsonSchema(socialSchema, cand).valid, false);
    }

    // EquipmentSnapshot: valid vs malformed specialEffects
    const validEquipSnap = {
      contractVersion: 1,
      characterId: charUuid,
      buildVersion: 2,
      snapshotVersion: 2,
      activeLoadoutId: "22222222-2222-4222-8222-222222222222",
      normalizationProfile: "open_world_persistent",
      equipmentModifiers: zeroAttrs,
      aggregatedEffectiveAttributes: zeroAttrs,
      equippedDetails: [
        {
          slotCode: "main_hand",
          occupiesOffHand: false,
          itemInstanceId: "33333333-3333-4333-8333-333333333333",
          definitionCode: "ironfang_longsword",
          definitionVersion: 1,
          itemLevel: 20,
          rarityCode: "mythic",
          qualityBp: 8000,
          currentDurability: 100,
          maxDurability: 100,
          isActiveForCombat: true,
          suppressionReason: null,
          implicitAttributes: zeroAttrs,
          generatedAttributes: zeroAttrs,
          specialEffects: [{ effectCode: "eff_bleed_edge_on_hit", params: { stacks: 1 } }],
        },
      ],
    };
    assert.equal(EquipmentSnapshotWireV1Schema.safeParse(validEquipSnap).success, true);
    assert.equal(validateAgainstJsonSchema(equipSchema, validEquipSnap).valid, true);

    const badEquipSnap = {
      ...validEquipSnap,
      equippedDetails: [
        {
          ...validEquipSnap.equippedDetails[0]!,
          specialEffects: ["garbage-untyped-effect"],
        },
      ],
    };
    assert.equal(EquipmentSnapshotWireV1Schema.safeParse(badEquipSnap).success, false);
    assert.equal(validateAgainstJsonSchema(equipSchema, badEquipSnap).valid, false);

    // AbilitySnapshot: valid vs mastery_experience overflow
    const validAbilitySnap = {
      contract_version: 1,
      character_id: charUuid,
      build_version: 1,
      snapshot_version: 1,
      active_loadout_id: null,
      rules_version: 1,
      normalization_profile: "legacy_ranked_md3",
      competitive_build_locked: true,
      specialization_budget: { earned_points: 6, spent_points: 0, unspent_points: 6 },
      build_budget: {
        used_equipment_cost: 0,
        max_equipment_cost: 12,
        active_slots_used: 0,
        max_active_slots: 4,
        passive_slots_used: 0,
        max_passive_slots: 2,
        ultimate_slots_used: 0,
        max_ultimate_slots: 1,
      },
      weapon_masteries: [
        {
          weapon_family_code: "longsword",
          mastery_experience: MAX_INT64.toString(),
          mastery_level: 100,
          proficiency_rank: "grandmaster",
        },
      ],
      equipped_abilities: [],
    };
    assert.equal(AbilitySnapshotWireV1Schema.safeParse(validAbilitySnap).success, true);
    assert.equal(validateAgainstJsonSchema(abilitySchema, validAbilitySnap).valid, true);

    const overflowAbilitySnap = {
      ...validAbilitySnap,
      weapon_masteries: [
        {
          ...validAbilitySnap.weapon_masteries[0]!,
          mastery_experience: (MAX_INT64 + 1n).toString(),
        },
      ],
    };
    assert.equal(AbilitySnapshotWireV1Schema.safeParse(overflowAbilitySnap).success, false);
    assert.equal(validateAgainstJsonSchema(abilitySchema, overflowAbilitySnap).valid, false);
  });

  it("Wire parser rejects oversized payloads (>64 KiB), fractional numbers, and duplicate keys on Contribution wire JSON", () => {
    const oversized = `{"event_id":"${"x".repeat(MAX_WIRE_PAYLOAD_BYTES + 100)}"}`;
    assert.throws(() => decodeWireJsonLossless(oversized), /exceeds maximum allowed/i);

    assert.throws(
      () =>
        parseContributionWireJson(
          '{"event_id":"e1","simulation_id":"s1","invasion_id":"i1","settlement_id":"st1","tick":10,"player_id":"p1","damage":12.5,"support":0,"objectives":0,"eligible":true,"outcome":"Defended"}',
        ),
      /non-integer/i,
    );

    assert.throws(
      () =>
        parseContributionWireJson(
          '{"event_id":"e1","simulation_id":"s1","invasion_id":"i1","settlement_id":"st1","tick":10,"player_id":"p1","damage":10,"damage":99999,"support":0,"objectives":0,"eligible":true,"outcome":"Defended"}',
        ),
      /Duplicate JSON object key/i,
    );
  });

  it("Section 12: Procedural item generator enforces 100% budget, rarity, quality, and exclusive-group invariants across 1,000 + 10,000 + 100,000 items", () => {
    const swordDef = INITIAL_ITEM_DEFINITIONS_CATALOG.find(
      (d) => d.definitionCode === "ironfang_longsword",
    )!;
    const poolSet = new Set(swordDef.allowedAffixPools);
    const candidates = INITIAL_AFFIXES_CATALOG.filter(
      (a) => poolSet.has(a.poolCode) && a.isEnabled,
    );

    // Determinism check
    const rRare = INITIAL_RARITIES_CATALOG.find((r) => r.rarityCode === "rare")!;
    const a1 = generateProceduralItemProperties({
      definition: swordDef,
      rarity: rRare,
      rules: DEFAULT_ITEM_GENERATION_RULES_V1,
      candidateAffixes: candidates,
      itemLevel: 35,
      serverSeed: "audit-det-seed-99",
      originReference: "boss:ironfang-01",
    });
    const a2 = generateProceduralItemProperties({
      definition: swordDef,
      rarity: rRare,
      rules: DEFAULT_ITEM_GENERATION_RULES_V1,
      candidateAffixes: candidates,
      itemLevel: 35,
      serverSeed: "audit-det-seed-99",
      originReference: "boss:ironfang-01",
    });
    assert.deepEqual(a1, a2);

    // Adversarial empty pool under reject_if_below_min MUST throw
    assert.throws(
      () =>
        generateProceduralItemProperties({
          definition: swordDef,
          rarity: rRare,
          rules: DEFAULT_ITEM_GENERATION_RULES_V1,
          candidateAffixes: [],
          itemLevel: 35,
          serverSeed: "audit-empty-pool",
          originReference: "boss:empty",
        }),
      (err: unknown) => err instanceof ItemGenerationInvalidError,
    );

    // Multi-scale statistical verification: 1,000 + 10,000 + 100,000 = 111,000 generated items!
    for (const batchSize of [1_000, 10_000, 100_000]) {
      let specialEffectCount = 0;
      for (let i = 0; i < batchSize; i++) {
        const rarity = INITIAL_RARITIES_CATALOG[i % INITIAL_RARITIES_CATALOG.length]!;
        const rolled = generateProceduralItemProperties({
          definition: swordDef,
          rarity,
          rules: DEFAULT_ITEM_GENERATION_RULES_V1,
          candidateAffixes: candidates,
          itemLevel: 25 + (i % 40),
          serverSeed: `audit-scale-${batchSize}`,
          originReference: `drop:${i}`,
        });

        assert.ok(
          rolled.qualityBp >= rarity.minQualityBp && rolled.qualityBp <= rarity.maxQualityBp,
          `Quality out of bounds at scale ${batchSize} idx ${i}`,
        );
        assert.ok(
          rolled.powerBudgetSpent >= 0 && rolled.powerBudgetSpent <= rolled.powerBudgetTotal,
          `Budget overflow at scale ${batchSize} idx ${i}`,
        );
        assert.ok(
          rolled.affixes.length <= rarity.maxExplicitAffixes,
          `Exceeded maxExplicitAffixes at scale ${batchSize} idx ${i}`,
        );

        const codes = new Set<string>();
        const groups = new Set<string>();
        for (const af of rolled.affixes) {
          assert.equal(codes.has(af.affixCode), false, "Duplicate affixCode rolled");
          assert.equal(groups.has(af.exclusiveGroup), false, "Duplicate exclusiveGroup rolled");
          codes.add(af.affixCode);
          groups.add(af.exclusiveGroup);
          if (af.affixKind === "special_effect") {
            assert.equal(
              rarity.allowsSpecialEffects,
              true,
              `Special effect rolled on ineligible rarity ${rarity.rarityCode}`,
            );
            specialEffectCount++;
          }
        }
      }
      assert.ok(specialEffectCount > 0, `Expected special effects in batch ${batchSize}`);
    }
  });

  it("[CARBON-AUD-010] & Section 14: Test DB URL guard rejects non-loopback hosts and Title AST validator blocks deep/oversized/malicious trees", () => {
    const prevOverride = process.env["ALLOW_EXTERNAL_TEST_DB"];
    delete process.env["ALLOW_EXTERNAL_TEST_DB"];
    try {
      // Remote host even with _test suffix MUST be rejected!
      assert.throws(
        () =>
          assertSafeTestDatabaseUrl(
            "postgresql://postgres:secret@prod-rds.example.com:5432/ascendra_test",
          ),
        /non-loopback host/i,
      );
      // Loopback host without _test/_ci suffix MUST be rejected!
      assert.throws(
        () =>
          assertSafeTestDatabaseUrl("postgresql://postgres:secret@127.0.0.1:5432/ascendra_prod"),
        /non-disposable database/i,
      );
      // Loopback host with _test or _ci suffix succeeds
      assertSafeTestDatabaseUrl("postgresql://postgres:pw@127.0.0.1:5432/ascendra_test");
      assertSafeTestDatabaseUrl("postgresql://postgres:pw@localhost:5432/ascendra_ci");
    } finally {
      if (prevOverride !== undefined) {
        process.env["ALLOW_EXTERNAL_TEST_DB"] = prevOverride;
      }
    }

    // Deeply nested AST (> depth ceiling) MUST be rejected
    let deepAst: TitleConditionNode = { op: "FameAtLeast", threshold: "100" };
    for (let d = 0; d < 12; d++) {
      deepAst = { op: "AND", conditions: [deepAst] };
    }
    assert.throws(
      () => validateTitleConditionAst(deepAst),
      (err: unknown) => err instanceof TitleConditionInvalidError,
    );

    // Unknown AST operator MUST be rejected (zero arbitrary code eval)
    assert.throws(
      () =>
        validateTitleConditionAst({
          op: "eval_javascript",
        } as unknown as TitleConditionNode),
      (err: unknown) => err instanceof TitleConditionInvalidError,
    );
  });
});
