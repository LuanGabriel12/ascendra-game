# Item Definitions and Unique Instances

## 1. Princípio Central

No ASCENDRA, uma definição de catálogo (`ItemDefinition`) nunca é confundida com um item concreto no mundo:
- **`ItemDefinition` (`item_definitions`):** Descreve o arquétipo base versionado (`(definition_code, definition_version)`). É imutável após publicado via `registerItemDefinition`.
- **`ItemInstance` (`item_instances`):** Representa um exemplar único persistente com UUID próprio, semente de geração, raridade, qualidade individual, afixos rolados, durabilidade atual, estado de vinculação e proveniência.
- **`InventoryStack` (`inventory_stacks`):** Representa lotes quantitativos de itens `stackable = TRUE` sem modificadores procedurais individuais.

Quando um designer altera o orçamento ou modificadores base de um equipamento (ex.: *Espada de Ironfang* `v1 -> v2`), publica-se `definition_version = 2`. Instâncias já existentes no inventário dos jogadores continuam apontando para `(ironfang_longsword, 1)` sem mutação retroativa silenciosa.

---

## 2. Categorias e Subcategorias Suportadas

### 9 Categorias Principais (`ITEM_CATEGORIES`)
`weapons`, `armor`, `accessories`, `consumables`, `materials`, `quest_items`, `cosmetics`, `tools`, `miscellaneous`.

### 22 Famílias de Armas Suportadas (`WEAPON_SUBCATEGORIES`)
`short_sword`, `longsword`, `greatsword_2h`, `dagger`, `axe`, `heavy_axe_2h`, `hammer`, `mace`, `spear`, `halberd_2h`, `scythe_2h`, `katana`, `staff_2h`, `wand`, `grimoire`, `gauntlets`, `claws`, `bow_2h`, `crossbow_2h`, `shield`, `dual_blades_2h`, `magic_catalyst`.

---

## 3. Catálogo Inicial de Desenvolvimento (20 Definições Originais)

Definido em `src/modules/inventory/catalog/initial-item-catalog.ts`:

| Código | Nome | Categoria / Subcategoria | Política de Slot | Stack / Durab. | Vinculação |
|---|---|---|---|---|---|
| `ironfang_longsword` | Espada de Ironfang | `weapons` / `longsword` | `either_hand` | `1` / `120` | `bind_on_equip` |
| `thornveil_dagger` | Adaga de Thornveil | `weapons` / `dagger` | `either_hand` | `1` / `90` | `unbound` |
| `crimson_clan_greataxe` | Machado do Clã Carmesim | `weapons` / `heavy_axe_2h` | `two_handed` | `1` / `150` | `bind_on_equip` |
| `twilight_staff` | Cajado do Crepúsculo | `weapons` / `staff_2h` | `two_handed` | `1` / `100` | `bind_on_equip` |
| `valewatch_tower_shield` | Escudo de Valewatch | `weapons` / `shield` | `single_slot` (`off_hand`) | `1` / `160` | `unbound` |
| `wandering_monk_gauntlets` | Manoplas do Monge Errante | `weapons` / `gauntlets` | `two_handed` | `1` / `110` | `bind_on_equip` |
| `ashvale_longbow` | Arco Longo de Cinzavale | `weapons` / `bow_2h` | `two_handed` | `1` / `105` | `unbound` |
| `astral_vigil_grimoire` | Grimório da Vigília Astral | `weapons` / `grimoire` | `single_slot` (`off_hand`) | `1` / `85` | `account_bound` |
| `guardian_plate_cuirass` | Armadura do Guardião | `armor` / `heavy_chest` | `single_slot` (`chest`) | `1` / `180` | `bind_on_equip` |
| `explorer_strider_boots` | Botas do Explorador | `armor` / `light_feet` | `single_slot` (`feet`) | `1` / `95` | `unbound` |
| `ashen_watch_helm` | Elmo da Vigília Cinzenta | `armor` / `medium_head` | `single_slot` (`head`) | `1` / `120` | `unbound` |
| `void_signet_ring` | Anel do Vazio | `accessories` / `ring` | `ring_any` | `1` / `80` | `bind_on_pickup` |
| `ancestral_hearth_amulet` | Amuleto Ancestral | `accessories` / `amulet` | `single_slot` (`neck`) | `1` / `100` | `account_bound` |
| `iron_ore` | Minério de Ferro | `materials` / `metal_ore` | `none` | `200` / `null` | `unbound` |
| `ancient_wood` | Madeira Ancestral | `materials` / `timber` | `none` | `200` / `null` | `unbound` |
| `arcane_fragment` | Fragmento Arcano | `materials` / `essence` | `none` | `100` / `null` | `unbound` |
| `abyssal_crystal` | Cristal Abissal | `materials` / `gemstone` | `none` | `50` / `null` | `account_bound` |
| `medicinal_herb` | Erva Medicinal | `consumables` / `alchemy_reagent` | `none` | `100` / `null` | `unbound` |
| `forge_smithing_hammer` | Martelo de Forja de Ironforge | `tools` / `hammer` | `single_slot` (`main_hand`) | `1` / `200` | `unbound` |
| `ashvale_ceremonial_cloak` | Manto Cerimonial de Cinzavale | `cosmetics` / `cosmetic_cloak` | `cosmetic_only` | `1` / `null` | `account_bound` |

---

## 4. Proveniência Auditável (`ITEM_ORIGIN_TYPES`)

Toda instância registra obrigatoriamente `origin_type` (`boss_drop`, `world_event_reward`, `dungeon_reward`, `quest_reward`, `crafting`, `gathering`, `merchant_purchase`, `exploration`, `trade`, `administrative_grant`, `dev_authorized`), `origin_reference` e `generation_seed_hash`, permitindo auditoria retroativa de qualquer equipamento raro no servidor.
