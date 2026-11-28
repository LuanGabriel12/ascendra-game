import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CharacterEngineService } from "../../src/modules/characters/application/character-engine-service.js";
import { sumAttributeBlock } from "../../src/modules/characters/domain/attributes-and-presets.js";
import {
  PostgresCharacterRepository,
  PostgresCharacterUnitOfWork,
} from "../../src/modules/characters/infrastructure/postgres-character-unit-of-work.js";
import { RecordContributionService } from "../../src/modules/contributions/application/record-contribution-service.js";
import { PostgresContributionUnitOfWork } from "../../src/modules/contributions/infrastructure/postgres-contribution-unit-of-work.js";
import { InventoryEngineService } from "../../src/modules/inventory/application/inventory-engine-service.js";
import { SplitMix64Rng } from "../../src/modules/inventory/domain/splitmix64-rng.js";
import { PostgresInventoryRepository } from "../../src/modules/inventory/infrastructure/postgres-inventory-unit-of-work.js";
import { PostgresCatalogRepository } from "../../src/modules/peoples/infrastructure/postgres-catalog-repository.js";
import { SkillEngineService } from "../../src/modules/skills/application/skill-engine-service.js";
import { PostgresSkillRepository } from "../../src/modules/skills/infrastructure/postgres-skill-unit-of-work.js";
import { SocialEngineService } from "../../src/modules/social/application/social-engine-service.js";
import { PostgresSocialRepository } from "../../src/modules/social/infrastructure/postgres-social-unit-of-work.js";
import {
  MigrationChecksumMismatchError,
  listAppliedMigrations,
  migrateDown,
  migrateUp,
} from "../../src/shared/db/migrator.js";
import { createPgPool, withPgTransaction } from "../../src/shared/db/pool.js";
import { StructuredLogger } from "../../src/shared/observability/logger.js";
import {
  startPostgresTestContext,
  type RunningPostgresTestContext,
} from "../helpers/postgres-test-harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

const SYSTEM_AUTH = {
  kind: "internal_system_authority" as const,
  actorId: "audit-fuzz-harness",
};

const VALID_APPEARANCE = {
  bodyPreset: "athletic_a",
  skinTone: "olive_bronze",
  hairStyle: "short_cropped",
  hairColor: "raven_black",
  eyeStyle: "almond_sharp",
  eyeColor: "slate_blue",
  earStyle: "rounded_standard",
} as const;

describe("CARBON Full Audit — Migrations, Fault Injection, Pool/Timeout Recovery & Seeded Property Fuzzing", () => {
  let pgCtx: RunningPostgresTestContext;
  const silentLogger = new StructuredLogger("silent");

  before(async () => {
    pgCtx = await startPostgresTestContext();
  });

  after(async () => {
    if (pgCtx) {
      await pgCtx.stop();
    }
  });

  it("Section 23: Concurrent migrateUp serialization via advisory lock, induced failure rollback, and checksum tamper detection", async () => {
    const pre = await listAppliedMigrations(pgCtx.pool);
    if (pre.length > 0) {
      await migrateDown(pgCtx.pool, MIGRATIONS_DIR, pre.length);
    }

    const expectedMigrationCount = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".up.sql")).length;
    assert.ok(expectedMigrationCount >= 15);

    // 1. Run 3 concurrent migrateUp calls against an empty schema -> advisory lock serializes cleanly!
    const [r1, r2, r3] = await Promise.all([
      migrateUp(pgCtx.pool, MIGRATIONS_DIR),
      migrateUp(pgCtx.pool, MIGRATIONS_DIR),
      migrateUp(pgCtx.pool, MIGRATIONS_DIR),
    ]);
    const totalApplied = r1.length + r2.length + r3.length;
    assert.equal(totalApplied, expectedMigrationCount);

    // 2. Copy migrations to a disposable directory to test checksum mismatch & induced SQL failure safely
    const tmpMigDir = await mkdtemp(path.join(os.tmpdir(), "ascendra-mig-audit-"));
    try {
      await cp(MIGRATIONS_DIR, tmpMigDir, { recursive: true });

      // Induce a failing migration 0099_broken.up.sql -> must rollback completely without leaving partial table
      await writeFile(
        path.join(tmpMigDir, "0099_induced_failure.up.sql"),
        "CREATE TABLE should_rollback_completely (id INT PRIMARY KEY);\nSELECT * FROM non_existent_table_xyz;",
        "utf8",
      );
      await assert.rejects(() => migrateUp(pgCtx.pool, tmpMigDir));

      const partialTableCheck = await pgCtx.pool.query(
        "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'should_rollback_completely'",
      );
      assert.equal(partialTableCheck.rowCount, 0);
      assert.equal((await listAppliedMigrations(pgCtx.pool)).length, expectedMigrationCount);

      // Remove broken 0099, tamper with already-applied 0001_carbon_settlement_slice.up.sql -> MUST throw MigrationChecksumMismatchError!
      await rm(path.join(tmpMigDir, "0099_induced_failure.up.sql"));
      await writeFile(
        path.join(tmpMigDir, "0001_carbon_settlement_slice.up.sql"),
        "-- TAMPERED RETROACTIVELY\nSELECT 1;",
        "utf8",
      );
      await assert.rejects(
        () => migrateUp(pgCtx.pool, tmpMigDir),
        (err: unknown) => err instanceof MigrationChecksumMismatchError && err.version === "0001",
      );
    } finally {
      await rm(tmpMigDir, { recursive: true, force: true });
    }
  });

  it("Section 25: Fault injection (pre-commit abort, post-commit lost response retry, query timeout, pool saturation, and DB server restart)", async () => {
    const catalogRepo = new PostgresCatalogRepository(pgCtx.pool);
    const charRepo = new PostgresCharacterRepository(pgCtx.pool);
    const invRepo = new PostgresInventoryRepository(pgCtx.pool);
    const skillRepo = new PostgresSkillRepository(pgCtx.pool);
    const socialRepo = new PostgresSocialRepository(pgCtx.pool);

    await catalogRepo.seedInitialCatalogs();
    await charRepo.seedProgressionRules();
    await invRepo.seedInitialItemCatalogs();
    await skillRepo.seedInitialSkillCatalogs();
    await socialRepo.seedInitialSocialCatalogs();

    const acc = await charRepo.createAccount({
      id: "44444444-4444-4444-8444-444444444401",
      externalSubject: "auth:fault-user",
    });
    const pAcc = { kind: "authenticated_account" as const, accountId: acc.id };

    // 1. Pre-commit crash via beforeCommitHook in RecordContributionService -> 0 rows persisted, retry succeeds!
    let failContribOnce = true;
    const contribService = new RecordContributionService({
      unitOfWork: new PostgresContributionUnitOfWork(pgCtx.pool),
      logger: silentLogger,
      beforeCommitHook: async () => {
        if (failContribOnce) {
          failContribOnce = false;
          throw new Error("SIMULATED_PRE_COMMIT_CRASH");
        }
      },
    });

    const contribPayload = {
      event_id: "audit:fault:contrib:01",
      simulation_id: "sim-fault",
      invasion_id: "inv-fault",
      settlement_id: "settlement-valewatch",
      tick: "420",
      player_id: "player-fault-01",
      damage: "1200",
      support: "300",
      objectives: "2",
      eligible: true,
      outcome: "Defended" as const,
    };

    await assert.rejects(() => contribService.record(contribPayload), /SIMULATED_PRE_COMMIT_CRASH/);
    const afterCrashCount = await pgCtx.pool.query(
      "SELECT COUNT(*)::int AS cnt FROM gameplay_contributions WHERE external_event_id = 'audit:fault:contrib:01'",
    );
    assert.equal(afterCrashCount.rows[0]?.cnt, 0);

    const recoveredContrib = await contribService.record(contribPayload);
    assert.equal(recoveredContrib.status, "applied");

    // 2. Post-commit simulated lost response on Character + Skill mutation -> retry after buildVersion incremented returns duplicate_idempotent!
    const charEngine = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(pgCtx.pool),
      logger: silentLogger,
    });
    const hero = (
      await charEngine.createCharacter({
        commandId: "audit:fault:create-hero",
        principal: pAcc,
        accountId: acc.id,
        characterName: "Valerius Resiliente",
        raceCode: "humans",
        lineageCode: "human_valorian",
        cultureCode: "valewatch_civic",
        backgroundCode: "veteran_soldier",
        originRegionId: "region-ashvale",
        appearance: VALID_APPEARANCE,
        presetCode: "berserker",
      })
    ).data;

    const skillEngine = new SkillEngineService({ pool: pgCtx.pool, logger: silentLogger });
    await skillEngine.grantWeaponMasteryExperience({
      grantId: "audit:fault:mast",
      principal: SYSTEM_AUTH,
      characterId: hero.id,
      weaponFamilyCode: "longsword",
      sourceType: "training",
      experienceAmount: 5000n,
    });

    const firstUnlock = await skillEngine.unlockSpecializationNode({
      commandId: "audit:fault:lost-response-unlock",
      principal: pAcc,
      characterId: hero.id,
      nodeCode: "node_sword_foundation",
      expectedBuildVersion: hero.buildVersion,
    });
    assert.equal(firstUnlock.status, "applied");

    // Client never received response; retries SAME commandId with original expectedBuildVersion (even though DB buildVersion is now +1!)
    const retryAfterLostResponse = await skillEngine.unlockSpecializationNode({
      commandId: "audit:fault:lost-response-unlock",
      principal: pAcc,
      characterId: hero.id,
      nodeCode: "node_sword_foundation",
      expectedBuildVersion: hero.buildVersion,
    });
    assert.equal(retryAfterLostResponse.status, "duplicate_idempotent");

    // 3. Query timeout (`statement_timeout`) & Pool saturation (`max: 2` with 6 concurrent transactions) -> zero leaked clients!
    const constrainedPool = createPgPool({
      connectionString: pgCtx.connectionString,
      max: 2,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 5000,
    });
    try {
      await assert.rejects(
        () =>
          withPgTransaction(constrainedPool, async (client) => {
            await client.query("SET LOCAL statement_timeout = '25ms'");
            await client.query("SELECT pg_sleep(0.2)");
          }),
        (err: unknown) => typeof err === "object" && err !== null && "code" in err && err.code === "57014",
      );

      // Run 6 concurrent transactional queries through a 2-connection pool after the timeout rollback
      const saturatedResults = await Promise.all(
        Array.from({ length: 6 }, (_, idx) =>
          withPgTransaction(constrainedPool, async (client) => {
            const r = await client.query<{ val: number }>("SELECT $1::int AS val", [idx + 1]);
            return r.rows[0]!.val;
          }),
        ),
      );
      assert.deepEqual(saturatedResults, [1, 2, 3, 4, 5, 6]);
      assert.equal(constrainedPool.waitingCount, 0);
    } finally {
      await constrainedPool.end();
    }

    // 4. Real PostgreSQL restart durability recovery
    await pgCtx.restartAndReconnect();
    const persistedHero = await new PostgresCharacterRepository(pgCtx.pool).findCharacterById(hero.id);
    assert.ok(persistedHero);
    assert.equal(persistedHero.displayName, "Valerius Resiliente");
  });

  it("Section 13, 14 & 26: Concurrent pardon vs new crime + Seeded 80-step stateful property & conservation fuzzing on real PostgreSQL", async () => {
    const charRepo = new PostgresCharacterRepository(pgCtx.pool);
    const charEngine = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(pgCtx.pool),
      logger: silentLogger,
    });
    const invEngine = new InventoryEngineService({ pool: pgCtx.pool, logger: silentLogger });
    const invRepo = new PostgresInventoryRepository(pgCtx.pool);
    const skillEngine = new SkillEngineService({ pool: pgCtx.pool, logger: silentLogger });
    const socialEngine = new SocialEngineService({ pool: pgCtx.pool, logger: silentLogger });

    const accA = await charRepo.createAccount({
      id: "55555555-5555-4555-8555-555555555501",
      externalSubject: "auth:fuzz-a",
    });
    const accB = await charRepo.createAccount({
      id: "55555555-5555-4555-8555-555555555502",
      externalSubject: "auth:fuzz-b",
    });
    const pA = { kind: "authenticated_account" as const, accountId: accA.id };

    const charA = (
      await charEngine.createCharacter({
        commandId: "fuzz:create:charA",
        principal: pA,
        accountId: accA.id,
        characterName: "Lyra Invariante",
        raceCode: "humans",
        lineageCode: "human_valorian",
        cultureCode: "valewatch_civic",
        backgroundCode: "veteran_soldier",
        originRegionId: "region-ashvale",
        appearance: VALID_APPEARANCE,
        presetCode: "berserker",
      })
    ).data;

    const charB = (
      await charEngine.createCharacter({
        commandId: "fuzz:create:charB",
        principal: { kind: "authenticated_account", accountId: accB.id },
        accountId: accB.id,
        characterName: "Darius Contraparte",
        raceCode: "humans",
        lineageCode: "human_valorian",
        cultureCode: "valewatch_civic",
        backgroundCode: "veteran_soldier",
        originRegionId: "region-ashvale",
        appearance: VALID_APPEARANCE,
        presetCode: "berserker",
      })
    ).data;

    // Adversarial race: initial confirmed crime -> then concurrent Pardon vs new Confirmed Crime!
    await socialEngine.recordAuthoritativeCrime({
      commandId: "fuzz:crime:init",
      principal: SYSTEM_AUTH,
      offenderCharacterId: charB.id,
      offenseCode: "Theft",
      combatContext: "unlawful_aggression",
      jurisdictionId: "jur-ashvale-civic",
      severity: "moderate",
      confirmationLevel: "confirmed",
      evidenceReference: "ev:init-theft",
    });

    await Promise.allSettled([
      socialEngine.resolveCriminalStatus({
        commandId: "fuzz:pardon:race",
        principal: SYSTEM_AUTH,
        characterId: charB.id,
        jurisdictionId: "jur-ashvale-civic",
        targetState: "Pardoned",
        authorityReference: "decree:ashvale-01",
      }),
      socialEngine.recordAuthoritativeCrime({
        commandId: "fuzz:crime:race-2",
        principal: SYSTEM_AUTH,
        offenderCharacterId: charB.id,
        offenseCode: "Robbery",
        combatContext: "unlawful_aggression",
        jurisdictionId: "jur-ashvale-civic",
        severity: "major",
        confirmationLevel: "confirmed",
        evidenceReference: "ev:race-robbery",
      }),
    ]);

    // Both historical crimes MUST remain preserved in criminal_records (zero deleted rows!)
    const crimeRows = await pgCtx.pool.query<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM criminal_records WHERE offender_character_id = $1::uuid",
      [charB.id],
    );
    assert.equal(crimeRows.rows[0]?.cnt, 2);

    // Seeded 80-step stateful property fuzzer
    const rng = new SplitMix64Rng("carbon-audit-stateful-fuzz-v1");
    let expectedIronOreTotal = 0;

    for (let step = 0; step < 80; step++) {
      const action = rng.nextIntInclusive(0, 6);
      const curChar = (await charRepo.findCharacterById(charA.id))!;

      try {
        if (action === 0) {
          // Grant random XP (or replay previous step to exercise idempotency)
          const useReplay = step > 5 && rng.nextIntInclusive(0, 4) === 0;
          const grantId = useReplay ? `fuzz:xp:${step - 1}` : `fuzz:xp:${step}`;
          await charEngine.grantExperience({
            grantId,
            principal: SYSTEM_AUTH,
            characterId: charA.id,
            amount: BigInt(rng.nextIntInclusive(50, 600)),
            sourceType: "quest",
            sourceReference: `fuzz-q-${step}`,
          });
        } else if (action === 1) {
          // Allocate attributes (valid or intentionally exceeding unspent budget)
          const pts = rng.nextIntInclusive(1, Math.max(2, curChar.unspentAttributePoints + 2));
          await charEngine.allocateAttributes({
            commandId: `fuzz:alloc:${step}`,
            principal: pA,
            characterId: charA.id,
            expectedBuildVersion: curChar.buildVersion,
            attributeDeltas: { strength: pts },
          });
        } else if (action === 2) {
          // Grant iron_ore material stack & track exact conservation
          const qty = rng.nextIntInclusive(1, 25);
          const res = await invEngine.grantStackableMaterial({
            grantId: `fuzz:ore:${step}`,
            principal: SYSTEM_AUTH,
            recipientCharacterId: charA.id,
            definitionCode: "iron_ore",
            quantity: qty,
            originType: "gathering",
            originReference: `fuzz-node-${step}`,
          });
          if (res.status === "applied") {
            expectedIronOreTotal += qty;
          }
        } else if (action === 3) {
          // Split or merge iron_ore stacks -> MUST strictly conserve expectedIronOreTotal!
          const stacks = await invRepo.listCharacterStacks(charA.id);
          if (stacks.length === 1 && stacks[0]!.quantity >= 2) {
            const splitQty = rng.nextIntInclusive(1, stacks[0]!.quantity - 1);
            await invEngine.splitStack({
              commandId: `fuzz:split:${step}`,
              principal: pA,
              characterId: charA.id,
              sourceStackId: stacks[0]!.id,
              splitQuantity: splitQty,
            });
          } else if (stacks.length >= 2) {
            await invEngine.mergeStacks({
              commandId: `fuzz:merge:${step}`,
              principal: pA,
              characterId: charA.id,
              sourceStackId: stacks[1]!.id,
              targetStackId: stacks[0]!.id,
            });
          }
        } else if (action === 4) {
          // Grant & equip/unequip procedural equipment
          const items = await invRepo.listCharacterItems(charA.id);
          if (items.length < 3) {
            await invEngine.grantProceduralEquipment({
              grantId: `fuzz:item:${step}`,
              principal: SYSTEM_AUTH,
              recipientCharacterId: charA.id,
              definitionCode: rng.nextIntInclusive(0, 1) === 0 ? "thornveil_dagger" : "valewatch_tower_shield",
              rarityCode: "uncommon",
              originType: "quest_reward",
              originReference: `fuzz-eq-${step}`,
            });
          } else {
            const candidate = items[rng.nextIntInclusive(0, items.length - 1)]!;
            if (candidate.locationState === "in_container") {
              const slot = candidate.definitionCode === "valewatch_tower_shield" ? "off_hand" : "main_hand";
              await invEngine.equipItem({
                commandId: `fuzz:equip:${step}`,
                principal: pA,
                characterId: charA.id,
                itemInstanceId: candidate.id,
                targetSlot: slot,
                expectedBuildVersion: curChar.buildVersion,
              });
            } else if (candidate.locationState === "equipped_active") {
              const slot = candidate.definitionCode === "valewatch_tower_shield" ? "off_hand" : "main_hand";
              await invEngine.unequipItem({
                commandId: `fuzz:unequip:${step}`,
                principal: pA,
                characterId: charA.id,
                slotCode: slot,
                expectedBuildVersion: curChar.buildVersion,
              });
            }
          }
        } else if (action === 5) {
          // Mastery XP grant
          await skillEngine.grantWeaponMasteryExperience({
            grantId: `fuzz:mast:${step}`,
            principal: SYSTEM_AUTH,
            characterId: charA.id,
            weaponFamilyCode: "dagger",
            sourceType: "training",
            experienceAmount: BigInt(rng.nextIntInclusive(40, 300)),
          });
        } else {
          // Moral bounty signed adjustment within extreme values
          const delta = BigInt(rng.nextIntInclusive(-800, 800) || 25);
          await socialEngine.adjustMoralBounty({
            commandId: `fuzz:moral:${step}`,
            principal: SYSTEM_AUTH,
            characterId: charA.id,
            signedDelta: delta,
            actionCode: "fuzz_deed",
            regionId: "region-ashvale",
          });
        }
      } catch {
        // Expected domain rejections (insufficient points, occupied slot, etc.) must leave invariants intact!
      }

      // VERIFY GLOBAL INVARIANTS AFTER EVERY SINGLE STEP:
      const postChar = (await charRepo.findCharacterById(charA.id))!;
      assert.equal(
        postChar.allocatedAttributePoints + postChar.unspentAttributePoints,
        postChar.earnedAttributePoints,
        `Attribute conservation failed at step ${step}`,
      );
      assert.equal(
        sumAttributeBlock(postChar.allocatedAttributes),
        postChar.allocatedAttributePoints,
        `Attribute sum mismatch at step ${step}`,
      );

      const postStacks = await invRepo.listCharacterStacks(charA.id);
      const actualIronOre = postStacks
        .filter((s) => s.definitionCode === "iron_ore")
        .reduce((accSum, s) => accSum + s.quantity, 0);
      assert.equal(
        actualIronOre,
        expectedIronOreTotal,
        `Material conservation violated at step ${step}: expected ${expectedIronOreTotal}, got ${actualIronOre}`,
      );

      // Single authoritative location check for every item instance
      const locCheck = await pgCtx.pool.query<{
        id: string;
        location_state: string;
        container_id: string | null;
        active_slot_refs: number;
      }>(
        `SELECT
           ii.id,
           ii.location_state,
           ii.container_id,
           (
             SELECT COUNT(*)::int
             FROM equipment_loadout_slots els
             INNER JOIN equipment_loadouts el ON el.id = els.loadout_id
             WHERE els.item_instance_id = ii.id AND el.is_active = TRUE
           ) AS active_slot_refs
         FROM item_instances ii
         WHERE ii.owner_character_id = $1::uuid`,
        [charA.id],
      );
      for (const r of locCheck.rows) {
        if (r.location_state === "in_container") {
          assert.ok(r.container_id !== null);
          assert.equal(r.active_slot_refs, 0, `in_container item ${r.id} has active loadout ref!`);
        } else if (r.location_state === "equipped_active") {
          assert.equal(r.container_id, null);
          assert.equal(r.active_slot_refs, 1, `equipped_active item ${r.id} missing active slot!`);
        }
      }

      // Moral bounty & specialization bounds check
      const socCheck = await pgCtx.pool.query<{ moral_bounty: string }>(
        "SELECT moral_bounty::text FROM character_social_standing WHERE character_id = $1::uuid",
        [charA.id],
      );
      if (socCheck.rows[0]) {
        const mb = BigInt(socCheck.rows[0].moral_bounty);
        assert.ok(mb >= -10000n && mb <= 10000n, `Moral bounty ${mb} escaped [-10000, 10000]`);
      }

      const specCheck = await pgCtx.pool.query<{
        earned_points: number;
        spent_points: number;
        unspent_points: number;
      }>(
        "SELECT earned_points, spent_points, unspent_points FROM character_specialization_points WHERE character_id = $1::uuid",
        [charA.id],
      );
      if (specCheck.rows[0]) {
        assert.equal(
          specCheck.rows[0].spent_points + specCheck.rows[0].unspent_points,
          specCheck.rows[0].earned_points,
        );
      }
    }
  });
});
