# CARBON Anti-Bad-Luck Fragment System (`ANTI_BAD_LUCK_SYSTEM.md`)

## 1. Decisão de Vinculação

Os fragmentos anti-azar (`anti_bad_luck_fragments` e `character_fragment_balances`) são modelados como **estritamente vinculados ao personagem (`binding_policy = 'character_bound'`)**, não negociáveis no mercado nem transferíveis em comércio bilateral. Isso preserva a relação direta entre o progresso individual em conteúdo de alto risco (ex.: `crimson_warlord_sigil`) e o equipamento resgatado, evitando que proteção contra azar se torne atalho puramente comprável.

---

## 2. Modelo Persistente e Invariantes (`0015`)

- **`anti_bad_luck_fragments`:** define `fragment_code`, `source_content_ref`, `redemption_cost > 0`, `reward_pool` declarativo (lista fechada de opções de equipamentos procedurais ou pacotes de materiais) e `rules_version`.
- **`character_fragment_balances`:** mantém `balance`, `total_earned` e `total_redeemed` com constraint no PostgreSQL:
  `CHECK (balance >= 0 AND total_earned >= 0 AND total_redeemed >= 0 AND total_earned - total_redeemed = balance)`.
- **`fragment_redemptions`:** registra cada resgate com `UNIQUE (redemption_id)` e `UNIQUE (processed_event_id)` vinculado a `reward_grants`.

---

## 3. Operações (`LootFragmentsAndBountyService`)

1. **Acúmulo Idempotente:** fragmentos podem ser concedidos automaticamente junto ao loot do boss (`guaranteedFragmentCode` em `loot_tables`) ou via `grantAntiBadLuckFragments`.
2. **Consulta:** `getCharacterFragmentBalances(characterId)`.
3. **Resgate Atômico (`redeemAntiBadLuckFragments`):**
   - Trava personagem, conta e linha de `character_fragment_balances FOR UPDATE`.
   - Exige `balance >= redemption_cost` e opção presente no `reward_pool`.
   - Deduz `redemption_cost` e gera o item procedural vinculado ao personagem (`bindingState = 'character_bound'`) na mesma transação.
   - Se a mochila estiver cheia, reverte o consumo dos fragmentos. Um segundo resgate com saldo insuficiente falha imediatamente; um *retry* com o mesmo `redemptionId` retorna o item original sem consumir saldo duas vezes.
