# Affix, Rarity & Quality System

## 1. Sete Raridades Versionadas (`item_rarities`)

| Código | Nome | Ordinal | Afixos Explícitos (`min..max`) | Multiplicador Orçamento (`bp`) | Faixa `quality_bp` | Efeitos Especiais Declarativos |
|---|---|---|---|---|---|---|
| `common` | Comum | 1 | `0..1` | `10000` (`1.00x`) | `1000..6000` | Não |
| `uncommon` | Incomum | 2 | `1..2` | `11500` (`1.15x`) | `2500..7500` | Não |
| `rare` | Raro | 3 | `2..3` | `13500` (`1.35x`) | `4000..8500` | Não |
| `epic` | Épico | 4 | `3..4` | `16000` (`1.60x`) | `5500..9200` | Sim (máx. 1) |
| `legendary` | Lendário | 5 | `4..5` | `19000` (`1.90x`) | `7000..9700` | Sim (máx. 1) |
| `mythic` | Mítico | 6 | `4..6` | `22000` (`2.20x`) | `8000..9900` | Sim (máx. 1) |
| `relic` | Relíquia | 7 | `5..6` | `25000` (`2.50x`) | `9000..10000` | Sim (máx. 1) |

---

## 2. Separação entre Raridade e Qualidade (`quality_bp`)

- **Raridade (`rarity_code`):** Governa a quantidade de afixos explícitos, o multiplicador de orçamento de geração e a elegibilidade para efeitos declarativos especiais.
- **Qualidade (`quality_bp`, `0..10000`):** Propriedade individual persistida em cada `ItemInstance` e `InventoryStack`. Influencia o bônus marginal de orçamento (até `+20%` em `10000 bp`), a rolagem dentro da faixa de cada afixo e a chave de equivalência de pilhas de materiais para *crafting* futuro.

Como as faixas de qualidade e de rolagem se sobrepõem parcialmente, um equipamento `rare` bem rolado e de alta qualidade pode competir taticamente com um `epic` mal rolado, evitando inflação vertical automática.

---

## 3. Estrutura de Afixos e Pools (`affix_definitions`)

Cada definição versionada `(affix_code, affix_version)` especifica:
- **`affix_kind`:** `'prefix'`, `'suffix'` ou `'special_effect'`.
- **`pool_code`:** Agrupamento semântico permitido por item (`pool_martial`, `pool_defense`, `pool_swift`, `pool_arcane`, `pool_fortune`, `pool_relic_effects`).
  - Exemplo de coerência sem bloquear *builds* híbridas: o *Machado do Clã Carmesim* (`crimson_clan_greataxe`) aceita apenas `pool_martial`, `pool_defense` e `pool_relic_effects` (nunca rola afixos arcanos puros), enquanto a versátil *Espada de Ironfang* (`ironfang_longsword`) inclui `pool_arcane` além de `pool_martial` e `pool_swift`, viabilizando *builds* emergentes de Cavaleiro Arcano.
- **`exclusive_group`:** Impede o acúmulo de afixos mutuamente exclusivos (ex.: `titanic_t1` e `titanic_t2` compartilham `attr_strength_prefix`; reforçado também no banco por `UNIQUE (item_instance_id, exclusive_group)` e `UNIQUE (item_instance_id, affix_code)`).
- **`weight`:** Inteiro estritamente positivo (`CHECK (weight > 0)`). Pesos zero ou negativos são rejeitados na geração e no schema SQL.

---

## 4. Catálogo Declarativo de Efeitos Especiais (`special_effect_definitions`)

Para preservar segurança e determinismo:
- Efeitos especiais (`ancestral_fury`, `iron_bulwark`, `eternal_flame`, `winters_mark`, `guardians_resolve`, `imperial_presence`, `abyssal_whisper`) são registrados apenas como códigos declarativos versionados com `trigger_category` (`on_hit`, `on_guard`, `aura`, `threshold`, `stance`) e parâmetros numéricos estruturados (`JSONB`).
- **Proibição absoluta de scripts dinâmicos:** nenhum `eval`, expressão arbitrária ou lógica de gameplay imperativa reside nos itens persistidos pelo CARBON. A execução mecânica pertencerá exclusivamente ao motor determinístico em Go do NEON.
