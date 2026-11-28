-- Migration: 0013_monetary_currencies_wallets_ledger_and_escrow (UP)
-- CARBON Session 07 (Stages A & B): Versioned Currencies, Economic Rules, Persistent Wallets & Treasuries,
-- Append-Only Double-Entry Monetary Ledger, Verifiable Monetary Reservations, Physical Asset Escrow,
-- and Direct Player-to-Player Bilateral Trade Sessions.

CREATE TABLE economic_rules_versions (
    rules_version INTEGER PRIMARY KEY,
    code VARCHAR(64) NOT NULL UNIQUE,
    default_market_listing_fee_bp INTEGER NOT NULL DEFAULT 100,
    default_market_sale_tax_bp INTEGER NOT NULL DEFAULT 500,
    max_tax_rate_bp INTEGER NOT NULL DEFAULT 2500,
    default_repair_cost_per_durability BIGINT NOT NULL DEFAULT 5,
    repair_treasury_share_bp INTEGER NOT NULL DEFAULT 5000,
    crafting_station_tax_treasury_share_bp INTEGER NOT NULL DEFAULT 5000,
    bounty_escrow_currency_code VARCHAR(32) NOT NULL DEFAULT 'ascendra_coin',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_economic_rules_bounds CHECK (
        rules_version >= 1
        AND char_length(btrim(code)) > 0
        AND default_market_listing_fee_bp BETWEEN 0 AND max_tax_rate_bp
        AND default_market_sale_tax_bp BETWEEN 0 AND max_tax_rate_bp
        AND max_tax_rate_bp BETWEEN 0 AND 5000
        AND default_repair_cost_per_durability >= 0
        AND repair_treasury_share_bp BETWEEN 0 AND 10000
        AND crafting_station_tax_treasury_share_bp BETWEEN 0 AND 10000
    )
);

CREATE TABLE currencies (
    currency_code VARCHAR(32) PRIMARY KEY,
    display_name VARCHAR(120) NOT NULL,
    description TEXT NOT NULL,
    smallest_unit_name VARCHAR(32) NOT NULL,
    denomination_notes JSONB NOT NULL DEFAULT '{}'::jsonb,
    maximum_balance BIGINT NOT NULL,
    is_tradeable BOOLEAN NOT NULL,
    is_transferable BOOLEAN NOT NULL,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    rules_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_currencies_rules
        FOREIGN KEY (rules_version) REFERENCES economic_rules_versions(rules_version) ON DELETE RESTRICT,
    CONSTRAINT chk_currencies_code
        CHECK (currency_code ~ '^[a-z][a-z0-9_]{1,31}$'),
    CONSTRAINT chk_currencies_bounds
        CHECK (
            maximum_balance > 0
            AND char_length(btrim(display_name)) > 0
            AND char_length(btrim(smallest_unit_name)) > 0
            AND rules_version >= 1
        )
);

CREATE TABLE currency_accounts (
    id UUID PRIMARY KEY,
    owner_type VARCHAR(32) NOT NULL,
    owner_id VARCHAR(128) NOT NULL,
    owner_character_id UUID NULL,
    owner_settlement_id UUID NULL,
    owner_faction_id UUID NULL,
    currency_code VARCHAR(32) NOT NULL,
    balance BIGINT NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_currency_accounts_character
        FOREIGN KEY (owner_character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_currency_accounts_settlement
        FOREIGN KEY (owner_settlement_id) REFERENCES settlements(id) ON DELETE RESTRICT,
    CONSTRAINT fk_currency_accounts_faction
        FOREIGN KEY (owner_faction_id) REFERENCES factions(id) ON DELETE RESTRICT,
    CONSTRAINT fk_currency_accounts_currency
        FOREIGN KEY (currency_code) REFERENCES currencies(currency_code) ON DELETE RESTRICT,
    CONSTRAINT uq_currency_accounts_owner_currency
        UNIQUE (owner_type, owner_id, currency_code),
    CONSTRAINT chk_currency_accounts_owner_type
        CHECK (
            owner_type IN (
                'player_wallet',
                'settlement_treasury',
                'faction_treasury',
                'system_mint',
                'system_sink',
                'escrow_account',
                'merchant_account'
            )
        ),
    CONSTRAINT chk_currency_accounts_owner_coherence
        CHECK (
            (owner_type = 'player_wallet' AND owner_character_id IS NOT NULL AND owner_settlement_id IS NULL AND owner_faction_id IS NULL AND owner_id = owner_character_id::text)
            OR (owner_type = 'settlement_treasury' AND owner_settlement_id IS NOT NULL AND owner_character_id IS NULL AND owner_faction_id IS NULL AND owner_id = owner_settlement_id::text)
            OR (owner_type = 'faction_treasury' AND owner_faction_id IS NOT NULL AND owner_character_id IS NULL AND owner_settlement_id IS NULL AND owner_id = owner_faction_id::text)
            OR (owner_type IN ('system_mint', 'system_sink', 'escrow_account', 'merchant_account') AND owner_character_id IS NULL AND char_length(btrim(owner_id)) > 0)
        ),
    CONSTRAINT chk_currency_accounts_status_and_balance
        CHECK (
            balance >= 0
            AND version >= 1
            AND status IN ('active', 'frozen', 'closed')
        )
);

CREATE INDEX idx_currency_accounts_character
    ON currency_accounts(owner_character_id, currency_code)
    WHERE owner_character_id IS NOT NULL;

CREATE TABLE currency_ledger_transactions (
    id UUID PRIMARY KEY,
    ledger_tx_seq BIGSERIAL NOT NULL,
    processed_event_id UUID NULL,
    idempotency_key VARCHAR(255) NOT NULL,
    operation_type VARCHAR(64) NOT NULL,
    currency_code VARCHAR(32) NOT NULL,
    total_amount BIGINT NOT NULL,
    correlation_id VARCHAR(128) NOT NULL,
    source_event_id VARCHAR(255) NOT NULL,
    actor_type VARCHAR(32) NOT NULL,
    actor_id VARCHAR(128) NOT NULL,
    is_compensating BOOLEAN NOT NULL DEFAULT FALSE,
    compensates_tx_id UUID NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    rules_version INTEGER NOT NULL DEFAULT 1,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_currency_ledger_tx_processed
        FOREIGN KEY (processed_event_id) REFERENCES processed_events(event_id) ON DELETE RESTRICT,
    CONSTRAINT fk_currency_ledger_tx_currency
        FOREIGN KEY (currency_code) REFERENCES currencies(currency_code) ON DELETE RESTRICT,
    CONSTRAINT fk_currency_ledger_tx_compensates
        FOREIGN KEY (compensates_tx_id) REFERENCES currency_ledger_transactions(id) ON DELETE RESTRICT,
    CONSTRAINT uq_currency_ledger_tx_idempotency
        UNIQUE (idempotency_key),
    CONSTRAINT chk_currency_ledger_tx_op_type
        CHECK (
            operation_type IN (
                'currency_mint',
                'currency_transfer',
                'currency_sink',
                'escrow_reserve',
                'escrow_consume',
                'escrow_release',
                'escrow_cancel',
                'player_trade_settlement',
                'market_listing_fee',
                'market_sale_settlement',
                'npc_merchant_purchase',
                'npc_merchant_buyback',
                'equipment_repair_fee',
                'crafting_fee',
                'bounty_payout_settlement',
                'world_event_reward_mint',
                'admin_compensating_entry'
            )
        ),
    CONSTRAINT chk_currency_ledger_tx_bounds
        CHECK (
            total_amount > 0
            AND char_length(btrim(idempotency_key)) > 0
            AND char_length(btrim(correlation_id)) > 0
            AND char_length(btrim(source_event_id)) > 0
            AND char_length(btrim(actor_id)) > 0
            AND rules_version >= 1
            AND (NOT is_compensating OR compensates_tx_id IS NOT NULL)
        )
);

CREATE INDEX idx_currency_ledger_tx_seq
    ON currency_ledger_transactions(currency_code, ledger_tx_seq ASC);

CREATE TABLE currency_ledger_entries (
    id UUID PRIMARY KEY,
    ledger_entry_seq BIGSERIAL NOT NULL,
    transaction_id UUID NOT NULL,
    entry_ordinal INTEGER NOT NULL,
    debit_account_id UUID NOT NULL,
    credit_account_id UUID NOT NULL,
    currency_code VARCHAR(32) NOT NULL,
    amount BIGINT NOT NULL,
    debit_balance_after BIGINT NOT NULL,
    credit_balance_after BIGINT NOT NULL,
    memo VARCHAR(255) NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_currency_ledger_entries_tx
        FOREIGN KEY (transaction_id) REFERENCES currency_ledger_transactions(id) ON DELETE RESTRICT,
    CONSTRAINT fk_currency_ledger_entries_debit
        FOREIGN KEY (debit_account_id) REFERENCES currency_accounts(id) ON DELETE RESTRICT,
    CONSTRAINT fk_currency_ledger_entries_credit
        FOREIGN KEY (credit_account_id) REFERENCES currency_accounts(id) ON DELETE RESTRICT,
    CONSTRAINT fk_currency_ledger_entries_currency
        FOREIGN KEY (currency_code) REFERENCES currencies(currency_code) ON DELETE RESTRICT,
    CONSTRAINT uq_currency_ledger_entries_ordinal
        UNIQUE (transaction_id, entry_ordinal),
    CONSTRAINT chk_currency_ledger_entries_bounds
        CHECK (
            entry_ordinal >= 0
            AND amount > 0
            AND debit_balance_after >= 0
            AND credit_balance_after >= 0
            AND debit_account_id <> credit_account_id
            AND char_length(btrim(memo)) > 0
        )
);

CREATE INDEX idx_currency_ledger_entries_debit
    ON currency_ledger_entries(debit_account_id, ledger_entry_seq ASC);
CREATE INDEX idx_currency_ledger_entries_credit
    ON currency_ledger_entries(credit_account_id, ledger_entry_seq ASC);

-- Enforce strict append-only immutability on monetary ledger tables
CREATE OR REPLACE FUNCTION fn_forbid_monetary_ledger_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Monetary ledger table % is append-only; retroactive UPDATE/DELETE is forbidden (use compensating transactions)', TG_TABLE_NAME
        USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER trg_forbid_currency_ledger_tx_mutation
BEFORE UPDATE OR DELETE ON currency_ledger_transactions
FOR EACH ROW
EXECUTE FUNCTION fn_forbid_monetary_ledger_mutation();

CREATE TRIGGER trg_forbid_currency_ledger_entries_mutation
BEFORE UPDATE OR DELETE ON currency_ledger_entries
FOR EACH ROW
EXECUTE FUNCTION fn_forbid_monetary_ledger_mutation();

CREATE TABLE currency_reservations (
    id UUID PRIMARY KEY,
    owner_wallet_id UUID NOT NULL,
    owner_character_id UUID NULL,
    escrow_account_id UUID NOT NULL,
    currency_code VARCHAR(32) NOT NULL,
    reserved_amount BIGINT NOT NULL,
    consumed_amount BIGINT NOT NULL DEFAULT 0,
    released_amount BIGINT NOT NULL DEFAULT 0,
    purpose VARCHAR(32) NOT NULL,
    reference_id VARCHAR(128) NOT NULL,
    reserve_ledger_tx_id UUID NOT NULL,
    resolution_ledger_tx_id UUID NULL,
    status VARCHAR(32) NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_currency_reservations_owner_wallet
        FOREIGN KEY (owner_wallet_id) REFERENCES currency_accounts(id) ON DELETE RESTRICT,
    CONSTRAINT fk_currency_reservations_character
        FOREIGN KEY (owner_character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_currency_reservations_escrow_acc
        FOREIGN KEY (escrow_account_id) REFERENCES currency_accounts(id) ON DELETE RESTRICT,
    CONSTRAINT fk_currency_reservations_currency
        FOREIGN KEY (currency_code) REFERENCES currencies(currency_code) ON DELETE RESTRICT,
    CONSTRAINT fk_currency_reservations_reserve_tx
        FOREIGN KEY (reserve_ledger_tx_id) REFERENCES currency_ledger_transactions(id) ON DELETE RESTRICT,
    CONSTRAINT fk_currency_reservations_resolution_tx
        FOREIGN KEY (resolution_ledger_tx_id) REFERENCES currency_ledger_transactions(id) ON DELETE RESTRICT,
    CONSTRAINT uq_currency_reservations_reserve_tx
        UNIQUE (reserve_ledger_tx_id),
    CONSTRAINT chk_currency_reservations_purpose
        CHECK (purpose IN ('player_trade', 'market_order', 'criminal_bounty', 'service_hold')),
    CONSTRAINT chk_currency_reservations_status
        CHECK (status IN ('Reserved', 'Consumed', 'Released', 'Cancelled')),
    CONSTRAINT chk_currency_reservations_conservation
        CHECK (
            reserved_amount > 0
            AND consumed_amount >= 0
            AND released_amount >= 0
            AND consumed_amount + released_amount <= reserved_amount
            AND (
                (status = 'Reserved' AND consumed_amount + released_amount < reserved_amount)
                OR (status IN ('Consumed', 'Released', 'Cancelled') AND consumed_amount + released_amount = reserved_amount AND resolution_ledger_tx_id IS NOT NULL)
            )
            AND char_length(btrim(reference_id)) > 0
            AND version >= 1
        )
);

CREATE INDEX idx_currency_reservations_owner_status
    ON currency_reservations(owner_wallet_id, status);
CREATE INDEX idx_currency_reservations_purpose_ref
    ON currency_reservations(purpose, reference_id);

-- Incrementally extend physical custody location_state & item_operation_ledger op types without touching 0001..0012
ALTER TABLE item_instances
    DROP CONSTRAINT chk_item_instances_single_location,
    ADD CONSTRAINT chk_item_instances_single_location
        CHECK (
            (location_state = 'in_container' AND container_id IS NOT NULL AND container_slot_index IS NOT NULL AND container_slot_index >= 0)
            OR (location_state IN ('equipped_active', 'in_escrow', 'destroyed') AND container_id IS NULL AND container_slot_index IS NULL)
        );

ALTER TABLE item_operation_ledger
    DROP CONSTRAINT chk_item_ledger_op_type,
    ADD CONSTRAINT chk_item_ledger_op_type
        CHECK (
            operation_type IN (
                'grant', 'move', 'equip', 'unequip', 'split', 'merge',
                'transfer', 'destroy', 'durability_loss', 'repair', 'loadout_activate',
                'escrow_lock', 'escrow_release', 'escrow_settle', 'consume', 'craft'
            )
        );

CREATE TABLE escrow_asset_holdings (
    id UUID PRIMARY KEY,
    owner_account_id UUID NOT NULL,
    owner_character_id UUID NOT NULL,
    purpose VARCHAR(32) NOT NULL,
    reference_id UUID NOT NULL,
    asset_kind VARCHAR(32) NOT NULL,
    item_instance_id UUID NULL,
    source_stack_id UUID NULL,
    definition_code VARCHAR(64) NOT NULL,
    definition_version INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    remaining_quantity INTEGER NOT NULL,
    quality_bp INTEGER NOT NULL,
    binding_state VARCHAR(32) NOT NULL,
    bound_account_id UUID NULL,
    bound_character_id UUID NULL,
    stack_equivalence_key VARCHAR(160) NULL,
    status VARCHAR(32) NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_escrow_holdings_account
        FOREIGN KEY (owner_account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
    CONSTRAINT fk_escrow_holdings_character
        FOREIGN KEY (owner_character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_escrow_holdings_instance
        FOREIGN KEY (item_instance_id) REFERENCES item_instances(id) ON DELETE RESTRICT,
    CONSTRAINT fk_escrow_holdings_definition
        FOREIGN KEY (definition_code, definition_version)
        REFERENCES item_definitions(definition_code, definition_version) ON DELETE RESTRICT,
    CONSTRAINT chk_escrow_holdings_purpose
        CHECK (purpose IN ('player_trade', 'market_listing')),
    CONSTRAINT chk_escrow_holdings_kind_coherence
        CHECK (
            (asset_kind = 'equipment_instance' AND item_instance_id IS NOT NULL AND quantity = 1 AND stack_equivalence_key IS NULL)
            OR (asset_kind = 'material_stack' AND item_instance_id IS NULL AND quantity >= 1 AND stack_equivalence_key IS NOT NULL)
        ),
    CONSTRAINT chk_escrow_holdings_status_bounds
        CHECK (
            status IN ('held', 'settled', 'released')
            AND remaining_quantity >= 0
            AND remaining_quantity <= quantity
            AND (
                (status = 'held' AND remaining_quantity > 0)
                OR (status IN ('settled', 'released') AND remaining_quantity = 0)
            )
            AND quality_bp BETWEEN 0 AND 10000
            AND version >= 1
        )
);

CREATE UNIQUE INDEX uq_escrow_active_item_instance
    ON escrow_asset_holdings(item_instance_id)
    WHERE status = 'held' AND item_instance_id IS NOT NULL;

CREATE INDEX idx_escrow_holdings_ref
    ON escrow_asset_holdings(purpose, reference_id, status);

CREATE TABLE trade_sessions (
    id UUID PRIMARY KEY,
    participant_a_character_id UUID NOT NULL,
    participant_b_character_id UUID NOT NULL,
    settlement_id UUID NULL,
    offer_version INTEGER NOT NULL DEFAULT 1,
    participant_a_confirmed_version INTEGER NULL,
    participant_b_confirmed_version INTEGER NULL,
    participant_a_currency_code VARCHAR(32) NOT NULL DEFAULT 'ascendra_coin',
    participant_a_currency_amount BIGINT NOT NULL DEFAULT 0,
    participant_a_reservation_id UUID NULL,
    participant_b_currency_code VARCHAR(32) NOT NULL DEFAULT 'ascendra_coin',
    participant_b_currency_amount BIGINT NOT NULL DEFAULT 0,
    participant_b_reservation_id UUID NULL,
    status VARCHAR(32) NOT NULL,
    settlement_ledger_tx_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_trade_sessions_char_a
        FOREIGN KEY (participant_a_character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_trade_sessions_char_b
        FOREIGN KEY (participant_b_character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_trade_sessions_settlement
        FOREIGN KEY (settlement_id) REFERENCES settlements(id) ON DELETE RESTRICT,
    CONSTRAINT fk_trade_sessions_curr_a
        FOREIGN KEY (participant_a_currency_code) REFERENCES currencies(currency_code) ON DELETE RESTRICT,
    CONSTRAINT fk_trade_sessions_curr_b
        FOREIGN KEY (participant_b_currency_code) REFERENCES currencies(currency_code) ON DELETE RESTRICT,
    CONSTRAINT fk_trade_sessions_res_a
        FOREIGN KEY (participant_a_reservation_id) REFERENCES currency_reservations(id) ON DELETE RESTRICT,
    CONSTRAINT fk_trade_sessions_res_b
        FOREIGN KEY (participant_b_reservation_id) REFERENCES currency_reservations(id) ON DELETE RESTRICT,
    CONSTRAINT chk_trade_sessions_bounds
        CHECK (
            participant_a_character_id <> participant_b_character_id
            AND status IN ('PendingAcceptance', 'Negotiating', 'Completed', 'Cancelled', 'Expired')
            AND offer_version >= 1
            AND participant_a_currency_amount >= 0
            AND participant_b_currency_amount >= 0
            AND version >= 1
        )
);

CREATE INDEX idx_trade_sessions_participants
    ON trade_sessions(participant_a_character_id, participant_b_character_id, status);

CREATE TABLE trade_offer_assets (
    id UUID PRIMARY KEY,
    trade_id UUID NOT NULL,
    side VARCHAR(8) NOT NULL,
    escrow_holding_id UUID NOT NULL,
    asset_kind VARCHAR(32) NOT NULL,
    item_instance_id UUID NULL,
    definition_code VARCHAR(64) NOT NULL,
    definition_version INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    quality_bp INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_trade_offer_assets_trade
        FOREIGN KEY (trade_id) REFERENCES trade_sessions(id) ON DELETE CASCADE,
    CONSTRAINT fk_trade_offer_assets_holding
        FOREIGN KEY (escrow_holding_id) REFERENCES escrow_asset_holdings(id) ON DELETE RESTRICT,
    CONSTRAINT fk_trade_offer_assets_instance
        FOREIGN KEY (item_instance_id) REFERENCES item_instances(id) ON DELETE RESTRICT,
    CONSTRAINT uq_trade_offer_assets_holding
        UNIQUE (escrow_holding_id),
    CONSTRAINT chk_trade_offer_assets_bounds
        CHECK (
            side IN ('A', 'B')
            AND asset_kind IN ('equipment_instance', 'material_stack')
            AND quantity > 0
            AND quality_bp BETWEEN 0 AND 10000
        )
);

CREATE INDEX idx_trade_offer_assets_trade
    ON trade_offer_assets(trade_id, side);

-- Seed baseline economic rules & primary currencies so pre-existing characters/settlements/factions backfill cleanly
INSERT INTO economic_rules_versions (
    rules_version, code, default_market_listing_fee_bp, default_market_sale_tax_bp,
    max_tax_rate_bp, default_repair_cost_per_durability, repair_treasury_share_bp,
    crafting_station_tax_treasury_share_bp, bounty_escrow_currency_code, is_active
)
VALUES (1, 'dev_economy_rules_v1', 100, 500, 2500, 5, 5000, 5000, 'ascendra_coin', TRUE)
ON CONFLICT (rules_version) DO NOTHING;

INSERT INTO currencies (
    currency_code, display_name, description, smallest_unit_name, denomination_notes,
    maximum_balance, is_tradeable, is_transferable, is_enabled, rules_version
)
VALUES
    (
        'ascendra_coin',
        'Moeda Imperial (Cobre/Prata/Ouro)',
        'Moeda principal negociável expressa em unidades atômicas de cobre (100 cobre = 1 prata; 10.000 cobre = 1 ouro).',
        'copper',
        '{"copper_per_silver": 100, "copper_per_gold": 10000}'::jsonb,
        9000000000000000,
        TRUE,
        TRUE,
        TRUE,
        1
    ),
    (
        'astral_shard',
        'Fragmento Especial Astral',
        'Moeda vinculada obtida em anomalias e conteúdos de alto risco; não negociável entre jogadores.',
        'shard',
        '{}'::jsonb,
        1000000000,
        FALSE,
        FALSE,
        TRUE,
        1
    ),
    (
        'ashvale_civic_token',
        'Insígnia Cívica de Ashvale',
        'Token regional de mérito cívico e serviços locais de Ashvale.',
        'token',
        '{"region_id": "region-ashvale"}'::jsonb,
        1000000000,
        FALSE,
        FALSE,
        TRUE,
        1
    ),
    (
        'world_event_commendation',
        'Comenda de Acontecimento Mundial',
        'Token concedido por contribuições elegíveis em cercos e defesas mundiais.',
        'commendation',
        '{}'::jsonb,
        1000000000,
        FALSE,
        FALSE,
        TRUE,
        1
    ),
    (
        'ranked_glory_token',
        'Insígnia Competitiva Planejada',
        'Moeda planejada e desabilitada para futuras temporadas ranqueadas.',
        'emblem',
        '{"planned": true}'::jsonb,
        1000000000,
        FALSE,
        FALSE,
        FALSE,
        1
    )
ON CONFLICT (currency_code) DO NOTHING;

-- Provision canonical technical system_mint, system_sink, and escrow_account per enabled currency
INSERT INTO currency_accounts (id, owner_type, owner_id, currency_code, balance, version, status)
SELECT
    md5('sys-mint:' || c.currency_code)::uuid,
    'system_mint',
    'canonical_mint',
    c.currency_code,
    0,
    1,
    'active'
FROM currencies c
WHERE c.is_enabled = TRUE
ON CONFLICT (owner_type, owner_id, currency_code) DO NOTHING;

INSERT INTO currency_accounts (id, owner_type, owner_id, currency_code, balance, version, status)
SELECT
    md5('sys-sink:' || c.currency_code)::uuid,
    'system_sink',
    'canonical_sink',
    c.currency_code,
    0,
    1,
    'active'
FROM currencies c
WHERE c.is_enabled = TRUE
ON CONFLICT (owner_type, owner_id, currency_code) DO NOTHING;

INSERT INTO currency_accounts (id, owner_type, owner_id, currency_code, balance, version, status)
SELECT
    md5('sys-escrow:' || c.currency_code)::uuid,
    'escrow_account',
    'canonical_escrow_pool',
    c.currency_code,
    0,
    1,
    'active'
FROM currencies c
WHERE c.is_enabled = TRUE
ON CONFLICT (owner_type, owner_id, currency_code) DO NOTHING;

-- Safe backfill of primary ascendra_coin wallets/treasuries for existing characters, settlements, and factions
INSERT INTO currency_accounts (id, owner_type, owner_id, owner_character_id, currency_code, balance, version, status)
SELECT
    md5('wallet:char:' || ch.id::text || ':ascendra_coin')::uuid,
    'player_wallet',
    ch.id::text,
    ch.id,
    'ascendra_coin',
    0,
    1,
    'active'
FROM characters ch
ON CONFLICT (owner_type, owner_id, currency_code) DO NOTHING;

INSERT INTO currency_accounts (id, owner_type, owner_id, owner_settlement_id, currency_code, balance, version, status)
SELECT
    md5('treasury:settlement:' || s.id::text || ':ascendra_coin')::uuid,
    'settlement_treasury',
    s.id::text,
    s.id,
    'ascendra_coin',
    0,
    1,
    'active'
FROM settlements s
ON CONFLICT (owner_type, owner_id, currency_code) DO NOTHING;

INSERT INTO currency_accounts (id, owner_type, owner_id, owner_faction_id, currency_code, balance, version, status)
SELECT
    md5('treasury:faction:' || f.id::text || ':ascendra_coin')::uuid,
    'faction_treasury',
    f.id::text,
    f.id,
    'ascendra_coin',
    0,
    1,
    'active'
FROM factions f
ON CONFLICT (owner_type, owner_id, currency_code) DO NOTHING;
