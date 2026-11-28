import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CharacterEngineService } from "../modules/characters/application/character-engine-service.js";
import type { AuthorityPrincipal } from "../modules/characters/domain/character.js";
import {
  GenesisTemporaryStatePersistenceForbiddenError,
} from "../modules/characters/domain/errors.js";
import {
  PostgresCharacterRepository,
  PostgresCharacterUnitOfWork,
} from "../modules/characters/infrastructure/postgres-character-unit-of-work.js";
import { CraftingAndProfessionService } from "../modules/economy/application/crafting-and-profession-service.js";
import { LootFragmentsAndBountyService } from "../modules/economy/application/loot-fragments-and-bounty-service.js";
import { MonetaryAndEscrowService } from "../modules/economy/application/monetary-and-escrow-service.js";
import { PlayerTradingService } from "../modules/economy/application/player-trading-service.js";
import { RegionalMarketAndMerchantService } from "../modules/economy/application/regional-market-and-merchant-service.js";
import { InsufficientFundsError } from "../modules/economy/domain/errors.js";
import { PostgresEconomyRepository } from "../modules/economy/infrastructure/postgres-economy-unit-of-work.js";
import { runEconomyDevelopmentSimulation } from "../modules/economy/simulation/economy-simulator.js";
import { InventoryEngineService } from "../modules/inventory/application/inventory-engine-service.js";
import { PostgresInventoryRepository } from "../modules/inventory/infrastructure/postgres-inventory-unit-of-work.js";
import { PostgresCatalogRepository } from "../modules/peoples/infrastructure/postgres-catalog-repository.js";
import { SocialEngineService } from "../modules/social/application/social-engine-service.js";
import { PostgresSocialRepository } from "../modules/social/infrastructure/postgres-social-unit-of-work.js";
import { migrateUp } from "../shared/db/migrator.js";
import { StructuredLogger } from "../shared/observability/logger.js";
import { startPostgresTestContext } from "../../tests/helpers/postgres-test-harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

async function runSession07Demo(): Promise<void> {
  const logger = new StructuredLogger("info");
  logger.info("Starting CARBON Session 07 headless economy, trading, market, loot & crafting demo", {
    operation: "demo07:start",
    deferred_future_scope: [
      "buy_orders_and_auctions",
      "real_time_gathering_mining_farming",
      "genesis_ranked_match_runtime",
      "live_neon_boss_transport_worker",
    ],
  });

  // Step 1: Initialize isolated PostgreSQL context
  const pgCtx = await startPostgresTestContext();
  try {
    // Step 2: Apply migrations 0001..0015 & seed versioned catalogs
    const applied = await migrateUp(pgCtx.pool, MIGRATIONS_DIR);
    await new PostgresCatalogRepository(pgCtx.pool).seedInitialCatalogs();
    const charRepo = new PostgresCharacterRepository(pgCtx.pool);
    await charRepo.seedProgressionRules();
    const invRepo = new PostgresInventoryRepository(pgCtx.pool);
    await invRepo.seedInitialItemCatalogs();
    const socialRepo = new PostgresSocialRepository(pgCtx.pool);
    await socialRepo.seedInitialSocialCatalogs();
    const econRepo = new PostgresEconomyRepository(pgCtx.pool);
    await econRepo.seedInitialEconomyCatalogs();
    logger.info("Step 2: Migrations 0001..0015 & Economy catalogs ready", {
      operation: "demo07:migrate",
      migrations_count: applied.length,
    });

    const sysAuth: AuthorityPrincipal = {
      kind: "internal_system_authority",
      actorId: "demo07-authority",
    };
    const charEngine = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(pgCtx.pool),
      logger,
    });
    const invEngine = new InventoryEngineService({ pool: pgCtx.pool, logger });
    const socialEngine = new SocialEngineService({ pool: pgCtx.pool, logger });
    const monetary = new MonetaryAndEscrowService({ pool: pgCtx.pool, logger });
    const trading = new PlayerTradingService({ pool: pgCtx.pool, logger });
    const market = new RegionalMarketAndMerchantService({ pool: pgCtx.pool, logger });
    const lootBounty = new LootFragmentsAndBountyService({ pool: pgCtx.pool, logger });
    const crafting = new CraftingAndProfessionService({ pool: pgCtx.pool, logger });

    // Step 3: Create three characters
    const acc1 = await charRepo.createAccount({ id: randomUUID(), externalSubject: "demo07-acc-1" });
    const acc2 = await charRepo.createAccount({ id: randomUUID(), externalSubject: "demo07-acc-2" });
    const acc3 = await charRepo.createAccount({ id: randomUUID(), externalSubject: "demo07-acc-3" });
    const p1: AuthorityPrincipal = { kind: "authenticated_account", accountId: acc1.id };
    const p2: AuthorityPrincipal = { kind: "authenticated_account", accountId: acc2.id };
    const p3: AuthorityPrincipal = { kind: "authenticated_account", accountId: acc3.id };

    const app = {
      bodyPreset: "athletic_a",
      skinTone: "olive_bronze",
      hairStyle: "short_cropped",
      hairColor: "raven_black",
      eyeStyle: "almond_sharp",
      eyeColor: "slate_blue",
      earStyle: "rounded_standard",
    };

    const aldric = (
      await charEngine.createCharacter({
        commandId: "demo07:char:aldric",
        principal: p1,
        accountId: acc1.id,
        characterName: "Aldric Forjador",
        raceCode: "humans",
        lineageCode: "human_frontier",
        cultureCode: "valewatch_civic",
        backgroundCode: "veteran_soldier",
        originRegionId: "region-ashvale",
        presetCode: "berserker",
        appearance: app,
      })
    ).data;
    const brynja = (
      await charEngine.createCharacter({
        commandId: "demo07:char:brynja",
        principal: p2,
        accountId: acc2.id,
        characterName: "Brynja Caçadora",
        raceCode: "humans",
        lineageCode: "human_frontier",
        cultureCode: "valewatch_civic",
        backgroundCode: "veteran_soldier",
        originRegionId: "granite-peaks",
        presetCode: "berserker",
        appearance: app,
      })
    ).data;
    const vane = (
      await charEngine.createCharacter({
        commandId: "demo07:char:vane",
        principal: p3,
        accountId: acc3.id,
        characterName: "Vane Sombra",
        raceCode: "humans",
        lineageCode: "human_frontier",
        cultureCode: "valewatch_civic",
        backgroundCode: "veteran_soldier",
        originRegionId: "region-thornreach",
        presetCode: "berserker",
        appearance: app,
      })
    ).data;

    // Step 4: Provision wallets
    const wAldric = (
      await monetary.ensurePlayerWallet({
        commandId: "demo07:wallet:aldric",
        principal: p1,
        characterId: aldric.id,
      })
    ).data;
    const wBrynja = (
      await monetary.ensurePlayerWallet({
        commandId: "demo07:wallet:brynja",
        principal: p2,
        characterId: brynja.id,
      })
    ).data;
    await monetary.ensurePlayerWallet({
      commandId: "demo07:wallet:vane",
      principal: p3,
      characterId: vane.id,
    });

    // Step 5: Mint authorized currency
    await monetary.mintAuthorizedCurrency({
      commandId: "demo07:mint:aldric",
      principal: sysAuth,
      recipientCharacterId: aldric.id,
      currencyCode: "ascendra_coin",
      amount: 4_000n,
      sourceCategory: "quest_reward",
      sourceReference: "quest:ashvale-convoy",
    });
    await monetary.mintAuthorizedCurrency({
      commandId: "demo07:mint:brynja",
      principal: sysAuth,
      recipientCharacterId: brynja.id,
      currencyCode: "ascendra_coin",
      amount: 3_500n,
      sourceCategory: "quest_reward",
      sourceReference: "quest:granite-escort",
    });

    // Step 6 & 7: Transfer money & query paginated double-entry ledger
    await monetary.transferCurrencyBetweenCharacters({
      commandId: "demo07:xfer:aldric-to-brynja",
      principal: p1,
      fromCharacterId: aldric.id,
      toCharacterId: brynja.id,
      currencyCode: "ascendra_coin",
      amount: 500n,
      reason: "Expedition share",
    });
    const aldricEntries = await econRepo.queryLedgerEntries({
      walletId: wAldric.id,
      limit: 10,
    });
    assert.equal(aldricEntries.length, 2);

    // Step 8: Grant stackable materials & equipment
    const oreGrant = (
      await invEngine.grantStackableMaterial({
        grantId: "demo07:grant:ore-brynja",
        principal: sysAuth,
        recipientCharacterId: brynja.id,
        definitionCode: "iron_ore",
        quantity: 25,
        qualityBp: 7800,
        originType: "gathering",
        originReference: "vein:granite-01",
      })
    ).data;
    await invEngine.grantStackableMaterial({
      grantId: "demo07:grant:wood-aldric",
      principal: sysAuth,
      recipientCharacterId: aldric.id,
      definitionCode: "ancient_wood",
      quantity: 10,
      qualityBp: 7200,
      originType: "gathering",
      originReference: "grove:ashvale-01",
    });
    const daggerAldric = (
      await invEngine.grantProceduralEquipment({
        grantId: "demo07:grant:dagger-aldric",
        principal: sysAuth,
        recipientCharacterId: aldric.id,
        definitionCode: "thornveil_dagger",
        rarityCode: "rare",
        originType: "dungeon_reward",
        originReference: "crypt:ashvale-01",
      })
    ).data;

    // Step 9: Reserve standalone currency & release cleanly
    const tempResv = (
      await monetary.reserveFunds({
        commandId: "demo07:resv:standalone",
        principal: p1,
        characterId: aldric.id,
        currencyCode: "ascendra_coin",
        amount: 250n,
        purpose: "service_hold",
        referenceId: "demo-hold-01",
      })
    ).data;
    await monetary.releaseReservation({
      commandId: "demo07:resv:release",
      principal: p1,
      reservationId: tempResv.id,
      reason: "demo hold released",
    });

    // Step 10 & 11: Reserve equipment & execute bilateral atomic player trade
    const trade = (
      await trading.initiateTrade({
        commandId: "demo07:trade:init",
        principal: p1,
        initiatorCharacterId: aldric.id,
        counterpartyCharacterId: brynja.id,
      })
    ).data;
    await trading.acceptTrade({
      commandId: "demo07:trade:accept",
      principal: p2,
      tradeId: trade.id,
      participantCharacterId: brynja.id,
    });
    await trading.setTradeParticipantOffer({
      commandId: "demo07:trade:offer-aldric",
      principal: p1,
      tradeId: trade.id,
      participantCharacterId: aldric.id,
      currencyAmount: 200n,
      itemInstanceIds: [daggerAldric.id],
      materialStacks: [],
    });
    const tradeReady = (
      await trading.setTradeParticipantOffer({
        commandId: "demo07:trade:offer-brynja",
        principal: p2,
        tradeId: trade.id,
        participantCharacterId: brynja.id,
        currencyAmount: 0n,
        itemInstanceIds: [],
        materialStacks: [{ stackId: oreGrant[0]!.id, quantity: 15 }],
      })
    ).data;
    await trading.confirmTradeOffer({
      commandId: "demo07:trade:conf-aldric",
      principal: p1,
      tradeId: trade.id,
      participantCharacterId: aldric.id,
      expectedOfferVersion: tradeReady.offerVersion,
    });
    const completedTrade = (
      await trading.confirmTradeOffer({
        commandId: "demo07:trade:conf-brynja",
        principal: p2,
        tradeId: trade.id,
        participantCharacterId: brynja.id,
        expectedOfferVersion: tradeReady.offerVersion,
      })
    ).data;
    assert.equal(completedTrade.status, "Completed");

    // Step 19 & 20: Craft equipment & verify crafter provenance (then sell crafted item on regional market!)
    const craftedOutcome = (
      await crafting.craftRecipe({
        operationId: "demo07:craft:ironfang-sword",
        principal: p1,
        characterId: aldric.id,
        recipeCode: "forge_ironfang_longsword",
        stationCode: "station_anvil_t1",
        serverEntropySecret: "demo07-server-entropy-secret",
      })
    ).data;
    const craftedSword = craftedOutcome.producedItemInstance!;
    assert.equal(craftedSword.craftedByCharacterId, aldric.id);
    assert.equal(craftedSword.originType, "crafting");

    // Step 12, 13, 14 & 15: Regional market listing (1,000 coins), purchase, 5% regional tax, & settlement treasury check
    const valewatch = (await socialRepo.findSettlementByExternalId("settlement-valewatch"))!;
    const listing = (
      await market.createMarketListing({
        commandId: "demo07:market:list-sword",
        principal: p1,
        sellerCharacterId: aldric.id,
        settlementId: valewatch.id,
        itemInstanceId: craftedSword.id,
        unitPrice: 1_000n,
      })
    ).data;
    const saleResult = (
      await market.buyMarketListing({
        commandId: "demo07:market:buy-sword",
        principal: p2,
        buyerCharacterId: brynja.id,
        listingId: listing.id,
      })
    ).data;
    const vwTreasury = (await econRepo.getSettlementTreasury(valewatch.id))!;
    assert.equal(saleResult.sale.treasuryTaxAmount, 50n);
    assert.equal(vwTreasury.balance, 60n); // 10 listing fee + 50 sale tax

    // Step 16, 17 & 18: Authoritative individual boss loot + anti-bad-luck fragments + redemption
    const bossDrop = (
      await lootBounty.grantAuthoritativeBossLoot({
        rewardEventId: "demo07:boss:warlord:brynja",
        principal: sysAuth,
        sourceEntityId: "boss-kill:crimson-warlord-demo",
        characterId: brynja.id,
        lootTableCode: "boss_crimson_warlord",
        eligibilityReference: "dev-fixture:boss-kill-verified",
        serverEntropySecret: "demo07-server-entropy-secret",
      })
    ).data;
    await lootBounty.grantAntiBadLuckFragments({
      commandId: "demo07:frag:topup-4",
      principal: sysAuth,
      characterId: brynja.id,
      fragmentCode: "crimson_warlord_sigil",
      quantity: 4,
      progressReference: "dev-fixture:warlord-clears-2-3",
    });
    const fragRedeemed = (
      await lootBounty.redeemAntiBadLuckFragments({
        redemptionId: "demo07:frag:redeem-epic-axe",
        principal: p2,
        characterId: brynja.id,
        fragmentCode: "crimson_warlord_sigil",
        selectedOptionCode: "redeem_crimson_greataxe_epic",
      })
    ).data;
    assert.equal(fragRedeemed.remainingBalance, 0);

    // Step 21 & 22: Fund real criminal bounty via verified monetary escrow & settle authorized capture
    const crime = (
      await socialEngine.recordAuthoritativeCrime({
        commandId: "demo07:crime:vane-robbery",
        principal: sysAuth,
        offenderCharacterId: vane.id,
        offenseCode: "Robbery",
        jurisdictionId: "jur-ashvale-civic",
        severity: "major",
        confirmationLevel: "confirmed",
        evidenceReference: "demo07:witness-log",
      })
    ).data.crimeRecord!;
    const draftBounty = (
      await socialEngine.createCriminalBounty({
        commandId: "demo07:bounty:draft",
        principal: sysAuth,
        targetCharacterId: vane.id,
        issuingAuthorityId: "ashvale-magistrate",
        jurisdictionId: "jur-ashvale-civic",
        sourceCrimeId: crime.id,
        rewardAmount: "600",
        currencyCode: "ascendra_coin",
        fundingStatus: "planned_unfunded",
        desiredStatus: "Draft",
      })
    ).data;
    const bountyEscrow = (
      await monetary.reserveFunds({
        commandId: "demo07:bounty:escrow-600",
        principal: p1,
        characterId: aldric.id,
        currencyCode: "ascendra_coin",
        amount: 600n,
        purpose: "criminal_bounty",
        referenceId: draftBounty.id,
      })
    ).data;
    await lootBounty.fundDraftCriminalBountyWithEscrow({
      commandId: "demo07:bounty:activate",
      principal: p1,
      bountyId: draftBounty.id,
      reservationId: bountyEscrow.id,
      issuerCharacterId: aldric.id,
    });
    const settledBounty = (
      await lootBounty.claimAndSettleVerifiedCriminalBounty({
        commandId: "demo07:bounty:settle",
        principal: sysAuth,
        bountyId: draftBounty.id,
        claimantCharacterId: brynja.id,
        resolutionKind: "confirmed_capture",
        authorityConfirmationRef: "demo07:capture-confirmed",
      })
    ).data;
    assert.equal(settledBounty.bounty.status, "Fulfilled");

    // Step 23: Reject overdraft without sufficient balance
    await assert.rejects(
      () =>
        monetary.transferCurrencyBetweenCharacters({
          commandId: "demo07:reject:overdraft",
          principal: p3,
          fromCharacterId: vane.id,
          toCharacterId: aldric.id,
          currencyCode: "ascendra_coin",
          amount: 100n,
          reason: "vane has 0 balance",
        }),
      InsufficientFundsError,
    );

    // Step 24: Accounting reconciliation & development simulation harness
    const simResult = await runEconomyDevelopmentSimulation(pgCtx.pool, {
      characterCount: 3,
      transfersCount: 6,
      craftsCount: 3,
      marketSalesCount: 2,
      settlementId: valewatch.id,
    });
    const preRestartRec = await econRepo.reconcileCurrency("ascendra_coin");
    assert.equal(preRestartRec.isBalanced, true);

    // Step 25: Reject Genesis temporary ranked economy persistence
    await assert.rejects(
      () =>
        monetary.transferCurrencyBetweenCharacters({
          commandId: "demo07:reject:genesis",
          principal: p1,
          fromCharacterId: aldric.id,
          toCharacterId: brynja.id,
          currencyCode: "ascendra_coin",
          amount: 10n,
          reason: "genesis forbidden",
          executionProfile: "genesis_ranked_md3_scratch",
        }),
      GenesisTemporaryStatePersistenceForbiddenError,
    );

    // Step 26 & 27: Restart/reconnect PostgreSQL & confirm 100% durable recovery
    const recoveredPool = await pgCtx.restartAndReconnect();
    const recoveredEcon = new PostgresEconomyRepository(recoveredPool);
    const postRestartObs = await recoveredEcon.getEconomicObservabilityReport();
    const postRestartCoin = postRestartObs.currencies.find(
      (c) => c.currencyCode === "ascendra_coin",
    )!;
    assert.equal(postRestartCoin.isBalanced, true);
    const brynjaWalletAfter = await recoveredEcon.getPlayerWallet(brynja.id, "ascendra_coin");
    assert.ok(brynjaWalletAfter && brynjaWalletAfter.balance > 0n);

    logger.info("Step 27: Persistent recovery of Wallets, Double-Entry Ledger, Market Sales, Treasuries, Loot, Fragments, Bounties & Crafted Provenance confirmed", {
      operation: "demo07:complete",
      result: "ok",
      embedded_postgres_restarted: pgCtx.isEmbedded,
      ascendra_coin_reconciled: postRestartCoin.isBalanced,
      total_minted: postRestartCoin.totalMinted.toString(),
      total_destroyed: postRestartCoin.totalDestroyed.toString(),
      circulating_supply: postRestartCoin.actualCirculatingSupply.toString(),
      brynja_wallet_id: wBrynja.id,
      brynja_boss_seed_hash: bossDrop.generationSeedHash,
      crafted_sword_crafter_id: craftedSword.craftedByCharacterId,
      simulation_elapsed_ms: simResult.elapsedMs,
    });
  } finally {
    await pgCtx.stop();
  }
}

runSession07Demo().catch((err: unknown) => {
  process.stderr.write(`Demo Session 07 failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
