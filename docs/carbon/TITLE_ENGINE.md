# Title Engine & Declarative Condition AST (`src/modules/titles/`)

## 1. Catálogo Inicial Versionado (18 Títulos: 14 Habilitados + 4 Planejados)

Persistido em `title_definitions`:
- **Heroicos Habilitados (6):** `protector_of_valewatch` (*Protetor de Valewatch*), `shield_of_the_realm` (*Escudo do Reino*), `liberator_of_ironfang` (*Libertador de Ironfang*), `guardian_of_innocents` (*Guardião dos Inocentes*), `hero_of_ascendra` (*Herói de Ascendra*, condicional), `living_legend` (*Lenda Viva*).
- **Reputação Condicional (1):** `exemplary_citizen_ashvale` (*Cidadão Exemplar de Ashvale*).
- **Criminais Habilitados (4):** `the_wanted` (*O Procurado*), `outlaw_scourge` (*Flagelo da Fronteira*), `shadow_of_thornveil` (*A Sombra de Thornveil*), `terror_of_the_realms` (*Terror dos Reinos*).
- **Conquista de Caçador (1):** `relentless_bounty_hunter` (*Caçador Implacável*).
- **Exclusivo Global e Posição Regional (2):** `first_liberator_valewatch` (*Primeiro Libertador de Valewatch*, exclusivo global) e `warden_governor_ashvale` (*Alto Guardião Cívico de Ashvale*, `ExclusiveOffice` regional revogável).
- **Planejados / Desabilitados (`is_enabled = FALSE`, 4):** `abyss_conqueror` (*Conquistador do Abismo*), `master_of_blades` (*Mestre das Lâminas*), `legendary_blacksmith` (*Ferreiro Lendário*) e `imperial_merchant` (*Mercador Imperial*) — registrados com `PlannedSystemUnavailable` até que os respectivos sistemas existam.

---

## 2. Engine Declarativa de Condições (Sem `eval`)

Implementada em `src/modules/titles/domain/title-contracts.ts`:
- Operadores suportados: `AND`, `OR`, `MoralBountyAtLeast`, `MoralBountyAtMost`, `FameAtLeast`, `ReputationAtLeast`, `ReputationAtMost`, `SuccessfulSettlementDefenses`, `SuccessfulSettlementLiberations`, `ValidatedCrimeCount`, `ValidatedCrimeCountAtMost`, `CriminalBountiesFulfilled`, `HistoricalAchievementRecorded` e `PlannedSystemUnavailable`.
- `validateTitleConditionAst` impõe `MAX_TITLE_AST_DEPTH = 4` e `MAX_TITLE_AST_NODES = 16`, rejeitando qualquer operador fora da *allowlist*.
- A avaliação utiliza os contadores pré-agregados em `character_social_standing` e mapas indexados do próprio personagem, sem varrer o histórico global do servidor.

---

## 3. Modos de Persistência, Exclusividade e Equipamento

1. **`PermanentAchievement`:** Permanece `active` permanentemente após conquistado.
2. **`ConditionalStanding`:** Reavaliado automaticamente (`reconcileConditionalTitles`) após mudanças morais, criminais, de fama ou de reputação. Se a condição deixar de ser satisfeita, transiciona para `inactive_conditional` e é desequipado caso esteja em uso, registrando `deactivated_conditional` em `character_title_history` sem apagar o desbloqueio original.
3. **`ExclusiveOffice` e Exclusividade Transacional (`title_exclusivity_claims`):** `PRIMARY KEY (exclusivity_key)` garante no PostgreSQL que corridas concorrentes jamais concedam o mesmo título exclusivo global/regional/sazonal a dois personagens distintos. Nota: quando a semântica futura exigir desempate pelo tick exato de simulação Go, o emissor autoritativo deverá enviar o vencedor ordenado (`authoritative_sequence`).
4. **Equipamento Sem Poder Competitivo (`equipTitle`):** Valida posse, estado `active` e `expectedSocialVersion`, atualizando `equipped_title_code` com **zero** alteração nos atributos de combate (`CharacterSnapshotV1`).
