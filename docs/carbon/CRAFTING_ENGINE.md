# CARBON Crafting & Professions Engine (`CRAFTING_ENGINE.md`)

## 1. Profissões e Independência de Combate (`0015`)

As 13 profissões planejadas do ASCENDRA estão registradas em `profession_definitions`:
- **Ativa na Vertical Slice da Session 07:** `blacksmithing` (*Ferraria*, `is_enabled = true`).
- **Planejadas / Desabilitadas (`is_enabled = false`):** `armorsmithing`, `carpentry`, `alchemy`, `jewelcrafting`, `enchanting`, `mining`, `logging`, `farming`, `fishing`, `cooking`, `tailoring` e `mercantile`.

A progressão em `character_professions` (`profession_level` `1..100`, `profession_experience`, `crafts_completed_count`) utiliza curva quadrática própria (`minimumXpForProfessionLevel`) **totalmente independente** do XP de nível do personagem (Session 03) e do XP de maestria de armas (Session 06).

---

## 2. Receitas Versionadas e Qualidade de Fabricação

Cada receita em `crafting_recipes` (`PRIMARY KEY (recipe_code, recipe_version)`) especifica:
- Profissão e nível mínimo de maestria (`required_profession_code`, `required_mastery_level`).
- Estação obrigatória (`required_station_code`, ex.: `station_anvil_t1`, `station_runic_forge_t2`).
- Lista de materiais empilháveis (`required_materials`), custo monetário (`currency_cost`) e XP profissional concedido.
- Faixa de qualidade permitida (`[min_quality_bp, max_quality_bp]`) e raridades elegíveis (`allowed_rarities`).

`rollDeterministicCraftingOutcome` combina faixa da receita, nível de maestria em Ferraria, qualidade média ponderada dos materiais consumidos e bônus provisório de ferramenta equipada (`tool_smithing`), **sempre limitado ao teto `[minQualityBp, maxQualityBp]` da raridade sorteada** para que nenhum item fabricado ultrapasse o orçamento de poder de `generateProceduralItemProperties`.

---

## 3. Atomicidade e Proveniência do Fabricante (`craftRecipe`)

Dentro de uma única transação PostgreSQL:
1. Valida estação e nível de maestria profissional.
2. Deduz todos os materiais exigidos da mochila (`consumeMaterialsFromCharacterBag` — se faltar 1 unidade de qualquer insumo, nada é consumido).
3. Cobra `currency_cost` dividindo entre `settlement_treasury` (quando realizado em cidade) e `system_sink`.
4. Gera o `ItemInstance` procedural com `origin_type = 'crafting'`, gravando **`crafted_by_character_id`** e **`crafting_recipe_code`** diretamente em `item_instances` para preservar a assinatura histórica do artesão mesmo após vendas futuras no mercado ou trocas.
5. Incrementa `profession_experience` / `crafts_completed_count`, grava `crafting_operations` e emite `CraftingCompleted` no Outbox.

---

## 4. Títulos Econômicos Verificáveis (`Section 28`)

`PostgresEconomyRepository.seedInitialEconomyCatalogs()` habilita a revisão `v2` dos títulos planejados na Session 05 usando novos operadores declarativos na AST de títulos (`title-contracts.ts`):
- **`legendary_blacksmith` (`v2`):** `ProfessionMasteryAtLeast` (`blacksmithing`, `minLevel: 5`, `minCraftsCompleted: 3` — parâmetros provisórios de desenvolvimento).
- **`imperial_merchant` (`v2`):** `VerifiedMarketSalesAtLeast` (`minDistinctAccountSalesCount: 3`, `minGrossVolume: "2000"`, `currencyCode: "ascendra_coin"`), filtrando estritamente `market_sales WHERE is_same_account = FALSE` para impedir *wash trading* entre personagens da mesma conta. Títulos permanecem cosméticos/sociais, sem conceder bônus de atributos de combate.
