-- Migration: 0014_regional_market_tax_policies_and_npc_merchants (DOWN)

DROP TABLE IF EXISTS npc_merchant_offers;
DROP TABLE IF EXISTS npc_merchants;
DROP TABLE IF EXISTS market_sales;
DROP TABLE IF EXISTS market_listings;
DROP TABLE IF EXISTS regional_tax_policies;
