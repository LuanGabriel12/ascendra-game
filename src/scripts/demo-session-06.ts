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
import { InventoryEngineService } from "../modules/inventory/application/inventory-engine-service.js";
import { PostgresInventoryRepository } from "../modules/inventory/infrastructure/postgres-inventory-unit-of-work.js";
import { PostgresCatalogRepository } from "../modules/peoples/infrastructure/postgres-catalog-repository.js";
import {
  PostgresAbilitySnapshotReader,
  assertConsistentCombatSnapshots,
  serializeAbilitySnapshotWireV1,
} from "../modules/skills/application/ability-snapshot-query.js";
import { SkillEngineService } from "../modules/skills/application/skill-engine-service.js";
import { DEFAULT_MASTERY_AND_SKILL_RULES_V1 } from "../modules/skills/catalog/initial-skills-catalog.js";
import {
  AbilityLoadoutInvalidError,
  SpecializationBudgetInsufficientError,
} from "../modules/skills/domain/errors.js";
import { cumulativeMasteryXpForLevel } from "../modules/skills/domain/mastery-and-dag-rules.js";
import { PostgresSkillRepository } from "../modules/skills/infrastructure/postgres-skill-unit-of-work.js";
import { runSkillProgressionSimulation } from "../modules/skills/simulation/skill-progression-simulator.js";
import { SocialEngineService } from "../modules/social/application/social-engine-service.js";
import { PostgresSocialRepository } from "../modules/social/infrastructure/postgres-social-unit-of-work.js";
import { migrateUp } from "../shared/db/migrator.js";
import { StructuredLogger } from "../shared/observability/logger.js";
import { startPostgresTestContext } from "../../tests/helpers/postgres-test-harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

async function runSession06Demo(): Promise<void> {
  const logger = new StructuredLogger("info");
  logger.info(
    "Starting CARBON Session 06 headless skills, specialization, weapon mastery & build customization demo",
    { operation: "demo06:start" },
  );

  // 1. Initialize isolated PostgreSQL
  const pgCtx = await startPostgresTestContext();

  try {
    // 2. Apply migrations 0001..0011
    const applied = await migrateUp(pgCtx.pool, MIGRATIONS_DIR);
    logger.info("Step 2: Migrations 0001..0011 applied", {
      operation: "demo06:migrate",
      applied,
    });

    // 3. Load & seed all persistent catalogs (Peoples, Progression, Items, Social, Skills & Mastery)
    const catalogRepo = new PostgresCatalogRepository(pgCtx.pool);
    const charRepo = new PostgresCharacterRepository(pgCtx.pool);
    const invRepo = new PostgresInventoryRepository(pgCtx.pool);
    let socialRepo = new PostgresSocialRepository(pgCtx.pool);
    let skillRepo = new PostgresSkillRepository(pgCtx.pool);

    await catalogRepo.seedInitialCatalogs();
    await charRepo.seedProgressionRules();
    await invRepo.seedInitialItemCatalogs();
    await socialRepo.seedInitialSocialCatalogs();
    await skillRepo.seedInitialSkillCatalogs();

    const catalogCounts = await skillRepo.listCatalogCounts();
    const simSummary = runSkillProgressionSimulation();
    logger.info("Step 3: Catalogs seeded & 6-archetype progression simulation verified", {
      operation: "demo06:catalogs",
      catalog_counts: catalogCounts,
      simulated_archetypes: simSummary.archetypeComparisons.map((a) => ({
        archetype: a.archetypeCode,
        schools: a.schoolsCombined,
        equip_cost: `${a.buildEquipmentCostUsed}/${a.buildEquipmentCostMax}`,
      })),
    });

    // 4. Create characters:
    //    - Lyra Lâmina-Rúnica (Emergent Arcane Knight: Swordsmanship + Arcane Arts)
    //    - Gorim Punho-Vivo (Emergent Martial Monk for specialization respec demonstration)
    const accLyra = await charRepo.createAccount({ id: randomUUID(), externalSubject: "demo06-lyra" });
    const accGorim = await charRepo.createAccount({ id: randomUUID(), externalSubject: "demo06-gorim" });
    const pLyra: AuthorityPrincipal = { kind: "authenticated_account", accountId: accLyra.id };
    const pGorim: AuthorityPrincipal = { kind: "authenticated_account", accountId: accGorim.id };
    const sysAuth: AuthorityPrincipal = {
      kind: "internal_system_authority",
      actorId: "skill-progression-director",
    };

    const charEngine = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(pgCtx.pool),
      logger,
    });
    const invEngine = new InventoryEngineService({ pool: pgCtx.pool, logger });
    let skillEngine = new SkillEngineService({ pool: pgCtx.pool, logger });
    let socialEngine = new SocialEngineService({ pool: pgCtx.pool, logger });
    let charSnapReader = new PostgresCharacterSnapshotReader(pgCtx.pool);
    let abilitySnapReader = new PostgresAbilitySnapshotReader(pgCtx.pool);

    let lyra = (
      await charEngine.createCharacter({
        commandId: "demo06:char:lyra",
        principal: pLyra,
        accountId: accLyra.id,
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
          strength: 10,
          fortitude: 10,
          dexterity: 8,
          intelligence: 14,
          wisdom: 8,
        },
      })
    ).data;

    const gorim = (
      await charEngine.createCharacter({
        commandId: "demo06:char:gorim",
        principal: pGorim,
        accountId: accGorim.id,
        characterName: "Gorim Punho-Vivo",
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
        presetCode: "monk",
      })
    ).data;

    lyra = (
      await charEngine.grantExperience({
        grantId: "demo06:xp:lyra-lvl4",
        principal: sysAuth,
        characterId: lyra.id,
        sourceType: "quest",
        sourceReference: "quest:ashvale-sanctum",
        amount: 3500n,
      })
    ).data.character;

    // 5. Grant authorized weapons (longsword, off-hand grimoire, 2H staff)
    const longsword = (
      await invEngine.grantProceduralEquipment({
        grantId: "demo06:item:lyra-sword",
        principal: sysAuth,
        recipientCharacterId: lyra.id,
        definitionCode: "ironfang_longsword",
        rarityCode: "epic",
        originType: "quest_reward",
        originReference: "quest:runeblade",
      })
    ).data;
    const grimoire = (
      await invEngine.grantProceduralEquipment({
        grantId: "demo06:item:lyra-grimoire",
        principal: sysAuth,
        recipientCharacterId: lyra.id,
        definitionCode: "astral_vigil_grimoire",
        rarityCode: "rare",
        originType: "quest_reward",
        originReference: "quest:astral-vigil",
      })
    ).data;
    const staff = (
      await invEngine.grantProceduralEquipment({
        grantId: "demo06:item:lyra-staff",
        principal: sysAuth,
        recipientCharacterId: lyra.id,
        definitionCode: "twilight_staff",
        rarityCode: "epic",
        originType: "dungeon_reward",
        originReference: "dungeon:twilight-spire",
      })
    ).data;

    // 6, 7, 8 & 9. Register & advance independent sword (`longsword`) and magic (`grimoire` & `staff_2h`) masteries
    const swordXp26 = cumulativeMasteryXpForLevel(26, DEFAULT_MASTERY_AND_SKILL_RULES_V1);
    const swordMasteryRes = await skillEngine.grantWeaponMasteryExperience({
      grantId: "demo06:mastery:lyra-longsword-26",
      sourceEventId: "combat:siege-valewatch-01",
      principal: sysAuth,
      characterId: lyra.id,
      weaponFamilyCode: "longsword",
      sourceType: "validated_combat",
      experienceAmount: swordXp26,
    });
    const grimoireMasteryRes = await skillEngine.grantWeaponMasteryExperience({
      grantId: "demo06:mastery:lyra-grimoire-12",
      sourceEventId: "combat:siege-valewatch-02",
      principal: sysAuth,
      characterId: lyra.id,
      weaponFamilyCode: "grimoire",
      sourceType: "validated_combat",
      experienceAmount: cumulativeMasteryXpForLevel(12, DEFAULT_MASTERY_AND_SKILL_RULES_V1),
    });
    const staffMasteryRes = await skillEngine.grantWeaponMasteryExperience({
      grantId: "demo06:mastery:lyra-staff-16",
      sourceEventId: "combat:siege-valewatch-03",
      principal: sysAuth,
      characterId: lyra.id,
      weaponFamilyCode: "staff_2h",
      sourceType: "validated_combat",
      experienceAmount: cumulativeMasteryXpForLevel(16, DEFAULT_MASTERY_AND_SKILL_RULES_V1),
    });

    assert.equal(swordMasteryRes.data.mastery.masteryLevel, 26);
    assert.equal(swordMasteryRes.data.mastery.proficiencyRank, "practitioner");
    assert.equal(grimoireMasteryRes.data.mastery.masteryLevel, 12);
    assert.equal(staffMasteryRes.data.mastery.masteryLevel, 16);

    logger.info("Steps 6-9: Sword & Arcane weapon masteries advanced independently", {
      operation: "demo06:mastery",
      longsword_level: swordMasteryRes.data.mastery.masteryLevel,
      longsword_rank: swordMasteryRes.data.mastery.proficiencyRank,
      grimoire_level: grimoireMasteryRes.data.mastery.masteryLevel,
      staff_level: staffMasteryRes.data.mastery.masteryLevel,
    });

    // 13 (part 1). Grant validated specialization points to support hybrid build
    const specGrant = await skillEngine.grantSpecializationPoints({
      grantId: "demo06:specpts:lyra-training",
      principal: sysAuth,
      characterId: lyra.id,
      sourceType: "training_completion",
      pointsAmount: 2,
    });
    assert.equal(
      specGrant.data.spentPoints + specGrant.data.unspentPoints,
      specGrant.data.earnedPoints,
    );

    // Equip primary Arcane Knight gear (`ironfang_longsword` + `astral_vigil_grimoire`)
    let lyraBv = lyra.buildVersion;
    const primaryLoadout = (
      await invEngine.equipItem({
        commandId: "demo06:equip:lyra-sword",
        principal: pLyra,
        characterId: lyra.id,
        itemInstanceId: longsword.id,
        targetSlot: "main_hand",
        expectedBuildVersion: lyraBv,
      })
    ).data;
    lyraBv++;
    await invEngine.equipItem({
      commandId: "demo06:equip:lyra-grimoire",
      principal: pLyra,
      characterId: lyra.id,
      itemInstanceId: grimoire.id,
      targetSlot: "off_hand",
      expectedBuildVersion: lyraBv,
    });
    lyraBv++;

    // 10, 11, 12, 13 & 14. Unlock specialization nodes, learn abilities across Swordsmanship + Arcane Arts, and upgrade rank!
    for (const nodeCode of [
      "node_sword_foundation",
      "node_arcane_initiate",
      "node_arcane_spellblade_bridge",
    ]) {
      lyraBv = (
        await skillEngine.unlockSpecializationNode({
          commandId: `demo06:unlock:${nodeCode}`,
          principal: pLyra,
          characterId: lyra.id,
          nodeCode,
          expectedBuildVersion: lyraBv,
        })
      ).data.buildVersion;
    }

    for (const abilityCode of [
      "rising_slash",
      "imperial_thrust",
      "blade_discipline",
      "arcane_lance",
      "mana_pulse",
      "arcane_barrier",
    ]) {
      lyraBv = (
        await skillEngine.learnAbility({
          commandId: `demo06:learn:${abilityCode}`,
          principal: pLyra,
          characterId: lyra.id,
          abilityCode,
          expectedBuildVersion: lyraBv,
        })
      ).data.buildVersion;
    }

    const upgradedSlash = await skillEngine.upgradeAbilityRank({
      commandId: "demo06:upgrade:rising-slash-r3",
      principal: pLyra,
      characterId: lyra.id,
      abilityCode: "rising_slash",
      ranksToGain: 2,
      expectedBuildVersion: lyraBv,
    });
    lyraBv = upgradedSlash.data.buildVersion;
    assert.equal(upgradedSlash.data.learned.currentRank, 3);

    // 15. Equip hybrid Arcane Knight abilities onto active loadout (`Principal`)
    for (const [slotIndex, abilityCode] of [
      [0, "rising_slash"],
      [1, "imperial_thrust"],
      [2, "arcane_lance"],
      [4, "blade_discipline"],
    ] as const) {
      lyraBv = (
        await skillEngine.equipAbility({
          commandId: `demo06:equip-ab:${abilityCode}`,
          principal: pLyra,
          characterId: lyra.id,
          slotIndex,
          abilityCode,
          expectedBuildVersion: lyraBv,
        })
      ).data.buildVersion;
    }

    // 16. Configure & switch to alternate loadout ("Arcanista Astral") and switch back
    const astralLoadout = (
      await invEngine.saveInactiveLoadout({
        commandId: "demo06:loadout:save-astral",
        principal: pLyra,
        characterId: lyra.id,
        loadoutName: "Arcanista Astral",
        assignments: [{ slotCode: "main_hand", itemInstanceId: staff.id }],
      })
    ).data;
    await skillEngine.saveLoadoutAbilities({
      commandId: "demo06:loadout:save-astral-abilities",
      principal: pLyra,
      characterId: lyra.id,
      loadoutId: astralLoadout.id,
      assignments: [
        { slotIndex: 0, abilityCode: "arcane_lance" },
        { slotIndex: 1, abilityCode: "mana_pulse" },
        { slotIndex: 2, abilityCode: "arcane_barrier" },
      ],
      expectedBuildVersion: lyraBv,
    });
    await invEngine.activateLoadout({
      commandId: "demo06:loadout:activate-astral",
      principal: pLyra,
      characterId: lyra.id,
      loadoutId: astralLoadout.id,
      expectedBuildVersion: lyraBv,
    });
    lyraBv++;
    const astralSnap = await charSnapReader.getCharacterSnapshot(lyra.id, { principal: pLyra });
    assert.deepEqual(
      astralSnap.equippedAbilities.map((a) => a.abilityCode),
      ["arcane_lance", "mana_pulse", "arcane_barrier"],
    );

    // Switch back to hybrid `Principal` loadout
    await invEngine.activateLoadout({
      commandId: "demo06:loadout:activate-principal",
      principal: pLyra,
      characterId: lyra.id,
      loadoutId: primaryLoadout.id,
      expectedBuildVersion: lyraBv,
    });
    lyraBv++;

    // 17 & 18. Swap weapon on `Principal` to 2H `twilight_staff` -> sword techniques become suppressed (`incompatible_equipped_weapon`)!
    await invEngine.equipItem({
      commandId: "demo06:swap:staff-suppresses-sword",
      principal: pLyra,
      characterId: lyra.id,
      itemInstanceId: staff.id,
      targetSlot: "main_hand",
      expectedBuildVersion: lyraBv,
    });
    lyraBv++;

    const suppressedCharSnap = await charSnapReader.getCharacterSnapshot(lyra.id, {
      principal: pLyra,
    });
    const suppressedAbSnap = await abilitySnapReader.getAbilitySnapshot(lyra.id, {
      principal: pLyra,
    });
    assert.deepEqual(
      suppressedCharSnap.equippedAbilities.map((a) => a.abilityCode),
      ["arcane_lance"],
    );
    assert.equal(
      suppressedAbSnap.equippedAbilities.find((a) => a.abilityCode === "rising_slash")
        ?.suppressionReason,
      "incompatible_equipped_weapon",
    );
    logger.info("Steps 17-18: Incompatible weapon swap suppressed sword abilities without deleting learned ranks", {
      operation: "demo06:suppression",
      active_eligible_abilities: suppressedCharSnap.equippedAbilities,
      rising_slash_suppression: "incompatible_equipped_weapon",
    });

    // 19. Re-equip compatible `ironfang_longsword` + `astral_vigil_grimoire` -> all 4 hybrid abilities restored!
    await invEngine.equipItem({
      commandId: "demo06:reequip:sword",
      principal: pLyra,
      characterId: lyra.id,
      itemInstanceId: longsword.id,
      targetSlot: "main_hand",
      expectedBuildVersion: lyraBv,
    });
    lyraBv++;
    await invEngine.equipItem({
      commandId: "demo06:reequip:grimoire",
      principal: pLyra,
      characterId: lyra.id,
      itemInstanceId: grimoire.id,
      targetSlot: "off_hand",
      expectedBuildVersion: lyraBv,
    });
    lyraBv++;

    // 20 & 21. Execute specialization respec on `Gorim Punho-Vivo` & reject illegal budget/loadout allocation
    await skillEngine.grantWeaponMasteryExperience({
      grantId: "demo06:gorim:unarmed-mastery",
      principal: sysAuth,
      characterId: gorim.id,
      weaponFamilyCode: "unarmed",
      sourceType: "training",
      experienceAmount: 3000n,
    });
    let gorimBv = gorim.buildVersion;
    gorimBv = (
      await skillEngine.unlockSpecializationNode({
        commandId: "demo06:gorim:unlock-martial",
        principal: pGorim,
        characterId: gorim.id,
        nodeCode: "node_martial_conditioning",
        expectedBuildVersion: gorimBv,
      })
    ).data.buildVersion;
    gorimBv = (
      await skillEngine.learnAbility({
        commandId: "demo06:gorim:learn-fist",
        principal: pGorim,
        characterId: gorim.id,
        abilityCode: "iron_fist",
        expectedBuildVersion: gorimBv,
      })
    ).data.buildVersion;

    const gorimRespec = await skillEngine.resetSpecialization({
      commandId: "demo06:gorim:respec",
      principal: pGorim,
      characterId: gorim.id,
      expectedBuildVersion: gorimBv,
    });
    gorimBv = gorimRespec.data.buildVersion;
    assert.equal(gorimRespec.data.specializationPoints.spentPoints, 0);
    assert.equal(
      gorimRespec.data.specializationPoints.unspentPoints,
      gorimRespec.data.specializationPoints.earnedPoints,
    );

    // Step 21: Reject illegal overspend & illegal duplicate slot equip
    await assert.rejects(
      () =>
        skillEngine.upgradeAbilityRank({
          commandId: "demo06:lyra:illegal-overspend",
          principal: pLyra,
          characterId: lyra.id,
          abilityCode: "imperial_thrust",
          ranksToGain: 4,
          expectedBuildVersion: lyraBv,
        }),
      SpecializationBudgetInsufficientError,
    );
    await assert.rejects(
      () =>
        skillEngine.equipAbility({
          commandId: "demo06:lyra:illegal-occupied-slot",
          principal: pLyra,
          characterId: lyra.id,
          slotIndex: 0,
          abilityCode: "mana_pulse",
          expectedBuildVersion: lyraBv,
        }),
      AbilityLoadoutInvalidError,
    );

    // 22 & 23. Resend weapon mastery event & confirm zero duplication
    const retryMastery = await skillEngine.grantWeaponMasteryExperience({
      grantId: "demo06:mastery:lyra-longsword-26",
      sourceEventId: "combat:siege-valewatch-01",
      principal: sysAuth,
      characterId: lyra.id,
      weaponFamilyCode: "longsword",
      sourceType: "validated_combat",
      experienceAmount: swordXp26,
    });
    assert.equal(retryMastery.status, "duplicate_idempotent");
    assert.equal(retryMastery.data.mastery.masteryExperience, swordXp26);

    // 24. Demonstrate competitive series lock (`in_ranked_series`) blocking build modification
    await pgCtx.pool.query(
      "UPDATE characters SET competitive_lock_state = 'in_ranked_series' WHERE id = $1::uuid",
      [lyra.id],
    );
    await assert.rejects(
      () =>
        skillEngine.resetSpecialization({
          commandId: "demo06:lyra:blocked-by-ranked-lock",
          principal: pLyra,
          characterId: lyra.id,
          expectedBuildVersion: lyraBv,
        }),
      CharacterCompetitiveLockedError,
    );
    await pgCtx.pool.query(
      "UPDATE characters SET competitive_lock_state = 'none' WHERE id = $1::uuid",
      [lyra.id],
    );

    // 25. Unlock Mastery Title `master_of_blades` ("Mestre das Lâminas")
    const titleUnlock = await socialEngine.evaluateAndUnlockTitle({
      commandId: "demo06:title:lyra-master-of-blades",
      principal: sysAuth,
      characterId: lyra.id,
      titleCode: "master_of_blades",
    });
    assert.equal(titleUnlock.status, "applied");
    assert.equal(titleUnlock.data.state, "active");

    // 26 & 27. Produce consistent `CharacterSnapshotV1` & `AbilitySnapshotV1`
    const charSnap = await charSnapReader.getCharacterSnapshot(lyra.id, { principal: pLyra });
    const abilitySnap = await abilitySnapReader.getAbilitySnapshot(lyra.id, { principal: pLyra });
    assertConsistentCombatSnapshots({
      characterSnapshot: charSnap,
      abilitySnapshot: abilitySnap,
    });

    logger.info("Steps 25-27: Master of Blades unlocked & CharacterSnapshotV1 + AbilitySnapshotV1 projected", {
      operation: "demo06:snapshots",
      unlocked_title: titleUnlock.data.titleCode,
      character_snapshot_wire: serializeCharacterSnapshotWireV1(charSnap),
      ability_snapshot_wire: serializeAbilitySnapshotWireV1(abilitySnap),
    });

    // 28. Reject persistence of temporary Genesis Ranked build
    await assert.rejects(
      () =>
        skillEngine.learnAbility({
          commandId: "demo06:genesis:forbidden",
          principal: pLyra,
          characterId: lyra.id,
          abilityCode: "whirling_blade",
          expectedBuildVersion: lyraBv,
          executionProfile: "genesis_ranked_md3_scratch",
        }),
      GenesisTemporaryStatePersistenceForbiddenError,
    );

    // 29 & 30. Restart / reconnect PostgreSQL and confirm full persistent recovery
    const reconnectedPool = await pgCtx.restartAndReconnect();
    skillRepo = new PostgresSkillRepository(reconnectedPool);
    socialRepo = new PostgresSocialRepository(reconnectedPool);
    skillEngine = new SkillEngineService({ pool: reconnectedPool, logger });
    socialEngine = new SocialEngineService({ pool: reconnectedPool, logger });
    charSnapReader = new PostgresCharacterSnapshotReader(reconnectedPool);
    abilitySnapReader = new PostgresAbilitySnapshotReader(reconnectedPool);

    const recoveredCharSnap = await charSnapReader.getCharacterSnapshot(lyra.id, {
      principal: pLyra,
    });
    const recoveredAbilitySnap = await abilitySnapReader.getAbilitySnapshot(lyra.id, {
      principal: pLyra,
    });
    const recoveredTitles = await socialRepo.listCharacterTitles(lyra.id);
    const recoveredHistory = await skillRepo.listCharacterSkillHistory(lyra.id, {
      limit: 50,
      offset: 0,
    });

    assert.deepEqual(recoveredCharSnap.equippedAbilities, [
      { slotIndex: 0, abilityCode: "rising_slash", rank: 3 },
      { slotIndex: 1, abilityCode: "imperial_thrust", rank: 1 },
      { slotIndex: 2, abilityCode: "arcane_lance", rank: 1 },
      { slotIndex: 4, abilityCode: "blade_discipline", rank: 1 },
    ]);
    assert.equal(
      recoveredAbilitySnap.weaponMasteries.find((m) => m.weaponFamilyCode === "longsword")
        ?.masteryLevel,
      26,
    );
    assert.equal(
      recoveredTitles.find((t) => t.titleCode === "master_of_blades")?.state,
      "active",
    );

    logger.info("Step 30: Persistent recovery of Weapon Masteries, Specialization DAGs, Ability Ranks, Loadouts & Mastery Titles confirmed", {
      operation: "demo06:complete",
      result: "ok",
      embedded_postgres_restarted: pgCtx.isEmbedded,
      lyra_equipped_abilities: recoveredCharSnap.equippedAbilities.length,
      lyra_longsword_mastery: 26,
      lyra_title: "Mestre das Lâminas (master_of_blades)",
      skill_history_entries: recoveredHistory.length,
    });
  } finally {
    await pgCtx.stop();
  }
}

runSession06Demo().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`Session 06 demo failed: ${msg}\n`);
  process.exitCode = 1;
});
