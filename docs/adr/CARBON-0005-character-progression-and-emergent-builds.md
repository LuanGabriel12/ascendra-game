# ADR CARBON-0005 — Motor de Personagens, Povos Orientados a Dados, Builds Emergentes e Isolamento Genesis

- **Status:** Accepted (CARBON Internal) / Proposed (`CharacterSnapshot` v1 Joint Review with NEON)
- **Data:** 2026-11-26
- **Autor:** CARBON

---

## Contexto

O ASCENDRA exige criação profunda de identidade (26 povos planejados no longo prazo, linhagens biológicas separadas de cultura e origem, aparência modular por sprites, 10 atributos primários sem classes rígidas, progressão persistente de nível e suporte futuro a *Legacy Ranked* e *Genesis Ranked* MD3).

---

## Decisões

1. **Separação Estrita entre `Account`, `Character` e `PlayerID` (NEON):**
   - `accounts` representa a identidade persistente do jogador; `characters` representa avatares individuais no mundo (múltiplos por conta até teto configurável).
   - O `player_id` textual atualmente emitido pelo NEON em `gameplay_contributions` **não** recebe chave estrangeira artificial retroativa para `characters`; o mapeamento formal ocorrerá quando a sessão autenticada vincular `character_id` na entrada da simulação.

2. **Catálogo Único Orientado a Dados (Zero Duplicação de Código por Povo):**
   - Todos os 26 povos compartilham `playable_peoples`, `lineages`, `cultures` e `backgrounds`. Seis povos iniciais estão habilitados (`humans`, `elves`, `dwarves`, `goblins`, `orcs`, `draconians`) com orçamento idêntico (`standard_100`), sem travar moralidade, facção ou classe.
   - Compatibilidade `race_code <-> lineage_code` é garantida estruturalmente no PostgreSQL via `FOREIGN KEY (race_code, lineage_code) REFERENCES lineages(race_code, lineage_code)`.

3. **Conservação Matemática de Atributos e Verdade Não Redundante:**
   - Apenas `BaseAttributes` e `AllocatedAttributes` são persistidos em `character_attributes`; `EffectiveAttributes` e recursos secundários são sempre derivados em runtime conforme versão de regras.
   - O PostgreSQL impõe `CHECK (allocated_attribute_points + unspent_attribute_points = earned_attribute_points)`.

4. **Invariante Arquitetural: Isolamento Absoluto do Modo *Genesis Ranked*:**
   - Nenhum comando mutável do `CharacterEngine` aceita o perfil `genesis_ranked_md3_scratch` (`GenesisTemporaryStatePersistenceForbiddenError`), garantindo que atributos, XP, ouro ou itens temporários de partidas Genesis jamais contaminem o personagem persistente do mundo aberto.
