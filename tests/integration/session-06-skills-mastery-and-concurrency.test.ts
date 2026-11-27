import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CharacterEngineService } from "../../src/modules/characters/application/character-engine-service.js";
import {
  PostgresCharacterSnapshotReader,
  serializeCharacterSnapshotWireV1,
} from "../../src/modules/characters/application/character-snapshot-query.js";
import type { AuthorityPrincipal } from "../../src/modules/characters/domain/character.js";
import {
  CharacterBuildConflictError,
  CharacterCompetitiveLockedError,
  GenesisTemporaryStatePersistenceForbiddenError,
} from "../../src/modules/characters/domain/errors.js";
import {
  PostgresCharacterRepository,
  PostgresCharacterUnitOfWork,
} from "../../src/modules/characters/infrastructure/postgres-character-unit-of-work.js";
import { PostgresEquipmentSnapshotReader } from "../../src/modules/inventory/application/equipment-snapshot-query.js";
import { InventoryEngineService } from "../../src/modules/inventory/application/inventory-engine-service.js";
import { WEAPON_SUBCATEGORIES } from "../../src/modules/inventory/domain/item-types.js";
import { PostgresInventoryRepository } from "../../src/modules/inventory/infrastructure/postgres-inventory-unit-of-work.js";
import { PostgresCatalogRepository } from "../../src/modules/peoples/infrastructure/postgres-catalog-repository.js";
import {
  PostgresAbilitySnapshotReader,
  assertConsistentCombatSnapshots,
  serializeAbilitySnapshotWireV1,
} from "../../src/modules/skills/application/ability-snapshot-query.js";
import { SkillEngineService } from "../../src/modules/skills/application/skill-engine-service.js";
import {
  AbilityLoadoutInvalidError,
  AbilityRankLimitExceededError,
  MasteryAntiFarmingRejectedError,
  MasteryNumericOverflowError,
  SkillAuthorizationForbiddenError,
  SkillCatalogDisabledOrNotFoundError,
  SkillPrerequisiteUnmetError,
  SpecializationBudgetInsufficientError,
  SpecializationDagInvalidError,
} from "../../src/modules/skills/domain/errors.js";
import { cumulativeMasteryXpForLevel } from "../../src/modules/skills/domain/mastery-and-dag-rules.js";
import { DEFAULT_MASTERY_AND_SKILL_RULES_V1 } from "../../src/modules/skills/catalog/initial-skills-catalog.js";
import { PostgresSkillRepository } from "../../src/modules/skills/infrastructure/postgres-skill-unit-of-work.js";
import { SocialEngineService } from "../../src/modules/social/application/social-engine-service.js";
import { TitleConditionInvalidError } from "../../src/modules/social/domain/errors.js";
import { PostgresSocialRepository } from "../../src/modules/social/infrastructure/postgres-social-unit-of-work.js";
import { MAX_INT64 } from "../../src/shared/contracts/int64-wire.js";
import {
  listAppliedMigrations,
  migrateDown,
  migrateUp,
} from "../../src/shared/db/migrator.js";
import { InboxIdempotencyConflictError } from "../../src/shared/db/processed-events-inbox.js";
import { StructuredLogger } from "../../src/shared/observability/logger.js";
import {
  validateAgainstJsonSchema,
  type JsonSchemaNode,
} from "../helpers/json-schema-assertion.js";
import {
  startPostgresTestContext,
  type RunningPostgresTestContext,
} from "../helpers/postgres-test-harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");
const CHAR_SNAPSHOT_SCHEMA_PATH = path.resolve(
  __dirname,
  "../../contracts/neon-carbon/character-snapshot.v1.schema.json",
);
const ABILITY_SNAPSHOT_SCHEMA_PATH = path.resolve(
  __dirname,
  "../../contracts/neon-carbon/ability-snapshot.v1.schema.json",
);

const SYSTEM_AUTHORITY: AuthorityPrincipal = {
  kind: "internal_system_authority",
  actorId: "test-skill-authority",
};

describe("CARBON Session 06 — Skills, Specialization, Weapon Mastery, Loadouts & Concurrency (Real PostgreSQL)", () => {
  let pgCtx: RunningPostgresTestContext;
  let charSnapshotSchema: JsonSchemaNode;
  let abilitySnapshotSchema: JsonSchemaNode;
  const silentLogger = new StructuredLogger("silent");

  before(async () => {
    pgCtx = await startPostgresTestContext();
    charSnapshotSchema = JSON.parse(
      await readFile(CHAR_SNAPSHOT_SCHEMA_PATH, "utf8"),
    ) as JsonSchemaNode;
    abilitySnapshotSchema = JSON.parse(
      await readFile(ABILITY_SNAPSHOT_SCHEMA_PATH, "utf8"),
    ) as JsonSchemaNode;
  });

  after(async () => {
    if (pgCtx) {
      await pgCtx.stop();
    }
  });

  it("Scenarios 46, 47, 1, 2, 3 & 16: Incremental migrations 0010..0011 apply over populated Session 05 data with backfill, full down/up cycle, school/ability registration, immutable versioning, and cyclic DAG rejection", async () => {
    const existing = await listAppliedMigrations(pgCtx.pool);
    if (existing.length > 0) {
      await migrateDown(pgCtx.pool, MIGRATIONS_DIR, existing.length);
    }

    // Apply all then step back to Session 05 (0001..0009)
    await migrateUp(pgCtx.pool, MIGRATIONS_DIR);
    const totalCount = (await listAppliedMigrations(pgCtx.pool)).length;
    await migrateDown(pgCtx.pool, MIGRATIONS_DIR, totalCount - 9);

    const s05Applied = await listAppliedMigrations(pgCtx.pool);
    assert.deepEqual(
      s05Applied.map((m) => m.version),
      ["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009"],
    );

    const catalogRepo = new PostgresCatalogRepository(pgCtx.pool);
    const charRepo = new PostgresCharacterRepository(pgCtx.pool);
    const invRepo = new PostgresInventoryRepository(pgCtx.pool);
    const socialRepo = new PostgresSocialRepository(pgCtx.pool);
    await catalogRepo.seedInitialCatalogs();
    await charRepo.seedProgressionRules();
    await invRepo.seedInitialItemCatalogs();
    await socialRepo.seedInitialSocialCatalogs();

    const preAcc = await charRepo.createAccount({
      id: randomUUID(),
      externalSubject: "pre-s06-acc",
    });
    const charEngine = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(pgCtx.pool),
      logger: silentLogger,
    });
    const preChar = (
      await charEngine.createCharacter({
        commandId: "s06:mig:pre-char",
        principal: { kind: "authenticated_account", accountId: preAcc.id },
        accountId: preAcc.id,
        characterName: "Kaelen Pré-Maestria",
        raceCode: "humans",
        lineageCode: "human_valorian",
        cultureCode: "valewatch_civic",
        backgroundCode: "veteran_soldier",
        originRegionId: "region-ashvale",
        appearance: {
          bodyPreset: "athletic_a",
          skinTone: "olive_bronze",
          hairStyle: "short_cropped",
          hairColor: "raven_black",
          eyeStyle: "almond_sharp",
          eyeColor: "slate_blue",
          earStyle: "rounded_standard",
        },
        presetCode: "arcane_knight",
      })
    ).data;

    // Advance pre-existing character to level 3 before Session 06 migration!
    await charEngine.grantExperience({
      grantId: "s06:mig:pre-xp",
      principal: SYSTEM_AUTHORITY,
      characterId: preChar.id,
      sourceType: "quest",
      sourceReference: "quest:ashvale-trial",
      amount: 1200n,
    });

    // Apply incremental migrations 0010 & 0011
    const inc = await migrateUp(pgCtx.pool, MIGRATIONS_DIR);
    assert.deepEqual(inc.slice(0, 2), [
      "0010_combat_schools_abilities_and_specialization_trees",
      "0011_character_mastery_skills_loadouts_and_history",
    ]);

    // Verify automatic specialization point backfill (`6 + (level - 1)`)
    const backfilledPts = await pgCtx.pool.query<{
      earned_points: number;
      spent_points: number;
      unspent_points: number;
    }>(
      "SELECT earned_points, spent_points, unspent_points FROM character_specialization_points WHERE character_id = $1::uuid",
      [preChar.id],
    );
    assert.ok((backfilledPts.rows[0]?.earned_points ?? 0) >= 8);
    assert.equal(backfilledPts.rows[0]?.spent_points, 0);
    assert.equal(
      backfilledPts.rows[0]?.unspent_points,
      backfilledPts.rows[0]?.earned_points,
    );

    // Full down:all -> up cycle
    const allNow = await listAppliedMigrations(pgCtx.pool);
    assert.ok(allNow.length >= 11);
    await migrateDown(pgCtx.pool, MIGRATIONS_DIR, allNow.length);
    assert.equal((await listAppliedMigrations(pgCtx.pool)).length, 0);
    await migrateUp(pgCtx.pool, MIGRATIONS_DIR);

    // Seed all catalogs for Session 06 tests
    await catalogRepo.seedInitialCatalogs();
    await charRepo.seedProgressionRules();
    await invRepo.seedInitialItemCatalogs();
    await socialRepo.seedInitialSocialCatalogs();
    const skillRepo = new PostgresSkillRepository(pgCtx.pool);
    await skillRepo.seedInitialSkillCatalogs();

    const counts = await skillRepo.listCatalogCounts();
    assert.equal(counts.totalSchools, 12);
    assert.equal(counts.enabledSchools, 6);
    assert.equal(counts.disabledSchools, 6);
    assert.equal(counts.totalAbilities, 28);
    assert.equal(counts.enabledAbilities, 27);
    assert.equal(counts.disabledAbilities, 1);
    assert.equal(counts.specializationNodes, 18);

    // #1 Register custom school in PostgreSQL
    await skillRepo.registerCombatSchool({
      schoolCode: "alchemical_combat",
      displayName: "Alquimia de Combate",
      description: "Escola experimental planejada.",
      primaryFocus: "tactical_concoctions",
      associatedWeaponFamilies: ["dagger", "wand"],
      isEnabled: false,
      rulesVersion: 1,
    });

    // #2 & #3 Register version 2 of `whirling_blade` while preserving v1 immutably!
    await skillRepo.registerVersionedAbilityDefinition({
      abilityCode: "whirling_blade",
      abilityVersion: 2,
      displayName: "Lâmina Giratória",
      description: "Revisão v2 com custo de equipamento reduzido sem alterar v1.",
      schoolCode: "swordsmanship",
      abilityCategory: "active",
      slotGroup: "active",
      requiredWeaponFamilies: ["short_sword", "longsword", "greatsword_2h", "dual_blades_2h"],
      requiredCharacterLevel: 2,
      requiredMasteryLevel: 8,
      requiredAttributes: { strength: 10, agility: 8 },
      prerequisiteAbilities: ["rising_slash"],
      prerequisiteNodes: [],
      maxRank: 5,
      unlockCost: 2,
      rankUpgradeCost: 1,
      equipmentCost: 2,
      exclusiveGroup: null,
      declarativePassiveParams: null,
      gameplayEffectRef: "neon.ability.sword.whirling_blade.v2",
      isEnabled: true,
      rulesVersion: 1,
    });

    const versionsRes = await pgCtx.pool.query<{
      ability_version: number;
      equipment_cost: number;
      gameplay_effect_ref: string;
    }>(
      "SELECT ability_version, equipment_cost, gameplay_effect_ref FROM ability_definitions WHERE ability_code = 'whirling_blade' ORDER BY ability_version ASC",
    );
    assert.equal(versionsRes.rows.length, 2);
    assert.equal(versionsRes.rows[0]?.ability_version, 1);
    assert.equal(versionsRes.rows[0]?.equipment_cost, 3);
    assert.equal(versionsRes.rows[1]?.ability_version, 2);
    assert.equal(versionsRes.rows[1]?.equipment_cost, 2);

    // #16 Cyclic specialization DAG registration is rejected and rolled back atomically!
    await assert.rejects(
      () =>
        skillRepo.registerSpecializationNodes([
          {
            nodeCode: "node_cycle_alpha",
            schoolCode: "swordsmanship",
            displayName: "Ciclo Alpha",
            description: "Teste de ciclo",
            abilityCode: null,
            abilityVersion: null,
            prerequisiteNodes: ["node_cycle_beta"],
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
            nodeCode: "node_cycle_beta",
            schoolCode: "swordsmanship",
            displayName: "Ciclo Beta",
            description: "Teste de ciclo",
            abilityCode: null,
            abilityVersion: null,
            prerequisiteNodes: ["node_cycle_alpha"],
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
        ]),
      SpecializationDagInvalidError,
    );

    const leakedCycle = await pgCtx.pool.query(
      "SELECT 1 FROM specialization_nodes WHERE node_code IN ('node_cycle_alpha', 'node_cycle_beta')",
    );
    assert.equal(leakedCycle.rowCount, 0);
  });

  it("Scenarios 4..11 & 40: Independent weapon mastery across all 22 families + unarmed, multi-level jumps, max level 100, int64 overflow, duplicate/conflicting/unauthorized grants, anti-farming, and bigint wire serialization", async () => {
    const charRepo = new PostgresCharacterRepository(pgCtx.pool);
    const skillRepo = new PostgresSkillRepository(pgCtx.pool);
    const charEngine = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(pgCtx.pool),
      logger: silentLogger,
    });
    const skillEngine = new SkillEngineService({ pool: pgCtx.pool, logger: silentLogger });
    const abilitySnapReader = new PostgresAbilitySnapshotReader(pgCtx.pool);

    const acc1 = await charRepo.createAccount({ id: randomUUID(), externalSubject: "s06-m-a1" });
    const acc2 = await charRepo.createAccount({ id: randomUUID(), externalSubject: "s06-m-a2" });
    const p1: AuthorityPrincipal = { kind: "authenticated_account", accountId: acc1.id };

    const fighter = (
      await charEngine.createCharacter({
        commandId: `s06:mast:fighter:${randomUUID()}`,
        principal: p1,
        accountId: acc1.id,
        characterName: "Valen Cem-Armas",
        raceCode: "humans",
        lineageCode: "human_frontier",
        cultureCode: "valewatch_civic",
        backgroundCode: "veteran_soldier",
        originRegionId: "region-ashvale",
        appearance: {
          bodyPreset: "athletic_a",
          skinTone: "olive_bronze",
          hairStyle: "short_cropped",
          hairColor: "raven_black",
          eyeStyle: "almond_sharp",
          eyeColor: "slate_blue",
          earStyle: "rounded_standard",
        },
        presetCode: "berserker",
      })
    ).data;

    const altSameAccount = (
      await charEngine.createCharacter({
        commandId: `s06:mast:alt:${randomUUID()}`,
        principal: p1,
        accountId: acc1.id,
        characterName: "Alt Mesma-Conta",
        raceCode: "humans",
        lineageCode: "human_frontier",
        cultureCode: "valewatch_civic",
        backgroundCode: "exile",
        originRegionId: "region-ashvale",
        appearance: {
          bodyPreset: "athletic_a",
          skinTone: "olive_bronze",
          hairStyle: "short_cropped",
          hairColor: "raven_black",
          eyeStyle: "almond_sharp",
          eyeColor: "slate_blue",
          earStyle: "rounded_standard",
        },
        presetCode: "assassin",
      })
    ).data;

    const rivalOtherAccount = (
      await charEngine.createCharacter({
        commandId: `s06:mast:rival:${randomUUID()}`,
        principal: { kind: "authenticated_account", accountId: acc2.id },
        accountId: acc2.id,
        characterName: "Rival Legítimo",
        raceCode: "orcs",
        lineageCode: "orc_ironblood",
        cultureCode: "valewatch_civic",
        backgroundCode: "veteran_soldier",
        originRegionId: "region-ashvale",
        appearance: {
          bodyPreset: "towering_broad_a",
          skinTone: "iron_grey",
          hairStyle: "topknot_warrior",
          hairColor: "raven_black",
          eyeStyle: "deep_set",
          eyeColor: "amber_gold",
          earStyle: "pointed_stout",
        },
        presetCode: "berserker",
      })
    ).data;

    // #11 Unauthorized client self-grant is rejected!
    await assert.rejects(
      () =>
        skillEngine.grantWeaponMasteryExperience({
          grantId: "s06:mast:unauth",
          principal: p1,
          characterId: fighter.id,
          weaponFamilyCode: "longsword",
          sourceType: "validated_combat",
          experienceAmount: 500n,
        }),
      SkillAuthorizationForbiddenError,
    );

    // Anti-farming: same-account counterparty rejected!
    await assert.rejects(
      () =>
        skillEngine.grantWeaponMasteryExperience({
          grantId: "s06:mast:alt-farm",
          principal: SYSTEM_AUTHORITY,
          characterId: fighter.id,
          counterpartyCharacterId: altSameAccount.id,
          weaponFamilyCode: "longsword",
          sourceType: "validated_combat",
          experienceAmount: 500n,
        }),
      MasteryAntiFarmingRejectedError,
    );

    // #4, #5 & #6 Independent mastery across families + multi-level jump (`longsword` -> practitioner >= 25, `unarmed` -> apprentice >= 10)
    const swordXpReq26 = cumulativeMasteryXpForLevel(26, DEFAULT_MASTERY_AND_SKILL_RULES_V1);
    const gSword = await skillEngine.grantWeaponMasteryExperience({
      grantId: "s06:mast:sword-jump",
      sourceEventId: "combat-encounter-001",
      principal: SYSTEM_AUTHORITY,
      characterId: fighter.id,
      counterpartyCharacterId: rivalOtherAccount.id,
      weaponFamilyCode: "longsword",
      sourceType: "validated_combat",
      experienceAmount: swordXpReq26,
    });
    assert.equal(gSword.status, "applied");
    assert.equal(gSword.data.mastery.masteryLevel, 26);
    assert.equal(gSword.data.mastery.proficiencyRank, "practitioner");

    // Anti-farming: reusing SAME `sourceEventId` (`combat-encounter-001`) on another weapon family (`dagger`) to duplicate reward is rejected!
    await assert.rejects(
      () =>
        skillEngine.grantWeaponMasteryExperience({
          grantId: "s06:mast:multi-weapon-dup-exploit",
          sourceEventId: "combat-encounter-001",
          principal: SYSTEM_AUTHORITY,
          characterId: fighter.id,
          weaponFamilyCode: "dagger",
          sourceType: "validated_combat",
          experienceAmount: 500n,
        }),
      MasteryAntiFarmingRejectedError,
    );

    // #9 Exact duplicate `grantId` returns `duplicate_idempotent` with zero extra XP!
    const gSwordDup = await skillEngine.grantWeaponMasteryExperience({
      grantId: "s06:mast:sword-jump",
      sourceEventId: "combat-encounter-001",
      principal: SYSTEM_AUTHORITY,
      characterId: fighter.id,
      counterpartyCharacterId: rivalOtherAccount.id,
      weaponFamilyCode: "longsword",
      sourceType: "validated_combat",
      experienceAmount: swordXpReq26,
    });
    assert.equal(gSwordDup.status, "duplicate_idempotent");
    assert.equal(gSwordDup.data.mastery.masteryExperience, swordXpReq26);

    // #10 Conflicting payload on same `grantId` throws `InboxIdempotencyConflictError`!
    await assert.rejects(
      () =>
        skillEngine.grantWeaponMasteryExperience({
          grantId: "s06:mast:sword-jump",
          sourceEventId: "combat-encounter-001",
          principal: SYSTEM_AUTHORITY,
          characterId: fighter.id,
          counterpartyCharacterId: rivalOtherAccount.id,
          weaponFamilyCode: "longsword",
          sourceType: "validated_combat",
          experienceAmount: swordXpReq26 + 1n,
        }),
      InboxIdempotencyConflictError,
    );

    // Independent progression on `unarmed` AND verify every single one of the 22 Session 04 weapon families can record mastery!
    const gUnarmed = await skillEngine.grantWeaponMasteryExperience({
      grantId: "s06:mast:unarmed-1",
      principal: SYSTEM_AUTHORITY,
      characterId: fighter.id,
      weaponFamilyCode: "unarmed",
      sourceType: "training",
      experienceAmount: cumulativeMasteryXpForLevel(10, DEFAULT_MASTERY_AND_SKILL_RULES_V1),
    });
    assert.ok(gUnarmed.data.mastery.masteryLevel >= 10);
    assert.equal(gUnarmed.data.mastery.proficiencyRank, "apprentice");

    for (const fam of WEAPON_SUBCATEGORIES) {
      if (fam === "longsword") continue;
      await skillEngine.grantWeaponMasteryExperience({
        grantId: `s06:mast:all22:${fam}`,
        principal: SYSTEM_AUTHORITY,
        characterId: fighter.id,
        weaponFamilyCode: fam,
        sourceType: "training",
        experienceAmount: 180n,
      });
    }
    const allMasteries = await skillRepo.listCharacterMasteries(fighter.id);
    assert.equal(allMasteries.length, 23); // 22 weapon families + unarmed!

    // #7 & #40 Max level 100 saturation + >53-bit bigint precision (`900719925474099312n`)
    const hugeBigIntGrant = 900_719_925_474_099_312n;
    const gMax = await skillEngine.grantWeaponMasteryExperience({
      grantId: "s06:mast:katana-grandmaster-bigint",
      principal: SYSTEM_AUTHORITY,
      characterId: fighter.id,
      weaponFamilyCode: "katana",
      sourceType: "dev_authorized",
      experienceAmount: hugeBigIntGrant,
    });
    assert.equal(gMax.data.mastery.masteryLevel, 100);
    assert.equal(gMax.data.mastery.proficiencyRank, "grandmaster");
    assert.equal(gMax.data.mastery.masteryExperience, 180n + hugeBigIntGrant);

    // #8 Overflow past MAX_INT64 rejects without corrupting katana mastery!
    await assert.rejects(
      () =>
        skillEngine.grantWeaponMasteryExperience({
          grantId: "s06:mast:katana-overflow",
          principal: SYSTEM_AUTHORITY,
          characterId: fighter.id,
          weaponFamilyCode: "katana",
          sourceType: "dev_authorized",
          experienceAmount: MAX_INT64,
        }),
      MasteryNumericOverflowError,
    );

    // #40 Validate `AbilitySnapshotWireV1` preserves exact >53-bit decimal string & matches JSON Schema!
    const abSnap = await abilitySnapReader.getAbilitySnapshot(fighter.id, { principal: p1 });
    const abWire = serializeAbilitySnapshotWireV1(abSnap);
    validateAgainstJsonSchema(abilitySnapshotSchema, abWire);
    const katanaWire = abWire.weapon_masteries.find((m) => m.weapon_family_code === "katana")!;
    assert.equal(katanaWire.mastery_experience, (180n + hugeBigIntGrant).toString());
    assert.equal(katanaWire.mastery_level, 100);
  });

  it("Scenarios 12..15, 17..23 & 35: Specialization points, concurrent allocation race, valid/duplicate/disabled/prereq/attribute/mastery learning, rank upgrades, max rank cap, and stale BuildVersion", async () => {
    const charRepo = new PostgresCharacterRepository(pgCtx.pool);
    const charEngine = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(pgCtx.pool),
      logger: silentLogger,
    });
    const skillEngine = new SkillEngineService({ pool: pgCtx.pool, logger: silentLogger });

    const acc = await charRepo.createAccount({ id: randomUUID(), externalSubject: "s06-learn" });
    const pAcc: AuthorityPrincipal = { kind: "authenticated_account", accountId: acc.id };

    // Create hybrid Arcane Knight (`strength: 12+5=17, dexterity: 8+5=13, intelligence: 12+5=17, wisdom: 8+5=13, fortitude: 10+5=15`)
    let knight = (
      await charEngine.createCharacter({
        commandId: `s06:knight:${randomUUID()}`,
        principal: pAcc,
        accountId: acc.id,
        characterName: "Lyra Lâmina-Rúnica",
        raceCode: "humans",
        lineageCode: "human_valorian",
        cultureCode: "valewatch_civic",
        backgroundCode: "arcane_scholar",
        originRegionId: "region-ashvale",
        appearance: {
          bodyPreset: "athletic_a",
          skinTone: "warm_ivory",
          hairStyle: "braided_crown",
          hairColor: "sun_gold",
          eyeStyle: "almond_sharp",
          eyeColor: "amber_gold",
          earStyle: "rounded_standard",
        },
        initialAttributeAllocation: {
          strength: 12,
          fortitude: 10,
          dexterity: 8,
          intelligence: 12,
          wisdom: 8,
        },
      })
    ).data;

    // Advance character to level 3
    knight = (
      await charEngine.grantExperience({
        grantId: `s06:knight:xp:${knight.id}`,
        principal: SYSTEM_AUTHORITY,
        characterId: knight.id,
        sourceType: "quest",
        sourceReference: "quest:runeblade-01",
        amount: 2000n,
      })
    ).data.character;

    // #14 Disabled ability (`abyssal_rift_slash`) cannot be learned!
    await assert.rejects(
      () =>
        skillEngine.learnAbility({
          commandId: "s06:learn:disabled",
          principal: pAcc,
          characterId: knight.id,
          abilityCode: "abyssal_rift_slash",
          expectedBuildVersion: knight.buildVersion,
        }),
      SkillCatalogDisabledOrNotFoundError,
    );

    // #15 Invalid prerequisites: `imperial_thrust` requires `rising_slash` + `node_sword_foundation` + mastery >= 5
    await assert.rejects(
      () =>
        skillEngine.learnAbility({
          commandId: "s06:learn:missing-prereq",
          principal: pAcc,
          characterId: knight.id,
          abilityCode: "imperial_thrust",
          expectedBuildVersion: knight.buildVersion,
        }),
      SkillPrerequisiteUnmetError,
    );

    // #22 Attribute requirement check: `seismic_rupture` requires `strength >= 14`, check `devastating_blow` (`strength >= 18`, knight has `17`) -> rejected!
    await assert.rejects(
      () =>
        skillEngine.unlockSpecializationNode({
          commandId: "s06:unlock:attr-short",
          principal: pAcc,
          characterId: knight.id,
          nodeCode: "node_heavy_titan_capstone",
          expectedBuildVersion: knight.buildVersion,
        }),
      SkillPrerequisiteUnmetError,
    );

    // #23 Mastery requirement check: `node_sword_sovereign_mastery` requires mastery >= 20 -> rejected while mastery is 1!
    await skillEngine.unlockSpecializationNode({
      commandId: `s06:unlock:sword-fnd:${knight.id}`,
      principal: pAcc,
      characterId: knight.id,
      nodeCode: "node_sword_foundation",
      expectedBuildVersion: 1,
    });
    await assert.rejects(
      () =>
        skillEngine.unlockSpecializationNode({
          commandId: "s06:unlock:mastery-short",
          principal: pAcc,
          characterId: knight.id,
          nodeCode: "node_sword_sovereign_mastery",
          expectedBuildVersion: 2,
        }),
      SkillPrerequisiteUnmetError,
    );

    // Grant longsword mastery -> level 12 (enough for `imperial_thrust` [5] & `duelist_counter` [10], still < 20)
    await skillEngine.grantWeaponMasteryExperience({
      grantId: `s06:knight:sword-m12:${knight.id}`,
      principal: SYSTEM_AUTHORITY,
      characterId: knight.id,
      weaponFamilyCode: "longsword",
      sourceType: "validated_combat",
      experienceAmount: cumulativeMasteryXpForLevel(12, DEFAULT_MASTERY_AND_SKILL_RULES_V1),
    });

    // #12 & #13 Valid ability learning + duplicate idempotency + non-idempotent duplicate rejection
    const learnSlash = await skillEngine.learnAbility({
      commandId: `s06:learn:rising:${knight.id}`,
      principal: pAcc,
      characterId: knight.id,
      abilityCode: "rising_slash",
      expectedBuildVersion: 2,
    });
    assert.equal(learnSlash.status, "applied");
    assert.equal(learnSlash.data.learned.currentRank, 1);

    const learnSlashDup = await skillEngine.learnAbility({
      commandId: `s06:learn:rising:${knight.id}`,
      principal: pAcc,
      characterId: knight.id,
      abilityCode: "rising_slash",
      expectedBuildVersion: 2,
    });
    assert.equal(learnSlashDup.status, "duplicate_idempotent");

    await assert.rejects(
      () =>
        skillEngine.learnAbility({
          commandId: `s06:learn:rising-second-cmd:${knight.id}`,
          principal: pAcc,
          characterId: knight.id,
          abilityCode: "rising_slash",
          expectedBuildVersion: 3,
        }),
      SkillPrerequisiteUnmetError,
    );

    // #35 Stale `expectedBuildVersion` rejected!
    await assert.rejects(
      () =>
        skillEngine.learnAbility({
          commandId: "s06:learn:stale-bv",
          principal: pAcc,
          characterId: knight.id,
          abilityCode: "imperial_thrust",
          expectedBuildVersion: 1,
        }),
      CharacterBuildConflictError,
    );

    // Learn `imperial_thrust` (buildVersion 3 -> 4)
    const learnThrust = await skillEngine.learnAbility({
      commandId: `s06:learn:thrust:${knight.id}`,
      principal: pAcc,
      characterId: knight.id,
      abilityCode: "imperial_thrust",
      expectedBuildVersion: 3,
    });
    assert.equal(learnThrust.data.buildVersion, 4);

    // #17 & #20 & #21 Grant specialization points & upgrade `rising_slash` from Rank 1 -> 5, then reject Rank 6!
    const grantPts = await skillEngine.grantSpecializationPoints({
      grantId: `s06:specpts:bonus:${knight.id}`,
      principal: SYSTEM_AUTHORITY,
      characterId: knight.id,
      sourceType: "training_completion",
      pointsAmount: 4,
    });
    assert.equal(
      grantPts.data.spentPoints + grantPts.data.unspentPoints,
      grantPts.data.earnedPoints,
    );

    const upg = await skillEngine.upgradeAbilityRank({
      commandId: `s06:upg:rising-to-5:${knight.id}`,
      principal: pAcc,
      characterId: knight.id,
      abilityCode: "rising_slash",
      ranksToGain: 4,
      expectedBuildVersion: 4,
    });
    assert.equal(upg.data.learned.currentRank, 5);

    await assert.rejects(
      () =>
        skillEngine.upgradeAbilityRank({
          commandId: `s06:upg:rising-over-max:${knight.id}`,
          principal: pAcc,
          characterId: knight.id,
          abilityCode: "rising_slash",
          ranksToGain: 1,
          expectedBuildVersion: upg.data.buildVersion,
        }),
      AbilityRankLimitExceededError,
    );

    // #18 & #19 Insufficient specialization budget & real multi-connection concurrent point spend race!
    // Check remaining unspent points and drain down to exactly 1 unspent point
    let curBv = upg.data.buildVersion;
    let rem = upg.data.specializationPoints.unspentPoints;
    if (rem > 1) {
      const gain = Math.min(4, rem - 1);
      const upgThrust = await skillEngine.upgradeAbilityRank({
        commandId: `s06:upg:drain:${knight.id}`,
        principal: pAcc,
        characterId: knight.id,
        abilityCode: "imperial_thrust",
        ranksToGain: gain,
        expectedBuildVersion: curBv,
      });
      curBv = upgThrust.data.buildVersion;
      rem = upgThrust.data.specializationPoints.unspentPoints;
    }
    if (rem > 1) {
      const lArc = await skillEngine.learnAbility({
        commandId: `s06:learn:drain-pulse:${knight.id}`,
        principal: pAcc,
        characterId: knight.id,
        abilityCode: "mana_pulse",
        expectedBuildVersion: curBv,
      });
      curBv = lArc.data.buildVersion;
      rem = lArc.data.specializationPoints.unspentPoints;
    }
    if (rem > 1) {
      const upgPulse = await skillEngine.upgradeAbilityRank({
        commandId: `s06:upg:drain-pulse:${knight.id}`,
        principal: pAcc,
        characterId: knight.id,
        abilityCode: "mana_pulse",
        ranksToGain: rem - 1,
        expectedBuildVersion: curBv,
      });
      curBv = upgPulse.data.buildVersion;
      rem = upgPulse.data.specializationPoints.unspentPoints;
    }
    assert.equal(rem, 1);

    // #18 Trying to learn a 2-point ability (`whirling_blade`) with only 1 unspent point fails!
    await assert.rejects(
      () =>
        skillEngine.learnAbility({
          commandId: `s06:learn:over-budget:${knight.id}`,
          principal: pAcc,
          characterId: knight.id,
          abilityCode: "whirling_blade",
          expectedBuildVersion: curBv,
        }),
      SpecializationBudgetInsufficientError,
    );

    // #19 Concurrent dual-connection race trying to spend the LAST 1 specialization point simultaneously!
    const raceResults = await Promise.allSettled([
      skillEngine.learnAbility({
        commandId: `s06:race:arcane-lance:${randomUUID()}`,
        principal: pAcc,
        characterId: knight.id,
        abilityCode: "arcane_lance",
        expectedBuildVersion: curBv,
      }),
      skillEngine.learnAbility({
        commandId: `s06:race:arcane-focus:${randomUUID()}`,
        principal: pAcc,
        characterId: knight.id,
        abilityCode: "arcane_focus",
        expectedBuildVersion: curBv,
      }),
    ]);

    const raceWinners = raceResults.filter((r) => r.status === "fulfilled");
    const raceLosers = raceResults.filter((r) => r.status === "rejected");
    assert.equal(raceWinners.length, 1);
    assert.equal(raceLosers.length, 1);

    const skillRepo = new PostgresSkillRepository(pgCtx.pool);
    const finalPts = (await skillRepo.getCharacterSpecializationPoints(knight.id))!;
    assert.equal(finalPts.unspentPoints, 0);
    assert.equal(finalPts.spentPoints, finalPts.earnedPoints);
  });

  it("Scenarios 24..34, 36..39: Equip/unequip abilities, slot/unlearned/budget/exclusive guards, incompatible weapon swap suppression, broken weapon suppression, loadout switching, respec & concurrent weapon-swap vs skill/respec races, competitive lock, and Snapshot parity", async () => {
    const charRepo = new PostgresCharacterRepository(pgCtx.pool);
    const skillRepo = new PostgresSkillRepository(pgCtx.pool);
    const charEngine = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(pgCtx.pool),
      logger: silentLogger,
    });
    const invEngine = new InventoryEngineService({ pool: pgCtx.pool, logger: silentLogger });
    const skillEngine = new SkillEngineService({ pool: pgCtx.pool, logger: silentLogger });
    const charSnapReader = new PostgresCharacterSnapshotReader(pgCtx.pool);
    const equipSnapReader = new PostgresEquipmentSnapshotReader(pgCtx.pool);
    const abilitySnapReader = new PostgresAbilitySnapshotReader(pgCtx.pool);

    const acc = await charRepo.createAccount({ id: randomUUID(), externalSubject: "s06-loadout" });
    const pAcc: AuthorityPrincipal = { kind: "authenticated_account", accountId: acc.id };

    let hero = (
      await charEngine.createCharacter({
        commandId: `s06:lo:hero:${randomUUID()}`,
        principal: pAcc,
        accountId: acc.id,
        characterName: "Caelum Híbrido",
        raceCode: "humans",
        lineageCode: "human_valorian",
        cultureCode: "valewatch_civic",
        backgroundCode: "veteran_soldier",
        originRegionId: "region-ashvale",
        appearance: {
          bodyPreset: "athletic_a",
          skinTone: "olive_bronze",
          hairStyle: "short_cropped",
          hairColor: "raven_black",
          eyeStyle: "almond_sharp",
          eyeColor: "slate_blue",
          earStyle: "rounded_standard",
        },
        initialAttributeAllocation: {
          strength: 9,       // 14 intrinsic
          fortitude: 9,      // 14 intrinsic
          dexterity: 8,      // 13 intrinsic
          intelligence: 9,   // 14 intrinsic (meets twilight_staff >= 14)
          wisdom: 7,         // 12 intrinsic (meets astral_vigil_grimoire >= 12)
          determination: 8,  // 13 intrinsic
        },
      })
    ).data;

    hero = (
      await charEngine.grantExperience({
        grantId: `s06:lo:xp:${hero.id}`,
        principal: SYSTEM_AUTHORITY,
        characterId: hero.id,
        sourceType: "quest",
        sourceReference: "quest:hybrid-master",
        amount: 5000n,
      })
    ).data.character;

    hero = (
      await charEngine.allocateAttributes({
        commandId: `s06:lo:alloc-vigor:${hero.id}`,
        principal: pAcc,
        characterId: hero.id,
        expectedBuildVersion: hero.buildVersion,
        attributeDeltas: { vigor: 6 },
      })
    ).data;

    // Grant weapons: `ironfang_longsword`, `astral_vigil_grimoire` (off_hand), `twilight_staff` (2H)
    const sword = (
      await invEngine.grantProceduralEquipment({
        grantId: `s06:lo:sword:${hero.id}`,
        principal: SYSTEM_AUTHORITY,
        recipientCharacterId: hero.id,
        definitionCode: "ironfang_longsword",
        rarityCode: "rare",
        originType: "quest_reward",
        originReference: "quest:hybrid-sword",
      })
    ).data;
    const grimoire = (
      await invEngine.grantProceduralEquipment({
        grantId: `s06:lo:grim:${hero.id}`,
        principal: SYSTEM_AUTHORITY,
        recipientCharacterId: hero.id,
        definitionCode: "astral_vigil_grimoire",
        rarityCode: "rare",
        originType: "quest_reward",
        originReference: "quest:hybrid-grim",
      })
    ).data;
    const staff = (
      await invEngine.grantProceduralEquipment({
        grantId: `s06:lo:staff:${hero.id}`,
        principal: SYSTEM_AUTHORITY,
        recipientCharacterId: hero.id,
        definitionCode: "twilight_staff",
        rarityCode: "epic",
        originType: "dungeon_reward",
        originReference: "dungeon:lunar-spire",
      })
    ).data;

    // Grant mastery in longsword (22), staff_2h (18), shield (6) + extra specialization points
    await skillEngine.grantWeaponMasteryExperience({
      grantId: `s06:lo:msword:${hero.id}`,
      principal: SYSTEM_AUTHORITY,
      characterId: hero.id,
      weaponFamilyCode: "longsword",
      sourceType: "validated_combat",
      experienceAmount: cumulativeMasteryXpForLevel(22, DEFAULT_MASTERY_AND_SKILL_RULES_V1),
    });
    await skillEngine.grantWeaponMasteryExperience({
      grantId: `s06:lo:mstaff:${hero.id}`,
      principal: SYSTEM_AUTHORITY,
      characterId: hero.id,
      weaponFamilyCode: "staff_2h",
      sourceType: "validated_combat",
      experienceAmount: cumulativeMasteryXpForLevel(18, DEFAULT_MASTERY_AND_SKILL_RULES_V1),
    });
    await skillEngine.grantSpecializationPoints({
      grantId: `s06:lo:pts:${hero.id}`,
      principal: SYSTEM_AUTHORITY,
      characterId: hero.id,
      sourceType: "training_completion",
      pointsAmount: 20,
    });

    // Equip sword in main_hand + grimoire in off_hand
    let bv = hero.buildVersion;
    const eq1 = await invEngine.equipItem({
      commandId: `s06:lo:eq-sword:${hero.id}`,
      principal: pAcc,
      characterId: hero.id,
      itemInstanceId: sword.id,
      targetSlot: "main_hand",
      expectedBuildVersion: bv,
    });
    bv++;
    const primaryLoadoutId = eq1.data.id;

    await invEngine.equipItem({
      commandId: `s06:lo:eq-grim:${hero.id}`,
      principal: pAcc,
      characterId: hero.id,
      itemInstanceId: grimoire.id,
      targetSlot: "off_hand",
      expectedBuildVersion: bv,
    });
    bv++;

    // #26 Equipping unlearned ability fails!
    await assert.rejects(
      () =>
        skillEngine.equipAbility({
          commandId: "s06:lo:equip-unlearned",
          principal: pAcc,
          characterId: hero.id,
          slotIndex: 0,
          abilityCode: "rising_slash",
          expectedBuildVersion: bv,
        }),
      AbilityLoadoutInvalidError,
    );

    // Unlock specialization nodes & learn hybrid abilities (`rising_slash`, `imperial_thrust`, `sovereign_blade_storm`, `arcane_lance`, `mana_pulse`, `arcane_barrier`, `unwavering_stance`, `blade_discipline`, `iron_fist`)
    for (const nc of ["node_sword_foundation", "node_sword_duelist_stance", "node_sword_sovereign_mastery"]) {
      const r = await skillEngine.unlockSpecializationNode({
        commandId: `s06:lo:un:${nc}:${hero.id}`,
        principal: pAcc,
        characterId: hero.id,
        nodeCode: nc,
        expectedBuildVersion: bv,
      });
      bv = r.data.buildVersion;
    }

    // #32 Exclusive specialization node group (`node_sword_vanguard_cleave` conflicts with `node_sword_duelist_stance`)
    await assert.rejects(
      () =>
        skillEngine.unlockSpecializationNode({
          commandId: `s06:lo:excl-node:${hero.id}`,
          principal: pAcc,
          characterId: hero.id,
          nodeCode: "node_sword_vanguard_cleave",
          expectedBuildVersion: bv,
        }),
      SkillPrerequisiteUnmetError,
    );

    for (const ac of [
      "rising_slash",
      "imperial_thrust",
      "sovereign_blade_storm",
      "arcane_lance",
      "mana_pulse",
      "arcane_barrier",
      "unwavering_stance",
      "blade_discipline",
      "iron_fist",
    ]) {
      const r = await skillEngine.learnAbility({
        commandId: `s06:lo:learn:${ac}:${hero.id}`,
        principal: pAcc,
        characterId: hero.id,
        abilityCode: ac,
        expectedBuildVersion: bv,
      });
      bv = r.data.buildVersion;
    }

    // Upgrade `rising_slash` to Rank 3
    bv = (
      await skillEngine.upgradeAbilityRank({
        commandId: `s06:lo:upg-rising:${hero.id}`,
        principal: pAcc,
        characterId: hero.id,
        abilityCode: "rising_slash",
        ranksToGain: 2,
        expectedBuildVersion: bv,
      })
    ).data.buildVersion;

    // #27 Directly equipping `iron_fist` (`unarmed`/`gauntlets`) onto active bar while wielding `longsword` + `grimoire` fails!
    await assert.rejects(
      () =>
        skillEngine.equipAbility({
          commandId: "s06:lo:equip-incompat-direct",
          principal: pAcc,
          characterId: hero.id,
          slotIndex: 0,
          abilityCode: "iron_fist",
          expectedBuildVersion: bv,
        }),
      AbilityLoadoutInvalidError,
    );

    // #24 Equip hybrid Arcane Knight bar: slot 0 `rising_slash` (rank 3, cost 2), slot 1 `imperial_thrust` (cost 3), slot 2 `arcane_lance` (cost 2), slot 4 `blade_discipline` (cost 3) -> total cost 10 <= 12!
    for (const [idx, code] of [
      [0, "rising_slash"],
      [1, "imperial_thrust"],
      [2, "arcane_lance"],
      [4, "blade_discipline"],
    ] as const) {
      bv = (
        await skillEngine.equipAbility({
          commandId: `s06:lo:eq:${code}:${hero.id}`,
          principal: pAcc,
          characterId: hero.id,
          slotIndex: idx,
          abilityCode: code,
          expectedBuildVersion: bv,
        })
      ).data.buildVersion;
    }

    // #25 Occupied slot (slot 0) rejected!
    await assert.rejects(
      () =>
        skillEngine.equipAbility({
          commandId: "s06:lo:slot-occupied",
          principal: pAcc,
          characterId: hero.id,
          slotIndex: 0,
          abilityCode: "mana_pulse",
          expectedBuildVersion: bv,
        }),
      AbilityLoadoutInvalidError,
    );

    // #31 Build equipment budget exceeded (`10 + 4 = 14 > 12` when adding `sovereign_blade_storm`)!
    await assert.rejects(
      () =>
        skillEngine.equipAbility({
          commandId: "s06:lo:budget-exceeded",
          principal: pAcc,
          characterId: hero.id,
          slotIndex: 6,
          abilityCode: "sovereign_blade_storm",
          expectedBuildVersion: bv,
        }),
      AbilityLoadoutInvalidError,
    );

    // #32 Exclusive ability group conflict (`arcane_barrier` + `unwavering_stance` in `saveLoadoutAbilities`)!
    await assert.rejects(
      () =>
        skillEngine.saveLoadoutAbilities({
          commandId: "s06:lo:excl-abilities",
          principal: pAcc,
          characterId: hero.id,
          loadoutId: primaryLoadoutId,
          assignments: [
            { slotIndex: 0, abilityCode: "arcane_barrier" },
            { slotIndex: 1, abilityCode: "unwavering_stance" },
          ],
          expectedBuildVersion: bv,
        }),
      AbilityLoadoutInvalidError,
    );

    // #37, #38 & #39 Verify `CharacterSnapshotV1`, `EquipmentSnapshotProposalV1`, and `AbilitySnapshotV1` consistency & JSON Schemas!
    const cSnap1 = await charSnapReader.getCharacterSnapshot(hero.id, { principal: pAcc });
    const eSnap1 = await equipSnapReader.getEquipmentSnapshot(hero.id, { principal: pAcc });
    const aSnap1 = await abilitySnapReader.getAbilitySnapshot(hero.id, { principal: pAcc });
    assertConsistentCombatSnapshots({
      characterSnapshot: cSnap1,
      equipmentSnapshot: eSnap1,
      abilitySnapshot: aSnap1,
    });
    validateAgainstJsonSchema(charSnapshotSchema, serializeCharacterSnapshotWireV1(cSnap1));
    validateAgainstJsonSchema(abilitySnapshotSchema, serializeAbilitySnapshotWireV1(aSnap1));

    assert.deepEqual(cSnap1.equippedAbilities, [
      { slotIndex: 0, abilityCode: "rising_slash", rank: 3 },
      { slotIndex: 1, abilityCode: "imperial_thrust", rank: 1 },
      { slotIndex: 2, abilityCode: "arcane_lance", rank: 1 },
      { slotIndex: 4, abilityCode: "blade_discipline", rank: 1 },
    ]);

    // #28 Break `ironfang_longsword` (`durability -> 0`): sword techniques (`rising_slash`, `imperial_thrust`, `blade_discipline`) are suppressed with `equipped_weapon_broken`, while `arcane_lance` (via intact off-hand `grimoire`) remains ACTIVE!
    await invEngine.applyDurabilityLoss({
      commandId: `s06:lo:break-sword:${hero.id}`,
      principal: SYSTEM_AUTHORITY,
      characterId: hero.id,
      itemInstanceId: sword.id,
      durabilityLoss: 500,
      causeReference: "boss:acid-cleave",
    });

    const cSnapBroken = await charSnapReader.getCharacterSnapshot(hero.id, { principal: pAcc });
    const aSnapBroken = await abilitySnapReader.getAbilitySnapshot(hero.id, { principal: pAcc });
    assert.deepEqual(cSnapBroken.equippedAbilities, [
      { slotIndex: 2, abilityCode: "arcane_lance", rank: 1 },
    ]);
    assert.equal(
      aSnapBroken.equippedAbilities.find((a) => a.abilityCode === "rising_slash")?.suppressionReason,
      "equipped_weapon_broken",
    );

    // Mismatched snapshot versions (`cSnap1` vs `aSnapBroken`) detected and rejected!
    assert.throws(
      () =>
        assertConsistentCombatSnapshots({
          characterSnapshot: cSnap1,
          abilitySnapshot: aSnapBroken,
        }),
      CharacterBuildConflictError,
    );

    // Repair sword -> all 4 equipped abilities immediately become eligible again!
    await invEngine.repairItem({
      commandId: `s06:lo:repair-sword:${hero.id}`,
      principal: SYSTEM_AUTHORITY,
      characterId: hero.id,
      itemInstanceId: sword.id,
      repairAmount: 500,
      causeReference: "npc:valewatch-smith",
    });
    const cSnapRepaired = await charSnapReader.getCharacterSnapshot(hero.id, { principal: pAcc });
    assert.equal(cSnapRepaired.equippedAbilities.length, 4);

    // #27 Swap `main_hand` to 2H `twilight_staff` (displacing both `ironfang_longsword` AND `astral_vigil_grimoire`):
    // Sword techniques are suppressed (`incompatible_equipped_weapon`) WITHOUT deleting learned abilities or loadout slots, while `arcane_lance` stays eligible via `staff_2h`!
    await invEngine.equipItem({
      commandId: `s06:lo:swap-staff:${hero.id}`,
      principal: pAcc,
      characterId: hero.id,
      itemInstanceId: staff.id,
      targetSlot: "main_hand",
      expectedBuildVersion: bv,
    });
    bv++;

    const cSnapStaff = await charSnapReader.getCharacterSnapshot(hero.id, { principal: pAcc });
    const aSnapStaff = await abilitySnapReader.getAbilitySnapshot(hero.id, { principal: pAcc });
    assert.deepEqual(cSnapStaff.equippedAbilities, [
      { slotIndex: 2, abilityCode: "arcane_lance", rank: 1 },
    ]);
    assert.equal(
      aSnapStaff.equippedAbilities.find((a) => a.abilityCode === "rising_slash")?.suppressionReason,
      "incompatible_equipped_weapon",
    );

    // #30 Create alternate Loadout ("Arcanista Puro") with `twilight_staff` + `arcane_lance` + `mana_pulse` + `arcane_barrier`, while re-equipping `ironfang_longsword` on Primary Loadout, then switch loadouts!
    await invEngine.equipItem({
      commandId: `s06:lo:restore-sword:${hero.id}`,
      principal: pAcc,
      characterId: hero.id,
      itemInstanceId: sword.id,
      targetSlot: "main_hand",
      expectedBuildVersion: bv,
    });
    bv++;

    const altLoadout = (
      await invEngine.saveInactiveLoadout({
        commandId: `s06:lo:save-arc-lo:${hero.id}`,
        principal: pAcc,
        characterId: hero.id,
        loadoutName: "Arcanista Puro",
        assignments: [{ slotCode: "main_hand", itemInstanceId: staff.id }],
      })
    ).data;

    await skillEngine.saveLoadoutAbilities({
      commandId: `s06:lo:save-arc-skills:${hero.id}`,
      principal: pAcc,
      characterId: hero.id,
      loadoutId: altLoadout.id,
      assignments: [
        { slotIndex: 0, abilityCode: "arcane_lance" },
        { slotIndex: 1, abilityCode: "mana_pulse" },
        { slotIndex: 2, abilityCode: "arcane_barrier" },
      ],
      expectedBuildVersion: bv,
    });

    await invEngine.activateLoadout({
      commandId: `s06:lo:activate-arc:${hero.id}`,
      principal: pAcc,
      characterId: hero.id,
      loadoutId: altLoadout.id,
      expectedBuildVersion: bv,
    });
    bv++;

    const cSnapAlt = await charSnapReader.getCharacterSnapshot(hero.id, { principal: pAcc });
    assert.deepEqual(
      cSnapAlt.equippedAbilities.map((a) => a.abilityCode),
      ["arcane_lance", "mana_pulse", "arcane_barrier"],
    );

    // #36 Competitive lock (`in_ranked_series`) blocks skill/loadout/respec mutations!
    await pgCtx.pool.query(
      "UPDATE characters SET competitive_lock_state = 'in_ranked_series' WHERE id = $1::uuid",
      [hero.id],
    );
    await assert.rejects(
      () =>
        skillEngine.unequipAbility({
          commandId: "s06:lo:locked-unequip",
          principal: pAcc,
          characterId: hero.id,
          slotIndex: 2,
          expectedBuildVersion: bv,
        }),
      CharacterCompetitiveLockedError,
    );
    await assert.rejects(
      () =>
        skillEngine.resetSpecialization({
          commandId: "s06:lo:locked-respec",
          principal: pAcc,
          characterId: hero.id,
          expectedBuildVersion: bv,
        }),
      CharacterCompetitiveLockedError,
    );
    await pgCtx.pool.query(
      "UPDATE characters SET competitive_lock_state = 'none' WHERE id = $1::uuid",
      [hero.id],
    );

    // #34 & #47 Real multi-connection concurrency race: concurrent Weapon Swap (`equipItem` sword) vs `resetSpecialization` at SAME `expectedBuildVersion`!
    const swapVsRespecRace = await Promise.allSettled([
      invEngine.equipItem({
        commandId: `s06:race:swap-sword:${randomUUID()}`,
        principal: pAcc,
        characterId: hero.id,
        itemInstanceId: sword.id,
        targetSlot: "main_hand",
        expectedBuildVersion: bv,
      }),
      skillEngine.resetSpecialization({
        commandId: `s06:race:spec-reset:${randomUUID()}`,
        principal: pAcc,
        characterId: hero.id,
        expectedBuildVersion: bv,
      }),
    ]);

    const raceFulfilled = swapVsRespecRace.filter((r) => r.status === "fulfilled");
    const raceRejected = swapVsRespecRace.filter((r) => r.status === "rejected");
    assert.equal(raceFulfilled.length, 1);
    assert.equal(raceRejected.length, 1);
    assert.ok(raceRejected[0]?.reason instanceof CharacterBuildConflictError);
    bv++;

    // #29, #33 & #34 Now execute concurrent `resetSpecialization` vs `resetSpecialization` (if swap won above) to verify respec semantics & concurrent respec safety!
    const dualRespecRace = await Promise.allSettled([
      skillEngine.resetSpecialization({
        commandId: `s06:race:respec-a:${randomUUID()}`,
        principal: pAcc,
        characterId: hero.id,
        expectedBuildVersion: bv,
      }),
      skillEngine.resetSpecialization({
        commandId: `s06:race:respec-b:${randomUUID()}`,
        principal: pAcc,
        characterId: hero.id,
        expectedBuildVersion: bv,
      }),
    ]);
    // If `resetSpecialization` hadn't run yet, 1 wins and 1 rejects on `CharacterBuildConflictError`; either way verify post-respec invariants!
    if (dualRespecRace.some((r) => r.status === "fulfilled")) {
      bv++;
    }

    const postRespecPts = (await skillRepo.getCharacterSpecializationPoints(hero.id))!;
    assert.equal(postRespecPts.spentPoints, 0);
    assert.equal(postRespecPts.unspentPoints, postRespecPts.earnedPoints);

    // Historical mastery XP and historical learned records (`maxRankEverReached === 3` on `rising_slash`) remain intact!
    const postRespecMasteries = await skillRepo.listCharacterMasteries(hero.id);
    assert.equal(
      postRespecMasteries.find((m) => m.weaponFamilyCode === "longsword")?.masteryLevel,
      22,
    );
    const postRespecLearned = await skillRepo.listCharacterLearnedAbilities(hero.id);
    const risingHist = postRespecLearned.find((l) => l.abilityCode === "rising_slash")!;
    assert.equal(risingHist.isActive, false);
    assert.equal(risingHist.maxRankEverReached, 3);

    // Suppressed after respec in `AbilitySnapshotV1`, empty in `CharacterSnapshotV1.equippedAbilities`!
    const cSnapPostRespec = await charSnapReader.getCharacterSnapshot(hero.id, { principal: pAcc });
    const aSnapPostRespec = await abilitySnapReader.getAbilitySnapshot(hero.id, { principal: pAcc });
    assert.equal(cSnapPostRespec.equippedAbilities.length, 0);
    assert.ok(
      aSnapPostRespec.equippedAbilities.every(
        (a) => a.suppressionReason === "inactive_after_specialization_reset",
      ),
    );
  });

  it("Scenarios 41..45: Master of Blades title unlock, duplicate/concurrent title safety, Genesis isolation, transactional fault rollback, and real PostgreSQL restart persistence", async () => {
    const charRepo = new PostgresCharacterRepository(pgCtx.pool);
    let skillRepo = new PostgresSkillRepository(pgCtx.pool);
    let socialRepo = new PostgresSocialRepository(pgCtx.pool);
    const charEngine = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(pgCtx.pool),
      logger: silentLogger,
    });
    const invEngine = new InventoryEngineService({ pool: pgCtx.pool, logger: silentLogger });
    let skillEngine = new SkillEngineService({ pool: pgCtx.pool, logger: silentLogger });
    let socialEngine = new SocialEngineService({ pool: pgCtx.pool, logger: silentLogger });
    let charSnapReader = new PostgresCharacterSnapshotReader(pgCtx.pool);
    let abilitySnapReader = new PostgresAbilitySnapshotReader(pgCtx.pool);

    const acc = await charRepo.createAccount({ id: randomUUID(), externalSubject: "s06-blades" });
    const pAcc: AuthorityPrincipal = { kind: "authenticated_account", accountId: acc.id };

    const duelist = (
      await charEngine.createCharacter({
        commandId: `s06:blades:char:${randomUUID()}`,
        principal: pAcc,
        accountId: acc.id,
        characterName: "Aethel Mestre-Lâmina",
        raceCode: "humans",
        lineageCode: "human_valorian",
        cultureCode: "valewatch_civic",
        backgroundCode: "veteran_soldier",
        originRegionId: "region-ashvale",
        appearance: {
          bodyPreset: "athletic_a",
          skinTone: "warm_ivory",
          hairStyle: "short_cropped",
          hairColor: "sun_gold",
          eyeStyle: "almond_sharp",
          eyeColor: "amber_gold",
          earStyle: "rounded_standard",
        },
        initialAttributeAllocation: {
          strength: 18,
          fortitude: 10,
          vigor: 10,
          dexterity: 12,
        },
      })
    ).data;

    // #43 Genesis Ranked temporary context is strictly blocked across Skill Engine & AbilitySnapshot!
    await assert.rejects(
      () =>
        skillEngine.grantWeaponMasteryExperience({
          grantId: "s06:genesis:block-xp",
          principal: SYSTEM_AUTHORITY,
          characterId: duelist.id,
          weaponFamilyCode: "longsword",
          sourceType: "validated_combat",
          experienceAmount: 100n,
          executionProfile: "genesis_ranked_md3_scratch",
        }),
      GenesisTemporaryStatePersistenceForbiddenError,
    );
    await assert.rejects(
      () =>
        skillEngine.learnAbility({
          commandId: "s06:genesis:block-learn",
          principal: pAcc,
          characterId: duelist.id,
          abilityCode: "rising_slash",
          expectedBuildVersion: 1,
          executionProfile: "genesis_ranked_md3_scratch",
        }),
      GenesisTemporaryStatePersistenceForbiddenError,
    );
    await assert.rejects(
      () =>
        abilitySnapReader.getAbilitySnapshot(duelist.id, {
          principal: pAcc,
          normalizationProfile: "genesis_ranked_md3_scratch",
        }),
      GenesisTemporaryStatePersistenceForbiddenError,
    );

    // #44 Transactional fault rollback via `beforeCommitHook` leaves zero partial state or orphan Outbox events!
    const faultySkillEngine = new SkillEngineService({
      pool: pgCtx.pool,
      logger: silentLogger,
      beforeCommitHook: async () => {
        throw new Error("Simulated pre-commit crash during mastery grant");
      },
    });
    await assert.rejects(
      () =>
        faultySkillEngine.grantWeaponMasteryExperience({
          grantId: "s06:rollback:sword-xp",
          principal: SYSTEM_AUTHORITY,
          characterId: duelist.id,
          weaponFamilyCode: "longsword",
          sourceType: "validated_combat",
          experienceAmount: 5000n,
        }),
      /Simulated pre-commit crash/,
    );
    assert.equal((await skillRepo.listCharacterMasteries(duelist.id)).length, 0);

    // Retry with healthy engine succeeds cleanly!
    await skillEngine.grantWeaponMasteryExperience({
      grantId: "s06:rollback:sword-xp",
      principal: SYSTEM_AUTHORITY,
      characterId: duelist.id,
      weaponFamilyCode: "longsword",
      sourceType: "validated_combat",
      experienceAmount: cumulativeMasteryXpForLevel(26, DEFAULT_MASTERY_AND_SKILL_RULES_V1),
    });

    // Before learning 2 swordsmanship abilities, `master_of_blades` cannot be unlocked!
    await assert.rejects(
      () =>
        socialEngine.evaluateAndUnlockTitle({
          commandId: "s06:blades:premature",
          principal: SYSTEM_AUTHORITY,
          characterId: duelist.id,
          titleCode: "master_of_blades",
        }),
      TitleConditionInvalidError,
    );

    // Equip sword, unlock `node_sword_foundation`, learn `rising_slash` + `blade_discipline`, and equip both!
    const sword = (
      await invEngine.grantProceduralEquipment({
        grantId: `s06:blades:sword:${duelist.id}`,
        principal: SYSTEM_AUTHORITY,
        recipientCharacterId: duelist.id,
        definitionCode: "ironfang_longsword",
        rarityCode: "epic",
        originType: "quest_reward",
        originReference: "quest:blade-trial",
      })
    ).data;

    await invEngine.equipItem({
      commandId: `s06:blades:eq-sword:${duelist.id}`,
      principal: pAcc,
      characterId: duelist.id,
      itemInstanceId: sword.id,
      targetSlot: "main_hand",
      expectedBuildVersion: 1,
    });
    let bv = 2;
    bv = (
      await skillEngine.unlockSpecializationNode({
        commandId: `s06:blades:un-fnd:${duelist.id}`,
        principal: pAcc,
        characterId: duelist.id,
        nodeCode: "node_sword_foundation",
        expectedBuildVersion: bv,
      })
    ).data.buildVersion;
    bv = (
      await skillEngine.learnAbility({
        commandId: `s06:blades:learn-1:${duelist.id}`,
        principal: pAcc,
        characterId: duelist.id,
        abilityCode: "rising_slash",
        expectedBuildVersion: bv,
      })
    ).data.buildVersion;
    bv = (
      await skillEngine.learnAbility({
        commandId: `s06:blades:learn-2:${duelist.id}`,
        principal: pAcc,
        characterId: duelist.id,
        abilityCode: "blade_discipline",
        expectedBuildVersion: bv,
      })
    ).data.buildVersion;
    bv = (
      await skillEngine.equipAbility({
        commandId: `s06:blades:eq-ab1:${duelist.id}`,
        principal: pAcc,
        characterId: duelist.id,
        slotIndex: 0,
        abilityCode: "rising_slash",
        expectedBuildVersion: bv,
      })
    ).data.buildVersion;
    bv = (
      await skillEngine.equipAbility({
        commandId: `s06:blades:eq-ab2:${duelist.id}`,
        principal: pAcc,
        characterId: duelist.id,
        slotIndex: 4,
        abilityCode: "blade_discipline",
        expectedBuildVersion: bv,
      })
    ).data.buildVersion;

    // #41 & #42 Unlock `master_of_blades` concurrently across two connections -> zero duplicates, and equipping grants zero combat stat bonus!
    const titleRace = await Promise.all([
      socialEngine.evaluateAndUnlockTitle({
        commandId: `s06:blades:unlock-a:${randomUUID()}`,
        principal: SYSTEM_AUTHORITY,
        characterId: duelist.id,
        titleCode: "master_of_blades",
      }),
      socialEngine.evaluateAndUnlockTitle({
        commandId: `s06:blades:unlock-b:${randomUUID()}`,
        principal: SYSTEM_AUTHORITY,
        characterId: duelist.id,
        titleCode: "master_of_blades",
      }),
    ]);
    assert.ok(titleRace.some((r) => r.status === "applied"));
    const titlesBeforeRestart = await socialRepo.listCharacterTitles(duelist.id);
    assert.equal(titlesBeforeRestart.filter((t) => t.titleCode === "master_of_blades").length, 1);

    const snapBeforeTitleEquip = await charSnapReader.getCharacterSnapshot(duelist.id, {
      principal: pAcc,
    });
    await socialEngine.equipTitle({
      commandId: `s06:blades:equip-title:${duelist.id}`,
      principal: pAcc,
      characterId: duelist.id,
      titleCode: "master_of_blades",
      expectedSocialVersion: 2,
    });
    const snapAfterTitleEquip = await charSnapReader.getCharacterSnapshot(duelist.id, {
      principal: pAcc,
    });
    assert.deepEqual(snapAfterTitleEquip.baseAttributes, snapBeforeTitleEquip.baseAttributes);
    assert.deepEqual(
      snapAfterTitleEquip.allocatedAttributes,
      snapBeforeTitleEquip.allocatedAttributes,
    );

    // #45 Real PostgreSQL restart recovery!
    const reconnectedPool = await pgCtx.restartAndReconnect();
    skillRepo = new PostgresSkillRepository(reconnectedPool);
    socialRepo = new PostgresSocialRepository(reconnectedPool);
    skillEngine = new SkillEngineService({ pool: reconnectedPool, logger: silentLogger });
    socialEngine = new SocialEngineService({ pool: reconnectedPool, logger: silentLogger });
    charSnapReader = new PostgresCharacterSnapshotReader(reconnectedPool);
    abilitySnapReader = new PostgresAbilitySnapshotReader(reconnectedPool);

    const cSnapAfterRestart = await charSnapReader.getCharacterSnapshot(duelist.id, {
      principal: pAcc,
    });
    const aSnapAfterRestart = await abilitySnapReader.getAbilitySnapshot(duelist.id, {
      principal: pAcc,
    });
    assert.deepEqual(cSnapAfterRestart.equippedAbilities, [
      { slotIndex: 0, abilityCode: "rising_slash", rank: 1 },
      { slotIndex: 4, abilityCode: "blade_discipline", rank: 1 },
    ]);
    assert.equal(
      aSnapAfterRestart.weaponMasteries.find((m) => m.weaponFamilyCode === "longsword")
        ?.masteryLevel,
      26,
    );
    const titlesAfterRestart = await socialRepo.listCharacterTitles(duelist.id);
    assert.equal(
      titlesAfterRestart.find((t) => t.titleCode === "master_of_blades")?.state,
      "active",
    );
    const historyAfterRestart = await skillRepo.listCharacterSkillHistory(duelist.id, {
      limit: 20,
      offset: 0,
    });
    assert.ok(historyAfterRestart.length >= 6);
  });
});
