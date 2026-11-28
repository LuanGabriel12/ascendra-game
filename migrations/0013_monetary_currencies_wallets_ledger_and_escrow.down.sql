-- Migration: 0013_monetary_currencies_wallets_ledger_and_escrow (DOWN)

DROP TABLE IF EXISTS trade_offer_assets;
DROP TABLE IF EXISTS trade_sessions;
DROP TABLE IF EXISTS escrow_asset_holdings;

DELETE FROM item_operation_ledger
WHERE operation_type IN ('escrow_lock', 'escrow_release', 'escrow_settle', 'consume', 'craft');

UPDATE item_instances
SET location_state = 'destroyed'
WHERE location_state = 'in_escrow';

ALTER TABLE item_operation_ledger
    DROP CONSTRAINT IF EXISTS chk_item_ledger_op_type,
    ADD CONSTRAINT chk_item_ledger_op_type
        CHECK (
            operation_type IN (
                'grant', 'move', 'equip', 'unequip', 'split', 'merge',
                'transfer', 'destroy', 'durability_loss', 'repair', 'loadout_activate'
            )
        );

ALTER TABLE item_instances
    DROP CONSTRAINT IF EXISTS chk_item_instances_single_location,
    ADD CONSTRAINT chk_item_instances_single_location
        CHECK (
            (location_state = 'in_container' AND container_id IS NOT NULL AND container_slot_index IS NOT NULL AND container_slot_index >= 0)
            OR (location_state IN ('equipped_active', 'destroyed') AND container_id IS NULL AND container_slot_index IS NULL)
        );

DROP TABLE IF EXISTS currency_reservations;

DROP TRIGGER IF EXISTS trg_forbid_currency_ledger_entries_mutation ON currency_ledger_entries;
DROP TRIGGER IF EXISTS trg_forbid_currency_ledger_tx_mutation ON currency_ledger_transactions;
DROP FUNCTION IF EXISTS fn_forbid_monetary_ledger_mutation();

DROP TABLE IF EXISTS currency_ledger_entries;
DROP TABLE IF EXISTS currency_ledger_transactions;
DROP TABLE IF EXISTS currency_accounts;
DROP TABLE IF EXISTS currencies;
DROP TABLE IF EXISTS economic_rules_versions;
