import type { ItemInstance, ItemRarityCode } from "../../inventory/domain/item-types.js";

export interface EconomicRulesConfig {
  readonly rulesVersion: number;
  readonly code: string;
  readonly defaultMarketListingFeeBp: number;
  readonly defaultMarketSaleTaxBp: number;
  readonly maxTaxRateBp: number;
  readonly defaultRepairCostPerDurability: bigint;
  readonly repairTreasuryShareBp: number;
  readonly craftingStationTaxTreasuryShareBp: number;
  readonly bountyEscrowCurrencyCode: string;
  readonly isActive: boolean;
}

export interface CurrencyDefinition {
  readonly currencyCode: string;
  readonly displayName: string;
  readonly description: string;
  readonly smallestUnitName: string;
  readonly denominationNotes: Readonly<Record<string, number | string | boolean>>;
  readonly maximumBalance: bigint;
  readonly isTradeable: boolean;
  readonly isTransferable: boolean;
  readonly isEnabled: boolean;
  readonly rulesVersion: number;
}

export const CURRENCY_ACCOUNT_OWNER_TYPES = [
  "player_wallet",
  "settlement_treasury",
  "faction_treasury",
  "system_mint",
  "system_sink",
  "escrow_account",
  "merchant_account",
] as const;

export type CurrencyAccountOwnerType = (typeof CURRENCY_ACCOUNT_OWNER_TYPES)[number];

export type CurrencyAccountStatus = "active" | "frozen" | "closed";

export interface CurrencyAccount {
  readonly id: string;
  readonly ownerType: CurrencyAccountOwnerType;
  readonly ownerId: string;
  readonly ownerCharacterId: string | null;
  readonly ownerSettlementId: string | null;
  readonly ownerFactionId: string | null;
  readonly currencyCode: string;
  readonly balance: bigint;
  readonly version: number;
  readonly status: CurrencyAccountStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export const MONETARY_OPERATION_TYPES = [
  "currency_mint",
  "currency_transfer",
  "currency_sink",
  "escrow_reserve",
  "escrow_consume",
  "escrow_release",
  "escrow_cancel",
  "player_trade_settlement",
  "market_listing_fee",
  "market_sale_settlement",
  "npc_merchant_purchase",
  "npc_merchant_buyback",
  "equipment_repair_fee",
  "crafting_fee",
  "bounty_payout_settlement",
  "world_event_reward_mint",
  "admin_compensating_entry",
] as const;

export type MonetaryOperationType = (typeof MONETARY_OPERATION_TYPES)[number];

export interface CurrencyLedgerEntryRecord {
  readonly id: string;
  readonly ledgerEntrySeq: bigint;
  readonly transactionId: string;
  readonly entryOrdinal: number;
  readonly debitAccountId: string;
  readonly creditAccountId: string;
  readonly currencyCode: string;
  readonly amount: bigint;
  readonly debitBalanceAfter: bigint;
  readonly creditBalanceAfter: bigint;
  readonly memo: string;
  readonly recordedAt: Date;
}

export interface CurrencyLedgerTransactionRecord {
  readonly id: string;
  readonly ledgerTxSeq: bigint;
  readonly processedEventId: string | null;
  readonly idempotencyKey: string;
  readonly operationType: MonetaryOperationType;
  readonly currencyCode: string;
  readonly totalAmount: bigint;
  readonly correlationId: string;
  readonly sourceEventId: string;
  readonly actorType: string;
  readonly actorId: string;
  readonly isCompensating: boolean;
  readonly compensatesTxId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly rulesVersion: number;
  readonly recordedAt: Date;
  readonly entries: ReadonlyArray<CurrencyLedgerEntryRecord>;
}

export type CurrencyReservationPurpose =
  | "player_trade"
  | "market_order"
  | "criminal_bounty"
  | "service_hold";

export type CurrencyReservationStatus = "Reserved" | "Consumed" | "Released" | "Cancelled";

export interface CurrencyReservation {
  readonly id: string;
  readonly ownerWalletId: string;
  readonly ownerCharacterId: string | null;
  readonly escrowAccountId: string;
  readonly currencyCode: string;
  readonly reservedAmount: bigint;
  readonly consumedAmount: bigint;
  readonly releasedAmount: bigint;
  readonly purpose: CurrencyReservationPurpose;
  readonly referenceId: string;
  readonly reserveLedgerTxId: string;
  readonly resolutionLedgerTxId: string | null;
  readonly status: CurrencyReservationStatus;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type EscrowAssetPurpose = "player_trade" | "market_listing";
export type EscrowAssetKind = "equipment_instance" | "material_stack";
export type EscrowHoldingStatus = "held" | "settled" | "released";

export interface EscrowAssetHolding {
  readonly id: string;
  readonly ownerAccountId: string;
  readonly ownerCharacterId: string;
  readonly purpose: EscrowAssetPurpose;
  readonly referenceId: string;
  readonly assetKind: EscrowAssetKind;
  readonly itemInstanceId: string | null;
  readonly sourceStackId: string | null;
  readonly definitionCode: string;
  readonly definitionVersion: number;
  readonly quantity: number;
  readonly remainingQuantity: number;
  readonly qualityBp: number;
  readonly bindingState: "unbound" | "bind_on_equip" | "account_bound" | "character_bound";
  readonly boundAccountId: string | null;
  readonly boundCharacterId: string | null;
  readonly stackEquivalenceKey: string | null;
  readonly status: EscrowHoldingStatus;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type TradeSessionStatus =
  | "PendingAcceptance"
  | "Negotiating"
  | "Completed"
  | "Cancelled"
  | "Expired";

export interface TradeOfferAssetRecord {
  readonly id: string;
  readonly tradeId: string;
  readonly side: "A" | "B";
  readonly escrowHoldingId: string;
  readonly assetKind: EscrowAssetKind;
  readonly itemInstanceId: string | null;
  readonly definitionCode: string;
  readonly definitionVersion: number;
  readonly quantity: number;
  readonly qualityBp: number;
  readonly createdAt: Date;
}

export interface TradeSession {
  readonly id: string;
  readonly participantACharacterId: string;
  readonly participantBCharacterId: string;
  readonly settlementId: string | null;
  readonly offerVersion: number;
  readonly participantAConfirmedVersion: number | null;
  readonly participantBConfirmedVersion: number | null;
  readonly participantACurrencyCode: string;
  readonly participantACurrencyAmount: bigint;
  readonly participantAReservationId: string | null;
  readonly participantBCurrencyCode: string;
  readonly participantBCurrencyAmount: bigint;
  readonly participantBReservationId: string | null;
  readonly status: TradeSessionStatus;
  readonly settlementLedgerTxIds: ReadonlyArray<string>;
  readonly offeredAssets: ReadonlyArray<TradeOfferAssetRecord>;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface RegionalTaxPolicy {
  readonly settlementId: string;
  readonly policyVersion: number;
  readonly listingFeeBp: number;
  readonly saleTaxBp: number;
  readonly craftingTaxBp: number;
  readonly repairTaxBp: number;
  readonly sinkBurnShareBp: number;
  readonly roundingMode: "floor_integer";
  readonly isActive: boolean;
  readonly rulesVersion: number;
}

export type MarketListingStatus =
  | "Open"
  | "PartiallyFilled"
  | "Filled"
  | "Cancelled"
  | "Expired";

export interface MarketListing {
  readonly id: string;
  readonly sellerAccountId: string;
  readonly sellerCharacterId: string;
  readonly settlementId: string;
  readonly escrowHoldingId: string;
  readonly assetKind: EscrowAssetKind;
  readonly itemInstanceId: string | null;
  readonly definitionCode: string;
  readonly definitionVersion: number;
  readonly initialQuantity: number;
  readonly remainingQuantity: number;
  readonly qualityBp: number;
  readonly rarityCode: ItemRarityCode;
  readonly currencyCode: string;
  readonly unitPrice: bigint;
  readonly listingFeePaid: bigint;
  readonly listingFeeTxId: string | null;
  readonly taxPolicyVersion: number;
  readonly status: MarketListingStatus;
  readonly expiresAt: Date;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MarketSaleRecord {
  readonly id: string;
  readonly listingId: string;
  readonly settlementId: string;
  readonly sellerAccountId: string;
  readonly sellerCharacterId: string;
  readonly buyerAccountId: string;
  readonly buyerCharacterId: string;
  readonly definitionCode: string;
  readonly definitionVersion: number;
  readonly itemInstanceId: string | null;
  readonly quantity: number;
  readonly unitPrice: bigint;
  readonly grossAmount: bigint;
  readonly taxAmount: bigint;
  readonly treasuryTaxAmount: bigint;
  readonly sinkBurnedAmount: bigint;
  readonly sellerNetAmount: bigint;
  readonly currencyCode: string;
  readonly ledgerTxId: string;
  readonly isSameAccount: boolean;
  readonly soldAt: Date;
}

export interface RegionalMarketPriceStats {
  readonly settlementId: string;
  readonly definitionCode: string;
  readonly currencyCode: string;
  readonly observationWindowStart: Date | null;
  readonly observationWindowEnd: Date;
  readonly availableListedQuantity: number;
  readonly lowestActiveAskPrice: bigint | null;
  readonly completedSalesCount: number;
  readonly totalTradedQuantity: number;
  readonly totalGrossVolume: bigint;
  readonly lastTradedUnitPrice: bigint | null;
  readonly volumeWeightedAverageUnitPrice: bigint | null;
  readonly medianSaleUnitPrice: bigint | null;
  readonly methodology: "executed_sales_only_vwap_floor_and_lower_median";
}

export interface NpcMerchant {
  readonly merchantCode: string;
  readonly displayName: string;
  readonly settlementId: string;
  readonly fundingMode: "treasury_backed" | "controlled_system_faucet_sink";
  readonly walletId: string | null;
  readonly dailyBuybackBudgetCap: bigint;
  readonly dailyBuybackSpent: bigint;
  readonly isEnabled: boolean;
  readonly rulesVersion: number;
  readonly version: number;
}

export interface NpcMerchantOffer {
  readonly id: string;
  readonly merchantCode: string;
  readonly offerCode: string;
  readonly offerKind: "sell_item_to_player" | "buy_item_from_player" | "repair_service";
  readonly definitionCode: string | null;
  readonly definitionVersion: number | null;
  readonly currencyCode: string;
  readonly unitPrice: bigint;
  readonly stockMode: "limited" | "unlimited_sink_source";
  readonly currentStock: number | null;
  readonly maxStock: number | null;
  readonly isEnabled: boolean;
  readonly version: number;
}

export interface LootTableEntryDefinition {
  readonly entryCode: string;
  readonly entryKind: "procedural_equipment" | "material_stack" | "currency_mint";
  readonly itemDefinitionCode: string | null;
  readonly itemDefinitionVersion: number | null;
  readonly currencyCode: string | null;
  readonly weight: number;
  readonly minQuantity: number;
  readonly maxQuantity: number;
  readonly allowedRarities: ReadonlyArray<ItemRarityCode>;
  readonly rarityWeights: Readonly<Partial<Record<ItemRarityCode, number>>>;
  readonly minItemLevel: number;
  readonly maxItemLevel: number;
}

export interface LootTableDefinition {
  readonly lootTableCode: string;
  readonly lootTableVersion: number;
  readonly displayName: string;
  readonly sourceCategory: "boss" | "world_event" | "dungeon";
  readonly guaranteedFragmentCode: string | null;
  readonly guaranteedFragmentQty: number;
  readonly rollsCount: number;
  readonly isEnabled: boolean;
  readonly rulesVersion: number;
  readonly entries: ReadonlyArray<LootTableEntryDefinition>;
}

export interface FragmentRedeemableOption {
  readonly optionCode: string;
  readonly rewardKind: "procedural_equipment" | "material_stack";
  readonly itemDefinitionCode: string;
  readonly itemDefinitionVersion: number;
  readonly rarityCode: ItemRarityCode;
  readonly itemLevel: number;
  readonly quantity: number;
}

export interface AntiBadLuckFragmentDefinition {
  readonly fragmentCode: string;
  readonly displayName: string;
  readonly sourceContentRef: string;
  readonly bindingPolicy: "character_bound";
  readonly redemptionCost: number;
  readonly rewardPool: ReadonlyArray<FragmentRedeemableOption>;
  readonly isEnabled: boolean;
  readonly rulesVersion: number;
}

export interface CharacterFragmentBalance {
  readonly characterId: string;
  readonly fragmentCode: string;
  readonly balance: number;
  readonly totalEarned: number;
  readonly totalRedeemed: number;
  readonly version: number;
}

export interface AuthoritativeRewardGrantRecord {
  readonly id: string;
  readonly rewardEventId: string;
  readonly sourceType: "boss_kill" | "world_event_contribution" | "fragment_redemption";
  readonly sourceEntityId: string;
  readonly characterId: string;
  readonly lootTableCode: string | null;
  readonly lootTableVersion: number | null;
  readonly eligibilityReference: string;
  readonly rewardSlotIndex: number;
  readonly generationSeedHash: string;
  readonly grantedItems: ReadonlyArray<ItemInstance>;
  readonly grantedStacks: ReadonlyArray<{
    readonly definitionCode: string;
    readonly quantity: number;
  }>;
  readonly mintedCurrency: {
    readonly currencyCode: string;
    readonly amount: bigint;
    readonly ledgerTxId: string;
  } | null;
  readonly grantedFragments: {
    readonly fragmentCode: string;
    readonly quantity: number;
    readonly newBalance: number;
  } | null;
  readonly rulesVersion: number;
  readonly grantedAt: Date;
}

export const PLANNED_PROFESSION_CODES = [
  "blacksmithing",
  "armorsmithing",
  "carpentry",
  "alchemy",
  "jewelcrafting",
  "enchanting",
  "mining",
  "logging",
  "farming",
  "fishing",
  "cooking",
  "tailoring",
  "mercantile",
] as const;

export type ProfessionCode = (typeof PLANNED_PROFESSION_CODES)[number];

export interface ProfessionDefinition {
  readonly professionCode: ProfessionCode;
  readonly displayName: string;
  readonly category: "crafting" | "gathering" | "commerce";
  readonly maxLevel: number;
  readonly isEnabled: boolean;
  readonly rulesVersion: number;
}

export interface CharacterProfessionState {
  readonly characterId: string;
  readonly professionCode: ProfessionCode;
  readonly professionLevel: number;
  readonly professionExperience: bigint;
  readonly craftsCompletedCount: number;
  readonly rulesVersion: number;
  readonly version: number;
}

export interface CraftingMaterialRequirement {
  readonly definitionCode: string;
  readonly definitionVersion: number;
  readonly quantity: number;
}

export interface CraftingRecipeDefinition {
  readonly recipeCode: string;
  readonly recipeVersion: number;
  readonly displayName: string;
  readonly requiredProfessionCode: ProfessionCode;
  readonly requiredMasteryLevel: number;
  readonly requiredStationCode: string;
  readonly requiredMaterials: ReadonlyArray<CraftingMaterialRequirement>;
  readonly currencyCode: string;
  readonly currencyCost: bigint;
  readonly outputDefinitionCode: string;
  readonly outputDefinitionVersion: number;
  readonly outputQuantity: number;
  readonly allowedRarities: ReadonlyArray<ItemRarityCode>;
  readonly minQualityBp: number;
  readonly maxQualityBp: number;
  readonly professionXpGranted: bigint;
  readonly isEnabled: boolean;
  readonly rulesVersion: number;
}

export interface CraftingOperationRecord {
  readonly id: string;
  readonly operationId: string;
  readonly characterId: string;
  readonly settlementId: string | null;
  readonly recipeCode: string;
  readonly recipeVersion: number;
  readonly stationCode: string;
  readonly consumedMaterials: ReadonlyArray<{
    readonly definitionCode: string;
    readonly quantity: number;
    readonly averageQualityBp: number;
  }>;
  readonly currencyPaid: bigint;
  readonly ledgerTxId: string | null;
  readonly producedItemInstance: ItemInstance | null;
  readonly rolledRarityCode: ItemRarityCode;
  readonly rolledQualityBp: number;
  readonly professionXpAwarded: bigint;
  readonly resultingProfessionState: CharacterProfessionState;
  readonly rulesVersion: number;
  readonly craftedAt: Date;
}

export interface CurrencyReconciliationResult {
  readonly currencyCode: string;
  readonly isBalanced: boolean;
  readonly totalMinted: bigint;
  readonly totalDestroyed: bigint;
  readonly expectedCirculatingSupply: bigint;
  readonly actualCirculatingSupply: bigint;
  readonly activeEscrowBalance: bigint;
  readonly activeReservationsUnresolvedSum: bigint;
  readonly totalLedgerDebits: bigint;
  readonly totalLedgerCredits: bigint;
  readonly accountDiscrepancies: ReadonlyArray<{
    readonly accountId: string;
    readonly ownerType: CurrencyAccountOwnerType;
    readonly storedBalance: bigint;
    readonly reconstructedBalance: bigint;
  }>;
}

export interface EconomicObservabilityReport {
  readonly generatedAt: Date;
  readonly currencies: ReadonlyArray<CurrencyReconciliationResult>;
  readonly activeMonetaryReservationsCount: number;
  readonly activeAssetEscrowHoldingsCount: number;
  readonly completedPlayerTradesCount: number;
  readonly openMarketListingsCount: number;
  readonly completedMarketSalesCount: number;
  readonly regionalTaxCollectedByCurrency: Readonly<Record<string, string>>;
  readonly equipmentGeneratedByCraftingCount: number;
  readonly totalMaterialsConsumedInCrafting: number;
  readonly authoritativeRewardGrantsCount: number;
  readonly fundedActiveBountiesCount: number;
  readonly settledBountyClaimsCount: number;
}

/**
 * Proposed non-persistent contract for future Genesis Ranked MD3 temporary match economy (Section 29).
 * Lives strictly in ephemeral match memory inside NEON; CARBON forbids persisting any Genesis economy state.
 */
export interface EphemeralGenesisMatchEconomyProposalV1 {
  readonly contractVersion: 1;
  readonly matchId: string;
  readonly seriesFormat: "MD3";
  readonly participantEphemeralCharacterId: string;
  readonly temporaryMatchGold: string;
  readonly temporaryMerchantPurchases: ReadonlyArray<{
    readonly roundNumber: 1 | 2 | 3;
    readonly temporaryOfferCode: string;
    readonly costPaid: string;
  }>;
  readonly persistenceAllowed: false;
}
