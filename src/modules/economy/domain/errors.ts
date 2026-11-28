export class EconomyDomainError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class CurrencyNotFoundOrDisabledError extends EconomyDomainError {
  constructor(currencyCode: string) {
    super(
      "CURRENCY_NOT_FOUND_OR_DISABLED",
      `Currency '${currencyCode}' does not exist or is currently disabled.`,
    );
  }
}

export class CurrencyOperationForbiddenError extends EconomyDomainError {
  constructor(message: string) {
    super("CURRENCY_OPERATION_FORBIDDEN", message);
  }
}

export class WalletNotFoundOrInactiveError extends EconomyDomainError {
  constructor(message: string) {
    super("WALLET_NOT_FOUND_OR_INACTIVE", message);
  }
}

export class InsufficientFundsError extends EconomyDomainError {
  constructor(walletId: string, currencyCode: string, required: bigint, available: bigint) {
    super(
      "INSUFFICIENT_FUNDS",
      `Wallet '${walletId}' has insufficient '${currencyCode}' balance: required ${required.toString()}, available ${available.toString()}.`,
    );
  }
}

export class MonetaryOverflowOrBoundsError extends EconomyDomainError {
  constructor(message: string) {
    super("MONETARY_OVERFLOW_OR_BOUNDS", message);
  }
}

export class MonetaryLedgerImbalanceError extends EconomyDomainError {
  constructor(message: string) {
    super("MONETARY_LEDGER_IMBALANCE", message);
  }
}

export class EscrowReservationStateError extends EconomyDomainError {
  constructor(message: string) {
    super("ESCROW_RESERVATION_STATE_ERROR", message);
  }
}

export class AssetEscrowCustodyError extends EconomyDomainError {
  constructor(message: string) {
    super("ASSET_ESCROW_CUSTODY_ERROR", message);
  }
}

export class PlayerTradeInvalidStateError extends EconomyDomainError {
  constructor(message: string) {
    super("PLAYER_TRADE_INVALID_STATE", message);
  }
}

export class RegionalMarketInvalidError extends EconomyDomainError {
  constructor(message: string) {
    super("REGIONAL_MARKET_INVALID", message);
  }
}

export class NpcMerchantOperationError extends EconomyDomainError {
  constructor(message: string) {
    super("NPC_MERCHANT_OPERATION_ERROR", message);
  }
}

export class LootOrRewardInvalidError extends EconomyDomainError {
  constructor(message: string) {
    super("LOOT_OR_REWARD_INVALID", message);
  }
}

export class CraftingOrProfessionError extends EconomyDomainError {
  constructor(message: string) {
    super("CRAFTING_OR_PROFESSION_ERROR", message);
  }
}
