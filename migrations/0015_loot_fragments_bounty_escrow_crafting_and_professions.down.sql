-- Migration: 0015_loot_fragments_bounty_escrow_crafting_and_professions (DOWN)

UPDATE title_definitions
SET title_version = 1,
    is_enabled = FALSE,
    visibility = 'hidden_until_unlocked',
    origin_summary = 'Planejado — aguarda sistema completo de profissões',
    requirements = '{"op":"PlannedSystemUnavailable","systemCode":"crafting_professions"}'::jsonb
WHERE title_code = 'legendary_blacksmith';

UPDATE title_definitions
SET title_version = 1,
    is_enabled = FALSE,
    visibility = 'hidden_until_unlocked',
    origin_summary = 'Planejado — aguarda economia monetária e mercado',
    requirements = '{"op":"PlannedSystemUnavailable","systemCode":"player_market_economy"}'::jsonb
WHERE title_code = 'imperial_merchant';

DROP TABLE IF EXISTS crafting_operations;
DROP TABLE IF EXISTS crafting_recipes;
DROP TABLE IF EXISTS character_professions;
DROP TABLE IF EXISTS profession_definitions;
DROP TABLE IF EXISTS contribution_economic_rewards;
DROP TABLE IF EXISTS fragment_redemptions;
DROP TABLE IF EXISTS reward_grants;
DROP TABLE IF EXISTS loot_table_entries;
DROP TABLE IF EXISTS loot_tables;
DROP TABLE IF EXISTS character_fragment_balances;
DROP TABLE IF EXISTS anti_bad_luck_fragments;

UPDATE criminal_bounty_claims
SET payout_commitment_status = 'pending_economy_settlement',
    settlement_ledger_tx_id = NULL,
    settled_at = NULL
WHERE payout_commitment_status = 'settled';

ALTER TABLE criminal_bounty_claims
    DROP CONSTRAINT IF EXISTS chk_bounty_claim_payout_status,
    DROP CONSTRAINT IF EXISTS uq_bounty_claims_settlement_tx,
    DROP CONSTRAINT IF EXISTS fk_bounty_claims_settlement_tx,
    DROP COLUMN IF EXISTS settled_at,
    DROP COLUMN IF EXISTS settlement_ledger_tx_id,
    ADD CONSTRAINT chk_bounty_claim_payout_pending
        CHECK (payout_commitment_status IN ('pending_economy_settlement'));

ALTER TABLE criminal_bounties
    DROP CONSTRAINT IF EXISTS uq_criminal_bounties_reservation,
    DROP CONSTRAINT IF EXISTS fk_criminal_bounties_reservation,
    DROP CONSTRAINT IF EXISTS fk_criminal_bounties_issuer_settlement,
    DROP CONSTRAINT IF EXISTS fk_criminal_bounties_issuer_char,
    DROP COLUMN IF EXISTS reservation_id,
    DROP COLUMN IF EXISTS issuer_settlement_id,
    DROP COLUMN IF EXISTS issuer_character_id;

ALTER TABLE item_instances
    DROP CONSTRAINT IF EXISTS fk_item_instances_crafted_by,
    DROP COLUMN IF EXISTS crafting_recipe_code,
    DROP COLUMN IF EXISTS crafted_by_character_id;
