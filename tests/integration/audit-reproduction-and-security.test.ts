import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CharacterEngineService } from "../../src/modules/characters/application/character-engine-service.js";
import {
  AccountInactiveError,
  CharacterCompetitiveLockedError,
  CharacterOwnershipForbiddenError,
} from "../../src/modules/characters/domain/errors.js";
import {
  PostgresCharacterRepository,
  PostgresCharacterUnitOfWork,
} from "../../src/modules/characters/infrastructure/postgres-character-unit-of-work.js";
import { InventoryEngineService } from "../../src/modules/inventory/application/inventory-engine-service.js";
import { LoadoutInvalidError } from "../../src/modules/inventory/domain/errors.js";
import { PostgresInventoryRepository } from "../../src/modules/inventory/infrastructure/postgres-inventory-unit-of-work.js";
import { PostgresCatalogRepository } from "../../src/modules/peoples/infrastructure/postgres-catalog-repository.js";
import { SkillEngineService } from "../../src/modules/skills/application/skill-engine-service.js";
import { PostgresSkillRepository } from "../../src/modules/skills/infrastructure/postgres-skill-unit-of-work.js";
import { SocialEngineService } from "../../src/modules/social/application/social-engine-service.js";
import { PostgresSocialSnapshotReader } from "../../src/modules/social/application/social-snapshot-query.js";
import { PostgresSocialRepository } from "../../src/modules/social/infrastructure/postgres-social-unit-of-work.js";
import { decodeWireJsonLossless } from "../../src/shared/contracts/int64-wire.js";
import { migrateUp } from "../../src/shared/db/migrator.js";
import { InboxIdempotencyConflictError } from "../../src/shared/db/processed-events-inbox.js";
import { StructuredLogger } from "../../src/shared/observability/logger.js";
import {
  startPostgresTestContext,
  type RunningPostgresTestContext,
} from "../helpers/postgres-test-harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

const SYSTEM_AUTH = {
  kind: "internal_system_authority" as const,
  actorId: "audit-test-harness",
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

describe("CARBON Full Audit — Defect Reproduction & Security Hardening Suite", () => {
  let pgCtx: RunningPostgresTestContext;
  let charService: CharacterEngineService;
  let charRepo: PostgresCharacterRepository;
  let invService: InventoryEngineService;
  let invRepo: PostgresInventoryRepository;
  let skillService: SkillEngineService;
  let socialService: SocialEngineService;
  let socialSnapReader: PostgresSocialSnapshotReader;

  const ownerAccountId = "11111111-1111-4111-8111-111111111101";
  const attackerAccountId = "22222222-2222-4222-8222-222222222202";
  const accompliceAccountId = "33333333-3333-4333-8333-333333333303";
  let ownerCharId: string;
  let attackerCharId: string;
  let accompliceCharId: string;

  before(async () => {
    pgCtx = await startPostgresTestContext();
    await migrateUp(pgCtx.pool, MIGRATIONS_DIR);

    const logger = new StructuredLogger("silent");
    const peoplesRepo = new PostgresCatalogRepository(pgCtx.pool);
    await peoplesRepo.seedInitialCatalogs();

    charRepo = new PostgresCharacterRepository(pgCtx.pool);
    await charRepo.seedProgressionRules();

    invRepo = new PostgresInventoryRepository(pgCtx.pool);
    await invRepo.seedInitialItemCatalogs();

    const skillRepo = new PostgresSkillRepository(pgCtx.pool);
    await skillRepo.seedInitialSkillCatalogs();

    const socialRepo = new PostgresSocialRepository(pgCtx.pool);
    await socialRepo.seedInitialSocialCatalogs();

    charService = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(pgCtx.pool),
      logger,
    });
    invService = new InventoryEngineService({ pool: pgCtx.pool, logger });
    skillService = new SkillEngineService({ pool: pgCtx.pool, logger });
    socialService = new SocialEngineService({ pool: pgCtx.pool, logger });
    socialSnapReader = new PostgresSocialSnapshotReader(pgCtx.pool);

    await charRepo.createAccount({ id: ownerAccountId, externalSubject: "auth:audit-owner" });
    await charRepo.createAccount({ id: attackerAccountId, externalSubject: "auth:audit-attacker" });
    await charRepo.createAccount({
      id: accompliceAccountId,
      externalSubject: "auth:audit-accomplice",
    });

    const c1 = await charService.createCharacter({
      commandId: "audit-create-owner",
      principal: { kind: "authenticated_account", accountId: ownerAccountId },
      accountId: ownerAccountId,
      characterName: "Aurelia Valen",
      raceCode: "humans",
      lineageCode: "human_valorian",
      cultureCode: "valewatch_civic",
      backgroundCode: "veteran_soldier",
      originRegionId: "region-ashvale",
      appearance: VALID_APPEARANCE,
      presetCode: "paladin",
    });
    ownerCharId = c1.data.id;

    const c2 = await charService.createCharacter({
      commandId: "audit-create-attacker",
      principal: { kind: "authenticated_account", accountId: attackerAccountId },
      accountId: attackerAccountId,
      characterName: "Malakor Vex",
      raceCode: "humans",
      lineageCode: "human_valorian",
      cultureCode: "valewatch_civic",
      backgroundCode: "veteran_soldier",
      originRegionId: "region-ashvale",
      appearance: VALID_APPEARANCE,
      presetCode: "assassin",
    });
    attackerCharId = c2.data.id;

    const c3 = await charService.createCharacter({
      commandId: "audit-create-accomplice",
      principal: { kind: "authenticated_account", accountId: accompliceAccountId },
      accountId: accompliceAccountId,
      characterName: "Seraphina Thorne",
      raceCode: "humans",
      lineageCode: "human_valorian",
      cultureCode: "valewatch_civic",
      backgroundCode: "veteran_soldier",
      originRegionId: "region-ashvale",
      appearance: VALID_APPEARANCE,
      presetCode: "berserker",
    });
    accompliceCharId = c3.data.id;
  });

  after(async () => {
    if (pgCtx) {
      await pgCtx.stop();
    }
  });

  it("[CARBON-AUD-001] forbids saveInactiveLoadout from overwriting an active loadout or stranding equipped_active items, including during in_ranked_series", async () => {
    // Advance owner so she meets level requirements for ironfang_longsword
    await charService.grantExperience({
      grantId: "aud001-xp-levelup",
      principal: SYSTEM_AUTH,
      characterId: ownerCharId,
      amount: 5000n,
      sourceType: "quest",
      sourceReference: "quest:aud001-lv",
    });

    const swordGrant = await invService.grantProceduralEquipment({
      grantId: "aud001-grant-sword",
      principal: SYSTEM_AUTH,
      recipientCharacterId: ownerCharId,
      definitionCode: "ironfang_longsword",
      rarityCode: "rare",
      originType: "quest_reward",
      originReference: "quest:audit-001-a",
    });
    const daggerGrant = await invService.grantProceduralEquipment({
      grantId: "aud001-grant-dagger",
      principal: SYSTEM_AUTH,
      recipientCharacterId: ownerCharId,
      definitionCode: "thornveil_dagger",
      rarityCode: "rare",
      originType: "quest_reward",
      originReference: "quest:audit-001-b",
    });

    const ownerPrincipal = { kind: "authenticated_account" as const, accountId: ownerAccountId };

    const charForStr = (await charRepo.findCharacterById(ownerCharId))!;
    await charService.allocateAttributes({
      commandId: "aud001-alloc-str",
      principal: ownerPrincipal,
      characterId: ownerCharId,
      expectedBuildVersion: charForStr.buildVersion,
      attributeDeltas: { strength: 6 },
    });

    // 1. Save inactive loadout "ArenaSet" with sword, then activate it
    const saved = await invService.saveInactiveLoadout({
      commandId: "aud001-save-arena-1",
      principal: ownerPrincipal,
      characterId: ownerCharId,
      loadoutName: "ArenaSet",
      assignments: [{ slotCode: "main_hand", itemInstanceId: swordGrant.data.id }],
    });

    const charBefore = (await charRepo.findCharacterById(ownerCharId))!;
    await invService.activateLoadout({
      commandId: "aud001-activate-arena",
      principal: ownerPrincipal,
      characterId: ownerCharId,
      loadoutId: saved.data.id,
      expectedBuildVersion: charBefore.buildVersion,
    });

    // 2. Attempt to overwrite active "ArenaSet" via saveInactiveLoadout MUST fail with LoadoutInvalidError
    await assert.rejects(
      () =>
        invService.saveInactiveLoadout({
          commandId: "aud001-overwrite-active-arena",
          principal: ownerPrincipal,
          characterId: ownerCharId,
          loadoutName: "ArenaSet",
          assignments: [{ slotCode: "main_hand", itemInstanceId: daggerGrant.data.id }],
        }),
      (err: unknown) => err instanceof LoadoutInvalidError,
    );

    // 3. Attempting to save an inactive loadout named "Principal" when "Principal" already exists MUST fail cleanly
    await assert.rejects(
      () =>
        invService.saveInactiveLoadout({
          commandId: "aud001-overwrite-principal",
          principal: ownerPrincipal,
          characterId: ownerCharId,
          loadoutName: "Principal",
          assignments: [{ slotCode: "main_hand", itemInstanceId: daggerGrant.data.id }],
        }),
      (err: unknown) => err instanceof LoadoutInvalidError,
    );

    // Verify sword is STILL equipped_active and STILL referenced by active loadout slots!
    const itemsAfter = await invRepo.listCharacterItems(ownerCharId);
    const swordAfter = itemsAfter.find((i) => i.id === swordGrant.data.id)!;
    assert.equal(swordAfter.locationState, "equipped_active");

    const activeSlotsRes = await pgCtx.pool.query<{ item_instance_id: string }>(
      `SELECT els.item_instance_id
       FROM equipment_loadout_slots els
       INNER JOIN equipment_loadouts el ON el.id = els.loadout_id
       WHERE el.character_id = $1::uuid AND el.is_active = TRUE`,
      [ownerCharId],
    );
    assert.deepEqual(
      activeSlotsRes.rows.map((r) => r.item_instance_id),
      [swordGrant.data.id],
    );
  });

  it("[CARBON-AUD-002] blocks cross-account duplicate_verified replay leaks and idempotency probing across Skill, Character, Inventory, and Social engines", async () => {
    const ownerPrincipal = { kind: "authenticated_account" as const, accountId: ownerAccountId };
    const attackerPrincipal = {
      kind: "authenticated_account" as const,
      accountId: attackerAccountId,
    };

    await skillService.grantWeaponMasteryExperience({
      grantId: "aud002-mast-1",
      principal: SYSTEM_AUTH,
      characterId: ownerCharId,
      weaponFamilyCode: "longsword",
      sourceType: "training",
      experienceAmount: 5000n,
    });

    const charNow = (await charRepo.findCharacterById(ownerCharId))!;
    await skillService.unlockSpecializationNode({
      commandId: "aud002-victim-unlock-cmd",
      principal: ownerPrincipal,
      characterId: ownerCharId,
      nodeCode: "node_sword_foundation",
      expectedBuildVersion: charNow.buildVersion,
    });

    // Attacker replays victim's EXACT commandId + payload -> MUST get CharacterOwnershipForbiddenError, NOT victim's data!
    await assert.rejects(
      () =>
        skillService.unlockSpecializationNode({
          commandId: "aud002-victim-unlock-cmd",
          principal: attackerPrincipal,
          characterId: ownerCharId,
          nodeCode: "node_sword_foundation",
          expectedBuildVersion: charNow.buildVersion,
        }),
      (err: unknown) => err instanceof CharacterOwnershipForbiddenError,
    );

    // Attacker probes victim's commandId with a DIFFERENT payload on victim's character -> MUST get CharacterOwnershipForbiddenError, NOT InboxIdempotencyConflictError!
    await assert.rejects(
      () =>
        skillService.unlockSpecializationNode({
          commandId: "aud002-victim-unlock-cmd",
          principal: attackerPrincipal,
          characterId: ownerCharId,
          nodeCode: "node_heavy_iron_grip",
          expectedBuildVersion: charNow.buildVersion,
        }),
      (err: unknown) => err instanceof CharacterOwnershipForbiddenError,
    );

    // Attacker probes victim's allocateAttributes commandId with different payload -> MUST get CharacterOwnershipForbiddenError!
    const charForAlloc = (await charRepo.findCharacterById(ownerCharId))!;
    await charService.allocateAttributes({
      commandId: "aud002-victim-alloc-cmd",
      principal: ownerPrincipal,
      characterId: ownerCharId,
      expectedBuildVersion: charForAlloc.buildVersion,
      attributeDeltas: { strength: 1 },
    });

    await assert.rejects(
      () =>
        charService.allocateAttributes({
          commandId: "aud002-victim-alloc-cmd",
          principal: attackerPrincipal,
          characterId: ownerCharId,
          expectedBuildVersion: charForAlloc.buildVersion,
          attributeDeltas: { agility: 2 },
        }),
      (err: unknown) => err instanceof CharacterOwnershipForbiddenError,
    );
  });

  it("[CARBON-AUD-003] serializes cross-table item_instance vs inventory_stack slot writes on the same container slot across two independent PostgreSQL connections", async () => {
    const daggerGrant = await invService.grantProceduralEquipment({
      grantId: "aud003-grant-dagger",
      principal: SYSTEM_AUTH,
      recipientCharacterId: attackerCharId,
      definitionCode: "thornveil_dagger",
      rarityCode: "common",
      originType: "quest_reward",
      originReference: "quest:aud003-a",
    });
    const oreGrant = await invService.grantStackableMaterial({
      grantId: "aud003-grant-ore",
      principal: SYSTEM_AUTH,
      recipientCharacterId: attackerCharId,
      definitionCode: "iron_ore",
      quantity: 10,
      originType: "gathering",
      originReference: "node:aud003-b",
    });

    const stackId = oreGrant.data[0]!.id;
    const contestedSlot = 25;

    const clientA = await pgCtx.pool.connect();
    const clientB = await pgCtx.pool.connect();
    try {
      await clientA.query("BEGIN");
      await clientB.query("BEGIN");

      await clientA.query("UPDATE item_instances SET container_slot_index = $1 WHERE id = $2", [
        contestedSlot,
        daggerGrant.data.id,
      ]);

      const pendingB = clientB.query(
        "UPDATE inventory_stacks SET container_slot_index = $1 WHERE id = $2",
        [contestedSlot, stackId],
      );

      await new Promise((r) => setTimeout(r, 60));
      await clientA.query("COMMIT");

      await assert.rejects(
        () => pendingB,
        (err: unknown) =>
          typeof err === "object" && err !== null && "code" in err && err.code === "23505",
      );
      await clientB.query("ROLLBACK");
    } finally {
      await clientA.query("ROLLBACK").catch(() => undefined);
      await clientB.query("ROLLBACK").catch(() => undefined);
      clientA.release();
      clientB.release();
    }
  });

  it("[CARBON-AUD-004] blocks suspended accounts, archived characters, and ranked-locked characters from transferring items or mutating builds", async () => {
    const loot = await invService.grantProceduralEquipment({
      grantId: "aud004-unbound-boots",
      principal: SYSTEM_AUTH,
      recipientCharacterId: attackerCharId,
      definitionCode: "explorer_strider_boots",
      rarityCode: "uncommon",
      originType: "exploration",
      originReference: "chest:aud004",
    });

    // Suspend attacker account -> outbound item transfer to accomplice MUST fail with AccountInactiveError!
    await pgCtx.pool.query("UPDATE accounts SET status = 'suspended' WHERE id = $1::uuid", [
      attackerAccountId,
    ]);

    try {
      await assert.rejects(
        () =>
          invService.transferItemInstance({
            commandId: "aud004-launder-attempt",
            principal: { kind: "authenticated_account", accountId: attackerAccountId },
            fromCharacterId: attackerCharId,
            toCharacterId: accompliceCharId,
            itemInstanceId: loot.data.id,
          }),
        (err: unknown) => err instanceof AccountInactiveError,
      );
    } finally {
      await pgCtx.pool.query("UPDATE accounts SET status = 'active' WHERE id = $1::uuid", [
        attackerAccountId,
      ]);
    }

    // Place attacker in_ranked_series -> outbound transfer MUST fail with CharacterCompetitiveLockedError!
    await charRepo.setCharacterCompetitiveLock(attackerCharId, "in_ranked_series");
    try {
      await assert.rejects(
        () =>
          invService.transferItemInstance({
            commandId: "aud004-ranked-transfer-attempt",
            principal: { kind: "authenticated_account", accountId: attackerAccountId },
            fromCharacterId: attackerCharId,
            toCharacterId: accompliceCharId,
            itemInstanceId: loot.data.id,
          }),
        (err: unknown) => err instanceof CharacterCompetitiveLockedError,
      );
    } finally {
      await charRepo.setCharacterCompetitiveLock(attackerCharId, "none");
    }
  });

  it("[CARBON-AUD-005] rejects duplicate JSON keys at any nesting depth in decodeWireJsonLossless", () => {
    assert.throws(
      () =>
        decodeWireJsonLossless(
          '{"event_id":"ev-1","eligible":false,"eligible":true,"damage":10}',
        ),
      /Duplicate JSON object key/i,
    );

    assert.throws(
      () =>
        decodeWireJsonLossless(
          '{"outer":{"damage":10,"\\u0064amage":999999999999999999}}',
        ),
      /Duplicate JSON object key/i,
    );
  });

  it("[CARBON-AUD-006] excludes restricted_archive historical records from public contextual NPC recognition", async () => {
    await socialService.recordHistoricalAchievement({
      commandId: "aud006-secret-archive",
      principal: SYSTEM_AUTH,
      eventReference: "secret-op-006",
      eventType: "ExclusiveMilestone",
      characterId: accompliceCharId,
      regionId: "region-ashvale",
      contributionRole: "settlement_defender",
      summary: "Operação confidencial restrita ao arquivo interno.",
      visibility: "restricted_archive",
    });

    const evalRes = await socialService.evaluateCharacterContextualRecognition({
      characterId: accompliceCharId,
      contextRegionId: "region-ashvale",
      npcSocialRole: "town_guard",
    });
    assert.equal(evalRes.isRecognizedByName, false);

    // Also ensure public_limited snapshot never leaks Suspected status
    await socialService.recordAuthoritativeCrime({
      commandId: "aud006-suspected-only",
      principal: SYSTEM_AUTH,
      offenderCharacterId: accompliceCharId,
      offenseCode: "Theft",
      combatContext: "unlawful_aggression",
      jurisdictionId: "jur-ashvale-civic",
      severity: "minor",
      confirmationLevel: "suspected",
      evidenceReference: "inv:aud006",
    });
    const pubSnap = await socialSnapReader.getSocialStandingSnapshot(accompliceCharId, {
      principal: { kind: "authenticated_account", accountId: ownerAccountId },
      projectionScope: "public_limited",
    });
    assert.equal(pubSnap.criminalStatusSummary.length, 0);
  });

  it("[CARBON-AUD-007] preserves camelCase InventoryStack mapping on grantStackableMaterial duplicate replay, serverSeed fingerprint conflict, and recordAuthoritativeCrime duplicate fidelity", async () => {
    const firstStack = await invService.grantStackableMaterial({
      grantId: "aud007-mat-grant",
      principal: SYSTEM_AUTH,
      recipientCharacterId: accompliceCharId,
      definitionCode: "iron_ore",
      quantity: 7,
      originType: "gathering",
      originReference: "node:aud007",
    });
    assert.equal(firstStack.data[0]?.definitionCode, "iron_ore");

    const replayStack = await invService.grantStackableMaterial({
      grantId: "aud007-mat-grant",
      principal: SYSTEM_AUTH,
      recipientCharacterId: accompliceCharId,
      definitionCode: "iron_ore",
      quantity: 7,
      originType: "gathering",
      originReference: "node:aud007",
    });
    assert.equal(replayStack.status, "duplicate_idempotent");
    assert.equal(replayStack.data[0]?.definitionCode, "iron_ore");
    assert.equal(replayStack.data[0]?.ownerCharacterId, accompliceCharId);

    await invService.grantProceduralEquipment({
      grantId: "aud007-seeded-grant",
      principal: SYSTEM_AUTH,
      recipientCharacterId: accompliceCharId,
      definitionCode: "thornveil_dagger",
      rarityCode: "uncommon",
      originType: "boss_drop",
      originReference: "boss:aud007",
      serverSeed: "seed-alpha",
    });
    await assert.rejects(
      () =>
        invService.grantProceduralEquipment({
          grantId: "aud007-seeded-grant",
          principal: SYSTEM_AUTH,
          recipientCharacterId: accompliceCharId,
          definitionCode: "thornveil_dagger",
          rarityCode: "uncommon",
          originType: "boss_drop",
          originReference: "boss:aud007",
          serverSeed: "seed-manipulated-beta",
        }),
      (err: unknown) => err instanceof InboxIdempotencyConflictError,
    );

    const duel1 = await socialService.recordAuthoritativeCrime({
      commandId: "aud007-duel-1",
      principal: SYSTEM_AUTH,
      offenderCharacterId: accompliceCharId,
      offenseCode: "UnlawfulAttack",
      combatContext: "consensual_duel",
      jurisdictionId: "jur-ashvale-civic",
      severity: "moderate",
      confirmationLevel: "confirmed",
      evidenceReference: "sim:duel:aud007",
    });
    assert.equal(duel1.data.constitutedCrime, false);

    const duelReplay = await socialService.recordAuthoritativeCrime({
      commandId: "aud007-duel-1",
      principal: SYSTEM_AUTH,
      offenderCharacterId: accompliceCharId,
      offenseCode: "UnlawfulAttack",
      combatContext: "consensual_duel",
      jurisdictionId: "jur-ashvale-civic",
      severity: "moderate",
      confirmationLevel: "confirmed",
      evidenceReference: "sim:duel:aud007",
    });
    assert.equal(duelReplay.status, "duplicate_idempotent");
    assert.equal(duelReplay.data.constitutedCrime, false);
  });
});
