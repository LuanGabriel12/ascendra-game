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
  CharacterOwnershipForbiddenError,
  GenesisTemporaryStatePersistenceForbiddenError,
} from "../../src/modules/characters/domain/errors.js";
import {
  PostgresCharacterRepository,
  PostgresCharacterUnitOfWork,
} from "../../src/modules/characters/infrastructure/postgres-character-unit-of-work.js";
import { PostgresEquipmentSnapshotReader } from "../../src/modules/inventory/application/equipment-snapshot-query.js";
import { InventoryEngineService } from "../../src/modules/inventory/application/inventory-engine-service.js";
import { INITIAL_ITEM_DEFINITIONS_CATALOG } from "../../src/modules/inventory/catalog/initial-item-catalog.js";
import {
  EquipmentRequirementNotMetError,
  EquipmentSlotIncompatibleError,
  InventoryCapacityExceededError,
  ItemBindingViolationError,
  ItemDefinitionInvalidError,
  ItemGenerationInvalidError,
  ItemOwnershipForbiddenError,
  LoadoutInvalidError,
  StackIncompatibilityError,
  StackOperationInvalidError,
} from "../../src/modules/inventory/domain/errors.js";
import type { ItemDefinition } from "../../src/modules/inventory/domain/item-types.js";
import { PostgresInventoryRepository } from "../../src/modules/inventory/infrastructure/postgres-inventory-unit-of-work.js";
import { PostgresCatalogRepository } from "../../src/modules/peoples/infrastructure/postgres-catalog-repository.js";
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
const EQUIP_SNAPSHOT_SCHEMA_PATH = path.resolve(
  __dirname,
  "../../contracts/neon-carbon/equipment-snapshot.v1.schema.json",
);

const SYSTEM_AUTHORITY: AuthorityPrincipal = {
  kind: "internal_system_authority",
  actorId: "test-inventory-authority",
};

describe("CARBON Session 04 — Inventory, Equipment, Procedural Items, Ledger & Concurrency (Real PostgreSQL)", () => {
  let pgCtx: RunningPostgresTestContext;
  let charSnapshotSchema: JsonSchemaNode;
  let equipSnapshotSchema: JsonSchemaNode;
  const silentLogger = new StructuredLogger("silent");

  before(async () => {
    pgCtx = await startPostgresTestContext();
    charSnapshotSchema = JSON.parse(
      await readFile(CHAR_SNAPSHOT_SCHEMA_PATH, "utf8"),
    ) as JsonSchemaNode;
    equipSnapshotSchema = JSON.parse(
      await readFile(EQUIP_SNAPSHOT_SCHEMA_PATH, "utf8"),
    ) as JsonSchemaNode;
  });

  after(async () => {
    if (pgCtx) {
      await pgCtx.stop();
    }
  });

  it("Scenarios 46, 1 & 2: Incremental migrations 0006..0007 apply over populated Session 03 data with automatic backfill, full down/up cycle, and immutable ItemDefinition versioning", async () => {
    const existing = await listAppliedMigrations(pgCtx.pool);
    if (existing.length > 0) {
      await migrateDown(pgCtx.pool, MIGRATIONS_DIR, existing.length);
    }

    // Apply all migrations then step back to Session 03 (0001..0005) dynamically
    await migrateUp(pgCtx.pool, MIGRATIONS_DIR);
    const totalAvailable = (await listAppliedMigrations(pgCtx.pool)).length;
    await migrateDown(pgCtx.pool, MIGRATIONS_DIR, totalAvailable - 5);
    const s03Applied = await listAppliedMigrations(pgCtx.pool);
    assert.deepEqual(
      s03Applied.map((m) => m.version),
      ["0001", "0002", "0003", "0004", "0005"],
    );

    // Populate a pre-existing Session 03 character BEFORE applying 0006 & 0007
    const catalogRepo = new PostgresCatalogRepository(pgCtx.pool);
    const charRepo = new PostgresCharacterRepository(pgCtx.pool);
    await catalogRepo.seedInitialCatalogs();
    await charRepo.seedProgressionRules();

    const preAccount = await charRepo.createAccount({
      id: randomUUID(),
      externalSubject: "pre-s04-legacy-account",
    });
    const charEngine = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(pgCtx.pool),
      logger: silentLogger,
    });
    const preChar = await charEngine.createCharacter({
      commandId: "s04:mig:legacy-char",
      principal: { kind: "authenticated_account", accountId: preAccount.id },
      accountId: preAccount.id,
      characterName: "Aldric Pré-Inventário",
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
    });

    // Now apply incremental migrations 0006+ over the populated Session 03 DB
    const incApplied = await migrateUp(pgCtx.pool, MIGRATIONS_DIR);
    assert.deepEqual(incApplied.slice(0, 2), [
      "0006_item_catalog_rarities_and_affixes",
      "0007_inventories_instances_loadouts_and_ledger",
    ]);

    // Verify automatic backfill created a 40-slot character_inventory and active 'Principal' loadout
    const backfilledBag = await pgCtx.pool.query<{ capacity: number }>(
      "SELECT capacity FROM inventory_containers WHERE owner_character_id = $1 AND container_type = 'character_inventory'",
      [preChar.data.id],
    );
    assert.equal(backfilledBag.rows[0]?.capacity, 40);

    const backfilledLoadout = await pgCtx.pool.query<{ name: string; is_active: boolean }>(
      "SELECT name, is_active FROM equipment_loadouts WHERE character_id = $1",
      [preChar.data.id],
    );
    assert.equal(backfilledLoadout.rows[0]?.name, "Principal");
    assert.equal(backfilledLoadout.rows[0]?.is_active, true);

    // Seed Session 04 catalogs and verify immutable definition versioning (v1 vs v2)
    const invRepo = new PostgresInventoryRepository(pgCtx.pool);
    await invRepo.seedInitialItemCatalogs();

    const invEngine = new InventoryEngineService({ pool: pgCtx.pool, logger: silentLogger });
    const v1SwordGrant = await invEngine.grantProceduralEquipment({
      grantId: "s04:defver:grant-v1",
      principal: SYSTEM_AUTHORITY,
      recipientCharacterId: preChar.data.id,
      definitionCode: "ironfang_longsword",
      rarityCode: "rare",
      originType: "quest_reward",
      originReference: "quest:v1-blade",
    });
    assert.equal(v1SwordGrant.data.definitionVersion, 1);

    // Re-registering v1 must be rejected as immutable
    const baseSwordDef = INITIAL_ITEM_DEFINITIONS_CATALOG.find(
      (d) => d.definitionCode === "ironfang_longsword",
    )!;
    await assert.rejects(
      () => invRepo.registerItemDefinition(baseSwordDef),
      ItemDefinitionInvalidError,
    );

    // Publishing v2 succeeds and new grants default to v2 while v1 instance keeps v1!
    const v2SwordDef: ItemDefinition = {
      ...baseSwordDef,
      definitionVersion: 2,
      basePowerBudget: 42,
      implicitModifiers: { strength: 6, dexterity: 3 },
    };
    await invRepo.registerItemDefinition(v2SwordDef);

    const v2SwordGrant = await invEngine.grantProceduralEquipment({
      grantId: "s04:defver:grant-v2",
      principal: SYSTEM_AUTHORITY,
      recipientCharacterId: preChar.data.id,
      definitionCode: "ironfang_longsword",
      rarityCode: "rare",
      originType: "quest_reward",
      originReference: "quest:v2-blade",
    });
    assert.equal(v2SwordGrant.data.definitionVersion, 2);
    assert.deepEqual(v2SwordGrant.data.implicitAttributes.strength, 6);

    const reloadedItems = await invRepo.listCharacterItems(preChar.data.id);
    const v1Reloaded = reloadedItems.find((i) => i.id === v1SwordGrant.data.id)!;
    assert.equal(v1Reloaded.definitionVersion, 1);
    assert.equal(v1Reloaded.implicitAttributes.strength, 4);

    // Verify full down:all -> up cycle works cleanly
    const allAppliedNow = await listAppliedMigrations(pgCtx.pool);
    assert.ok(allAppliedNow.length >= 7);
    await migrateDown(pgCtx.pool, MIGRATIONS_DIR, allAppliedNow.length);
    assert.equal((await listAppliedMigrations(pgCtx.pool)).length, 0);
    await migrateUp(pgCtx.pool, MIGRATIONS_DIR);

    // Re-seed base catalogs for subsequent tests
    await catalogRepo.seedInitialCatalogs();
    await charRepo.seedProgressionRules();
    await invRepo.seedInitialItemCatalogs();
  });

  it("Scenarios 13, 14, 15, 16 & 17: Authorized grants, player grant rejection, duplicate idempotency, conflicting payload detection, boss reward slot uniqueness, and 40-slot inventory capacity", async () => {
    const charRepo = new PostgresCharacterRepository(pgCtx.pool);
    const invRepo = new PostgresInventoryRepository(pgCtx.pool);
    const charEngine = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(pgCtx.pool),
      logger: silentLogger,
    });
    const invEngine = new InventoryEngineService({ pool: pgCtx.pool, logger: silentLogger });

    const account = await charRepo.createAccount({
      id: randomUUID(),
      externalSubject: "s04-grants-acc",
    });
    const playerPrincipal: AuthorityPrincipal = {
      kind: "authenticated_account",
      accountId: account.id,
    };
    const hero = (
      await charEngine.createCharacter({
        commandId: `s04:char:${randomUUID()}`,
        principal: playerPrincipal,
        accountId: account.id,
        characterName: "Bram Mochila-Cheia",
        raceCode: "dwarves",
        lineageCode: "dwarf_mountain",
        cultureCode: "ironforge_guildpact",
        backgroundCode: "blacksmith_apprentice",
        originRegionId: "granite-peaks",
        appearance: {
          bodyPreset: "forged_broad_a",
          skinTone: "granite_tan",
          hairStyle: "braided_crown",
          hairColor: "copper_red",
          eyeStyle: "deep_set",
          eyeColor: "amber_gold",
          earStyle: "rounded_broad",
        },
        presetCode: "berserker",
      })
    ).data;

    // #14: Unauthorized grant from player principal rejected
    await assert.rejects(
      () =>
        invEngine.grantProceduralEquipment({
          grantId: "s04:unauth:grant-1",
          principal: playerPrincipal,
          recipientCharacterId: hero.id,
          definitionCode: "ironfang_longsword",
          rarityCode: "legendary",
          originType: "boss_drop",
          originReference: "forged",
        }),
      ItemOwnershipForbiddenError,
    );

    // #13 & #15: Authorized grant succeeds, duplicate retry returns identical item without creating a second row
    const g1 = await invEngine.grantProceduralEquipment({
      grantId: "s04:auth:grant-boss-slot0",
      sourceEventId: "boss-kill:granite-colossus-99",
      rewardSlotIndex: 0,
      principal: SYSTEM_AUTHORITY,
      recipientCharacterId: hero.id,
      definitionCode: "ironfang_longsword",
      rarityCode: "epic",
      originType: "boss_drop",
      originReference: "boss:granite-colossus",
    });
    assert.equal(g1.status, "applied");

    const g1Dup = await invEngine.grantProceduralEquipment({
      grantId: "s04:auth:grant-boss-slot0",
      sourceEventId: "boss-kill:granite-colossus-99",
      rewardSlotIndex: 0,
      principal: SYSTEM_AUTHORITY,
      recipientCharacterId: hero.id,
      definitionCode: "ironfang_longsword",
      rarityCode: "epic",
      originType: "boss_drop",
      originReference: "boss:granite-colossus",
    });
    assert.equal(g1Dup.status, "duplicate_idempotent");
    assert.equal(g1Dup.data.id, g1.data.id);

    // #16: Conflicting retry with same grantId but different rarity/item throws InboxIdempotencyConflictError
    await assert.rejects(
      () =>
        invEngine.grantProceduralEquipment({
          grantId: "s04:auth:grant-boss-slot0",
          sourceEventId: "boss-kill:granite-colossus-99",
          rewardSlotIndex: 0,
          principal: SYSTEM_AUTHORITY,
          recipientCharacterId: hero.id,
          definitionCode: "ironfang_longsword",
          rarityCode: "mythic",
          originType: "boss_drop",
          originReference: "boss:granite-colossus",
        }),
      InboxIdempotencyConflictError,
    );

    // Boss reward slot uniqueness: different grantId trying to claim SAME (sourceEventId, recipient, rewardSlotIndex=0) rejected!
    await assert.rejects(
      () =>
        invEngine.grantProceduralEquipment({
          grantId: "s04:auth:grant-boss-slot0-duplicate-attempt",
          sourceEventId: "boss-kill:granite-colossus-99",
          rewardSlotIndex: 0,
          principal: SYSTEM_AUTHORITY,
          recipientCharacterId: hero.id,
          definitionCode: "thornveil_dagger",
          rarityCode: "rare",
          originType: "boss_drop",
          originReference: "boss:granite-colossus",
        }),
      ItemGenerationInvalidError,
    );

    // #17: Fill remaining 39 slots of 40-slot inventory, then confirm 41st item is rejected cleanly!
    for (let slot = 1; slot < 40; slot++) {
      await invEngine.grantProceduralEquipment({
        grantId: `s04:fill-bag:${hero.id}:${slot}`,
        principal: SYSTEM_AUTHORITY,
        recipientCharacterId: hero.id,
        definitionCode: "thornveil_dagger",
        rarityCode: "common",
        originType: "exploration",
        originReference: `chest:${slot}`,
      });
    }
    assert.equal((await invRepo.listCharacterItems(hero.id)).length, 40);

    await assert.rejects(
      () =>
        invEngine.grantProceduralEquipment({
          grantId: `s04:fill-bag:${hero.id}:overflow-41`,
          principal: SYSTEM_AUTHORITY,
          recipientCharacterId: hero.id,
          definitionCode: "thornveil_dagger",
          rarityCode: "common",
          originType: "exploration",
          originReference: "chest:overflow",
        }),
      InventoryCapacityExceededError,
    );
    assert.equal((await invRepo.listCharacterItems(hero.id)).length, 40);
  });

  it("Scenarios 18, 19, 20, 21 & 22: Container movement (inventory <-> personal_storage), stack split/merge, strict quantity conservation, incompatibility checks, and real concurrent stack contention", async () => {
    const charRepo = new PostgresCharacterRepository(pgCtx.pool);
    const invRepo = new PostgresInventoryRepository(pgCtx.pool);
    const charEngine = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(pgCtx.pool),
      logger: silentLogger,
    });
    const invEngine = new InventoryEngineService({ pool: pgCtx.pool, logger: silentLogger });

    const account = await charRepo.createAccount({
      id: randomUUID(),
      externalSubject: "s04-stacks-acc",
    });
    const principal: AuthorityPrincipal = {
      kind: "authenticated_account",
      accountId: account.id,
    };
    const crafter = (
      await charEngine.createCharacter({
        commandId: `s04:char:${randomUUID()}`,
        principal,
        accountId: account.id,
        characterName: "Talia Forja-Viva",
        raceCode: "humans",
        lineageCode: "human_frontier",
        cultureCode: "ironforge_guildpact",
        backgroundCode: "blacksmith_apprentice",
        originRegionId: "granite-peaks",
        appearance: {
          bodyPreset: "athletic_a",
          skinTone: "olive_bronze",
          hairStyle: "braided_crown",
          hairColor: "raven_black",
          eyeStyle: "round_bright",
          eyeColor: "amber_gold",
          earStyle: "rounded_standard",
        },
        presetCode: "berserker",
      })
    ).data;

    // Grant 150 iron_ore (quality 5000) and 40 iron_ore (quality 8000 — distinct quality cannot merge!)
    const ore5000 = await invEngine.grantStackableMaterial({
      grantId: `s04:ore5k:${crafter.id}`,
      principal: SYSTEM_AUTHORITY,
      recipientCharacterId: crafter.id,
      definitionCode: "iron_ore",
      quantity: 150,
      qualityBp: 5000,
      originType: "gathering",
      originReference: "vein:a",
    });
    const ore8000 = await invEngine.grantStackableMaterial({
      grantId: `s04:ore8k:${crafter.id}`,
      principal: SYSTEM_AUTHORITY,
      recipientCharacterId: crafter.id,
      definitionCode: "iron_ore",
      quantity: 40,
      qualityBp: 8000,
      originType: "gathering",
      originReference: "vein:b",
    });

    // Incompatible quality merge rejected
    await assert.rejects(
      () =>
        invEngine.mergeStacks({
          commandId: "s04:merge:incompatible-quality",
          principal,
          characterId: crafter.id,
          sourceStackId: ore8000.data[0]!.id,
          targetStackId: ore5000.data[0]!.id,
        }),
      StackIncompatibilityError,
    );

    // #19 Split 150 -> 90 + 60
    const split1 = await invEngine.splitStack({
      commandId: "s04:split:ore-60",
      principal,
      characterId: crafter.id,
      sourceStackId: ore5000.data[0]!.id,
      splitQuantity: 60,
    });
    assert.equal(split1.data.updatedSource.quantity, 90);
    assert.equal(split1.data.createdSplit.quantity, 60);

    // #18 Move split stack (60 units) to personal_storage slot 5, then move back to character_inventory slot 10
    await invEngine.moveInventoryEntry({
      commandId: "s04:move:to-storage",
      principal,
      characterId: crafter.id,
      stackId: split1.data.createdSplit.id,
      targetContainerType: "personal_storage",
      targetSlotIndex: 5,
    });
    await invEngine.moveInventoryEntry({
      commandId: "s04:move:back-to-bag",
      principal,
      characterId: crafter.id,
      stackId: split1.data.createdSplit.id,
      targetContainerType: "character_inventory",
      targetSlotIndex: 10,
    });

    // #20 Partial merge 25 units from 60 -> (90+25=115) and (60-25=35)
    const partialMerge = await invEngine.mergeStacks({
      commandId: "s04:merge:partial-25",
      principal,
      characterId: crafter.id,
      sourceStackId: split1.data.createdSplit.id,
      targetStackId: split1.data.updatedSource.id,
      quantity: 25,
    });
    assert.equal(partialMerge.data.quantity, 115);

    // #22 Real concurrent stack splits against the 115-unit stack: two concurrent requests each trying to split 80 units!
    // Total 115 cannot fund two 80-unit splits (80 + 80 = 160 > 115). Exactly 1 must succeed and 1 must fail, conserving 190 total ore!
    const concurrentSplits = await Promise.allSettled([
      invEngine.splitStack({
        commandId: `s04:concur-split:a:${randomUUID()}`,
        principal,
        characterId: crafter.id,
        sourceStackId: split1.data.updatedSource.id,
        splitQuantity: 80,
      }),
      invEngine.splitStack({
        commandId: `s04:concur-split:b:${randomUUID()}`,
        principal,
        characterId: crafter.id,
        sourceStackId: split1.data.updatedSource.id,
        splitQuantity: 80,
      }),
    ]);

    const fulfilled = concurrentSplits.filter((r) => r.status === "fulfilled");
    const rejected = concurrentSplits.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]?.reason instanceof StackOperationInvalidError);

    // #21 Strict conservation check across all stacks for crafter: 150 + 40 === 190!
    const finalStacks = await invRepo.listCharacterStacks(crafter.id);
    const totalOreQuantity = finalStacks.reduce((acc, s) => acc + s.quantity, 0);
    assert.equal(totalOreQuantity, 190);
  });

  it("Scenarios 23..33 & 42..43: Equip weapon/armor, slot & cosmetic guards, 2H weapon displacing 1H+shield, full-bag 2H swap rollback, ownership, level/intrinsic-attribute/post-respec rules, competitive lock, loadouts, build_version conflict, and CharacterSnapshot/EquipmentSnapshot parity", async () => {
    const charRepo = new PostgresCharacterRepository(pgCtx.pool);
    const invRepo = new PostgresInventoryRepository(pgCtx.pool);
    const charEngine = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(pgCtx.pool),
      logger: silentLogger,
    });
    const invEngine = new InventoryEngineService({ pool: pgCtx.pool, logger: silentLogger });
    const charSnapReader = new PostgresCharacterSnapshotReader(pgCtx.pool);
    const equipSnapReader = new PostgresEquipmentSnapshotReader(pgCtx.pool);

    const acc1 = await charRepo.createAccount({ id: randomUUID(), externalSubject: "s04-eq-1" });
    const acc2 = await charRepo.createAccount({ id: randomUUID(), externalSubject: "s04-eq-2" });
    const p1: AuthorityPrincipal = { kind: "authenticated_account", accountId: acc1.id };
    const p2: AuthorityPrincipal = { kind: "authenticated_account", accountId: acc2.id };

    const knight = (
      await charEngine.createCharacter({
        commandId: `s04:knight:${randomUUID()}`,
        principal: p1,
        accountId: acc1.id,
        characterName: "Vaelen Escudo-Firme",
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
        presetCode: "berserker", // STR +20 (total 25 >= 18), FOR +12 (total 17 >= 12)
      })
    ).data;

    const stranger = (
      await charEngine.createCharacter({
        commandId: `s04:stranger:${randomUUID()}`,
        principal: p2,
        accountId: acc2.id,
        characterName: "Nyx Sombra-Fria",
        raceCode: "elves",
        lineageCode: "elf_lunar",
        cultureCode: "arcane_collegium",
        backgroundCode: "hunter",
        originRegionId: "region-thornreach",
        appearance: {
          bodyPreset: "lean_a",
          skinTone: "moonlit_silver",
          hairStyle: "windswept_long",
          hairColor: "frost_white",
          eyeStyle: "almond_sharp",
          eyeColor: "emerald_green",
          earStyle: "pointed_long",
        },
        presetCode: "assassin",
      })
    ).data;

    // Grant items to knight + 1 dagger to stranger
    const sword = (
      await invEngine.grantProceduralEquipment({
        grantId: `s04:eq:sword:${knight.id}`,
        principal: SYSTEM_AUTHORITY,
        recipientCharacterId: knight.id,
        definitionCode: "ironfang_longsword",
        rarityCode: "epic",
        originType: "quest_reward",
        originReference: "q1",
      })
    ).data;
    const shield = (
      await invEngine.grantProceduralEquipment({
        grantId: `s04:eq:shield:${knight.id}`,
        principal: SYSTEM_AUTHORITY,
        recipientCharacterId: knight.id,
        definitionCode: "valewatch_tower_shield",
        rarityCode: "rare",
        originType: "quest_reward",
        originReference: "q2",
      })
    ).data;
    const armor = (
      await invEngine.grantProceduralEquipment({
        grantId: `s04:eq:armor:${knight.id}`,
        principal: SYSTEM_AUTHORITY,
        recipientCharacterId: knight.id,
        definitionCode: "guardian_plate_cuirass",
        rarityCode: "rare",
        originType: "quest_reward",
        originReference: "q3",
      })
    ).data;
    const greataxe = (
      await invEngine.grantProceduralEquipment({
        grantId: `s04:eq:greataxe:${knight.id}`,
        principal: SYSTEM_AUTHORITY,
        recipientCharacterId: knight.id,
        definitionCode: "crimson_clan_greataxe", // requiredLevel: 3, requiredAttributes: { strength: 18 }
        rarityCode: "legendary",
        originType: "boss_drop",
        originReference: "b1",
      })
    ).data;
    const cosmeticCloak = (
      await invEngine.grantProceduralEquipment({
        grantId: `s04:eq:cloak:${knight.id}`,
        principal: SYSTEM_AUTHORITY,
        recipientCharacterId: knight.id,
        definitionCode: "ashvale_ceremonial_cloak",
        rarityCode: "rare",
        originType: "quest_reward",
        originReference: "q4",
      })
    ).data;
    const strangerDagger = (
      await invEngine.grantProceduralEquipment({
        grantId: `s04:eq:stranger-dagger:${stranger.id}`,
        principal: SYSTEM_AUTHORITY,
        recipientCharacterId: stranger.id,
        definitionCode: "thornveil_dagger",
        rarityCode: "uncommon",
        originType: "exploration",
        originReference: "e1",
      })
    ).data;

    // #28 Item ownership: knight cannot equip stranger's dagger; stranger cannot equip knight's sword
    await assert.rejects(
      () =>
        invEngine.equipItem({
          commandId: "s04:eq:steal-dagger",
          principal: p1,
          characterId: knight.id,
          itemInstanceId: strangerDagger.id,
          targetSlot: "main_hand",
          expectedBuildVersion: 1,
        }),
      ItemOwnershipForbiddenError,
    );
    await assert.rejects(
      () =>
        invEngine.equipItem({
          commandId: "s04:eq:cross-account-impersonation",
          principal: p2,
          characterId: knight.id,
          itemInstanceId: sword.id,
          targetSlot: "main_hand",
          expectedBuildVersion: 1,
        }),
      CharacterOwnershipForbiddenError,
    );

    // #25 Incompatible slot (armor in head, cosmetic cloak in back combat slot, 2H axe in off_hand)
    await assert.rejects(
      () =>
        invEngine.equipItem({
          commandId: "s04:eq:armor-in-head",
          principal: p1,
          characterId: knight.id,
          itemInstanceId: armor.id,
          targetSlot: "head",
          expectedBuildVersion: 1,
        }),
      EquipmentSlotIncompatibleError,
    );
    await assert.rejects(
      () =>
        invEngine.equipItem({
          commandId: "s04:eq:cosmetic-in-combat-back",
          principal: p1,
          characterId: knight.id,
          itemInstanceId: cosmeticCloak.id,
          targetSlot: "back",
          expectedBuildVersion: 1,
        }),
      EquipmentSlotIncompatibleError,
    );

    // #29 Level requirement: knight is Level 1, greataxe requires Level 3 -> rejected!
    await assert.rejects(
      () =>
        invEngine.equipItem({
          commandId: "s04:eq:axe-underleveled",
          principal: p1,
          characterId: knight.id,
          itemInstanceId: greataxe.id,
          targetSlot: "main_hand",
          expectedBuildVersion: 1,
        }),
      EquipmentRequirementNotMetError,
    );

    // Level knight up to Level 3
    await charEngine.grantExperience({
      grantId: `s04:xp:knight-lv3:${knight.id}`,
      principal: SYSTEM_AUTHORITY,
      characterId: knight.id,
      sourceType: "boss",
      sourceReference: "b1",
      amount: "500",
    });

    // #23 & #24 Equip 1H sword, off_hand shield, and chest armor (BuildVersion 1 -> 2 -> 3 -> 4)
    await invEngine.equipItem({
      commandId: "s04:eq:ok-sword",
      principal: p1,
      characterId: knight.id,
      itemInstanceId: sword.id,
      targetSlot: "main_hand",
      expectedBuildVersion: 1,
    });
    await invEngine.equipItem({
      commandId: "s04:eq:ok-shield",
      principal: p1,
      characterId: knight.id,
      itemInstanceId: shield.id,
      targetSlot: "off_hand",
      expectedBuildVersion: 2,
    });
    await invEngine.equipItem({
      commandId: "s04:eq:ok-armor",
      principal: p1,
      characterId: knight.id,
      itemInstanceId: armor.id,
      targetSlot: "chest",
      expectedBuildVersion: 3,
    });

    // #42 Stale expectedBuildVersion rejected with CharacterBuildConflictError
    await assert.rejects(
      () =>
        invEngine.equipItem({
          commandId: "s04:eq:stale-bv",
          principal: p1,
          characterId: knight.id,
          itemInstanceId: greataxe.id,
          targetSlot: "main_hand",
          expectedBuildVersion: 2,
        }),
      CharacterBuildConflictError,
    );

    // #27 Full inventory during 2H swap (2H axe leaves 1 bag slot free, but displaces TWO items: sword + shield -> needs 2 bag slots!):
    // Currently knight has 2 items in bag (greataxe + cosmeticCloak) out of 40 slots -> 38 slots free.
    // Fill those 38 free slots with iron_ore stacks so bag is 40/40 full!
    const fillerStackIds: string[] = [];
    for (let i = 0; i < 38; i++) {
      const st = await invEngine.grantStackableMaterial({
        grantId: `s04:filler:${knight.id}:${i}`,
        principal: SYSTEM_AUTHORITY,
        recipientCharacterId: knight.id,
        definitionCode: "iron_ore",
        quantity: 1,
        qualityBp: 1000 + i, // distinct qualityBp forces 1 slot per grant!
        originType: "gathering",
        originReference: `fill:${i}`,
      });
      fillerStackIds.push(st.data[0]!.id);
    }

    // Attempt 2H swap with 0 extra bag slots -> MUST fail & rollback cleanly leaving sword + shield equipped!
    await assert.rejects(
      () =>
        invEngine.equipItem({
          commandId: "s04:eq:2h-full-bag-rollback",
          principal: p1,
          characterId: knight.id,
          itemInstanceId: greataxe.id,
          targetSlot: "main_hand",
          expectedBuildVersion: 4,
        }),
      InventoryCapacityExceededError,
    );
    const snapAfterFailedSwap = await charSnapReader.getCharacterSnapshot(knight.id, {
      principal: p1,
    });
    assert.equal(snapAfterFailedSwap.buildVersion, 4);
    assert.equal(snapAfterFailedSwap.equippedItems.length, 3);

    // Free 1 bag slot by moving 1 filler stack to personal_storage!
    await invEngine.moveInventoryEntry({
      commandId: "s04:move:free-one-bag-slot",
      principal: p1,
      characterId: knight.id,
      stackId: fillerStackIds[0]!,
      targetContainerType: "personal_storage",
      targetSlotIndex: 0,
    });

    // #26 Now 2H greataxe swap succeeds (1 freed by axe + 1 free in bag = 2 slots for sword + shield)!
    const twoHandRes = await invEngine.equipItem({
      commandId: "s04:eq:2h-greataxe-ok",
      principal: p1,
      characterId: knight.id,
      itemInstanceId: greataxe.id,
      targetSlot: "main_hand",
      expectedBuildVersion: 4,
    });
    assert.equal(twoHandRes.data.slots.length, 2); // main_hand (greataxe) + chest (armor)

    // #33 Invalid loadout references rejected (unowned item or 2H + off_hand combination)
    await assert.rejects(
      () =>
        invEngine.saveInactiveLoadout({
          commandId: "s04:loadout:invalid-2h-plus-shield",
          principal: p1,
          characterId: knight.id,
          loadoutName: "Ilegal 2H Escudo",
          assignments: [
            { slotCode: "main_hand", itemInstanceId: greataxe.id },
            { slotCode: "off_hand", itemInstanceId: shield.id },
          ],
        }),
      LoadoutInvalidError,
    );
    await assert.rejects(
      () =>
        invEngine.saveInactiveLoadout({
          commandId: "s04:loadout:unowned-ref",
          principal: p1,
          characterId: knight.id,
          loadoutName: "Ilegal Alheio",
          assignments: [{ slotCode: "main_hand", itemInstanceId: strangerDagger.id }],
        }),
      ItemOwnershipForbiddenError,
    );

    // #32 Save valid secondary loadout (sword + shield + armor) & activate it (BuildVersion 5 -> 6)!
    // Move one more filler stack to storage so activating 3-item loadout vs 2-item loadout has room if needed
    await invEngine.moveInventoryEntry({
      commandId: "s04:move:free-second-slot",
      principal: p1,
      characterId: knight.id,
      stackId: fillerStackIds[1]!,
      targetContainerType: "personal_storage",
      targetSlotIndex: 1,
    });

    const shieldLoadout = await invEngine.saveInactiveLoadout({
      commandId: "s04:loadout:valid-sword-board",
      principal: p1,
      characterId: knight.id,
      loadoutName: "Defesa Fronteiriça",
      assignments: [
        { slotCode: "main_hand", itemInstanceId: sword.id },
        { slotCode: "off_hand", itemInstanceId: shield.id },
        { slotCode: "chest", itemInstanceId: armor.id },
      ],
    });
    const activated = await invEngine.activateLoadout({
      commandId: "s04:loadout:activate-sword-board",
      principal: p1,
      characterId: knight.id,
      loadoutId: shieldLoadout.data.id,
      expectedBuildVersion: 5,
    });
    assert.equal(activated.data.slots.length, 3);

    // #43 Validate both CharacterSnapshotWireV1 and EquipmentSnapshotProposalV1 against JSON Schemas!
    const charSnap = await charSnapReader.getCharacterSnapshot(knight.id, { principal: p1 });
    const charWire = serializeCharacterSnapshotWireV1(charSnap);
    const charSchemaCheck = validateAgainstJsonSchema(charSnapshotSchema, charWire);
    assert.equal(charSchemaCheck.valid, true, charSchemaCheck.errors.join("; "));
    assert.equal(charWire.equipped_items.length, 3);

    const equipSnap = await equipSnapReader.getEquipmentSnapshot(knight.id, { principal: p1 });
    const equipSchemaCheck = validateAgainstJsonSchema(equipSnapshotSchema, equipSnap);
    assert.equal(equipSchemaCheck.valid, true, equipSchemaCheck.errors.join("; "));
    assert.equal(equipSnap.equippedDetails.length, 3);

    // #30 Post-respec intrinsic attribute suppression:
    // Re-activate 2H greataxe (requires STR 18), then respec knight's allocated attributes to 0 (base STR of human border_guard is 10+2=12 < 18)!
    // Greataxe remains owned & in slot, but is suppressed from CharacterSnapshotV1.equippedItems and EquipmentSnapshot modifiers!
    const principalLoadoutRow = await pgCtx.pool.query<{ id: string }>(
      "SELECT id FROM equipment_loadouts WHERE character_id = $1 AND name = 'Principal'",
      [knight.id],
    );
    await invEngine.activateLoadout({
      commandId: "s04:loadout:back-to-2h",
      principal: p1,
      characterId: knight.id,
      loadoutId: principalLoadoutRow.rows[0]!.id,
      expectedBuildVersion: 6,
    });

    await charEngine.respecAttributes({
      commandId: "s04:respec:drop-strength",
      principal: p1,
      characterId: knight.id,
      expectedBuildVersion: 7,
    });

    const postRespecCharSnap = await charSnapReader.getCharacterSnapshot(knight.id, {
      principal: p1,
    });
    const postRespecEquipSnap = await equipSnapReader.getEquipmentSnapshot(knight.id, {
      principal: p1,
    });
    // Greataxe (STR 18) is suppressed after respec!
    assert.equal(
      postRespecCharSnap.equippedItems.find((i) => i.itemInstanceId === greataxe.id),
      undefined,
    );
    const axeDetail = postRespecEquipSnap.equippedDetails.find(
      (d) => d.itemInstanceId === greataxe.id,
    );
    assert.equal(axeDetail?.isActiveForCombat, false);
    assert.ok(axeDetail?.suppressionReason?.includes("strength"));

    // #31 Competitive lock (`in_ranked_series`) blocks equip/unequip/loadout switch
    await charRepo.setCharacterCompetitiveLock(knight.id, "in_ranked_series");
    await assert.rejects(
      () =>
        invEngine.activateLoadout({
          commandId: "s04:loadout:blocked-in-md3",
          principal: p1,
          characterId: knight.id,
          loadoutId: shieldLoadout.data.id,
          expectedBuildVersion: 8,
        }),
      CharacterCompetitiveLockedError,
    );
    assert.equal((await invRepo.listCharacterItems(knight.id)).length, 5);
  });

  it("Scenarios 34..41, 44, 45 & 47: Durability & broken-gear suppression, binding & authorized/forbidden transfers, concurrent double-transfer anti-duping race, pre-commit rollback & retry, Genesis isolation, PostgreSQL restart recovery, and prior-session regressions", async () => {
    const charRepo = new PostgresCharacterRepository(pgCtx.pool);
    let invRepo = new PostgresInventoryRepository(pgCtx.pool);
    const charEngine = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(pgCtx.pool),
      logger: silentLogger,
    });
    let invEngine = new InventoryEngineService({ pool: pgCtx.pool, logger: silentLogger });
    let charSnapReader = new PostgresCharacterSnapshotReader(pgCtx.pool);

    const accA = await charRepo.createAccount({ id: randomUUID(), externalSubject: "s04-tr-a" });
    const accB = await charRepo.createAccount({ id: randomUUID(), externalSubject: "s04-tr-b" });
    const pA: AuthorityPrincipal = { kind: "authenticated_account", accountId: accA.id };

    const charA1 = (
      await charEngine.createCharacter({
        commandId: `s04:a1:${randomUUID()}`,
        principal: pA,
        accountId: accA.id,
        characterName: "Doran Guarda-Norte",
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

    // Second character on SAME account A (for account_bound transfer test!)
    const charA2 = (
      await charEngine.createCharacter({
        commandId: `s04:a2:${randomUUID()}`,
        principal: pA,
        accountId: accA.id,
        characterName: "Elara Guarda-Sul",
        raceCode: "humans",
        lineageCode: "human_valorian",
        cultureCode: "valewatch_civic",
        backgroundCode: "merchant",
        originRegionId: "region-ashvale",
        appearance: {
          bodyPreset: "athletic_a",
          skinTone: "warm_ivory",
          hairStyle: "windswept_long",
          hairColor: "raven_black",
          eyeStyle: "round_bright",
          eyeColor: "amber_gold",
          earStyle: "rounded_standard",
        },
        presetCode: "arcanist",
      })
    ).data;

    // Character on DIFFERENT account B
    const charB1 = (
      await charEngine.createCharacter({
        commandId: `s04:b1:${randomUUID()}`,
        principal: { kind: "authenticated_account", accountId: accB.id },
        accountId: accB.id,
        characterName: "Garrick Mercador",
        raceCode: "dwarves",
        lineageCode: "dwarf_mountain",
        cultureCode: "ironforge_guildpact",
        backgroundCode: "blacksmith_apprentice",
        originRegionId: "granite-peaks",
        appearance: {
          bodyPreset: "forged_broad_a",
          skinTone: "granite_tan",
          hairStyle: "braided_crown",
          hairColor: "copper_red",
          eyeStyle: "deep_set",
          eyeColor: "slate_blue",
          earStyle: "rounded_broad",
        },
        presetCode: "berserker",
      })
    ).data;

    // #34 & #35: Durability wear to 0 (broken) suppresses combat equipment from CharacterSnapshotV1 without deleting item; repair restores it!
    const boots = (
      await invEngine.grantProceduralEquipment({
        grantId: `s04:dur:boots:${charA1.id}`,
        principal: SYSTEM_AUTHORITY,
        recipientCharacterId: charA1.id,
        definitionCode: "explorer_strider_boots", // maxDurability: 95, unbound
        rarityCode: "rare",
        originType: "exploration",
        originReference: "ruins:1",
      })
    ).data;

    await invEngine.equipItem({
      commandId: "s04:dur:equip-boots",
      principal: pA,
      characterId: charA1.id,
      itemInstanceId: boots.id,
      targetSlot: "feet",
      expectedBuildVersion: 1,
    });
    assert.equal(
      (await charSnapReader.getCharacterSnapshot(charA1.id, { principal: pA })).equippedItems.length,
      1,
    );

    const brokenBoots = await invEngine.applyDurabilityLoss({
      commandId: "s04:dur:break-boots-to-zero",
      principal: SYSTEM_AUTHORITY,
      characterId: charA1.id,
      itemInstanceId: boots.id,
      durabilityLoss: 500, // clamped to 0!
      causeReference: "combat:acid-trap",
    });
    assert.equal(brokenBoots.data.currentDurability, 0);

    // Broken boots are suppressed from active combat CharacterSnapshotV1, yet still owned!
    const snapWhileBroken = await charSnapReader.getCharacterSnapshot(charA1.id, { principal: pA });
    assert.equal(snapWhileBroken.equippedItems.length, 0);
    assert.equal((await invRepo.listCharacterItems(charA1.id)).length, 1);

    const repairedBoots = await invEngine.repairItem({
      commandId: "s04:dur:repair-boots",
      principal: SYSTEM_AUTHORITY,
      characterId: charA1.id,
      itemInstanceId: boots.id,
      repairAmount: 999, // clamped to maxDurability=95!
      causeReference: "npc:smith-ironford",
    });
    assert.equal(repairedBoots.data.currentDurability, 95);
    assert.equal(
      (await charSnapReader.getCharacterSnapshot(charA1.id, { principal: pA })).equippedItems.length,
      1,
    );

    // #36, #37 & #38: Binding rules (`bind_on_equip` transitions on equip; `account_bound` transfers within account A1->A2, blocked A2->B1)
    const boeSword = (
      await invEngine.grantProceduralEquipment({
        grantId: `s04:bind:boe:${charA1.id}`,
        principal: SYSTEM_AUTHORITY,
        recipientCharacterId: charA1.id,
        definitionCode: "ironfang_longsword", // bind_on_equip
        rarityCode: "rare",
        originType: "dungeon_reward",
        originReference: "d1",
      })
    ).data;
    assert.equal(boeSword.bindingState, "bind_on_equip");

    // Equipping transitions bind_on_equip -> character_bound; even after unequipping, transfer is forbidden!
    await invEngine.equipItem({
      commandId: "s04:bind:equip-boe",
      principal: pA,
      characterId: charA1.id,
      itemInstanceId: boeSword.id,
      targetSlot: "main_hand",
      expectedBuildVersion: 2,
    });
    await invEngine.unequipItem({
      commandId: "s04:bind:unequip-boe",
      principal: pA,
      characterId: charA1.id,
      slotCode: "main_hand",
      expectedBuildVersion: 3,
    });
    await assert.rejects(
      () =>
        invEngine.transferItemInstance({
          commandId: "s04:bind:reject-boe-after-equip",
          principal: pA,
          fromCharacterId: charA1.id,
          toCharacterId: charA2.id,
          itemInstanceId: boeSword.id,
        }),
      ItemBindingViolationError,
    );

    // Account-bound amulet transfers cleanly from charA1 -> charA2 (same account), but is rejected from charA2 -> charB1 (different account)!
    const acctAmulet = (
      await invEngine.grantProceduralEquipment({
        grantId: `s04:bind:amulet:${charA1.id}`,
        principal: SYSTEM_AUTHORITY,
        recipientCharacterId: charA1.id,
        definitionCode: "ancestral_hearth_amulet", // account_bound
        rarityCode: "epic",
        originType: "quest_reward",
        originReference: "heirloom-q",
      })
    ).data;
    assert.equal(acctAmulet.bindingState, "account_bound");

    const sameAccTransfer = await invEngine.transferItemInstance({
      commandId: "s04:bind:amulet-a1-to-a2",
      principal: pA,
      fromCharacterId: charA1.id,
      toCharacterId: charA2.id,
      itemInstanceId: acctAmulet.id,
    });
    assert.equal(sameAccTransfer.data.ownerCharacterId, charA2.id);
    assert.equal(sameAccTransfer.data.bindingState, "account_bound");

    await assert.rejects(
      () =>
        invEngine.transferItemInstance({
          commandId: "s04:bind:amulet-a2-to-b1-forbidden",
          principal: pA,
          fromCharacterId: charA2.id,
          toCharacterId: charB1.id,
          itemInstanceId: acctAmulet.id,
        }),
      ItemBindingViolationError,
    );

    // #39: Real concurrent double-transfer race!
    // Grant 1 unbound dagger to charA1, then fire TWO concurrent transfers (charA1 -> charA2 AND charA1 -> charB1) simultaneously!
    const contestedDagger = (
      await invEngine.grantProceduralEquipment({
        grantId: `s04:race:dagger:${charA1.id}`,
        principal: SYSTEM_AUTHORITY,
        recipientCharacterId: charA1.id,
        definitionCode: "thornveil_dagger", // unbound
        rarityCode: "epic",
        originType: "boss_drop",
        originReference: "race-boss",
      })
    ).data;

    const raceOutcome = await Promise.allSettled([
      invEngine.transferItemInstance({
        commandId: `s04:race:to-a2:${randomUUID()}`,
        principal: pA,
        fromCharacterId: charA1.id,
        toCharacterId: charA2.id,
        itemInstanceId: contestedDagger.id,
      }),
      invEngine.transferItemInstance({
        commandId: `s04:race:to-b1:${randomUUID()}`,
        principal: pA,
        fromCharacterId: charA1.id,
        toCharacterId: charB1.id,
        itemInstanceId: contestedDagger.id,
      }),
    ]);

    const raceFulfilled = raceOutcome.filter((r) => r.status === "fulfilled");
    const raceRejected = raceOutcome.filter((r) => r.status === "rejected");
    assert.equal(raceFulfilled.length, 1);
    assert.equal(raceRejected.length, 1);

    // Confirm across the entire PostgreSQL database that `contestedDagger.id` exists ONCE with a single owner!
    const dbDaggerCount = await pgCtx.pool.query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM item_instances WHERE id = $1",
      [contestedDagger.id],
    );
    assert.equal(dbDaggerCount.rows[0]?.cnt, "1");

    // #40 & #41: Pre-commit fault injection rollback & clean timeout/retry recovery (zero partial inbox/ledger/instance rows!)
    let injectFailure = true;
    const faultEngine = new InventoryEngineService({
      pool: pgCtx.pool,
      logger: silentLogger,
      beforeCommitHook: async () => {
        if (injectFailure) {
          throw new Error("SIMULATED_PRE_COMMIT_CRASH");
        }
      },
    });

    await assert.rejects(
      () =>
        faultEngine.grantProceduralEquipment({
          grantId: "s04:fault:recoverable-grant",
          principal: SYSTEM_AUTHORITY,
          recipientCharacterId: charA1.id,
          definitionCode: "ashen_watch_helm",
          rarityCode: "rare",
          originType: "quest_reward",
          originReference: "fault-quest",
        }),
      /SIMULATED_PRE_COMMIT_CRASH/,
    );

    // Verify zero leaked rows in item_grants or item_operation_ledger after rollback
    const leakedGrant = await pgCtx.pool.query(
      "SELECT 1 FROM item_grants WHERE external_grant_id = 's04:fault:recoverable-grant'",
    );
    assert.equal(leakedGrant.rowCount, 0);

    // Now heal fault and retry exact same grantId -> succeeds cleanly!
    injectFailure = false;
    const recoveredGrant = await faultEngine.grantProceduralEquipment({
      grantId: "s04:fault:recoverable-grant",
      principal: SYSTEM_AUTHORITY,
      recipientCharacterId: charA1.id,
      definitionCode: "ashen_watch_helm",
      rarityCode: "rare",
      originType: "quest_reward",
      originReference: "fault-quest",
    });
    assert.equal(recoveredGrant.status, "applied");

    // #44: Genesis Ranked isolation across inventory mutations & snapshot readers
    await assert.rejects(
      () =>
        invEngine.equipItem({
          commandId: "s04:genesis:equip-forbidden",
          principal: pA,
          characterId: charA1.id,
          itemInstanceId: recoveredGrant.data.id,
          targetSlot: "head",
          expectedBuildVersion: 4,
          executionProfile: "genesis_ranked_md3_scratch",
        }),
      GenesisTemporaryStatePersistenceForbiddenError,
    );
    const equipReader = new PostgresEquipmentSnapshotReader(pgCtx.pool);
    await assert.rejects(
      () =>
        equipReader.getEquipmentSnapshot(charA1.id, {
          principal: pA,
          normalizationProfile: "genesis_ranked_md3_scratch" as unknown as "open_world_persistent",
        }),
      GenesisTemporaryStatePersistenceForbiddenError,
    );

    // #45 & #47: Restart real PostgreSQL server and verify full persistent recovery of items, durability, bindings & ledger!
    const newPool = await pgCtx.restartAndReconnect();
    invRepo = new PostgresInventoryRepository(newPool);
    invEngine = new InventoryEngineService({ pool: newPool, logger: silentLogger });
    charSnapReader = new PostgresCharacterSnapshotReader(newPool);

    const postRestartSnap = await charSnapReader.getCharacterSnapshot(charA1.id, { principal: pA });
    const postRestartItems = await invRepo.listCharacterItems(charA1.id);
    const postRestartLedger = await invRepo.listCharacterLedger(charA1.id);
    assert.equal(postRestartSnap.equippedItems.length, 1);
    assert.equal(postRestartSnap.equippedItems[0]?.itemInstanceId, boots.id);
    assert.ok(postRestartItems.some((i) => i.id === recoveredGrant.data.id));
    assert.ok(postRestartLedger.length >= 8);
  });
});
