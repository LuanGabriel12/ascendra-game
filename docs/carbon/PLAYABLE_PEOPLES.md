# CARBON — Catálogo de Povos Jogáveis, Linhagens, Culturas e Origens

## 1. Princípios de Design e Propriedade Intelectual Original

1. **Identidade 100% Original ASCENDRA:** nenhum nome protegido, lore, personagem ou mecânica proprietária de terceiros (D&D / Baldur's Gate) foi utilizado.
2. **Liberdade Moral, Social e Mecânica:** `race_code`, `lineage_code`, `culture_code` e `background_code` **jamais** determinam moralidade, *Bounty*, fama, facção, classe ou profissão (ex.: um Goblin pode ser paladino nobre em uma guilda anã; um Orc pode ser estudioso arcano; um Draconiano pode ser agricultor/mercador).
3. **Equilíbrio na Session 03:** todos os povos habilitados utilizam o mesmo perfil de orçamento (`standard_100`: 50 base + 50 alocáveis = 100 pontos iniciais), sem vantagens competitivas ocultas. Animações, pixel art e habilidades raciais ativas **não** estão implementadas nesta sessão.

---

## 2. Os 26 Povos Cadastrados (`playable_peoples`)

Todos os 26 povos compartilham a mesma tabela e infraestrutura orientada a dados (`src/modules/peoples/catalog/initial-peoples-catalog.ts`):

### Habilitados na Vertical Slice (`is_enabled = TRUE` — 6 povos)
| `race_code` | Nome | Linhagens Habilitadas (`lineages`) |
| :--- | :--- | :--- |
| `humans` | Humanos | `human_valorian` (Valorianos), `human_frontier` (Fronteiriços), `human_nomadic` (Nômades) |
| `elves` | Elfos | `elf_solar` (Solares), `elf_lunar` (Lunares), `elf_forest` (Florestais) |
| `dwarves` | Anões | `dwarf_mountain` (Montanheses), `dwarf_volcanic` (Vulcânicos), `dwarf_subterranean` (Subterrâneos) |
| `goblins` | Goblins | `goblin_engineer` (Engenheiros), `goblin_nomad` (Nômades), `goblin_cavern` (Habitantes das Cavernas) |
| `orcs` | Orcs | `orc_ironblood` (Sangue de Ferro), `orc_whitefang` (Presa Branca), `orc_crimsonclan` (Clã Carmesim) |
| `draconians` | Draconianos | `draconian_fire` (Fogo), `draconian_ice` (Gelo), `draconian_thunder` (Trovão), `draconian_earth` (Terra), `draconian_venom` (Veneno), `draconian_light` (Luz), `draconian_shadow` (Sombra) |

### Planejados / Desabilitados para Criação (`is_enabled = FALSE` — 20 povos)
`umbral_elves` (Elfos Sombrios), `half_elves` (Meio-elfos), `smallfolk` (Pequeninos), `gnomes` (Gnomos), `infernals` (Infernais), `astrals` (Astrais), `half_orcs` (Meio-orcs), `hobgoblins` (Hobgoblins), `trolls` (Trolls), `lycanthropes` (Licantropos), `felids` (Felídeos), `reptilians` (Reptilianos), `avians` (Avianos), `vampirics` (Vampíricos), `reborn` (Renascidos), `celestials` (Celestiais), `forged` (Forjados), `sylvans` (Silvanos), `abyssals` (Abissais) e `lesser_giants` (Gigantes Menores).

---

## 3. Culturas Desacopladas (`cultures`) e Origens (`backgrounds`)

- **Culturas iniciais (`is_enabled = TRUE`):** `valewatch_civic`, `ironforge_guildpact`, `arcane_collegium`, `steppe_caravaneers`, `verdant_circle`, `crimson_hearth_clans`. Qualquer povo habilitado pode adotar qualquer cultura habilitada.
- **10 Origens iniciais (`backgrounds`):** `war_orphan` (Órfão de Guerra), `blacksmith_apprentice` (Aprendiz de Ferreiro), `explorer` (Explorador), `noble_heir` (Herdeiro Nobre), `exile` (Exilado), `merchant` (Mercador), `hunter` (Caçador), `arcane_scholar` (Estudioso Arcano), `farmer` (Agricultor) e `veteran_soldier` (Antigo Soldado). Nenhuma concede bônus numéricos permanentes arbitrários.
