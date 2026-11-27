-- Migration: 0010_combat_schools_abilities_and_specialization_trees (UP)
-- CARBON Session 06: Versioned Mastery & Skill Rules, Data-Driven Combat Schools,
-- Immutable Versioned Ability Definitions, and Bounded Specialization DAG Nodes.

CREATE TABLE mastery_and_skill_rules (
    rules_version INTEGER PRIMARY KEY,
    code VARCHAR(64) NOT NULL,
    min_mastery_level INTEGER NOT NULL DEFAULT 1,
    max_mastery_level INTEGER NOT NULL DEFAULT 100,
    xp_curve_base BIGINT NOT NULL,
    xp_curve_linear BIGINT NOT NULL,
    xp_curve_quadratic BIGINT NOT NULL,
    proficiency_bands JSONB NOT NULL,
    initial_specialization_points INTEGER NOT NULL DEFAULT 6,
    specialization_points_per_level INTEGER NOT NULL DEFAULT 1,
    mastery_milestone_levels JSONB NOT NULL DEFAULT '[10, 25, 50, 75, 100]'::jsonb,
    max_active_ability_slots INTEGER NOT NULL DEFAULT 4,
    max_passive_ability_slots INTEGER NOT NULL DEFAULT 2,
    max_ultimate_ability_slots INTEGER NOT NULL DEFAULT 1,
    max_total_equipped_slots INTEGER NOT NULL DEFAULT 7,
    max_build_equipment_cost INTEGER NOT NULL DEFAULT 12,
    max_tree_depth INTEGER NOT NULL DEFAULT 5,
    max_nodes_per_school INTEGER NOT NULL DEFAULT 24,
    anti_farm_cooldown_seconds INTEGER NOT NULL DEFAULT 30,
    anti_farm_window_seconds INTEGER NOT NULL DEFAULT 3600,
    anti_farm_max_grants_per_window INTEGER NOT NULL DEFAULT 8,
    diminishing_returns_step_bp INTEGER NOT NULL DEFAULT 2000,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_mastery_and_skill_rules_code
        UNIQUE (code),
    CONSTRAINT chk_mastery_and_skill_rules_bounds
        CHECK (
            rules_version >= 1
            AND char_length(btrim(code)) BETWEEN 3 AND 64
            AND min_mastery_level = 1
            AND max_mastery_level BETWEEN 10 AND 100
            AND xp_curve_base > 0
            AND xp_curve_linear >= 0
            AND xp_curve_quadratic >= 0
            AND initial_specialization_points >= 0
            AND specialization_points_per_level >= 0
            AND max_active_ability_slots BETWEEN 1 AND 16
            AND max_passive_ability_slots BETWEEN 1 AND 12
            AND max_ultimate_ability_slots BETWEEN 0 AND 4
            AND max_total_equipped_slots BETWEEN 1 AND 32
            AND max_build_equipment_cost >= 1
            AND max_tree_depth BETWEEN 1 AND 10
            AND max_nodes_per_school BETWEEN 1 AND 64
            AND anti_farm_cooldown_seconds >= 0
            AND anti_farm_window_seconds >= 1
            AND anti_farm_max_grants_per_window >= 1
            AND diminishing_returns_step_bp BETWEEN 0 AND 9500
        )
);

CREATE TABLE combat_schools (
    school_code VARCHAR(64) PRIMARY KEY,
    display_name VARCHAR(120) NOT NULL,
    description TEXT NOT NULL,
    primary_focus VARCHAR(64) NOT NULL,
    associated_weapon_families JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    rules_version INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_combat_schools_rules
        FOREIGN KEY (rules_version) REFERENCES mastery_and_skill_rules(rules_version) ON DELETE RESTRICT,
    CONSTRAINT chk_combat_schools_code
        CHECK (school_code ~ '^[a-z][a-z0-9_]{1,63}$'),
    CONSTRAINT chk_combat_schools_text
        CHECK (
            char_length(btrim(display_name)) > 0
            AND char_length(btrim(description)) > 0
            AND char_length(btrim(primary_focus)) > 0
        )
);

CREATE TABLE ability_definitions (
    ability_code VARCHAR(64) NOT NULL,
    ability_version INTEGER NOT NULL,
    display_name VARCHAR(120) NOT NULL,
    description TEXT NOT NULL,
    school_code VARCHAR(64) NOT NULL,
    ability_category VARCHAR(32) NOT NULL,
    slot_group VARCHAR(16) NOT NULL,
    required_weapon_families JSONB NOT NULL DEFAULT '[]'::jsonb,
    required_character_level INTEGER NOT NULL DEFAULT 1,
    required_mastery_level INTEGER NOT NULL DEFAULT 1,
    required_attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
    prerequisite_abilities JSONB NOT NULL DEFAULT '[]'::jsonb,
    prerequisite_nodes JSONB NOT NULL DEFAULT '[]'::jsonb,
    max_rank INTEGER NOT NULL DEFAULT 5,
    unlock_cost INTEGER NOT NULL DEFAULT 1,
    rank_upgrade_cost INTEGER NOT NULL DEFAULT 1,
    equipment_cost INTEGER NOT NULL DEFAULT 2,
    exclusive_group VARCHAR(64) NULL,
    declarative_passive_params JSONB NULL,
    gameplay_effect_ref VARCHAR(128) NOT NULL,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    rules_version INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (ability_code, ability_version),
    CONSTRAINT fk_ability_definitions_school
        FOREIGN KEY (school_code) REFERENCES combat_schools(school_code) ON DELETE RESTRICT,
    CONSTRAINT fk_ability_definitions_rules
        FOREIGN KEY (rules_version) REFERENCES mastery_and_skill_rules(rules_version) ON DELETE RESTRICT,
    CONSTRAINT chk_ability_definitions_code
        CHECK (ability_code ~ '^[a-z][a-z0-9_]{1,63}$'),
    CONSTRAINT chk_ability_definitions_category
        CHECK (
            ability_category IN (
                'active',
                'passive',
                'reactive',
                'mobility',
                'defensive',
                'weapon_technique',
                'magical_technique',
                'ultimate_super'
            )
        ),
    CONSTRAINT chk_ability_definitions_slot_group
        CHECK (slot_group IN ('active', 'passive', 'ultimate')),
    CONSTRAINT chk_ability_definitions_bounds
        CHECK (
            ability_version >= 1
            AND required_character_level BETWEEN 1 AND 1000
            AND required_mastery_level BETWEEN 1 AND 100
            AND max_rank BETWEEN 1 AND 99
            AND unlock_cost >= 0
            AND rank_upgrade_cost >= 0
            AND equipment_cost >= 0
            AND char_length(btrim(display_name)) > 0
            AND char_length(btrim(gameplay_effect_ref)) > 0
            AND (exclusive_group IS NULL OR exclusive_group ~ '^[a-z][a-z0-9_]{1,63}$')
        )
);

CREATE INDEX idx_ability_definitions_school
    ON ability_definitions(school_code, is_enabled);

CREATE TABLE specialization_nodes (
    node_code VARCHAR(64) PRIMARY KEY,
    school_code VARCHAR(64) NOT NULL,
    display_name VARCHAR(120) NOT NULL,
    description TEXT NOT NULL,
    ability_code VARCHAR(64) NULL,
    ability_version INTEGER NULL,
    prerequisite_nodes JSONB NOT NULL DEFAULT '[]'::jsonb,
    required_weapon_families JSONB NOT NULL DEFAULT '[]'::jsonb,
    required_mastery_level INTEGER NOT NULL DEFAULT 1,
    required_character_level INTEGER NOT NULL DEFAULT 1,
    required_attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
    point_cost INTEGER NOT NULL DEFAULT 1,
    exclusive_group VARCHAR(64) NULL,
    tier_depth INTEGER NOT NULL DEFAULT 1,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    rules_version INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_specialization_nodes_school
        FOREIGN KEY (school_code) REFERENCES combat_schools(school_code) ON DELETE RESTRICT,
    CONSTRAINT fk_specialization_nodes_ability
        FOREIGN KEY (ability_code, ability_version)
        REFERENCES ability_definitions(ability_code, ability_version) ON DELETE RESTRICT,
    CONSTRAINT fk_specialization_nodes_rules
        FOREIGN KEY (rules_version) REFERENCES mastery_and_skill_rules(rules_version) ON DELETE RESTRICT,
    CONSTRAINT chk_specialization_nodes_code
        CHECK (node_code ~ '^[a-z][a-z0-9_]{1,63}$'),
    CONSTRAINT chk_specialization_nodes_ability_pair
        CHECK (
            (ability_code IS NULL AND ability_version IS NULL)
            OR (ability_code IS NOT NULL AND ability_version IS NOT NULL)
        ),
    CONSTRAINT chk_specialization_nodes_bounds
        CHECK (
            required_mastery_level BETWEEN 1 AND 100
            AND required_character_level BETWEEN 1 AND 1000
            AND point_cost >= 0
            AND tier_depth BETWEEN 1 AND 10
            AND char_length(btrim(display_name)) > 0
            AND (exclusive_group IS NULL OR exclusive_group ~ '^[a-z][a-z0-9_]{1,63}$')
        )
);

CREATE INDEX idx_specialization_nodes_school
    ON specialization_nodes(school_code, tier_depth ASC);
