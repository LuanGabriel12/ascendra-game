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
} from "../../characters/domain/character.js";
import { CharacterCompetitiveLockedError } from "../../characters/domain/errors.js";
import type { CompetitiveNormalizationProfile } from "../../peoples/domain/character-snapshot-proposal.js";
import type {
  CurrencyAccount,
  CurrencyLedgerTransactionRecord,
  CurrencyReservation,
  CurrencyReservationPurpose,
} from "../domain/economy-types.js";
import {
  CurrencyOperationForbiddenError,
  EscrowReservationStateError,
  MonetaryLedgerImbalanceError,
} from "../domain/errors.js";
import { assertPositiveMonetaryAmount } from "../domain/monetary-and-tax-rules.js";
import { PostgresEconomyUnitOfWork } from "../infrastructure/postgres-economy-unit-of-work.js";

export interface ProvisionPlayerWalletCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly currencyCode?: string | undefined;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface MintAuthorizedCurrencyCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly recipientCharacterId?: string | undefined;
  readonly recipientSettlementId?: string | undefined;
  readonly recipientFactionId?: string | undefined;
  readonly currencyCode: string;
  readonly amount: bigint;
  readonly sourceCategory:
    | "boss_reward"
    | "quest_reward"
    | "world_event_reward"
    | "authorized_grant"
    | "dev_seed";
  readonly sourceReference: string;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface TransferCurrencyCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly fromCharacterId: string;
  readonly toCharacterId: string;
  readonly currencyCode: string;
  readonly amount: bigint;
  readonly reason: string;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface BurnCurrencySinkCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly currencyCode: string;
  readonly amount: bigint;
  readonly sinkReason: string;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface CompensatingMonetaryEntryCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly compensatesTransactionId: string;
  readonly reason: string;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface ReserveFundsCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly currencyCode: string;
  readonly amount: bigint;
  readonly purpose: CurrencyReservationPurpose;
  readonly referenceId: string;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface ConsumeReservationCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly reservationId: string;
  readonly recipientCharacterId?: string | undefined;
  readonly recipientSettlementId?: string | undefined;
  readonly memo: string;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface ReleaseReservationCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly reservationId: string;
  readonly terminalStatus?: "Released" | "Cancelled" | undefined;
  readonly reason: string;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface MonetaryEngineDependencies {
  readonly pool: PgPool;
  readonly logger: Logger;
  readonly beforeCommitHook?:
    | ((context: { operation: string; commandId: string }) => Promise<void>)
    | undefined;
}

function requireSystemPrincipal(principal: AuthorityPrincipal, operation: string): string {
  if (principal.kind !== "internal_system_authority") {
    throw new CurrencyOperationForbiddenError(
      `Operation '${operation}' requires internal_system_authority.`,
    );
  }
  return principal.actorId;
}

export class MonetaryAndEscrowService {
  private readonly uow: PostgresEconomyUnitOfWork;
  private readonly logger: Logger;
  private readonly beforeCommitHook:
    | ((context: { operation: string; commandId: string }) => Promise<void>)
    | undefined;

  constructor(deps: MonetaryEngineDependencies) {
    this.uow = new PostgresEconomyUnitOfWork(deps.pool);
    this.logger = deps.logger;
    this.beforeCommitHook = deps.beforeCommitHook;
  }

  public async ensurePlayerWallet(
    cmd: ProvisionPlayerWalletCommand,
  ): Promise<IdempotentCommandOutcome<CurrencyAccount>> {
    assertNotGenesisContext("ensurePlayerWallet", cmd.executionProfile);
    const currencyCode = cmd.currencyCode ?? "ascendra_coin";
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "EnsurePlayerWallet",
      character_id: cmd.characterId.toLowerCase(),
      currency_code: currencyCode,
    });

    return this.uow.executeInTransaction(async (scope) => {
      const { characters, accounts } = await scope.lockCharactersAndAccountsCanonical([
        cmd.characterId,
      ]);
      const ch = characters.get(cmd.characterId.toLowerCase())!;
      const acc = accounts.get(ch.accountId.toLowerCase())!;
      ch.assertOwnedByOrSystem(cmd.principal);
      ch.assertActiveStatus();
      assertAccountActive(acc);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "PlayerWalletProvisioned",
        eventVersion: 1,
        source: "carbon.economy",
        correlationUuid: eventUuid,
        aggregateUuid: ch.id,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const walletId = await scope.ensurePlayerWalletId(ch.id, currencyCode);
      const locked = await scope.lockWalletsCanonical([walletId]);
      const wallet = locked.get(walletId.toLowerCase())!;

      if (claim.status === "duplicate_verified") {
        return { status: "duplicate_idempotent", duplicate: true, data: wallet };
      }
      return { status: "applied", duplicate: false, data: wallet };
    });
  }

  public async mintAuthorizedCurrency(
    cmd: MintAuthorizedCurrencyCommand,
  ): Promise<IdempotentCommandOutcome<CurrencyLedgerTransactionRecord>> {
    assertNotGenesisContext("mintAuthorizedCurrency", cmd.executionProfile);
    const actorId = requireSystemPrincipal(cmd.principal, "mintAuthorizedCurrency");
    assertPositiveMonetaryAmount(cmd.amount, "amount");

    const targets = [
      cmd.recipientCharacterId ? "char" : null,
      cmd.recipientSettlementId ? "settlement" : null,
      cmd.recipientFactionId ? "faction" : null,
    ].filter(Boolean);
    if (targets.length !== 1) {
      throw new CurrencyOperationForbiddenError(
        "Specify exactly one recipient (recipientCharacterId, recipientSettlementId, or recipientFactionId).",
      );
    }

    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "MintAuthorizedCurrency",
      recipient_character_id: cmd.recipientCharacterId?.toLowerCase() ?? null,
      recipient_settlement_id: cmd.recipientSettlementId?.toLowerCase() ?? null,
      recipient_faction_id: cmd.recipientFactionId?.toLowerCase() ?? null,
      currency_code: cmd.currencyCode,
      amount: cmd.amount.toString(),
      source_category: cmd.sourceCategory,
      source_reference: cmd.sourceReference.trim(),
    });

    return this.uow.executeInTransaction(async (scope) => {
      if (cmd.recipientCharacterId) {
        const { characters, accounts } = await scope.lockCharactersAndAccountsCanonical([
          cmd.recipientCharacterId,
        ]);
        const ch = characters.get(cmd.recipientCharacterId.toLowerCase())!;
        ch.assertActiveStatus();
        assertAccountActive(accounts.get(ch.accountId.toLowerCase())!);
      }

      const aggId =
        cmd.recipientCharacterId ?? cmd.recipientSettlementId ?? cmd.recipientFactionId!;
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "CurrencyMinted",
        eventVersion: 1,
        source: `carbon.economy:${actorId}`,
        correlationUuid: eventUuid,
        aggregateUuid: aggId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      if (claim.status === "duplicate_verified") {
        const ex = await scope.findLedgerTransactionByIdempotencyKey(commandKey);
        return { status: "duplicate_idempotent", duplicate: true, data: ex! };
      }

      const mintAccountId = await scope.ensureCanonicalTechnicalAccountId(
        "system_mint",
        cmd.currencyCode,
      );
      const destWalletId = cmd.recipientCharacterId
        ? await scope.ensurePlayerWalletId(cmd.recipientCharacterId, cmd.currencyCode)
        : cmd.recipientSettlementId
          ? await scope.ensureSettlementTreasuryId(cmd.recipientSettlementId, cmd.currencyCode)
          : await scope.ensureFactionTreasuryId(cmd.recipientFactionId!, cmd.currencyCode);

      const tx = await scope.executeBalancedLedgerTransaction({
        idempotencyKey: commandKey,
        processedEventId: claim.eventUuid,
        operationType: "currency_mint",
        currencyCode: cmd.currencyCode,
        correlationId: eventUuid,
        sourceEventId: commandKey,
        actorType: "system_authority",
        actorId,
        metadata: {
          source_category: cmd.sourceCategory,
          source_reference: cmd.sourceReference.trim(),
        },
        legs: [
          {
            debitAccountId: mintAccountId,
            creditAccountId: destWalletId,
            amount: cmd.amount,
            memo: `Mint (${cmd.sourceCategory}): ${cmd.sourceReference.trim()}`,
          },
        ],
      });

      await scope.enqueueEconomyOutbox({
        aggregateType: "CurrencyAccount",
        aggregateId: destWalletId,
        eventType: "CurrencyMinted",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          transaction_id: tx.id,
          destination_wallet_id: destWalletId,
          currency_code: cmd.currencyCode,
          amount: cmd.amount.toString(),
          source_category: cmd.sourceCategory,
          source_reference: cmd.sourceReference.trim(),
        },
      });

      if (this.beforeCommitHook) {
        await this.beforeCommitHook({ operation: "mintAuthorizedCurrency", commandId: commandKey });
      }

      this.logger.info("Minted authorized currency", {
        event_id: commandKey,
        aggregate_id: destWalletId,
        operation: "mintAuthorizedCurrency",
        result: "applied",
      });

      return { status: "applied", duplicate: false, data: tx };
    });
  }

  public async transferCurrencyBetweenCharacters(
    cmd: TransferCurrencyCommand,
  ): Promise<IdempotentCommandOutcome<CurrencyLedgerTransactionRecord>> {
    assertNotGenesisContext("transferCurrencyBetweenCharacters", cmd.executionProfile);
    assertPositiveMonetaryAmount(cmd.amount, "amount");
    if (cmd.fromCharacterId.trim().toLowerCase() === cmd.toCharacterId.trim().toLowerCase()) {
      throw new CurrencyOperationForbiddenError("Cannot transfer currency to the same character.");
    }

    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "TransferCurrencyBetweenCharacters",
      from_character_id: cmd.fromCharacterId.toLowerCase(),
      to_character_id: cmd.toCharacterId.toLowerCase(),
      currency_code: cmd.currencyCode,
      amount: cmd.amount.toString(),
      reason: cmd.reason.trim(),
    });

    return this.uow.executeInTransaction(async (scope) => {
      const { characters, accounts } = await scope.lockCharactersAndAccountsCanonical([
        cmd.fromCharacterId,
        cmd.toCharacterId,
      ]);
      const sender = characters.get(cmd.fromCharacterId.toLowerCase())!;
      const recipient = characters.get(cmd.toCharacterId.toLowerCase())!;

      sender.assertOwnedByOrSystem(cmd.principal);
      sender.assertActiveStatus();
      recipient.assertActiveStatus();
      assertAccountActive(accounts.get(sender.accountId.toLowerCase())!);
      assertAccountActive(accounts.get(recipient.accountId.toLowerCase())!);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "CurrencyTransferred",
        eventVersion: 1,
        source: "carbon.economy",
        correlationUuid: eventUuid,
        aggregateUuid: sender.id,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      if (claim.status === "duplicate_verified") {
        const ex = await scope.findLedgerTransactionByIdempotencyKey(commandKey);
        return { status: "duplicate_idempotent", duplicate: true, data: ex! };
      }

      if (sender.competitiveLockState === "in_ranked_series") {
        throw new CharacterCompetitiveLockedError(sender.id);
      }
      if (recipient.competitiveLockState === "in_ranked_series") {
        throw new CharacterCompetitiveLockedError(recipient.id);
      }

      const currency = await scope.requireActiveCurrency(cmd.currencyCode);
      if (!currency.isTransferable) {
        throw new CurrencyOperationForbiddenError(
          `Currency '${currency.currencyCode}' is non-transferable between characters.`,
        );
      }

      const senderWalletId = await scope.ensurePlayerWalletId(sender.id, currency.currencyCode);
      const recipientWalletId = await scope.ensurePlayerWalletId(
        recipient.id,
        currency.currencyCode,
      );

      const tx = await scope.executeBalancedLedgerTransaction({
        idempotencyKey: commandKey,
        processedEventId: claim.eventUuid,
        operationType: "currency_transfer",
        currencyCode: currency.currencyCode,
        correlationId: eventUuid,
        sourceEventId: commandKey,
        actorType: cmd.principal.kind,
        actorId:
          cmd.principal.kind === "authenticated_account"
            ? cmd.principal.accountId
            : cmd.principal.actorId,
        metadata: {
          from_character_id: sender.id,
          to_character_id: recipient.id,
          same_account: sender.accountId === recipient.accountId,
        },
        legs: [
          {
            debitAccountId: senderWalletId,
            creditAccountId: recipientWalletId,
            amount: cmd.amount,
            memo: cmd.reason.trim() || "Direct character currency transfer",
          },
        ],
      });

      await scope.enqueueEconomyOutbox({
        aggregateType: "CurrencyAccount",
        aggregateId: senderWalletId,
        eventType: "CurrencyTransferred",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          transaction_id: tx.id,
          from_character_id: sender.id,
          to_character_id: recipient.id,
          currency_code: currency.currencyCode,
          amount: cmd.amount.toString(),
        },
      });

      if (this.beforeCommitHook) {
        await this.beforeCommitHook({
          operation: "transferCurrencyBetweenCharacters",
          commandId: commandKey,
        });
      }

      return { status: "applied", duplicate: false, data: tx };
    });
  }

  public async burnCurrencySink(
    cmd: BurnCurrencySinkCommand,
  ): Promise<IdempotentCommandOutcome<CurrencyLedgerTransactionRecord>> {
    assertNotGenesisContext("burnCurrencySink", cmd.executionProfile);
    assertPositiveMonetaryAmount(cmd.amount, "amount");
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "BurnCurrencySink",
      character_id: cmd.characterId.toLowerCase(),
      currency_code: cmd.currencyCode,
      amount: cmd.amount.toString(),
      sink_reason: cmd.sinkReason.trim(),
    });

    return this.uow.executeInTransaction(async (scope) => {
      const { characters, accounts } = await scope.lockCharactersAndAccountsCanonical([
        cmd.characterId,
      ]);
      const ch = characters.get(cmd.characterId.toLowerCase())!;
      ch.assertOwnedByOrSystem(cmd.principal);
      ch.assertActiveStatus();
      assertAccountActive(accounts.get(ch.accountId.toLowerCase())!);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "CurrencyDestroyed",
        eventVersion: 1,
        source: "carbon.economy",
        correlationUuid: eventUuid,
        aggregateUuid: ch.id,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      if (claim.status === "duplicate_verified") {
        const ex = await scope.findLedgerTransactionByIdempotencyKey(commandKey);
        return { status: "duplicate_idempotent", duplicate: true, data: ex! };
      }

      const walletId = await scope.ensurePlayerWalletId(ch.id, cmd.currencyCode);
      const sinkId = await scope.ensureCanonicalTechnicalAccountId("system_sink", cmd.currencyCode);

      const tx = await scope.executeBalancedLedgerTransaction({
        idempotencyKey: commandKey,
        processedEventId: claim.eventUuid,
        operationType: "currency_sink",
        currencyCode: cmd.currencyCode,
        correlationId: eventUuid,
        sourceEventId: commandKey,
        actorType: cmd.principal.kind,
        actorId:
          cmd.principal.kind === "authenticated_account"
            ? cmd.principal.accountId
            : cmd.principal.actorId,
        legs: [
          {
            debitAccountId: walletId,
            creditAccountId: sinkId,
            amount: cmd.amount,
            memo: `Sink: ${cmd.sinkReason.trim()}`,
          },
        ],
      });

      await scope.enqueueEconomyOutbox({
        aggregateType: "CurrencyAccount",
        aggregateId: walletId,
        eventType: "CurrencyDestroyed",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          transaction_id: tx.id,
          character_id: ch.id,
          currency_code: cmd.currencyCode,
          amount: cmd.amount.toString(),
          sink_reason: cmd.sinkReason.trim(),
        },
      });

      return { status: "applied", duplicate: false, data: tx };
    });
  }

  /**
   * Administrative compensating ledger movement (reverses a historical transaction via new append-only entries,
   * NEVER editing or deleting historical rows).
   */
  public async recordCompensatingEntry(
    cmd: CompensatingMonetaryEntryCommand,
  ): Promise<IdempotentCommandOutcome<CurrencyLedgerTransactionRecord>> {
    assertNotGenesisContext("recordCompensatingEntry", cmd.executionProfile);
    const actorId = requireSystemPrincipal(cmd.principal, "recordCompensatingEntry");
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "RecordCompensatingEntry",
      compensates_tx_id: cmd.compensatesTransactionId.toLowerCase(),
      reason: cmd.reason.trim(),
    });

    return this.uow.executeInTransaction(async (scope) => {
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "CurrencyTransferred",
        eventVersion: 1,
        source: `carbon.economy:${actorId}`,
        correlationUuid: eventUuid,
        aggregateUuid: cmd.compensatesTransactionId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      if (claim.status === "duplicate_verified") {
        const ex = await scope.findLedgerTransactionByIdempotencyKey(commandKey);
        return { status: "duplicate_idempotent", duplicate: true, data: ex! };
      }

      const origRes = await scope.client.query<{
        id: string;
        currency_code: string;
      }>("SELECT id, currency_code FROM currency_ledger_transactions WHERE id = $1::uuid", [
        cmd.compensatesTransactionId,
      ]);
      const origTx = origRes.rows[0];
      if (!origTx) {
        throw new MonetaryLedgerImbalanceError(
          `Original transaction '${cmd.compensatesTransactionId}' not found.`,
        );
      }

      const origLegsRes = await scope.client.query<{
        debit_account_id: string;
        credit_account_id: string;
        amount: string;
        entry_ordinal: number;
      }>(
        `SELECT debit_account_id, credit_account_id, amount::text, entry_ordinal
         FROM currency_ledger_entries
         WHERE transaction_id = $1::uuid
         ORDER BY entry_ordinal ASC`,
        [origTx.id],
      );

      const tx = await scope.executeBalancedLedgerTransaction({
        idempotencyKey: commandKey,
        processedEventId: claim.eventUuid,
        operationType: "admin_compensating_entry",
        currencyCode: origTx.currency_code,
        correlationId: eventUuid,
        sourceEventId: commandKey,
        actorType: "system_authority",
        actorId,
        isCompensating: true,
        compensatesTxId: origTx.id,
        metadata: { reason: cmd.reason.trim() },
        legs: origLegsRes.rows.map((l) => ({
          debitAccountId: l.credit_account_id,
          creditAccountId: l.debit_account_id,
          amount: BigInt(l.amount),
          memo: `Compensating reversal of tx ${origTx.id} leg #${l.entry_ordinal}: ${cmd.reason.trim()}`,
        })),
      });

      return { status: "applied", duplicate: false, data: tx };
    });
  }

  public async reserveFunds(
    cmd: ReserveFundsCommand,
  ): Promise<IdempotentCommandOutcome<CurrencyReservation>> {
    assertNotGenesisContext("reserveFunds", cmd.executionProfile);
    assertPositiveMonetaryAmount(cmd.amount, "amount");
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);
    const reservationId = deriveDeterministicEventUuid(`currency-resv:${commandKey}`);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "ReserveFunds",
      character_id: cmd.characterId.toLowerCase(),
      currency_code: cmd.currencyCode,
      amount: cmd.amount.toString(),
      purpose: cmd.purpose,
      reference_id: cmd.referenceId.trim(),
    });

    return this.uow.executeInTransaction(async (scope) => {
      const { characters, accounts } = await scope.lockCharactersAndAccountsCanonical([
        cmd.characterId,
      ]);
      const ch = characters.get(cmd.characterId.toLowerCase())!;
      ch.assertOwnedByOrSystem(cmd.principal);
      ch.assertActiveStatus();
      assertAccountActive(accounts.get(ch.accountId.toLowerCase())!);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "FundsReserved",
        eventVersion: 1,
        source: "carbon.economy",
        correlationUuid: eventUuid,
        aggregateUuid: reservationId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      if (claim.status === "duplicate_verified") {
        const locked = await scope.lockReservationsCanonical([reservationId]);
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: locked.get(reservationId.toLowerCase())!,
        };
      }

      if (ch.competitiveLockState === "in_ranked_series") {
        throw new CharacterCompetitiveLockedError(ch.id);
      }

      const walletId = await scope.ensurePlayerWalletId(ch.id, cmd.currencyCode);
      const { reservation } = await scope.reserveFundsInScope({
        reservationId,
        idempotencyKey: commandKey,
        processedEventId: claim.eventUuid,
        ownerWalletId: walletId,
        ownerCharacterId: ch.id,
        currencyCode: cmd.currencyCode,
        amount: cmd.amount,
        purpose: cmd.purpose,
        referenceId: cmd.referenceId.trim(),
        correlationId: eventUuid,
        actorType: cmd.principal.kind,
        actorId:
          cmd.principal.kind === "authenticated_account"
            ? cmd.principal.accountId
            : cmd.principal.actorId,
      });

      await scope.enqueueEconomyOutbox({
        aggregateType: "CurrencyReservation",
        aggregateId: reservation.id,
        eventType: "FundsReserved",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          reservation_id: reservation.id,
          owner_wallet_id: walletId,
          character_id: ch.id,
          currency_code: cmd.currencyCode,
          reserved_amount: cmd.amount.toString(),
          purpose: cmd.purpose,
          reference_id: cmd.referenceId.trim(),
        },
      });

      return { status: "applied", duplicate: false, data: reservation };
    });
  }

  public async consumeReservation(
    cmd: ConsumeReservationCommand,
  ): Promise<IdempotentCommandOutcome<CurrencyReservation>> {
    assertNotGenesisContext("consumeReservation", cmd.executionProfile);
    const actorId = requireSystemPrincipal(cmd.principal, "consumeReservation");
    if (Boolean(cmd.recipientCharacterId) === Boolean(cmd.recipientSettlementId)) {
      throw new EscrowReservationStateError(
        "Specify exactly one of recipientCharacterId or recipientSettlementId.",
      );
    }

    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "ConsumeReservation",
      reservation_id: cmd.reservationId.toLowerCase(),
      recipient_character_id: cmd.recipientCharacterId?.toLowerCase() ?? null,
      recipient_settlement_id: cmd.recipientSettlementId?.toLowerCase() ?? null,
      memo: cmd.memo.trim(),
    });

    return this.uow.executeInTransaction(async (scope) => {
      if (cmd.recipientCharacterId) {
        const { characters, accounts } = await scope.lockCharactersAndAccountsCanonical([
          cmd.recipientCharacterId,
        ]);
        const ch = characters.get(cmd.recipientCharacterId.toLowerCase())!;
        ch.assertActiveStatus();
        assertAccountActive(accounts.get(ch.accountId.toLowerCase())!);
      }

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "FundsConsumed",
        eventVersion: 1,
        source: `carbon.economy:${actorId}`,
        correlationUuid: eventUuid,
        aggregateUuid: cmd.reservationId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      if (claim.status === "duplicate_verified") {
        const locked = await scope.lockReservationsCanonical([cmd.reservationId]);
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: locked.get(cmd.reservationId.toLowerCase())!,
        };
      }

      const existingMap = await scope.lockReservationsCanonical([cmd.reservationId]);
      const existing = existingMap.get(cmd.reservationId.toLowerCase());
      if (!existing) {
        throw new EscrowReservationStateError(`Reservation '${cmd.reservationId}' not found.`);
      }

      const destWalletId = cmd.recipientCharacterId
        ? await scope.ensurePlayerWalletId(cmd.recipientCharacterId, existing.currencyCode)
        : await scope.ensureSettlementTreasuryId(cmd.recipientSettlementId!, existing.currencyCode);

      const { reservation } = await scope.consumeReservationInScope({
        reservationId: existing.id,
        idempotencyKey: commandKey,
        processedEventId: claim.eventUuid,
        operationType: "escrow_consume",
        payouts: [
          {
            creditAccountId: destWalletId,
            amount: existing.reservedAmount - existing.consumedAmount - existing.releasedAmount,
            memo: cmd.memo.trim(),
          },
        ],
        correlationId: eventUuid,
        actorType: "system_authority",
        actorId,
      });

      await scope.enqueueEconomyOutbox({
        aggregateType: "CurrencyReservation",
        aggregateId: reservation.id,
        eventType: "FundsConsumed",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          reservation_id: reservation.id,
          destination_wallet_id: destWalletId,
          amount: reservation.consumedAmount.toString(),
          currency_code: reservation.currencyCode,
        },
      });

      return { status: "applied", duplicate: false, data: reservation };
    });
  }

  public async releaseReservation(
    cmd: ReleaseReservationCommand,
  ): Promise<IdempotentCommandOutcome<CurrencyReservation>> {
    assertNotGenesisContext("releaseReservation", cmd.executionProfile);
    const terminalStatus = cmd.terminalStatus ?? "Released";
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "ReleaseReservation",
      reservation_id: cmd.reservationId.toLowerCase(),
      terminal_status: terminalStatus,
      reason: cmd.reason.trim(),
    });

    return this.uow.executeInTransaction(async (scope) => {
      const preResvRes = await scope.client.query<{ owner_character_id: string | null }>(
        "SELECT owner_character_id FROM currency_reservations WHERE id = $1::uuid",
        [cmd.reservationId],
      );
      const ownerCharId = preResvRes.rows[0]?.owner_character_id ?? null;
      if (!preResvRes.rows[0]) {
        throw new EscrowReservationStateError(`Reservation '${cmd.reservationId}' not found.`);
      }

      if (ownerCharId) {
        const { characters, accounts } = await scope.lockCharactersAndAccountsCanonical([
          ownerCharId,
        ]);
        const ch = characters.get(ownerCharId.toLowerCase())!;
        ch.assertOwnedByOrSystem(cmd.principal);
        ch.assertActiveStatus();
        assertAccountActive(accounts.get(ch.accountId.toLowerCase())!);
      } else {
        requireSystemPrincipal(cmd.principal, "releaseReservation");
      }

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "FundsReleased",
        eventVersion: 1,
        source: "carbon.economy",
        correlationUuid: eventUuid,
        aggregateUuid: cmd.reservationId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      if (claim.status === "duplicate_verified") {
        const locked = await scope.lockReservationsCanonical([cmd.reservationId]);
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: locked.get(cmd.reservationId.toLowerCase())!,
        };
      }

      const { reservation } = await scope.releaseReservationInScope({
        reservationId: cmd.reservationId,
        idempotencyKey: commandKey,
        processedEventId: claim.eventUuid,
        terminalStatus,
        correlationId: eventUuid,
        actorType: cmd.principal.kind,
        actorId:
          cmd.principal.kind === "authenticated_account"
            ? cmd.principal.accountId
            : cmd.principal.actorId,
        reason: cmd.reason.trim(),
      });

      await scope.enqueueEconomyOutbox({
        aggregateType: "CurrencyReservation",
        aggregateId: reservation.id,
        eventType: "FundsReleased",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          reservation_id: reservation.id,
          owner_wallet_id: reservation.ownerWalletId,
          status: reservation.status,
          released_amount: reservation.releasedAmount.toString(),
          currency_code: reservation.currencyCode,
        },
      });

      return { status: "applied", duplicate: false, data: reservation };
    });
  }
}
