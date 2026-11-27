-- Migration: 0007_inventories_instances_loadouts_and_ledger (UP)
-- CARBON Session 04: Authoritative Containers, Unique Item Instances, Affix Rolls,
-- Material Stacks, Combat Equipment Loadouts, Provenance Grants, and Immutable Item Ledger.

CREATE TABLE inventory_containers (
    id UUID PRIMARY KEY,
    owner_character_id UUID NOT NULL,
    container_type VARCHAR(32) NOT NULL,
    capacity INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_inventory_containers_owner
        FOREIGN KEY (owner_character_id) REFERENCES characters(id) ON DELETE CASCADE,
    CONSTRAINT uq_inventory_containers_owner_type
        UNIQUE (owner_character_id, container_type),
    CONSTRAINT chk_inventory_containers_type
        CHECK (container_type IN ('character_inventory', 'personal_storage')),
    CONSTRAINT chk_inventory_containers_bounds
        CHECK (capacity BETWEEN 1 AND 500 AND version >= 1)
);

CREATE TABLE item_instances (
    id UUID PRIMARY KEY,
    definition_code VARCHAR(64) NOT NULL,
    definition_version INTEGER NOT NULL,
    owner_account_id UUID NOT NULL,
    owner_character_id UUID NOT NULL,
    location_state VARCHAR(32) NOT NULL,
    container_id UUID NULL,
    container_slot_index INTEGER NULL,
    item_level INTEGER NOT NULL,
    rarity_code VARCHAR(32) NOT NULL,
    quality_bp INTEGER NOT NULL,
    power_budget_total INTEGER NOT NULL,
    power_budget_spent INTEGER NOT NULL,
    implicit_attributes JSONB NOT NULL,
    generated_attributes JSONB NOT NULL,
    current_durability INTEGER NULL,
    max_durability INTEGER NULL,
    binding_state VARCHAR(32) NOT NULL,
    bound_account_id UUID NULL,
    bound_character_id UUID NULL,
    generation_rules_version INTEGER NOT NULL,
    generation_seed_hash VARCHAR(64) NOT NULL,
    origin_type VARCHAR(32) NOT NULL,
    origin_reference VARCHAR(128) NOT NULL,
    instance_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_item_instances_definition
        FOREIGN KEY (definition_code, definition_version)
        REFERENCES item_definitions(definition_code, definition_version) ON DELETE RESTRICT,
    CONSTRAINT fk_item_instances_owner_account
        FOREIGN KEY (owner_account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
    CONSTRAINT fk_item_instances_owner_character
        FOREIGN KEY (owner_character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_item_instances_container
        FOREIGN KEY (container_id) REFERENCES inventory_containers(id) ON DELETE RESTRICT,
    CONSTRAINT fk_item_instances_rarity
        FOREIGN KEY (rarity_code) REFERENCES item_rarities(rarity_code) ON DELETE RESTRICT,
    CONSTRAINT fk_item_instances_bound_account
        FOREIGN KEY (bound_account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
    CONSTRAINT fk_item_instances_bound_character
        FOREIGN KEY (bound_character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_item_instances_gen_rules
        FOREIGN KEY (generation_rules_version) REFERENCES item_generation_rules(rules_version) ON DELETE RESTRICT,
    CONSTRAINT chk_item_instances_single_location
        CHECK (
            (location_state = 'in_container' AND container_id IS NOT NULL AND container_slot_index IS NOT NULL AND container_slot_index >= 0)
            OR (location_state IN ('equipped_active', 'destroyed') AND container_id IS NULL AND container_slot_index IS NULL)
        ),
    CONSTRAINT chk_item_instances_level_quality_budget
        CHECK (
            item_level BETWEEN 1 AND 1000
            AND quality_bp BETWEEN 0 AND 10000
            AND power_budget_total >= 0
            AND power_budget_spent >= 0
            AND power_budget_spent <= power_budget_total
            AND instance_version >= 1
        ),
    CONSTRAINT chk_item_instances_durability
        CHECK (
            (max_durability IS NULL AND current_durability IS NULL)
            OR (max_durability > 0 AND current_durability BETWEEN 0 AND max_durability)
        ),
    CONSTRAINT chk_item_instances_binding_coherence
        CHECK (
            (binding_state IN ('unbound', 'bind_on_equip') AND bound_account_id IS NULL AND bound_character_id IS NULL)
            OR (binding_state = 'account_bound' AND bound_account_id IS NOT NULL AND bound_character_id IS NULL)
            OR (binding_state = 'character_bound' AND bound_account_id IS NOT NULL AND bound_character_id IS NOT NULL)
        ),
    CONSTRAINT chk_item_instances_origin_type
        CHECK (
            origin_type IN (
                'boss_drop', 'world_event_reward', 'dungeon_reward', 'quest_reward',
                'crafting', 'gathering', 'merchant_purchase', 'exploration',
                'trade', 'administrative_grant', 'dev_authorized'
            )
        ),
    CONSTRAINT chk_item_instances_origin_ref_not_blank
        CHECK (char_length(btrim(origin_reference)) > 0 AND char_length(btrim(generation_seed_hash)) >= 16)
);

CREATE UNIQUE INDEX uq_item_instances_container_slot
    ON item_instances(container_id, container_slot_index)
    WHERE location_state = 'in_container';

CREATE INDEX idx_item_instances_owner_character
    ON item_instances(owner_character_id, location_state);

CREATE TABLE item_instance_affixes (
    id UUID PRIMARY KEY,
    item_instance_id UUID NOT NULL,
    affix_code VARCHAR(64) NOT NULL,
    affix_version INTEGER NOT NULL,
    affix_kind VARCHAR(32) NOT NULL,
    exclusive_group VARCHAR(64) NOT NULL,
    rolled_magnitude INTEGER NOT NULL DEFAULT 0,
    attribute_key VARCHAR(32) NULL,
    special_effect_code VARCHAR(64) NULL,
    special_effect_params JSONB NULL,
    power_budget_cost INTEGER NOT NULL,
    slot_ordinal INTEGER NOT NULL,
    CONSTRAINT fk_item_instance_affixes_instance
        FOREIGN KEY (item_instance_id) REFERENCES item_instances(id) ON DELETE CASCADE,
    CONSTRAINT fk_item_instance_affixes_def
        FOREIGN KEY (affix_code, affix_version) REFERENCES affix_definitions(affix_code, affix_version) ON DELETE RESTRICT,
    CONSTRAINT fk_item_instance_affixes_effect
        FOREIGN KEY (special_effect_code) REFERENCES special_effect_definitions(effect_code) ON DELETE RESTRICT,
    CONSTRAINT uq_item_instance_affixes_no_duplicate_code
        UNIQUE (item_instance_id, affix_code),
    CONSTRAINT uq_item_instance_affixes_exclusive_group
        UNIQUE (item_instance_id, exclusive_group),
    CONSTRAINT chk_item_instance_affixes_bounds
        CHECK (rolled_magnitude >= 0 AND power_budget_cost >= 0 AND slot_ordinal >= 0)
);

CREATE TABLE inventory_stacks (
    id UUID PRIMARY KEY,
    container_id UUID NOT NULL,
    owner_character_id UUID NOT NULL,
    container_slot_index INTEGER NOT NULL,
    definition_code VARCHAR(64) NOT NULL,
    definition_version INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    quality_bp INTEGER NOT NULL DEFAULT 5000,
    binding_state VARCHAR(32) NOT NULL,
    bound_account_id UUID NULL,
    bound_character_id UUID NULL,
    stack_equivalence_key VARCHAR(160) NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_inventory_stacks_container
        FOREIGN KEY (container_id) REFERENCES inventory_containers(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventory_stacks_owner
        FOREIGN KEY (owner_character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventory_stacks_definition
        FOREIGN KEY (definition_code, definition_version)
        REFERENCES item_definitions(definition_code, definition_version) ON DELETE RESTRICT,
    CONSTRAINT fk_inventory_stacks_bound_account
        FOREIGN KEY (bound_account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventory_stacks_bound_character
        FOREIGN KEY (bound_character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT uq_inventory_stacks_container_slot
        UNIQUE (container_id, container_slot_index),
    CONSTRAINT chk_inventory_stacks_bounds
        CHECK (
            container_slot_index >= 0
            AND quantity BETWEEN 1 AND 9999
            AND quality_bp BETWEEN 0 AND 10000
            AND binding_state IN ('unbound', 'account_bound', 'character_bound')
            AND char_length(btrim(stack_equivalence_key)) > 0
            AND version >= 1
        )
);

CREATE INDEX idx_inventory_stacks_owner ON inventory_stacks(owner_character_id, container_id);

-- Enforce cross-table container slot exclusivity & capacity bounds directly in PostgreSQL
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
        SELECT capacity, owner_character_id INTO v_capacity, v_owner
        FROM inventory_containers WHERE id = NEW.container_id;

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
        SELECT capacity, owner_character_id INTO v_capacity, v_owner
        FROM inventory_containers WHERE id = NEW.container_id;

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

CREATE TRIGGER trg_item_instances_slot_integrity
BEFORE INSERT OR UPDATE ON item_instances
FOR EACH ROW
EXECUTE FUNCTION fn_enforce_container_slot_integrity();

CREATE TRIGGER trg_inventory_stacks_slot_integrity
BEFORE INSERT OR UPDATE ON inventory_stacks
FOR EACH ROW
EXECUTE FUNCTION fn_enforce_container_slot_integrity();

CREATE TABLE equipment_loadouts (
    id UUID PRIMARY KEY,
    character_id UUID NOT NULL,
    name VARCHAR(64) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_equipment_loadouts_character
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    CONSTRAINT uq_equipment_loadouts_character_name
        UNIQUE (character_id, name),
    CONSTRAINT chk_equipment_loadouts_name_and_version
        CHECK (char_length(btrim(name)) BETWEEN 1 AND 64 AND version >= 1)
);

CREATE UNIQUE INDEX uq_equipment_loadouts_single_active
    ON equipment_loadouts(character_id)
    WHERE is_active = TRUE;

CREATE TABLE equipment_loadout_slots (
    loadout_id UUID NOT NULL,
    slot_code VARCHAR(32) NOT NULL,
    item_instance_id UUID NOT NULL,
    occupies_off_hand BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (loadout_id, slot_code),
    CONSTRAINT fk_equipment_loadout_slots_loadout
        FOREIGN KEY (loadout_id) REFERENCES equipment_loadouts(id) ON DELETE CASCADE,
    CONSTRAINT fk_equipment_loadout_slots_instance
        FOREIGN KEY (item_instance_id) REFERENCES item_instances(id) ON DELETE CASCADE,
    CONSTRAINT uq_equipment_loadout_slots_unique_instance
        UNIQUE (loadout_id, item_instance_id),
    CONSTRAINT chk_equipment_loadout_slots_code
        CHECK (
            slot_code IN (
                'main_hand', 'off_hand', 'head', 'chest', 'hands', 'legs', 'feet',
                'waist', 'neck', 'ring_1', 'ring_2', 'back', 'trinket_1', 'trinket_2'
            )
        ),
    CONSTRAINT chk_equipment_loadout_two_handed_slot
        CHECK (NOT occupies_off_hand OR slot_code = 'main_hand')
);

CREATE TABLE item_grants (
    id UUID PRIMARY KEY,
    processed_event_id UUID NOT NULL,
    external_grant_id VARCHAR(255) NOT NULL,
    source_event_id VARCHAR(255) NOT NULL,
    recipient_character_id UUID NOT NULL,
    reward_slot_index INTEGER NOT NULL DEFAULT 0,
    grant_kind VARCHAR(32) NOT NULL,
    item_instance_id UUID NULL,
    stack_id UUID NULL,
    definition_code VARCHAR(64) NOT NULL,
    definition_version INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    origin_type VARCHAR(32) NOT NULL,
    origin_reference VARCHAR(128) NOT NULL,
    payload_fingerprint VARCHAR(80) NOT NULL,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_item_grants_processed_event
        FOREIGN KEY (processed_event_id) REFERENCES processed_events(event_id) ON DELETE RESTRICT,
    CONSTRAINT fk_item_grants_recipient
        FOREIGN KEY (recipient_character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_item_grants_instance
        FOREIGN KEY (item_instance_id) REFERENCES item_instances(id) ON DELETE RESTRICT,
    CONSTRAINT fk_item_grants_definition
        FOREIGN KEY (definition_code, definition_version)
        REFERENCES item_definitions(definition_code, definition_version) ON DELETE RESTRICT,
    CONSTRAINT uq_item_grants_processed_event
        UNIQUE (processed_event_id),
    CONSTRAINT uq_item_grants_external_grant_id
        UNIQUE (external_grant_id),
    CONSTRAINT uq_item_grants_boss_reward_slot
        UNIQUE (source_event_id, recipient_character_id, reward_slot_index),
    CONSTRAINT chk_item_grants_bounds
        CHECK (
            grant_kind IN ('equipment_instance', 'material_stack')
            AND reward_slot_index >= 0
            AND quantity > 0
            AND char_length(btrim(external_grant_id)) > 0
            AND char_length(btrim(source_event_id)) > 0
            AND char_length(btrim(payload_fingerprint)) >= 16
        )
);

CREATE TABLE item_operation_ledger (
    id UUID PRIMARY KEY,
    ledger_seq BIGSERIAL NOT NULL,
    operation_id VARCHAR(255) NOT NULL,
    operation_type VARCHAR(32) NOT NULL,
    character_id UUID NOT NULL,
    counterparty_character_id UUID NULL,
    item_instance_id UUID NULL,
    stack_id UUID NULL,
    definition_code VARCHAR(64) NOT NULL,
    definition_version INTEGER NOT NULL,
    source_location VARCHAR(128) NULL,
    destination_location VARCHAR(128) NULL,
    quantity INTEGER NOT NULL,
    entity_version INTEGER NOT NULL,
    cause_reference VARCHAR(255) NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_item_ledger_character
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_item_ledger_counterparty
        FOREIGN KEY (counterparty_character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_item_ledger_instance
        FOREIGN KEY (item_instance_id) REFERENCES item_instances(id) ON DELETE RESTRICT,
    CONSTRAINT chk_item_ledger_op_type
        CHECK (
            operation_type IN (
                'grant', 'move', 'equip', 'unequip', 'split', 'merge',
                'transfer', 'destroy', 'durability_loss', 'repair', 'loadout_activate'
            )
        ),
    CONSTRAINT chk_item_ledger_bounds
        CHECK (
            quantity > 0
            AND entity_version >= 1
            AND char_length(btrim(operation_id)) > 0
            AND char_length(btrim(cause_reference)) > 0
        )
);

CREATE INDEX idx_item_operation_ledger_character
    ON item_operation_ledger(character_id, ledger_seq ASC);
CREATE INDEX idx_item_operation_ledger_instance
    ON item_operation_ledger(item_instance_id, ledger_seq ASC)
    WHERE item_instance_id IS NOT NULL;

-- Safe backfill: provision primary 40-slot inventory and default active loadout for any pre-existing Session 03 characters
INSERT INTO inventory_containers (id, owner_character_id, container_type, capacity, version)
SELECT
    md5('init-inv:' || c.id::text)::uuid,
    c.id,
    'character_inventory',
    40,
    1
FROM characters c
ON CONFLICT (owner_character_id, container_type) DO NOTHING;

INSERT INTO equipment_loadouts (id, character_id, name, is_active, version)
SELECT
    md5('init-loadout:' || c.id::text)::uuid,
    c.id,
    'Principal',
    TRUE,
    1
FROM characters c
WHERE NOT EXISTS (
    SELECT 1 FROM equipment_loadouts el WHERE el.character_id = c.id AND el.is_active = TRUE
);
