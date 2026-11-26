import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CharacterEngineService } from "../../src/modules/characters/application/character-engine-service.js";
import {
  PostgresCharacterSnapshotReader,
  parseCharacterSnapshotWireV1,
  serializeCharacterSnapshotWireV1,
} from "../../src/modules/characters/application/character-snapshot-query.js";
import type { AuthorityPrincipal } from "../../src/modules/characters/domain/character.js";
import {
  AccountCharacterLimitReachedError,
  AttributeAllocationInvalidError,
  CharacterBuildConflictError,
  CharacterCompetitiveLockedError,
  CharacterNameInvalidError,
  CharacterNameTakenError,
  CharacterNotFoundError,
  CharacterOwnershipForbiddenError,
  ExperienceGrantInvalidError,
  GenesisTemporaryStatePersistenceForbiddenError,
  LineageIncompatibleError,
  PeopleDisabledError,
} from "../../src/modules/characters/domain/errors.js";
import {
  PostgresCharacterRepository,
  PostgresCharacterUnitOfWork,
} from "../../src/modules/characters/infrastructure/postgres-character-unit-of-work.js";
import { IncompatibleAppearanceError } from "../../src/modules/peoples/domain/appearance.js";
import { PostgresCatalogRepository } from "../../src/modules/peoples/infrastructure/postgres-catalog-repository.js";
import { MAX_INT64 } from "../../src/shared/contracts/int64-wire.js";
import {
  discoverMigrations,
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

const SYSTEM_AUTHORITY: AuthorityPrincipal = {
  kind: "internal_system_authority",
  actorId: "test-progression-authority",
};

describe("CARBON Session 03 — Persistent Characters, Attributes, Progression & Concurrency (Real PostgreSQL)", () => {
  let pgCtx: RunningPostgresTestContext;
  let charSnapshotSchema: JsonSchemaNode;
  const silentLogger = new StructuredLogger("silent");

  before(async () => {
    pgCtx = await startPostgresTestContext();
    charSnapshotSchema = JSON.parse(
      await readFile(CHAR_SNAPSHOT_SCHEMA_PATH, "utf8"),
    ) as JsonSchemaNode;
  });

  after(async () => {
    if (pgCtx) {
      await pgCtx.stop();
    }
  });

  it("Test 34: Incremental migrations 0004 & 0005 apply cleanly over populated 0001..0003 DB and support full down/up cycle", async () => {
    const existing = await listAppliedMigrations(pgCtx.pool);
    if (existing.length > 0) {
      await migrateDown(pgCtx.pool, MIGRATIONS_DIR, existing.length);
    }

    // Apply 0001..0003 first to simulate an existing Session 02 database
    const allMigs = await discoverMigrations(MIGRATIONS_DIR);
    for (const mig of allMigs.filter((m) => Number(m.version) <= 3)) {
      const sql = await readFile(mig.upPath, "utf8");
      await pgCtx.pool.query("BEGIN");
      await pgCtx.pool.query(sql);
      await pgCtx.pool.query(
        "INSERT INTO schema_migrations (version, name) VALUES ($1, $2)",
        [mig.version, mig.name],
      );
      await pgCtx.pool.query("COMMIT");
    }

    // Seed a Session 02 contribution with unmapped NEON player_id ("player-kael")
    await pgCtx.pool.query(
      `INSERT INTO processed_events (event_id, external_event_id, idempotency_key, event_type, event_version, source, correlation_id, aggregate_id, received_at, payload_fingerprint)
       VALUES ($1, 'sim:s2:inv:1:contrib:player-kael', 'sim:s2:inv:1:contrib:player-kael', 'ContributionRecorded', 1, 'neon', $2, $3, NOW(), 'fp:v1:1234567890abcdef')`,
      [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
      ],
    );
    await pgCtx.pool.query(
      `INSERT INTO gameplay_contributions (id, processed_event_id, external_event_id, contract_version, simulation_id, invasion_id, settlement_ref, player_id, simulation_tick, damage, support, objectives, eligible, outcome, payload_fingerprint, received_at)
       VALUES ($1, $2, 'sim:s2:inv:1:contrib:player-kael', 1, 's2', '1', 'settlement-valewatch', 'player-kael', 50, 200, 0, 1, TRUE, 'Defended', 'fp:v1:1234567890abcdef', NOW())`,
      [
        "44444444-4444-4444-8444-444444444444",
        "11111111-1111-4111-8111-111111111111",
      ],
    );

    // Apply incremental 0004 & 0005 without touching or breaking legacy contribution!
    const newlyApplied = await migrateUp(pgCtx.pool, MIGRATIONS_DIR);
    assert.deepEqual(newlyApplied, [
      "0004_peoples_catalog_and_progression_rules",
      "0005_accounts_characters_attributes_and_progression",
    ]);

    const checkLegacyContrib = await pgCtx.pool.query(
      "SELECT player_id FROM gameplay_contributions WHERE external_event_id = 'sim:s2:inv:1:contrib:player-kael'",
    );
    assert.equal(checkLegacyContrib.rows[0]?.player_id, "player-kael");

    // Seed catalogs & progression rules for subsequent tests
    const catalogRepo = new PostgresCatalogRepository(pgCtx.pool);
    const charRepo = new PostgresCharacterRepository(pgCtx.pool);
    await catalogRepo.seedInitialCatalogs();
    await charRepo.seedProgressionRules();
  });

  it("Tests 1..10: Account creation, multi-character limit, duplicate/invalid names (concurrent race), disabled people, incompatible lineage, decoupled culture/origin, and valid/invalid appearance", async () => {
    const charRepo = new PostgresCharacterRepository(pgCtx.pool);
    const engine = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(pgCtx.pool),
      logger: silentLogger,
    });

    // Test 1: Account creation (with maxCharactersOverride = 2 to test multi-character ceiling)
    const accA = await charRepo.createAccount({
      id: randomUUID(),
      externalSubject: `subj-${randomUUID()}`,
      maxCharactersOverride: 2,
    });
    const accB = await charRepo.createAccount({
      id: randomUUID(),
      externalSubject: `subj-${randomUUID()}`,
    });
    const principalA: AuthorityPrincipal = { kind: "authenticated_account", accountId: accA.id };
    const principalB: AuthorityPrincipal = { kind: "authenticated_account", accountId: accB.id };

    // Test 2 & 8 & 9: Create Orc Arcanist raised in Human walled city + valid appearance
    const c1 = await engine.createCharacter({
      principal: principalA,
      accountId: accA.id,
      characterName: "Kaelen Vane",
      raceCode: "orcs",
      lineageCode: "orc_ironblood",
      cultureCode: "valewatch_civic",
      backgroundCode: "arcane_scholar",
      originRegionId: "region-ashvale",
      appearance: {
        bodyPreset: "athletic_a",
        skinTone: "iron_grey",
        hairStyle: "short_cropped",
        hairColor: "raven_black",
        eyeStyle: "fierce_narrow",
        eyeColor: "amber_gold",
        earStyle: "pointed_stout",
      },
      presetCode: "arcanist",
    });
    assert.equal(c1.status, "applied");
    assert.equal(c1.data.allocatedAttributes.intelligence, 22);

    // Test 3: Second character on same account (Draconian Farmer with valid scales/horns/tail)
    const c2 = await engine.createCharacter({
      principal: principalA,
      accountId: accA.id,
      characterName: "Vaelis Brasa",
      raceCode: "draconians",
      lineageCode: "draconian_fire",
      cultureCode: "steppe_caravaneers",
      backgroundCode: "farmer",
      originRegionId: "red-dunes",
      appearance: {
        bodyPreset: "scaled_vanguard_a",
        skinTone: "ember_red",
        eyeStyle: "slit_draconic",
        eyeColor: "crimson_ember",
        hornStyle: "curved_ram",
        tailStyle: "crested_heavy",
        scalePattern: "ancient_plated",
      },
    });
    assert.equal(c2.status, "applied");

    // 3rd character on accA (maxCharactersOverride = 2) -> rejected!
    await assert.rejects(
      () =>
        engine.createCharacter({
          principal: principalA,
          accountId: accA.id,
          characterName: "Third Overflow",
          raceCode: "humans",
          lineageCode: "human_valorian",
          cultureCode: "valewatch_civic",
          backgroundCode: "explorer",
          originRegionId: "region-ashvale",
          appearance: {
            bodyPreset: "athletic_a",
            skinTone: "warm_ivory",
            eyeStyle: "almond_sharp",
            eyeColor: "slate_blue",
          },
        }),
      AccountCharacterLimitReachedError,
    );

    // Test 4a: Accent/case duplicate ("kaélen vane" collides with "Kaelen Vane")
    await assert.rejects(
      () =>
        engine.createCharacter({
          principal: principalB,
          accountId: accB.id,
          characterName: "kaélen vane",
          raceCode: "humans",
          lineageCode: "human_valorian",
          cultureCode: "valewatch_civic",
          backgroundCode: "hunter",
          originRegionId: "region-ashvale",
          appearance: {
            bodyPreset: "athletic_a",
            skinTone: "warm_ivory",
            eyeStyle: "almond_sharp",
            eyeColor: "slate_blue",
          },
        }),
      CharacterNameTakenError,
    );

    // Test 4b: Concurrent simultaneous creation of the exact same character name across 2 accounts!
    const racedName = `RacedHero${randomUUID().slice(0, 4).replace(/[0-9]/g, "a")}`;
    const raceCreates = await Promise.allSettled([
      engine.createCharacter({
        principal: principalB,
        accountId: accB.id,
        characterName: racedName,
        raceCode: "elves",
        lineageCode: "elf_lunar",
        cultureCode: "verdant_circle",
        backgroundCode: "hunter",
        originRegionId: "green-hollow",
        appearance: {
          bodyPreset: "lean_a",
          skinTone: "moonlit_silver",
          eyeStyle: "almond_sharp",
          eyeColor: "silver_pale",
          earStyle: "pointed_long",
        },
      }),
      engine.createCharacter({
        principal: principalB,
        accountId: accB.id,
        characterName: racedName.toUpperCase(),
        raceCode: "dwarves",
        lineageCode: "dwarf_mountain",
        cultureCode: "ironforge_guildpact",
        backgroundCode: "blacksmith_apprentice",
        originRegionId: "granite-peaks",
        appearance: {
          bodyPreset: "stocky_a",
          skinTone: "granite_tan",
          eyeStyle: "deep_set",
          eyeColor: "amber_gold",
          beardStyle: "forgemaster_braids",
        },
      }),
    ]);
    assert.equal(raceCreates.filter((r) => r.status === "fulfilled").length, 1);
    const rejectedNameRace = raceCreates.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    assert.equal(rejectedNameRace.length, 1);
    assert.ok(rejectedNameRace[0]?.reason instanceof CharacterNameTakenError);

    // Test 5: Invalid character name
    await assert.rejects(
      () =>
        engine.createCharacter({
          principal: principalB,
          accountId: accB.id,
          characterName: "Bad\u200BName",
          raceCode: "humans",
          lineageCode: "human_valorian",
          cultureCode: "valewatch_civic",
          backgroundCode: "explorer",
          originRegionId: "region-ashvale",
          appearance: {
            bodyPreset: "athletic_a",
            skinTone: "warm_ivory",
            eyeStyle: "almond_sharp",
            eyeColor: "slate_blue",
          },
        }),
      CharacterNameInvalidError,
    );

    // Test 6: Disabled people (`forged` is registered among 26, but disabled)
    await assert.rejects(
      () =>
        engine.createCharacter({
          principal: principalB,
          accountId: accB.id,
          characterName: "Unit Seven",
          raceCode: "forged",
          lineageCode: "forged_runecore",
          cultureCode: "ironforge_guildpact",
          backgroundCode: "blacksmith_apprentice",
          originRegionId: "granite-peaks",
          appearance: {
            bodyPreset: "athletic_a",
            skinTone: "warm_ivory",
            eyeStyle: "almond_sharp",
            eyeColor: "slate_blue",
          },
        }),
      PeopleDisabledError,
    );

    // Test 7: Incompatible lineage (`humans` + `goblin_engineer`)
    await assert.rejects(
      () =>
        engine.createCharacter({
          principal: principalB,
          accountId: accB.id,
          characterName: "Mismatch Hero",
          raceCode: "humans",
          lineageCode: "goblin_engineer",
          cultureCode: "valewatch_civic",
          backgroundCode: "explorer",
          originRegionId: "region-ashvale",
          appearance: {
            bodyPreset: "athletic_a",
            skinTone: "warm_ivory",
            eyeStyle: "almond_sharp",
            eyeColor: "slate_blue",
          },
        }),
      LineageIncompatibleError,
    );

    // Test 10: Incompatible appearance (`humans` with `hornStyle`)
    await assert.rejects(
      () =>
        engine.createCharacter({
          principal: principalB,
          accountId: accB.id,
          characterName: "Horned Human",
          raceCode: "humans",
          lineageCode: "human_valorian",
          cultureCode: "valewatch_civic",
          backgroundCode: "explorer",
          originRegionId: "region-ashvale",
          appearance: {
            bodyPreset: "athletic_a",
            skinTone: "warm_ivory",
            eyeStyle: "almond_sharp",
            eyeColor: "slate_blue",
            hornStyle: "swept_crown",
          },
        }),
      IncompatibleAppearanceError,
    );
  });

  it("Tests 11..26: Attributes, budget/cap enforcement, concurrent allocation, multi-level XP, max level, XP overflow/duplicates/conflicts, respec, concurrent respec+XP, and stale BuildVersion", async () => {
    const charRepo = new PostgresCharacterRepository(pgCtx.pool);
    const engine = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(pgCtx.pool),
      logger: silentLogger,
    });

    const acc = await charRepo.createAccount({ id: randomUUID() });
    const owner: AuthorityPrincipal = { kind: "authenticated_account", accountId: acc.id };

    const created = await engine.createCharacter({
      principal: owner,
      accountId: acc.id,
      characterName: "Lyra Pedra-Fria",
      raceCode: "dwarves",
      lineageCode: "dwarf_volcanic",
      cultureCode: "ironforge_guildpact",
      backgroundCode: "veteran_soldier",
      originRegionId: "granite-peaks",
      appearance: {
        bodyPreset: "forged_broad_a",
        skinTone: "ember_ruddy",
        hairStyle: "braided_crown",
        hairColor: "copper_red",
        eyeStyle: "deep_set",
        eyeColor: "amber_gold",
        beardStyle: "forgemaster_braids",
        earStyle: "rounded_broad",
      },
    });
    const charId = created.data.id;
    assert.equal(created.data.unspentAttributePoints, 50);

    // Test 12: Unknown attribute rejected
    await assert.rejects(
      () =>
        engine.allocateAttributes({
          commandId: `cmd-unk-${randomUUID()}`,
          principal: owner,
          characterId: charId,
          expectedBuildVersion: 1,
          attributeDeltas: { telekinesis: 5 },
        }),
      AttributeAllocationInvalidError,
    );

    // Test 14: Over-budget allocation (51 > 50) rejected
    await assert.rejects(
      () =>
        engine.allocateAttributes({
          commandId: `cmd-over-${randomUUID()}`,
          principal: owner,
          characterId: charId,
          expectedBuildVersion: 1,
          attributeDeltas: { strength: 25, fortitude: 25, vigor: 1 },
        }),
      AttributeAllocationInvalidError,
    );

    // Test 15: Per-attribute cap exceeded (5 base + 26 = 31 > 30) rejected
    await assert.rejects(
      () =>
        engine.allocateAttributes({
          commandId: `cmd-cap-${randomUUID()}`,
          principal: owner,
          characterId: charId,
          expectedBuildVersion: 1,
          attributeDeltas: { strength: 26 },
        }),
      AttributeAllocationInvalidError,
    );

    // Test 13 & 16: Concurrent competing allocations targeting expectedBuildVersion = 1 -> 1 succeeds, 1 conflicts!
    const concAllocs = await Promise.allSettled([
      engine.allocateAttributes({
        commandId: `cmd-conc-alloc-A-${randomUUID()}`,
        principal: owner,
        characterId: charId,
        expectedBuildVersion: 1,
        attributeDeltas: { strength: 25, fortitude: 25 },
      }),
      engine.allocateAttributes({
        commandId: `cmd-conc-alloc-B-${randomUUID()}`,
        principal: owner,
        characterId: charId,
        expectedBuildVersion: 1,
        attributeDeltas: { intelligence: 25, wisdom: 25 },
      }),
    ]);
    assert.equal(concAllocs.filter((r) => r.status === "fulfilled").length, 1);
    const rejectedAlloc = concAllocs.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    assert.equal(rejectedAlloc.length, 1);
    assert.ok(rejectedAlloc[0]?.reason instanceof CharacterBuildConflictError);

    // Test 26: Stale expectedBuildVersion (1 when actual is 2) rejected explicitly
    await assert.rejects(
      () =>
        engine.allocateAttributes({
          commandId: `cmd-stale-${randomUUID()}`,
          principal: owner,
          characterId: charId,
          expectedBuildVersion: 1,
          attributeDeltas: { luck: 1 },
        }),
      CharacterBuildConflictError,
    );

    // Direct player account principal attempting to grant XP -> forbidden!
    await assert.rejects(
      () =>
        engine.grantExperience({
          grantId: `xp-unauth-${randomUUID()}`,
          principal: owner,
          characterId: charId,
          sourceType: "quest",
          sourceReference: "cheat",
          amount: "1000",
        }),
      CharacterOwnershipForbiddenError,
    );

    // Tests 17 & 18: Valid XP grant jumping multiple levels (7000 XP -> Level 10, +18 points)
    const xpGrantId = `xp-multi-${randomUUID()}`;
    const xp1 = await engine.grantExperience({
      grantId: xpGrantId,
      principal: SYSTEM_AUTHORITY,
      characterId: charId,
      sourceType: "boss",
      sourceReference: "boss:ashvale-wyrm",
      amount: "7000",
    });
    assert.equal(xp1.status, "applied");
    assert.equal(xp1.data.character.level, 10);
    assert.equal(xp1.data.character.earnedAttributePoints, 68);
    assert.equal(xp1.data.character.unspentAttributePoints, 18);

    // Test 21: Duplicate identical XP grant -> duplicate_idempotent
    const xpDup = await engine.grantExperience({
      grantId: xpGrantId,
      principal: SYSTEM_AUTHORITY,
      characterId: charId,
      sourceType: "boss",
      sourceReference: "boss:ashvale-wyrm",
      amount: "7000",
    });
    assert.equal(xpDup.status, "duplicate_idempotent");
    assert.equal(xpDup.data.character.experienceTotal, 7000n);

    // Test 22: Conflicting XP grant reusing same grantId with different amount -> conflict!
    await assert.rejects(
      () =>
        engine.grantExperience({
          grantId: xpGrantId,
          principal: SYSTEM_AUTHORITY,
          characterId: charId,
          sourceType: "boss",
          sourceReference: "boss:ashvale-wyrm",
          amount: "99999",
        }),
      InboxIdempotencyConflictError,
    );

    // Competitive lock blocks respec during an active ranked series
    await charRepo.setCharacterCompetitiveLock(charId, "in_ranked_series");
    await assert.rejects(
      () =>
        engine.respecAttributes({
          commandId: `respec-locked-${randomUUID()}`,
          principal: owner,
          characterId: charId,
          expectedBuildVersion: 2,
        }),
      CharacterCompetitiveLockedError,
    );
    await charRepo.setCharacterCompetitiveLock(charId, "none");

    // Tests 23, 24 & 25: Concurrent Respec vs Level-Up XP + Duplicate Respec!
    const respecCmdId = `respec-conc-${randomUUID()}`;
    const [respecOut, concurrentXpOut, rivalRespecOut] = await Promise.allSettled([
      engine.respecAttributes({
        commandId: respecCmdId,
        principal: owner,
        characterId: charId,
        expectedBuildVersion: 2,
      }),
      engine.grantExperience({
        grantId: `xp-conc-with-respec-${randomUUID()}`,
        principal: SYSTEM_AUTHORITY,
        characterId: charId,
        sourceType: "exploration",
        sourceReference: "region:granite-peaks",
        amount: "800000", // Pushes to Max Level 100! (Test 19)
      }),
      engine.respecAttributes({
        commandId: `respec-rival-${randomUUID()}`,
        principal: owner,
        characterId: charId,
        expectedBuildVersion: 2,
      }),
    ]);

    // Exactly ONE of the two competing respecs (expectedBuildVersion=2) succeeds, AND XP grant succeeds!
    const respecResults = [respecOut, rivalRespecOut];
    assert.equal(respecResults.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(respecResults.filter((r) => r.status === "rejected").length, 1);
    assert.equal(concurrentXpOut.status, "fulfilled");

    // Test 24: Re-sending the winning respec commandId returns duplicate_idempotent
    const winningRespecCmdId =
      respecOut.status === "fulfilled" ? respecCmdId : "other";
    if (winningRespecCmdId === respecCmdId) {
      const dupRespec = await engine.respecAttributes({
        commandId: respecCmdId,
        principal: owner,
        characterId: charId,
        expectedBuildVersion: 2,
      });
      assert.equal(dupRespec.status, "duplicate_idempotent");
    }

    // Verify Test 19 (Max Level 100 cap & conservation law allocated + unspent === earned = 248!)
    const atMax = await charRepo.findCharacterById(charId);
    assert.ok(atMax);
    assert.equal(atMax.level, 100);
    assert.equal(atMax.earnedAttributePoints, 248);
    assert.equal(atMax.allocatedAttributePoints, 0);
    assert.equal(atMax.unspentAttributePoints, 248);
    assert.equal(atMax.buildVersion, 3);

    // Additional XP at max level stays capped at Level 100 without awarding extra points
    const extraMaxXp = await engine.grantExperience({
      grantId: `xp-beyond-cap-${randomUUID()}`,
      principal: SYSTEM_AUTHORITY,
      characterId: charId,
      sourceType: "world_event",
      sourceReference: "event:titan-fall",
      amount: "10000",
    });
    assert.equal(extraMaxXp.data.character.level, 100);
    assert.equal(extraMaxXp.data.character.earnedAttributePoints, 248);

    // Test 20: Experience int64 overflow rejected without mutating character
    await assert.rejects(
      () =>
        engine.grantExperience({
          grantId: `xp-overflow-${randomUUID()}`,
          principal: SYSTEM_AUTHORITY,
          characterId: charId,
          sourceType: "dev_authorized",
          sourceReference: "overflow-check",
          amount: MAX_INT64,
        }),
      ExperienceGrantInvalidError,
    );
  });

  it("Tests 27, 28, 29, 30, 31, 32, 33 & 36: CharacterSnapshot, cross-account isolation, bigint wire, rollback, outbox, Genesis block, and PostgreSQL restart recovery", async () => {
    let charRepo = new PostgresCharacterRepository(pgCtx.pool);
    const engine = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(pgCtx.pool),
      logger: silentLogger,
    });
    let snapshotReader = new PostgresCharacterSnapshotReader(pgCtx.pool);

    const ownerAcc = await charRepo.createAccount({ id: randomUUID() });
    const intruderAcc = await charRepo.createAccount({ id: randomUUID() });
    const ownerPrincipal: AuthorityPrincipal = {
      kind: "authenticated_account",
      accountId: ownerAcc.id,
    };
    const intruderPrincipal: AuthorityPrincipal = {
      kind: "authenticated_account",
      accountId: intruderAcc.id,
    };

    const hero = await engine.createCharacter({
      commandId: `hero-create-${randomUUID()}`,
      principal: ownerPrincipal,
      accountId: ownerAcc.id,
      characterName: "Thalion Sol",
      raceCode: "elves",
      lineageCode: "elf_solar",
      cultureCode: "arcane_collegium",
      backgroundCode: "noble_heir",
      originRegionId: "region-thornreach",
      appearance: {
        bodyPreset: "lean_b",
        skinTone: "sunlit_bronze",
        hairStyle: "windswept_long",
        hairColor: "sun_gold",
        eyeStyle: "almond_sharp",
        eyeColor: "emerald_green",
        earStyle: "pointed_swept",
      },
      presetCode: "arcane_knight",
    });
    const heroId = hero.data.id;

    // Grant large 64-bit experience (> 2^53 - 1) to verify exact bigint serialization (Test 30)
    const hugeXp = 9007199254740999n;
    await engine.grantExperience({
      grantId: `xp-huge-64bit-${randomUUID()}`,
      principal: SYSTEM_AUTHORITY,
      characterId: heroId,
      sourceType: "dev_authorized",
      sourceReference: "bigint-wire-test",
      amount: hugeXp,
    });

    // Test 27 & 30: Snapshot query, JSON Schema validation, and exact bigint string roundtrip
    const snap = await snapshotReader.getCharacterSnapshot(heroId, {
      principal: ownerPrincipal,
      normalizationProfile: "legacy_ranked_md3",
    });
    const wire = serializeCharacterSnapshotWireV1(snap);
    assert.equal(wire.experience_total, "9007199254740999");
    assert.equal("account_id" in wire, false);
    assert.deepEqual(wire.equipped_items, []);
    assert.deepEqual(wire.equipped_abilities, []);
    assert.equal(validateAgainstJsonSchema(charSnapshotSchema, wire).valid, true);
    const parsedBack = parseCharacterSnapshotWireV1(wire);
    assert.equal(parsedBack.progression.experienceTotal, hugeXp);

    // Test 28: Non-existent character snapshot
    await assert.rejects(
      () =>
        snapshotReader.getCharacterSnapshot(randomUUID(), {
          principal: SYSTEM_AUTHORITY,
        }),
      CharacterNotFoundError,
    );

    // Test 29: Cross-account access & mutation forbidden
    await assert.rejects(
      () =>
        snapshotReader.getCharacterSnapshot(heroId, {
          principal: intruderPrincipal,
        }),
      CharacterOwnershipForbiddenError,
    );
    await assert.rejects(
      () =>
        engine.respecAttributes({
          commandId: `intruder-respec-${randomUUID()}`,
          principal: intruderPrincipal,
          characterId: heroId,
          expectedBuildVersion: 1,
        }),
      CharacterOwnershipForbiddenError,
    );

    // Test 36: Genesis Ranked temporary build persistence strictly forbidden across all commands
    await assert.rejects(
      () =>
        engine.allocateAttributes({
          commandId: `genesis-illegal-alloc-${randomUUID()}`,
          principal: ownerPrincipal,
          characterId: heroId,
          expectedBuildVersion: 1,
          attributeDeltas: { strength: 2 },
          executionProfile: "genesis_ranked_md3_scratch",
        }),
      GenesisTemporaryStatePersistenceForbiddenError,
    );
    await assert.rejects(
      () =>
        engine.grantExperience({
          grantId: `genesis-illegal-xp-${randomUUID()}`,
          principal: SYSTEM_AUTHORITY,
          characterId: heroId,
          sourceType: "dev_authorized",
          sourceReference: "genesis-arena",
          amount: "100",
          executionProfile: "genesis_ranked_md3_scratch",
        }),
      GenesisTemporaryStatePersistenceForbiddenError,
    );

    // Test 32: Transactional Rollback on mid-transaction failure leaves zero partial state
    const failingEngine = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(pgCtx.pool),
      logger: silentLogger,
      beforeCommitHook: async () => {
        throw new Error("Simulated pre-commit crash in CharacterEngine");
      },
    });
    const rollbackAllocId = `rollback-alloc-${randomUUID()}`;
    await assert.rejects(
      () =>
        failingEngine.allocateAttributes({
          commandId: rollbackAllocId,
          principal: ownerPrincipal,
          characterId: heroId,
          expectedBuildVersion: 1,
          attributeDeltas: { vigor: 10 },
        }),
      /Simulated pre-commit crash/,
    );
    const afterRollback = await charRepo.findCharacterById(heroId);
    assert.equal(afterRollback?.buildVersion, 1);
    assert.equal(afterRollback?.allocatedAttributes.vigor, 0);

    // Test 33: Outbox integrity (`CharacterCreated`, `CharacterBuildChanged`, `CharacterExperienceGranted`, `CharacterLevelUp` with publishedAt === null)
    const outboxEvents = await charRepo.listCharacterOutboxEvents(heroId);
    const eventTypes = outboxEvents.map((e) => e.eventType);
    assert.ok(eventTypes.includes("CharacterCreated"));
    assert.ok(eventTypes.includes("CharacterBuildChanged"));
    assert.ok(eventTypes.includes("CharacterExperienceGranted"));
    assert.ok(eventTypes.includes("CharacterLevelUp"));
    for (const ev of outboxEvents) {
      assert.equal(ev.publishedAt, null);
    }

    // Test 31: Restart real PostgreSQL server and confirm full persistence recovery
    const poolAfterRestart = await pgCtx.restartAndReconnect();
    charRepo = new PostgresCharacterRepository(poolAfterRestart);
    snapshotReader = new PostgresCharacterSnapshotReader(poolAfterRestart);

    const recoveredSnap = await snapshotReader.getCharacterSnapshot(heroId, {
      principal: ownerPrincipal,
    });
    assert.equal(recoveredSnap.progression.experienceTotal, hugeXp);
    assert.equal(recoveredSnap.progression.level, 100);
    assert.equal(recoveredSnap.allocatedAttributes.strength, 18);
  });
});
