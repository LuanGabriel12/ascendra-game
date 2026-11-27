# Integridade de Progressão, Segurança, Títulos de Maestria e Simulação

## 1. Segurança e Fronteiras de Autorização

- **SQL Parametrizado e Zod Estrito:** 100% das consultas SQL utilizam parâmetros posicionais (`$1, $2...`) e validação estrita de inteiros de 64 bits (`PositiveInt64Schema`, `NonNegativeInt64Schema`) com proteção explícita contra *overflow* acima de `MAX_INT64` (`9223372036854775807`).
- **Verificação de Propriedade e Conta Ativa:** Operações de jogador verificam `character.assertOwnedByOrSystem(principal)` e `accounts.status === 'active'`. Concessões de XP de maestria e de pontos de especialização exigem `internal_system_authority`.
- **Paginação Obrigatória:** `listCharacterSkillHistory` limita consultas entre `1` e `100` registros por página (`ORDER BY history_seq ASC LIMIT $2 OFFSET $3`).

---

## 2. Evolução da Engine Declarativa de Títulos (`src/modules/titles/`)

Sem criar uma segunda engine e preservando `MAX_TITLE_AST_DEPTH = 4` e `MAX_TITLE_AST_NODES = 16`, foram adicionados 4 operadores declarativos sustentados pelo banco:
- `WeaponMasteryAtLeast { weaponFamilyCode, minLevel }`
- `MasteredWeaponFamilyCount { minFamilies, minMasteryLevel }`
- `LearnedAbilityCount { minCount, schoolCode? }`
- `SchoolSpecializationCompleted { schoolCode, minUnlockedNodes }`

Quando o catálogo da Session 06 é carregado (`seedInitialSkillCatalogs`), o título planejado da Session 05 **`master_of_blades` (*Mestre das Lâminas*)** avança para `title_version = 2` (`is_enabled = TRUE`) exigindo maestria `>= 25` em família de espada e `2+` habilidades ativas de `swordsmanship`, além dos títulos `unshakeable_fist`, `supreme_guardian`, `supreme_arcanist`, `master_of_all_arms` e `lord_of_spears` (planejado). Nenhum título concede atributos de combate.

---

## 3. Simulador de Progressão (`src/modules/skills/simulation/skill-progression-simulator.ts`)

O *harness* determinístico valida a curva de maestria (`1..100`), a integridade acíclica do DAG e compara 6 arquétipos emergentes sob o orçamento `max_build_equipment_cost = 12`:
1. `pure_swordsman` (*Espadachim Puro*)
2. `guardian` (*Guardião*)
3. `monk` (*Monge*)
4. `arcanist` (*Arcanista*)
5. `arcane_knight` (*Cavaleiro Arcano* — híbrido `swordsmanship` + `arcane_arts`)
6. `hybrid_assassin` (*Assassino Híbrido* — híbrido `shadow_arts` + `arcane_arts`)

> **Limitação:** O simulador valida consistência estrutural, orçamentos e supressão ao trocar armas; **não** comprova balanceamento competitivo final sem motor de combate real e *playtests* no NEON.
