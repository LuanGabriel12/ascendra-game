# Criminal Bounty & Bounty Hunter Engine

## 1. Separação entre `MoralBounty` e `CriminalBounty`

- **`MoralBounty`:** Pontuação moral persistente assinada do personagem no mundo.
- **`CriminalBounty` (`criminal_bounties`):** Contrato formal emitido por uma autoridade (`issuing_authority_id`) em uma jurisdição (`jurisdiction_id`) vinculado a um crime confirmado (`source_crime_id`), oferecendo recompensa (`reward_amount`, `currency_code`) pela captura confirmada ou derrota autorizada do alvo.

---

## 2. Estados e Financiamento Explícito (Sem Moeda Fictícia)

Estados suportados: `Draft`, `Active`, `Reserved`, `Fulfilled`, `Expired`, `Cancelled`.

Como o sistema monetário completo e o *escrow* financeiro definitivo pertencem a sessões futuras:
1. O banco exige via `chk_criminal_bounties_active_requires_funding` que qualquer recompensa `Active`, `Reserved` ou `Fulfilled` possua `funding_status = 'escrow_committed'` e `funding_reference` preenchido; propostas sem fundo permanecem restritas a `Draft` (`planned_unfunded`).
2. Ao cumprir uma recompensa via `claimCriminalBounty`, grava-se `criminal_bounty_claims` com `payout_commitment_status = 'pending_economy_settlement'`. **Nenhuma moeda é creditada artificialmente** e nenhum saldo monetário fictício é criado.

---

## 3. Regras de Elegibilidade e Proteção Concorrente para Caçadores

`claimCriminalBounty` garante transacionalmente:
- Bloqueio pessimista `SELECT ... FROM criminal_bounties WHERE id = $1 FOR UPDATE` seguido de verificação otimista de `version` e constraint `UNIQUE (bounty_id)` em `criminal_bounty_claims` — em corridas concorrentes entre dois caçadores, exatamente **uma** reivindicação vence e a outra é rejeitada.
- Proibição de auto-reivindicação (`claimant_character_id <> target_character_id`) e proibição entre personagens da mesma conta (`claimant_account_id <> target_account_id`), reforçadas tanto no domínio quanto por `CHECK` SQL (`chk_bounty_claim_no_self_or_same_account`).
- Exigência de estado elegível do alvo (`Wanted`, `Fugitive` ou `Captured`; mera suspeita `Suspected` nunca autoriza coleta de recompensa).
- Incremento atômico de `bounties_fulfilled_count` no caçador para desbloqueio de títulos como `relentless_bounty_hunter` (*Caçador Implacável*), sem expor coordenadas privadas em tempo real.
