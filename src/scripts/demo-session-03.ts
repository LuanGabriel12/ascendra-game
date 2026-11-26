import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CharacterEngineService } from "../modules/characters/application/character-engine-service.js";
import {
  PostgresCharacterSnapshotReader,
  serializeCharacterSnapshotWireV1,
} from "../modules/characters/application/character-snapshot-query.js";
import type { AuthorityPrincipal } from "../modules/characters/domain/character.js";
import { AttributeAllocationInvalidError } from "../modules/characters/domain/errors.js";
import {
  PostgresCharacterRepository,
  PostgresCharacterUnitOfWork,
} from "../modules/characters/infrastructure/postgres-character-unit-of-work.js";
import { runProgressionSimulationHarness } from "../modules/characters/simulation/progression-simulator.js";
import { PostgresCatalogRepository } from "../modules/peoples/infrastructure/postgres-catalog-repository.js";
import { migrateUp } from "../shared/db/migrator.js";
import { StructuredLogger } from "../shared/observability/logger.js";
import { startPostgresTestContext } from "../../tests/helpers/postgres-test-harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

async function runSession03Demo(): Promise<void> {
  const logger = new StructuredLogger("info");
  logger.info("Starting CARBON Session 03 headless character & progression demonstration", {
    operation: "demo03:start",
  });

  // 1. Initialize isolated PostgreSQL
  const pgCtx = await startPostgresTestContext();

  try {
    // 2. Apply all migrations (0001..0005)
    const applied = await migrateUp(pgCtx.pool, MIGRATIONS_DIR);
    logger.info("Step 2: Migrations applied", {
      operation: "demo03:migrate",
      applied,
    });

    // 3. Load & seed initial catalogs (26 peoples, lineages, cultures, 10 backgrounds, progression_rules v1)
    const catalogRepo = new PostgresCatalogRepository(pgCtx.pool);
    let charRepo = new PostgresCharacterRepository(pgCtx.pool);
    await catalogRepo.seedInitialCatalogs();
    await charRepo.seedProgressionRules();

    const peopleCounts = await catalogRepo.countPeoples();
    assert.equal(peopleCounts.total, 26);
    assert.equal(peopleCounts.enabled, 6);

    // 4. Create test Account
    const account = await charRepo.createAccount({
      id: randomUUID(),
      externalSubject: "demo-player-session03",
    });
    const accountPrincipal: AuthorityPrincipal = {
      kind: "authenticated_account",
      accountId: account.id,
    };
    const systemPrincipal: AuthorityPrincipal = {
      kind: "internal_system_authority",
      actorId: "world-quest-rewarder",
    };

    let engine = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(pgCtx.pool),
      logger,
    });

    // 5–8. Create a Goblin character with Dwarven guild culture, noble origin, modular appearance, and Paladin build!
    const goblinCreate = await engine.createCharacter({
      commandId: "demo03:create:goblin-paladin",
      principal: accountPrincipal,
      accountId: account.id,
      characterName: "Zîg Escudo-Dourado",
      raceCode: "goblins",
      lineageCode: "goblin_engineer",
      cultureCode: "ironforge_guildpact",
      backgroundCode: "noble_heir",
      originRegionId: "granite-peaks",
      hometownSettlementRef: "settlement-ironford",
      appearance: {
        bodyPreset: "nimble_compact_a",
        skinTone: "moss_green",
        hairStyle: "braided_crown",
        hairColor: "iron_grey",
        eyeStyle: "round_bright",
        eyeColor: "amber_gold",
        earStyle: "long_batwing",
        scars: ["left_brow_slash"],
        cosmeticAccessories: ["scholar_spectacles"],
      },
      presetCode: "paladin", // Fortitude +18, Wisdom +18, Determination +14 = 50 allocated
    });
    assert.equal(goblinCreate.status, "applied");
    const goblinId = goblinCreate.data.id;

    // Demonstrate race-independent emergent builds on the same account:
    // Orc Arcanist raised in multicultural Arcane Collegium + Draconian Farmer/Merchant!
    const orcArcanist = await engine.createCharacter({
      commandId: "demo03:create:orc-arcanist",
      principal: accountPrincipal,
      accountId: account.id,
      characterName: "Mogra Solis",
      raceCode: "orcs",
      lineageCode: "orc_whitefang",
      cultureCode: "arcane_collegium",
      backgroundCode: "arcane_scholar",
      originRegionId: "region-thornreach",
      appearance: {
        bodyPreset: "towering_broad_a",
        skinTone: "ashen_frost",
        hairStyle: "topknot_warrior",
        hairColor: "frost_white",
        eyeStyle: "deep_set",
        eyeColor: "violet_mist",
        earStyle: "pointed_stout",
        tattoos: ["lunar_crescent"],
      },
      presetCode: "arcanist",
    });
    assert.equal(orcArcanist.status, "applied");

    const draconianMerchant = await engine.createCharacter({
      commandId: "demo03:create:draconian-farmer-merchant",
      principal: accountPrincipal,
      accountId: account.id,
      characterName: "Saphira Vane",
      raceCode: "draconians",
      lineageCode: "draconian_ice",
      cultureCode: "valewatch_civic",
      backgroundCode: "farmer",
      originRegionId: "region-ashvale",
      appearance: {
        bodyPreset: "scaled_athletic_a",
        skinTone: "frost_blue",
        eyeStyle: "slit_draconic",
        eyeColor: "silver_pale",
        hornStyle: "swept_crown",
        tailStyle: "plated_long",
        scalePattern: "smooth_iridescent",
      },
      presetCode: "merchant",
    });
    assert.equal(draconianMerchant.status, "applied");

    // 9–10. Grant authorized XP (500 XP -> jumps Level 1 -> Level 3, awarding +4 attribute points)
    const xpGrant = await engine.grantExperience({
      grantId: "demo03:xp:quest-ashvale-relief-01",
      principal: systemPrincipal,
      characterId: goblinId,
      sourceType: "quest",
      sourceReference: "quest:ashvale-relief",
      amount: "500",
    });
    assert.equal(xpGrant.status, "applied");
    assert.equal(xpGrant.data.character.level, 3);
    assert.equal(xpGrant.data.character.unspentAttributePoints, 4);

    // 11. Distribute newly earned 4 points (BuildVersion 1 -> 2)
    const allocAfterLevelUp = await engine.allocateAttributes({
      commandId: "demo03:alloc:goblin-lv3",
      principal: accountPrincipal,
      characterId: goblinId,
      expectedBuildVersion: 1,
      attributeDeltas: { charisma: 4 },
    });
    assert.equal(allocAfterLevelUp.data.buildVersion, 2);
    assert.equal(allocAfterLevelUp.data.unspentAttributePoints, 0);

    // 12–13. Execute Respec (BuildVersion 2 -> 3, recovers all 54 earned points) & reallocate hybrid build (BuildVersion 3 -> 4)
    const respecRes = await engine.respecAttributes({
      commandId: "demo03:respec:goblin-01",
      principal: accountPrincipal,
      characterId: goblinId,
      expectedBuildVersion: 2,
    });
    assert.equal(respecRes.data.buildVersion, 3);
    assert.equal(respecRes.data.unspentAttributePoints, 54);
    assert.equal(respecRes.data.allocatedAttributePoints, 0);

    const customBuild = await engine.allocateAttributes({
      commandId: "demo03:alloc:goblin-arcane-tinker",
      principal: accountPrincipal,
      characterId: goblinId,
      expectedBuildVersion: 3,
      attributeDeltas: {
        intelligence: 20,
        dexterity: 18,
        fortitude: 10,
        luck: 6,
      },
    });
    assert.equal(customBuild.data.buildVersion, 4);
    assert.equal(customBuild.data.unspentAttributePoints, 0);

    // 14–15. Re-deliver identical XP event -> confirm zero duplication
    const duplicateXp = await engine.grantExperience({
      grantId: "demo03:xp:quest-ashvale-relief-01",
      principal: systemPrincipal,
      characterId: goblinId,
      sourceType: "quest",
      sourceReference: "quest:ashvale-relief",
      amount: "500",
    });
    assert.equal(duplicateXp.status, "duplicate_idempotent");
    assert.equal(duplicateXp.data.character.experienceTotal, 500n);
    assert.equal(duplicateXp.data.character.level, 3);

    // 16–17. Attempt illegal attribute allocation (exceeding unspent budget) -> confirm rejection without partial effects
    let illegalRejected = false;
    try {
      await engine.allocateAttributes({
        commandId: "demo03:alloc:illegal-overbudget",
        principal: accountPrincipal,
        characterId: goblinId,
        expectedBuildVersion: 4,
        attributeDeltas: { strength: 10 },
      });
    } catch (err) {
      if (err instanceof AttributeAllocationInvalidError) {
        illegalRejected = true;
      } else {
        throw err;
      }
    }
    assert.equal(illegalRejected, true);
    const unchangedAfterIllegal = await charRepo.findCharacterById(goblinId);
    assert.equal(unchangedAfterIllegal?.buildVersion, 4);
    assert.equal(unchangedAfterIllegal?.allocatedAttributes.strength, 0);

    // 18. Produce versioned CharacterSnapshot & run Progression Simulation summary
    const snapshotReader = new PostgresCharacterSnapshotReader(pgCtx.pool);
    const goblinSnapshot = await snapshotReader.getCharacterSnapshot(goblinId, {
      principal: systemPrincipal,
      normalizationProfile: "legacy_ranked_md3",
    });
    const wireSnapshot = serializeCharacterSnapshotWireV1(goblinSnapshot);
    assert.equal("account_id" in wireSnapshot, false);
    assert.equal(wireSnapshot.build_version, 4);
    assert.equal(wireSnapshot.experience_total, "500");

    const simReport = runProgressionSimulationHarness();
    logger.info("Step 18: CharacterSnapshot & Progression Simulation verified", {
      operation: "demo03:snapshot",
      snapshot: wireSnapshot,
      curve_max_level_xp: simReport.fullCurve[simReport.fullCurve.length - 1]?.cumulativeXpRequired,
      cap_saturation_level: simReport.capSaturationLevel,
    });

    // 19–20. Restart PostgreSQL server / reconnect pool and confirm durable recovery
    const reconnectedPool = await pgCtx.restartAndReconnect();
    charRepo = new PostgresCharacterRepository(reconnectedPool);
    const postRestartReader = new PostgresCharacterSnapshotReader(reconnectedPool);
    engine = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(reconnectedPool),
      logger,
    });

    const recoveredGoblin = await postRestartReader.getCharacterSnapshot(goblinId, {
      principal: accountPrincipal,
    });
    const recoveredAccountChars = await charRepo.listCharactersByAccount(account.id);
    assert.equal(recoveredAccountChars.length, 3);
    assert.equal(recoveredGoblin.buildVersion, 4);
    assert.equal(recoveredGoblin.progression.experienceTotal, 500n);
    assert.equal(recoveredGoblin.allocatedAttributes.intelligence, 20);

    logger.info("Step 20: Persistent recovery confirmed across all 3 diverse characters", {
      operation: "demo03:complete",
      result: "ok",
      embedded_postgres_restarted: pgCtx.isEmbedded,
      characters_recovered: recoveredAccountChars.map((c) => `${c.displayName} (${c.raceCode})`),
    });
  } finally {
    await pgCtx.stop();
  }
}

runSession03Demo().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`Session 03 demo failed: ${msg}\n`);
  process.exitCode = 1;
});
