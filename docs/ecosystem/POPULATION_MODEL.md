# ASCENDRA — Discrete Integer Population Model (`internal/ecosystem/population.go`)

## Modelo discreto de crescimento logístico

Referência conceitual: `growth = r × N × (1 - N/K)`.  
Implementação determinística em inteiros (`int64` + `math/bits` 128-bit) com escala `BasisPointsScale = 10000`:

1. **Identidade populacional**:
   - `TotalSize = FreePopulation + MaterializedPopulation` (verificado sem overflow).
   - Capacidade efetiva `K = min(pop.CarryingCapacity, region.CarryingCapacity)`.
2. **Extinção (`FreePopulation == 0`)**:
   - `births = 0`, `deaths = 0`, resíduos zerados. **Nenhuma geração espontânea**; recolonização ocorre somente via imigração explícita de uma região adjacente viva.
3. **Crescimento (`0 < TotalSize < K`)**:
   - `densityBP = floor(((K - TotalSize) * 10000) / K)`
   - `supplyBP = 10000 - ScarcityBP`
   - `effGrowthBP = floor((floor((GrowthRateBP * densityBP) / 10000) * supplyBP) / 10000)`
   - `rawBirths = FreePopulation * effGrowthBP + GrowthResidualBP` (em 128-bit)
   - `births = min(MaxBirthsPerEpoch, rawBirths / 10000)`
   - `GrowthResidualBP = rawBirths % 10000`
4. **Capacidade nula (`K == 0`) ou superpopulação (`TotalSize >= K`)**:
   - `births = 0`.
   - Se `K == 0`: aplica `OvercrowdingMortalityBP` e `StarvationMortalityBP` máximos sem divisão por zero.
   - Se `TotalSize >= K`: `excessBP = floor(((TotalSize - K) * 10000) / K)`, `overcrowdingMortBP = floor((OvercrowdingMortalityBP * excessBP) / 10000)`.
5. **Mortalidade**:
   - `totalMortBP = min(10000, MortalityRateBP + floor((StarvationMortalityBP * ScarcityBP) / 10000) + overcrowdingMortBP)`
   - `rawDeaths = FreePopulation * totalMortBP + MortalityResidualBP` (em 128-bit)
   - `deaths = min(FreePopulation, rawDeaths / 10000)`
   - `MortalityResidualBP = rawDeaths % 10000`
6. **Equação de conservação**:
   - `Free_next = FreePopulation - deaths + births` (seguida pela fase de migração `Free_final = Free_next + immigration - emigration`).

## Efeitos de arredondamento e prevenção de estagnação

Truncagem inteira pura faria pequenas populações (ex.: `Free = 3` com `effGrowthBP = 1200`, ou `0,36` nascimentos/epoch) ficarem permanentemente presas em `births = 0`. Os acumuladores `GrowthResidualBP` e `MortalityResidualBP` (`[0, 9999]`), incluídos explicitamente no `EcosystemState`, nos snapshots e no checksum canônico, preservam os restos fracionários sem `float64` e garantem replay idêntico após snapshot/restore.

## Parâmetros provisórios de balanceamento (fixtures de desenvolvimento)

| Perfil Ecológico | `GrowthRateBP` | `MortalityRateBP` | `Food/cap (milli)` | `Wood/cap` | `Ore/cap` | `Water/cap` | `Strength/ind` |
|---|---:|---:|---:|---:|---:|---:|---:|
| Goblin (`goblin-common`) | `1400` (14,0%) | `320` (3,2%) | `1400` (1,4) | `800` | `200` | `1100` | `10` |
| Orc (`orc-ironblood`) | `750` (7,5%) | `220` (2,2%) | `2600` (2,6) | `900` | `1200` | `2000` | `24` |

> Estes valores são **parâmetros provisórios** de vertical slice, não balanceamento definitivo de produção.
