# CARBON Double-Entry Monetary Ledger (`MONETARY_LEDGER.md`)

## 1. Modelo de Partidas Dobradas

Toda mutação em `currency_accounts.balance` ocorre exclusivamente através de `PgEconomyTransactionScope.executeBalancedLedgerTransaction(...)` na mesma transação PostgreSQL, gravando:
1. **`currency_ledger_transactions`:** cabeçalho com `idempotency_key` (`UNIQUE`), `operation_type`, `currency_code`, `total_amount`, `correlation_id`, `source_event_id`, `actor_type`, `actor_id`, `is_compensating`, `compensates_tx_id` e `rules_version`.
2. **`currency_ledger_entries`:** pernas ordenadas (`entry_ordinal`), cada uma ligando `debit_account_id` e `credit_account_id` distintos com `amount > 0`, `debit_balance_after >= 0` e `credit_balance_after >= 0`.

### Imutabilidade no PostgreSQL
Os triggers `trg_forbid_currency_ledger_tx_mutation` e `trg_forbid_currency_ledger_entries_mutation` rejeitam qualquer `UPDATE` ou `DELETE` retroativo nas tabelas do razão monetário com `SQLSTATE 23514`. Correções administrativas exigem `MonetaryAndEscrowService.recordCompensatingEntry(...)`, que grava uma nova transação reversa vinculada por `compensates_tx_id`.

---

## 2. Emissão, Transferência e Destruição Monetária

- **Emissão (`currency_mint`, `world_event_reward_mint`, buyback técnico limitado):** debita `system_mint` (incrementando o contador acumulado emitido) e credita a carteira destinatária. Exige `internal_system_authority` ou política controlada explícita.
- **Transferência (`currency_transfer`, `player_trade_settlement`, `market_sale_settlement` para vendedor/tesouro, `bounty_payout_settlement`):** debita uma conta circulante/escrow e credita outra(s) conta(s) circulante(s). **Variação na oferta monetária circulante = `0`**. Taxas enviadas a `settlement_treasury` permanecem em circulação no tesouro regional e **não** são contabilizadas como *sink*.
- **Destruição (`currency_sink`, parcelas queimadas de taxas/reparos/forja):** debita a carteira pagadora e credita `system_sink`, reduzindo efetivamente a oferta circulante.

---

## 3. Invariantes de Reconciliação (`reconcileCurrency`)

Executada sob `REPEATABLE READ READ ONLY`, `PostgresEconomyRepository.reconcileCurrency(currencyCode)` comprova simultaneamente:
1. `totalLedgerDebits === totalLedgerCredits`.
2. Para cada conta circulante/custódia: `storedBalance === SUM(credits) - SUM(debits)`.
3. Para `system_mint`: `storedBalance === SUM(debits) - SUM(credits)`; para `system_sink`: `storedBalance === SUM(credits) - SUM(debits)`.
4. **Conservação da Oferta:** `actualCirculatingSupply === totalMinted - totalDestroyed`.
5. **Integridade do Escrow:** `escrow_account.balance === SUM(reserved_amount - consumed_amount - released_amount)` das reservas em status `'Reserved'`.
