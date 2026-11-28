import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CharacterEngineService } from "../../src/modules/characters/application/character-engine-service.js";
import { PostgresCharacterSnapshotReader } from "../../src/modules/characters/application/character-snapshot-query.js";
import type { AuthorityPrincipal } from "../../src/modules/characters/domain/character.js";
import {
  CharacterOwnershipForbiddenError,
  GenesisTemporaryStatePersistenceForbiddenError,
} from "../../src/modules/characters/domain/errors.js";
import {
  PostgresCharacterRepository,
  PostgresCharacterUnitOfWork,
} from "../../src/modules/characters/infrastructure/postgres-character-unit-of-work.js";
import { RecordContributionService } from "../../src/modules/contributions/application/record-contribution-service.js";
import { PostgresContributionUnitOfWork } from "../../src/modules/contributions/infrastructure/postgres-contribution-unit-of-work.js";
import { PostgresInventoryRepository } from "../../src/modules/inventory/infrastructure/postgres-inventory-unit-of-work.js";
import { PostgresCatalogRepository } from "../../src/modules/peoples/infrastructure/postgres-catalog-repository.js";
import { SocialEngineService } from "../../src/modules/social/application/social-engine-service.js";
import {
  PostgresSocialSnapshotReader,
  serializeSocialStandingSnapshotWireV1,
} from "../../src/modules/social/application/social-snapshot-query.js";
import {
  ContributionRecognitionInvalidError,
  CriminalBountyInvalidError,
  ExternalIdentityConflictError,
  ExternalIdentityUnresolvedError,
  SocialAntiExploitRejectedError,
  SocialAuthorizationForbiddenError,
  SocialNumericOverflowError,
  SocialReferenceNotFoundError,
  TitleConditionInvalidError,
  TitleExclusivityClaimedError,
  TitleOwnershipOrStateError,
} from "../../src/modules/social/domain/errors.js";
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
const SOCIAL_SNAPSHOT_SCHEMA_PATH = path.resolve(
  __dirname,
  "../../contracts/neon-carbon/social-standing-snapshot.v1.schema.json",
);

const SYSTEM_AUTHORITY: AuthorityPrincipal = {
  kind: "internal_system_authority",
  actorId: "test-social-authority",
};

describe("CARBON Session 05 — Reputation, Bounty, Fame, Criminality, Titles & World Recognition (Real PostgreSQL)", () => {
  let pgCtx: RunningPostgresTestContext;
  let socialSnapshotSchema: JsonSchemaNode;
  const silentLogger = new StructuredLogger("silent");

  before(async () => {
    pgCtx = await startPostgresTestContext();
    socialSnapshotSchema = JSON.parse(
      await readFile(SOCIAL_SNAPSHOT_SCHEMA_PATH, "utf8"),
    ) as JsonSchemaNode;
  });

  after(async () => {
    if (pgCtx) {
      await pgCtx.stop();
    }
  });

  it("Scenarios 49 & 50: Incremental migrations 0008..0009 apply cleanly over populated Session 04 data with automatic social backfill and full down/up cycle", async () => {
    const existing = await listAppliedMigrations(pgCtx.pool);
    if (existing.length > 0) {
      await migrateDown(pgCtx.pool, MIGRATIONS_DIR, existing.length);
    }

    // Apply all then step back to Session 04 (0001..0007)
    await migrateUp(pgCtx.pool, MIGRATIONS_DIR);
    const totalCount = (await listAppliedMigrations(pgCtx.pool)).length;
    await migrateDown(pgCtx.pool, MIGRATIONS_DIR, totalCount - 7);

    const s04Applied = await listAppliedMigrations(pgCtx.pool);
    assert.deepEqual(
      s04Applied.map((m) => m.version),
      ["0001", "0002", "0003", "0004", "0005", "0006", "0007"],
    );

    const catalogRepo = new PostgresCatalogRepository(pgCtx.pool);
    const charRepo = new PostgresCharacterRepository(pgCtx.pool);
    const invRepo = new PostgresInventoryRepository(pgCtx.pool);
    await catalogRepo.seedInitialCatalogs();
    await charRepo.seedProgressionRules();
    await invRepo.seedInitialItemCatalogs();

    const preAcc = await charRepo.createAccount({
      id: randomUUID(),
      externalSubject: "pre-s05-acc",
    });
    const charEngine = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(pgCtx.pool),
      logger: silentLogger,
    });
    const preChar = (
      await charEngine.createCharacter({
        commandId: "s05:mig:pre-char",
        principal: { kind: "authenticated_account", accountId: preAcc.id },
        accountId: preAcc.id,
        characterName: "Seraphina Pré-Social",
        raceCode: "humans",
        lineageCode: "human_valorian",
        cultureCode: "valewatch_civic",
        backgroundCode: "noble_heir",
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
        presetCode: "paladin",
      })
    ).data;

    // Apply incremental migrations 0008 & 0009
    const inc = await migrateUp(pgCtx.pool, MIGRATIONS_DIR);
    assert.deepEqual(inc.slice(0, 2), [
      "0008_social_standing_fame_reputation_and_identity_links",
      "0009_criminality_bounties_titles_and_world_history",
    ]);

    // Verify automatic neutral social standing backfill for pre-existing character
    const backfilledSocial = await pgCtx.pool.query<{
      moral_bounty: string;
      moral_band: string;
      global_fame: string;
    }>(
      "SELECT moral_bounty, moral_band, global_fame FROM character_social_standing WHERE character_id = $1::uuid",
      [preChar.id],
    );
    assert.equal(backfilledSocial.rows[0]?.moral_bounty, "0");
    assert.equal(backfilledSocial.rows[0]?.moral_band, "neutral");
    assert.equal(backfilledSocial.rows[0]?.global_fame, "0");

    // Full down:all -> up cycle
    const allNow = await listAppliedMigrations(pgCtx.pool);
    assert.ok(allNow.length >= 9);
    await migrateDown(pgCtx.pool, MIGRATIONS_DIR, allNow.length);
    assert.equal((await listAppliedMigrations(pgCtx.pool)).length, 0);
    await migrateUp(pgCtx.pool, MIGRATIONS_DIR);

    // Seed catalogs for remaining Session 05 tests
    await catalogRepo.seedInitialCatalogs();
    await charRepo.seedProgressionRules();
    await invRepo.seedInitialItemCatalogs();
    const socialRepo = new PostgresSocialRepository(pgCtx.pool);
    await socialRepo.seedInitialSocialCatalogs();
  });

  it("Scenarios 1..12, 41..44: MoralBounty (+/-), Fame independence, Faction/Settlement/Region reputations, neutral absence, invalid refs, single-hop propagation, anti-farming, rollback, and concurrent updates", async () => {
    const charRepo = new PostgresCharacterRepository(pgCtx.pool);
    const socialRepo = new PostgresSocialRepository(pgCtx.pool);
    const charEngine = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(pgCtx.pool),
      logger: silentLogger,
    });
    const socialEngine = new SocialEngineService({ pool: pgCtx.pool, logger: silentLogger });
    const snapReader = new PostgresSocialSnapshotReader(pgCtx.pool);

    const acc1 = await charRepo.createAccount({ id: randomUUID(), externalSubject: "s05-acc1" });
    const acc2 = await charRepo.createAccount({ id: randomUUID(), externalSubject: "s05-acc2" });
    const p1: AuthorityPrincipal = { kind: "authenticated_account", accountId: acc1.id };

    const hero = (
      await charEngine.createCharacter({
        commandId: `s05:hero:${randomUUID()}`,
        principal: p1,
        accountId: acc1.id,
        characterName: "Caelum Escudo-Real",
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
        presetCode: "paladin",
      })
    ).data;

    const altSameAcc = (
      await charEngine.createCharacter({
        commandId: `s05:alt:${randomUUID()}`,
        principal: p1,
        accountId: acc1.id,
        characterName: "Caelum Alt-Conta",
        raceCode: "humans",
        lineageCode: "human_frontier",
        cultureCode: "valewatch_civic",
        backgroundCode: "farmer",
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

    const otherAccChar = (
      await charEngine.createCharacter({
        commandId: `s05:other:${randomUUID()}`,
        principal: { kind: "authenticated_account", accountId: acc2.id },
        accountId: acc2.id,
        characterName: "Riven Estranho",
        raceCode: "elves",
        lineageCode: "elf_lunar",
        cultureCode: "arcane_collegium",
        backgroundCode: "explorer",
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
        presetCode: "arcanist",
      })
    ).data;

    // Client principal rejected from self-granting MoralBounty or Fame
    await assert.rejects(
      () =>
        socialEngine.adjustMoralBounty({
          commandId: "s05:unauth-bounty",
          principal: p1,
          characterId: hero.id,
          signedDelta: 500n,
          actionCode: "self_forged",
        }),
      SocialAuthorizationForbiddenError,
    );

    // Same-account anti-farming blocked!
    await assert.rejects(
      () =>
        socialEngine.adjustMoralBounty({
          commandId: "s05:alt-farming",
          principal: SYSTEM_AUTHORITY,
          characterId: hero.id,
          counterpartyCharacterId: altSameAcc.id,
          signedDelta: 100n,
          actionCode: "rescue_player",
          enforceAntiAbuseCooldown: true,
        }),
      SocialAntiExploitRejectedError,
    );

    // Cross-account rescue works once, then immediate repeat within cooldown is rejected!
    const t0 = new Date("2026-11-27T01:00:00Z");
    const m1 = await socialEngine.adjustMoralBounty({
      commandId: "s05:moral:rescue-1",
      principal: SYSTEM_AUTHORITY,
      characterId: hero.id,
      counterpartyCharacterId: otherAccChar.id,
      signedDelta: 250n,
      actionCode: "rescue_player",
      regionId: "region-ashvale",
      enforceAntiAbuseCooldown: true,
      occurredAt: t0,
    });
    assert.equal(m1.data.moralBounty, 250n);
    assert.equal(m1.data.moralBand, "respected");

    await assert.rejects(
      () =>
        socialEngine.adjustMoralBounty({
          commandId: "s05:moral:rescue-cooldown-violation",
          principal: SYSTEM_AUTHORITY,
          characterId: hero.id,
          counterpartyCharacterId: otherAccChar.id,
          signedDelta: 250n,
          actionCode: "rescue_player",
          enforceAntiAbuseCooldown: true,
          occurredAt: new Date(t0.getTime() + 10_000), // 10s < 120s cooldown!
        }),
      SocialAntiExploitRejectedError,
    );

    // #41 & #42: Duplicate idempotent delivery vs conflicting payload
    const m1Dup = await socialEngine.adjustMoralBounty({
      commandId: "s05:moral:rescue-1",
      principal: SYSTEM_AUTHORITY,
      characterId: hero.id,
      counterpartyCharacterId: otherAccChar.id,
      signedDelta: 250n,
      actionCode: "rescue_player",
      regionId: "region-ashvale",
    });
    assert.equal(m1Dup.status, "duplicate_idempotent");
    assert.equal(m1Dup.data.moralBounty, 250n);

    await assert.rejects(
      () =>
        socialEngine.adjustMoralBounty({
          commandId: "s05:moral:rescue-1",
          principal: SYSTEM_AUTHORITY,
          characterId: hero.id,
          counterpartyCharacterId: otherAccChar.id,
          signedDelta: 999n, // conflicting payload!
          actionCode: "rescue_player",
          regionId: "region-ashvale",
        }),
      InboxIdempotencyConflictError,
    );

    // #2 Negative MoralBounty adjustment & #5 Overflow protection
    const mNeg = await socialEngine.adjustMoralBounty({
      commandId: "s05:moral:minor-betrayal",
      principal: SYSTEM_AUTHORITY,
      characterId: otherAccChar.id,
      signedDelta: -120n,
      actionCode: "contract_breach",
    });
    assert.equal(mNeg.data.moralBounty, -120n);
    assert.equal(mNeg.data.moralBand, "dishonored");

    await assert.rejects(
      () =>
        socialEngine.adjustMoralBounty({
          commandId: "s05:moral:overflow",
          principal: SYSTEM_AUTHORITY,
          characterId: hero.id,
          signedDelta: MAX_INT64,
          actionCode: "overflow_test",
        }),
      SocialNumericOverflowError,
    );

    // #6 Fame independent of morality: dishonored character gains 900 Fame from boss kill while staying -120 MoralBounty!
    const fameOnDishonored = await socialEngine.grantFame({
      commandId: "s05:fame:boss-kill-riven",
      principal: SYSTEM_AUTHORITY,
      characterId: otherAccChar.id,
      fameAmount: 900n,
      sourceCategory: "boss_defeat",
      sourceReference: "boss:ash-wyrm",
      regionId: "region-thornreach",
    });
    assert.equal(fameOnDishonored.data.globalFame, 900n);
    assert.equal(fameOnDishonored.data.moralBounty, -120n);

    // #10 Neutral absence before any reputation is recorded
    const initialSnap = await snapReader.getSocialStandingSnapshot(hero.id, {
      principal: p1,
      projectionScope: "self_character",
    });
    assert.equal(initialSnap.factionReputations.length, 0);

    // #11 Invalid scope references rejected
    await assert.rejects(
      () =>
        socialEngine.adjustReputation({
          commandId: "s05:rep:missing-faction",
          principal: SYSTEM_AUTHORITY,
          characterId: hero.id,
          scopeType: "faction",
          scopeId: randomUUID(),
          delta: 100,
          actionCode: "quest",
        }),
      SocialReferenceNotFoundError,
    );
    await assert.rejects(
      () =>
        socialEngine.adjustReputation({
          commandId: "s05:rep:missing-region",
          principal: SYSTEM_AUTHORITY,
          characterId: hero.id,
          scopeType: "region",
          scopeId: "region-nonexistent-xyz",
          delta: 100,
          actionCode: "quest",
        }),
      SocialReferenceNotFoundError,
    );

    // #7, #8, #9 & #12: Faction reputation (+400 with Valewatch Guard) propagates +100 to allied Ironforge & -120 to hostile Thornveil, leaving unrelated Crimson Raiders untouched!
    const vwFaction = (await socialRepo.findFactionByCode("valewatch_guard"))!;
    const valewatchSettlement = (await socialRepo.findSettlementByExternalId(
      "settlement-valewatch",
    ))!;

    const repRes = await socialEngine.adjustReputation({
      commandId: "s05:rep:vw-guard-400",
      principal: SYSTEM_AUTHORITY,
      characterId: hero.id,
      scopeType: "faction",
      scopeId: vwFaction.id,
      delta: 400,
      actionCode: "patrol_aid",
    });
    assert.equal(repRes.data.primary.standingValue, 400);
    assert.equal(repRes.data.propagated.length, 2);

    await socialEngine.adjustReputation({
      commandId: "s05:rep:vw-settlement-350",
      principal: SYSTEM_AUTHORITY,
      characterId: hero.id,
      scopeType: "settlement",
      scopeId: valewatchSettlement.id,
      delta: 350,
      actionCode: "civic_aid",
    });
    await socialEngine.adjustReputation({
      commandId: "s05:rep:ashvale-region-550",
      principal: SYSTEM_AUTHORITY,
      characterId: hero.id,
      scopeType: "region",
      scopeId: "region-ashvale",
      delta: 550,
      actionCode: "regional_patrol",
    });

    const afterRepSnap = await snapReader.getSocialStandingSnapshot(hero.id, {
      principal: p1,
      projectionScope: "self_character",
    });
    assert.equal(
      afterRepSnap.factionReputations.find((f) => f.factionCode === "valewatch_guard")?.standingValue,
      400,
    );
    assert.equal(
      afterRepSnap.factionReputations.find((f) => f.factionCode === "ironforge_artisans")
        ?.standingValue,
      100,
    );
    assert.equal(
      afterRepSnap.factionReputations.find((f) => f.factionCode === "thornveil_syndicate")
        ?.standingValue,
      -120,
    );
    assert.equal(
      afterRepSnap.factionReputations.find((f) => f.factionCode === "crimson_raiders"),
      undefined,
    );

    // #43 Pre-commit fault rollback & retry recovery
    let crashNow = true;
    const faultSocialEngine = new SocialEngineService({
      pool: pgCtx.pool,
      logger: silentLogger,
      beforeCommitHook: async () => {
        if (crashNow) {
          throw new Error("SIMULATED_SOCIAL_PRE_COMMIT_FAULT");
        }
      },
    });
    await assert.rejects(
      () =>
        faultSocialEngine.adjustMoralBounty({
          commandId: "s05:fault:moral-100",
          principal: SYSTEM_AUTHORITY,
          characterId: hero.id,
          signedDelta: 100n,
          actionCode: "fault_test",
        }),
      /SIMULATED_SOCIAL_PRE_COMMIT_FAULT/,
    );
    crashNow = false;
    const recovered = await faultSocialEngine.adjustMoralBounty({
      commandId: "s05:fault:moral-100",
      principal: SYSTEM_AUTHORITY,
      characterId: hero.id,
      signedDelta: 100n,
      actionCode: "fault_test",
    });
    assert.equal(recovered.data.moralBounty, 350n); // 250 + 100 = 350 (zero partial leak from failed attempt!)

    // #44 Real concurrent social updates (3 simultaneous MoralBounty + 2 simultaneous Fame grants -> zero lost updates!)
    await Promise.all([
      socialEngine.adjustMoralBounty({
        commandId: "s05:concur:mb-1",
        principal: SYSTEM_AUTHORITY,
        characterId: hero.id,
        signedDelta: 30n,
        actionCode: "concur_a",
      }),
      socialEngine.adjustMoralBounty({
        commandId: "s05:concur:mb-2",
        principal: SYSTEM_AUTHORITY,
        characterId: hero.id,
        signedDelta: 40n,
        actionCode: "concur_b",
      }),
      socialEngine.grantFame({
        commandId: "s05:concur:fame-1",
        principal: SYSTEM_AUTHORITY,
        characterId: hero.id,
        fameAmount: 110n,
        sourceCategory: "city_defense",
        sourceReference: "def-1",
      }),
      socialEngine.grantFame({
        commandId: "s05:concur:fame-2",
        principal: SYSTEM_AUTHORITY,
        characterId: hero.id,
        fameAmount: 140n,
        sourceCategory: "discovery",
        sourceReference: "disc-1",
      }),
    ]);

    const postConcurSnap = await snapReader.getSocialStandingSnapshot(hero.id, {
      principal: p1,
      projectionScope: "self_character",
    });
    assert.equal(postConcurSnap.moralBounty, 420n); // 350 + 30 + 40
    assert.equal(postConcurSnap.globalFame, 250n); // 110 + 140
  });

  it("Scenarios 14..25: Authoritative crimes, legal vs illegal combat, warrants, unfunded vs funded CriminalBounty, self/duplicate/concurrent bounty claims, and Pardon preserving criminal history", async () => {
    const charRepo = new PostgresCharacterRepository(pgCtx.pool);
    const socialRepo = new PostgresSocialRepository(pgCtx.pool);
    const charEngine = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(pgCtx.pool),
      logger: silentLogger,
    });
    const socialEngine = new SocialEngineService({ pool: pgCtx.pool, logger: silentLogger });

    const accOutlaw = await charRepo.createAccount({ id: randomUUID(), externalSubject: "s05-outlaw" });
    const accHunter1 = await charRepo.createAccount({ id: randomUUID(), externalSubject: "s05-h1" });
    const accHunter2 = await charRepo.createAccount({ id: randomUUID(), externalSubject: "s05-h2" });
    const pOutlaw: AuthorityPrincipal = { kind: "authenticated_account", accountId: accOutlaw.id };

    const outlaw = (
      await charEngine.createCharacter({
        commandId: `s05:outlaw:${randomUUID()}`,
        principal: pOutlaw,
        accountId: accOutlaw.id,
        characterName: "Varkon Lâmina-Negra",
        raceCode: "humans",
        lineageCode: "human_nomadic",
        cultureCode: "steppe_caravaneers",
        backgroundCode: "exile",
        originRegionId: "region-thornreach",
        appearance: {
          bodyPreset: "athletic_a",
          skinTone: "deep_umber",
          hairStyle: "shaved_sides",
          hairColor: "raven_black",
          eyeStyle: "fierce_narrow",
          eyeColor: "crimson_ember",
          earStyle: "rounded_standard",
        },
        presetCode: "assassin",
      })
    ).data;

    const hunter1 = (
      await charEngine.createCharacter({
        commandId: `s05:h1:${randomUUID()}`,
        principal: { kind: "authenticated_account", accountId: accHunter1.id },
        accountId: accHunter1.id,
        characterName: "Darius Caça-Recompensa",
        raceCode: "dwarves",
        lineageCode: "dwarf_mountain",
        cultureCode: "ironforge_guildpact",
        backgroundCode: "hunter",
        originRegionId: "granite-peaks",
        appearance: {
          bodyPreset: "forged_broad_a",
          skinTone: "granite_tan",
          hairStyle: "braided_crown",
          hairColor: "iron_grey",
          eyeStyle: "deep_set",
          eyeColor: "amber_gold",
          earStyle: "rounded_broad",
        },
        presetCode: "berserker",
      })
    ).data;

    const hunter2 = (
      await charEngine.createCharacter({
        commandId: `s05:h2:${randomUUID()}`,
        principal: { kind: "authenticated_account", accountId: accHunter2.id },
        accountId: accHunter2.id,
        characterName: "Sylva Rastreadora",
        raceCode: "elves",
        lineageCode: "elf_forest",
        cultureCode: "verdant_circle",
        backgroundCode: "hunter",
        originRegionId: "green-hollow",
        appearance: {
          bodyPreset: "lean_a",
          skinTone: "forest_ochre",
          hairStyle: "windswept_long",
          hairColor: "ash_brown",
          eyeStyle: "almond_sharp",
          eyeColor: "emerald_green",
          earStyle: "pointed_long",
        },
        presetCode: "assassin",
      })
    ).data;

    // #15 Player cannot accuse/record crimes directly
    await assert.rejects(
      () =>
        socialEngine.recordAuthoritativeCrime({
          commandId: "s05:crime:player-forged",
          principal: pOutlaw,
          offenderCharacterId: hunter1.id,
          offenseCode: "Theft",
          jurisdictionId: "jur-ashvale-civic",
          severity: "minor",
          confirmationLevel: "confirmed",
          evidenceReference: "fake",
        }),
      SocialAuthorizationForbiddenError,
    );

    // #17 Consensual duel in civic city -> NOT recorded as crime
    const duelRes = await socialEngine.recordAuthoritativeCrime({
      commandId: "s05:crime:consensual-duel",
      principal: SYSTEM_AUTHORITY,
      offenderCharacterId: outlaw.id,
      victimCharacterId: hunter1.id,
      offenseCode: "UnlawfulAttack",
      combatContext: "consensual_duel",
      jurisdictionId: "jur-ashvale-civic",
      severity: "moderate",
      confirmationLevel: "confirmed",
      evidenceReference: "duel-flag:ashvale-99",
    });
    assert.equal(duelRes.data.constitutedCrime, false);
    assert.equal(duelRes.data.crimeRecord, null);

    // Suspected offense -> cannot create CriminalBounty!
    const suspectedCrime = await socialEngine.recordAuthoritativeCrime({
      commandId: "s05:crime:suspected-theft",
      principal: SYSTEM_AUTHORITY,
      offenderCharacterId: outlaw.id,
      offenseCode: "Theft",
      jurisdictionId: "jur-granite-guild",
      severity: "minor",
      confirmationLevel: "suspected",
      evidenceReference: "witness:unverified",
    });
    assert.equal(suspectedCrime.data.crimeRecord?.legalStatus, "suspected");
    await assert.rejects(
      () =>
        socialEngine.createCriminalBounty({
          commandId: "s05:bounty:from-suspected-illegal",
          principal: SYSTEM_AUTHORITY,
          targetCharacterId: outlaw.id,
          issuingAuthorityId: "ironforge_magistrate",
          jurisdictionId: "jur-granite-guild",
          sourceCrimeId: suspectedCrime.data.crimeRecord!.id,
          rewardAmount: 500n,
          currencyCode: "silver_mark",
          fundingStatus: "escrow_committed",
          fundingReference: "escrow:1",
          desiredStatus: "Active",
        }),
      CriminalBountyInvalidError,
    );

    // #14 & #18 Confirmed UnlawfulKill in Ashvale -> negative MoralBounty (-300), +1100 notoriety Fame, auto-warrant issued!
    const confirmedMurder = await socialEngine.recordAuthoritativeCrime({
      commandId: "s05:crime:confirmed-kill-ashvale",
      principal: SYSTEM_AUTHORITY,
      offenderCharacterId: outlaw.id,
      victimReference: "npc:merchant-caravan-master",
      offenseCode: "UnlawfulKill",
      combatContext: "unlawful_aggression",
      jurisdictionId: "jur-ashvale-civic",
      severity: "capital",
      confirmationLevel: "confirmed",
      notorietyFameGrant: 1100n,
      reputationPenaltyWithControllingFaction: -600,
      evidenceReference: "guard-witness:ashvale-gate-01",
    });
    assert.equal(confirmedMurder.data.constitutedCrime, true);
    assert.ok(confirmedMurder.data.autoWarrant !== null);
    assert.equal(confirmedMurder.data.socialStanding.moralBounty, -300n);
    assert.equal(confirmedMurder.data.socialStanding.globalFame, 1100n);

    // #25 Unfunded Active bounty rejected!
    await assert.rejects(
      () =>
        socialEngine.createCriminalBounty({
          commandId: "s05:bounty:unfunded-active-illegal",
          principal: SYSTEM_AUTHORITY,
          targetCharacterId: outlaw.id,
          issuingAuthorityId: "valewatch_guard",
          jurisdictionId: "jur-ashvale-civic",
          sourceCrimeId: confirmedMurder.data.crimeRecord!.id,
          rewardAmount: 2500n,
          currencyCode: "silver_mark",
          fundingStatus: "planned_unfunded",
          fundingReference: null,
          desiredStatus: "Active",
        }),
      CriminalBountyInvalidError,
    );

    // Until a ledger exists, textual escrow references cannot prove funding.
    const create = {
      commandId: "s05:bounty:funded-varkon",
      principal: SYSTEM_AUTHORITY,
      targetCharacterId: outlaw.id,
      issuingAuthorityId: "valewatch_guard",
      jurisdictionId: "jur-ashvale-civic",
      warrantId: confirmedMurder.data.autoWarrant!.id,
      sourceCrimeId: confirmedMurder.data.crimeRecord!.id,
      rewardAmount: 2500n,
      currencyCode: "silver_mark",
      fundingStatus: "escrow_committed" as const,
      fundingReference: "treasury-escrow:valewatch:0042",
      desiredStatus: "Active" as const,
    };
    await assert.rejects(() => socialEngine.createCriminalBounty(create), CriminalBountyInvalidError);
    await assert.rejects(() => socialEngine.createCriminalBounty({ ...create, fundingReference: "" }), CriminalBountyInvalidError);
    await assert.rejects(() => socialEngine.createCriminalBounty({ ...create, desiredStatus: "Draft" }), CriminalBountyInvalidError);

    const proposal = (await socialEngine.createCriminalBounty({
      ...create, commandId: "s05:bounty:proposal", fundingStatus: "planned_unfunded",
      fundingReference: null, desiredStatus: "Draft",
    })).data;
    assert.equal(proposal.status, "Draft");
    assert.equal(proposal.fundingStatus, "planned_unfunded");
    const retry = await socialEngine.createCriminalBounty({
      ...create, commandId: "s05:bounty:proposal", fundingStatus: "planned_unfunded",
      fundingReference: null, desiredStatus: "Draft",
    });
    assert.equal(retry.duplicate, true);
    await assert.rejects(() => socialEngine.createCriminalBounty({
      ...create, commandId: "s05:bounty:proposal", fundingStatus: "planned_unfunded",
      fundingReference: null, desiredStatus: "Draft", rewardAmount: 2501n,
    }));

    // Simulate an existing legacy record without deleting or rewriting its financial history.
    await pgCtx.pool.query(
      "UPDATE criminal_bounties SET status = 'Active', funding_status = 'escrow_committed', funding_reference = $2 WHERE id = $1::uuid",
      [proposal.id, "legacy-reference"],
    );
    assert.equal((await socialRepo.listActiveCriminalBounties({ jurisdictionId: "jur-ashvale-civic" })).length, 0);
    const claim = {
      commandId: "s05:claim:legacy", principal: SYSTEM_AUTHORITY, bountyId: proposal.id,
      claimantCharacterId: hunter1.id, resolutionKind: "confirmed_capture" as const,
      authorityConfirmationRef: "capture-report",
    };
    await assert.rejects(() => socialEngine.claimCriminalBounty(claim), CriminalBountyInvalidError);
    await assert.rejects(() => socialEngine.claimCriminalBounty(claim), CriminalBountyInvalidError);
    await assert.rejects(() => socialEngine.claimCriminalBounty({ ...claim, claimantCharacterId: hunter2.id }), CriminalBountyInvalidError);
    const race = await Promise.allSettled([
      socialEngine.claimCriminalBounty(claim),
      socialEngine.claimCriminalBounty({ ...claim, commandId: "s05:claim:other", claimantCharacterId: hunter2.id }),
    ]);
    assert.equal(race.filter((r) => r.status === "rejected").length, 2);
    const preserved = await pgCtx.pool.query(
      "SELECT status, funding_status, funding_reference, reward_amount FROM criminal_bounties WHERE id = $1::uuid",
      [proposal.id],
    );
    assert.equal(preserved.rows[0].funding_reference, "legacy-reference");
    assert.equal(preserved.rows[0].status, "Active");
    assert.equal(preserved.rows[0].reward_amount, "2500");
    assert.equal((await pgCtx.pool.query("SELECT count(*)::int AS n FROM criminal_bounty_claims WHERE bounty_id = $1::uuid", [proposal.id])).rows[0].n, 0);
    // #19 Pardon resolves state to 'Pardoned' without erasing historical criminal_records!
    await socialEngine.resolveCriminalStatus({
      commandId: "s05:pardon:varkon-royal-amnesty",
      principal: SYSTEM_AUTHORITY,
      characterId: outlaw.id,
      jurisdictionId: "jur-ashvale-civic",
      targetState: "Pardoned",
      authorityReference: "decree:ashvale-amnesty-01",
    });

    const preservedCrimes = await socialRepo.listCharacterCriminalRecords(outlaw.id);
    assert.equal(preservedCrimes.length, 2); // Both suspected theft in granite + pardoned murder in ashvale remain in history!
    const pardonedMurderRow = preservedCrimes.find((c) => c.offenseCode === "UnlawfulKill")!;
    assert.equal(pardonedMurderRow.legalStatus, "pardoned");
  });

  it("Scenarios 26..33: Title unlocks, duplicate idempotency, conditional auto-deactivation on crime, revocable office, global exclusivity concurrent race, and non-combat equip", async () => {
    const charRepo = new PostgresCharacterRepository(pgCtx.pool);
    const socialRepo = new PostgresSocialRepository(pgCtx.pool);
    const charEngine = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(pgCtx.pool),
      logger: silentLogger,
    });
    const socialEngine = new SocialEngineService({ pool: pgCtx.pool, logger: silentLogger });
    const charSnapReader = new PostgresCharacterSnapshotReader(pgCtx.pool);

    const counts = await socialRepo.listTitleCatalogCounts();
    assert.equal(counts.total, 18);
    assert.equal(counts.enabled, 14);
    assert.equal(counts.disabledPlanned, 4);

    const accA = await charRepo.createAccount({ id: randomUUID(), externalSubject: "s05-t-a" });
    const accB = await charRepo.createAccount({ id: randomUUID(), externalSubject: "s05-t-b" });
    const pA: AuthorityPrincipal = { kind: "authenticated_account", accountId: accA.id };

    const citizenA = (
      await charEngine.createCharacter({
        commandId: `s05:citA:${randomUUID()}`,
        principal: pA,
        accountId: accA.id,
        characterName: "Helena Luz-Clara",
        raceCode: "humans",
        lineageCode: "human_valorian",
        cultureCode: "valewatch_civic",
        backgroundCode: "noble_heir",
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
        presetCode: "paladin",
      })
    ).data;

    const rivalB = (
      await charEngine.createCharacter({
        commandId: `s05:rivB:${randomUUID()}`,
        principal: { kind: "authenticated_account", accountId: accB.id },
        accountId: accB.id,
        characterName: "Marcus Pioneiro",
        raceCode: "humans",
        lineageCode: "human_frontier",
        cultureCode: "valewatch_civic",
        backgroundCode: "explorer",
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

    // Planned disabled title cannot be unlocked
    await assert.rejects(
      () =>
        socialEngine.evaluateAndUnlockTitle({
          commandId: "s05:title:disabled-blades",
          principal: SYSTEM_AUTHORITY,
          characterId: citizenA.id,
          titleCode: "master_of_blades",
        }),
      TitleConditionInvalidError,
    );

    // #33 Equipping unowned title fails
    await assert.rejects(
      () =>
        socialEngine.equipTitle({
          commandId: "s05:title:equip-unowned",
          principal: pA,
          characterId: citizenA.id,
          titleCode: "guardian_of_innocents",
          expectedSocialVersion: 1,
        }),
      TitleOwnershipOrStateError,
    );

    // Grant +550 MoralBounty and +550 Ashvale regional reputation to citizenA
    await socialEngine.adjustMoralBounty({
      commandId: `s05:t:mb550:${citizenA.id}`,
      principal: SYSTEM_AUTHORITY,
      characterId: citizenA.id,
      signedDelta: 550n,
      actionCode: "heroic_aid",
    });
    await socialEngine.adjustReputation({
      commandId: `s05:t:rep550:${citizenA.id}`,
      principal: SYSTEM_AUTHORITY,
      characterId: citizenA.id,
      scopeType: "region",
      scopeId: "region-ashvale",
      delta: 550,
      actionCode: "civic_stewardship",
    });

    // #26 & #27 Unlock Permanent (`guardian_of_innocents`) + duplicate unlock returns duplicate_idempotent
    const uPerm = await socialEngine.evaluateAndUnlockTitle({
      commandId: `s05:t:unlock-guardian:${citizenA.id}`,
      principal: SYSTEM_AUTHORITY,
      characterId: citizenA.id,
      titleCode: "guardian_of_innocents",
    });
    assert.equal(uPerm.status, "applied");
    const uPermDup = await socialEngine.evaluateAndUnlockTitle({
      commandId: `s05:t:unlock-guardian-dup:${citizenA.id}`,
      principal: SYSTEM_AUTHORITY,
      characterId: citizenA.id,
      titleCode: "guardian_of_innocents",
    });
    assert.equal(uPermDup.status, "duplicate_idempotent");

    // #28 & #32 Unlock Conditional title (`exemplary_citizen_ashvale`) and equip it!
    await socialEngine.evaluateAndUnlockTitle({
      commandId: `s05:t:unlock-exemplary:${citizenA.id}`,
      principal: SYSTEM_AUTHORITY,
      characterId: citizenA.id,
      titleCode: "exemplary_citizen_ashvale",
    });

    const beforeEquipCharSnap = await charSnapReader.getCharacterSnapshot(citizenA.id, {
      principal: pA,
    });
    const equippedSocial = await socialEngine.equipTitle({
      commandId: `s05:t:equip-exemplary:${citizenA.id}`,
      principal: pA,
      characterId: citizenA.id,
      titleCode: "exemplary_citizen_ashvale",
      expectedSocialVersion: 5,
    });
    assert.equal(equippedSocial.data.equippedTitleCode, "exemplary_citizen_ashvale");

    // Confirm zero combat attribute bonus from equipped title!
    const afterEquipCharSnap = await charSnapReader.getCharacterSnapshot(citizenA.id, {
      principal: pA,
    });
    assert.deepEqual(afterEquipCharSnap.baseAttributes, beforeEquipCharSnap.baseAttributes);
    assert.deepEqual(afterEquipCharSnap.allocatedAttributes, beforeEquipCharSnap.allocatedAttributes);

    // #29 Unlock revocable ExclusiveOffice (`warden_governor_ashvale`) & revoke it releasing exclusivity
    await socialEngine.evaluateAndUnlockTitle({
      commandId: `s05:t:unlock-governor:${citizenA.id}`,
      principal: SYSTEM_AUTHORITY,
      characterId: citizenA.id,
      titleCode: "warden_governor_ashvale",
      exclusivityScopeRef: "region-ashvale",
    });
    await socialEngine.revokeTitle({
      commandId: `s05:t:revoke-governor:${citizenA.id}`,
      principal: SYSTEM_AUTHORITY,
      characterId: citizenA.id,
      titleCode: "warden_governor_ashvale",
      reason: "term_completed",
      releaseExclusivityOffice: true,
    });

    // Now citizenA commits a confirmed crime -> `exemplary_citizen_ashvale` auto-deactivates (`inactive_conditional`) & auto-unequips, while `guardian_of_innocents` (`PermanentAchievement`) remains active & title history is preserved!
    const postCrime = await socialEngine.recordAuthoritativeCrime({
      commandId: `s05:t:crime-breaks-exemplary:${citizenA.id}`,
      principal: SYSTEM_AUTHORITY,
      offenderCharacterId: citizenA.id,
      offenseCode: "Theft",
      jurisdictionId: "jur-ashvale-civic",
      severity: "minor",
      confirmationLevel: "confirmed",
      evidenceReference: "ledger-audit-01",
    });
    assert.equal(postCrime.data.socialStanding.equippedTitleCode, null);

    const titlesAfterCrime = await socialRepo.listCharacterTitles(citizenA.id);
    assert.equal(
      titlesAfterCrime.find((t) => t.titleCode === "exemplary_citizen_ashvale")?.state,
      "inactive_conditional",
    );
    assert.equal(
      titlesAfterCrime.find((t) => t.titleCode === "guardian_of_innocents")?.state,
      "active",
    );
    const titleHist = await socialRepo.listCharacterTitleHistory(citizenA.id);
    assert.ok(titleHist.some((h) => h.action === "deactivated_conditional"));

    // #30 & #31 Concurrent Global Exclusive Title Race (`first_liberator_valewatch`)!
    // Record liberation achievement for BOTH citizenA and rivalB, then race `evaluateAndUnlockTitle` concurrently!
    const vwSettlement = (await socialRepo.findSettlementByExternalId("settlement-valewatch"))!;
    await socialEngine.recordHistoricalAchievement({
      commandId: `s05:hist:lib-vw-a:${citizenA.id}`,
      principal: SYSTEM_AUTHORITY,
      eventReference: "invasion:valewatch-lib-01",
      eventType: "SettlementLiberated",
      characterId: citizenA.id,
      settlementId: vwSettlement.id,
      regionId: "region-ashvale",
      contributionRole: "vanguard_liberator",
      summary: "Participou da retomada de Valewatch.",
    });
    await socialEngine.recordHistoricalAchievement({
      commandId: `s05:hist:lib-vw-b:${rivalB.id}`,
      principal: SYSTEM_AUTHORITY,
      eventReference: "invasion:valewatch-lib-01",
      eventType: "SettlementLiberated",
      characterId: rivalB.id,
      settlementId: vwSettlement.id,
      regionId: "region-ashvale",
      contributionRole: "support_liberator",
      summary: "Participou da retomada de Valewatch.",
    });

    const exclRace = await Promise.allSettled([
      socialEngine.evaluateAndUnlockTitle({
        commandId: `s05:excl-race:a:${randomUUID()}`,
        principal: SYSTEM_AUTHORITY,
        characterId: citizenA.id,
        titleCode: "first_liberator_valewatch",
        authoritativeSequence: 100n,
      }),
      socialEngine.evaluateAndUnlockTitle({
        commandId: `s05:excl-race:b:${randomUUID()}`,
        principal: SYSTEM_AUTHORITY,
        characterId: rivalB.id,
        titleCode: "first_liberator_valewatch",
        authoritativeSequence: 100n,
      }),
    ]);

    const exclWinners = exclRace.filter((r) => r.status === "fulfilled");
    const exclLosers = exclRace.filter((r) => r.status === "rejected");
    assert.equal(exclWinners.length, 1);
    assert.equal(exclLosers.length, 1);
    assert.ok(exclLosers[0]?.reason instanceof TitleExclusivityClaimedError);
  });

  it("Scenarios 13, 34..40 & 45..48: Contribution Engine bridge, Orc Hero vs Human Outlaw non-racial recognition, SocialStandingSnapshotV1 scopes & schema, Genesis block, and PostgreSQL restart recovery", async () => {
    const charRepo = new PostgresCharacterRepository(pgCtx.pool);
    let socialRepo = new PostgresSocialRepository(pgCtx.pool);
    const charEngine = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(pgCtx.pool),
      logger: silentLogger,
    });
    const contribService = new RecordContributionService({
      unitOfWork: new PostgresContributionUnitOfWork(pgCtx.pool),
      logger: silentLogger,
    });
    let socialEngine = new SocialEngineService({ pool: pgCtx.pool, logger: silentLogger });
    let snapReader = new PostgresSocialSnapshotReader(pgCtx.pool);

    const accOrc = await charRepo.createAccount({ id: randomUUID(), externalSubject: "s05-orc" });
    const accViewer = await charRepo.createAccount({ id: randomUUID(), externalSubject: "s05-view" });
    const pOrc: AuthorityPrincipal = { kind: "authenticated_account", accountId: accOrc.id };
    const pViewer: AuthorityPrincipal = { kind: "authenticated_account", accountId: accViewer.id };

    // #13 Orc character who will become a celebrated Hero of Valewatch (proving race != morality!)
    const orcHero = (
      await charEngine.createCharacter({
        commandId: `s05:orc-hero:${randomUUID()}`,
        principal: pOrc,
        accountId: accOrc.id,
        characterName: "Gorim Mão-Justa",
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
        presetCode: "paladin",
      })
    ).data;

    // Record 3 contributions in Session 02 `gameplay_contributions`:
    // 1) Eligible Defended contribution for 'neon-player-gorim'
    // 2) Ineligible Defended contribution (`eligible: false`)
    // 3) Eligible Captured contribution (ambiguous moral role unless policy specified!)
    await contribService.record({
      event_id: "s05:contrib:gorim-defended-vw",
      simulation_id: "sim-s05",
      invasion_id: "inv-vw-01",
      settlement_id: "settlement-valewatch",
      tick: "1200",
      player_id: "neon-player-gorim",
      damage: "150",
      support: "420",
      objectives: "2",
      eligible: true,
      outcome: "Defended",
    });
    await contribService.record({
      event_id: "s05:contrib:gorim-ineligible",
      simulation_id: "sim-s05",
      invasion_id: "inv-vw-02",
      settlement_id: "settlement-valewatch",
      tick: "1500",
      player_id: "neon-player-gorim",
      damage: "5",
      support: "0",
      objectives: "0",
      eligible: false,
      outcome: "Defended",
    });
    await contribService.record({
      event_id: "s05:contrib:gorim-captured-ambiguous",
      simulation_id: "sim-s05",
      invasion_id: "inv-vw-03",
      settlement_id: "settlement-valewatch",
      tick: "1800",
      player_id: "neon-player-gorim",
      damage: "300",
      support: "100",
      objectives: "1",
      eligible: true,
      outcome: "Captured",
    });

    // #40 Before linking external identity, recognition fails with ExternalIdentityUnresolvedError
    await assert.rejects(
      () =>
        socialEngine.recognizeEligibleContribution({
          commandId: "s05:rec:unmapped",
          principal: SYSTEM_AUTHORITY,
          contributionExternalEventId: "s05:contrib:gorim-defended-vw",
        }),
      ExternalIdentityUnresolvedError,
    );

    const impostorChar = (
      await charEngine.createCharacter({
        commandId: `s05:impostor:${randomUUID()}`,
        principal: pViewer,
        accountId: accViewer.id,
        characterName: "Zarek Usurpador",
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

    // Link ('neon.simulation', 'neon-player-gorim') -> orcHero.id; verify remapping to another character is blocked!
    await socialEngine.linkExternalIdentity({
      commandId: "s05:link:gorim",
      principal: SYSTEM_AUTHORITY,
      sourceNamespace: "neon.simulation",
      externalSubjectId: "neon-player-gorim",
      characterId: orcHero.id,
    });
    await assert.rejects(
      () =>
        socialEngine.linkExternalIdentity({
          commandId: "s05:link:hijack-gorim",
          principal: SYSTEM_AUTHORITY,
          sourceNamespace: "neon.simulation",
          externalSubjectId: "neon-player-gorim",
          characterId: impostorChar.id,
        }),
      ExternalIdentityConflictError,
    );

    // #39 Ineligible contribution rejected!
    await assert.rejects(
      () =>
        socialEngine.recognizeEligibleContribution({
          commandId: "s05:rec:ineligible",
          principal: SYSTEM_AUTHORITY,
          contributionExternalEventId: "s05:contrib:gorim-ineligible",
        }),
      ContributionRecognitionInvalidError,
    );

    // Captured outcome without explicit role policy rejected (never assumes criminal!)
    await assert.rejects(
      () =>
        socialEngine.recognizeEligibleContribution({
          commandId: "s05:rec:ambiguous-captured",
          principal: SYSTEM_AUTHORITY,
          contributionExternalEventId: "s05:contrib:gorim-captured-ambiguous",
        }),
      ContributionRecognitionInvalidError,
    );

    // #38 Eligible Defended contribution recognized -> grants MoralBounty (+180), Fame (+220), Valewatch Rep (+250), and auto-unlocks `protector_of_valewatch`!
    const recOk = await socialEngine.recognizeEligibleContribution({
      commandId: "s05:rec:gorim-defended-ok",
      principal: SYSTEM_AUTHORITY,
      contributionExternalEventId: "s05:contrib:gorim-defended-vw",
    });
    assert.equal(recOk.status, "applied");
    assert.ok(recOk.data.unlockedTitleCodes.includes("protector_of_valewatch"));

    // Equip `protector_of_valewatch` on Orc Hero
    await socialEngine.equipTitle({
      commandId: "s05:equip:gorim-protector",
      principal: pOrc,
      characterId: orcHero.id,
      titleCode: "protector_of_valewatch",
      expectedSocialVersion: 2,
    });

    // #13 & #37 Compare contextual recognition of Orc Hero in Ashvale (Respectful!) vs distant Red Dunes with high fame threshold
    const vwSettlement = (await socialRepo.findSettlementByExternalId("settlement-valewatch"))!;
    const vwFaction = (await socialRepo.findFactionByCode("valewatch_guard"))!;
    const orcInValewatch = await socialEngine.evaluateCharacterContextualRecognition({
      characterId: orcHero.id,
      contextRegionId: "region-ashvale",
      contextSettlementId: vwSettlement.id,
      contextFactionId: vwFaction.id,
      contextJurisdictionId: "jur-ashvale-civic",
      npcSocialRole: "town_guard",
    });
    assert.equal(orcInValewatch.disposition, "Respectful");
    assert.equal(orcInValewatch.safeZoneEnforcement, "none");

    // #45 & #46 SocialStandingSnapshotV1 JSON Schema validation & query privacy/security
    // Third-party viewer CANNOT read `self_character` or `internal_authorized` scopes!
    await assert.rejects(
      () =>
        snapReader.getSocialStandingSnapshot(orcHero.id, {
          principal: pViewer,
          projectionScope: "self_character",
        }),
      CharacterOwnershipForbiddenError,
    );
    await assert.rejects(
      () =>
        snapReader.getSocialStandingSnapshot(orcHero.id, {
          principal: pViewer,
          projectionScope: "internal_authorized",
        }),
      SocialAuthorizationForbiddenError,
    );

    // Public limited snapshot succeeds for viewer, omitting exact `moral_bounty`!
    const publicSnap = await snapReader.getSocialStandingSnapshot(orcHero.id, {
      principal: pViewer,
      projectionScope: "public_limited",
    });
    const publicWire = serializeSocialStandingSnapshotWireV1(publicSnap);
    assert.equal("moral_bounty" in publicWire, false);
    const pubSchemaValid = validateAgainstJsonSchema(socialSnapshotSchema, publicWire);
    assert.equal(pubSchemaValid.valid, true, pubSchemaValid.errors.join("; "));

    // Self & Internal snapshots include exact signed 64-bit string `moral_bounty` and validate against JSON Schema!
    const internalSnap = await snapReader.getSocialStandingSnapshot(orcHero.id, {
      principal: SYSTEM_AUTHORITY,
      projectionScope: "internal_authorized",
    });
    const internalWire = serializeSocialStandingSnapshotWireV1(internalSnap);
    assert.equal(internalWire.moral_bounty, "180");
    assert.equal(internalWire.equipped_title?.title_code, "protector_of_valewatch");
    const intSchemaValid = validateAgainstJsonSchema(socialSnapshotSchema, internalWire);
    assert.equal(intSchemaValid.valid, true, intSchemaValid.errors.join("; "));

    // #47 Genesis Ranked isolation
    await assert.rejects(
      () =>
        socialEngine.grantFame({
          commandId: "s05:genesis:forbidden",
          principal: SYSTEM_AUTHORITY,
          characterId: orcHero.id,
          fameAmount: 100n,
          sourceCategory: "championship",
          sourceReference: "genesis-md3",
          executionProfile: "genesis_ranked_md3_scratch",
        }),
      GenesisTemporaryStatePersistenceForbiddenError,
    );
    await assert.rejects(
      () =>
        snapReader.getSocialStandingSnapshot(orcHero.id, {
          principal: SYSTEM_AUTHORITY,
          projectionScope: "internal_authorized",
          normalizationProfile: "genesis_ranked_md3_scratch",
        }),
      GenesisTemporaryStatePersistenceForbiddenError,
    );

    // #48 Restart PostgreSQL server and verify full persistent recovery!
    const newPool = await pgCtx.restartAndReconnect();
    socialRepo = new PostgresSocialRepository(newPool);
    socialEngine = new SocialEngineService({ pool: newPool, logger: silentLogger });
    snapReader = new PostgresSocialSnapshotReader(newPool);

    const recoveredSnap = await snapReader.getSocialStandingSnapshot(orcHero.id, {
      principal: pOrc,
      projectionScope: "self_character",
    });
    const recoveredLedger = await socialRepo.listCharacterSocialLedger(orcHero.id);
    assert.equal(recoveredSnap.moralBounty, 180n);
    assert.equal(recoveredSnap.globalFame, 220n);
    assert.equal(recoveredSnap.equippedTitle?.titleCode, "protector_of_valewatch");
    assert.ok(recoveredLedger.length >= 1);
  });
});
