-- Migration: 0004_peoples_catalog_and_progression_rules (UP)
-- CARBON Session 03: Data-driven catalogs for Playable Peoples (26 planned), Lineages,
-- Cultures, Origin Backgrounds, and Versioned Progression/Attribute Rules.
-- NOTE: Does NOT modify 0001..0003 retroactively.

CREATE TABLE playable_peoples (
    race_code VARCHAR(64) PRIMARY KEY,
    display_name VARCHAR(120) NOT NULL,
    description TEXT NOT NULL,
    is_playable BOOLEAN NOT NULL DEFAULT TRUE,
    is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    catalog_version INTEGER NOT NULL DEFAULT 1,
    attribute_budget_profile VARCHAR(64) NOT NULL DEFAULT 'standard_100',
    customization_profile JSONB NOT NULL,
    planned_traits_notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_playable_peoples_code_format
        CHECK (race_code ~ '^[a-z][a-z0-9_]{1,63}$'),
    CONSTRAINT chk_playable_peoples_name_not_blank
        CHECK (char_length(btrim(display_name)) > 0),
    CONSTRAINT chk_playable_peoples_desc_not_blank
        CHECK (char_length(btrim(description)) > 0),
    CONSTRAINT chk_playable_peoples_catalog_version
        CHECK (catalog_version >= 1),
    CONSTRAINT chk_playable_peoples_enabled_requires_playable
        CHECK (NOT is_enabled OR is_playable)
);

CREATE TABLE lineages (
    lineage_code VARCHAR(64) PRIMARY KEY,
    race_code VARCHAR(64) NOT NULL,
    display_name VARCHAR(120) NOT NULL,
    description TEXT NOT NULL,
    is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    catalog_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_lineages_race_code
        FOREIGN KEY (race_code) REFERENCES playable_peoples(race_code) ON DELETE RESTRICT,
    CONSTRAINT uq_lineages_race_and_lineage
        UNIQUE (race_code, lineage_code),
    CONSTRAINT chk_lineages_code_format
        CHECK (lineage_code ~ '^[a-z][a-z0-9_]{1,63}$'),
    CONSTRAINT chk_lineages_name_not_blank
        CHECK (char_length(btrim(display_name)) > 0),
    CONSTRAINT chk_lineages_desc_not_blank
        CHECK (char_length(btrim(description)) > 0),
    CONSTRAINT chk_lineages_catalog_version
        CHECK (catalog_version >= 1)
);

CREATE INDEX idx_lineages_race_code ON lineages(race_code);

CREATE TABLE cultures (
    culture_code VARCHAR(64) PRIMARY KEY,
    display_name VARCHAR(120) NOT NULL,
    description TEXT NOT NULL,
    default_region_id VARCHAR(64) NULL,
    traditions JSONB NOT NULL DEFAULT '[]'::jsonb,
    languages JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    catalog_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_cultures_code_format
        CHECK (culture_code ~ '^[a-z][a-z0-9_]{1,63}$'),
    CONSTRAINT chk_cultures_name_not_blank
        CHECK (char_length(btrim(display_name)) > 0),
    CONSTRAINT chk_cultures_desc_not_blank
        CHECK (char_length(btrim(description)) > 0),
    CONSTRAINT chk_cultures_catalog_version
        CHECK (catalog_version >= 1)
);

CREATE TABLE backgrounds (
    background_code VARCHAR(64) PRIMARY KEY,
    display_name VARCHAR(120) NOT NULL,
    description TEXT NOT NULL,
    narrative_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    catalog_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_backgrounds_code_format
        CHECK (background_code ~ '^[a-z][a-z0-9_]{1,63}$'),
    CONSTRAINT chk_backgrounds_name_not_blank
        CHECK (char_length(btrim(display_name)) > 0),
    CONSTRAINT chk_backgrounds_desc_not_blank
        CHECK (char_length(btrim(description)) > 0),
    CONSTRAINT chk_backgrounds_catalog_version
        CHECK (catalog_version >= 1)
);

CREATE TABLE progression_rules (
    rules_version INTEGER PRIMARY KEY,
    code VARCHAR(64) NOT NULL,
    base_points_per_attribute INTEGER NOT NULL,
    creation_allocatable_points INTEGER NOT NULL,
    points_per_level INTEGER NOT NULL,
    max_effective_before_equipment INTEGER NOT NULL,
    min_level INTEGER NOT NULL DEFAULT 1,
    max_level INTEGER NOT NULL,
    xp_curve_type VARCHAR(32) NOT NULL,
    xp_curve_base BIGINT NOT NULL,
    xp_curve_linear BIGINT NOT NULL,
    xp_curve_quadratic BIGINT NOT NULL,
    max_characters_per_account INTEGER NOT NULL DEFAULT 6,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_progression_rules_code
        UNIQUE (code),
    CONSTRAINT chk_progression_rules_version
        CHECK (rules_version >= 1),
    CONSTRAINT chk_progression_rules_attribute_bounds
        CHECK (
            base_points_per_attribute >= 0
            AND creation_allocatable_points >= 0
            AND points_per_level >= 0
            AND max_effective_before_equipment > base_points_per_attribute
        ),
    CONSTRAINT chk_progression_rules_level_bounds
        CHECK (min_level = 1 AND max_level >= 1 AND max_level <= 1000),
    CONSTRAINT chk_progression_rules_curve
        CHECK (
            xp_curve_type IN ('quadratic_polynomial_v1')
            AND xp_curve_base > 0
            AND xp_curve_linear >= 0
            AND xp_curve_quadratic >= 0
        ),
    CONSTRAINT chk_progression_rules_max_chars
        CHECK (max_characters_per_account >= 1 AND max_characters_per_account <= 50)
);
