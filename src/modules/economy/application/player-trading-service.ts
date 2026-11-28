import {
  computeCanonicalFingerprintV1,
  deriveDeterministicEventUuid,
} from "../../../shared/contracts/canonical-fingerprint.js";
import type { PgPool } from "../../../shared/db/pool.js";
import type { Logger } from "../../../shared/observability/logger.js";
import type { IdempotentCommandOutcome } from "../../characters/application/character-engine-service.js";
import {
  assertAccountActive,
  assertNotGenesisContext,
  type AuthorityPrincipal,
  type Character,
} from "../../characters/domain/character.js";
import { CharacterCompetitiveLockedError } from "../../characters/domain/errors.js";
import type { CompetitiveNormalizationProfile } from "../../peoples/domain/character-snapshot-proposal.js";
import type {
  EscrowAssetKind,
  TradeOfferAssetRecord,
  TradeSession,
  TradeSessionStatus,
} from "../domain/economy-types.js";
import {
  CurrencyOperationForbiddenError,
  PlayerTradeInvalidStateError,
} from "../domain/errors.js";
import { assertNonNegativeMonetaryAmount } from "../domain/monetary-and-tax-rules.js";
import {
  PostgresEconomyUnitOfWork,
  type PgEconomyTransactionScope,
} from "../infrastructure/postgres-economy-unit-of-work.js";

export interface InitiatePlayerTradeCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly initiatorCharacterId: string;
  readonly counterpartyCharacterId: string;
  readonly settlementId?: string | null | undefined;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface AcceptPlayerTradeCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly tradeId: string;
  readonly participantCharacterId: string;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface SetTradeParticipantOfferCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly tradeId: string;
  readonly participantCharacterId: string;
  readonly currencyCode?: string | undefined;
  readonly currencyAmount: bigint;
  readonly itemInstanceIds: ReadonlyArray<string>;
  readonly materialStacks: ReadonlyArray<{
    readonly stackId: string;
    readonly quantity: number;
  }>;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface ConfirmPlayerTradeOfferCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly tradeId: string;
  readonly participantCharacterId: string;
  readonly expectedOfferVersion: number;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface CancelPlayerTradeCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly tradeId: string;
  readonly actorCharacterId: string;
  readonly reason: string;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

interface TradeSessionRow {
  id: string;
  participant_a_character_id: string;
  participant_b_character_id: string;
  settlement_id: string | null;
  offer_version: number;
  participant_a_confirmed_version: number | null;
  participant_b_confirmed_version: number | null;
  participant_a_currency_code: string;
  participant_a_currency_amount: string;
  participant_a_reservation_id: string | null;
  participant_b_currency_code: string;
  participant_b_currency_amount: string;
  participant_b_reservation_id: string | null;
  status: TradeSessionStatus;
  settlement_ledger_tx_ids: ReadonlyArray<string>;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface PlayerTradingDependencies {
  readonly pool: PgPool;
  readonly logger: Logger;
  readonly beforeCommitHook?:
    | ((context: { operation: string; commandId: string }) => Promise<void>)
    | undefined;
}

export class PlayerTradingService {
  private readonly uow: PostgresEconomyUnitOfWork;
  private readonly logger: Logger;
  private readonly beforeCommitHook:
    | ((context: { operation: string; commandId: string }) => Promise<void>)
    | undefined;

  constructor(deps: PlayerTradingDependencies) {
    this.uow = new PostgresEconomyUnitOfWork(deps.pool);
    this.logger = deps.logger;
    this.beforeCommitHook = deps.beforeCommitHook;
  }

  private async lockTradeSessionWithAssets(
    scope: PgEconomyTransactionScope,
    tradeId: string,
  ): Promise<TradeSession> {
    const res = await scope.client.query<TradeSessionRow>(
      "SELECT * FROM trade_sessions WHERE id = $1::uuid FOR UPDATE",
      [tradeId],
    );
    const r = res.rows[0];
    if (!r) {
      throw new PlayerTradeInvalidStateError(`TradeSession '${tradeId}' not found.`);
    }
    const assetsRes = await scope.client.query<{
      id: string;
      trade_id: string;
      side: "A" | "B";
      escrow_holding_id: string;
      asset_kind: EscrowAssetKind;
      item_instance_id: string | null;
      definition_code: string;
      definition_version: number;
      quantity: number;
      quality_bp: number;
      created_at: Date;
    }>(
      `SELECT * FROM trade_offer_assets
       WHERE trade_id = $1::uuid
       ORDER BY side ASC, created_at ASC, id ASC`,
      [r.id],
    );

    const offeredAssets: TradeOfferAssetRecord[] = assetsRes.rows.map((a) => ({
      id: a.id,
      tradeId: a.trade_id,
      side: a.side,
      escrowHoldingId: a.escrow_holding_id,
      assetKind: a.asset_kind,
      itemInstanceId: a.item_instance_id,
      definitionCode: a.definition_code,
      definitionVersion: a.definition_version,
      quantity: a.quantity,
      qualityBp: a.quality_bp,
      createdAt: a.created_at,
    }));

    return {
      id: r.id,
      participantACharacterId: r.participant_a_character_id,
      participantBCharacterId: r.participant_b_character_id,
      settlementId: r.settlement_id,
      offerVersion: r.offer_version,
      participantAConfirmedVersion: r.participant_a_confirmed_version,
      participantBConfirmedVersion: r.participant_b_confirmed_version,
      participantACurrencyCode: r.participant_a_currency_code,
      participantACurrencyAmount: BigInt(r.participant_a_currency_amount),
      participantAReservationId: r.participant_a_reservation_id,
      participantBCurrencyCode: r.participant_b_currency_code,
      participantBCurrencyAmount: BigInt(r.participant_b_currency_amount),
      participantBReservationId: r.participant_b_reservation_id,
      status: r.status,
      settlementLedgerTxIds: r.settlement_ledger_tx_ids ?? [],
      offeredAssets,
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  public async initiateTrade(
    cmd: InitiatePlayerTradeCommand,
  ): Promise<IdempotentCommandOutcome<TradeSession>> {
    assertNotGenesisContext("initiateTrade", cmd.executionProfile);
    if (
      cmd.initiatorCharacterId.trim().toLowerCase() ===
      cmd.counterpartyCharacterId.trim().toLowerCase()
    ) {
      throw new PlayerTradeInvalidStateError("Cannot initiate a trade with the same character.");
    }

    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);
    const tradeId = deriveDeterministicEventUuid(`trade-session:${commandKey}`);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "InitiatePlayerTrade",
      initiator_character_id: cmd.initiatorCharacterId.toLowerCase(),
      counterparty_character_id: cmd.counterpartyCharacterId.toLowerCase(),
      settlement_id: cmd.settlementId?.toLowerCase() ?? null,
    });

    return this.uow.executeInTransaction(async (scope) => {
      const { characters, accounts } = await scope.lockCharactersAndAccountsCanonical([
        cmd.initiatorCharacterId,
        cmd.counterpartyCharacterId,
      ]);
      const charA = characters.get(cmd.initiatorCharacterId.toLowerCase())!;
      const charB = characters.get(cmd.counterpartyCharacterId.toLowerCase())!;

      charA.assertOwnedByOrSystem(cmd.principal);
      charA.assertActiveStatus();
      charB.assertActiveStatus();
      assertAccountActive(accounts.get(charA.accountId.toLowerCase())!);
      assertAccountActive(accounts.get(charB.accountId.toLowerCase())!);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "TradeCreated",
        eventVersion: 1,
        source: "carbon.economy.trading",
        correlationUuid: eventUuid,
        aggregateUuid: tradeId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      if (claim.status === "duplicate_verified") {
        const ex = await this.lockTradeSessionWithAssets(scope, tradeId);
        return { status: "duplicate_idempotent", duplicate: true, data: ex };
      }

      if (charA.competitiveLockState === "in_ranked_series") {
        throw new CharacterCompetitiveLockedError(charA.id);
      }
      if (charB.competitiveLockState === "in_ranked_series") {
        throw new CharacterCompetitiveLockedError(charB.id);
      }

      await scope.client.query(
        `INSERT INTO trade_sessions (
           id, participant_a_character_id, participant_b_character_id, settlement_id,
           offer_version, participant_a_confirmed_version, participant_b_confirmed_version,
           participant_a_currency_code, participant_a_currency_amount, participant_a_reservation_id,
           participant_b_currency_code, participant_b_currency_amount, participant_b_reservation_id,
           status, settlement_ledger_tx_ids, version, created_at, updated_at
         )
         VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid,
           1, NULL, NULL,
           'ascendra_coin', 0, NULL,
           'ascendra_coin', 0, NULL,
           'PendingAcceptance', '[]'::jsonb, 1, $5, $5
         )`,
        [tradeId, charA.id, charB.id, cmd.settlementId ?? null, now],
      );

      await scope.enqueueEconomyOutbox({
        aggregateType: "TradeSession",
        aggregateId: tradeId,
        eventType: "TradeCreated",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          trade_id: tradeId,
          participant_a_character_id: charA.id,
          participant_b_character_id: charB.id,
        },
      });

      const created = await this.lockTradeSessionWithAssets(scope, tradeId);
      return { status: "applied", duplicate: false, data: created };
    });
  }

  public async acceptTrade(
    cmd: AcceptPlayerTradeCommand,
  ): Promise<IdempotentCommandOutcome<TradeSession>> {
    assertNotGenesisContext("acceptTrade", cmd.executionProfile);
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "AcceptPlayerTrade",
      trade_id: cmd.tradeId.toLowerCase(),
      participant_character_id: cmd.participantCharacterId.toLowerCase(),
    });

    return this.uow.executeInTransaction(async (scope) => {
      const session = await this.lockTradeSessionWithAssets(scope, cmd.tradeId);
      const { characters, accounts } = await scope.lockCharactersAndAccountsCanonical([
        session.participantACharacterId,
        session.participantBCharacterId,
      ]);
      const charB = characters.get(session.participantBCharacterId.toLowerCase())!;
      if (charB.id.toLowerCase() !== cmd.participantCharacterId.toLowerCase()) {
        throw new PlayerTradeInvalidStateError(
          "Only counterparty participant B may accept a pending trade.",
        );
      }
      charB.assertOwnedByOrSystem(cmd.principal);
      charB.assertActiveStatus();
      assertAccountActive(accounts.get(charB.accountId.toLowerCase())!);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "TradeAccepted",
        eventVersion: 1,
        source: "carbon.economy.trading",
        correlationUuid: eventUuid,
        aggregateUuid: session.id,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      if (claim.status === "duplicate_verified") {
        return { status: "duplicate_idempotent", duplicate: true, data: session };
      }

      if (session.status !== "PendingAcceptance") {
        throw new PlayerTradeInvalidStateError(
          `Trade '${session.id}' is '${session.status}', expected 'PendingAcceptance'.`,
        );
      }
      if (charB.competitiveLockState === "in_ranked_series") {
        throw new CharacterCompetitiveLockedError(charB.id);
      }

      await scope.client.query(
        `UPDATE trade_sessions
         SET status = 'Negotiating', version = version + 1, updated_at = $1
         WHERE id = $2::uuid AND version = $3`,
        [now, session.id, session.version],
      );

      await scope.enqueueEconomyOutbox({
        aggregateType: "TradeSession",
        aggregateId: session.id,
        eventType: "TradeAccepted",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: { trade_id: session.id, accepted_by_character_id: charB.id },
      });

      const updated = await this.lockTradeSessionWithAssets(scope, session.id);
      return { status: "applied", duplicate: false, data: updated };
    });
  }

  /**
   * Updates one participant's offer:
   * 1. Releases any prior monetary reservation & escrowed items/stacks held by that participant on this trade.
   * 2. Reserves the new currency amount & moves newly offered equipment/stacks into escrow custody.
   * 3. Increments `offerVersion` and resets BOTH participants' confirmations (`null`) to prevent bait-and-switch!
   */
  public async setTradeParticipantOffer(
    cmd: SetTradeParticipantOfferCommand,
  ): Promise<IdempotentCommandOutcome<TradeSession>> {
    assertNotGenesisContext("setTradeParticipantOffer", cmd.executionProfile);
    assertNonNegativeMonetaryAmount(cmd.currencyAmount, "currencyAmount");
    const currencyCode = cmd.currencyCode ?? "ascendra_coin";
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const sortedItems = Array.from(
      new Set(cmd.itemInstanceIds.map((x) => x.trim().toLowerCase())),
    ).sort();
    if (sortedItems.length !== cmd.itemInstanceIds.length) {
      throw new PlayerTradeInvalidStateError("Duplicate itemInstanceId in trade offer.");
    }
    const sortedStacks = cmd.materialStacks
      .map((s) => ({ stackId: s.stackId.trim().toLowerCase(), quantity: s.quantity }))
      .sort((a, b) => (a.stackId < b.stackId ? -1 : a.stackId > b.stackId ? 1 : 0));
    const uniqueStackIds = new Set(sortedStacks.map((s) => s.stackId));
    if (uniqueStackIds.size !== sortedStacks.length) {
      throw new PlayerTradeInvalidStateError("Duplicate stackId in trade offer.");
    }

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "SetTradeParticipantOffer",
      trade_id: cmd.tradeId.toLowerCase(),
      participant_character_id: cmd.participantCharacterId.toLowerCase(),
      currency_code: currencyCode,
      currency_amount: cmd.currencyAmount.toString(),
      item_instance_ids: sortedItems,
      material_stacks: sortedStacks,
    });

    return this.uow.executeInTransaction(async (scope) => {
      const session = await this.lockTradeSessionWithAssets(scope, cmd.tradeId);
      const { characters, accounts } = await scope.lockCharactersAndAccountsCanonical([
        session.participantACharacterId,
        session.participantBCharacterId,
      ]);
      const charA = characters.get(session.participantACharacterId.toLowerCase())!;
      const charB = characters.get(session.participantBCharacterId.toLowerCase())!;

      let side: "A" | "B";
      let actorChar: Character;
      if (cmd.participantCharacterId.toLowerCase() === charA.id.toLowerCase()) {
        side = "A";
        actorChar = charA;
      } else if (cmd.participantCharacterId.toLowerCase() === charB.id.toLowerCase()) {
        side = "B";
        actorChar = charB;
      } else {
        throw new PlayerTradeInvalidStateError(
          `Character '${cmd.participantCharacterId}' is not a participant in trade '${session.id}'.`,
        );
      }

      actorChar.assertOwnedByOrSystem(cmd.principal);
      charA.assertActiveStatus();
      charB.assertActiveStatus();
      assertAccountActive(accounts.get(charA.accountId.toLowerCase())!);
      assertAccountActive(accounts.get(charB.accountId.toLowerCase())!);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "TradeOfferUpdated",
        eventVersion: 1,
        source: "carbon.economy.trading",
        correlationUuid: eventUuid,
        aggregateUuid: session.id,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      if (claim.status === "duplicate_verified") {
        return { status: "duplicate_idempotent", duplicate: true, data: session };
      }

      if (session.status !== "Negotiating") {
        throw new PlayerTradeInvalidStateError(
          `Trade '${session.id}' is '${session.status}'; offers can only be modified in 'Negotiating' state.`,
        );
      }
      if (
        charA.competitiveLockState === "in_ranked_series" ||
        charB.competitiveLockState === "in_ranked_series"
      ) {
        throw new CharacterCompetitiveLockedError(actorChar.id);
      }

      const currency = await scope.requireActiveCurrency(currencyCode);
      if (cmd.currencyAmount > 0n && !currency.isTradeable) {
        throw new CurrencyOperationForbiddenError(
          `Currency '${currency.currencyCode}' is not tradeable.`,
        );
      }

      // 1. Release previous currency reservation & offered assets for `side`
      const prevResvId =
        side === "A" ? session.participantAReservationId : session.participantBReservationId;
      if (prevResvId) {
        await scope.releaseReservationInScope({
          reservationId: prevResvId,
          idempotencyKey: `${commandKey}:rel-prev-curr`,
          processedEventId: null,
          terminalStatus: "Released",
          correlationId: eventUuid,
          actorType: cmd.principal.kind,
          actorId: actorChar.id,
          reason: `Superseded by trade offer update on ${session.id}`,
        });
      }

      const prevSideAssets = session.offeredAssets.filter((a) => a.side === side);
      for (const prevAsset of prevSideAssets) {
        await scope.deliverFromEscrowHolding({
          holdingId: prevAsset.escrowHoldingId,
          deliverQuantity: prevAsset.quantity,
          recipient: actorChar,
          mode: "release_to_owner",
          operationId: `${commandKey}:rel-asset:${prevAsset.id}`,
          allowPersonalStorageFallback: true,
        });
      }
      if (prevSideAssets.length > 0) {
        await scope.client.query(
          "DELETE FROM trade_offer_assets WHERE trade_id = $1::uuid AND side = $2",
          [session.id, side],
        );
      }

      // 2. Reserve new currency offer if > 0
      let newResvId: string | null = null;
      if (cmd.currencyAmount > 0n) {
        const walletId = await scope.ensurePlayerWalletId(actorChar.id, currency.currencyCode);
        const resvUuid = deriveDeterministicEventUuid(`trade-resv:${commandKey}:${side}`);
        const { reservation } = await scope.reserveFundsInScope({
          reservationId: resvUuid,
          idempotencyKey: `${commandKey}:resv-curr`,
          processedEventId: claim.eventUuid,
          ownerWalletId: walletId,
          ownerCharacterId: actorChar.id,
          currencyCode: currency.currencyCode,
          amount: cmd.currencyAmount,
          purpose: "player_trade",
          referenceId: session.id,
          correlationId: eventUuid,
          actorType: cmd.principal.kind,
          actorId: actorChar.id,
        });
        newResvId = reservation.id;
      }

      // 3. Lock offered equipment instances & material stacks into escrow
      const sameAccPeerId = charA.accountId === charB.accountId ? charA.accountId : null;

      for (let i = 0; i < sortedItems.length; i++) {
        const itemId = sortedItems[i]!;
        const holdingId = deriveDeterministicEventUuid(`trade-hold-item:${commandKey}:${i}`);
        const { holding } = await scope.lockEquipmentInstanceIntoEscrow({
          holdingId,
          operationId: `${commandKey}:lock-item:${i}`,
          owner: actorChar,
          itemInstanceId: itemId,
          purpose: "player_trade",
          referenceId: session.id,
          allowSameAccountRestrictedAccountId: sameAccPeerId,
        });
        await scope.client.query(
          `INSERT INTO trade_offer_assets (
             id, trade_id, side, escrow_holding_id, asset_kind, item_instance_id,
             definition_code, definition_version, quantity, quality_bp, created_at
           )
           VALUES ($1::uuid, $2::uuid, $3, $4::uuid, 'equipment_instance', $5::uuid, $6, $7, 1, $8, $9)`,
          [
            deriveDeterministicEventUuid(`trade-asset-row:${commandKey}:item:${i}`),
            session.id,
            side,
            holding.id,
            holding.itemInstanceId,
            holding.definitionCode,
            holding.definitionVersion,
            holding.qualityBp,
            now,
          ],
        );
      }

      for (let i = 0; i < sortedStacks.length; i++) {
        const stReq = sortedStacks[i]!;
        const holdingId = deriveDeterministicEventUuid(`trade-hold-stack:${commandKey}:${i}`);
        const { holding } = await scope.lockMaterialStackIntoEscrow({
          holdingId,
          operationId: `${commandKey}:lock-stack:${i}`,
          owner: actorChar,
          stackId: stReq.stackId,
          quantity: stReq.quantity,
          purpose: "player_trade",
          referenceId: session.id,
          allowSameAccountRestrictedAccountId: sameAccPeerId,
        });
        await scope.client.query(
          `INSERT INTO trade_offer_assets (
             id, trade_id, side, escrow_holding_id, asset_kind, item_instance_id,
             definition_code, definition_version, quantity, quality_bp, created_at
           )
           VALUES ($1::uuid, $2::uuid, $3, $4::uuid, 'material_stack', NULL, $5, $6, $7, $8, $9)`,
          [
            deriveDeterministicEventUuid(`trade-asset-row:${commandKey}:stack:${i}`),
            session.id,
            side,
            holding.id,
            holding.definitionCode,
            holding.definitionVersion,
            holding.quantity,
            holding.qualityBp,
            now,
          ],
        );
      }

      const nextOfferVersion = session.offerVersion + 1;
      if (side === "A") {
        await scope.client.query(
          `UPDATE trade_sessions
           SET offer_version = $1,
               participant_a_confirmed_version = NULL,
               participant_b_confirmed_version = NULL,
               participant_a_currency_code = $2,
               participant_a_currency_amount = $3::bigint,
               participant_a_reservation_id = $4::uuid,
               version = version + 1,
               updated_at = $5
           WHERE id = $6::uuid AND version = $7`,
          [
            nextOfferVersion,
            currency.currencyCode,
            cmd.currencyAmount.toString(),
            newResvId,
            now,
            session.id,
            session.version,
          ],
        );
      } else {
        await scope.client.query(
          `UPDATE trade_sessions
           SET offer_version = $1,
               participant_a_confirmed_version = NULL,
               participant_b_confirmed_version = NULL,
               participant_b_currency_code = $2,
               participant_b_currency_amount = $3::bigint,
               participant_b_reservation_id = $4::uuid,
               version = version + 1,
               updated_at = $5
           WHERE id = $6::uuid AND version = $7`,
          [
            nextOfferVersion,
            currency.currencyCode,
            cmd.currencyAmount.toString(),
            newResvId,
            now,
            session.id,
            session.version,
          ],
        );
      }

      await scope.enqueueEconomyOutbox({
        aggregateType: "TradeSession",
        aggregateId: session.id,
        eventType: "TradeOfferUpdated",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          trade_id: session.id,
          side,
          offer_version: nextOfferVersion,
          confirmations_invalidated: true,
        },
      });

      const updated = await this.lockTradeSessionWithAssets(scope, session.id);
      return { status: "applied", duplicate: false, data: updated };
    });
  }

  /**
   * Confirms the exact `expectedOfferVersion`. When BOTH participants have confirmed the current
   * `offerVersion`, executes atomic bilateral settlement of all reserved currency, items, and stacks
   * inside the same PostgreSQL transaction!
   */
  public async confirmTradeOffer(
    cmd: ConfirmPlayerTradeOfferCommand,
  ): Promise<IdempotentCommandOutcome<TradeSession>> {
    assertNotGenesisContext("confirmTradeOffer", cmd.executionProfile);
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "ConfirmPlayerTradeOffer",
      trade_id: cmd.tradeId.toLowerCase(),
      participant_character_id: cmd.participantCharacterId.toLowerCase(),
      expected_offer_version: cmd.expectedOfferVersion,
    });

    return this.uow.executeInTransaction(async (scope) => {
      const session = await this.lockTradeSessionWithAssets(scope, cmd.tradeId);
      const { characters, accounts } = await scope.lockCharactersAndAccountsCanonical([
        session.participantACharacterId,
        session.participantBCharacterId,
      ]);
      const charA = characters.get(session.participantACharacterId.toLowerCase())!;
      const charB = characters.get(session.participantBCharacterId.toLowerCase())!;

      const isA = cmd.participantCharacterId.toLowerCase() === charA.id.toLowerCase();
      const isB = cmd.participantCharacterId.toLowerCase() === charB.id.toLowerCase();
      if (!isA && !isB) {
        throw new PlayerTradeInvalidStateError(
          `Character '${cmd.participantCharacterId}' is not a participant in trade '${session.id}'.`,
        );
      }
      const actorChar = isA ? charA : charB;
      actorChar.assertOwnedByOrSystem(cmd.principal);
      charA.assertActiveStatus();
      charB.assertActiveStatus();
      assertAccountActive(accounts.get(charA.accountId.toLowerCase())!);
      assertAccountActive(accounts.get(charB.accountId.toLowerCase())!);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "TradeCompleted",
        eventVersion: 1,
        source: "carbon.economy.trading",
        correlationUuid: eventUuid,
        aggregateUuid: session.id,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      if (claim.status === "duplicate_verified") {
        return { status: "duplicate_idempotent", duplicate: true, data: session };
      }

      if (session.status !== "Negotiating") {
        throw new PlayerTradeInvalidStateError(
          `Trade '${session.id}' is '${session.status}', cannot confirm.`,
        );
      }
      if (session.offerVersion !== cmd.expectedOfferVersion) {
        throw new PlayerTradeInvalidStateError(
          `Trade '${session.id}' offerVersion mismatch: expected ${cmd.expectedOfferVersion}, actual ${session.offerVersion}.`,
        );
      }
      if (
        charA.competitiveLockState === "in_ranked_series" ||
        charB.competitiveLockState === "in_ranked_series"
      ) {
        throw new CharacterCompetitiveLockedError(actorChar.id);
      }

      const nextAConf = isA ? session.offerVersion : session.participantAConfirmedVersion;
      const nextBConf = isB ? session.offerVersion : session.participantBConfirmedVersion;
      const bothConfirmed =
        nextAConf === session.offerVersion && nextBConf === session.offerVersion;

      if (!bothConfirmed) {
        await scope.client.query(
          `UPDATE trade_sessions
           SET participant_a_confirmed_version = $1,
               participant_b_confirmed_version = $2,
               version = version + 1,
               updated_at = $3
           WHERE id = $4::uuid AND version = $5`,
          [nextAConf, nextBConf, now, session.id, session.version],
        );
        const partial = await this.lockTradeSessionWithAssets(scope, session.id);
        return { status: "applied", duplicate: false, data: partial };
      }

      // BOTH participants confirmed the exact current offerVersion -> ATOMIC SETTLEMENT!
      const settlementTxIds: string[] = [];

      // Lock primary bags in canonical character UUID order before delivering assets
      const genRules = (await scope.inventory.loadGenerationRules(1))!;
      for (const ownerId of [charA.id, charB.id].sort()) {
        await scope.inventory.ensureAndLockPrimaryContainers(
          ownerId,
          genRules.defaultInventoryCapacity,
        );
      }

      // Consume A's currency reservation -> credit B's wallet
      if (session.participantAReservationId && session.participantACurrencyAmount > 0n) {
        const walletBId = await scope.ensurePlayerWalletId(
          charB.id,
          session.participantACurrencyCode,
        );
        const { ledgerTx } = await scope.consumeReservationInScope({
          reservationId: session.participantAReservationId,
          idempotencyKey: `${commandKey}:settle-curr-a-to-b`,
          processedEventId: claim.eventUuid,
          operationType: "player_trade_settlement",
          payouts: [
            {
              creditAccountId: walletBId,
              amount: session.participantACurrencyAmount,
              memo: `Trade ${session.id} currency A -> B`,
            },
          ],
          correlationId: eventUuid,
          actorType: cmd.principal.kind,
          actorId: actorChar.id,
        });
        settlementTxIds.push(ledgerTx.id);
      }

      // Consume B's currency reservation -> credit A's wallet
      if (session.participantBReservationId && session.participantBCurrencyAmount > 0n) {
        const walletAId = await scope.ensurePlayerWalletId(
          charA.id,
          session.participantBCurrencyCode,
        );
        const { ledgerTx } = await scope.consumeReservationInScope({
          reservationId: session.participantBReservationId,
          idempotencyKey: `${commandKey}:settle-curr-b-to-a`,
          processedEventId: null,
          operationType: "player_trade_settlement",
          payouts: [
            {
              creditAccountId: walletAId,
              amount: session.participantBCurrencyAmount,
              memo: `Trade ${session.id} currency B -> A`,
            },
          ],
          correlationId: eventUuid,
          actorType: cmd.principal.kind,
          actorId: actorChar.id,
        });
        settlementTxIds.push(ledgerTx.id);
      }

      // Deliver A's escrowed assets -> B's character_inventory (rolls back entire tx if B's bag is full!)
      // Deliver B's escrowed assets -> A's character_inventory (rolls back entire tx if A's bag is full!)
      for (const asset of session.offeredAssets) {
        const recipient = asset.side === "A" ? charB : charA;
        await scope.deliverFromEscrowHolding({
          holdingId: asset.escrowHoldingId,
          deliverQuantity: asset.quantity,
          recipient,
          mode: "settle_to_recipient",
          operationId: `${commandKey}:settle-asset:${asset.id}`,
          allowPersonalStorageFallback: false,
        });
      }

      await scope.client.query(
        `UPDATE trade_sessions
         SET participant_a_confirmed_version = $1,
             participant_b_confirmed_version = $2,
             status = 'Completed',
             settlement_ledger_tx_ids = $3::jsonb,
             version = version + 1,
             updated_at = $4
         WHERE id = $5::uuid AND version = $6`,
        [
          nextAConf,
          nextBConf,
          JSON.stringify(settlementTxIds),
          now,
          session.id,
          session.version,
        ],
      );

      await scope.enqueueEconomyOutbox({
        aggregateType: "TradeSession",
        aggregateId: session.id,
        eventType: "TradeCompleted",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          trade_id: session.id,
          participant_a_character_id: charA.id,
          participant_b_character_id: charB.id,
          offer_version: session.offerVersion,
          settlement_ledger_tx_ids: settlementTxIds,
        },
      });

      if (this.beforeCommitHook) {
        await this.beforeCommitHook({ operation: "confirmTradeOffer", commandId: commandKey });
      }

      this.logger.info("Completed atomic bilateral player trade", {
        event_id: commandKey,
        aggregate_id: session.id,
        operation: "confirmTradeOffer",
        result: "settled",
      });

      const completed = await this.lockTradeSessionWithAssets(scope, session.id);
      return { status: "applied", duplicate: false, data: completed };
    });
  }

  /**
   * Idempotently cancels an active/pending trade and safely returns all reserved currency and
   * escrowed items/materials to their original owners.
   */
  public async cancelTrade(
    cmd: CancelPlayerTradeCommand,
  ): Promise<IdempotentCommandOutcome<TradeSession>> {
    assertNotGenesisContext("cancelTrade", cmd.executionProfile);
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "CancelPlayerTrade",
      trade_id: cmd.tradeId.toLowerCase(),
      actor_character_id: cmd.actorCharacterId.toLowerCase(),
      reason: cmd.reason.trim(),
    });

    return this.uow.executeInTransaction(async (scope) => {
      const session = await this.lockTradeSessionWithAssets(scope, cmd.tradeId);
      const { characters } = await scope.lockCharactersAndAccountsCanonical([
        session.participantACharacterId,
        session.participantBCharacterId,
      ]);
      const charA = characters.get(session.participantACharacterId.toLowerCase())!;
      const charB = characters.get(session.participantBCharacterId.toLowerCase())!;

      const isA = cmd.actorCharacterId.toLowerCase() === charA.id.toLowerCase();
      const isB = cmd.actorCharacterId.toLowerCase() === charB.id.toLowerCase();
      if (!isA && !isB) {
        throw new PlayerTradeInvalidStateError(
          `Character '${cmd.actorCharacterId}' is not a participant in trade '${session.id}'.`,
        );
      }
      const actorChar = isA ? charA : charB;
      actorChar.assertOwnedByOrSystem(cmd.principal);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "TradeCancelled",
        eventVersion: 1,
        source: "carbon.economy.trading",
        correlationUuid: eventUuid,
        aggregateUuid: session.id,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      if (claim.status === "duplicate_verified" || session.status === "Cancelled") {
        return { status: "duplicate_idempotent", duplicate: true, data: session };
      }

      if (session.status !== "PendingAcceptance" && session.status !== "Negotiating") {
        throw new PlayerTradeInvalidStateError(
          `Trade '${session.id}' is '${session.status}' and can no longer be cancelled.`,
        );
      }

      if (session.participantAReservationId) {
        await scope.releaseReservationInScope({
          reservationId: session.participantAReservationId,
          idempotencyKey: `${commandKey}:cancel-resv-a`,
          processedEventId: claim.eventUuid,
          terminalStatus: "Cancelled",
          correlationId: eventUuid,
          actorType: cmd.principal.kind,
          actorId: actorChar.id,
          reason: cmd.reason.trim() || "Trade cancelled",
        });
      }

      if (session.participantBReservationId) {
        await scope.releaseReservationInScope({
          reservationId: session.participantBReservationId,
          idempotencyKey: `${commandKey}:cancel-resv-b`,
          processedEventId: null,
          terminalStatus: "Cancelled",
          correlationId: eventUuid,
          actorType: cmd.principal.kind,
          actorId: actorChar.id,
          reason: cmd.reason.trim() || "Trade cancelled",
        });
      }

      for (const asset of session.offeredAssets) {
        const owner = asset.side === "A" ? charA : charB;
        await scope.deliverFromEscrowHolding({
          holdingId: asset.escrowHoldingId,
          deliverQuantity: asset.quantity,
          recipient: owner,
          mode: "release_to_owner",
          operationId: `${commandKey}:cancel-asset:${asset.id}`,
          allowPersonalStorageFallback: true,
        });
      }

      const upd = await scope.client.query(
        `UPDATE trade_sessions
         SET status = 'Cancelled',
             participant_a_confirmed_version = NULL,
             participant_b_confirmed_version = NULL,
             version = version + 1,
             updated_at = $1
         WHERE id = $2::uuid AND status IN ('PendingAcceptance', 'Negotiating') AND version = $3`,
        [now, session.id, session.version],
      );
      if (upd.rowCount !== 1) {
        throw new PlayerTradeInvalidStateError(`Concurrent modification cancelling trade '${session.id}'.`);
      }

      await scope.enqueueEconomyOutbox({
        aggregateType: "TradeSession",
        aggregateId: session.id,
        eventType: "TradeCancelled",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          trade_id: session.id,
          cancelled_by_character_id: actorChar.id,
          reason: cmd.reason.trim(),
        },
      });

      const cancelled = await this.lockTradeSessionWithAssets(scope, session.id);
      return { status: "applied", duplicate: false, data: cancelled };
    });
  }
}
