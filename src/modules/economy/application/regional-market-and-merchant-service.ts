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
import {
  DurabilityOperationInvalidError,
  InventoryCapacityExceededError,
  ItemBindingViolationError,
  ItemDefinitionNotFoundError,
  ItemInstanceNotFoundError,
  ItemOwnershipForbiddenError,
} from "../../inventory/domain/errors.js";
import {
  buildStackEquivalenceKey,
  resolveInitialBindingOnGrant,
} from "../../inventory/domain/equipment-and-stack-rules.js";
import type {
  EscrowAssetKind,
  MarketListing,
  MarketListingStatus,
  MarketSaleRecord,
  NpcMerchant,
  NpcMerchantOffer,
  RegionalTaxPolicy,
} from "../domain/economy-types.js";
import type { ItemInstance, ItemRarityCode } from "../../inventory/domain/item-types.js";
import { generateProceduralItemProperties } from "../../inventory/domain/procedural-generator.js";
import type { CompetitiveNormalizationProfile } from "../../peoples/domain/character-snapshot-proposal.js";
import {
  CurrencyOperationForbiddenError,
  NpcMerchantOperationError,
  RegionalMarketInvalidError,
} from "../domain/errors.js";
import {
  checkedMultiplyUnitPrice,
  computeRegionalListingFee,
  computeRegionalSaleTaxBreakdown,
} from "../domain/monetary-and-tax-rules.js";
import {
  PostgresEconomyUnitOfWork,
  type PgEconomyTransactionScope,
} from "../infrastructure/postgres-economy-unit-of-work.js";
import type { BalancedLedgerLegInput } from "../domain/value-ledger.js";

export interface CreateMarketListingCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly sellerCharacterId: string;
  readonly settlementId: string;
  readonly itemInstanceId?: string | undefined;
  readonly stackId?: string | undefined;
  readonly quantity?: number | undefined;
  readonly currencyCode?: string | undefined;
  readonly unitPrice: bigint;
  readonly durationSeconds?: number | undefined;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface BuyMarketListingCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly buyerCharacterId: string;
  readonly listingId: string;
  readonly quantity?: number | undefined;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface CancelMarketListingCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly sellerCharacterId: string;
  readonly listingId: string;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface ExpireMarketListingCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly listingId: string;
  readonly asOf?: Date | undefined;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface BuyFromNpcMerchantCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly merchantCode: string;
  readonly offerCode: string;
  readonly quantity: number;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface SellToNpcMerchantCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly merchantCode: string;
  readonly offerCode: string;
  readonly stackId?: string | undefined;
  readonly itemInstanceId?: string | undefined;
  readonly quantity: number;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface RepairEquipmentAtNpcCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly merchantCode: string;
  readonly offerCode: string;
  readonly itemInstanceId: string;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

interface ListingRow {
  id: string;
  seller_account_id: string;
  seller_character_id: string;
  settlement_id: string;
  escrow_holding_id: string;
  asset_kind: EscrowAssetKind;
  item_instance_id: string | null;
  definition_code: string;
  definition_version: number;
  initial_quantity: number;
  remaining_quantity: number;
  quality_bp: number;
  rarity_code: ItemRarityCode;
  currency_code: string;
  unit_price: string;
  listing_fee_paid: string;
  listing_fee_tx_id: string | null;
  tax_policy_version: number;
  status: MarketListingStatus;
  expires_at: Date;
  version: number;
  created_at: Date;
  updated_at: Date;
}

function mapListingRow(r: ListingRow): MarketListing {
  return {
    id: r.id,
    sellerAccountId: r.seller_account_id,
    sellerCharacterId: r.seller_character_id,
    settlementId: r.settlement_id,
    escrowHoldingId: r.escrow_holding_id,
    assetKind: r.asset_kind,
    itemInstanceId: r.item_instance_id,
    definitionCode: r.definition_code,
    definitionVersion: r.definition_version,
    initialQuantity: r.initial_quantity,
    remainingQuantity: r.remaining_quantity,
    qualityBp: r.quality_bp,
    rarityCode: r.rarity_code,
    currencyCode: r.currency_code,
    unitPrice: BigInt(r.unit_price),
    listingFeePaid: BigInt(r.listing_fee_paid),
    listingFeeTxId: r.listing_fee_tx_id,
    taxPolicyVersion: r.tax_policy_version,
    status: r.status,
    expiresAt: r.expires_at,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class RegionalMarketAndMerchantService {
  private readonly pool: PgPool;
  private readonly uow: PostgresEconomyUnitOfWork;
  private readonly logger: Logger;

  constructor(deps: { readonly pool: PgPool; readonly logger: Logger }) {
    this.pool = deps.pool;
    this.uow = new PostgresEconomyUnitOfWork(deps.pool);
    this.logger = deps.logger;
  }

  private async resolveSettlementTaxPolicy(
    scope: PgEconomyTransactionScope,
    settlementId: string,
  ): Promise<RegionalTaxPolicy> {
    const stCheck = await scope.client.query<{ id: string }>(
      "SELECT id FROM settlements WHERE id = $1::uuid",
      [settlementId],
    );
    if (!stCheck.rows[0]) {
      throw new RegionalMarketInvalidError(`Settlement '${settlementId}' not found.`);
    }

    const polRes = await scope.client.query<{
      settlement_id: string;
      policy_version: number;
      listing_fee_bp: number;
      sale_tax_bp: number;
      crafting_tax_bp: number;
      repair_tax_bp: number;
      sink_burn_share_bp: number;
      rounding_mode: "floor_integer";
      is_active: boolean;
      rules_version: number;
    }>(
      `SELECT * FROM regional_tax_policies
       WHERE settlement_id = $1::uuid AND is_active = TRUE
       ORDER BY policy_version DESC
       LIMIT 1`,
      [settlementId],
    );

    const p = polRes.rows[0];
    if (p) {
      return {
        settlementId: p.settlement_id,
        policyVersion: p.policy_version,
        listingFeeBp: p.listing_fee_bp,
        saleTaxBp: p.sale_tax_bp,
        craftingTaxBp: p.crafting_tax_bp,
        repairTaxBp: p.repair_tax_bp,
        sinkBurnShareBp: p.sink_burn_share_bp,
        roundingMode: p.rounding_mode,
        isActive: p.is_active,
        rulesVersion: p.rules_version,
      };
    }

    const econRules = await scope.loadEconomicRules(1);
    return {
      settlementId,
      policyVersion: 1,
      listingFeeBp: econRules.defaultMarketListingFeeBp,
      saleTaxBp: econRules.defaultMarketSaleTaxBp,
      craftingTaxBp: 400,
      repairTaxBp: 200,
      sinkBurnShareBp: 0,
      roundingMode: "floor_integer",
      isActive: true,
      rulesVersion: econRules.rulesVersion,
    };
  }

  public async listOpenMarketListings(params: {
    readonly settlementId: string;
    readonly definitionCode?: string | undefined;
    readonly limit?: number | undefined;
    readonly offset?: number | undefined;
  }): Promise<ReadonlyArray<MarketListing>> {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(params.limit ?? 50)));
    const safeOffset = Math.max(0, Math.trunc(params.offset ?? 0));
    const qParams: unknown[] = [params.settlementId, new Date(), safeLimit, safeOffset];
    let defClause = "";
    if (params.definitionCode) {
      qParams.push(params.definitionCode);
      defClause = `AND definition_code = $${qParams.length}`;
    }

    const res = await this.pool.query<ListingRow>(
      `SELECT * FROM market_listings
       WHERE settlement_id = $1::uuid
         AND status IN ('Open', 'PartiallyFilled')
         AND expires_at > $2
         ${defClause}
       ORDER BY unit_price ASC, created_at ASC, id ASC
       LIMIT $3 OFFSET $4`,
      qParams,
    );
    return res.rows.map(mapListingRow);
  }

  public async createMarketListing(
    cmd: CreateMarketListingCommand,
  ): Promise<IdempotentCommandOutcome<MarketListing>> {
    assertNotGenesisContext("createMarketListing", cmd.executionProfile);
    if (Boolean(cmd.itemInstanceId) === Boolean(cmd.stackId)) {
      throw new RegionalMarketInvalidError(
        "Specify exactly one of itemInstanceId (equipment) or stackId (material stack).",
      );
    }
    const quantity = cmd.itemInstanceId ? 1 : (cmd.quantity ?? 0);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new RegionalMarketInvalidError("Listing quantity must be a positive integer.");
    }
    const grossAsk = checkedMultiplyUnitPrice(cmd.unitPrice, quantity);
    const currencyCode = cmd.currencyCode ?? "ascendra_coin";
    const durationSeconds = cmd.durationSeconds ?? 86_400;
    if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 2_592_000) {
      throw new RegionalMarketInvalidError("durationSeconds must be within 1..2592000.");
    }

    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationSeconds * 1000);
    const eventUuid = deriveDeterministicEventUuid(commandKey);
    const listingId = deriveDeterministicEventUuid(`market-listing:${commandKey}`);
    const holdingId = deriveDeterministicEventUuid(`market-holding:${commandKey}`);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "CreateMarketListing",
      seller_character_id: cmd.sellerCharacterId.toLowerCase(),
      settlement_id: cmd.settlementId.toLowerCase(),
      item_instance_id: cmd.itemInstanceId?.toLowerCase() ?? null,
      stack_id: cmd.stackId?.toLowerCase() ?? null,
      quantity,
      currency_code: currencyCode,
      unit_price: cmd.unitPrice.toString(),
      duration_seconds: durationSeconds,
    });

    return this.uow.executeInTransaction(async (scope) => {
      const { characters, accounts } = await scope.lockCharactersAndAccountsCanonical([
        cmd.sellerCharacterId,
      ]);
      const seller = characters.get(cmd.sellerCharacterId.toLowerCase())!;
      seller.assertOwnedByOrSystem(cmd.principal);
      seller.assertActiveStatus();
      assertAccountActive(accounts.get(seller.accountId.toLowerCase())!);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "MarketListingCreated",
        eventVersion: 1,
        source: "carbon.economy.market",
        correlationUuid: eventUuid,
        aggregateUuid: listingId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      if (claim.status === "duplicate_verified") {
        const ex = await scope.client.query<ListingRow>(
          "SELECT * FROM market_listings WHERE id = $1::uuid",
          [listingId],
        );
        return { status: "duplicate_idempotent", duplicate: true, data: mapListingRow(ex.rows[0]!) };
      }

      if (seller.competitiveLockState === "in_ranked_series") {
        throw new CharacterCompetitiveLockedError(seller.id);
      }

      const currency = await scope.requireActiveCurrency(currencyCode);
      if (!currency.isTradeable) {
        throw new CurrencyOperationForbiddenError(
          `Currency '${currency.currencyCode}' cannot be used for market listings.`,
        );
      }

      const econRules = await scope.loadEconomicRules(1);
      const taxPolicy = await this.resolveSettlementTaxPolicy(scope, cmd.settlementId);
      const listingFee = computeRegionalListingFee({
        grossAskValue: grossAsk,
        policy: taxPolicy,
        maxTaxRateBp: econRules.maxTaxRateBp,
      });

      let listingFeeTxId: string | null = null;
      if (listingFee.totalFee > 0n) {
        const sellerWalletId = await scope.ensurePlayerWalletId(seller.id, currency.currencyCode);
        const legs: BalancedLedgerLegInput[] = [];
        if (listingFee.treasuryAmount > 0n) {
          const treasuryId = await scope.ensureSettlementTreasuryId(
            cmd.settlementId,
            currency.currencyCode,
          );
          legs.push({
            debitAccountId: sellerWalletId,
            creditAccountId: treasuryId,
            amount: listingFee.treasuryAmount,
            memo: `Market listing fee (treasury) on ${listingId}`,
          });
        }
        if (listingFee.sinkBurnedAmount > 0n) {
          const sinkId = await scope.ensureCanonicalTechnicalAccountId(
            "system_sink",
            currency.currencyCode,
          );
          legs.push({
            debitAccountId: sellerWalletId,
            creditAccountId: sinkId,
            amount: listingFee.sinkBurnedAmount,
            memo: `Market listing fee (burned sink) on ${listingId}`,
          });
        }
        const feeTx = await scope.executeBalancedLedgerTransaction({
          idempotencyKey: `${commandKey}:listing-fee`,
          processedEventId: claim.eventUuid,
          operationType: "market_listing_fee",
          currencyCode: currency.currencyCode,
          correlationId: eventUuid,
          sourceEventId: commandKey,
          actorType: cmd.principal.kind,
          actorId: seller.id,
          legs,
        });
        listingFeeTxId = feeTx.id;
      }

      let definitionCode: string;
      let definitionVersion: number;
      let qualityBp: number;
      let rarityCode: ItemRarityCode;
      let assetKind: EscrowAssetKind;

      if (cmd.itemInstanceId) {
        assetKind = "equipment_instance";
        const { holding, instance } = await scope.lockEquipmentInstanceIntoEscrow({
          holdingId,
          operationId: `${commandKey}:escrow`,
          owner: seller,
          itemInstanceId: cmd.itemInstanceId,
          purpose: "market_listing",
          referenceId: listingId,
        });
        definitionCode = holding.definitionCode;
        definitionVersion = holding.definitionVersion;
        qualityBp = holding.qualityBp;
        rarityCode = instance.rarityCode;
      } else {
        assetKind = "material_stack";
        const { holding, definition } = await scope.lockMaterialStackIntoEscrow({
          holdingId,
          operationId: `${commandKey}:escrow`,
          owner: seller,
          stackId: cmd.stackId!,
          quantity,
          purpose: "market_listing",
          referenceId: listingId,
        });
        definitionCode = holding.definitionCode;
        definitionVersion = holding.definitionVersion;
        qualityBp = holding.qualityBp;
        rarityCode = definition.allowedRarities[0] ?? "common";
      }

      await scope.client.query(
        `INSERT INTO market_listings (
           id, seller_account_id, seller_character_id, settlement_id, escrow_holding_id,
           asset_kind, item_instance_id, definition_code, definition_version,
           initial_quantity, remaining_quantity, quality_bp, rarity_code,
           currency_code, unit_price, listing_fee_paid, listing_fee_tx_id,
           tax_policy_version, status, expires_at, version, created_at, updated_at
         )
         VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
           $6, $7::uuid, $8, $9,
           $10, $10, $11, $12,
           $13, $14::bigint, $15::bigint, $16::uuid,
           $17, 'Open', $18, 1, $19, $19
         )`,
        [
          listingId,
          seller.accountId,
          seller.id,
          cmd.settlementId,
          holdingId,
          assetKind,
          cmd.itemInstanceId ?? null,
          definitionCode,
          definitionVersion,
          quantity,
          qualityBp,
          rarityCode,
          currency.currencyCode,
          cmd.unitPrice.toString(),
          listingFee.totalFee.toString(),
          listingFeeTxId,
          taxPolicy.policyVersion,
          expiresAt,
          now,
        ],
      );

      await scope.enqueueEconomyOutbox({
        aggregateType: "MarketListing",
        aggregateId: listingId,
        eventType: "MarketListingCreated",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          listing_id: listingId,
          settlement_id: cmd.settlementId,
          seller_character_id: seller.id,
          definition_code: definitionCode,
          quantity,
          unit_price: cmd.unitPrice.toString(),
          listing_fee_paid: listingFee.totalFee.toString(),
        },
      });

      const createdRes = await scope.client.query<ListingRow>(
        "SELECT * FROM market_listings WHERE id = $1::uuid",
        [listingId],
      );
      return { status: "applied", duplicate: false, data: mapListingRow(createdRes.rows[0]!) };
    });
  }

  public async buyMarketListing(
    cmd: BuyMarketListingCommand,
  ): Promise<
    IdempotentCommandOutcome<{
      readonly listing: MarketListing;
      readonly sale: MarketSaleRecord;
    }>
  > {
    assertNotGenesisContext("buyMarketListing", cmd.executionProfile);
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);
    const saleId = deriveDeterministicEventUuid(`market-sale:${commandKey}`);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "BuyMarketListing",
      buyer_character_id: cmd.buyerCharacterId.toLowerCase(),
      listing_id: cmd.listingId.toLowerCase(),
      quantity: cmd.quantity ?? null,
    });

    return this.uow.executeInTransaction(async (scope) => {
      // Lock listing FIRST so concurrent buyer fills and seller cancels serialize cleanly!
      const listingRes = await scope.client.query<ListingRow>(
        "SELECT * FROM market_listings WHERE id = $1::uuid FOR UPDATE",
        [cmd.listingId],
      );
      if (!listingRes.rows[0]) {
        throw new RegionalMarketInvalidError(`MarketListing '${cmd.listingId}' not found.`);
      }
      const listing = mapListingRow(listingRes.rows[0]);

      const { characters, accounts } = await scope.lockCharactersAndAccountsCanonical([
        cmd.buyerCharacterId,
        listing.sellerCharacterId,
      ]);
      const buyer = characters.get(cmd.buyerCharacterId.toLowerCase())!;
      const seller = characters.get(listing.sellerCharacterId.toLowerCase())!;

      buyer.assertOwnedByOrSystem(cmd.principal);
      buyer.assertActiveStatus();
      assertAccountActive(accounts.get(buyer.accountId.toLowerCase())!);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "MarketSaleCompleted",
        eventVersion: 1,
        source: "carbon.economy.market",
        correlationUuid: eventUuid,
        aggregateUuid: listing.id,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      if (claim.status === "duplicate_verified") {
        const saleRes = await scope.client.query<Record<string, unknown>>(
          "SELECT * FROM market_sales WHERE id = $1::uuid",
          [saleId],
        );
        const s = saleRes.rows[0]!;
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: {
            listing,
            sale: {
              id: String(s["id"]),
              listingId: String(s["listing_id"]),
              settlementId: String(s["settlement_id"]),
              sellerAccountId: String(s["seller_account_id"]),
              sellerCharacterId: String(s["seller_character_id"]),
              buyerAccountId: String(s["buyer_account_id"]),
              buyerCharacterId: String(s["buyer_character_id"]),
              definitionCode: String(s["definition_code"]),
              definitionVersion: Number(s["definition_version"]),
              itemInstanceId: (s["item_instance_id"] as string | null) ?? null,
              quantity: Number(s["quantity"]),
              unitPrice: BigInt(String(s["unit_price"])),
              grossAmount: BigInt(String(s["gross_amount"])),
              taxAmount: BigInt(String(s["tax_amount"])),
              treasuryTaxAmount: BigInt(String(s["treasury_tax_amount"])),
              sinkBurnedAmount: BigInt(String(s["sink_burned_amount"])),
              sellerNetAmount: BigInt(String(s["seller_net_amount"])),
              currencyCode: String(s["currency_code"]),
              ledgerTxId: String(s["ledger_tx_id"]),
              isSameAccount: Boolean(s["is_same_account"]),
              soldAt: s["sold_at"] as Date,
            },
          },
        };
      }

      if (buyer.id === seller.id) {
        throw new RegionalMarketInvalidError("A character cannot buy their own market listing.");
      }
      if (buyer.competitiveLockState === "in_ranked_series") {
        throw new CharacterCompetitiveLockedError(buyer.id);
      }
      if (listing.status !== "Open" && listing.status !== "PartiallyFilled") {
        throw new RegionalMarketInvalidError(
          `Listing '${listing.id}' is '${listing.status}' and cannot be purchased.`,
        );
      }
      if (listing.expiresAt.getTime() <= now.getTime()) {
        throw new RegionalMarketInvalidError(`Listing '${listing.id}' has expired.`);
      }

      const buyQty = cmd.quantity ?? listing.remainingQuantity;
      if (!Number.isInteger(buyQty) || buyQty <= 0 || buyQty > listing.remainingQuantity) {
        throw new RegionalMarketInvalidError(
          `Requested quantity ${String(buyQty)} exceeds listing remainingQuantity ${listing.remainingQuantity}.`,
        );
      }

      const econRules = await scope.loadEconomicRules(1);
      const taxPolicy = await this.resolveSettlementTaxPolicy(scope, listing.settlementId);
      const grossAmount = checkedMultiplyUnitPrice(listing.unitPrice, buyQty);
      const split = computeRegionalSaleTaxBreakdown({
        grossAmount,
        taxRateBp: taxPolicy.saleTaxBp,
        maxTaxRateBp: econRules.maxTaxRateBp,
        sinkBurnShareBp: taxPolicy.sinkBurnShareBp,
      });

      const buyerWalletId = await scope.ensurePlayerWalletId(buyer.id, listing.currencyCode);
      const sellerWalletId = await scope.ensurePlayerWalletId(seller.id, listing.currencyCode);
      const legs: BalancedLedgerLegInput[] = [];

      if (split.sellerNetAmount > 0n) {
        legs.push({
          debitAccountId: buyerWalletId,
          creditAccountId: sellerWalletId,
          amount: split.sellerNetAmount,
          memo: `Market sale proceeds on listing ${listing.id}`,
        });
      }
      if (split.treasuryAmount > 0n) {
        const treasuryId = await scope.ensureSettlementTreasuryId(
          listing.settlementId,
          listing.currencyCode,
        );
        legs.push({
          debitAccountId: buyerWalletId,
          creditAccountId: treasuryId,
          amount: split.treasuryAmount,
          memo: `Regional market sale tax on listing ${listing.id}`,
        });
      }
      if (split.sinkBurnedAmount > 0n) {
        const sinkId = await scope.ensureCanonicalTechnicalAccountId(
          "system_sink",
          listing.currencyCode,
        );
        legs.push({
          debitAccountId: buyerWalletId,
          creditAccountId: sinkId,
          amount: split.sinkBurnedAmount,
          memo: `Regional market burned tax sink on listing ${listing.id}`,
        });
      }

      const ledgerTx = await scope.executeBalancedLedgerTransaction({
        idempotencyKey: commandKey,
        processedEventId: claim.eventUuid,
        operationType: "market_sale_settlement",
        currencyCode: listing.currencyCode,
        correlationId: eventUuid,
        sourceEventId: commandKey,
        actorType: cmd.principal.kind,
        actorId: buyer.id,
        metadata: {
          listing_id: listing.id,
          settlement_id: listing.settlementId,
          gross_amount: split.grossAmount.toString(),
          tax_amount: split.totalTaxAmount.toString(),
        },
        legs,
      });

      // Deliver escrowed asset to buyer (throws & rolls back payment if buyer's bag is full!)
      await scope.deliverFromEscrowHolding({
        holdingId: listing.escrowHoldingId,
        deliverQuantity: buyQty,
        recipient: buyer,
        mode: "settle_to_recipient",
        operationId: `${commandKey}:deliver`,
        allowPersonalStorageFallback: false,
      });

      const nextRemaining = listing.remainingQuantity - buyQty;
      const nextStatus: MarketListingStatus = nextRemaining === 0 ? "Filled" : "PartiallyFilled";

      const updListing = await scope.client.query<ListingRow>(
        `UPDATE market_listings
         SET remaining_quantity = $1,
             status = $2,
             version = version + 1,
             updated_at = $3
         WHERE id = $4::uuid AND status IN ('Open', 'PartiallyFilled') AND version = $5
         RETURNING *`,
        [nextRemaining, nextStatus, now, listing.id, listing.version],
      );
      if (updListing.rowCount !== 1) {
        throw new RegionalMarketInvalidError(
          `Concurrent modification prevented filling listing '${listing.id}'.`,
        );
      }

      const isSameAccount = buyer.accountId.toLowerCase() === seller.accountId.toLowerCase();
      await scope.client.query(
        `INSERT INTO market_sales (
           id, listing_id, settlement_id, seller_account_id, seller_character_id,
           buyer_account_id, buyer_character_id, definition_code, definition_version,
           item_instance_id, quantity, unit_price, gross_amount, tax_amount,
           treasury_tax_amount, sink_burned_amount, seller_net_amount,
           currency_code, ledger_tx_id, is_same_account, sold_at
         )
         VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
           $6::uuid, $7::uuid, $8, $9,
           $10::uuid, $11, $12::bigint, $13::bigint, $14::bigint,
           $15::bigint, $16::bigint, $17::bigint,
           $18, $19::uuid, $20, $21
         )`,
        [
          saleId,
          listing.id,
          listing.settlementId,
          seller.accountId,
          seller.id,
          buyer.accountId,
          buyer.id,
          listing.definitionCode,
          listing.definitionVersion,
          listing.itemInstanceId,
          buyQty,
          listing.unitPrice.toString(),
          split.grossAmount.toString(),
          split.totalTaxAmount.toString(),
          split.treasuryAmount.toString(),
          split.sinkBurnedAmount.toString(),
          split.sellerNetAmount.toString(),
          listing.currencyCode,
          ledgerTx.id,
          isSameAccount,
          now,
        ],
      );

      await scope.enqueueEconomyOutbox({
        aggregateType: "MarketListing",
        aggregateId: listing.id,
        eventType: "MarketSaleCompleted",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          sale_id: saleId,
          listing_id: listing.id,
          settlement_id: listing.settlementId,
          seller_character_id: seller.id,
          buyer_character_id: buyer.id,
          quantity: buyQty,
          gross_amount: split.grossAmount.toString(),
          seller_net_amount: split.sellerNetAmount.toString(),
          tax_amount: split.totalTaxAmount.toString(),
        },
      });

      if (split.treasuryAmount > 0n) {
        await scope.enqueueEconomyOutbox({
          aggregateType: "MarketListing",
          aggregateId: listing.id,
          eventType: "RegionalTaxCollected",
          correlationUuid: eventUuid,
          causationEventUuid: claim.eventUuid,
          occurredAt: now,
          payload: {
            settlement_id: listing.settlementId,
            sale_id: saleId,
            currency_code: listing.currencyCode,
            treasury_tax_amount: split.treasuryAmount.toString(),
          },
        });
      }

      const saleRecord: MarketSaleRecord = {
        id: saleId,
        listingId: listing.id,
        settlementId: listing.settlementId,
        sellerAccountId: seller.accountId,
        sellerCharacterId: seller.id,
        buyerAccountId: buyer.accountId,
        buyerCharacterId: buyer.id,
        definitionCode: listing.definitionCode,
        definitionVersion: listing.definitionVersion,
        itemInstanceId: listing.itemInstanceId,
        quantity: buyQty,
        unitPrice: listing.unitPrice,
        grossAmount: split.grossAmount,
        taxAmount: split.totalTaxAmount,
        treasuryTaxAmount: split.treasuryAmount,
        sinkBurnedAmount: split.sinkBurnedAmount,
        sellerNetAmount: split.sellerNetAmount,
        currencyCode: listing.currencyCode,
        ledgerTxId: ledgerTx.id,
        isSameAccount,
        soldAt: now,
      };

      return {
        status: "applied",
        duplicate: false,
        data: {
          listing: mapListingRow(updListing.rows[0]!),
          sale: saleRecord,
        },
      };
    });
  }

  public async cancelMarketListing(
    cmd: CancelMarketListingCommand,
  ): Promise<IdempotentCommandOutcome<MarketListing>> {
    assertNotGenesisContext("cancelMarketListing", cmd.executionProfile);
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "CancelMarketListing",
      seller_character_id: cmd.sellerCharacterId.toLowerCase(),
      listing_id: cmd.listingId.toLowerCase(),
    });

    return this.uow.executeInTransaction(async (scope) => {
      const listingRes = await scope.client.query<ListingRow>(
        "SELECT * FROM market_listings WHERE id = $1::uuid FOR UPDATE",
        [cmd.listingId],
      );
      if (!listingRes.rows[0]) {
        throw new RegionalMarketInvalidError(`MarketListing '${cmd.listingId}' not found.`);
      }
      const listing = mapListingRow(listingRes.rows[0]);

      const { characters } = await scope.lockCharactersAndAccountsCanonical([
        listing.sellerCharacterId,
      ]);
      const seller = characters.get(listing.sellerCharacterId.toLowerCase())!;
      if (seller.id.toLowerCase() !== cmd.sellerCharacterId.toLowerCase()) {
        throw new RegionalMarketInvalidError("Only the seller may cancel their market listing.");
      }
      seller.assertOwnedByOrSystem(cmd.principal);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "MarketListingCancelled",
        eventVersion: 1,
        source: "carbon.economy.market",
        correlationUuid: eventUuid,
        aggregateUuid: listing.id,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      if (claim.status === "duplicate_verified" || listing.status === "Cancelled") {
        return { status: "duplicate_idempotent", duplicate: true, data: listing };
      }

      if (listing.status !== "Open" && listing.status !== "PartiallyFilled") {
        throw new RegionalMarketInvalidError(
          `Listing '${listing.id}' is '${listing.status}' and cannot be cancelled.`,
        );
      }

      await scope.deliverFromEscrowHolding({
        holdingId: listing.escrowHoldingId,
        deliverQuantity: listing.remainingQuantity,
        recipient: seller,
        mode: "release_to_owner",
        operationId: `${commandKey}:cancel-return`,
        allowPersonalStorageFallback: true,
      });

      const upd = await scope.client.query<ListingRow>(
        `UPDATE market_listings
         SET status = 'Cancelled',
             remaining_quantity = 0,
             version = version + 1,
             updated_at = $1
         WHERE id = $2::uuid AND status IN ('Open', 'PartiallyFilled') AND version = $3
         RETURNING *`,
        [now, listing.id, listing.version],
      );
      if (upd.rowCount !== 1) {
        throw new RegionalMarketInvalidError(`Concurrent conflict cancelling listing '${listing.id}'.`);
      }

      await scope.enqueueEconomyOutbox({
        aggregateType: "MarketListing",
        aggregateId: listing.id,
        eventType: "MarketListingCancelled",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          listing_id: listing.id,
          seller_character_id: seller.id,
          returned_quantity: listing.remainingQuantity,
        },
      });

      return { status: "applied", duplicate: false, data: mapListingRow(upd.rows[0]!) };
    });
  }

  public async expireMarketListing(
    cmd: ExpireMarketListingCommand,
  ): Promise<IdempotentCommandOutcome<MarketListing>> {
    assertNotGenesisContext("expireMarketListing", cmd.executionProfile);
    if (cmd.principal.kind !== "internal_system_authority") {
      throw new CurrencyOperationForbiddenError(
        "expireMarketListing requires internal_system_authority.",
      );
    }
    const sysActorId = cmd.principal.actorId;
    const asOf = cmd.asOf ?? new Date();
    const commandKey = cmd.commandId.trim();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "ExpireMarketListing",
      listing_id: cmd.listingId.toLowerCase(),
      as_of_iso: asOf.toISOString(),
    });

    return this.uow.executeInTransaction(async (scope) => {
      const listingRes = await scope.client.query<ListingRow>(
        "SELECT * FROM market_listings WHERE id = $1::uuid FOR UPDATE",
        [cmd.listingId],
      );
      if (!listingRes.rows[0]) {
        throw new RegionalMarketInvalidError(`MarketListing '${cmd.listingId}' not found.`);
      }
      const listing = mapListingRow(listingRes.rows[0]);

      const { characters } = await scope.lockCharactersAndAccountsCanonical([
        listing.sellerCharacterId,
      ]);
      const seller = characters.get(listing.sellerCharacterId.toLowerCase())!;

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "MarketListingExpired",
        eventVersion: 1,
        source: `carbon.economy.market:${sysActorId}`,
        correlationUuid: eventUuid,
        aggregateUuid: listing.id,
        occurredAt: asOf,
        receivedAt: asOf,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      if (claim.status === "duplicate_verified" || listing.status === "Expired") {
        return { status: "duplicate_idempotent", duplicate: true, data: listing };
      }

      if (listing.status !== "Open" && listing.status !== "PartiallyFilled") {
        throw new RegionalMarketInvalidError(
          `Listing '${listing.id}' is '${listing.status}' and cannot expire.`,
        );
      }
      if (listing.expiresAt.getTime() > asOf.getTime()) {
        throw new RegionalMarketInvalidError(
          `Listing '${listing.id}' has not yet reached expiresAt (${listing.expiresAt.toISOString()}).`,
        );
      }

      await scope.deliverFromEscrowHolding({
        holdingId: listing.escrowHoldingId,
        deliverQuantity: listing.remainingQuantity,
        recipient: seller,
        mode: "release_to_owner",
        operationId: `${commandKey}:expire-return`,
        allowPersonalStorageFallback: true,
      });

      const upd = await scope.client.query<ListingRow>(
        `UPDATE market_listings
         SET status = 'Expired',
             remaining_quantity = 0,
             version = version + 1,
             updated_at = $1
         WHERE id = $2::uuid AND status IN ('Open', 'PartiallyFilled') AND version = $3
         RETURNING *`,
        [asOf, listing.id, listing.version],
      );
      if (upd.rowCount !== 1) {
        throw new RegionalMarketInvalidError(`Concurrent conflict expiring listing '${listing.id}'.`);
      }

      await scope.enqueueEconomyOutbox({
        aggregateType: "MarketListing",
        aggregateId: listing.id,
        eventType: "MarketListingExpired",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: asOf,
        payload: {
          listing_id: listing.id,
          seller_character_id: seller.id,
          returned_quantity: listing.remainingQuantity,
        },
      });

      return { status: "applied", duplicate: false, data: mapListingRow(upd.rows[0]!) };
    });
  }

  public async listNpcMerchantOffers(merchantCode: string): Promise<{
    readonly merchant: NpcMerchant;
    readonly offers: ReadonlyArray<NpcMerchantOffer>;
  }> {
    const mRes = await this.pool.query<Record<string, unknown>>(
      "SELECT * FROM npc_merchants WHERE merchant_code = $1",
      [merchantCode],
    );
    const m = mRes.rows[0];
    if (!m) {
      throw new NpcMerchantOperationError(`NPC Merchant '${merchantCode}' not found.`);
    }
    const oRes = await this.pool.query<Record<string, unknown>>(
      "SELECT * FROM npc_merchant_offers WHERE merchant_code = $1 ORDER BY offer_code ASC",
      [merchantCode],
    );
    return {
      merchant: {
        merchantCode: String(m["merchant_code"]),
        displayName: String(m["display_name"]),
        settlementId: String(m["settlement_id"]),
        fundingMode: m["funding_mode"] as NpcMerchant["fundingMode"],
        walletId: (m["wallet_id"] as string | null) ?? null,
        dailyBuybackBudgetCap: BigInt(String(m["daily_buyback_budget_cap"])),
        dailyBuybackSpent: BigInt(String(m["daily_buyback_spent"])),
        isEnabled: Boolean(m["is_enabled"]),
        rulesVersion: Number(m["rules_version"]),
        version: Number(m["version"]),
      },
      offers: oRes.rows.map((o) => ({
        id: String(o["id"]),
        merchantCode: String(o["merchant_code"]),
        offerCode: String(o["offer_code"]),
        offerKind: o["offer_kind"] as NpcMerchantOffer["offerKind"],
        definitionCode: (o["definition_code"] as string | null) ?? null,
        definitionVersion: o["definition_version"] === null ? null : Number(o["definition_version"]),
        currencyCode: String(o["currency_code"]),
        unitPrice: BigInt(String(o["unit_price"])),
        stockMode: o["stock_mode"] as NpcMerchantOffer["stockMode"],
        currentStock: o["current_stock"] === null ? null : Number(o["current_stock"]),
        maxStock: o["max_stock"] === null ? null : Number(o["max_stock"]),
        isEnabled: Boolean(o["is_enabled"]),
        version: Number(o["version"]),
      })),
    };
  }

  public async buyFromNpcMerchant(
    cmd: BuyFromNpcMerchantCommand,
  ): Promise<IdempotentCommandOutcome<{ readonly totalPaid: bigint; readonly ledgerTxId: string }>> {
    assertNotGenesisContext("buyFromNpcMerchant", cmd.executionProfile);
    if (!Number.isInteger(cmd.quantity) || cmd.quantity <= 0) {
      throw new NpcMerchantOperationError("quantity must be a positive integer.");
    }
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "BuyFromNpcMerchant",
      character_id: cmd.characterId.toLowerCase(),
      merchant_code: cmd.merchantCode,
      offer_code: cmd.offerCode,
      quantity: cmd.quantity,
    });

    return this.uow.executeInTransaction(async (scope) => {
      const mRes = await scope.client.query<Record<string, unknown>>(
        "SELECT * FROM npc_merchants WHERE merchant_code = $1 FOR UPDATE",
        [cmd.merchantCode],
      );
      const m = mRes.rows[0];
      if (!m || !m["is_enabled"]) {
        throw new NpcMerchantOperationError(`NPC Merchant '${cmd.merchantCode}' unavailable.`);
      }
      const oRes = await scope.client.query<Record<string, unknown>>(
        "SELECT * FROM npc_merchant_offers WHERE merchant_code = $1 AND offer_code = $2 FOR UPDATE",
        [cmd.merchantCode, cmd.offerCode],
      );
      const o = oRes.rows[0];
      if (!o || !o["is_enabled"] || o["offer_kind"] !== "sell_item_to_player") {
        throw new NpcMerchantOperationError(`Offer '${cmd.offerCode}' is not a valid sell offer.`);
      }

      const { characters, accounts } = await scope.lockCharactersAndAccountsCanonical([
        cmd.characterId,
      ]);
      const buyer = characters.get(cmd.characterId.toLowerCase())!;
      buyer.assertOwnedByOrSystem(cmd.principal);
      buyer.assertActiveStatus();
      assertAccountActive(accounts.get(buyer.accountId.toLowerCase())!);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "NpcMerchantPurchaseCompleted",
        eventVersion: 1,
        source: "carbon.economy.npc",
        correlationUuid: eventUuid,
        aggregateUuid: String(o["id"]),
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      if (claim.status === "duplicate_verified") {
        const tx = await scope.findLedgerTransactionByIdempotencyKey(commandKey);
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: { totalPaid: tx!.totalAmount, ledgerTxId: tx!.id },
        };
      }

      if (buyer.competitiveLockState === "in_ranked_series") {
        throw new CharacterCompetitiveLockedError(buyer.id);
      }

      if (o["stock_mode"] === "limited") {
        const curStock = Number(o["current_stock"]);
        if (curStock < cmd.quantity) {
          throw new NpcMerchantOperationError(
            `Merchant offer '${cmd.offerCode}' only has ${curStock} unit(s) in stock.`,
          );
        }
        await scope.client.query(
          "UPDATE npc_merchant_offers SET current_stock = $1, version = version + 1, updated_at = $2 WHERE id = $3::uuid",
          [curStock - cmd.quantity, now, o["id"]],
        );
      }

      const unitPrice = BigInt(String(o["unit_price"]));
      const totalCost = checkedMultiplyUnitPrice(unitPrice, cmd.quantity);
      const currencyCode = String(o["currency_code"]);
      const buyerWalletId = await scope.ensurePlayerWalletId(buyer.id, currencyCode);

      const destAccountId =
        m["funding_mode"] === "treasury_backed"
          ? await scope.ensureSettlementTreasuryId(String(m["settlement_id"]), currencyCode)
          : await scope.ensureCanonicalTechnicalAccountId("system_sink", currencyCode);

      const ledgerTx = await scope.executeBalancedLedgerTransaction({
        idempotencyKey: commandKey,
        processedEventId: claim.eventUuid,
        operationType: "npc_merchant_purchase",
        currencyCode,
        correlationId: eventUuid,
        sourceEventId: commandKey,
        actorType: cmd.principal.kind,
        actorId: buyer.id,
        legs: [
          {
            debitAccountId: buyerWalletId,
            creditAccountId: destAccountId,
            amount: totalCost,
            memo: `NPC purchase ${cmd.merchantCode}:${cmd.offerCode} x${cmd.quantity}`,
          },
        ],
      });

      const def = await scope.inventory.findItemDefinition(
        String(o["definition_code"]),
        Number(o["definition_version"]),
      );
      if (!def) {
        throw new ItemDefinitionNotFoundError(
          String(o["definition_code"]),
          Number(o["definition_version"]),
        );
      }

      const genRules = (await scope.inventory.loadGenerationRules(1))!;
      const { bag } = await scope.inventory.ensureAndLockPrimaryContainers(
        buyer.id,
        genRules.defaultInventoryCapacity,
      );

      const bind = resolveInitialBindingOnGrant({
        policy: def.bindingPolicy,
        recipientAccountId: buyer.accountId,
        recipientCharacterId: buyer.id,
      });

      if (def.stackable) {
        const eqKey = buildStackEquivalenceKey({
          definitionCode: def.definitionCode,
          definitionVersion: def.definitionVersion,
          qualityBp: 5000,
          bindingState: bind.bindingState === "bind_on_equip" ? "unbound" : bind.bindingState,
          boundAccountId: bind.boundAccountId,
          boundCharacterId: bind.boundCharacterId,
        });
        const placed = await scope.deliverStackQuantityToCharacterContainers({
          recipient: buyer,
          primaryBag: bag,
          definition: def,
          quantity: cmd.quantity,
          qualityBp: 5000,
          bindingState: bind.bindingState === "bind_on_equip" ? "unbound" : bind.bindingState,
          boundAccountId: bind.boundAccountId,
          boundCharacterId: bind.boundCharacterId,
          equivalenceKey: eqKey,
          allowPersonalStorageFallback: false,
          seedPrefix: `${commandKey}:npc-stack`,
        });
        await scope.inventory.appendLedger({
          operationId: commandKey,
          operationType: "grant",
          characterId: buyer.id,
          stackId: placed[0]?.id ?? null,
          definitionCode: def.definitionCode,
          definitionVersion: def.definitionVersion,
          sourceLocation: `npc:${cmd.merchantCode}`,
          destinationLocation: `container:${bag.id}`,
          quantity: cmd.quantity,
          entityVersion: placed[0]?.version ?? 1,
          causeReference: commandKey,
        });
      } else {
        const freeSlots = await scope.inventory.findFreeContainerSlots(bag, cmd.quantity);
        if (freeSlots.length < cmd.quantity) {
          throw new InventoryCapacityExceededError(
            `Inventory full: requires ${cmd.quantity} free slot(s) for NPC purchase.`,
          );
        }
        const rarityCode = def.allowedRarities[0] ?? "common";
        const rarity = (await scope.inventory.findRarity(rarityCode))!;
        const affixes = await scope.inventory.listAffixesForPools(def.allowedAffixPools);

        for (let i = 0; i < cmd.quantity; i++) {
          const gen = generateProceduralItemProperties({
            definition: def,
            rarity,
            rules: genRules,
            candidateAffixes: affixes,
            itemLevel: def.baseItemLevel,
            serverSeed: `npc-buy:${commandKey}:${i}`,
            originReference: `npc:${cmd.merchantCode}:${cmd.offerCode}`,
          });
          const instId = deriveDeterministicEventUuid(`npc-item:${commandKey}:${i}`);
          const inst: ItemInstance = {
            id: instId,
            definitionCode: def.definitionCode,
            definitionVersion: def.definitionVersion,
            ownerAccountId: buyer.accountId,
            ownerCharacterId: buyer.id,
            locationState: "in_container",
            containerId: bag.id,
            containerSlotIndex: freeSlots[i]!,
            itemLevel: gen.itemLevel,
            rarityCode: gen.rarityCode,
            qualityBp: gen.qualityBp,
            powerBudgetTotal: gen.powerBudgetTotal,
            powerBudgetSpent: gen.powerBudgetSpent,
            implicitAttributes: gen.implicitAttributes,
            generatedAttributes: gen.generatedAttributes,
            affixes: gen.affixes,
            currentDurability: gen.currentDurability,
            maxDurability: gen.maxDurability,
            bindingState: bind.bindingState,
            boundAccountId: bind.boundAccountId,
            boundCharacterId: bind.boundCharacterId,
            generationRulesVersion: genRules.rulesVersion,
            generationSeedHash: gen.generationSeedHash,
            originType: "merchant_purchase",
            originReference: `npc:${cmd.merchantCode}:${cmd.offerCode}`,
            instanceVersion: 1,
            createdAt: now,
            updatedAt: now,
          };
          await scope.inventory.insertItemInstance(inst);
          await scope.inventory.appendLedger({
            operationId: commandKey,
            operationType: "grant",
            characterId: buyer.id,
            itemInstanceId: inst.id,
            definitionCode: def.definitionCode,
            definitionVersion: def.definitionVersion,
            sourceLocation: `npc:${cmd.merchantCode}`,
            destinationLocation: `container:${bag.id}:slot:${freeSlots[i]!}`,
            quantity: 1,
            entityVersion: 1,
            causeReference: commandKey,
          });
        }
      }

      await scope.enqueueEconomyOutbox({
        aggregateType: "NpcMerchant",
        aggregateId: String(o["id"]),
        eventType: "NpcMerchantPurchaseCompleted",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          merchant_code: cmd.merchantCode,
          offer_code: cmd.offerCode,
          character_id: buyer.id,
          quantity: cmd.quantity,
          total_paid: totalCost.toString(),
        },
      });

      this.logger.info("Completed NPC merchant purchase", {
        event_id: commandKey,
        operation: "buyFromNpcMerchant",
      });

      return {
        status: "applied",
        duplicate: false,
        data: { totalPaid: totalCost, ledgerTxId: ledgerTx.id },
      };
    });
  }

  public async sellToNpcMerchant(
    cmd: SellToNpcMerchantCommand,
  ): Promise<IdempotentCommandOutcome<{ readonly payoutReceived: bigint; readonly ledgerTxId: string }>> {
    assertNotGenesisContext("sellToNpcMerchant", cmd.executionProfile);
    if (Boolean(cmd.stackId) === Boolean(cmd.itemInstanceId)) {
      throw new NpcMerchantOperationError("Specify exactly one of stackId or itemInstanceId.");
    }
    if (!Number.isInteger(cmd.quantity) || cmd.quantity <= 0) {
      throw new NpcMerchantOperationError("quantity must be a positive integer.");
    }
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "SellToNpcMerchant",
      character_id: cmd.characterId.toLowerCase(),
      merchant_code: cmd.merchantCode,
      offer_code: cmd.offerCode,
      stack_id: cmd.stackId?.toLowerCase() ?? null,
      item_instance_id: cmd.itemInstanceId?.toLowerCase() ?? null,
      quantity: cmd.quantity,
    });

    return this.uow.executeInTransaction(async (scope) => {
      const mRes = await scope.client.query<Record<string, unknown>>(
        "SELECT * FROM npc_merchants WHERE merchant_code = $1 FOR UPDATE",
        [cmd.merchantCode],
      );
      const m = mRes.rows[0];
      if (!m || !m["is_enabled"]) {
        throw new NpcMerchantOperationError(`NPC Merchant '${cmd.merchantCode}' unavailable.`);
      }
      const oRes = await scope.client.query<Record<string, unknown>>(
        "SELECT * FROM npc_merchant_offers WHERE merchant_code = $1 AND offer_code = $2 FOR UPDATE",
        [cmd.merchantCode, cmd.offerCode],
      );
      const o = oRes.rows[0];
      if (!o || !o["is_enabled"] || o["offer_kind"] !== "buy_item_from_player") {
        throw new NpcMerchantOperationError(`Offer '${cmd.offerCode}' is not a buyback offer.`);
      }

      const { characters, accounts } = await scope.lockCharactersAndAccountsCanonical([
        cmd.characterId,
      ]);
      const seller = characters.get(cmd.characterId.toLowerCase())!;
      seller.assertOwnedByOrSystem(cmd.principal);
      seller.assertActiveStatus();
      assertAccountActive(accounts.get(seller.accountId.toLowerCase())!);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "NpcMerchantSaleCompleted",
        eventVersion: 1,
        source: "carbon.economy.npc",
        correlationUuid: eventUuid,
        aggregateUuid: String(o["id"]),
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      if (claim.status === "duplicate_verified") {
        const tx = await scope.findLedgerTransactionByIdempotencyKey(commandKey);
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: { payoutReceived: tx!.totalAmount, ledgerTxId: tx!.id },
        };
      }

      if (seller.competitiveLockState === "in_ranked_series") {
        throw new CharacterCompetitiveLockedError(seller.id);
      }

      const payout = checkedMultiplyUnitPrice(BigInt(String(o["unit_price"])), cmd.quantity);
      const spent = BigInt(String(m["daily_buyback_spent"]));
      const cap = BigInt(String(m["daily_buyback_budget_cap"]));
      if (spent + payout > cap) {
        throw new NpcMerchantOperationError(
          `NPC Merchant '${cmd.merchantCode}' daily buyback cap exceeded (${(spent + payout).toString()} > ${cap.toString()}).`,
        );
      }

      if (o["stock_mode"] === "limited") {
        const curStock = Number(o["current_stock"]);
        const maxStock = Number(o["max_stock"]);
        if (curStock + cmd.quantity > maxStock) {
          throw new NpcMerchantOperationError(
            `NPC Merchant '${cmd.merchantCode}' stock capacity reached (${curStock}/${maxStock}).`,
          );
        }
        await scope.client.query(
          "UPDATE npc_merchant_offers SET current_stock = $1, version = version + 1, updated_at = $2 WHERE id = $3::uuid",
          [curStock + cmd.quantity, now, o["id"]],
        );
      }

      await scope.client.query(
        "UPDATE npc_merchants SET daily_buyback_spent = $1::bigint, version = version + 1, updated_at = $2 WHERE merchant_code = $3",
        [(spent + payout).toString(), now, cmd.merchantCode],
      );

      const expectedDefCode = String(o["definition_code"]);
      if (cmd.stackId) {
        const stacks = await scope.inventory.lockStacksInCanonicalOrder([cmd.stackId]);
        const st = stacks.get(cmd.stackId);
        if (!st || st.ownerCharacterId !== seller.id) {
          throw new ItemOwnershipForbiddenError("Stack not owned by character.");
        }
        if (st.definitionCode !== expectedDefCode) {
          throw new NpcMerchantOperationError(
            `Stack '${st.definitionCode}' does not match buyback offer '${expectedDefCode}'.`,
          );
        }
        if (st.bindingState === "character_bound") {
          throw new ItemBindingViolationError("character_bound stack cannot be sold to merchant.");
        }
        if (st.quantity < cmd.quantity) {
          throw new NpcMerchantOperationError(`Stack only has ${st.quantity} units.`);
        }
        if (st.quantity === cmd.quantity) {
          await scope.inventory.deleteStack(st.id);
        } else {
          await scope.inventory.updateStack(
            { ...st, quantity: st.quantity - cmd.quantity, version: st.version + 1 },
            st.version,
          );
        }
        await scope.inventory.appendLedger({
          operationId: commandKey,
          operationType: "destroy",
          characterId: seller.id,
          stackId: st.id,
          definitionCode: st.definitionCode,
          definitionVersion: st.definitionVersion,
          sourceLocation: `container:${st.containerId}:slot:${st.containerSlotIndex}`,
          destinationLocation: `npc_buyback:${cmd.merchantCode}`,
          quantity: cmd.quantity,
          entityVersion: st.version + 1,
          causeReference: commandKey,
        });
      } else {
        if (cmd.quantity !== 1) {
          throw new NpcMerchantOperationError("Equipment instance sale quantity must be 1.");
        }
        const inst = await scope.inventory.lockItemInstanceById(cmd.itemInstanceId!);
        if (!inst || inst.ownerCharacterId !== seller.id || inst.locationState !== "in_container") {
          throw new ItemOwnershipForbiddenError(
            "Item must be owned and unequipped in inventory to sell.",
          );
        }
        if (inst.definitionCode !== expectedDefCode) {
          throw new NpcMerchantOperationError("Item definition mismatches merchant offer.");
        }
        if (inst.bindingState === "character_bound") {
          throw new ItemBindingViolationError("character_bound item cannot be sold.");
        }
        await scope.inventory.purgeInactiveLoadoutReferencesForItem(seller.id, inst.id);
        await scope.inventory.updateItemInstance(
          {
            ...inst,
            locationState: "destroyed",
            containerId: null,
            containerSlotIndex: null,
            instanceVersion: inst.instanceVersion + 1,
            updatedAt: now,
          },
          inst.instanceVersion,
        );
        await scope.inventory.appendLedger({
          operationId: commandKey,
          operationType: "destroy",
          characterId: seller.id,
          itemInstanceId: inst.id,
          definitionCode: inst.definitionCode,
          definitionVersion: inst.definitionVersion,
          sourceLocation: `container:${inst.containerId}:slot:${inst.containerSlotIndex}`,
          destinationLocation: `npc_buyback:${cmd.merchantCode}`,
          quantity: 1,
          entityVersion: inst.instanceVersion + 1,
          causeReference: commandKey,
        });
      }

      const currencyCode = String(o["currency_code"]);
      const sellerWalletId = await scope.ensurePlayerWalletId(seller.id, currencyCode);
      const sourceAccountId =
        m["funding_mode"] === "treasury_backed"
          ? await scope.ensureSettlementTreasuryId(String(m["settlement_id"]), currencyCode)
          : await scope.ensureCanonicalTechnicalAccountId("system_mint", currencyCode);

      const ledgerTx = await scope.executeBalancedLedgerTransaction({
        idempotencyKey: commandKey,
        processedEventId: claim.eventUuid,
        operationType: "npc_merchant_buyback",
        currencyCode,
        correlationId: eventUuid,
        sourceEventId: commandKey,
        actorType: cmd.principal.kind,
        actorId: seller.id,
        legs: [
          {
            debitAccountId: sourceAccountId,
            creditAccountId: sellerWalletId,
            amount: payout,
            memo: `NPC buyback ${cmd.merchantCode}:${cmd.offerCode} x${cmd.quantity}`,
          },
        ],
      });

      await scope.enqueueEconomyOutbox({
        aggregateType: "NpcMerchant",
        aggregateId: String(o["id"]),
        eventType: "NpcMerchantSaleCompleted",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          merchant_code: cmd.merchantCode,
          offer_code: cmd.offerCode,
          character_id: seller.id,
          quantity: cmd.quantity,
          payout_received: payout.toString(),
        },
      });

      return {
        status: "applied",
        duplicate: false,
        data: { payoutReceived: payout, ledgerTxId: ledgerTx.id },
      };
    });
  }

  public async repairEquipmentAtNpc(
    cmd: RepairEquipmentAtNpcCommand,
  ): Promise<IdempotentCommandOutcome<{ readonly repairedItem: ItemInstance; readonly totalCost: bigint }>> {
    assertNotGenesisContext("repairEquipmentAtNpc", cmd.executionProfile);
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "RepairEquipmentAtNpc",
      character_id: cmd.characterId.toLowerCase(),
      merchant_code: cmd.merchantCode,
      offer_code: cmd.offerCode,
      item_instance_id: cmd.itemInstanceId.toLowerCase(),
    });

    return this.uow.executeInTransaction(async (scope) => {
      const mRes = await scope.client.query<Record<string, unknown>>(
        "SELECT * FROM npc_merchants WHERE merchant_code = $1 FOR UPDATE",
        [cmd.merchantCode],
      );
      const m = mRes.rows[0];
      if (!m || !m["is_enabled"]) {
        throw new NpcMerchantOperationError(`NPC Merchant '${cmd.merchantCode}' unavailable.`);
      }
      const oRes = await scope.client.query<Record<string, unknown>>(
        "SELECT * FROM npc_merchant_offers WHERE merchant_code = $1 AND offer_code = $2 FOR UPDATE",
        [cmd.merchantCode, cmd.offerCode],
      );
      const o = oRes.rows[0];
      if (!o || !o["is_enabled"] || o["offer_kind"] !== "repair_service") {
        throw new NpcMerchantOperationError(`Offer '${cmd.offerCode}' is not a repair service.`);
      }

      const { characters, accounts } = await scope.lockCharactersAndAccountsCanonical([
        cmd.characterId,
      ]);
      const player = characters.get(cmd.characterId.toLowerCase())!;
      player.assertOwnedByOrSystem(cmd.principal);
      player.assertActiveStatus();
      assertAccountActive(accounts.get(player.accountId.toLowerCase())!);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "EquipmentRepairCompleted",
        eventVersion: 1,
        source: "carbon.economy.npc",
        correlationUuid: eventUuid,
        aggregateUuid: cmd.itemInstanceId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const inst = await scope.inventory.lockItemInstanceById(cmd.itemInstanceId);
      if (!inst) {
        throw new ItemInstanceNotFoundError(cmd.itemInstanceId);
      }
      if (claim.status === "duplicate_verified") {
        const tx = await scope.findLedgerTransactionByIdempotencyKey(commandKey);
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: { repairedItem: inst, totalCost: tx!.totalAmount },
        };
      }

      if (player.competitiveLockState === "in_ranked_series") {
        throw new CharacterCompetitiveLockedError(player.id);
      }
      if (inst.ownerCharacterId !== player.id) {
        throw new ItemOwnershipForbiddenError("Item does not belong to character.");
      }
      if (inst.locationState === "in_escrow" || inst.locationState === "destroyed") {
        throw new DurabilityOperationInvalidError("Cannot repair escrowed or destroyed item.");
      }
      if (
        inst.currentDurability === null ||
        inst.maxDurability === null ||
        inst.currentDurability >= inst.maxDurability
      ) {
        throw new DurabilityOperationInvalidError("Item does not require durability repair.");
      }

      const missing = inst.maxDurability - inst.currentDurability;
      const unitCost = BigInt(String(o["unit_price"]));
      const totalCost = checkedMultiplyUnitPrice(unitCost, missing);
      const econRules = await scope.loadEconomicRules(1);
      const treasuryShare =
        (totalCost * BigInt(econRules.repairTreasuryShareBp)) / 10_000n;
      const sinkShare = totalCost - treasuryShare;

      const currencyCode = String(o["currency_code"]);
      const walletId = await scope.ensurePlayerWalletId(player.id, currencyCode);
      const legs: BalancedLedgerLegInput[] = [];
      if (treasuryShare > 0n) {
        const trId = await scope.ensureSettlementTreasuryId(
          String(m["settlement_id"]),
          currencyCode,
        );
        legs.push({
          debitAccountId: walletId,
          creditAccountId: trId,
          amount: treasuryShare,
          memo: `Repair treasury fee on item ${inst.id}`,
        });
      }
      if (sinkShare > 0n) {
        const sinkId = await scope.ensureCanonicalTechnicalAccountId("system_sink", currencyCode);
        legs.push({
          debitAccountId: walletId,
          creditAccountId: sinkId,
          amount: sinkShare,
          memo: `Repair sink burn on item ${inst.id}`,
        });
      }

      await scope.executeBalancedLedgerTransaction({
        idempotencyKey: commandKey,
        processedEventId: claim.eventUuid,
        operationType: "equipment_repair_fee",
        currencyCode,
        correlationId: eventUuid,
        sourceEventId: commandKey,
        actorType: cmd.principal.kind,
        actorId: player.id,
        legs,
      });

      const repaired: ItemInstance = {
        ...inst,
        currentDurability: inst.maxDurability,
        instanceVersion: inst.instanceVersion + 1,
        updatedAt: now,
      };
      await scope.inventory.updateItemInstance(repaired, inst.instanceVersion);

      if (repaired.locationState === "equipped_active") {
        await scope.client.query(
          "UPDATE characters SET snapshot_version = snapshot_version + 1, updated_at = $1 WHERE id = $2::uuid",
          [now, player.id],
        );
      }

      await scope.inventory.appendLedger({
        operationId: commandKey,
        operationType: "repair",
        characterId: player.id,
        itemInstanceId: repaired.id,
        definitionCode: repaired.definitionCode,
        definitionVersion: repaired.definitionVersion,
        sourceLocation: `durability:${inst.currentDurability}`,
        destinationLocation: `durability:${repaired.maxDurability}`,
        quantity: 1,
        entityVersion: repaired.instanceVersion,
        causeReference: commandKey,
      });

      await scope.enqueueEconomyOutbox({
        aggregateType: "NpcMerchant",
        aggregateId: repaired.id,
        eventType: "EquipmentRepairCompleted",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: player.id,
          item_instance_id: repaired.id,
          restored_durability: missing,
          total_cost: totalCost.toString(),
          sink_burned: sinkShare.toString(),
        },
      });

      return { status: "applied", duplicate: false, data: { repairedItem: repaired, totalCost } };
    });
  }
}
