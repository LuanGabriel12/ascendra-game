-- Migration: 0008_social_standing_fame_reputation_and_identity_links (DOWN)

DROP TABLE IF EXISTS social_standing_ledger;
DROP TABLE IF EXISTS character_reputations;
DROP TABLE IF EXISTS character_regional_standing;
DROP TABLE IF EXISTS character_social_standing;
DROP TABLE IF EXISTS external_identity_link_history;
DROP TABLE IF EXISTS external_identity_links;
DROP TABLE IF EXISTS faction_relations;
DROP TABLE IF EXISTS social_regions;
DROP TABLE IF EXISTS social_rules_versions;
