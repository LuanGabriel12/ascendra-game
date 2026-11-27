# Escolas de Combate, Classes Emergentes e Catálogo Inicial

## 1. Liberdade de Construção e Classes Emergentes

O ASCENDRA **não possui classes fixas obrigatórias**. Nomes como *Espadachim*, *Berserker*, *Guardião*, *Monge*, *Arcanista*, *Cavaleiro Arcano* ou *Assassino Híbrido* emergem exclusivamente da combinação real entre atributos intrínsecos, armas equipadas, maestrias desenvolvidas, nós de especialização e habilidades equipadas — sem bônus ocultos por rótulo.

### Mecânicas Universais vs Habilidades Persistentes
Fundamentos competitivos (*movimentação, defesa, ataques básicos, dash, esquiva, agarrões, parry/counter conforme design e gestão de recursos*) pertencem ao núcleo universal do motor de combate do **NEON** e **não** foram transformados em itens bloqueados por *grind* no catálogo do CARBON.

---

## 2. Catálogo de 12 Escolas (`combat_schools`)

### Escolas Habilitadas na Session 06 (`is_enabled = TRUE` — 6 escolas)
1. **`martial_arts` (*Artes Marciais*):** `unarmed`, `gauntlets`, `claws`.
2. **`swordsmanship` (*Esgrima e Lâminas*):** `short_sword`, `longsword`, `greatsword_2h`, `katana`, `dual_blades_2h`.
3. **`heavy_arms` (*Armas Pesadas*):** `axe`, `heavy_axe_2h`, `hammer`, `mace`, `greatsword_2h`.
4. **`defensive_arts` (*Artes Defensivas*):** `shield`, `mace`, `hammer`, `longsword`, `spear`.
5. **`shadow_arts` (*Artes das Sombras*):** `dagger`, `short_sword`, `dual_blades_2h`, `claws`.
6. **`arcane_arts` (*Artes Arcanas*):** `staff_2h`, `wand`, `grimoire`, `magic_catalyst`, `longsword`.

### Escolas Planejadas / Desabilitadas (`is_enabled = FALSE` — 6 escolas)
7. `polearm_arts` (*Artes de Haste*)
8. `ranged_arts` (*Artes à Distância*)
9. `sacred_arts` (*Artes Sagradas*)
10. `elemental_arts` (*Artes Elementais*)
11. `necromantic_arts` (*Artes Necromânticas*)
12. `abyssal_arts` (*Artes Abissais*)

---

## 3. Catálogo Versionado de 28 Habilidades (`ability_definitions`)

Cada linha possui chave primária composta `(ability_code, ability_version)` imutável:
- **Esgrima (`swordsmanship`, 7):** `rising_slash` (*Corte Ascendente*), `imperial_thrust` (*Estocada Imperial*), `whirling_blade` (*Lâmina Giratória*), `duelist_counter` (*Contra-Golpe do Duelista*, reativa), `blade_discipline` (*Disciplina da Lâmina*, passiva declarativa), `duelist_precision` (*Precisão do Duelista*, passiva declarativa), `sovereign_blade_storm` (*Tempestade Soberana*, *ultimate/super*).
- **Armas Pesadas (`heavy_arms`, 3):** `seismic_rupture` (*Ruptura Sísmica*), `colossus_charge` (*Investida do Colosso*, mobilidade), `devastating_blow` (*Golpe Devastador*, *ultimate/super*).
- **Artes das Sombras (`shadow_arts`, 3):** `shadow_step` (*Passo Sombrio*, mobilidade compatível com híbridos), `shadow_slash` (*Corte das Sombras*), `silent_lunge` (*Investida Silenciosa*).
- **Artes Marciais (`martial_arts`, 4):** `iron_fist` (*Punho de Ferro*), `resonant_palm` (*Palma Ressonante*), `spiritual_flurry` (*Sequência Espiritual*, *ultimate/super*), `spiritual_flow` (*Fluxo Espiritual*, passiva declarativa).
- **Artes Defensivas (`defensive_arts`, 5):** `guardian_aegis` (*Égide do Guardião*), `shield_retaliation` (*Retaliação*, reativa), `unwavering_stance` (*Postura Inabalável*), `guardian_resilience` (*Resistência do Guardião*, passiva declarativa), `unwavering_determination` (*Determinação Inabalável*, passiva declarativa).
- **Artes Arcanas (`arcane_arts`, 5):** `arcane_lance` (*Lança Arcana*), `mana_pulse` (*Pulso de Mana*, compatível com híbridos), `arcane_barrier` (*Barreira Arcana*), `elemental_rupture` (*Ruptura Elemental*, *ultimate/super*), `arcane_focus` (*Foco Arcano*, passiva declarativa).
- **Planejada / Desabilitada (`abyssal_arts`, 1):** `abyssal_rift_slash` (*Fenda Abissal*, `is_enabled = FALSE`).
