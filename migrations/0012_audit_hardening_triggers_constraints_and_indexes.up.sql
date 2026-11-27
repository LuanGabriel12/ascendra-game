-- Migration: 0012_audit_hardening_triggers_constraints_and_indexes (UP)
-- CARBON Full Engineering Audit (Sessions 01..06):
-- 1. Hardens `fn_enforce_container_slot_integrity()` with row-level `FOR UPDATE` locking on
--    `inventory_containers` to prevent cross-table (`item_instances` vs `inventory_stacks`)
--    slot double-occupancy under concurrent `READ COMMITTED` transactions (CARBON-AUD-003).
-- 2. Adds composite indexes for high-growth audit, outbox, inbox, and bounty lookup paths
--    without mutating historical migrations 0001..0011 (CARBON-AUD-009).

CREATE OR REPLACE FUNCTION fn_enforce_container_slot_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_capacity INTEGER;
    v_owner UUID;
BEGIN
    IF TG_TABLE_NAME = 'item_instances' THEN
        IF NEW.location_state <> 'in_container' THEN
            RETURN NEW;
        END IF;

        -- Serialize concurrent cross-table slot allocations on the parent container row
        SELECT capacity, owner_character_id INTO v_capacity, v_owner
        FROM inventory_containers
        WHERE id = NEW.container_id
        FOR UPDATE;

        IF v_capacity IS NULL THEN
            RAISE EXCEPTION 'Container % not found', NEW.container_id USING ERRCODE = '23503';
        END IF;
        IF v_owner <> NEW.owner_character_id THEN
            RAISE EXCEPTION 'Item owner % does not match container owner %', NEW.owner_character_id, v_owner USING ERRCODE = '23514';
        END IF;
        IF NEW.container_slot_index >= v_capacity THEN
            RAISE EXCEPTION 'Slot index % exceeds container capacity %', NEW.container_slot_index, v_capacity USING ERRCODE = '23514';
        END IF;
        IF EXISTS (
            SELECT 1 FROM inventory_stacks
            WHERE container_id = NEW.container_id AND container_slot_index = NEW.container_slot_index
        ) THEN
            RAISE EXCEPTION 'Container slot (%, %) already occupied by an inventory stack', NEW.container_id, NEW.container_slot_index USING ERRCODE = '23505';
        END IF;
    ELSIF TG_TABLE_NAME = 'inventory_stacks' THEN
        -- Serialize concurrent cross-table slot allocations on the parent container row
        SELECT capacity, owner_character_id INTO v_capacity, v_owner
        FROM inventory_containers
        WHERE id = NEW.container_id
        FOR UPDATE;

        IF v_capacity IS NULL THEN
            RAISE EXCEPTION 'Container % not found', NEW.container_id USING ERRCODE = '23503';
        END IF;
        IF v_owner <> NEW.owner_character_id THEN
            RAISE EXCEPTION 'Stack owner % does not match container owner %', NEW.owner_character_id, v_owner USING ERRCODE = '23514';
        END IF;
        IF NEW.container_slot_index >= v_capacity THEN
            RAISE EXCEPTION 'Slot index % exceeds container capacity %', NEW.container_slot_index, v_capacity USING ERRCODE = '23514';
        END IF;
        IF EXISTS (
            SELECT 1 FROM item_instances
            WHERE container_id = NEW.container_id
              AND container_slot_index = NEW.container_slot_index
              AND location_state = 'in_container'
        ) THEN
            RAISE EXCEPTION 'Container slot (%, %) already occupied by an item instance', NEW.container_id, NEW.container_slot_index USING ERRCODE = '23505';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_outbox_events_aggregate_created
    ON outbox_events(aggregate_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_item_operation_ledger_counterparty
    ON item_operation_ledger(counterparty_character_id, ledger_seq ASC)
    WHERE counterparty_character_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_criminal_bounties_target_status
    ON criminal_bounties(target_character_id, status);

CREATE INDEX IF NOT EXISTS idx_processed_events_aggregate_processed
    ON processed_events(aggregate_id, processed_at DESC);
