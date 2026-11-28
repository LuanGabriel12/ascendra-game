-- Migration: 0014_regional_market_tax_policies_and_npc_merchants (UP)
-- CARBON Session 07 (Stage C): Versioned Regional Tax Policies, Settlement Market Listings,
-- Executed Market Sales History, and Controlled NPC Merchants & Offers.

CREATE TABLE regional_tax_policies (
    settlement_id UUID NOT NULL,
    policy_version INTEGER NOT NULL,
    listing_fee_bp INTEGER NOT NULL DEFAULT 100,
    sale_tax_bp INTEGER NOT NULL DEFAULT 500,
    crafting_tax_bp INTEGER NOT NULL DEFAULT 400,
    repair_tax_bp INTEGER NOT NULL DEFAULT 200,
    sink_burn_share_bp INTEGER NOT NULL DEFAULT 0,
    rounding_mode VARCHAR(32) NOT NULL DEFAULT 'floor_integer',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    rules_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (settlement_id, policy_version),
    CONSTRAINT fk_regional_tax_settlement
        FOREIGN KEY (settlement_id) REFERENCES settlements(id) ON DELETE RESTRICT,
    CONSTRAINT fk_regional_tax_rules
        FOREIGN KEY (rules_version) REFERENCES economic_rules_versions(rules_version) ON DELETE RESTRICT,
    CONSTRAINT chk_regional_tax_bounds
        CHECK (
            policy_version >= 1
            AND listing_fee_bp BETWEEN 0 AND 2500
            AND sale_tax_bp BETWEEN 0 AND 2500
            AND crafting_tax_bp BETWEEN 0 AND 2500
            AND repair_tax_bp BETWEEN 0 AND 2500
            AND sink_burn_share_bp BETWEEN 0 AND 10000
            AND rounding_mode IN ('floor_integer')
            AND rules_version >= 1
        )
);

CREATE TABLE market_listings (
    id UUID PRIMARY KEY,
    seller_account_id UUID NOT NULL,
    seller_character_id UUID NOT NULL,
    settlement_id UUID NOT NULL,
    escrow_holding_id UUID NOT NULL,
    asset_kind VARCHAR(32) NOT NULL,
    item_instance_id UUID NULL,
    definition_code VARCHAR(64) NOT NULL,
    definition_version INTEGER NOT NULL,
    initial_quantity INTEGER NOT NULL,
    remaining_quantity INTEGER NOT NULL,
    quality_bp INTEGER NOT NULL,
    rarity_code VARCHAR(32) NOT NULL,
    currency_code VARCHAR(32) NOT NULL,
    unit_price BIGINT NOT NULL,
    listing_fee_paid BIGINT NOT NULL DEFAULT 0,
    listing_fee_tx_id UUID NULL,
    tax_policy_version INTEGER NOT NULL DEFAULT 1,
    status VARCHAR(32) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_market_listings_seller_acc
        FOREIGN KEY (seller_account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
    CONSTRAINT fk_market_listings_seller_char
        FOREIGN KEY (seller_character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_market_listings_settlement
        FOREIGN KEY (settlement_id) REFERENCES settlements(id) ON DELETE RESTRICT,
    CONSTRAINT fk_market_listings_holding
        FOREIGN KEY (escrow_holding_id) REFERENCES escrow_asset_holdings(id) ON DELETE RESTRICT,
    CONSTRAINT fk_market_listings_instance
        FOREIGN KEY (item_instance_id) REFERENCES item_instances(id) ON DELETE RESTRICT,
    CONSTRAINT fk_market_listings_def
        FOREIGN KEY (definition_code, definition_version)
        REFERENCES item_definitions(definition_code, definition_version) ON DELETE RESTRICT,
    CONSTRAINT fk_market_listings_rarity
        FOREIGN KEY (rarity_code) REFERENCES item_rarities(rarity_code) ON DELETE RESTRICT,
    CONSTRAINT fk_market_listings_currency
        FOREIGN KEY (currency_code) REFERENCES currencies(currency_code) ON DELETE RESTRICT,
    CONSTRAINT fk_market_listings_fee_tx
        FOREIGN KEY (listing_fee_tx_id) REFERENCES currency_ledger_transactions(id) ON DELETE RESTRICT,
    CONSTRAINT uq_market_listings_holding
        UNIQUE (escrow_holding_id),
    CONSTRAINT chk_market_listings_bounds
        CHECK (
            asset_kind IN ('equipment_instance', 'material_stack')
            AND initial_quantity > 0
            AND remaining_quantity >= 0
            AND remaining_quantity <= initial_quantity
            AND quality_bp BETWEEN 0 AND 10000
            AND unit_price > 0
            AND listing_fee_paid >= 0
            AND tax_policy_version >= 1
            AND status IN ('Open', 'PartiallyFilled', 'Filled', 'Cancelled', 'Expired')
            AND (
                (status = 'Open' AND remaining_quantity = initial_quantity)
                OR (status = 'PartiallyFilled' AND remaining_quantity > 0 AND remaining_quantity < initial_quantity)
                OR (status = 'Filled' AND remaining_quantity = 0)
                OR (status IN ('Cancelled', 'Expired'))
            )
            AND version >= 1
        )
);

CREATE UNIQUE INDEX uq_market_listings_active_instance
    ON market_listings(item_instance_id)
    WHERE status IN ('Open', 'PartiallyFilled') AND item_instance_id IS NOT NULL;

CREATE INDEX idx_market_listings_regional_book
    ON market_listings(settlement_id, definition_code, status, unit_price ASC, created_at ASC);

CREATE TABLE market_sales (
    id UUID PRIMARY KEY,
    listing_id UUID NOT NULL,
    settlement_id UUID NOT NULL,
    seller_account_id UUID NOT NULL,
    seller_character_id UUID NOT NULL,
    buyer_account_id UUID NOT NULL,
    buyer_character_id UUID NOT NULL,
    definition_code VARCHAR(64) NOT NULL,
    definition_version INTEGER NOT NULL,
    item_instance_id UUID NULL,
    quantity INTEGER NOT NULL,
    unit_price BIGINT NOT NULL,
    gross_amount BIGINT NOT NULL,
    tax_amount BIGINT NOT NULL,
    treasury_tax_amount BIGINT NOT NULL,
    sink_burned_amount BIGINT NOT NULL,
    seller_net_amount BIGINT NOT NULL,
    currency_code VARCHAR(32) NOT NULL,
    ledger_tx_id UUID NOT NULL,
    is_same_account BOOLEAN NOT NULL,
    sold_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_market_sales_listing
        FOREIGN KEY (listing_id) REFERENCES market_listings(id) ON DELETE RESTRICT,
    CONSTRAINT fk_market_sales_settlement
        FOREIGN KEY (settlement_id) REFERENCES settlements(id) ON DELETE RESTRICT,
    CONSTRAINT fk_market_sales_seller_acc
        FOREIGN KEY (seller_account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
    CONSTRAINT fk_market_sales_seller_char
        FOREIGN KEY (seller_character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_market_sales_buyer_acc
        FOREIGN KEY (buyer_account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
    CONSTRAINT fk_market_sales_buyer_char
        FOREIGN KEY (buyer_character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_market_sales_currency
        FOREIGN KEY (currency_code) REFERENCES currencies(currency_code) ON DELETE RESTRICT,
    CONSTRAINT fk_market_sales_ledger_tx
        FOREIGN KEY (ledger_tx_id) REFERENCES currency_ledger_transactions(id) ON DELETE RESTRICT,
    CONSTRAINT uq_market_sales_ledger_tx
        UNIQUE (ledger_tx_id),
    CONSTRAINT chk_market_sales_conservation
        CHECK (
            seller_character_id <> buyer_character_id
            AND quantity > 0
            AND unit_price > 0
            AND gross_amount = unit_price * quantity
            AND tax_amount >= 0
            AND treasury_tax_amount >= 0
            AND sink_burned_amount >= 0
            AND seller_net_amount >= 0
            AND treasury_tax_amount + sink_burned_amount = tax_amount
            AND seller_net_amount + tax_amount = gross_amount
        )
);

CREATE INDEX idx_market_sales_regional_history
    ON market_sales(settlement_id, definition_code, currency_code, sold_at DESC);
CREATE INDEX idx_market_sales_seller_verified
    ON market_sales(seller_character_id, is_same_account, currency_code);

CREATE TABLE npc_merchants (
    merchant_code VARCHAR(64) PRIMARY KEY,
    display_name VARCHAR(120) NOT NULL,
    settlement_id UUID NOT NULL,
    funding_mode VARCHAR(40) NOT NULL,
    wallet_id UUID NULL,
    daily_buyback_budget_cap BIGINT NOT NULL DEFAULT 0,
    daily_buyback_spent BIGINT NOT NULL DEFAULT 0,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    rules_version INTEGER NOT NULL DEFAULT 1,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_npc_merchants_settlement
        FOREIGN KEY (settlement_id) REFERENCES settlements(id) ON DELETE RESTRICT,
    CONSTRAINT fk_npc_merchants_wallet
        FOREIGN KEY (wallet_id) REFERENCES currency_accounts(id) ON DELETE RESTRICT,
    CONSTRAINT chk_npc_merchants_bounds
        CHECK (
            merchant_code ~ '^[a-z][a-z0-9_]{1,63}$'
            AND char_length(btrim(display_name)) > 0
            AND funding_mode IN ('treasury_backed', 'controlled_system_faucet_sink')
            AND daily_buyback_budget_cap >= 0
            AND daily_buyback_spent >= 0
            AND daily_buyback_spent <= daily_buyback_budget_cap
            AND rules_version >= 1
            AND version >= 1
        )
);

CREATE TABLE npc_merchant_offers (
    id UUID PRIMARY KEY,
    merchant_code VARCHAR(64) NOT NULL,
    offer_code VARCHAR(64) NOT NULL,
    offer_kind VARCHAR(32) NOT NULL,
    definition_code VARCHAR(64) NULL,
    definition_version INTEGER NULL,
    currency_code VARCHAR(32) NOT NULL,
    unit_price BIGINT NOT NULL,
    stock_mode VARCHAR(32) NOT NULL,
    current_stock INTEGER NULL,
    max_stock INTEGER NULL,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_npc_offers_merchant
        FOREIGN KEY (merchant_code) REFERENCES npc_merchants(merchant_code) ON DELETE CASCADE,
    CONSTRAINT fk_npc_offers_def
        FOREIGN KEY (definition_code, definition_version)
        REFERENCES item_definitions(definition_code, definition_version) ON DELETE RESTRICT,
    CONSTRAINT fk_npc_offers_currency
        FOREIGN KEY (currency_code) REFERENCES currencies(currency_code) ON DELETE RESTRICT,
    CONSTRAINT uq_npc_offers_merchant_code
        UNIQUE (merchant_code, offer_code),
    CONSTRAINT chk_npc_offers_bounds
        CHECK (
            offer_kind IN ('sell_item_to_player', 'buy_item_from_player', 'repair_service')
            AND unit_price > 0
            AND stock_mode IN ('limited', 'unlimited_sink_source')
            AND (
                (stock_mode = 'unlimited_sink_source' AND current_stock IS NULL AND max_stock IS NULL)
                OR (stock_mode = 'limited' AND current_stock IS NOT NULL AND max_stock IS NOT NULL AND current_stock >= 0 AND max_stock >= current_stock)
            )
            AND (
                (offer_kind = 'repair_service' AND definition_code IS NULL AND definition_version IS NULL)
                OR (offer_kind IN ('sell_item_to_player', 'buy_item_from_player') AND definition_code IS NOT NULL AND definition_version IS NOT NULL)
            )
            AND version >= 1
        )
);
