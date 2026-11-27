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
import {
  CharacterCompetitiveLockedError,
  GenesisTemporaryStatePersistenceForbiddenError,
} from "../modules/characters/domain/errors.js";
import {
  PostgresCharacterRepository,
  PostgresCharacterUnitOfWork,
} from "../modules/characters/infrastructure/postgres-character-unit-of-work.js";
import { PostgresEquipmentSnapshotReader } from "../modules/inventory/application/equipment-snapshot-query.js";
import { InventoryEngineService } from "../modules/inventory/application/inventory-engine-service.js";
import {
  EquipmentRequirementNotMetError,
  ItemBindingViolationError,
  ItemOwnershipForbiddenError,
} from "../modules/inventory/domain/errors.js";
import { PostgresInventoryRepository } from "../modules/inventory/infrastructure/postgres-inventory-unit-of-work.js";
import { runProceduralGenerationSimulation } from "../modules/inventory/simulation/procedural-item-simulator.js";
import { PostgresCatalogRepository } from "../modules/peoples/infrastructure/postgres-catalog-repository.js";
import { migrateUp } from "../shared/db/migrator.js";
import { StructuredLogger } from "../shared/observability/logger.js";
import { startPostgresTestContext } from "../../tests/helpers/postgres-test-harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

async function runSession04Demo(): Promise<void> {
  const logger = new StructuredLogger("info");
  logger.info("Starting CARBON Session 04 headless inventory, equipment & procedural item demo", {
    operation: "demo04:start",
  });

  // 1. Initialize isolated PostgreSQL
  const pgCtx = await startPostgresTestContext();

  try {
    // 2. Apply all migrations (0001..0007)
    const applied = await migrateUp(pgCtx.pool, MIGRATIONS_DIR);
    logger.info("Step 2: Migrations 0001..0007 applied", {
      operation: "demo04:migrate",
      applied,
    });

    // 3. Load & seed catalogs (peoples, progression_rules, rarities, affixes, 20 item definitions)
    const catalogRepo = new PostgresCatalogRepository(pgCtx.pool);
    let charRepo = new PostgresCharacterRepository(pgCtx.pool);
    let invRepo = new PostgresInventoryRepository(pgCtx.pool);
    await catalogRepo.seedInitialCatalogs();
    await charRepo.seedProgressionRules();
    await invRepo.seedInitialItemCatalogs();

    // 4. Create two characters (on two distinct accounts so we can demonstrate cross-account & binding rules)
    const accountA = await charRepo.createAccount({
      id: randomUUID(),
      externalSubject: "demo04-account-a",
    });
    const accountB = await charRepo.createAccount({
      id: randomUUID(),
      externalSubject: "demo04-account-b",
    });

    const principalA: AuthorityPrincipal = {
      kind: "authenticated_account",
      accountId: accountA.id,
    };
    const principalB: AuthorityPrincipal = {
      kind: "authenticated_account",
      accountId: accountB.id,
    };
    const systemPrincipal: AuthorityPrincipal = {
      kind: "internal_system_authority",
      actorId: "world-loot-director",
    };

    const charEngine = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(pgCtx.pool),
      logger,
    });
    let invEngine = new InventoryEngineService({
      pool: pgCtx.pool,
      logger,
    });

    const heroACreate = await charEngine.createCharacter({
      commandId: "demo04:create:kael-vanguard",
      principal: principalA,
      accountId: accountA.id,
      characterName: "Kael Quebra-Ferro",
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
      presetCode: "berserker", // Strength +20 (total 25), Fortitude +12 (total 17), Vigor +18 (total 23)
    });
    const heroBCreate = await charEngine.createCharacter({
      commandId: "demo04:create:lyra-scholar",
      principal: principalB,
      accountId: accountB.id,
      characterName: "Lyra Bruma-Prata",
      raceCode: "elves",
      lineageCode: "elf_lunar",
      cultureCode: "arcane_collegium",
      backgroundCode: "arcane_scholar",
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
      presetCode: "arcanist", // Strength base = 5 (< 18 required for 2H greataxe!)
    });

    const heroAId = heroACreate.data.id;
    const heroBId = heroBCreate.data.id;

    // Grant 500 XP to Hero A so Hero A reaches Level 3 (requiredLevel=3 for crimson_clan_greataxe)
    await charEngine.grantExperience({
      grantId: "demo04:xp:kael-lv3",
      principal: systemPrincipal,
      characterId: heroAId,
      sourceType: "boss",
      sourceReference: "boss:ironfang-warden",
      amount: "500",
    });

    // 5–7. Generate two unique instances of Espada de Ironfang and grant one to each character, demonstrating distinct properties
    const swordGrantA = await invEngine.grantProceduralEquipment({
      grantId: "demo04:grant:sword-hero-a",
      sourceEventId: "boss-kill:warden-001",
      rewardSlotIndex: 0,
      principal: systemPrincipal,
      recipientCharacterId: heroAId,
      definitionCode: "ironfang_longsword",
      itemLevel: 15,
      rarityCode: "epic",
      originType: "boss_drop",
      originReference: "boss:ironfang-warden",
      serverSeed: "warden-drop-seed-alpha",
    });
    const swordGrantB = await invEngine.grantProceduralEquipment({
      grantId: "demo04:grant:sword-hero-b",
      sourceEventId: "boss-kill:warden-001",
      rewardSlotIndex: 1,
      principal: systemPrincipal,
      recipientCharacterId: heroBId,
      definitionCode: "ironfang_longsword",
      itemLevel: 15,
      rarityCode: "rare",
      originType: "boss_drop",
      originReference: "boss:ironfang-warden",
      serverSeed: "warden-drop-seed-beta",
    });

    const swordA = swordGrantA.data;
    const swordB = swordGrantB.data;
    assert.notEqual(swordA.id, swordB.id);
    assert.notEqual(swordA.generationSeedHash, swordB.generationSeedHash);
    assert.notDeepEqual(
      { rarity: swordA.rarityCode, qualityBp: swordA.qualityBp, affixes: swordA.affixes },
      { rarity: swordB.rarityCode, qualityBp: swordB.qualityBp, affixes: swordB.affixes },
    );
    logger.info("Steps 5-7: Two distinct Espada de Ironfang instances generated & granted", {
      operation: "demo04:distinct-swords",
      sword_a: {
        id: swordA.id,
        rarity: swordA.rarityCode,
        quality_bp: swordA.qualityBp,
        affixes: swordA.affixes.map((a) => `${a.affixCode}(+${a.rolledMagnitude})`),
      },
      sword_b: {
        id: swordB.id,
        rarity: swordB.rarityCode,
        quality_bp: swordB.qualityBp,
        affixes: swordB.affixes.map((a) => `${a.affixCode}(+${a.rolledMagnitude})`),
      },
    });

    // 8–9. Re-send identical grant -> confirm zero duplication
    const duplicateSwordGrant = await invEngine.grantProceduralEquipment({
      grantId: "demo04:grant:sword-hero-a",
      sourceEventId: "boss-kill:warden-001",
      rewardSlotIndex: 0,
      principal: systemPrincipal,
      recipientCharacterId: heroAId,
      definitionCode: "ironfang_longsword",
      itemLevel: 15,
      rarityCode: "epic",
      originType: "boss_drop",
      originReference: "boss:ironfang-warden",
      serverSeed: "warden-drop-seed-alpha",
    });
    assert.equal(duplicateSwordGrant.status, "duplicate_idempotent");
    assert.equal((await invRepo.listCharacterItems(heroAId)).length, 1);

    // 10–12. Add stackable Minério de Ferro (120 units), split 45 units, then merge back conserving exact 120 total
    const oreGrant = await invEngine.grantStackableMaterial({
      grantId: "demo04:grant:iron-ore-120",
      principal: systemPrincipal,
      recipientCharacterId: heroAId,
      definitionCode: "iron_ore",
      quantity: 120,
      qualityBp: 6000,
      originType: "gathering",
      originReference: "node:granite-vein-07",
    });
    const initialOreStack = oreGrant.data[0]!;
    assert.equal(initialOreStack.quantity, 120);

    const splitRes = await invEngine.splitStack({
      commandId: "demo04:split:iron-ore-45",
      principal: principalA,
      characterId: heroAId,
      sourceStackId: initialOreStack.id,
      splitQuantity: 45,
    });
    assert.equal(splitRes.data.updatedSource.quantity, 75);
    assert.equal(splitRes.data.createdSplit.quantity, 45);

    const mergeRes = await invEngine.mergeStacks({
      commandId: "demo04:merge:iron-ore-rejoin",
      principal: principalA,
      characterId: heroAId,
      sourceStackId: splitRes.data.createdSplit.id,
      targetStackId: splitRes.data.updatedSource.id,
    });
    assert.equal(mergeRes.data.quantity, 120);
    assert.equal((await invRepo.listCharacterStacks(heroAId)).length, 1);

    // Grant shield, guardian armor, and 2H greataxe to Hero A; also grant 2H greataxe to Hero B (Level 1, low Strength)
    const shieldGrant = await invEngine.grantProceduralEquipment({
      grantId: "demo04:grant:shield-hero-a",
      principal: systemPrincipal,
      recipientCharacterId: heroAId,
      definitionCode: "valewatch_tower_shield",
      rarityCode: "uncommon",
      originType: "quest_reward",
      originReference: "quest:border-defense",
    });
    const armorGrant = await invEngine.grantProceduralEquipment({
      grantId: "demo04:grant:armor-hero-a",
      principal: systemPrincipal,
      recipientCharacterId: heroAId,
      definitionCode: "guardian_plate_cuirass",
      rarityCode: "rare",
      originType: "dungeon_reward",
      originReference: "dungeon:ironhold",
    });
    const axeGrantA = await invEngine.grantProceduralEquipment({
      grantId: "demo04:grant:greataxe-hero-a",
      principal: systemPrincipal,
      recipientCharacterId: heroAId,
      definitionCode: "crimson_clan_greataxe",
      rarityCode: "legendary",
      originType: "boss_drop",
      originReference: "boss:crimson-warlord",
    });
    const axeGrantB = await invEngine.grantProceduralEquipment({
      grantId: "demo04:grant:greataxe-hero-b",
      principal: systemPrincipal,
      recipientCharacterId: heroBId,
      definitionCode: "crimson_clan_greataxe",
      rarityCode: "rare",
      originType: "boss_drop",
      originReference: "boss:crimson-warlord",
    });

    // 13. Equip 1H sword, off-hand shield, and chest armor on Hero A
    await invEngine.equipItem({
      commandId: "demo04:equip:sword-a",
      principal: principalA,
      characterId: heroAId,
      itemInstanceId: swordA.id,
      targetSlot: "main_hand",
      expectedBuildVersion: 1,
    });
    await invEngine.equipItem({
      commandId: "demo04:equip:shield-a",
      principal: principalA,
      characterId: heroAId,
      itemInstanceId: shieldGrant.data.id,
      targetSlot: "off_hand",
      expectedBuildVersion: 2,
    });
    const afterArmorEquip = await invEngine.equipItem({
      commandId: "demo04:equip:armor-a",
      principal: principalA,
      characterId: heroAId,
      itemInstanceId: armorGrant.data.id,
      targetSlot: "chest",
      expectedBuildVersion: 3,
    });
    assert.equal(afterArmorEquip.data.slots.length, 3);

    // 14. Validate requirements: Hero B (Level 1 Arcanist) tries to equip crimson_clan_greataxe (requires Lv 3 & STR 18) -> rejected!
    await assert.rejects(
      () =>
        invEngine.equipItem({
          commandId: "demo04:equip:illegal-axe-hero-b",
          principal: principalB,
          characterId: heroBId,
          itemInstanceId: axeGrantB.data.id,
          targetSlot: "main_hand",
          expectedBuildVersion: 1,
        }),
      EquipmentRequirementNotMetError,
    );

    // 15. Demonstrate two-handed weapon on Hero A: equipping crimson_clan_greataxe automatically displaces BOTH 1H sword AND off-hand shield!
    const twoHandEquip = await invEngine.equipItem({
      commandId: "demo04:equip:greataxe-a",
      principal: principalA,
      characterId: heroAId,
      itemInstanceId: axeGrantA.data.id,
      targetSlot: "main_hand",
      expectedBuildVersion: 4,
    });
    assert.equal(twoHandEquip.data.slots.length, 2); // main_hand (2H axe with occupiesOffHand=true) + chest (armor)
    assert.equal(
      twoHandEquip.data.slots.find((s) => s.slotCode === "main_hand")?.occupiesOffHand,
      true,
    );
    assert.equal(
      twoHandEquip.data.slots.find((s) => s.slotCode === "off_hand"),
      undefined,
    );

    // 16–17. Create secondary Sword-and-Board loadout ("Vanguarda Escudo") and switch between loadouts!
    const savedVanguardLoadout = await invEngine.saveInactiveLoadout({
      commandId: "demo04:loadout:save-vanguard",
      principal: principalA,
      characterId: heroAId,
      loadoutName: "Vanguarda Escudo",
      assignments: [
        { slotCode: "main_hand", itemInstanceId: swordA.id },
        { slotCode: "off_hand", itemInstanceId: shieldGrant.data.id },
        { slotCode: "chest", itemInstanceId: armorGrant.data.id },
      ],
    });
    const activatedVanguard = await invEngine.activateLoadout({
      commandId: "demo04:loadout:activate-vanguard",
      principal: principalA,
      characterId: heroAId,
      loadoutId: savedVanguardLoadout.data.id,
      expectedBuildVersion: 5,
    });
    assert.equal(activatedVanguard.data.isActive, true);
    assert.equal(activatedVanguard.data.slots.length, 3);

    // 18. Apply combat durability wear on equipped sword (120 -> 95)
    const afterWear = await invEngine.applyDurabilityLoss({
      commandId: "demo04:durability:wear-sword-a",
      principal: systemPrincipal,
      characterId: heroAId,
      itemInstanceId: swordA.id,
      durabilityLoss: 25,
      causeReference: "combat-encounter:ironfang-01",
    });
    assert.equal(afterWear.data.currentDurability, 95);

    // 19. Demonstrate bound item protection: grant bind_on_pickup Anel do Vazio -> character_bound -> transfer to Hero B rejected!
    const voidRingGrant = await invEngine.grantProceduralEquipment({
      grantId: "demo04:grant:void-ring-a",
      principal: systemPrincipal,
      recipientCharacterId: heroAId,
      definitionCode: "void_signet_ring",
      rarityCode: "relic",
      originType: "boss_drop",
      originReference: "boss:abyssal-archon",
    });
    assert.equal(voidRingGrant.data.bindingState, "character_bound");
    await assert.rejects(
      () =>
        invEngine.transferItemInstance({
          commandId: "demo04:transfer:forbidden-void-ring",
          principal: principalA,
          fromCharacterId: heroAId,
          toCharacterId: heroBId,
          itemInstanceId: voidRingGrant.data.id,
        }),
      ItemBindingViolationError,
    );

    // 20. Attempt unauthorized operation (player principal trying to execute authoritative item grant) -> rejected!
    await assert.rejects(
      () =>
        invEngine.grantProceduralEquipment({
          grantId: "demo04:grant:illegal-player-forged",
          principal: principalA,
          recipientCharacterId: heroAId,
          definitionCode: "ironfang_longsword",
          rarityCode: "mythic",
          originType: "boss_drop",
          originReference: "forged",
        }),
      ItemOwnershipForbiddenError,
    );

    // 21. Query updated CharacterSnapshotV1 & companion EquipmentSnapshotProposalV1
    const charSnapReader = new PostgresCharacterSnapshotReader(pgCtx.pool);
    const equipSnapReader = new PostgresEquipmentSnapshotReader(pgCtx.pool);
    const heroASnapshot = await charSnapReader.getCharacterSnapshot(heroAId, {
      principal: systemPrincipal,
      normalizationProfile: "open_world_persistent",
    });
    const heroAWire = serializeCharacterSnapshotWireV1(heroASnapshot);
    const heroAEquipSnap = await equipSnapReader.getEquipmentSnapshot(heroAId, {
      principal: systemPrincipal,
    });
    assert.equal(heroAWire.equipped_items.length, 3);
    assert.equal(heroAWire.build_version, 6);

    const sim1k = runProceduralGenerationSimulation({
      sampleSize: 1000,
      batchSeedPrefix: "demo04-stat-check",
    });
    logger.info("Step 21: CharacterSnapshotV1, EquipmentSnapshotProposalV1 & 1k Statistical Sim verified", {
      operation: "demo04:snapshots",
      equipped_items: heroAWire.equipped_items,
      equipment_modifiers: heroAEquipSnap.equipmentModifiers,
      sim_1k_checksum: sim1k.deterministicChecksum,
      sim_1k_unique_combos: sim1k.uniqueAffixCombinationCount,
    });

    // 22. Simulate competitive lock (`in_ranked_series`) -> block equipment swap, then release lock
    await charRepo.setCharacterCompetitiveLock(heroAId, "in_ranked_series");
    await assert.rejects(
      () =>
        invEngine.unequipItem({
          commandId: "demo04:unequip:blocked-by-md3",
          principal: principalA,
          characterId: heroAId,
          slotCode: "off_hand",
          expectedBuildVersion: 6,
        }),
      CharacterCompetitiveLockedError,
    );
    await charRepo.setCharacterCompetitiveLock(heroAId, "none");

    // 23. Demonstrate Genesis temporary state rejection across inventory/snapshot operations
    await assert.rejects(
      () =>
        invEngine.grantProceduralEquipment({
          grantId: "demo04:genesis:forbidden",
          principal: systemPrincipal,
          recipientCharacterId: heroAId,
          definitionCode: "ironfang_longsword",
          rarityCode: "epic",
          originType: "administrative_grant",
          originReference: "genesis-match",
          executionProfile: "genesis_ranked_md3_scratch",
        }),
      GenesisTemporaryStatePersistenceForbiddenError,
    );

    // 24–25. Restart PostgreSQL server / reconnect pool and confirm full durable recovery of items, stacks, loadouts, and durability
    const reconnectedPool = await pgCtx.restartAndReconnect();
    invRepo = new PostgresInventoryRepository(reconnectedPool);
    invEngine = new InventoryEngineService({ pool: reconnectedPool, logger });
    const postRestartSnapReader = new PostgresCharacterSnapshotReader(reconnectedPool);

    const recoveredSnap = await postRestartSnapReader.getCharacterSnapshot(heroAId, {
      principal: principalA,
    });
    const recoveredItems = await invRepo.listCharacterItems(heroAId);
    const recoveredStacks = await invRepo.listCharacterStacks(heroAId);
    const recoveredLedger = await invRepo.listCharacterLedger(heroAId);
    const recoveredSword = recoveredItems.find((i) => i.id === swordA.id);

    assert.equal(recoveredSnap.equippedItems.length, 3);
    assert.equal(recoveredSword?.currentDurability, 95);
    assert.equal(recoveredSword?.bindingState, "character_bound");
    assert.equal(recoveredStacks[0]?.quantity, 120);
    assert.ok(recoveredLedger.length >= 10);

    logger.info("Step 25: Full persistent recovery of inventories, loadouts, durability & ledger confirmed", {
      operation: "demo04:complete",
      result: "ok",
      embedded_postgres_restarted: pgCtx.isEmbedded,
      hero_a_items: recoveredItems.length,
      hero_a_equipped_slots: recoveredSnap.equippedItems.length,
      sword_durability_after_restart: recoveredSword?.currentDurability,
      iron_ore_total_after_restart: recoveredStacks[0]?.quantity,
      ledger_entries_recorded: recoveredLedger.length,
    });
  } finally {
    await pgCtx.stop();
  }
}

runSession04Demo().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`Session 04 demo failed: ${msg}\n`);
  process.exitCode = 1;
});
