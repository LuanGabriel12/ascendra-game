import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CharacterEngineService } from "../modules/characters/application/character-engine-service.js";
import type { AuthorityPrincipal } from "../modules/characters/domain/character.js";
import {
  PostgresCharacterRepository,
  PostgresCharacterUnitOfWork,
} from "../modules/characters/infrastructure/postgres-character-unit-of-work.js";
import { RecordContributionService } from "../modules/contributions/application/record-contribution-service.js";
import { PostgresContributionUnitOfWork } from "../modules/contributions/infrastructure/postgres-contribution-unit-of-work.js";
import { PostgresInventoryRepository } from "../modules/inventory/infrastructure/postgres-inventory-unit-of-work.js";
import { PostgresCatalogRepository } from "../modules/peoples/infrastructure/postgres-catalog-repository.js";
import { SocialEngineService } from "../modules/social/application/social-engine-service.js";
import {
  PostgresSocialSnapshotReader,
  serializeSocialStandingSnapshotWireV1,
} from "../modules/social/application/social-snapshot-query.js";
import { CriminalBountyInvalidError } from "../modules/social/domain/errors.js";
import { PostgresSocialRepository } from "../modules/social/infrastructure/postgres-social-unit-of-work.js";
import { migrateUp } from "../shared/db/migrator.js";
import { StructuredLogger } from "../shared/observability/logger.js";
import { startPostgresTestContext } from "../../tests/helpers/postgres-test-harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

async function runSession05Demo(): Promise<void> {
  const logger = new StructuredLogger("info");
  logger.info(
    "Starting CARBON Session 05 headless reputation, bounty, fame, criminality, titles & world recognition demo",
    { operation: "demo05:start" },
  );

  // 1. Initialize isolated PostgreSQL
  const pgCtx = await startPostgresTestContext();

  try {
    // 2. Apply all migrations (0001..0009)
    const applied = await migrateUp(pgCtx.pool, MIGRATIONS_DIR);
    logger.info("Step 2: Migrations 0001..0009 applied", {
      operation: "demo05:migrate",
      applied,
    });

    // 3. Load & seed catalogs and social rules
    const catalogRepo = new PostgresCatalogRepository(pgCtx.pool);
    const charRepo = new PostgresCharacterRepository(pgCtx.pool);
    const invRepo = new PostgresInventoryRepository(pgCtx.pool);
    let socialRepo = new PostgresSocialRepository(pgCtx.pool);
    await catalogRepo.seedInitialCatalogs();
    await charRepo.seedProgressionRules();
    await invRepo.seedInitialItemCatalogs();
    await socialRepo.seedInitialSocialCatalogs();

    // 4. Create three characters across three accounts:
    //    - Heroic Orc Defender ("Gorim Escudo-Vivo") -> proves species != morality!
    //    - Notorious Human Outlaw ("Varkon Cinza-Negra")
    //    - Dwarven Bounty Hunter ("Bramir Caça-Sombras")
    const accHero = await charRepo.createAccount({ id: randomUUID(), externalSubject: "demo05-hero" });
    const accOutlaw = await charRepo.createAccount({ id: randomUUID(), externalSubject: "demo05-outlaw" });
    const accHunter = await charRepo.createAccount({ id: randomUUID(), externalSubject: "demo05-hunter" });

    const pHero: AuthorityPrincipal = { kind: "authenticated_account", accountId: accHero.id };
    const pOutlaw: AuthorityPrincipal = { kind: "authenticated_account", accountId: accOutlaw.id };
    const pHunter: AuthorityPrincipal = { kind: "authenticated_account", accountId: accHunter.id };
    const sysAuth: AuthorityPrincipal = {
      kind: "internal_system_authority",
      actorId: "world-recognition-director",
    };

    const charEngine = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(pgCtx.pool),
      logger,
    });
    const contribService = new RecordContributionService({
      unitOfWork: new PostgresContributionUnitOfWork(pgCtx.pool),
      logger,
    });
    let socialEngine = new SocialEngineService({ pool: pgCtx.pool, logger });
    let snapReader = new PostgresSocialSnapshotReader(pgCtx.pool);

    const orcHero = (
      await charEngine.createCharacter({
        commandId: "demo05:char:orc-hero",
        principal: pHero,
        accountId: accHero.id,
        characterName: "Gorim Escudo-Vivo",
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

    const humanOutlaw = (
      await charEngine.createCharacter({
        commandId: "demo05:char:human-outlaw",
        principal: pOutlaw,
        accountId: accOutlaw.id,
        characterName: "Varkon Cinza-Negra",
        raceCode: "humans",
        lineageCode: "human_nomadic",
        cultureCode: "steppe_caravaneers",
        backgroundCode: "exile",
        originRegionId: "region-thornreach",
        appearance: {
          bodyPreset: "athletic_a",
          skinTone: "olive_bronze",
          hairStyle: "shaved_sides",
          hairColor: "raven_black",
          eyeStyle: "fierce_narrow",
          eyeColor: "crimson_ember",
          earStyle: "rounded_standard",
        },
        presetCode: "assassin",
      })
    ).data;

    const dwarfHunter = (
      await charEngine.createCharacter({
        commandId: "demo05:char:dwarf-hunter",
        principal: pHunter,
        accountId: accHunter.id,
        characterName: "Bramir Caça-Sombras",
        raceCode: "dwarves",
        lineageCode: "dwarf_mountain",
        cultureCode: "ironforge_guildpact",
        backgroundCode: "hunter",
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

    // 5. Query representative factions & settlements
    const valewatchGuard = (await socialRepo.findFactionByCode("valewatch_guard"))!;
    const thornveilSyndicate = (await socialRepo.findFactionByCode("thornveil_syndicate"))!;
    const valewatchSettlement = (await socialRepo.findSettlementByExternalId("settlement-valewatch"))!;
    const thornveilSettlement = (await socialRepo.findSettlementByExternalId("settlement-thornveil"))!;

    // 6–10. Link external NEON PlayerID & recognize heroic city defense contribution -> grants positive MoralBounty, Fame, Reputation, and unlocks 'Protetor de Valewatch'!
    await socialEngine.linkExternalIdentity({
      commandId: "demo05:link:gorim-neon",
      principal: sysAuth,
      sourceNamespace: "neon.simulation",
      externalSubjectId: "player-gorim-01",
      characterId: orcHero.id,
    });
    await contribService.record({
      event_id: "demo05:contrib:valewatch-defense-01",
      simulation_id: "sim-ashvale-01",
      invasion_id: "inv-valewatch-siege",
      settlement_id: "settlement-valewatch",
      tick: "2400",
      player_id: "player-gorim-01",
      damage: "320",
      support: "510",
      objectives: "3",
      eligible: true,
      outcome: "Defended",
    });

    const contribRecognition = await socialEngine.recognizeEligibleContribution({
      commandId: "demo05:recognize:gorim-valewatch",
      principal: sysAuth,
      contributionExternalEventId: "demo05:contrib:valewatch-defense-01",
    });
    assert.ok(contribRecognition.data.unlockedTitleCodes.includes("protector_of_valewatch"));

    // Also grant additional heroic MoralBounty (+350), Fame (+400), and Ashvale regional Reputation (+450)
    await socialEngine.adjustMoralBounty({
      commandId: "demo05:moral:gorim-rescue-citizens",
      principal: sysAuth,
      characterId: orcHero.id,
      signedDelta: 350n,
      actionCode: "rescue_protected_npcs",
      regionId: "region-ashvale",
    });
    await socialEngine.grantFame({
      commandId: "demo05:fame:gorim-heroics",
      principal: sysAuth,
      characterId: orcHero.id,
      fameAmount: 400n,
      sourceCategory: "city_defense",
      sourceReference: "valewatch-relief",
      regionId: "region-ashvale",
    });
    await socialEngine.adjustReputation({
      commandId: "demo05:rep:gorim-ashvale-region",
      principal: sysAuth,
      characterId: orcHero.id,
      scopeType: "region",
      scopeId: "region-ashvale",
      delta: 450,
      actionCode: "border_protection",
    });

    // 11. Equip 'Protetor de Valewatch' on Gorim
    const gorimAfterEquip = await socialEngine.equipTitle({
      commandId: "demo05:equip:gorim-protector",
      principal: pHero,
      characterId: orcHero.id,
      titleCode: "protector_of_valewatch",
      expectedSocialVersion: 5,
    });
    assert.equal(gorimAfterEquip.data.equippedTitleCode, "protector_of_valewatch");

    // 12–16. Record confirmed capital crime by Varkon in Ashvale -> legal consequences, negative MoralBounty, criminal notoriety Fame, and arrest warrant!
    const crimeOutcome = await socialEngine.recordAuthoritativeCrime({
      commandId: "demo05:crime:varkon-assault-ashvale",
      principal: sysAuth,
      offenderCharacterId: humanOutlaw.id,
      victimReference: "npc:ashvale-magistrate-escort",
      offenseCode: "UnlawfulKill",
      combatContext: "unlawful_aggression",
      jurisdictionId: "jur-ashvale-civic",
      severity: "capital",
      confirmationLevel: "confirmed",
      notorietyFameGrant: 1200n,
      reputationPenaltyWithControllingFaction: -700,
      evidenceReference: "witness-seal:ashvale-09",
    });
    assert.ok(crimeOutcome.data.autoWarrant !== null);

    // Varkon also builds positive underworld standing with Thornveil Syndicate (+350) & further infamy (-750)
    await socialEngine.adjustReputation({
      commandId: "demo05:rep:varkon-syndicate",
      principal: sysAuth,
      characterId: humanOutlaw.id,
      scopeType: "faction",
      scopeId: thornveilSyndicate.id,
      delta: 350,
      actionCode: "smuggling_contract",
      propagateToRelatedFactions: false,
    });
    await socialEngine.adjustMoralBounty({
      commandId: "demo05:moral:varkon-sabotage",
      principal: sysAuth,
      characterId: humanOutlaw.id,
      signedDelta: -750n,
      actionCode: "caravan_raid",
      regionId: "region-thornreach",
    });

    // 17. Create funded CriminalBounty (`escrow_committed`) on Varkon
    const varkonBounty = (
      await socialEngine.createCriminalBounty({
        commandId: "demo05:bounty:create-varkon",
        principal: sysAuth,
        targetCharacterId: humanOutlaw.id,
        issuingAuthorityId: "valewatch_guard",
        jurisdictionId: "jur-ashvale-civic",
        warrantId: crimeOutcome.data.autoWarrant!.id,
        sourceCrimeId: crimeOutcome.data.crimeRecord!.id,
        rewardAmount: 3000n,
        currencyCode: "silver_mark",
        fundingStatus: "escrow_committed",
        fundingReference: "escrow:valewatch-treasury:77",
        desiredStatus: "Active",
      })
    ).data;

    // 18–19. Bramir claims the CriminalBounty (`pending_economy_settlement`); duplicate claim attempt is rejected!
    const validClaim = await socialEngine.claimCriminalBounty({
      commandId: "demo05:bounty:claim-varkon-by-bramir",
      principal: sysAuth,
      bountyId: varkonBounty.id,
      claimantCharacterId: dwarfHunter.id,
      resolutionKind: "authorized_defeat",
      authorityConfirmationRef: "combat-log:ashvale-bounty-77",
    });
    assert.equal(validClaim.data.payoutCommitmentStatus, "pending_economy_settlement");

    await assert.rejects(
      () =>
        socialEngine.claimCriminalBounty({
          commandId: "demo05:bounty:duplicate-claim-rejected",
          principal: sysAuth,
          bountyId: varkonBounty.id,
          claimantCharacterId: dwarfHunter.id,
          resolutionKind: "authorized_defeat",
          authorityConfirmationRef: "combat-log:duplicate-attempt",
        }),
      CriminalBountyInvalidError,
    );

    // 20. Unlock & equip criminal title ('Terror dos Reinos') on Varkon + bounty-hunter title on Bramir
    await socialEngine.evaluateAndUnlockTitle({
      commandId: "demo05:title:varkon-terror",
      principal: sysAuth,
      characterId: humanOutlaw.id,
      titleCode: "terror_of_the_realms",
    });
    await socialEngine.equipTitle({
      commandId: "demo05:equip:varkon-terror",
      principal: pOutlaw,
      characterId: humanOutlaw.id,
      titleCode: "terror_of_the_realms",
      expectedSocialVersion: 5,
    });
    await socialEngine.evaluateAndUnlockTitle({
      commandId: "demo05:title:bramir-hunter",
      principal: sysAuth,
      characterId: dwarfHunter.id,
      titleCode: "relentless_bounty_hunter",
    });

    // 21–22. Compare contextual NPC recognition across two regions (Ashvale vs Thornreach) & prove species != morality!
    //        Orc Gorim is Admiring/Respectful in Ashvale; Human Varkon is Hostile to Ashvale guards yet Admiring to Thornveil Syndicate!
    const gorimInAshvale = await socialEngine.evaluateCharacterContextualRecognition({
      characterId: orcHero.id,
      contextRegionId: "region-ashvale",
      contextSettlementId: valewatchSettlement.id,
      contextFactionId: valewatchGuard.id,
      contextJurisdictionId: "jur-ashvale-civic",
      npcSocialRole: "civic_citizen",
    });
    const gorimInRedDunes = await socialEngine.evaluateCharacterContextualRecognition({
      characterId: orcHero.id,
      contextRegionId: "red-dunes",
      npcSocialRole: "merchant",
    });
    const varkonInAshvaleGuard = await socialEngine.evaluateCharacterContextualRecognition({
      characterId: humanOutlaw.id,
      contextRegionId: "region-ashvale",
      contextSettlementId: valewatchSettlement.id,
      contextFactionId: valewatchGuard.id,
      contextJurisdictionId: "jur-ashvale-civic",
      npcSocialRole: "town_guard",
      authoritativePowerStanding: 820,
    });
    const varkonInThornveilSyndicate = await socialEngine.evaluateCharacterContextualRecognition({
      characterId: humanOutlaw.id,
      contextRegionId: "region-thornreach",
      contextSettlementId: thornveilSettlement.id,
      contextFactionId: thornveilSyndicate.id,
      contextJurisdictionId: "jur-thornveil-frontier",
      npcSocialRole: "criminal_syndicate",
    });

    assert.equal(gorimInAshvale.disposition, "Admiring"); // Heroic Orc admired in Human/multicultural city!
    assert.equal(varkonInAshvaleGuard.disposition, "Hostile"); // Outlaw Human arrested on sight by city guard!
    assert.equal(varkonInThornveilSyndicate.disposition, "Admiring"); // Admired by criminal syndicate!

    logger.info("Steps 21-22: Contextual recognition across regions & race-neutral morality verified", {
      operation: "demo05:recognition",
      orc_hero_in_ashvale: gorimInAshvale.disposition,
      orc_hero_in_distant_red_dunes: gorimInRedDunes.disposition,
      human_outlaw_to_ashvale_guard: varkonInAshvaleGuard.disposition,
      human_outlaw_to_thornveil_syndicate: varkonInThornveilSyndicate.disposition,
    });

    // 23–24. Re-deliver heroic contribution recognition -> confirm zero duplication!
    const dupHeroic = await socialEngine.recognizeEligibleContribution({
      commandId: "demo05:recognize:gorim-valewatch",
      principal: sysAuth,
      contributionExternalEventId: "demo05:contrib:valewatch-defense-01",
    });
    assert.equal(dupHeroic.status, "duplicate_idempotent");

    // 25. Record an explicit World Historical Milestone
    const histMilestone = await socialEngine.recordHistoricalAchievement({
      commandId: "demo05:history:valewatch-bastion-monument",
      principal: sysAuth,
      eventReference: "chronicle:ashvale-year1-bastion",
      eventType: "ExclusiveMilestone",
      characterId: orcHero.id,
      settlementId: valewatchSettlement.id,
      regionId: "region-ashvale",
      factionId: valewatchGuard.id,
      contributionRole: "honored_protector",
      summary: "Gorim Escudo-Vivo inscrito nos anais cívicos de Valewatch.",
    });
    assert.equal(histMilestone.status, "applied");

    // 26. Produce SocialStandingSnapshotV1 (wire-serialized with 64-bit decimal strings)
    const gorimSnap = await snapReader.getSocialStandingSnapshot(orcHero.id, {
      principal: sysAuth,
      projectionScope: "internal_authorized",
    });
    const varkonPublicSnap = await snapReader.getSocialStandingSnapshot(humanOutlaw.id, {
      principal: pHero,
      projectionScope: "public_limited",
    });
    logger.info("Step 26: SocialStandingSnapshotV1 projections generated", {
      operation: "demo05:snapshots",
      gorim_internal_wire: serializeSocialStandingSnapshotWireV1(gorimSnap),
      varkon_public_wire: serializeSocialStandingSnapshotWireV1(varkonPublicSnap),
    });

    // 27–28. Restart PostgreSQL server / reconnect pool and confirm durable recovery of all social domains
    const reconnectedPool = await pgCtx.restartAndReconnect();
    socialRepo = new PostgresSocialRepository(reconnectedPool);
    socialEngine = new SocialEngineService({ pool: reconnectedPool, logger });
    snapReader = new PostgresSocialSnapshotReader(reconnectedPool);

    const recoveredGorim = await snapReader.getSocialStandingSnapshot(orcHero.id, {
      principal: pHero,
      projectionScope: "self_character",
    });
    const recoveredVarkon = await snapReader.getSocialStandingSnapshot(humanOutlaw.id, {
      principal: pOutlaw,
      projectionScope: "self_character",
    });
    const recoveredClaims = await socialRepo.listCharacterBountyClaims(dwarfHunter.id);

    assert.equal(recoveredGorim.moralBounty, 530n); // +180 contrib + 350 rescue
    assert.equal(recoveredGorim.globalFame, 620n); // +220 contrib + 400 heroics
    assert.equal(recoveredGorim.equippedTitle?.titleCode, "protector_of_valewatch");
    assert.equal(recoveredVarkon.moralBounty, -1050n); // -300 murder - 750 sabotage
    assert.equal(recoveredVarkon.globalFame, 1200n);
    assert.equal(recoveredVarkon.equippedTitle?.titleCode, "terror_of_the_realms");
    assert.equal(recoveredClaims.length, 1);
    assert.equal(recoveredClaims[0]?.payoutCommitmentStatus, "pending_economy_settlement");

    logger.info("Step 28: Persistent recovery of MoralBounty, Fame, Reputations, Crimes, Claims & Titles confirmed", {
      operation: "demo05:complete",
      result: "ok",
      embedded_postgres_restarted: pgCtx.isEmbedded,
      gorim_moral_bounty: recoveredGorim.moralBounty?.toString(),
      gorim_title: recoveredGorim.equippedTitle?.displayName,
      varkon_moral_bounty: recoveredVarkon.moralBounty?.toString(),
      varkon_title: recoveredVarkon.equippedTitle?.displayName,
      bramir_fulfilled_claims: recoveredClaims.length,
    });
  } finally {
    await pgCtx.stop();
  }
}

runSession05Demo().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`Session 05 demo failed: ${msg}\n`);
  process.exitCode = 1;
});
