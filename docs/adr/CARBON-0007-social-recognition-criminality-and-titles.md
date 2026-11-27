# ADR CARBON-0007: Reconhecimento Social Multi-Domínio, Jurisdições Criminais, Títulos Declarativos e Anti-Abuso

- **Status:** Accepted (CARBON Domain) / Proposed Wire (`SocialStandingSnapshotV1`)
- **Data:** 2026-11-27
- **Domínio:** CARBON (`src/modules/social/`, `src/modules/titles/`, `migrations/0008..0009`)
- **Sessão:** CARBON Engineering Session 05 (`carbon/reputation-bounty-titles-engine`)

## 1. Contexto

O ASCENDRA exige um sistema profundo e persistente de reconhecimento social no qual heróis, criminosos, mercenários, caçadores de recompensa e defensores históricos sejam lembrados pelo mundo sem reduzir sua identidade a uma única "barra de carma" ou derivar poder competitivo automático de notoriedade.

## 2. Decisões Arquiteturais

### 2.1 Ortogonalidade Estrita entre Sete Domínios Sociais
Os conceitos abaixo possuem armazenamento, regras e semântica independentes centrados em `CharacterID`:
1. **Moral Bounty (`character_social_standing.moral_bounty`):** Inteiro assinado de 64 bits (`BIGINT`, `SignedInt64Schema`). O valor global é o registro autoritativo primário de ações morais validadas, acompanhado de manifestações regionais (`character_regional_standing`) gravadas em paralelo na mesma transação sem dupla contagem. Avalia **11 faixas configuráveis** com **histerese** (`moral_band_hysteresis`) e **teto de crime grave** (`severe_crime_cap_band`), impedindo que crimes hediondos sejam apagados por tarefas triviais sem reabilitação formal.
2. **Fame (`global_fame` / `regional_fame`):** Inteiro não negativo de 64 bits medindo notoriedade pura, independente de moralidade (um criminoso lendário pode possuir mais fama do que um herói local).
3. **Contextual Reputation (`character_reputations`):** Reputação esparsa por `(scope_type, scope_id)` cobrindo `faction`, `settlement` e `region` com integridade referencial real no PostgreSQL. Ausência de linha equivale a `0` (`Neutral`), evitando explosão combinatória de registros. A propagação entre facções (`faction_relations`) é estritamente de **um salto (`depth = 1`)**, eliminando ciclos e recursão infinita.
4. **Criminal Record & Jurisdictions (`criminal_jurisdictions`, `criminal_records`, `character_jurisdiction_status`, `criminal_warrants`):** Regras orientadas a dados separam duelo consensual, arena autorizada, guerra reconhecida, autodefesa e regiões sem lei (`lawless`) de agressões ilegais em cidades protegidas. Perdão (`Pardoned`) encerra mandados ativos e restaura acesso a zonas seguras **sem jamais deletar** `criminal_records`.
5. **Criminal Bounty (`criminal_bounties`, `criminal_bounty_claims`):** Separado do Bounty moral. Recompensas `Active` exigem `funding_status = 'escrow_committed'` e `funding_reference` válido (`CHECK` no PostgreSQL). Reivindicações autoritativas (`UNIQUE (bounty_id)`) bloqueiam auto-reivindicação e mesma `AccountID`, registrando `payout_commitment_status = 'pending_economy_settlement'` sem fabricar saldos monetários fictícios.
6. **Titles (`title_definitions`, `character_titles`, `title_exclusivity_claims`):** Condições declarativas em AST JSON validado (`maxDepth = 4`, `maxNodes = 16`, `AND`/`OR`, zero `eval`), diferenciando `PermanentAchievement`, `ConditionalStanding` (desativado e desequipado automaticamente quando a condição deixa de valer, preservando histórico) e `ExclusiveOffice` / exclusividade transacional por `PRIMARY KEY (exclusivity_key)`. Títulos equipados nunca concedem atributos de combate.
7. **Contextual World Recognition (`evaluateContextualWorldRecognition`):** Política pura orientada a dados para consumo do NEON. `raceCode` é estruturalmente excluído da assinatura da função, garantindo que espécie biológica jamais determine moralidade ou hostilidade.

### 2.2 Ponte Autoritativa `PlayerID <-> CharacterID` e `ContributionEngine`
- `external_identity_links` associa `(source_namespace, external_subject_id)` a `character_id` com índice único parcial `WHERE link_status = 'active'` e trilha em `external_identity_link_history`, sem inferência retroativa por nome.
- `recognizeEligibleContribution` exige `eligible = TRUE`, identidade vinculada ativa e política explícita caso `outcome = 'Captured'`, gravando `contribution_recognitions(contribution_id)` para impedir duplo reconhecimento.

### 2.3 Projeção `SocialStandingSnapshotV1` com Quatro Níveis de Privacidade
- Mantida independente de `CharacterSnapshotV1` (zero quebra de contrato), com quatro escopos validados (`public_limited`, `self_character`, `internal_authorized`, `judicial_authority`) sob `REPEATABLE READ READ ONLY`.

## 3. Consequências
- **Positivas:** Consistência transacional sob corridas reais no PostgreSQL; prevenção estrutural contra *alt-farming* na mesma conta, *self-bounty* e corridas em títulos exclusivos; memória histórica auditável.
- **Limitações:** Execução de diálogos, movimentação e perseguição de guardas permanece responsabilidade futura do NEON; liquidação financeira aguarda o ledger monetário definitivo.
