# Fame and Contextual Reputation Systems

## 1. Fama (`global_fame` e `regional_fame`)

A Fama mede **notoriedade**, nunca virtude moral:
- Armazenada como `BIGINT` estritamente não negativo (`>= 0`, limitada por `fame_max = 10.000.000` em `v1`).
- Fontes autoritativas reconhecidas (`GrantFameCommand.sourceCategory`): `boss_defeat`, `city_defense`, `championship`, `discovery`, `leadership`, `exceptional_craft`, `historical_event` e `notorious_crime`.
- Um fora da lei com `moral_bounty = -1050` pode possuir `global_fame = 1200`, superando em notoriedade um defensor local menos conhecido.
- Nunca é derivada automaticamente do nível (`characters.level`) nem concede bônus em atributos de combate.

---

## 2. Reputação Contextual Esparsa (`character_reputations`)

Suporta três escopos explícitos com validação de chave estrangeira real no PostgreSQL (`chk_char_reputations_scope_coherence`):
- **`faction`:** referencia `factions(id)`.
- **`settlement`:** referencia `settlements(id)`.
- **`region`:** referencia `social_regions(region_id)`.

### Semântica de Ausência = Neutro (`0`)
- O sistema **não** pré-aloca linhas para o produto cartesiano `characters x factions/settlements/regions`.
- A ausência de registro em `character_reputations` possui semântica canônica `standing_value = 0` (`Neutral`).

---

## 3. Relações entre Facções e Propagação Limitada de 1 Salto

A tabela `faction_relations` modela estados `allied`, `friendly`, `neutral`, `unfriendly` e `hostile` com coeficiente `propagation_bp` (`-10000..+10000` *basis points*):
- Exemplo do catálogo inicial: ganhar `+400` com `valewatch_guard` propaga `+100` (`+2500 bp`) para a aliada `ironforge_artisans` e `-120` (`-3000 bp`) para a rival `thornveil_syndicate`, sem tocar facções não relacionadas (`crimson_raiders`).
- **Garantia Anti-Ciclo:** `computeSingleHopFactionPropagations` executa exclusivamente **1 salto direto (`depth = 1`)** a partir da facção primária do evento, jamais invocando propagação recursiva sobre facções vizinhas.
