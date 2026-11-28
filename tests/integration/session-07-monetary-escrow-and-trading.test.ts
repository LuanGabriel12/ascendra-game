import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CharacterEngineService } from "../../src/modules/characters/application/character-engine-service.js";
import type { AuthorityPrincipal } from "../../src/modules/characters/domain/character.js";
import {
  GenesisTemporaryStatePersistenceForbiddenError,
} from "../../src/modules/characters/domain/errors.js";
import {
  PostgresCharacterRepository,
  PostgresCharacterUnitOfWork,
} from "../../src/modules/characters/infrastructure/postgres-character-unit-of-work.js";
import { MonetaryAndEscrowService } from "../../src/modules/economy/application/monetary-and-escrow-service.js";
import { PlayerTradingService } from "../../src/modules/economy/application/player-trading-service.js";
import {
  CurrencyNotFoundOrDisabledError,
  CurrencyOperationForbiddenError,
  EscrowReservationStateError,
  InsufficientFundsError,
  PlayerTradeInvalidStateError,
} from "../../src/modules/economy/domain/errors.js";
import { PostgresEconomyRepository } from "../../src/modules/economy/infrastructure/postgres-economy-unit-of-work.js";
import { InventoryEngineService } from "../../src/modules/inventory/application/inventory-engine-service.js";
import {
  InventoryCapacityExceededError,
  ItemBindingViolationError,
  LoadoutInvalidError,
} from "../../src/modules/inventory/domain/errors.js";
import { PostgresInventoryRepository } from "../../src/modules/inventory/infrastructure/postgres-inventory-unit-of-work.js";
import { PostgresCatalogRepository } from "../../src/modules/peoples/infrastructure/postgres-catalog-repository.js";
import { migrateDown, migrateUp } from "../../src/shared/db/migrator.js";
import { InboxIdempotencyConflictError } from "../../src/shared/db/processed-events-inbox.js";
import { StructuredLogger } from "../../src/shared/observability/logger.js";
import {
  startPostgresTestContext,
  type RunningPostgresTestContext,
} from "../helpers/postgres-test-harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

const SYSTEM_AUTH: AuthorityPrincipal = {
  kind: "internal_system_authority",
  actorId: "test-economy-s07",
};

describe("CARBON Session 07 (Stages A & B) — Monetary Ledger, Escrow Reservations & Atomic Player Trading (Real PostgreSQL)", () => {
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

  it("validates 0013 migration backfill/down/up, double-entry mint/transfer/sink/compensation, ledger immutability, escrow concurrency, and atomic bilateral player trading", async () => {
    await migrateUp(pgCtx.pool, MIGRATIONS_DIR);
    // Verify clean rollback & re-apply of 0013+
    await migrateDown(pgCtx.pool, MIGRATIONS_DIR, 1);
    await migrateUp(pgCtx.pool, MIGRATIONS_DIR);

    const catalogRepo = new PostgresCatalogRepository(pgCtx.pool);
    await catalogRepo.seedInitialCatalogs();
    const invRepo = new PostgresInventoryRepository(pgCtx.pool);
    await invRepo.seedInitialItemCatalogs();
    const econRepo = new PostgresEconomyRepository(pgCtx.pool);
    await econRepo.seedInitialEconomyCatalogs();

    const charRepo = new PostgresCharacterRepository(pgCtx.pool);
    await charRepo.seedProgressionRules();
    const charEngine = new CharacterEngineService({
      unitOfWork: new PostgresCharacterUnitOfWork(pgCtx.pool),
      logger: silentLogger,
    });
    const invEngine = new InventoryEngineService({ pool: pgCtx.pool, logger: silentLogger });
    const monetary = new MonetaryAndEscrowService({ pool: pgCtx.pool, logger: silentLogger });
    const trading = new PlayerTradingService({ pool: pgCtx.pool, logger: silentLogger });

    const accA = await charRepo.createAccount({ id: randomUUID(), externalSubject: "s07-acc-a" });
    const accB = await charRepo.createAccount({ id: randomUUID(), externalSubject: "s07-acc-b" });
    const pA: AuthorityPrincipal = { kind: "authenticated_account", accountId: accA.id };
    const pB: AuthorityPrincipal = { kind: "authenticated_account", accountId: accB.id };

    const baseApp = {
      bodyPreset: "athletic_a",
      skinTone: "olive_bronze",
      hairStyle: "short_cropped",
      hairColor: "raven_black",
      eyeStyle: "almond_sharp",
      eyeColor: "slate_blue",
      earStyle: "rounded_standard",
    };

    const charA = (
      await charEngine.createCharacter({
        commandId: "s07-ab:create:a",
        principal: pA,
        accountId: accA.id,
        characterName: "Aldric Mercador",
        raceCode: "humans",
        lineageCode: "human_frontier",
        cultureCode: "valewatch_civic",
        backgroundCode: "veteran_soldier",
        originRegionId: "region-ashvale",
        presetCode: "berserker",
        appearance: baseApp,
      })
    ).data;

    const charB = (
      await charEngine.createCharacter({
        commandId: "s07-ab:create:b",
        principal: pB,
        accountId: accB.id,
        characterName: "Brynja Forjadora",
        raceCode: "humans",
        lineageCode: "human_frontier",
        cultureCode: "valewatch_civic",
        backgroundCode: "veteran_soldier",
        originRegionId: "granite-peaks",
        presetCode: "berserker",
        appearance: baseApp,
      })
    ).data;

    // 1. Player cannot self-mint currency; disabled currency rejected; Genesis profile rejected
    await assert.rejects(
      () =>
        monetary.mintAuthorizedCurrency({
          commandId: "s07-ab:illegal-mint",
          principal: pA,
          recipientCharacterId: charA.id,
          currencyCode: "ascendra_coin",
          amount: 5000n,
          sourceCategory: "boss_reward",
          sourceReference: "fake-boss",
        }),
      CurrencyOperationForbiddenError,
    );

    await assert.rejects(
      () =>
        monetary.mintAuthorizedCurrency({
          commandId: "s07-ab:disabled-curr",
          principal: SYSTEM_AUTH,
          recipientCharacterId: charA.id,
          currencyCode: "ranked_glory_token",
          amount: 100n,
          sourceCategory: "authorized_grant",
          sourceReference: "test",
        }),
      CurrencyNotFoundOrDisabledError,
    );

    await assert.rejects(
      () =>
        monetary.ensurePlayerWallet({
          commandId: "s07-ab:genesis-block",
          principal: pA,
          characterId: charA.id,
          executionProfile: "genesis_ranked_md3_scratch",
        }),
      GenesisTemporaryStatePersistenceForbiddenError,
    );

    // 2. Authorized mint + idempotent retry + conflicting payload detection
    const mintA = await monetary.mintAuthorizedCurrency({
      commandId: "s07-ab:mint:a:1",
      principal: SYSTEM_AUTH,
      recipientCharacterId: charA.id,
      currencyCode: "ascendra_coin",
      amount: 2500n,
      sourceCategory: "quest_reward",
      sourceReference: "quest:ashvale_escort",
    });
    assert.equal(mintA.status, "applied");

    const mintADup = await monetary.mintAuthorizedCurrency({
      commandId: "s07-ab:mint:a:1",
      principal: SYSTEM_AUTH,
      recipientCharacterId: charA.id,
      currencyCode: "ascendra_coin",
      amount: 2500n,
      sourceCategory: "quest_reward",
      sourceReference: "quest:ashvale_escort",
    });
    assert.equal(mintADup.status, "duplicate_idempotent");
    assert.equal(mintADup.data.id, mintA.data.id);

    await assert.rejects(
      () =>
        monetary.mintAuthorizedCurrency({
          commandId: "s07-ab:mint:a:1",
          principal: SYSTEM_AUTH,
          recipientCharacterId: charA.id,
          currencyCode: "ascendra_coin",
          amount: 9999n,
          sourceCategory: "quest_reward",
          sourceReference: "quest:ashvale_escort",
        }),
      InboxIdempotencyConflictError,
    );

    await monetary.mintAuthorizedCurrency({
      commandId: "s07-ab:mint:b:1",
      principal: SYSTEM_AUTH,
      recipientCharacterId: charB.id,
      currencyCode: "ascendra_coin",
      amount: 1200n,
      sourceCategory: "quest_reward",
      sourceReference: "quest:ironfang_patrol",
    });

    // Non-transferable currency (`astral_shard`) can be minted, but cannot be transferred between players!
    await monetary.mintAuthorizedCurrency({
      commandId: "s07-ab:mint:shard:a",
      principal: SYSTEM_AUTH,
      recipientCharacterId: charA.id,
      currencyCode: "astral_shard",
      amount: 25n,
      sourceCategory: "boss_reward",
      sourceReference: "anomaly:rift_01",
    });
    await assert.rejects(
      () =>
        monetary.transferCurrencyBetweenCharacters({
          commandId: "s07-ab:illegal-shard-transfer",
          principal: pA,
          fromCharacterId: charA.id,
          toCharacterId: charB.id,
          currencyCode: "astral_shard",
          amount: 5n,
          reason: "attempt transfer bound currency",
        }),
      CurrencyOperationForbiddenError,
    );

    // 3. Direct transfer (500 A -> B), insufficient funds rejection, currency sink (100 burned by A), and compensating entry
    await monetary.transferCurrencyBetweenCharacters({
      commandId: "s07-ab:transfer:a-to-b:500",
      principal: pA,
      fromCharacterId: charA.id,
      toCharacterId: charB.id,
      currencyCode: "ascendra_coin",
      amount: 500n,
      reason: "payment for scouting",
    });

    await assert.rejects(
      () =>
        monetary.transferCurrencyBetweenCharacters({
          commandId: "s07-ab:transfer:overdraft",
          principal: pA,
          fromCharacterId: charA.id,
          toCharacterId: charB.id,
          currencyCode: "ascendra_coin",
          amount: 999999n,
          reason: "overdraft",
        }),
      InsufficientFundsError,
    );

    const sinkTx = await monetary.burnCurrencySink({
      commandId: "s07-ab:sink:a:100",
      principal: pA,
      characterId: charA.id,
      currencyCode: "ascendra_coin",
      amount: 100n,
      sinkReason: "fast_travel_coach",
    });
    assert.equal(sinkTx.data.totalAmount, 100n);

    // Verify PostgreSQL append-only trigger blocks retroactive UPDATE/DELETE on ledger!
    await assert.rejects(
      () =>
        pgCtx.pool.query("UPDATE currency_ledger_entries SET amount = 1 WHERE transaction_id = $1::uuid", [
          sinkTx.data.id,
        ]),
      /append-only/i,
    );

    // Compensating reversal of a wrong 50-unit transfer
    const accidentalTx = await monetary.transferCurrencyBetweenCharacters({
      commandId: "s07-ab:transfer:accidental:50",
      principal: pA,
      fromCharacterId: charA.id,
      toCharacterId: charB.id,
      currencyCode: "ascendra_coin",
      amount: 50n,
      reason: "mistaken payment",
    });
    await monetary.recordCompensatingEntry({
      commandId: "s07-ab:compensate:50",
      principal: SYSTEM_AUTH,
      compensatesTransactionId: accidentalTx.data.id,
      reason: "authorized reversal",
    });

    // Wallet balances: A = 2500 - 500 - 100 = 1900; B = 1200 + 500 = 1700; Total supply = 3600 (3700 minted - 100 sink)
    const walletA1 = (await econRepo.getPlayerWallet(charA.id))!;
    const walletB1 = (await econRepo.getPlayerWallet(charB.id))!;
    assert.equal(walletA1.balance, 1900n);
    assert.equal(walletB1.balance, 1700n);

    const rec1 = await econRepo.reconcileCurrency("ascendra_coin");
    assert.equal(rec1.isBalanced, true);
    assert.equal(rec1.totalMinted, 3700n);
    assert.equal(rec1.totalDestroyed, 100n);
    assert.equal(rec1.actualCirculatingSupply, 3600n);

    // 4. Monetary Escrow: concurrent reservations exceeding balance & double-consume race!
    const [resvRace1, resvRace2] = await Promise.allSettled([
      monetary.reserveFunds({
        commandId: "s07-ab:resv-race:1",
        principal: pA,
        characterId: charA.id,
        currencyCode: "ascendra_coin",
        amount: 1200n,
        purpose: "service_hold",
        referenceId: "hold-1",
      }),
      monetary.reserveFunds({
        commandId: "s07-ab:resv-race:2",
        principal: pA,
        characterId: charA.id,
        currencyCode: "ascendra_coin",
        amount: 1200n,
        purpose: "service_hold",
        referenceId: "hold-2",
      }),
    ]);
    const fulfilledResvs = [resvRace1, resvRace2].filter((r) => r.status === "fulfilled");
    const rejectedResvs = [resvRace1, resvRace2].filter((r) => r.status === "rejected");
    assert.equal(fulfilledResvs.length, 1);
    assert.equal(rejectedResvs.length, 1);

    const wonResv = (fulfilledResvs[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof monetary.reserveFunds>>>).value.data;

    // Concurrent consume vs release race on the SAME reservation -> exactly one succeeds!
    const [consRace, relRace] = await Promise.allSettled([
      monetary.consumeReservation({
        commandId: "s07-ab:resv-consume-race",
        principal: SYSTEM_AUTH,
        reservationId: wonResv.id,
        recipientCharacterId: charB.id,
        memo: "service payout",
      }),
      monetary.releaseReservation({
        commandId: "s07-ab:resv-release-race",
        principal: pA,
        reservationId: wonResv.id,
        reason: "try cancel simultaneously",
      }),
    ]);
    assert.equal([consRace, relRace].filter((r) => r.status === "fulfilled").length, 1);
    assert.equal([consRace, relRace].filter((r) => r.status === "rejected").length, 1);
    await assert.rejects(
      () =>
        monetary.consumeReservation({
          commandId: "s07-ab:resv-double-consume",
          principal: SYSTEM_AUTH,
          reservationId: wonResv.id,
          recipientCharacterId: charB.id,
          memo: "second consume must fail",
        }),
      EscrowReservationStateError,
    );

    // Ensure A has plenty of funds for trading
    await monetary.mintAuthorizedCurrency({
      commandId: "s07-ab:mint:a:topup",
      principal: SYSTEM_AUTH,
      recipientCharacterId: charA.id,
      currencyCode: "ascendra_coin",
      amount: 1500n,
      sourceCategory: "dev_seed",
      sourceReference: "topup",
    });

    // 5. Bilateral Player Trading:
    // Grant equipment & materials + bound item to test custody, confirmation invalidation, full-bag protection & settlement!
    const daggerA = (
      await invEngine.grantProceduralEquipment({
        grantId: "s07-ab:grant:dagger-a",
        principal: SYSTEM_AUTH,
        recipientCharacterId: charA.id,
        definitionCode: "thornveil_dagger",
        rarityCode: "rare",
        originType: "dungeon_reward",
        originReference: "crypt:01",
      })
    ).data;

    const voidRingA = (
      await invEngine.grantProceduralEquipment({
        grantId: "s07-ab:grant:void-ring-a",
        principal: SYSTEM_AUTH,
        recipientCharacterId: charA.id,
        definitionCode: "void_signet_ring",
        rarityCode: "epic",
        originType: "boss_drop",
        originReference: "void_boss:01",
      })
    ).data;

    const oreStacksB = (
      await invEngine.grantStackableMaterial({
        grantId: "s07-ab:grant:ore-b",
        principal: SYSTEM_AUTH,
        recipientCharacterId: charB.id,
        definitionCode: "iron_ore",
        quantity: 30,
        originType: "gathering",
        originReference: "vein:01",
      })
    ).data;

    const trade = (
      await trading.initiateTrade({
        commandId: "s07-ab:trade:init",
        principal: pA,
        initiatorCharacterId: charA.id,
        counterpartyCharacterId: charB.id,
      })
    ).data;

    await trading.acceptTrade({
      commandId: "s07-ab:trade:accept",
      principal: pB,
      tradeId: trade.id,
      participantCharacterId: charB.id,
    });

    // Bound/non-tradable item (`void_signet_ring`) rejected at offer boundary!
    await assert.rejects(
      () =>
        trading.setTradeParticipantOffer({
          commandId: "s07-ab:trade:illegal-bound",
          principal: pA,
          tradeId: trade.id,
          participantCharacterId: charA.id,
          currencyAmount: 0n,
          itemInstanceIds: [voidRingA.id],
          materialStacks: [],
        }),
      ItemBindingViolationError,
    );

    // A offers daggerA + 300 coins
    const afterOfferA = (
      await trading.setTradeParticipantOffer({
        commandId: "s07-ab:trade:offer-a-1",
        principal: pA,
        tradeId: trade.id,
        participantCharacterId: charA.id,
        currencyAmount: 300n,
        itemInstanceIds: [daggerA.id],
        materialStacks: [],
      })
    ).data;

    // While daggerA is in trade escrow, A CANNOT equip, transfer, or destroy it!
    await assert.rejects(
      () =>
        invEngine.equipItem({
          commandId: "s07-ab:illegal-equip-escrowed",
          principal: pA,
          characterId: charA.id,
          itemInstanceId: daggerA.id,
          targetSlot: "main_hand",
          expectedBuildVersion: 1,
        }),
      LoadoutInvalidError,
    );
    await assert.rejects(
      () =>
        invEngine.destroyItemInstance({
          commandId: "s07-ab:illegal-destroy-escrowed",
          principal: pA,
          characterId: charA.id,
          itemInstanceId: daggerA.id,
          reasonReference: "try-destroy",
        }),
      LoadoutInvalidError,
    );

    // A confirms offerVersion 2, THEN B updates offer (20 iron_ore) -> A's confirmation MUST be invalidated!
    await trading.confirmTradeOffer({
      commandId: "s07-ab:trade:confirm-a-early",
      principal: pA,
      tradeId: trade.id,
      participantCharacterId: charA.id,
      expectedOfferVersion: afterOfferA.offerVersion,
    });

    const afterOfferB = (
      await trading.setTradeParticipantOffer({
        commandId: "s07-ab:trade:offer-b-1",
        principal: pB,
        tradeId: trade.id,
        participantCharacterId: charB.id,
        currencyAmount: 0n,
        itemInstanceIds: [],
        materialStacks: [{ stackId: oreStacksB[0]!.id, quantity: 20 }],
      })
    ).data;
    assert.equal(afterOfferB.participantAConfirmedVersion, null);
    assert.equal(afterOfferB.participantBConfirmedVersion, null);

    // Stale offerVersion confirmation rejected!
    await assert.rejects(
      () =>
        trading.confirmTradeOffer({
          commandId: "s07-ab:trade:confirm-stale",
          principal: pB,
          tradeId: trade.id,
          participantCharacterId: charB.id,
          expectedOfferVersion: afterOfferA.offerVersion,
        }),
      PlayerTradeInvalidStateError,
    );

    // Both confirm current offerVersion -> atomic settlement!
    await trading.confirmTradeOffer({
      commandId: "s07-ab:trade:confirm-a-final",
      principal: pA,
      tradeId: trade.id,
      participantCharacterId: charA.id,
      expectedOfferVersion: afterOfferB.offerVersion,
    });
    const settled = (
      await trading.confirmTradeOffer({
        commandId: "s07-ab:trade:confirm-b-final",
        principal: pB,
        tradeId: trade.id,
        participantCharacterId: charB.id,
        expectedOfferVersion: afterOfferB.offerVersion,
      })
    ).data;
    assert.equal(settled.status, "Completed");

    // Verify ownership & exact material conservation:
    // B now owns daggerA (`in_container`) + 10 remaining iron_ore; A now owns 20 iron_ore!
    const bItems = await invRepo.listCharacterItems(charB.id);
    assert.ok(bItems.some((i) => i.id === daggerA.id && i.locationState === "in_container"));
    const aStacks = await invRepo.listCharacterStacks(charA.id);
    const bStacks = await invRepo.listCharacterStacks(charB.id);
    assert.equal(
      aStacks.filter((s) => s.definitionCode === "iron_ore").reduce((s, x) => s + x.quantity, 0),
      20,
    );
    assert.equal(
      bStacks.filter((s) => s.definitionCode === "iron_ore").reduce((s, x) => s + x.quantity, 0),
      10,
    );

    // 6. Trade cancellation & full-bag safety check
    const trade2 = (
      await trading.initiateTrade({
        commandId: "s07-ab:trade2:init",
        principal: pB,
        initiatorCharacterId: charB.id,
        counterpartyCharacterId: charA.id,
      })
    ).data;
    await trading.acceptTrade({
      commandId: "s07-ab:trade2:accept",
      principal: pA,
      tradeId: trade2.id,
      participantCharacterId: charA.id,
    });
    const t2Offered = (
      await trading.setTradeParticipantOffer({
        commandId: "s07-ab:trade2:offer-b",
        principal: pB,
        tradeId: trade2.id,
        participantCharacterId: charB.id,
        currencyAmount: 100n,
        itemInstanceIds: [daggerA.id],
        materialStacks: [],
      })
    ).data;

    // Fill A's remaining 38 inventory slots so A's bag is 40/40 full (voidRingA + 20 iron_ore + 38 boots = 40 slots)
    for (let i = 0; i < 38; i++) {
      await invEngine.grantProceduralEquipment({
        grantId: `s07-ab:fill-a:${i}`,
        principal: SYSTEM_AUTH,
        recipientCharacterId: charA.id,
        definitionCode: "explorer_strider_boots",
        rarityCode: "common",
        originType: "dev_authorized",
        originReference: "bag-fill",
      });
    }

    await trading.confirmTradeOffer({
      commandId: "s07-ab:trade2:conf-b",
      principal: pB,
      tradeId: trade2.id,
      participantCharacterId: charB.id,
      expectedOfferVersion: t2Offered.offerVersion,
    });

    // Settlement fails atomically because A's bag is 40/40 full -> zero lost item, zero transferred currency!
    await assert.rejects(
      () =>
        trading.confirmTradeOffer({
          commandId: "s07-ab:trade2:conf-a-fullbag",
          principal: pA,
          tradeId: trade2.id,
          participantCharacterId: charA.id,
          expectedOfferVersion: t2Offered.offerVersion,
        }),
      InventoryCapacityExceededError,
    );

    // Idempotent cancellation returns both 100 coins and daggerA safely back to B!
    const cancelled = await trading.cancelTrade({
      commandId: "s07-ab:trade2:cancel",
      principal: pB,
      tradeId: trade2.id,
      actorCharacterId: charB.id,
      reason: "counterparty inventory full",
    });
    assert.equal(cancelled.data.status, "Cancelled");

    const finalRec = await econRepo.reconcileCurrency("ascendra_coin");
    assert.equal(finalRec.isBalanced, true);
    assert.equal(finalRec.activeEscrowBalance, 0n);
    assert.equal(finalRec.activeReservationsUnresolvedSum, 0n);
  });
});
