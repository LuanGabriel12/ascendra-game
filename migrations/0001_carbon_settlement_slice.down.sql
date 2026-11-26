-- Migration: 0001_carbon_settlement_slice (DOWN)
-- Reverts tables in reverse foreign-key topological order without dropping schema or database.

DROP TABLE IF EXISTS outbox_events;
DROP TABLE IF EXISTS settlement_history;
DROP TABLE IF EXISTS processed_events;
DROP TABLE IF EXISTS settlements;
DROP TABLE IF EXISTS factions;
