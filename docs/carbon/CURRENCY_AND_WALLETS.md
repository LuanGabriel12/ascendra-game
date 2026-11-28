# CARBON Currency & Wallets (`CURRENCY_AND_WALLETS.md`)

## 1. Catálogo Versionado de Moedas (`currencies`)

Nenhum valor monetário utiliza `float` ou `number` fracionário: toda aritmética ocorre em `bigint` no TypeScript, `BIGINT` no PostgreSQL e strings decimais canônicas nos contratos de transporte.

| `currency_code` | Nome | Unidade Mínima | `maximum_balance` | `is_tradeable` | `is_transferable` | `is_enabled` | Finalidade |
|---|---|---|---:|---|---|---|---|
| `ascendra_coin` | Moeda Imperial (Cobre/Prata/Ouro) | `copper` (`100` = `1` prata; `10.000` = `1` ouro) | `9.000.000.000.000.000` | `true` | `true` | `true` | Moeda principal negociável da vertical slice |
| `astral_shard` | Fragmento Especial Astral | `shard` | `1.000.000.000` | `false` | `false` | `true` | Moeda vinculada ao personagem |
| `ashvale_civic_token` | Insígnia Cívica de Ashvale | `token` | `1.000.000.000` | `false` | `false` | `true` | Token regional cívico |
| `world_event_commendation` | Comenda de Acontecimento Mundial | `commendation` | `1.000.000.000` | `false` | `false` | `true` | Recompensa de contribuições mundiais |
| `ranked_glory_token` | Insígnia Competitiva Planejada | `emblem` | `1.000.000.000` | `false` | `false` | `false` | Planejada e desabilitada |

---

## 2. Tipos de Contas Econômicas (`currency_accounts`)

- **`player_wallet`:** Vinculada a `characters(id)` (`owner_character_id`), com propriedade e status ativo validados contra `accounts(id)` do jogador. Saldo estritamente `>= 0` e `<= maximum_balance`.
- **`settlement_treasury`:** Tesouro regional vinculado a `settlements(id)` (`owner_settlement_id`), recebendo taxas de anúncio, impostos sobre vendas, frações de taxas de reparo/forja e financiando recompras de intendentes locais. Saldo `>= 0`.
- **`faction_treasury`:** Tesouro vinculado a `factions(id)` (`owner_faction_id`). Saldo `>= 0`.
- **`escrow_account`:** Conta técnica de custódia (`canonical_escrow_pool` por moeda) onde residem os fundos reservados por `currency_reservations` enquanto negociações, ordens ou recompensas criminais estão ativas.
- **`merchant_account`:** Carteira técnica dedicada para NPCs não vinculados diretamente ao tesouro da cidade.
- **`system_mint`:** Conta contábil técnica de emissão autorizada (`balance` registra o total líquido emitido historicamente `>= 0`). Jogadores nunca podem movimentá-la diretamente.
- **`system_sink`:** Conta contábil técnica de destruição monetária (`balance` registra o total líquido retirado de circulação `>= 0`). Jogadores nunca podem debitá-la.

### Backfill Seguro
A migração `0013` provisiona idempotentemente `system_mint`, `system_sink`, `escrow_account` e carteiras `ascendra_coin` para todos os personagens, assentamentos e facções pré-existentes sem alterar dados históricos das Sessões 01–06.
