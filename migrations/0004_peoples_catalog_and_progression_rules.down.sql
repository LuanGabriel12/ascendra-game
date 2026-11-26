-- Migration: 0004_peoples_catalog_and_progression_rules (DOWN)
-- Reverts Session 03 catalog and progression_rules tables in reverse dependency order.

DROP TABLE IF EXISTS progression_rules;
DROP TABLE IF EXISTS backgrounds;
DROP TABLE IF EXISTS cultures;
DROP TABLE IF EXISTS lineages;
DROP TABLE IF EXISTS playable_peoples;
