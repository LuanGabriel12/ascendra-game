import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CharacterEngineService } from "../../src/modules/characters/application/character-engine-service.js";
import type { AuthorityPrincipal } from "../../src/modules/characters/domain/character.js";
import {
  PostgresCharacterRepository,
  PostgresCharacterUnitOfWork,
} from "../../src/modules/characters/infrastructure/postgres-character-unit-of-work.js";
import { RecordContributionService } from "../../src/modules/contributions/application/record-contribution-service.js";
import { PostgresContributionUnitOfWork } from "../../src/modules/contributions/infrastructure/postgres-contribution-unit-of-work.js";
import { CraftingAndProfessionService } from "../../src/modules/economy/application/crafting-and-profession-service.js";
import { LootFragmentsAndBountyService } from "../../src/modules/economy/application/loot-fragments-and-bounty-service.js";
import { MonetaryAndEscrowService } from "../../src/modules/economy/application/monetary-and-escrow-service.js";
import { RegionalMarketAndMerchantService } from "../../src/modules/economy/application/regional-market-and-merchant-service.js";
import {
  CraftingOrProfessionError,
  EscrowReservationStateError,
  LootOrRewardInvalidError,
  NpcMerchantOperationError,
  RegionalMarketInvalidError,
} from "../../src/modules/economy/domain/errors.js";
import { PostgresEconomyRepository } from "../../src/modules/economy/infrastructure/postgres-economy-unit-of-work.js";
import { runEconomyDevelopmentSimulation } from "../../src/modules/economy/simulation/economy-simulator.js";
import { InventoryEngineService } from "../../src/modules/inventory/application/inventory-engine-service.js";
import { PostgresInventoryRepository } from "../../src/modules/inventory/infrastructure/postgres-inventory-unit-of-work.js";
import { PostgresCatalogRepository } from "../../src/modules/peoples/infrastructure/postgres-catalog-repository.js";
import { SocialEngineService } from "../../src/modules/social/application/social-engine-service.js";
import {
  CriminalBountyInvalidError,
  TitleConditionInvalidError,
} from "../../src/modules/social/domain/errors.js";
import { PostgresSocialRepository } from "../../src/modules/social/infrastructure/postgres-social-unit-of-work.js";
import { migrateDown, migrateUp } from "../../src/shared/db/migrator.js";
import { StructuredLogger } from "../../src/shared/observability/logger.js";
import {
  startPostgresTestContext,
  type RunningPostgresTestContext,
} from "../helpers/postgres-test-harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

const SYSTEM_AUTH: AuthorityPrincipal = {
  kind: "internal_system_authority",
  actorId: "test-economy-cde",
};

describe("CARBON Session 07 (Stages C, D & E) — Regional Market, NPC Merchants, Loot/Fragments, Verified Criminal Bounties, Crafting & Titles (Real PostgreSQL)", () => {
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

  it("validates 0014..0015 migrations, regional market taxes & concurrent buy/cancel, NPC merchants/repair, boss loot & fragments, world contributions, verified vs legacy criminal bounties, crafting atomicity, economic titles, simulation, and PG restart durability", async () => {
    await migrateUp(pgCtx.pool, MIGRATIONS_DIR);
    // Test clean rollback of 0015 & 0014 and re-apply
    await migrateDown(pgCtx.pool, MIGRATIONS_DIR, 2);
    await migrateUp(pgCtx.pool, MIGRATIONS_DIR);

    const catalogRepo = new PostgresCatalogRepository(pgCtx.pool);
    await catalogRepo.seedInitialCatalogs();
    const charRepo = new PostgresCharacterRepository(pgCtx.pool);
    await charRepo.seedProgressionRules();
    const invRepo = new PostgresInventoryRepository(pgCtx.pool);
    await invRepo.seedInitialItemCatalogs();
    const socialRepo = new PostgresSocialRepository(pgCtx.pool);
    await socialRepo.seedInitialSocialCatalogs();
    const econRepo = new PostgresEconomyRepository(pgCtx.pool);
    await econRepo.seedInitialEconomyCatalogs();

    const charEngine = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(pgCtx.pool),
      logger: silentLogger,
    });
    const invEngine = new InventoryEngineService({ pool: pgCtx.pool, logger: silentLogger });
    const socialEngine = new SocialEngineService({ pool: pgCtx.pool, logger: silentLogger });
    const contribService = new RecordContributionService({
      unitOfWork: new PostgresContributionUnitOfWork(pgCtx.pool),
      logger: silentLogger,
    });
    const monetary = new MonetaryAndEscrowService({ pool: pgCtx.pool, logger: silentLogger });
    const market = new RegionalMarketAndMerchantService({ pool: pgCtx.pool, logger: silentLogger });
    const lootBounty = new LootFragmentsAndBountyService({
      pool: pgCtx.pool,
      logger: silentLogger,
    });
    const crafting = new CraftingAndProfessionService({ pool: pgCtx.pool, logger: silentLogger });

    const valewatch = (await socialRepo.findSettlementByExternalId("settlement-valewatch"))!;

    const accSeller = await charRepo.createAccount({ id: randomUUID(), externalSubject: "s07-seller" });
    const accBuyer = await charRepo.createAccount({ id: randomUUID(), externalSubject: "s07-buyer" });
    const accOutlaw = await charRepo.createAccount({ id: randomUUID(), externalSubject: "s07-outlaw" });
    const pSeller: AuthorityPrincipal = { kind: "authenticated_account", accountId: accSeller.id };
    const pBuyer: AuthorityPrincipal = { kind: "authenticated_account", accountId: accBuyer.id };
    const pOutlaw: AuthorityPrincipal = { kind: "authenticated_account", accountId: accOutlaw.id };

    const app = {
      bodyPreset: "athletic_a",
      skinTone: "olive_bronze",
      hairStyle: "short_cropped",
      hairColor: "raven_black",
      eyeStyle: "almond_sharp",
      eyeColor: "slate_blue",
      earStyle: "rounded_standard",
    };

    const seller = (
      await charEngine.createCharacter({
        commandId: "s07-cde:char:seller",
        principal: pSeller,
        accountId: accSeller.id,
        characterName: "Kaelen Mercante",
        raceCode: "humans",
        lineageCode: "human_frontier",
        cultureCode: "valewatch_civic",
        backgroundCode: "veteran_soldier",
        originRegionId: "region-ashvale",
        presetCode: "berserker",
        appearance: app,
      })
    ).data;

    // Second character on Seller's SAME account (to verify anti-wash-trading on `imperial_merchant`!)
    const sellerAlt = (
      await charEngine.createCharacter({
        commandId: "s07-cde:char:seller-alt",
        principal: pSeller,
        accountId: accSeller.id,
        characterName: "Kaelen Alt",
        raceCode: "humans",
        lineageCode: "human_frontier",
        cultureCode: "valewatch_civic",
        backgroundCode: "veteran_soldier",
        originRegionId: "region-ashvale",
        presetCode: "berserker",
        appearance: app,
      })
    ).data;

    const buyer = (
      await charEngine.createCharacter({
        commandId: "s07-cde:char:buyer",
        principal: pBuyer,
        accountId: accBuyer.id,
        characterName: "Lyra Caçadora",
        raceCode: "humans",
        lineageCode: "human_frontier",
        cultureCode: "valewatch_civic",
        backgroundCode: "veteran_soldier",
        originRegionId: "region-ashvale",
        presetCode: "berserker",
        appearance: app,
      })
    ).data;

    const outlaw = (
      await charEngine.createCharacter({
        commandId: "s07-cde:char:outlaw",
        principal: pOutlaw,
        accountId: accOutlaw.id,
        characterName: "Vane Renegado",
        raceCode: "humans",
        lineageCode: "human_frontier",
        cultureCode: "valewatch_civic",
        backgroundCode: "veteran_soldier",
        originRegionId: "region-ashvale",
        presetCode: "berserker",
        appearance: app,
      })
    ).data;

    for (const [cid, amt] of [
      [seller.id, 5_000n],
      [sellerAlt.id, 5_000n],
      [buyer.id, 10_000n],
    ] as const) {
      await monetary.mintAuthorizedCurrency({
        commandId: `s07-cde:mint:${cid}`,
        principal: SYSTEM_AUTH,
        recipientCharacterId: cid,
        currencyCode: "ascendra_coin",
        amount: amt,
        sourceCategory: "dev_seed",
        sourceReference: "s07-cde-seed",
      });
    }

    // =========================================================================
    // STAGE C — Regional Market, Tax Split, Partial Fill, Cancel vs Buy Race, Expiration & Price Stats
    // =========================================================================
    const shieldForSale = (
      await invEngine.grantProceduralEquipment({
        grantId: "s07-cde:grant:shield",
        principal: SYSTEM_AUTH,
        recipientCharacterId: seller.id,
        definitionCode: "valewatch_tower_shield",
        rarityCode: "rare",
        originType: "dungeon_reward",
        originReference: "bastion:01",
      })
    ).data;

    // Listing at 1,000 coins in Valewatch (listing fee 1% = 10 to Valewatch Treasury; sale tax 5% = 50 to Valewatch Treasury, 950 net to seller!)
    const shieldListing = (
      await market.createMarketListing({
        commandId: "s07-cde:mkt:list-shield",
        principal: pSeller,
        sellerCharacterId: seller.id,
        settlementId: valewatch.id,
        itemInstanceId: shieldForSale.id,
        unitPrice: 1000n,
      })
    ).data;
    assert.equal(shieldListing.listingFeePaid, 10n);

    // Cannot list the same escrowed equipment a second time!
    await assert.rejects(
      () =>
        market.createMarketListing({
          commandId: "s07-cde:mkt:double-list",
          principal: pSeller,
          sellerCharacterId: seller.id,
          settlementId: valewatch.id,
          itemInstanceId: shieldForSale.id,
          unitPrice: 900n,
        }),
      /escrow/i,
    );

    const buyShield = (
      await market.buyMarketListing({
        commandId: "s07-cde:mkt:buy-shield",
        principal: pBuyer,
        buyerCharacterId: buyer.id,
        listingId: shieldListing.id,
      })
    ).data;
    assert.equal(buyShield.listing.status, "Filled");
    assert.equal(buyShield.sale.grossAmount, 1000n);
    assert.equal(buyShield.sale.sellerNetAmount, 950n);
    assert.equal(buyShield.sale.treasuryTaxAmount, 50n);
    assert.equal(buyShield.sale.sinkBurnedAmount, 0n);

    const vwTreasuryAfterShield = (await econRepo.getSettlementTreasury(valewatch.id))!;
    assert.equal(vwTreasuryAfterShield.balance, 60n); // 10 listing fee + 50 sale tax!

    // Stack listing with partial fill, concurrent buy vs cancel race, and expiration!
    const sellerOre = (
      await invEngine.grantStackableMaterial({
        grantId: "s07-cde:grant:seller-ore",
        principal: SYSTEM_AUTH,
        recipientCharacterId: seller.id,
        definitionCode: "iron_ore",
        quantity: 40,
        originType: "gathering",
        originReference: "mine:01",
      })
    ).data;

    const oreListing = (
      await market.createMarketListing({
        commandId: "s07-cde:mkt:list-ore",
        principal: pSeller,
        sellerCharacterId: seller.id,
        settlementId: valewatch.id,
        stackId: sellerOre[0]!.id,
        quantity: 20,
        unitPrice: 50n,
      })
    ).data;

    // Partial fill of 10 units
    const partialBuy = (
      await market.buyMarketListing({
        commandId: "s07-cde:mkt:buy-ore-10",
        principal: pBuyer,
        buyerCharacterId: buyer.id,
        listingId: oreListing.id,
        quantity: 10,
      })
    ).data;
    assert.equal(partialBuy.listing.status, "PartiallyFilled");
    assert.equal(partialBuy.listing.remainingQuantity, 10);

    // Concurrent race: Buyer tries to buy remaining 10 while Seller cancels simultaneously -> exactly ONE succeeds!
    const [raceBuy, raceCancel] = await Promise.allSettled([
      market.buyMarketListing({
        commandId: "s07-cde:mkt:race-buy-rem",
        principal: pBuyer,
        buyerCharacterId: buyer.id,
        listingId: oreListing.id,
        quantity: 10,
      }),
      market.cancelMarketListing({
        commandId: "s07-cde:mkt:race-cancel-rem",
        principal: pSeller,
        sellerCharacterId: seller.id,
        listingId: oreListing.id,
      }),
    ]);
    assert.equal([raceBuy, raceCancel].filter((r) => r.status === "fulfilled").length, 1);
    assert.equal([raceBuy, raceCancel].filter((r) => r.status === "rejected").length, 1);

    // Expiring short-lived listing returns remaining stock cleanly
    const sellerHerbs = (
      await invEngine.grantStackableMaterial({
        grantId: "s07-cde:grant:seller-herbs",
        principal: SYSTEM_AUTH,
        recipientCharacterId: seller.id,
        definitionCode: "medicinal_herb",
        quantity: 10,
        originType: "gathering",
        originReference: "meadow:01",
      })
    ).data;
    const shortListing = (
      await market.createMarketListing({
        commandId: "s07-cde:mkt:short-herb",
        principal: pSeller,
        sellerCharacterId: seller.id,
        settlementId: valewatch.id,
        stackId: sellerHerbs[0]!.id,
        quantity: 10,
        unitPrice: 30n,
        durationSeconds: 5,
      })
    ).data;
    const expired = await market.expireMarketListing({
      commandId: "s07-cde:mkt:expire-short",
      principal: SYSTEM_AUTH,
      listingId: shortListing.id,
      asOf: new Date(Date.now() + 10_000),
    });
    assert.equal(expired.data.status, "Expired");

    // Verify Regional Market Price Stats differentiate unsold asks vs executed sales!
    const statsShield = await econRepo.getRegionalMarketPriceStats({
      settlementId: valewatch.id,
      definitionCode: "valewatch_tower_shield",
    });
    assert.equal(statsShield.completedSalesCount, 1);
    assert.equal(statsShield.lastTradedUnitPrice, 1000n);
    assert.equal(statsShield.medianSaleUnitPrice, 1000n);

    // NPC Merchant: buy limited stock, sell back iron_ore (funded by Valewatch treasury!), and repair damaged shield!
    const npcHerbBuy = await market.buyFromNpcMerchant({
      commandId: "s07-cde:npc:buy-herb",
      principal: pBuyer,
      characterId: buyer.id,
      merchantCode: "valewatch_quartermaster",
      offerCode: "sell_medicinal_herb_limited",
      quantity: 4,
    });
    assert.equal(npcHerbBuy.data.totalPaid, 100n); // 4 * 25 -> increases Valewatch treasury!

    const buyerStacksForNpc = await invRepo.listCharacterStacks(buyer.id);
    const buyerOreStack = buyerStacksForNpc.find((s) => s.definitionCode === "iron_ore")!;
    const npcSellBack = await market.sellToNpcMerchant({
      commandId: "s07-cde:npc:sell-ore",
      principal: pBuyer,
      characterId: buyer.id,
      merchantCode: "valewatch_quartermaster",
      offerCode: "buyback_iron_ore_treasury",
      stackId: buyerOreStack.id,
      quantity: 5,
    });
    assert.equal(npcSellBack.data.payoutReceived, 60n); // Paid out of Valewatch treasury (zero minting!)

    // Exceeding NPC stock or daily buyback cap fails cleanly
    await assert.rejects(
      () =>
        market.buyFromNpcMerchant({
          commandId: "s07-cde:npc:exceed-stock",
          principal: pBuyer,
          characterId: buyer.id,
          merchantCode: "valewatch_quartermaster",
          offerCode: "sell_medicinal_herb_limited",
          quantity: 999,
        }),
      NpcMerchantOperationError,
    );

    // Damage shield durability then repair at Ironfang Master Anvil (splits cost 50% treasury / 50% system_sink!)
    await invEngine.applyDurabilityLoss({
      commandId: "s07-cde:dmg-shield",
      principal: SYSTEM_AUTH,
      characterId: buyer.id,
      itemInstanceId: shieldForSale.id,
      durabilityLoss: 20,
      causeReference: "combat:siege-01",
    });
    const repaired = await market.repairEquipmentAtNpc({
      commandId: "s07-cde:npc:repair-shield",
      principal: pBuyer,
      characterId: buyer.id,
      merchantCode: "ironfang_master_anvil",
      offerCode: "service_equipment_repair",
      itemInstanceId: shieldForSale.id,
    });
    assert.equal(repaired.data.totalCost, 100n); // 20 * 5
    assert.equal(repaired.data.repairedItem.currentDurability, 160);

    // =========================================================================
    // STAGE D — Individual Boss Loot, Anti-Bad-Luck Fragments, World Contributions & Criminal Bounties
    // =========================================================================
    const lootSeller = (
      await lootBounty.grantAuthoritativeBossLoot({
        rewardEventId: "s07-cde:boss:warlord-kill-1:seller",
        principal: SYSTEM_AUTH,
        sourceEntityId: "boss-kill:warlord-001",
        characterId: seller.id,
        lootTableCode: "boss_crimson_warlord",
        eligibilityReference: "neon:kill-proof:warlord-001",
        serverEntropySecret: "server-secret-entropy-2026",
      })
    ).data;
    const lootBuyer = (
      await lootBounty.grantAuthoritativeBossLoot({
        rewardEventId: "s07-cde:boss:warlord-kill-1:buyer",
        principal: SYSTEM_AUTH,
        sourceEntityId: "boss-kill:warlord-001",
        characterId: buyer.id,
        lootTableCode: "boss_crimson_warlord",
        eligibilityReference: "neon:kill-proof:warlord-001",
        serverEntropySecret: "server-secret-entropy-2026",
      })
    ).data;
    // Independent seeds per character + idempotent retry returns identical grant without re-rolling!
    assert.notEqual(lootSeller.generationSeedHash, lootBuyer.generationSeedHash);
    const lootBuyerRetry = await lootBounty.grantAuthoritativeBossLoot({
      rewardEventId: "s07-cde:boss:warlord-kill-1:buyer",
      principal: SYSTEM_AUTH,
      sourceEntityId: "boss-kill:warlord-001",
      characterId: buyer.id,
      lootTableCode: "boss_crimson_warlord",
      eligibilityReference: "neon:kill-proof:warlord-001",
      serverEntropySecret: "server-secret-entropy-2026",
    });
    assert.equal(lootBuyerRetry.status, "duplicate_idempotent");
    assert.equal(lootBuyerRetry.data.generationSeedHash, lootBuyer.generationSeedHash);

    // Buyer got 2 fragments from boss kill; grant 4 more -> total 6 -> redeem epic greataxe!
    await lootBounty.grantAntiBadLuckFragments({
      commandId: "s07-cde:frag:grant-4",
      principal: SYSTEM_AUTH,
      characterId: buyer.id,
      fragmentCode: "crimson_warlord_sigil",
      quantity: 4,
      progressReference: "boss-kills:2-3",
    });
    const redeemed = (
      await lootBounty.redeemAntiBadLuckFragments({
        redemptionId: "s07-cde:frag:redeem-1",
        principal: pBuyer,
        characterId: buyer.id,
        fragmentCode: "crimson_warlord_sigil",
        selectedOptionCode: "redeem_crimson_greataxe_epic",
      })
    ).data;
    assert.equal(redeemed.remainingBalance, 0);
    assert.equal(redeemed.rewardGrant.grantedItems[0]?.rarityCode, "epic");
    assert.equal(redeemed.rewardGrant.grantedItems[0]?.bindingState, "character_bound");

    // Second redemption with 0 remaining balance fails!
    await assert.rejects(
      () =>
        lootBounty.redeemAntiBadLuckFragments({
          redemptionId: "s07-cde:frag:redeem-insufficient",
          principal: pBuyer,
          characterId: buyer.id,
          fragmentCode: "crimson_warlord_sigil",
          selectedOptionCode: "redeem_crimson_greataxe_epic",
        }),
      LootOrRewardInvalidError,
    );

    // World Event Contribution Reward: link NEON player_id -> buyer.id and reward support+objective healer!
    await socialEngine.linkExternalIdentity({
      commandId: "s07-cde:link:lyra",
      principal: SYSTEM_AUTH,
      sourceNamespace: "neon_player",
      externalSubjectId: "neon-player-lyra",
      characterId: buyer.id,
    });
    await contribService.record({
      contract_version: 1,
      event_id: "sim:s7:inv:vw:lyra",
      simulation_id: "sim-s7",
      invasion_id: "inv-vw-07",
      settlement_id: "settlement-valewatch",
      tick: "500",
      player_id: "neon-player-lyra",
      damage: "0", // Zero damage, pure support + objectives!
      support: "350",
      objectives: "4",
      eligible: true,
      outcome: "Defended",
    });
    const contribRew = (
      await lootBounty.grantContributionEconomicReward({
        commandId: "s07-cde:contrib-rew:lyra",
        principal: SYSTEM_AUTH,
        contributionEventId: "sim:s7:inv:vw:lyra",
        serverEntropySecret: "server-secret-entropy-2026",
      })
    ).data;
    assert.ok(contribRew.commendationMinted > 0n);
    assert.ok(contribRew.coinStipendMinted > 0n);

    // Criminal Bounties (Section 24):
    // 1. Outlaw commits confirmed major crime in Ashvale -> becomes Wanted
    const crime = (
      await socialEngine.recordAuthoritativeCrime({
        commandId: "s07-cde:crime:outlaw",
        principal: SYSTEM_AUTH,
        offenderCharacterId: outlaw.id,
        offenseCode: "Robbery",
        jurisdictionId: "jur-ashvale-civic",
        severity: "major",
        confirmationLevel: "confirmed",
        evidenceReference: "patrol-witness-07",
      })
    ).data.crimeRecord!;

    // 2. Simulate a legacy unverified `escrow_committed` bounty row (reservation_id = NULL) and prove it is REJECTED on settlement!
    const legacyBountyId = randomUUID();
    await pgCtx.pool.query(
      `INSERT INTO criminal_bounties (
         id, target_character_id, issuing_authority_id, jurisdiction_id,
         warrant_id, source_crime_id, reward_amount, currency_code,
         funding_status, funding_reference, status, rules_version, version
       )
       VALUES ($1::uuid, $2::uuid, 'legacy-issuer', 'jur-ashvale-civic', NULL, $3::uuid, 500, 'ascendra_coin', 'escrow_committed', 'legacy_text_only_ref', 'Active', 1, 1)`,
      [legacyBountyId, outlaw.id, crime.id],
    );
    await assert.rejects(
      () =>
        lootBounty.claimAndSettleVerifiedCriminalBounty({
          commandId: "s07-cde:bounty:reject-legacy",
          principal: SYSTEM_AUTH,
          bountyId: legacyBountyId,
          claimantCharacterId: buyer.id,
          resolutionKind: "confirmed_capture",
          authorityConfirmationRef: "auth-cap-legacy",
        }),
      EscrowReservationStateError,
    );

    // 3. Create Draft bounty, reserve real 800-coin escrow from Seller, fund & activate bounty, then settle claim to Buyer (while racing Seller trying a competing claim)!
    const draftBounty = (
      await socialEngine.createCriminalBounty({
        commandId: "s07-cde:bounty:draft",
        principal: SYSTEM_AUTH,
        targetCharacterId: outlaw.id,
        issuingAuthorityId: "ashvale-magistrate",
        jurisdictionId: "jur-ashvale-civic",
        sourceCrimeId: crime.id,
        rewardAmount: "800",
        currencyCode: "ascendra_coin",
        fundingStatus: "planned_unfunded",
        desiredStatus: "Draft",
      })
    ).data;

    const bountyResv = (
      await monetary.reserveFunds({
        commandId: "s07-cde:bounty:reserve-800",
        principal: pSeller,
        characterId: seller.id,
        currencyCode: "ascendra_coin",
        amount: 800n,
        purpose: "criminal_bounty",
        referenceId: draftBounty.id,
      })
    ).data;

    const fundedBounty = (
      await lootBounty.fundDraftCriminalBountyWithEscrow({
        commandId: "s07-cde:bounty:fund",
        principal: pSeller,
        bountyId: draftBounty.id,
        reservationId: bountyResv.id,
        issuerCharacterId: seller.id,
      })
    ).data;
    assert.equal(fundedBounty.status, "Active");
    assert.equal(fundedBounty.fundingStatus, "escrow_committed");

    // Self-claim by Outlaw rejected!
    await assert.rejects(
      () =>
        lootBounty.claimAndSettleVerifiedCriminalBounty({
          commandId: "s07-cde:bounty:self-claim",
          principal: SYSTEM_AUTH,
          bountyId: fundedBounty.id,
          claimantCharacterId: outlaw.id,
          resolutionKind: "authorized_defeat",
          authorityConfirmationRef: "self-attempt",
        }),
      CriminalBountyInvalidError,
    );

    const buyerBeforeBounty = (await econRepo.getPlayerWallet(buyer.id))!.balance;
    const [claimHunter1, claimHunter2] = await Promise.allSettled([
      lootBounty.claimAndSettleVerifiedCriminalBounty({
        commandId: "s07-cde:bounty:settle-buyer",
        principal: SYSTEM_AUTH,
        bountyId: fundedBounty.id,
        claimantCharacterId: buyer.id,
        resolutionKind: "confirmed_capture",
        authorityConfirmationRef: "capture-vane-001",
      }),
      lootBounty.claimAndSettleVerifiedCriminalBounty({
        commandId: "s07-cde:bounty:settle-seller",
        principal: SYSTEM_AUTH,
        bountyId: fundedBounty.id,
        claimantCharacterId: seller.id,
        resolutionKind: "confirmed_capture",
        authorityConfirmationRef: "capture-vane-002",
      }),
    ]);
    assert.equal([claimHunter1, claimHunter2].filter((r) => r.status === "fulfilled").length, 1);
    assert.equal([claimHunter1, claimHunter2].filter((r) => r.status === "rejected").length, 1);
    if (claimHunter1.status === "fulfilled") {
      const buyerAfterBounty = (await econRepo.getPlayerWallet(buyer.id))!.balance;
      assert.equal(buyerAfterBounty - buyerBeforeBounty, 800n);
    }

    // =========================================================================
    // STAGE E — Crafting Engine, Blacksmithing Mastery, Provenance & Economic Titles
    // =========================================================================
    // Grant materials to Seller for blacksmithing
    await invEngine.grantStackableMaterial({
      grantId: "s07-cde:craft-mat:ore",
      principal: SYSTEM_AUTH,
      recipientCharacterId: seller.id,
      definitionCode: "iron_ore",
      quantity: 50,
      qualityBp: 8000,
      originType: "gathering",
      originReference: "granite-vein",
    });
    await invEngine.grantStackableMaterial({
      grantId: "s07-cde:craft-mat:wood",
      principal: SYSTEM_AUTH,
      recipientCharacterId: seller.id,
      definitionCode: "ancient_wood",
      quantity: 20,
      qualityBp: 7500,
      originType: "gathering",
      originReference: "ashvale-grove",
    });

    // Recipe requiring blacksmithing level 5 (`forge_runic_guardian_cuirass`) fails at level 1 without consuming materials!
    await assert.rejects(
      () =>
        crafting.craftRecipe({
          operationId: "s07-cde:craft:too-low-level",
          principal: pSeller,
          characterId: seller.id,
          recipeCode: "forge_runic_guardian_cuirass",
          stationCode: "station_runic_forge_t2",
          settlementId: valewatch.id,
          serverEntropySecret: "server-secret-entropy-2026",
        }),
      CraftingOrProfessionError,
    );

    // Craft 3 Ironfang Longswords + grant profession XP to reach Blacksmithing Level >= 5 -> unlock `legendary_blacksmith`!
    const craftedSwords: string[] = [];
    for (let c = 0; c < 3; c++) {
      const outcome = await crafting.craftRecipe({
        operationId: `s07-cde:craft:sword:${c}`,
        principal: pSeller,
        characterId: seller.id,
        recipeCode: "forge_ironfang_longsword",
        stationCode: "station_anvil_t1",
        settlementId: valewatch.id,
        serverEntropySecret: "server-secret-entropy-2026",
      });
      const prod = outcome.data.producedItemInstance;
      assert.ok(prod);
      assert.equal(prod.craftedByCharacterId, seller.id);
      assert.equal(prod.craftingRecipeCode, "forge_ironfang_longsword");
      craftedSwords.push(prod.id);
    }

    await crafting.grantProfessionExperience({
      commandId: "s07-cde:prof-xp:boost-l5",
      principal: SYSTEM_AUTH,
      characterId: seller.id,
      professionCode: "blacksmithing",
      experienceAmount: 600n,
      sourceReference: "guild-commission",
    });

    const unlockedSmithTitle = await socialEngine.evaluateAndUnlockTitle({
      commandId: "s07-cde:title:legendary-blacksmith",
      principal: SYSTEM_AUTH,
      characterId: seller.id,
      titleCode: "legendary_blacksmith",
    });
    assert.equal(unlockedSmithTitle.data.state, "active");

    // Anti-Wash-Trading check on `imperial_merchant`:
    // Have `sellerAlt` sell 3 items to `seller` (SAME account!) for 3,000 total gross volume -> 0 distinct-account sales -> MUST REJECT `imperial_merchant`!
    for (let w = 0; w < 3; w++) {
      const altItem = (
        await invEngine.grantProceduralEquipment({
          grantId: `s07-cde:alt-item:${w}`,
          principal: SYSTEM_AUTH,
          recipientCharacterId: sellerAlt.id,
          definitionCode: "explorer_strider_boots",
          rarityCode: "common",
          originType: "dev_authorized",
          originReference: "wash-test",
        })
      ).data;
      const wList = (
        await market.createMarketListing({
          commandId: `s07-cde:wash:alt-list-${w}`,
          principal: pSeller,
          sellerCharacterId: sellerAlt.id,
          settlementId: valewatch.id,
          itemInstanceId: altItem.id,
          unitPrice: 1000n,
        })
      ).data;
      await market.buyMarketListing({
        commandId: `s07-cde:wash:alt-buy-${w}`,
        principal: pSeller,
        buyerCharacterId: seller.id,
        listingId: wList.id,
      });
    }
    await assert.rejects(
      () =>
        socialEngine.evaluateAndUnlockTitle({
          commandId: "s07-cde:title:wash-merchant-fail",
          principal: SYSTEM_AUTH,
          characterId: sellerAlt.id,
          titleCode: "imperial_merchant",
        }),
      TitleConditionInvalidError,
    );

    // Crafting rollback check: if a fault occurs before commit, ZERO materials and ZERO currency are deducted!
    const preFaultWallet = (await econRepo.getPlayerWallet(seller.id))!.balance;
    const preFaultStacks = await invRepo.listCharacterStacks(seller.id);
    const preFaultOre = preFaultStacks
      .filter((s) => s.definitionCode === "iron_ore")
      .reduce((a, b) => a + b.quantity, 0);
    const faultyCrafting = new CraftingAndProfessionService({
      pool: pgCtx.pool,
      logger: silentLogger,
      beforeCommitHook: async () => {
        throw new Error("INJECTED_CRAFT_FAULT_BEFORE_COMMIT");
      },
    });
    await assert.rejects(
      () =>
        faultyCrafting.craftRecipe({
          operationId: "s07-cde:craft:fault-rollback",
          principal: pSeller,
          characterId: seller.id,
          recipeCode: "forge_ironfang_longsword",
          stationCode: "station_anvil_t1",
          settlementId: valewatch.id,
          serverEntropySecret: "server-secret-entropy-2026",
        }),
      /INJECTED_CRAFT_FAULT_BEFORE_COMMIT/,
    );
    const postFaultWallet = (await econRepo.getPlayerWallet(seller.id))!.balance;
    const postFaultOre = (await invRepo.listCharacterStacks(seller.id))
      .filter((s) => s.definitionCode === "iron_ore")
      .reduce((a, b) => a + b.quantity, 0);
    assert.equal(postFaultWallet, preFaultWallet);
    assert.equal(postFaultOre, preFaultOre);

    // Now sell the 3 crafted swords from `seller` to `buyer` (DIFFERENT account!) -> guarantees >= 3 distinct-account sales & >= 2,000 volume -> unlocks `imperial_merchant`!
    for (let idx = 0; idx < 3; idx++) {
      const l = (
        await market.createMarketListing({
          commandId: `s07-cde:real:list-${idx}`,
          principal: pSeller,
          sellerCharacterId: seller.id,
          settlementId: valewatch.id,
          itemInstanceId: craftedSwords[idx]!,
          unitPrice: 700n,
        })
      ).data;
      await market.buyMarketListing({
        commandId: `s07-cde:real:buy-${idx}`,
        principal: pBuyer,
        buyerCharacterId: buyer.id,
        listingId: l.id,
      });
    }
    const unlockedMerchantTitle = await socialEngine.evaluateAndUnlockTitle({
      commandId: "s07-cde:title:imperial-merchant-ok",
      principal: SYSTEM_AUTH,
      characterId: seller.id,
      titleCode: "imperial_merchant",
    });
    assert.equal(unlockedMerchantTitle.data.state, "active");

    // =========================================================================
    // STAGE F — Development Simulation Harness + Full Reconciliation + PG Restart Recovery
    // =========================================================================
    const simReport = await runEconomyDevelopmentSimulation(pgCtx.pool, {
      characterCount: 4,
      transfersCount: 8,
      craftsCount: 4,
      marketSalesCount: 3,
      settlementId: valewatch.id,
    });
    assert.equal(simReport.isLedgerReconciled, true);
    assert.ok(simReport.craftedItemsCount >= 7);

    // Restart PostgreSQL server & verify 100% durable ledger/inventory/market/bounty/crafting state!
    const restartedPool = await pgCtx.restartAndReconnect();
    const postRestartRepo = new PostgresEconomyRepository(restartedPool);
    const obsAfterRestart = await postRestartRepo.getEconomicObservabilityReport();
    for (const cRec of obsAfterRestart.currencies) {
      assert.equal(
        cRec.isBalanced,
        true,
        `Currency '${cRec.currencyCode}' failed reconciliation after PostgreSQL restart!`,
      );
    }
    assert.equal(obsAfterRestart.settledBountyClaimsCount, 1);
  });
});
