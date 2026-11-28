-- Migration: 0015_loot_fragments_bounty_escrow_crafting_and_professions (UP)
-- CARBON Session 07 (Stages D & E): Versioned Loot Tables, Individual Authoritative Reward Grants,
-- Character-Bound Anti-Bad-Luck Fragments, World Event Contribution Economic Rewards,
-- Verified Monetary Escrow Links on Criminal Bounties, Professions, Crafting Recipes & Operations,
-- and Item Crafter Provenance.

ALTER TABLE item_instances
    ADD COLUMN crafted_by_character_id UUID NULL,
    ADD COLUMN crafting_recipe_code VARCHAR(64) NULL,
    ADD CONSTRAINT fk_item_instances_crafted_by
        FOREIGN KEY (crafted_by_character_id) REFERENCES characters(id) ON DELETE RESTRICT;

ALTER TABLE criminal_bounties
    ADD COLUMN issuer_character_id UUID NULL,
    ADD COLUMN issuer_settlement_id UUID NULL,
    ADD COLUMN reservation_id UUID NULL,
    ADD CONSTRAINT fk_criminal_bounties_issuer_char
        FOREIGN KEY (issuer_character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    ADD CONSTRAINT fk_criminal_bounties_issuer_settlement
        FOREIGN KEY (issuer_settlement_id) REFERENCES settlements(id) ON DELETE RESTRICT,
    ADD CONSTRAINT fk_criminal_bounties_reservation
        FOREIGN KEY (reservation_id) REFERENCES currency_reservations(id) ON DELETE RESTRICT,
    ADD CONSTRAINT uq_criminal_bounties_reservation
        UNIQUE (reservation_id);

ALTER TABLE criminal_bounty_claims
    ADD COLUMN settlement_ledger_tx_id UUID NULL,
    ADD COLUMN settled_at TIMESTAMPTZ NULL,
    DROP CONSTRAINT chk_bounty_claim_payout_pending,
    ADD CONSTRAINT fk_bounty_claims_settlement_tx
        FOREIGN KEY (settlement_ledger_tx_id) REFERENCES currency_ledger_transactions(id) ON DELETE RESTRICT,
    ADD CONSTRAINT uq_bounty_claims_settlement_tx
        UNIQUE (settlement_ledger_tx_id),
    ADD CONSTRAINT chk_bounty_claim_payout_status
        CHECK (
            (payout_commitment_status = 'pending_economy_settlement' AND settlement_ledger_tx_id IS NULL)
            OR (payout_commitment_status = 'settled' AND settlement_ledger_tx_id IS NOT NULL AND settled_at IS NOT NULL)
        );

CREATE TABLE anti_bad_luck_fragments (
    fragment_code VARCHAR(64) PRIMARY KEY,
    display_name VARCHAR(120) NOT NULL,
    source_content_ref VARCHAR(128) NOT NULL,
    binding_policy VARCHAR(32) NOT NULL DEFAULT 'character_bound',
    redemption_cost INTEGER NOT NULL,
    reward_pool JSONB NOT NULL,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    rules_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_fragments_bounds
        CHECK (
            fragment_code ~ '^[a-z][a-z0-9_]{1,63}$'
            AND char_length(btrim(display_name)) > 0
            AND char_length(btrim(source_content_ref)) > 0
            AND binding_policy IN ('character_bound')
            AND redemption_cost > 0
            AND rules_version >= 1
        )
);

CREATE TABLE character_fragment_balances (
    character_id UUID NOT NULL,
    fragment_code VARCHAR(64) NOT NULL,
    balance INTEGER NOT NULL DEFAULT 0,
    total_earned INTEGER NOT NULL DEFAULT 0,
    total_redeemed INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (character_id, fragment_code),
    CONSTRAINT fk_char_fragments_character
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    CONSTRAINT fk_char_fragments_def
        FOREIGN KEY (fragment_code) REFERENCES anti_bad_luck_fragments(fragment_code) ON DELETE RESTRICT,
    CONSTRAINT chk_char_fragments_conservation
        CHECK (
            balance >= 0
            AND total_earned >= 0
            AND total_redeemed >= 0
            AND total_earned - total_redeemed = balance
            AND version >= 1
        )
);

CREATE TABLE loot_tables (
    loot_table_code VARCHAR(64) NOT NULL,
    loot_table_version INTEGER NOT NULL,
    display_name VARCHAR(120) NOT NULL,
    source_category VARCHAR(32) NOT NULL,
    guaranteed_fragment_code VARCHAR(64) NULL,
    guaranteed_fragment_qty INTEGER NOT NULL DEFAULT 0,
    rolls_count INTEGER NOT NULL DEFAULT 1,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    rules_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (loot_table_code, loot_table_version),
    CONSTRAINT fk_loot_tables_fragment
        FOREIGN KEY (guaranteed_fragment_code) REFERENCES anti_bad_luck_fragments(fragment_code) ON DELETE RESTRICT,
    CONSTRAINT chk_loot_tables_bounds
        CHECK (
            loot_table_code ~ '^[a-z][a-z0-9_]{1,63}$'
            AND loot_table_version >= 1
            AND source_category IN ('boss', 'world_event', 'dungeon')
            AND guaranteed_fragment_qty >= 0
            AND (guaranteed_fragment_code IS NOT NULL OR guaranteed_fragment_qty = 0)
            AND rolls_count BETWEEN 1 AND 10
            AND rules_version >= 1
        )
);

CREATE TABLE loot_table_entries (
    id UUID PRIMARY KEY,
    loot_table_code VARCHAR(64) NOT NULL,
    loot_table_version INTEGER NOT NULL,
    entry_code VARCHAR(64) NOT NULL,
    entry_kind VARCHAR(32) NOT NULL,
    item_definition_code VARCHAR(64) NULL,
    item_definition_version INTEGER NULL,
    currency_code VARCHAR(32) NULL,
    weight INTEGER NOT NULL,
    min_quantity INTEGER NOT NULL,
    max_quantity INTEGER NOT NULL,
    allowed_rarities JSONB NOT NULL DEFAULT '[]'::jsonb,
    rarity_weights JSONB NOT NULL DEFAULT '{}'::jsonb,
    min_item_level INTEGER NOT NULL DEFAULT 1,
    max_item_level INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT fk_loot_entries_table
        FOREIGN KEY (loot_table_code, loot_table_version)
        REFERENCES loot_tables(loot_table_code, loot_table_version) ON DELETE CASCADE,
    CONSTRAINT fk_loot_entries_item
        FOREIGN KEY (item_definition_code, item_definition_version)
        REFERENCES item_definitions(definition_code, definition_version) ON DELETE RESTRICT,
    CONSTRAINT fk_loot_entries_currency
        FOREIGN KEY (currency_code) REFERENCES currencies(currency_code) ON DELETE RESTRICT,
    CONSTRAINT uq_loot_entries_code
        UNIQUE (loot_table_code, loot_table_version, entry_code),
    CONSTRAINT chk_loot_entries_bounds
        CHECK (
            entry_kind IN ('procedural_equipment', 'material_stack', 'currency_mint')
            AND weight > 0
            AND min_quantity > 0
            AND max_quantity >= min_quantity
            AND min_item_level >= 1
            AND max_item_level >= min_item_level
        )
);

CREATE TABLE reward_grants (
    id UUID PRIMARY KEY,
    processed_event_id UUID NOT NULL,
    reward_event_id VARCHAR(255) NOT NULL,
    source_type VARCHAR(32) NOT NULL,
    source_entity_id VARCHAR(128) NOT NULL,
    character_id UUID NOT NULL,
    loot_table_code VARCHAR(64) NULL,
    loot_table_version INTEGER NULL,
    eligibility_reference VARCHAR(255) NOT NULL,
    reward_slot_index INTEGER NOT NULL DEFAULT 0,
    generation_seed_hash VARCHAR(64) NOT NULL,
    reward_result JSONB NOT NULL,
    rules_version INTEGER NOT NULL DEFAULT 1,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_reward_grants_processed
        FOREIGN KEY (processed_event_id) REFERENCES processed_events(event_id) ON DELETE RESTRICT,
    CONSTRAINT fk_reward_grants_character
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_reward_grants_table
        FOREIGN KEY (loot_table_code, loot_table_version)
        REFERENCES loot_tables(loot_table_code, loot_table_version) ON DELETE RESTRICT,
    CONSTRAINT uq_reward_grants_processed
        UNIQUE (processed_event_id),
    CONSTRAINT uq_reward_grants_event_id
        UNIQUE (reward_event_id),
    CONSTRAINT uq_reward_grants_source_char_slot
        UNIQUE (source_type, source_entity_id, character_id, reward_slot_index),
    CONSTRAINT chk_reward_grants_bounds
        CHECK (
            source_type IN ('boss_kill', 'world_event_contribution', 'fragment_redemption')
            AND char_length(btrim(reward_event_id)) > 0
            AND char_length(btrim(source_entity_id)) > 0
            AND char_length(btrim(eligibility_reference)) > 0
            AND reward_slot_index >= 0
            AND char_length(btrim(generation_seed_hash)) >= 16
            AND rules_version >= 1
        )
);

CREATE TABLE fragment_redemptions (
    id UUID PRIMARY KEY,
    processed_event_id UUID NOT NULL,
    redemption_id VARCHAR(255) NOT NULL,
    character_id UUID NOT NULL,
    fragment_code VARCHAR(64) NOT NULL,
    fragments_consumed INTEGER NOT NULL,
    selected_reward_code VARCHAR(64) NOT NULL,
    item_instance_id UUID NULL,
    stack_id UUID NULL,
    reward_grant_id UUID NOT NULL,
    rules_version INTEGER NOT NULL DEFAULT 1,
    redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_fragment_redemptions_processed
        FOREIGN KEY (processed_event_id) REFERENCES processed_events(event_id) ON DELETE RESTRICT,
    CONSTRAINT fk_fragment_redemptions_char
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_fragment_redemptions_frag
        FOREIGN KEY (fragment_code) REFERENCES anti_bad_luck_fragments(fragment_code) ON DELETE RESTRICT,
    CONSTRAINT fk_fragment_redemptions_instance
        FOREIGN KEY (item_instance_id) REFERENCES item_instances(id) ON DELETE RESTRICT,
    CONSTRAINT fk_fragment_redemptions_grant
        FOREIGN KEY (reward_grant_id) REFERENCES reward_grants(id) ON DELETE RESTRICT,
    CONSTRAINT uq_fragment_redemptions_processed
        UNIQUE (processed_event_id),
    CONSTRAINT uq_fragment_redemptions_id
        UNIQUE (redemption_id),
    CONSTRAINT chk_fragment_redemptions_bounds
        CHECK (
            fragments_consumed > 0
            AND char_length(btrim(selected_reward_code)) > 0
            AND rules_version >= 1
        )
);

CREATE TABLE contribution_economic_rewards (
    contribution_id UUID PRIMARY KEY,
    character_id UUID NOT NULL,
    policy_code VARCHAR(64) NOT NULL,
    rules_version INTEGER NOT NULL DEFAULT 1,
    commendation_minted BIGINT NOT NULL DEFAULT 0,
    coin_stipend_minted BIGINT NOT NULL DEFAULT 0,
    commendation_tx_id UUID NULL,
    stipend_tx_id UUID NULL,
    reward_grant_id UUID NULL,
    rewarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_contrib_econ_rewards_contrib
        FOREIGN KEY (contribution_id) REFERENCES gameplay_contributions(id) ON DELETE RESTRICT,
    CONSTRAINT fk_contrib_econ_rewards_char
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_contrib_econ_rewards_comm_tx
        FOREIGN KEY (commendation_tx_id) REFERENCES currency_ledger_transactions(id) ON DELETE RESTRICT,
    CONSTRAINT fk_contrib_econ_rewards_stip_tx
        FOREIGN KEY (stipend_tx_id) REFERENCES currency_ledger_transactions(id) ON DELETE RESTRICT,
    CONSTRAINT fk_contrib_econ_rewards_grant
        FOREIGN KEY (reward_grant_id) REFERENCES reward_grants(id) ON DELETE RESTRICT,
    CONSTRAINT chk_contrib_econ_rewards_bounds
        CHECK (
            commendation_minted >= 0
            AND coin_stipend_minted >= 0
            AND char_length(btrim(policy_code)) > 0
            AND rules_version >= 1
        )
);

CREATE TABLE profession_definitions (
    profession_code VARCHAR(64) PRIMARY KEY,
    display_name VARCHAR(120) NOT NULL,
    category VARCHAR(32) NOT NULL,
    max_level INTEGER NOT NULL DEFAULT 100,
    is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    rules_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_profession_defs_bounds
        CHECK (
            profession_code ~ '^[a-z][a-z0-9_]{1,63}$'
            AND category IN ('crafting', 'gathering', 'commerce')
            AND max_level BETWEEN 1 AND 200
            AND rules_version >= 1
        )
);

CREATE TABLE character_professions (
    character_id UUID NOT NULL,
    profession_code VARCHAR(64) NOT NULL,
    profession_level INTEGER NOT NULL DEFAULT 1,
    profession_experience BIGINT NOT NULL DEFAULT 0,
    crafts_completed_count INTEGER NOT NULL DEFAULT 0,
    rules_version INTEGER NOT NULL DEFAULT 1,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (character_id, profession_code),
    CONSTRAINT fk_char_professions_char
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    CONSTRAINT fk_char_professions_def
        FOREIGN KEY (profession_code) REFERENCES profession_definitions(profession_code) ON DELETE RESTRICT,
    CONSTRAINT chk_char_professions_bounds
        CHECK (
            profession_level BETWEEN 1 AND 100
            AND profession_experience >= 0
            AND crafts_completed_count >= 0
            AND rules_version >= 1
            AND version >= 1
        )
);

CREATE TABLE crafting_recipes (
    recipe_code VARCHAR(64) NOT NULL,
    recipe_version INTEGER NOT NULL,
    display_name VARCHAR(120) NOT NULL,
    required_profession_code VARCHAR(64) NOT NULL,
    required_mastery_level INTEGER NOT NULL,
    required_station_code VARCHAR(64) NOT NULL,
    required_materials JSONB NOT NULL,
    currency_code VARCHAR(32) NOT NULL,
    currency_cost BIGINT NOT NULL DEFAULT 0,
    output_definition_code VARCHAR(64) NOT NULL,
    output_definition_version INTEGER NOT NULL,
    output_quantity INTEGER NOT NULL DEFAULT 1,
    allowed_rarities JSONB NOT NULL,
    min_quality_bp INTEGER NOT NULL,
    max_quality_bp INTEGER NOT NULL,
    profession_xp_granted BIGINT NOT NULL DEFAULT 0,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    rules_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (recipe_code, recipe_version),
    CONSTRAINT fk_crafting_recipes_prof
        FOREIGN KEY (required_profession_code) REFERENCES profession_definitions(profession_code) ON DELETE RESTRICT,
    CONSTRAINT fk_crafting_recipes_currency
        FOREIGN KEY (currency_code) REFERENCES currencies(currency_code) ON DELETE RESTRICT,
    CONSTRAINT fk_crafting_recipes_output
        FOREIGN KEY (output_definition_code, output_definition_version)
        REFERENCES item_definitions(definition_code, definition_version) ON DELETE RESTRICT,
    CONSTRAINT chk_crafting_recipes_bounds
        CHECK (
            recipe_code ~ '^[a-z][a-z0-9_]{1,63}$'
            AND recipe_version >= 1
            AND required_mastery_level BETWEEN 1 AND 100
            AND char_length(btrim(required_station_code)) > 0
            AND currency_cost >= 0
            AND output_quantity > 0
            AND min_quality_bp BETWEEN 0 AND 10000
            AND max_quality_bp BETWEEN min_quality_bp AND 10000
            AND profession_xp_granted >= 0
            AND rules_version >= 1
        )
);

CREATE TABLE crafting_operations (
    id UUID PRIMARY KEY,
    processed_event_id UUID NOT NULL,
    operation_id VARCHAR(255) NOT NULL,
    character_id UUID NOT NULL,
    settlement_id UUID NULL,
    recipe_code VARCHAR(64) NOT NULL,
    recipe_version INTEGER NOT NULL,
    station_code VARCHAR(64) NOT NULL,
    consumed_materials JSONB NOT NULL,
    currency_paid BIGINT NOT NULL DEFAULT 0,
    ledger_tx_id UUID NULL,
    produced_item_instance_id UUID NULL,
    produced_stack_id UUID NULL,
    rolled_rarity_code VARCHAR(32) NOT NULL,
    rolled_quality_bp INTEGER NOT NULL,
    profession_xp_awarded BIGINT NOT NULL DEFAULT 0,
    rules_version INTEGER NOT NULL DEFAULT 1,
    crafted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_crafting_ops_processed
        FOREIGN KEY (processed_event_id) REFERENCES processed_events(event_id) ON DELETE RESTRICT,
    CONSTRAINT fk_crafting_ops_char
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_crafting_ops_settlement
        FOREIGN KEY (settlement_id) REFERENCES settlements(id) ON DELETE RESTRICT,
    CONSTRAINT fk_crafting_ops_recipe
        FOREIGN KEY (recipe_code, recipe_version)
        REFERENCES crafting_recipes(recipe_code, recipe_version) ON DELETE RESTRICT,
    CONSTRAINT fk_crafting_ops_tx
        FOREIGN KEY (ledger_tx_id) REFERENCES currency_ledger_transactions(id) ON DELETE RESTRICT,
    CONSTRAINT fk_crafting_ops_instance
        FOREIGN KEY (produced_item_instance_id) REFERENCES item_instances(id) ON DELETE RESTRICT,
    CONSTRAINT uq_crafting_ops_processed
        UNIQUE (processed_event_id),
    CONSTRAINT uq_crafting_ops_operation_id
        UNIQUE (operation_id),
    CONSTRAINT chk_crafting_ops_bounds
        CHECK (
            currency_paid >= 0
            AND rolled_quality_bp BETWEEN 0 AND 10000
            AND profession_xp_awarded >= 0
            AND rules_version >= 1
        )
);

CREATE INDEX idx_crafting_ops_character
    ON crafting_operations(character_id, crafted_at DESC);
