# ASCENDRA — Territory, Migration, Camps & Regional Threat

## Regiões conectadas (fixtures de desenvolvimento)

As três regiões iniciais formam um grafo de adjacência simétrico e validado (sem auto-laços nem referências inexistentes), mantendo a simulação tática em 1D:

| RegionID | Nome (fixture) | Bioma | Settlement | `CarryingCapacity` | Perfil de Recursos | Adjacências |
|---|---|---|---|---:|---|---|
| `region-valewatch-vale` | Vale de Valewatch | `valley` | `settlement-valewatch` | `380` | Moderados e equilibrados | `ironfang`, `thornveil` |
| `region-thornveil-forest` | Floresta de Thornveil | `forest` | — | `600` | Comida/Madeira/Água abundantes | `ironfang`, `valewatch` |
| `region-ironfang-frontier` | Fronteira de Ironfang | `frontier` | — | `500` | Minério/Pedra ricos, comida moderada | `thornveil`, `valewatch` |

## Migração em duas fases (`internal/ecosystem/migration.go`)

1. **Fase 1 — Planejamento (`planMigrations`)**:
   - Executa sobre um `Clone()` imutável do estado pré-migração.
   - Todas as decisões partem da mesma visão consistente: a ordem das regiões não altera planos e **nenhum contingente migra duas vezes no mesmo epoch**.
   - Destinos elegíveis: somente regiões em `AdjacentRegions` com `CarryingCapacity > occupied`.
   - Pontuação inteira do destino: `40% headroom + 30% comida + 15% água + 15% recurso secundário (Madeira p/ goblins, Minério p/ orcs) - influência hostil / 3`.
   - Desempate canônico: maior `score` → menor `RegionID`.
2. **Fase 2 — Aplicação atômica**:
   - Subtrai `plan.Count` de `src.FreePopulation` e adiciona exatamente `plan.Count` ao destino (somando em população compatível `(RegionID, SpeciesID, FactionID)` ou criando nova população recolonizada respeitando `MaxPopulations`).
   - Se `MaxPopulations` impedir criação de nova entrada, o plano é descartado intacto (conservação exata: `outflow == inflow`).

## Facções, competição territorial e coexistência (`internal/ecosystem/territory.go`)

- Família biológica (`goblin`, `orc`) é explicitamente separada de facção (`faction-thorn-goblins`, `faction-cinder-goblins`, `faction-ironfang-orcs`, `faction-valewatch-freefolk`).
- Relações diplomáticas são configuradas explicitamente (`StanceAllied`, `StanceNeutral`, `StanceHostile`):
  - Facções `StanceHostile` na mesma região sofrem atrito competitivo proporcional à força relativa (`CompetitionAttritionBP`), elevam `RecentConflictScore` e sofrem pressão migratória adicional.
  - Facções `StanceNeutral` ou `StanceAllied` (ex.: `Cinderfang Goblins` e `Ironfang Warclans` nas fixtures) **coexistem sem combate automático**.
- A influência territorial (`FactionInfluences`) soma estritamente `<= 10000 BP` por região e emite `TerritorialInfluenceChanged` apenas em mudança de líder ou variação `>= InfluenceEventThresholdBP`.

## Ameaça regional com histerese (`internal/ecosystem/threat.go`)

`ThreatScore` (`0..2000`) combina força populacional hostil, contribuição de acampamentos ativos, influência hostil, conflitos recentes e fator de proximidade de settlement (`120%` na região do settlement, `110%` adjacente, `100%` demais).

| Nível | Entrada (`>=`) | Saída / Rebaixamento (`<=`) | Comportamento |
|---|---:|---:|---|
| `Stable` | `0` | — | Estado basal |
| `Growing` | `400` | `260` | Acúmulo perceptível |
| `Hostile` | `900` | `720` | Pressão territorial ativa |
| `Critical` | `1400` | `1150` | Emite intenção `intent=InvasionPressure` com cooldown `EventIntentCooldownEpochs = 5` |
