# ASCENDRA — Cycle 03 Performance Baseline & Spatial Coordination Comparison

## Ambiente de medição

- **CPU**: AMD Ryzen 7 5800X3D 8-Core Processor (16 threads lógicos)
- **Sistema operacional / Arquitetura**: Windows 11 (`windows/amd64`)
- **Runtime**: Go `1.27.4` (stdlib apenas)
- **Metodologia**: `-benchmem -count=5` (valores abaixo são **medianas** das 5 medições consecutivas, sem execução de carga externa paralela).
- **Aviso de escopo**: benchmarks headless medem custo lógico de CPU/memória de simulação pura — **não** representam suporte de produção a milhares de jogadores conectados simultaneamente (rede, I/O, autenticação e persistência estão fora do escopo).

---

## 1. Comparação ANTES vs DEPOIS — Coordenação da IA (`BenchmarkCycle2Scaling`)

Configuração experimental (idêntica à auditoria do Ciclo 02 em `internal/world/scaling_test.go`): `MaxReinforcementWaves = 0`, 1 alvo defensor, grupos `goblin-skirmisher` empilhados na mesma coordenada 1D (`Position = 12000`, pior caso denso).

| Escala (grupos ativos) | Métrica | ANTES (Ciclo 02 — `O(G²)`) | DEPOIS (Ciclo 03 — `O(G log G)`) | Ganho |
|---:|---|---:|---:|---:|
| **100** | `ai.Coordinate` | `100.579 ns/op` (`12.672 B`, `2 allocs`) | **`12.419 ns/op`** (`26.352 B`, `14 allocs`) | **8,1× mais rápido** |
| **1.000** | `ai.Coordinate` | `9.889.919 ns/op` (`122.880 B`, `2 allocs`) | **`192.442 ns/op`** (`263.409 B`, `18 allocs`) | **51,4× mais rápido** |
| **10.000** | `ai.Coordinate` | `987.118.550 ns/op` (`1.204.224 B`, `2 allocs`) | **`1.453.841 ns/op`** (`2.790.641 B`, `25 allocs`) | **679× mais rápido** |
| **100** | `world.Step` | `182.332 ns/op` (`241.088 B`, `107 allocs`) | `177.977 ns/op` (`698.722 B`, `321 allocs`) | ~1,02× (inclui validações v3) |
| **1.000** | `world.Step` | `10.607.181 ns/op` (`2.351.050 B`, `1.007 allocs`) | **`2.641.421 ns/op`** (`6.910.206 B`, `3.025 allocs`) | **4,0× mais rápido** |
| **10.000** | `world.Step` | `1.005.064.900 ns/op` (`23.378.880 B`, `10.007 allocs`) | **`16.287.572 ns/op`** (`69.044.490 B`, `30.032 allocs`) | **61,7× mais rápido** |

### Complexidade real e limitações

- Consultas de contagem de aliados (`NearbyAllies`, `NearbySameFamily`, `NearbyRetreating`), aura de comandantes (`MoraleAuraBP`) e comandante mais próximo (`findNearestCommander`) executam em **`O(G log G)`** mesmo quando todos os `G` grupos compartilham a mesma coordenada 1D (via ordenação espacial + somas de prefixo + busca binária).
- Seleção de alvo de comandantes executa `O(C × T)` e seleção descentralizada em `Coordinate` usa defensores ordenados por posição (`O(log D + D_in_range)`). Em cenários onde todos os defensores `T` estão simultaneamente dentro do alcance de todos os `G` grupos, o custo de seleção de alvos individuais em `SelectTarget` permanece `O(G × T)`.

---

## 2. Coordenação da IA por distribuição espacial (`BenchmarkCoordinateSpatialDistributions`, `-count=5`)

Dataset misto com os 6 perfis (goblins, orcs, comandantes, retiradas, mortos) e 4 alvos (1 settlement + 3 defensores):

| Distribuição | Grupos | Mediana `ns/op` | `B/op` | `allocs/op` |
|---|---:|---:|---:|---:|
| `uniform` | `100` | `23.883` | `27.760` | `39` |
| `uniform` | `1.000` | `444.112` | `269.313` | `53` |
| `uniform` | `10.000` | `6.271.921` | `2.855.937` | `73` |
| `sparse` | `100` | `18.594` | `27.760` | `39` |
| `sparse` | `1.000` | `287.002` | `269.313` | `53` |
| `sparse` | `10.000` | `2.716.261` | `2.855.937` | `73` |
| `dense` | `100` | `18.946` | `27.760` | `39` |
| `dense` | `1.000` | `198.306` | `269.312` | `53` |
| `dense` | `10.000` | `1.878.050` | `2.855.936` | `73` |

---

## 3. Ecossistema Regional (`internal/ecosystem`, `-count=5`)

Escala representativa da vertical slice: **3 regiões conectadas**, **4 facções**, **3 populações abstratas** (~240–400 indivíduos abstratos), **3 acampamentos ativos**.

| Benchmark | Mediana `ns/op` | `B/op` | `allocs/op` |
|---|---:|---:|---:|
| `BenchmarkEcosystemSubsystems/resources` | `2.538` | `4.499` | `26` |
| `BenchmarkEcosystemSubsystems/populations` | `2.800` | `4.563` | `24` |
| `BenchmarkEcosystemSubsystems/migration` | `5.115` | `8.166` | `40` |
| `BenchmarkEcosystemSubsystems/territory` | `3.541` | `4.843` | `26` |
| `BenchmarkEcosystemSubsystems/threat` | `2.370` | `4.320` | `15` |
| `BenchmarkEcosystemStepEpoch` (epoch completo) | `13.899` | `11.940` | `87` |
| `BenchmarkEcosystemMaterializeDematerialize` | `6.911` | `6.741` | `25` |
| `BenchmarkEcosystemChecksum` | `9.374` | `2.408` | `69` |
| `BenchmarkEcosystemSnapshotRoundTrip` (`~6.269 B`) | `107.780` | `38.686` | `202` |

---

## 4. Simulação Tática (`internal/world`, `-count=5`, limite padrão `MaxActiveGroups = 32`)

| Benchmark | Escala | Mediana `ns/op` | `B/op` | `allocs/op` |
|---|---|---:|---:|---:|
| `BenchmarkWorldStep` | 1 grupo ativo | `3.534` | `7.861` | `14` |
| `BenchmarkWorldStepMultiGroup16` | 16 grupos ativos + 4 defensores | `41.588` | `114.026` | `86` |
| `BenchmarkCanonicalChecksum` | Cenário Defended (tick 40) | `4.387` | `6.144` | `31` |
| `BenchmarkSnapshotRoundTrip` | Cenário Defended (tick 40) | `41.512` | `27.474` | `89` |
