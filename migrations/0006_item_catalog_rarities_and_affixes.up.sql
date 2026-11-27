-- Migration: 0006_item_catalog_rarities_and_affixes (UP)
-- CARBON Session 04: Versioned Rarities (7 tiers), Special Effect Metadata Catalog,
-- Affix Definitions, Immutable Item Definitions, and Procedural Generation Rules.
-- NOTE: Preserves 0001..0005 untouched.

CREATE TABLE item_rarities (
    rarity_code VARCHAR(32) PRIMARY KEY,
    display_name VARCHAR(64) NOT NULL,
    ordinal INTEGER NOT NULL,
    min_explicit_affixes INTEGER NOT NULL,
    max_explicit_affixes INTEGER NOT NULL,
    power_budget_multiplier_bp INTEGER NOT NULL,
    min_quality_bp INTEGER NOT NULL,
    max_quality_bp INTEGER NOT NULL,
    allows_special_effects BOOLEAN NOT NULL DEFAULT FALSE,
    rules_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_item_rarities_ordinal
        UNIQUE (ordinal),
    CONSTRAINT chk_item_rarities_code
        CHECK (rarity_code IN ('common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'relic')),
    CONSTRAINT chk_item_rarities_ordinal_range
        CHECK (ordinal BETWEEN 1 AND 7),
    CONSTRAINT chk_item_rarities_affix_counts
        CHECK (min_explicit_affixes >= 0 AND max_explicit_affixes >= min_explicit_affixes AND max_explicit_affixes <= 8),
    CONSTRAINT chk_item_rarities_multiplier
        CHECK (power_budget_multiplier_bp BETWEEN 10000 AND 50000),
    CONSTRAINT chk_item_rarities_quality_range
        CHECK (min_quality_bp >= 0 AND max_quality_bp <= 10000 AND max_quality_bp >= min_quality_bp),
    CONSTRAINT chk_item_rarities_rules_version
        CHECK (rules_version >= 1)
);

CREATE TABLE special_effect_definitions (
    effect_code VARCHAR(64) PRIMARY KEY,
    effect_version INTEGER NOT NULL DEFAULT 1,
    display_name VARCHAR(120) NOT NULL,
    description TEXT NOT NULL,
    trigger_category VARCHAR(64) NOT NULL,
    parameter_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
    power_budget_cost INTEGER NOT NULL,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_special_effects_code
        CHECK (effect_code ~ '^[a-z][a-z0-9_]{1,63}$'),
    CONSTRAINT chk_special_effects_version
        CHECK (effect_version >= 1),
    CONSTRAINT chk_special_effects_trigger
        CHECK (trigger_category IN ('on_hit', 'on_guard', 'aura', 'threshold', 'stance')),
    CONSTRAINT chk_special_effects_cost
        CHECK (power_budget_cost >= 0)
);

CREATE TABLE affix_definitions (
    affix_code VARCHAR(64) NOT NULL,
    affix_version INTEGER NOT NULL,
    affix_kind VARCHAR(32) NOT NULL,
    pool_code VARCHAR(64) NOT NULL,
    display_name VARCHAR(120) NOT NULL,
    tier INTEGER NOT NULL,
    weight INTEGER NOT NULL,
    allowed_categories JSONB NOT NULL,
    min_item_level INTEGER NOT NULL DEFAULT 1,
    allowed_rarities JSONB NOT NULL,
    attribute_key VARCHAR(32) NULL,
    min_modifier INTEGER NOT NULL DEFAULT 0,
    max_modifier INTEGER NOT NULL DEFAULT 0,
    special_effect_code VARCHAR(64) NULL,
    special_effect_params JSONB NULL,
    power_budget_cost INTEGER NOT NULL,
    exclusive_group VARCHAR(64) NOT NULL,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (affix_code, affix_version),
    CONSTRAINT fk_affix_special_effect
        FOREIGN KEY (special_effect_code) REFERENCES special_effect_definitions(effect_code) ON DELETE RESTRICT,
    CONSTRAINT chk_affix_code_format
        CHECK (affix_code ~ '^[a-z][a-z0-9_]{1,63}$' AND pool_code ~ '^[a-z][a-z0-9_]{1,63}$'),
    CONSTRAINT chk_affix_version_positive
        CHECK (affix_version >= 1),
    CONSTRAINT chk_affix_kind
        CHECK (affix_kind IN ('prefix', 'suffix', 'special_effect')),
    CONSTRAINT chk_affix_tier_and_weight
        CHECK (tier BETWEEN 1 AND 10 AND weight > 0),
    CONSTRAINT chk_affix_min_level
        CHECK (min_item_level >= 1),
    CONSTRAINT chk_affix_modifier_range
        CHECK (min_modifier >= 0 AND max_modifier >= min_modifier),
    CONSTRAINT chk_affix_power_cost
        CHECK (power_budget_cost >= 0),
    CONSTRAINT chk_affix_exclusive_group_not_blank
        CHECK (char_length(btrim(exclusive_group)) > 0),
    CONSTRAINT chk_affix_attribute_key
        CHECK (
            attribute_key IS NULL
            OR attribute_key IN (
                'strength', 'fortitude', 'vigor', 'agility', 'dexterity',
                'intelligence', 'wisdom', 'determination', 'luck', 'charisma'
            )
        ),
    CONSTRAINT chk_affix_kind_target_coherence
        CHECK (
            (affix_kind IN ('prefix', 'suffix') AND attribute_key IS NOT NULL AND special_effect_code IS NULL)
            OR (affix_kind = 'special_effect' AND special_effect_code IS NOT NULL AND attribute_key IS NULL)
        )
);

CREATE INDEX idx_affix_definitions_pool ON affix_definitions(pool_code) WHERE is_enabled = TRUE;

CREATE TABLE item_definitions (
    definition_code VARCHAR(64) NOT NULL,
    definition_version INTEGER NOT NULL,
    display_name VARCHAR(120) NOT NULL,
    description TEXT NOT NULL,
    category VARCHAR(32) NOT NULL,
    subcategory VARCHAR(64) NOT NULL,
    equip_slot_policy VARCHAR(32) NOT NULL,
    allowed_slots JSONB NOT NULL DEFAULT '[]'::jsonb,
    stackable BOOLEAN NOT NULL DEFAULT FALSE,
    max_stack_size INTEGER NOT NULL DEFAULT 1,
    base_item_level INTEGER NOT NULL DEFAULT 1,
    base_power_budget INTEGER NOT NULL DEFAULT 0,
    implicit_modifiers JSONB NOT NULL DEFAULT '{}'::jsonb,
    allowed_rarities JSONB NOT NULL,
    allowed_affix_pools JSONB NOT NULL DEFAULT '[]'::jsonb,
    max_durability INTEGER NULL,
    required_level INTEGER NOT NULL DEFAULT 1,
    required_attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
    binding_policy VARCHAR(32) NOT NULL,
    crafting_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
    trade_category VARCHAR(32) NOT NULL DEFAULT 'standard',
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (definition_code, definition_version),
    CONSTRAINT chk_item_definitions_code
        CHECK (definition_code ~ '^[a-z][a-z0-9_]{1,63}$'),
    CONSTRAINT chk_item_definitions_version
        CHECK (definition_version >= 1),
    CONSTRAINT chk_item_definitions_names
        CHECK (char_length(btrim(display_name)) > 0 AND char_length(btrim(description)) > 0),
    CONSTRAINT chk_item_definitions_category
        CHECK (
            category IN (
                'weapons', 'armor', 'accessories', 'consumables',
                'materials', 'quest_items', 'cosmetics', 'tools', 'miscellaneous'
            )
        ),
    CONSTRAINT chk_item_definitions_slot_policy
        CHECK (
            equip_slot_policy IN (
                'none', 'single_slot', 'two_handed', 'either_hand',
                'ring_any', 'trinket_any', 'cosmetic_only'
            )
        ),
    CONSTRAINT chk_item_definitions_stack_coherence
        CHECK (
            (NOT stackable AND max_stack_size = 1)
            OR (stackable AND max_stack_size BETWEEN 2 AND 9999 AND equip_slot_policy = 'none' AND max_durability IS NULL)
        ),
    CONSTRAINT chk_item_definitions_levels_and_budget
        CHECK (
            base_item_level BETWEEN 1 AND 1000
            AND required_level BETWEEN 1 AND 1000
            AND base_power_budget >= 0
            AND (max_durability IS NULL OR max_durability > 0)
        ),
    CONSTRAINT chk_item_definitions_binding_policy
        CHECK (
            binding_policy IN (
                'unbound', 'bind_on_equip', 'bind_on_pickup', 'account_bound', 'character_bound'
            )
        ),
    CONSTRAINT chk_item_definitions_trade_category
        CHECK (trade_category IN ('standard', 'restricted', 'non_tradable'))
);

CREATE TABLE item_generation_rules (
    rules_version INTEGER PRIMARY KEY,
    code VARCHAR(64) NOT NULL,
    level_budget_per_item_level INTEGER NOT NULL,
    quality_bonus_max_bp INTEGER NOT NULL,
    max_prefixes INTEGER NOT NULL,
    max_suffixes INTEGER NOT NULL,
    max_special_effects INTEGER NOT NULL,
    empty_pool_policy VARCHAR(32) NOT NULL,
    max_equipped_attribute_bonus_cap INTEGER NOT NULL DEFAULT 500,
    default_inventory_capacity INTEGER NOT NULL DEFAULT 40,
    max_loadouts_per_character INTEGER NOT NULL DEFAULT 5,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_item_generation_rules_code
        UNIQUE (code),
    CONSTRAINT chk_item_generation_rules_bounds
        CHECK (
            rules_version >= 1
            AND level_budget_per_item_level >= 0
            AND quality_bonus_max_bp BETWEEN 0 AND 10000
            AND max_prefixes >= 0
            AND max_suffixes >= 0
            AND max_special_effects >= 0
            AND empty_pool_policy IN ('allow_fewer_affixes', 'reject_if_below_min')
            AND max_equipped_attribute_bonus_cap > 0
            AND default_inventory_capacity BETWEEN 1 AND 500
            AND max_loadouts_per_character BETWEEN 1 AND 20
        )
);
