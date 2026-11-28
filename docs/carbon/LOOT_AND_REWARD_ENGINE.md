# CARBON Loot, Event Rewards & Verified Bounty Settlement (`LOOT_AND_REWARD_ENGINE.md`)

## 1. Loot Individual Autoritativo de Bosses (`grantAuthoritativeBossLoot`)

- Requer exclusivamente `internal_system_authority` e `serverEntropySecret` controlado pelo servidor: clientes nunca informam raridade, quantidade, afixos ou *seed*.
- Para um mesmo evento de boss (`sourceEntityId`), cada `characterId` elegível recebe uma derivação determinística independente (`SplitMix64Rng`), permitindo que dois jogadores obtenham definições iguais ou distintas com raridades, qualidades e afixos independentes, reusing `generateProceduralItemProperties` da Session 04.
- **Idempotência sem Nova Rolagem:** o resultado completo é gravado em `reward_grants` (`UNIQUE(reward_event_id)` e `UNIQUE(source_type, source_entity_id, character_id, reward_slot_index)`). Qualquer *retry* reconstrói exatamente os mesmos itens, pilhas, moedas e fragmentos concedidos originalmente.
- Enquanto contratos definitivos de bosses do NEON não estão publicados, os testes e a demonstração utilizam fixtures de desenvolvimento claramente rotuladas (`boss_crimson_warlord`).

---

## 2. Recompensas Econômicas de Contribuições Mundiais (`grantContributionEconomicReward`)

- Consome registros persistidos em `gameplay_contributions`, exigindo `eligible = true` e resolvendo `player_id -> character_id` **exclusivamente** via vínculo ativo em `external_identity_links` (`source_namespace = 'neon_player'`).
- Avalia pontuação composta multidimensional (`damage + 2 * support + 50 * objectives` — provisória v1), recompensando suporte e objetivos além de dano puro, e impede dupla concessão via `PRIMARY KEY (contribution_id)` em `contribution_economic_rewards`.

---

## 3. Recompensas Criminais Financiadas (`Section 24`)

- **Proteção Legada Preservada:** os guardas introduzidos pelo CODEX em `SocialEngineService.createCriminalBounty` (apenas `Draft`/`planned_unfunded`) e `SocialEngineService.claimCriminalBounty` permanecem fechados para evitar financiamentos textuais fictícios. Registros legados com `funding_status = 'escrow_committed'` e `reservation_id IS NULL` são **quarentenados e rejeitados** por `claimAndSettleVerifiedCriminalBounty`.
- **Fluxo Verificado na Session 07:**
  1. Cria-se a proposta `Draft` (`planned_unfunded`) vinculada a um crime confirmado.
  2. O emissor reserva fundos reais via `reserveFunds` (`purpose = 'criminal_bounty'`, `referenceId = bountyId`).
  3. `fundDraftCriminalBountyWithEscrow` valida que a reserva existe, está `'Reserved'`, pertence ao emissor, possui a mesma moeda e valor exato da recompensa e possui transação real em `currency_ledger_transactions`, ativando a recompensa com FK `reservation_id` (`UNIQUE`).
  4. `claimAndSettleVerifiedCriminalBounty` trava a recompensa `FOR UPDATE`, valida jurisdição e proibição de auto-reivindicação/mesma conta, consome a reserva pagando a carteira do caçador e grava `criminal_bounty_claims` com `payout_commitment_status = 'settled'` e `settlement_ledger_tx_id` na mesma transação.
