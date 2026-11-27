-- Migration: 0009_criminality_bounties_titles_and_world_history (UP)
-- CARBON Session 05: Data-Driven Jurisdictions, Criminal Records, Warrants,
-- Separate Criminal Bounties & Claims (Pending Economy Commitment), Versioned Titles,
-- Declarative/Exclusive Title Unlocks, World Historical Records, and Contribution Recognition Bridge.

CREATE TABLE criminal_jurisdictions (
    jurisdiction_id VARCHAR(64) PRIMARY KEY,
    display_name VARCHAR(120) NOT NULL,
    region_id VARCHAR(64) NOT NULL,
    controlling_faction_id UUID NULL,
    settlement_id UUID NULL,
    law_profile VARCHAR(32) NOT NULL,
    consensual_duel_exempt BOOLEAN NOT NULL DEFAULT TRUE,
    arena_combat_exempt BOOLEAN NOT NULL DEFAULT TRUE,
    recognized_war_exempt BOOLEAN NOT NULL DEFAULT TRUE,
    self_defense_exempt BOOLEAN NOT NULL DEFAULT TRUE,
    unlawful_attack_moral_delta BIGINT NOT NULL DEFAULT -40,
    unlawful_kill_moral_delta BIGINT NOT NULL DEFAULT -250,
    theft_moral_delta BIGINT NOT NULL DEFAULT -60,
    auto_warrant_min_severity VARCHAR(32) NOT NULL DEFAULT 'moderate',
    rules_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_jurisdictions_region
        FOREIGN KEY (region_id) REFERENCES social_regions(region_id) ON DELETE RESTRICT,
    CONSTRAINT fk_jurisdictions_faction
        FOREIGN KEY (controlling_faction_id) REFERENCES factions(id) ON DELETE RESTRICT,
    CONSTRAINT fk_jurisdictions_settlement
        FOREIGN KEY (settlement_id) REFERENCES settlements(id) ON DELETE RESTRICT,
    CONSTRAINT chk_jurisdictions_law_profile
        CHECK (law_profile IN ('civic_protected', 'martial_frontier', 'syndicate_shadow', 'lawless')),
    CONSTRAINT chk_jurisdictions_warrant_threshold
        CHECK (auto_warrant_min_severity IN ('minor', 'moderate', 'major', 'capital', 'never')),
    CONSTRAINT chk_jurisdictions_rules_version
        CHECK (rules_version >= 1 AND char_length(btrim(display_name)) > 0)
);

CREATE TABLE criminal_records (
    id UUID PRIMARY KEY,
    offender_character_id UUID NOT NULL,
    victim_character_id UUID NULL,
    victim_reference VARCHAR(128) NULL,
    offense_code VARCHAR(64) NOT NULL,
    combat_context VARCHAR(32) NOT NULL DEFAULT 'unlawful_aggression',
    jurisdiction_id VARCHAR(64) NOT NULL,
    settlement_id UUID NULL,
    faction_id UUID NULL,
    region_id VARCHAR(64) NOT NULL,
    severity VARCHAR(32) NOT NULL,
    legal_status VARCHAR(32) NOT NULL,
    moral_delta_applied BIGINT NOT NULL DEFAULT 0,
    notoriety_fame_granted BIGINT NOT NULL DEFAULT 0,
    source_event_id VARCHAR(255) NOT NULL,
    evidence_reference VARCHAR(255) NOT NULL,
    rules_version INTEGER NOT NULL DEFAULT 1,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_criminal_records_offender
        FOREIGN KEY (offender_character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_criminal_records_victim
        FOREIGN KEY (victim_character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_criminal_records_jurisdiction
        FOREIGN KEY (jurisdiction_id) REFERENCES criminal_jurisdictions(jurisdiction_id) ON DELETE RESTRICT,
    CONSTRAINT fk_criminal_records_settlement
        FOREIGN KEY (settlement_id) REFERENCES settlements(id) ON DELETE RESTRICT,
    CONSTRAINT fk_criminal_records_faction
        FOREIGN KEY (faction_id) REFERENCES factions(id) ON DELETE RESTRICT,
    CONSTRAINT fk_criminal_records_region
        FOREIGN KEY (region_id) REFERENCES social_regions(region_id) ON DELETE RESTRICT,
    CONSTRAINT uq_criminal_records_source_event
        UNIQUE (source_event_id),
    CONSTRAINT chk_criminal_records_offense
        CHECK (
            offense_code IN (
                'UnlawfulAttack',
                'UnlawfulKill',
                'Theft',
                'Robbery',
                'Sabotage',
                'Treason',
                'ProtectedNPCViolation',
                'SettlementAssault',
                'Smuggling'
            )
        ),
    CONSTRAINT chk_criminal_records_context
        CHECK (
            combat_context IN (
                'unlawful_aggression',
                'consensual_duel',
                'authorized_arena',
                'recognized_faction_war',
                'self_defense'
            )
        ),
    CONSTRAINT chk_criminal_records_severity
        CHECK (severity IN ('minor', 'moderate', 'major', 'capital')),
    CONSTRAINT chk_criminal_records_legal_status
        CHECK (legal_status IN ('suspected', 'confirmed', 'pardoned', 'sentence_served')),
    CONSTRAINT chk_criminal_records_fields
        CHECK (
            notoriety_fame_granted >= 0
            AND char_length(btrim(source_event_id)) > 0
            AND char_length(btrim(evidence_reference)) > 0
            AND rules_version >= 1
        )
);

CREATE INDEX idx_criminal_records_offender
    ON criminal_records(offender_character_id, jurisdiction_id, recorded_at DESC);

CREATE TABLE character_jurisdiction_status (
    character_id UUID NOT NULL,
    jurisdiction_id VARCHAR(64) NOT NULL,
    criminal_state VARCHAR(32) NOT NULL DEFAULT 'Clear',
    safe_zone_access VARCHAR(32) NOT NULL DEFAULT 'permitted',
    active_warrants_count INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (character_id, jurisdiction_id),
    CONSTRAINT fk_char_jur_status_character
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    CONSTRAINT fk_char_jur_status_jurisdiction
        FOREIGN KEY (jurisdiction_id) REFERENCES criminal_jurisdictions(jurisdiction_id) ON DELETE RESTRICT,
    CONSTRAINT chk_char_jur_criminal_state
        CHECK (
            criminal_state IN (
                'Clear',
                'Suspected',
                'Wanted',
                'Fugitive',
                'Captured',
                'ServingSentence',
                'Pardoned'
            )
        ),
    CONSTRAINT chk_char_jur_safe_zone
        CHECK (
            safe_zone_access IN (
                'permitted',
                'monitored',
                'restricted_arrest_on_sight'
            )
        ),
    CONSTRAINT chk_char_jur_bounds
        CHECK (active_warrants_count >= 0 AND version >= 1)
);

CREATE TABLE criminal_warrants (
    id UUID PRIMARY KEY,
    target_character_id UUID NOT NULL,
    issuing_authority_id VARCHAR(128) NOT NULL,
    jurisdiction_id VARCHAR(64) NOT NULL,
    source_crime_id UUID NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    authorized_exceptions JSONB NOT NULL DEFAULT '[]'::jsonb,
    version INTEGER NOT NULL DEFAULT 1,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ NULL,
    resolution_reference VARCHAR(255) NULL,
    CONSTRAINT fk_criminal_warrants_target
        FOREIGN KEY (target_character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_criminal_warrants_jurisdiction
        FOREIGN KEY (jurisdiction_id) REFERENCES criminal_jurisdictions(jurisdiction_id) ON DELETE RESTRICT,
    CONSTRAINT fk_criminal_warrants_crime
        FOREIGN KEY (source_crime_id) REFERENCES criminal_records(id) ON DELETE RESTRICT,
    CONSTRAINT chk_criminal_warrants_status
        CHECK (status IN ('active', 'captured', 'pardoned', 'expired', 'revoked')),
    CONSTRAINT chk_criminal_warrants_fields
        CHECK (char_length(btrim(issuing_authority_id)) > 0 AND version >= 1)
);

CREATE INDEX idx_criminal_warrants_target_active
    ON criminal_warrants(target_character_id, jurisdiction_id)
    WHERE status = 'active';

CREATE TABLE criminal_bounties (
    id UUID PRIMARY KEY,
    target_character_id UUID NOT NULL,
    issuing_authority_id VARCHAR(128) NOT NULL,
    jurisdiction_id VARCHAR(64) NOT NULL,
    warrant_id UUID NULL,
    source_crime_id UUID NOT NULL,
    reward_amount BIGINT NOT NULL,
    currency_code VARCHAR(32) NOT NULL,
    funding_status VARCHAR(32) NOT NULL,
    funding_reference VARCHAR(128) NULL,
    status VARCHAR(32) NOT NULL,
    rules_version INTEGER NOT NULL DEFAULT 1,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_criminal_bounties_target
        FOREIGN KEY (target_character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_criminal_bounties_jurisdiction
        FOREIGN KEY (jurisdiction_id) REFERENCES criminal_jurisdictions(jurisdiction_id) ON DELETE RESTRICT,
    CONSTRAINT fk_criminal_bounties_warrant
        FOREIGN KEY (warrant_id) REFERENCES criminal_warrants(id) ON DELETE RESTRICT,
    CONSTRAINT fk_criminal_bounties_crime
        FOREIGN KEY (source_crime_id) REFERENCES criminal_records(id) ON DELETE RESTRICT,
    CONSTRAINT chk_criminal_bounties_status
        CHECK (status IN ('Draft', 'Active', 'Reserved', 'Fulfilled', 'Expired', 'Cancelled')),
    CONSTRAINT chk_criminal_bounties_funding_status
        CHECK (funding_status IN ('planned_unfunded', 'escrow_committed')),
    CONSTRAINT chk_criminal_bounties_active_requires_funding
        CHECK (
            status NOT IN ('Active', 'Reserved', 'Fulfilled')
            OR (
                funding_status = 'escrow_committed'
                AND funding_reference IS NOT NULL
                AND char_length(btrim(funding_reference)) > 0
            )
        ),
    CONSTRAINT chk_criminal_bounties_bounds
        CHECK (
            reward_amount > 0
            AND char_length(btrim(currency_code)) BETWEEN 2 AND 32
            AND char_length(btrim(issuing_authority_id)) > 0
            AND rules_version >= 1
            AND version >= 1
        )
);

CREATE INDEX idx_criminal_bounties_active_lookup
    ON criminal_bounties(jurisdiction_id, status, reward_amount DESC)
    WHERE status = 'Active';

CREATE TABLE criminal_bounty_claims (
    id UUID PRIMARY KEY,
    bounty_id UUID NOT NULL,
    claimant_character_id UUID NOT NULL,
    claimant_account_id UUID NOT NULL,
    target_character_id UUID NOT NULL,
    target_account_id UUID NOT NULL,
    resolution_kind VARCHAR(32) NOT NULL,
    authority_event_id VARCHAR(255) NOT NULL,
    payout_commitment_status VARCHAR(32) NOT NULL DEFAULT 'pending_economy_settlement',
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_bounty_claims_bounty
        FOREIGN KEY (bounty_id) REFERENCES criminal_bounties(id) ON DELETE RESTRICT,
    CONSTRAINT fk_bounty_claims_claimant_char
        FOREIGN KEY (claimant_character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_bounty_claims_claimant_acc
        FOREIGN KEY (claimant_account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
    CONSTRAINT fk_bounty_claims_target_char
        FOREIGN KEY (target_character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_bounty_claims_target_acc
        FOREIGN KEY (target_account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
    CONSTRAINT uq_criminal_bounty_single_claim
        UNIQUE (bounty_id),
    CONSTRAINT uq_criminal_bounty_authority_event
        UNIQUE (authority_event_id),
    CONSTRAINT chk_bounty_claim_no_self_or_same_account
        CHECK (
            claimant_character_id <> target_character_id
            AND claimant_account_id <> target_account_id
        ),
    CONSTRAINT chk_bounty_claim_resolution
        CHECK (resolution_kind IN ('confirmed_capture', 'authorized_defeat')),
    CONSTRAINT chk_bounty_claim_payout_pending
        CHECK (payout_commitment_status IN ('pending_economy_settlement'))
);

CREATE TABLE title_definitions (
    title_code VARCHAR(64) PRIMARY KEY,
    title_version INTEGER NOT NULL DEFAULT 1,
    display_name VARCHAR(120) NOT NULL,
    description TEXT NOT NULL,
    category VARCHAR(32) NOT NULL,
    rarity VARCHAR(32) NOT NULL,
    persistence_mode VARCHAR(32) NOT NULL,
    exclusivity_scope VARCHAR(32) NOT NULL DEFAULT 'none',
    visibility VARCHAR(32) NOT NULL DEFAULT 'public',
    stackability_policy VARCHAR(32) NOT NULL DEFAULT 'single_unlock',
    revocable BOOLEAN NOT NULL DEFAULT FALSE,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    origin_summary VARCHAR(160) NOT NULL,
    requirements JSONB NOT NULL,
    rules_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_title_definitions_code
        CHECK (title_code ~ '^[a-z][a-z0-9_]{1,63}$'),
    CONSTRAINT chk_title_definitions_category
        CHECK (
            category IN (
                'achievement',
                'reputation',
                'historical',
                'exclusive',
                'criminal',
                'heroic',
                'professional',
                'competitive',
                'exploration',
                'political'
            )
        ),
    CONSTRAINT chk_title_definitions_rarity
        CHECK (rarity IN ('common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic')),
    CONSTRAINT chk_title_definitions_persistence_mode
        CHECK (persistence_mode IN ('PermanentAchievement', 'ConditionalStanding', 'ExclusiveOffice')),
    CONSTRAINT chk_title_definitions_exclusivity_scope
        CHECK (exclusivity_scope IN ('none', 'global', 'regional', 'seasonal', 'event_first')),
    CONSTRAINT chk_title_definitions_visibility
        CHECK (visibility IN ('public', 'contextual', 'hidden_until_unlocked')),
    CONSTRAINT chk_title_definitions_stackability
        CHECK (stackability_policy IN ('single_unlock')),
    CONSTRAINT chk_title_definitions_bounds
        CHECK (
            title_version >= 1
            AND rules_version >= 1
            AND char_length(btrim(display_name)) > 0
            AND char_length(btrim(origin_summary)) > 0
        )
);

ALTER TABLE character_social_standing
    ADD CONSTRAINT fk_character_social_equipped_title
        FOREIGN KEY (equipped_title_code) REFERENCES title_definitions(title_code) ON DELETE RESTRICT;

CREATE TABLE character_titles (
    id UUID PRIMARY KEY,
    character_id UUID NOT NULL,
    title_code VARCHAR(64) NOT NULL,
    state VARCHAR(32) NOT NULL,
    exclusivity_key VARCHAR(160) NULL,
    origin_event_id VARCHAR(255) NOT NULL,
    unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT fk_character_titles_character
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    CONSTRAINT fk_character_titles_def
        FOREIGN KEY (title_code) REFERENCES title_definitions(title_code) ON DELETE RESTRICT,
    CONSTRAINT uq_character_titles_unique_unlock
        UNIQUE (character_id, title_code),
    CONSTRAINT chk_character_titles_state
        CHECK (state IN ('active', 'inactive_conditional', 'revoked', 'expired')),
    CONSTRAINT chk_character_titles_bounds
        CHECK (char_length(btrim(origin_event_id)) > 0 AND version >= 1)
);

CREATE TABLE character_title_history (
    id UUID PRIMARY KEY,
    character_id UUID NOT NULL,
    title_code VARCHAR(64) NOT NULL,
    action VARCHAR(32) NOT NULL,
    cause_event_id VARCHAR(255) NOT NULL,
    correlation_id UUID NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_char_title_history_character
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    CONSTRAINT fk_char_title_history_def
        FOREIGN KEY (title_code) REFERENCES title_definitions(title_code) ON DELETE RESTRICT,
    CONSTRAINT chk_char_title_history_action
        CHECK (
            action IN (
                'unlocked',
                'activated',
                'deactivated_conditional',
                'revoked',
                'expired',
                'equipped',
                'unequipped'
            )
        )
);

CREATE INDEX idx_character_title_history_char
    ON character_title_history(character_id, recorded_at ASC);

CREATE TABLE title_exclusivity_claims (
    exclusivity_key VARCHAR(160) PRIMARY KEY,
    title_code VARCHAR(64) NOT NULL,
    exclusivity_scope VARCHAR(32) NOT NULL,
    scope_ref VARCHAR(128) NOT NULL,
    holder_character_id UUID NOT NULL,
    authoritative_sequence BIGINT NOT NULL,
    origin_event_id VARCHAR(255) NOT NULL,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_title_exclusivity_def
        FOREIGN KEY (title_code) REFERENCES title_definitions(title_code) ON DELETE RESTRICT,
    CONSTRAINT fk_title_exclusivity_holder
        FOREIGN KEY (holder_character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT chk_title_exclusivity_bounds
        CHECK (
            char_length(btrim(exclusivity_key)) > 0
            AND authoritative_sequence >= 0
            AND char_length(btrim(origin_event_id)) > 0
        )
);

CREATE TABLE historical_social_records (
    id UUID PRIMARY KEY,
    event_reference VARCHAR(255) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    character_id UUID NULL,
    settlement_id UUID NULL,
    region_id VARCHAR(64) NULL,
    faction_id UUID NULL,
    contribution_role VARCHAR(64) NOT NULL,
    visibility VARCHAR(32) NOT NULL DEFAULT 'public_chronicle',
    summary TEXT NOT NULL,
    rules_version INTEGER NOT NULL DEFAULT 1,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_hist_social_character
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_hist_social_settlement
        FOREIGN KEY (settlement_id) REFERENCES settlements(id) ON DELETE RESTRICT,
    CONSTRAINT fk_hist_social_region
        FOREIGN KEY (region_id) REFERENCES social_regions(region_id) ON DELETE RESTRICT,
    CONSTRAINT fk_hist_social_faction
        FOREIGN KEY (faction_id) REFERENCES factions(id) ON DELETE RESTRICT,
    CONSTRAINT chk_hist_social_visibility
        CHECK (visibility IN ('public_chronicle', 'regional_lore', 'restricted_archive')),
    CONSTRAINT chk_hist_social_fields
        CHECK (
            char_length(btrim(event_reference)) > 0
            AND char_length(btrim(event_type)) > 0
            AND char_length(btrim(contribution_role)) > 0
            AND char_length(btrim(summary)) > 0
            AND rules_version >= 1
        )
);

CREATE UNIQUE INDEX uq_historical_social_event_char_role
    ON historical_social_records(event_reference, COALESCE(character_id, '00000000-0000-0000-0000-000000000000'::uuid), contribution_role);

CREATE TABLE contribution_recognitions (
    contribution_id UUID PRIMARY KEY,
    character_id UUID NOT NULL,
    policy_code VARCHAR(64) NOT NULL,
    rules_version INTEGER NOT NULL DEFAULT 1,
    moral_bounty_granted BIGINT NOT NULL,
    fame_granted BIGINT NOT NULL,
    settlement_reputation_granted INTEGER NOT NULL,
    recognized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_contrib_recognitions_contrib
        FOREIGN KEY (contribution_id) REFERENCES gameplay_contributions(id) ON DELETE RESTRICT,
    CONSTRAINT fk_contrib_recognitions_character
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT chk_contrib_recognitions_bounds
        CHECK (fame_granted >= 0 AND rules_version >= 1 AND char_length(btrim(policy_code)) > 0)
);
