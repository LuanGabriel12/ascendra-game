-- Migration: 0011_character_mastery_skills_loadouts_and_history (UP)
-- CARBON Session 06: Independent Weapon Mastery (22 Weapon Families + Unarmed),
-- Authoritative Mastery XP Grants with Anti-Farming Constraints, Separate Specialization Point Budget,
-- Specialization Node Unlocks, Learned Abilities with Ranks, Loadout Ability Slots, and Skill History.

CREATE TABLE character_weapon_masteries (
    character_id UUID NOT NULL,
    weapon_family_code VARCHAR(64) NOT NULL,
    mastery_experience BIGINT NOT NULL DEFAULT 0,
    mastery_level INTEGER NOT NULL DEFAULT 1,
    proficiency_rank VARCHAR(32) NOT NULL DEFAULT 'novice',
    rules_version INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (character_id, weapon_family_code),
    CONSTRAINT fk_character_weapon_masteries_character
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    CONSTRAINT fk_character_weapon_masteries_rules
        FOREIGN KEY (rules_version) REFERENCES mastery_and_skill_rules(rules_version) ON DELETE RESTRICT,
    CONSTRAINT chk_character_weapon_masteries_family
        CHECK (
            weapon_family_code IN (
                'short_sword',
                'longsword',
                'greatsword_2h',
                'dagger',
                'axe',
                'heavy_axe_2h',
                'hammer',
                'mace',
                'spear',
                'halberd_2h',
                'scythe_2h',
                'katana',
                'staff_2h',
                'wand',
                'grimoire',
                'gauntlets',
                'claws',
                'bow_2h',
                'crossbow_2h',
                'shield',
                'dual_blades_2h',
                'magic_catalyst',
                'unarmed'
            )
        ),
    CONSTRAINT chk_character_weapon_masteries_rank
        CHECK (
            proficiency_rank IN (
                'novice',
                'apprentice',
                'practitioner',
                'specialist',
                'master',
                'grandmaster'
            )
        ),
    CONSTRAINT chk_character_weapon_masteries_bounds
        CHECK (
            mastery_experience >= 0
            AND mastery_level BETWEEN 1 AND 100
            AND version >= 1
        )
);

CREATE INDEX idx_character_weapon_masteries_level
    ON character_weapon_masteries(character_id, mastery_level DESC);

CREATE TABLE mastery_experience_grants (
    id UUID PRIMARY KEY,
    processed_event_id UUID NOT NULL,
    external_grant_id VARCHAR(255) NOT NULL,
    source_event_id VARCHAR(255) NOT NULL,
    character_id UUID NOT NULL,
    counterparty_character_id UUID NULL,
    counterparty_account_id UUID NULL,
    weapon_family_code VARCHAR(64) NOT NULL,
    source_type VARCHAR(64) NOT NULL,
    requested_amount BIGINT NOT NULL,
    validated_amount BIGINT NOT NULL,
    previous_xp BIGINT NOT NULL,
    new_xp BIGINT NOT NULL,
    previous_level INTEGER NOT NULL,
    new_level INTEGER NOT NULL,
    rules_version INTEGER NOT NULL,
    payload_fingerprint VARCHAR(80) NOT NULL,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_mastery_grants_processed_event
        FOREIGN KEY (processed_event_id) REFERENCES processed_events(event_id) ON DELETE RESTRICT,
    CONSTRAINT fk_mastery_grants_character
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_mastery_grants_counterparty_char
        FOREIGN KEY (counterparty_character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_mastery_grants_counterparty_acc
        FOREIGN KEY (counterparty_account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
    CONSTRAINT fk_mastery_grants_rules
        FOREIGN KEY (rules_version) REFERENCES mastery_and_skill_rules(rules_version) ON DELETE RESTRICT,
    CONSTRAINT uq_mastery_grants_processed_event
        UNIQUE (processed_event_id),
    CONSTRAINT uq_mastery_grants_external_grant_id
        UNIQUE (external_grant_id),
    CONSTRAINT uq_mastery_grants_single_family_per_source_event
        UNIQUE (source_event_id, character_id),
    CONSTRAINT chk_mastery_grants_family
        CHECK (
            weapon_family_code IN (
                'short_sword', 'longsword', 'greatsword_2h', 'dagger', 'axe', 'heavy_axe_2h',
                'hammer', 'mace', 'spear', 'halberd_2h', 'scythe_2h', 'katana', 'staff_2h',
                'wand', 'grimoire', 'gauntlets', 'claws', 'bow_2h', 'crossbow_2h', 'shield',
                'dual_blades_2h', 'magic_catalyst', 'unarmed'
            )
        ),
    CONSTRAINT chk_mastery_grants_source_type
        CHECK (
            source_type IN (
                'validated_combat',
                'weapon_usage',
                'training',
                'quest_reward',
                'creature_defeat',
                'boss_participation',
                'achievement_milestone',
                'master_training',
                'dev_authorized'
            )
        ),
    CONSTRAINT chk_mastery_grants_no_self_counterparty
        CHECK (counterparty_character_id IS NULL OR counterparty_character_id <> character_id),
    CONSTRAINT chk_mastery_grants_bounds
        CHECK (
            requested_amount > 0
            AND validated_amount > 0
            AND previous_xp >= 0
            AND new_xp >= previous_xp
            AND previous_level BETWEEN 1 AND 100
            AND new_level BETWEEN previous_level AND 100
            AND char_length(btrim(external_grant_id)) > 0
            AND char_length(btrim(source_event_id)) > 0
            AND char_length(btrim(payload_fingerprint)) >= 16
        )
);

CREATE INDEX idx_mastery_grants_anti_farm_window
    ON mastery_experience_grants(character_id, weapon_family_code, source_type, granted_at DESC);

CREATE TABLE character_specialization_points (
    character_id UUID PRIMARY KEY,
    earned_points INTEGER NOT NULL,
    spent_points INTEGER NOT NULL DEFAULT 0,
    unspent_points INTEGER NOT NULL,
    rules_version INTEGER NOT NULL DEFAULT 1,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_character_spec_points_character
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    CONSTRAINT chk_character_spec_points_non_negative
        CHECK (
            earned_points >= 0
            AND spent_points >= 0
            AND unspent_points >= 0
            AND rules_version >= 1
            AND version >= 1
        ),
    CONSTRAINT chk_character_spec_points_conservation
        CHECK (spent_points + unspent_points = earned_points)
);

CREATE TABLE character_specialization_point_grants (
    id UUID PRIMARY KEY,
    processed_event_id UUID NOT NULL,
    external_grant_id VARCHAR(255) NOT NULL,
    source_event_id VARCHAR(255) NOT NULL,
    character_id UUID NOT NULL,
    source_type VARCHAR(64) NOT NULL,
    points_awarded INTEGER NOT NULL,
    payload_fingerprint VARCHAR(80) NOT NULL,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_spec_point_grants_processed_event
        FOREIGN KEY (processed_event_id) REFERENCES processed_events(event_id) ON DELETE RESTRICT,
    CONSTRAINT fk_spec_point_grants_character
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT uq_spec_point_grants_processed_event
        UNIQUE (processed_event_id),
    CONSTRAINT uq_spec_point_grants_external_id
        UNIQUE (external_grant_id),
    CONSTRAINT uq_spec_point_grants_source_event
        UNIQUE (source_event_id, character_id),
    CONSTRAINT chk_spec_point_grants_source_type
        CHECK (
            source_type IN (
                'level_progression',
                'mastery_milestone',
                'training_completion',
                'achievement_reward',
                'dev_authorized'
            )
        ),
    CONSTRAINT chk_spec_point_grants_bounds
        CHECK (
            points_awarded > 0
            AND char_length(btrim(external_grant_id)) > 0
            AND char_length(btrim(source_event_id)) > 0
            AND char_length(btrim(payload_fingerprint)) >= 16
        )
);

CREATE TABLE character_specialization_unlocks (
    character_id UUID NOT NULL,
    node_code VARCHAR(64) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    points_invested INTEGER NOT NULL DEFAULT 0,
    unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (character_id, node_code),
    CONSTRAINT fk_char_spec_unlocks_character
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    CONSTRAINT fk_char_spec_unlocks_node
        FOREIGN KEY (node_code) REFERENCES specialization_nodes(node_code) ON DELETE RESTRICT,
    CONSTRAINT chk_char_spec_unlocks_bounds
        CHECK (points_invested >= 0 AND version >= 1)
);

CREATE TABLE character_learned_abilities (
    character_id UUID NOT NULL,
    ability_code VARCHAR(64) NOT NULL,
    ability_version INTEGER NOT NULL,
    current_rank INTEGER NOT NULL DEFAULT 1,
    max_rank_ever_reached INTEGER NOT NULL DEFAULT 1,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    points_invested INTEGER NOT NULL DEFAULT 0,
    learned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (character_id, ability_code),
    CONSTRAINT fk_char_learned_abilities_character
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    CONSTRAINT fk_char_learned_abilities_definition
        FOREIGN KEY (ability_code, ability_version)
        REFERENCES ability_definitions(ability_code, ability_version) ON DELETE RESTRICT,
    CONSTRAINT chk_char_learned_abilities_bounds
        CHECK (
            current_rank BETWEEN 1 AND 99
            AND max_rank_ever_reached >= current_rank
            AND points_invested >= 0
            AND version >= 1
        )
);

CREATE TABLE character_ability_loadout_slots (
    loadout_id UUID NOT NULL,
    slot_index INTEGER NOT NULL,
    character_id UUID NOT NULL,
    ability_code VARCHAR(64) NOT NULL,
    slot_group VARCHAR(16) NOT NULL,
    equipped_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (loadout_id, slot_index),
    CONSTRAINT fk_char_ability_loadout_slots_loadout
        FOREIGN KEY (loadout_id) REFERENCES equipment_loadouts(id) ON DELETE CASCADE,
    CONSTRAINT fk_char_ability_loadout_slots_character
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    CONSTRAINT fk_char_ability_loadout_slots_learned
        FOREIGN KEY (character_id, ability_code)
        REFERENCES character_learned_abilities(character_id, ability_code) ON DELETE RESTRICT,
    CONSTRAINT uq_char_ability_loadout_no_duplicate_ability
        UNIQUE (loadout_id, ability_code),
    CONSTRAINT chk_char_ability_loadout_slot_bounds
        CHECK (
            slot_index BETWEEN 0 AND 31
            AND slot_group IN ('active', 'passive', 'ultimate')
        )
);

CREATE INDEX idx_character_ability_loadout_slots_character
    ON character_ability_loadout_slots(character_id, loadout_id, slot_index ASC);

CREATE TABLE character_skill_history (
    id UUID PRIMARY KEY,
    history_seq BIGSERIAL NOT NULL,
    character_id UUID NOT NULL,
    operation_type VARCHAR(64) NOT NULL,
    ability_code VARCHAR(64) NULL,
    weapon_family_code VARCHAR(64) NULL,
    node_code VARCHAR(64) NULL,
    previous_rank INTEGER NULL,
    new_rank INTEGER NULL,
    previous_mastery_level INTEGER NULL,
    new_mastery_level INTEGER NULL,
    points_delta INTEGER NULL,
    source_event_id VARCHAR(255) NOT NULL,
    rules_version INTEGER NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_character_skill_history_character
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT chk_character_skill_history_op
        CHECK (
            operation_type IN (
                'mastery_xp_granted',
                'mastery_level_up',
                'spec_points_granted',
                'spec_node_unlocked',
                'ability_learned',
                'ability_rank_upgraded',
                'ability_equipped',
                'ability_unequipped',
                'loadout_abilities_saved',
                'specialization_reset'
            )
        ),
    CONSTRAINT chk_character_skill_history_bounds
        CHECK (
            char_length(btrim(source_event_id)) > 0
            AND rules_version >= 1
        )
);

CREATE INDEX idx_character_skill_history_character
    ON character_skill_history(character_id, history_seq ASC);

-- Safe automatic backfill: initialize specialization point ledger for pre-existing Session 03..05 characters
-- using provisional development formula (6 initial + 1 per level above 1).
INSERT INTO character_specialization_points (
    character_id,
    earned_points,
    spent_points,
    unspent_points,
    rules_version,
    version
)
SELECT
    c.id,
    6 + GREATEST(0, c.level - 1),
    0,
    6 + GREATEST(0, c.level - 1),
    1,
    1
FROM characters c
ON CONFLICT (character_id) DO NOTHING;
