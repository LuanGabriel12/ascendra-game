# ADR CARBON-0009 — Razão Monetária de Partidas Dobradas, Custódia Física de Escrow e Fronteira Transacional Econômica Compartilhada

- **Status:** Accepted (CARBON Development Branch — Isolated Environment)
- **Data:** 2026-11-28
- **Owner:** CARBON (Persistence, Economy, Inventory, Social & Progression Bounded Contexts)

---

## 1. Contexto

Na Session 07, o CARBON precisava introduzir moedas, carteiras, tesouros de cidades/facções, comércio bilateral entre jogadores, mercado regional com taxas, comerciantes NPC, loot individual de bosses, fragmentos anti-azar, liquidação real de recompensas criminais e *crafting* sobre a base `origin/carbon/codex-independent-audit` (`d40c356`).

Três riscos estruturais precisavam ser eliminados desde o desenho:
1. Mutações diretas de saldo (`balance += X`) sem contrapartida contábil ou uso de ponto flutuante.
2. Chamadas sequenciais a serviços públicos que abrem transações independentes (permitindo transferir o item e falhar no pagamento, ou vice-versa).
3. Liquidação de recompensas criminais legadas cujo campo textual `funding_reference` não correspondia a fundos reais reservados.

---

## 2. Decisão

1. **Unidade Inteira Mínima e Ledger Imutável de Partidas Dobradas (`0013`):**
   - `ascendra_coin` usa a menor unidade atômica inteira (`copper` em `BIGINT`), tratando prata (`100`) e ouro (`10.000`) como denominações de apresentação.
   - `currency_ledger_transactions` e `currency_ledger_entries` são protegidas por triggers PostgreSQL que proíbem `UPDATE`/`DELETE` retroativos, exigindo lançamentos compensatórios explícitos.
   - Contas técnicas `system_mint` e `system_sink` separam emissão e destruição monetária de transferências circulantes (incluindo impostos transferidos a `settlement_treasury`), permitindo reconciliação exata `Oferta Circulante === Total Emitido - Total Destruído`.
2. **Fronteira Transacional Única (`PgEconomyTransactionScope`) e Ordem Determinística de Locks:**
   - Operações econômicas compõem `PgCharacterTransactionScope`, `PgInventoryTransactionScope` e `PgSocialTransactionScope` sobre o mesmo `PgPoolClient`.
   - Locks seguem ordem determinística: agregado coordenador (`trade_sessions`/`market_listings`/`criminal_bounties`/`npc_merchants`) -> `characters` (UUID ASC) -> `accounts` (UUID ASC) -> `processed_events` -> `currency_accounts` (`ORDER BY id ASC FOR UPDATE`) -> `inventory_containers` -> `escrow_asset_holdings` / `item_instances` / `inventory_stacks` (UUID ASC).
3. **Custódia Autoritativa (`in_escrow` + `escrow_asset_holdings`):**
   - Equipamentos reservados entram em `location_state = 'in_escrow'` (com índice único parcial `uq_escrow_active_item_instance` e bloqueio nos comandos de inventário/loadout), e pilhas têm sua quantidade fisicamente deduzida de `inventory_stacks` enquanto em custódia.
4. **Quarentena de Recompensas Criminais Legadas (`0015`):**
   - Mantém os guardas fechados de `SocialEngineService` para caminhos não verificados e exige FK `reservation_id` apontando para uma `currency_reservations` real e ativa antes de ativar ou liquidar qualquer recompensa criminal.

---

## 3. Consequências

- **Positivas:** Conservação exata de moedas, equipamentos e materiais sob falhas injetadas, corridas concorrentes (`buy` vs `cancel`, dupla reserva, dupla reivindicação de bounty) e reinicialização do PostgreSQL.
- **Limitações Preservadas:** A auditoria independente geral do CODEX sobre o grafo global completo de locks entre todos os serviços das Sessões 01–06 permanece aberta conforme registrado em `docs/audits/CARBON_CODEX_INDEPENDENT_AUDIT.md`, e o sistema permanece restrito ao ambiente isolado de desenvolvimento.
