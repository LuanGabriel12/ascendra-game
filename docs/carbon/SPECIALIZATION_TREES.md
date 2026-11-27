# Árvores de Especialização (DAG), Orçamento de Pontos e Respec

## 1. Modelo de Grafo Acíclico Direcionado (`specialization_nodes`)

As árvores de especialização são representadas declarativamente em `specialization_nodes` (18 nós iniciais distribuídos nas 6 escolas ativas, com profundidade `1..3`).

Antes da inserção de qualquer nó (`seedInitialSkillCatalogs` ou `registerSpecializationNodes`), `validateSpecializationDag` verifica deterministicamente:
1. **Ausência de Ciclos e Auto-dependência:** Busca em profundidade (DFS) tricolor (`visiting` / `visited`) rejeita qualquer ciclo com `SpecializationDagInvalidError`.
2. **Integridade Referencial:** Todos os `prerequisiteNodes` e pares `(abilityCode, abilityVersion)` precisam existir.
3. **Limites Estruturais:** Profundidade máxima de cadeia `<= maxTreeDepth` (`5` provisório) e quantidade por escola `<= maxNodesPerSchool` (`24` provisório).
4. **Ausência de Condições Impossíveis:** Rejeita requisitos acima dos tetos intrínsecos (`requiredCharacterLevel <= 1000`, `requiredMasteryLevel <= 100`, atributos intrínsecos `<= 30`) e rejeita nós cujo pré-requisito pertença ao mesmo `exclusiveGroup` (ex.: `sword_tier2_doctrine` separa *Doutrina de Duelo Preciso* de *Doutrina de Vanguarda Cortante*).

---

## 2. Orçamento Independente de Pontos de Especialização

`character_specialization_points` mantém um orçamento totalmente independente de `earned_attribute_points`:
- **Fórmula Inicial Provisória (`v1`):** `6 + max(0, level - 1) * 1` pontos iniciais (com *backfill* automático na migração `0011` para personagens das Sessions 03–05), além de concessões autoritativas auditadas em `character_specialization_point_grants` (`UNIQUE (source_event_id, character_id)`).
- **Lei de Conservação no Banco:** `CHECK (spent_points + unspent_points = earned_points)` e `CHECK` de não-negatividade em todas as colunas.
- Custos separados por definição:
  - `point_cost`: custo em pontos de especialização para desbloquear um nó DAG.
  - `unlock_cost`: custo em pontos de especialização para aprender a habilidade no Rank 1.
  - `rank_upgrade_cost`: custo por *rank* adicional (`1..max_rank`, dentro do limite `1..99` do contrato *wire*).
  - `equipment_cost`: orçamento de configuração de build (independente de pontos de especialização).

---

## 3. Política Explícita de Respec (`resetSpecialization`)

`SkillEngineService.resetSpecialization` redistribui especializações de forma transacional sem apagar a história do personagem:
- **O que permanece intacto:**
  - Toda a experiência, níveis e *ranks* conceituais de maestria de armas (`character_weapon_masteries` e `mastery_experience_grants`).
  - Os registros históricos em `character_learned_abilities` (`learned_at` e `max_rank_ever_reached` preservam o maior *rank* já atingido) e `character_specialization_unlocks` (`unlocked_at`).
  - Todo o log auditável em `character_skill_history`.
- **O que é redefinido:**
  - `spent_points` retorna integralmente para `unspent_points` (`spent = 0`, `unspent = earned`).
  - Nós desbloqueados passam a `is_active = FALSE, points_invested = 0`.
  - Habilidades que investiram pontos de especialização ou dependiam de nós desativados passam a `is_active = FALSE, current_rank = 1, points_invested = 0`.
  - Quaisquer slots equipados em `character_ability_loadout_slots` que referenciem habilidades agora inativas passam a ficar **suprimidos** (`suppressionReason = 'inactive_after_specialization_reset'`), incrementa-se `build_version` e `snapshot_version`, e publica-se `SpecializationReset` + `CharacterBuildChanged` no Outbox.
