# ASCENDRA — Natural Resource Dynamics (`internal/ecosystem/resources.go`)

## Escopo e fronteira com CARBON

Os cinco recursos ecológicos (`Food`, `Wood`, `Stone`, `Ore`, `Water`) representam **capacidade ambiental agregada** para sustentar populações e acampamentos. Eles **não** são inventário de jogadores, itens comercializáveis, moeda ou economia regional (domínios exclusivos do CARBON).

## Conservação exata no consumo

Para cada região e recurso, por epoch:

1. **Demanda por população**: `demand_i = ceil((FreePopulation_i * perCapitaMilli) / 1000)` em aritmética de 128 bits (`ceilMilliDemand`). Populações não vazias nunca consomem zero por truncagem.
2. **Oferta extraível no epoch**: `available = min(slot.Amount, slot.ExtractionLimit)`.
3. **Sem escassez (`totalDemand <= available`)**: cada consumidor recebe `demand_i` integralmente e `slot.Amount -= totalDemand`.
4. **Sob escassez (`totalDemand > available`)**:
   - Parcela proporcional base em 128 bits: `share_i = floor((demand_i * available) / totalDemand)`.
   - Distribuição determinística do resto `remainder = available - sum(share_i)`: soma `+1` em ordem canônica de `PopulationID` aos consumidores com demanda ainda não atendida até `remainder == 0`.
   - **Invariante de conservação**: `sum(allocated) == consumed == amountBefore - amountAfter` exatamente ao inteiro (zero unidades criadas ou perdidas por arredondamento).
5. **Índice de escassez (`ScarcityBP`)**: média ponderada da fração não atendida por população (`Food 60%`, `Water 25%`, `Wood 10%`, `Ore 5%`).
6. **Regeneração limitada**: `gain = min(MaxCapacity - Amount, RegenPerEpoch + floor(((MaxCapacity - Amount) * RegenRateBP) / 10000))`. Eventos `ResourceDepleted` e `ResourceRegenerated` são emitidos apenas nas transições relevantes (evitando spam por epoch).

## Impacto da escassez

- Reduz diretamente o fator de crescimento populacional (`supplyBP = 10000 - ScarcityBP`).
- Eleva mortalidade (`StarvationMortalityBP * ScarcityBP / 10000`).
- Eleva `MigrationPressureBP` (55% escassez + 45% densidade).
- Drena reservas dos acampamentos e os conduz a `CampResourceStarved` → `CampAbandoned` após `CampAbandonStarveEpochs` epochs consecutivos sem reservas.
