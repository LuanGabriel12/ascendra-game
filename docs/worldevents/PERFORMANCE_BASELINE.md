# World Event Director — Performance Baseline & Stability Report (Cycle 04)

> **Aviso de escopo (obrigatório):** Todos os números abaixo são medições **locais, single-process e headless** da simulação determinística em Go. Eles servem exclusivamente como linha de base técnica para regressão de custo por tick, alocações, memória retida e tamanho de snapshot — **não** representam capacidade de servidor multiplayer em produção, carga de rede real ou throughput com banco de dados.

## 1. Ambiente de Medição

- **OS / Arch:** `windows/amd64`
- **CPU:** `AMD Ryzen 7 5800X3D 8-Core Processor` (16 threads)
- **Go Runtime:** `go1.27.4 windows/amd64`
- **Comando de benchmark:** `go test '-bench=.' -benchmem -count=5 '-run=^$' ./internal/worldevents`

## 2. Benchmarks (`-count=5`, mediana das 5 amostras)

| Benchmark | Mediana (ns/op) | Faixa (min–max ns/op) | Memória (B/op) | Alocações (allocs/op) | Escopo Medido |
|---|---:|---|---:|---:|---|
| `BenchmarkEvaluateCandidates-16` | **9.754** (~9,75 µs) | 7.769 – 10.252 | 17.600 | 13 | Avaliação de candidatos sobre ecossistema dual-hostil (Goblins + Orcs) |
| `BenchmarkReservationLifecycle-16` | **10.823** (~10,82 µs) | 10.264 – 11.632 | 7.478 | 45 | Ciclo completo: `CreateReservation` → `MaterializeFromReservation` → `ReconcileReservationContingent` → `CompleteReservation` |
| `BenchmarkSchedulerEnqueueAndStep-16` | **68.952** (~68,95 µs) | 54.066 – 76.918 | 84.906 | 128 | Enfileiramento de 8 `ScheduledEvent` + `Step` com escalonamento e validação cross-layer |
| `BenchmarkCampaignProgressionStep-16` | **93.684** (~93,68 µs) | 80.281 – 112.574 | 119.272 | 111 | `Step` completo durante campanha `Active` com combate tático + IA + validação 3 camadas |
| `BenchmarkOrchestratedStepIntegrated-16` | **121.841** (~121,84 µs) | 111.594 – 127.455 | 100.289 | 181 | Tick pesado de fronteira de epoch (`StepEpoch` + candidatos + escalonador + campanhas + `StepWithDirector` + `Validate`) |
| `BenchmarkOrchestratedSnapshotRoundTrip-16` | **490.650** (~490,65 µs) | 441.647 – 535.430 | 223.700 | 424 | `MarshalSnapshot` v4 (JSON + SHA-256) + `UnmarshalOrchestratedSnapshot` (pré-checagem de bytes + decodificação + `Validate` cross-layer) |

### Tamanho Real de Snapshot v4 (`Scenario G`)

- **Snapshot mid-campaign (`wev-scenario-g-snapshot`, tick 32 com campanha ativa, reserva e grupos táticos mobilizados):** **12.964 bytes** (~12,7 KiB), bem abaixo do teto padrão `DefaultMaxSnapshotBytes = 2 MiB`.

## 3. Estabilidade de Longa Duração e Memória Retida

Medida em `TestLongDurationMultiSeedStabilityAndBoundedMemory`:
- **Carga:** `3` seeds independentes (`10001`, `20002`, `30003`) × `1.000` epochs ecológicos (`4.000` ticks por seed) = **3.000 epochs / 12.000 ticks orquestrados**.
- **Atividade real:** **78 campanhas completas** instanciadas, reservadas, mobilizadas, combatidas, reconciliadas, encerradas e arquivadas.
- **Invariantes:** `OrchestratedState.Validate` executado ao final de **100% dos 12.000 ticks** (0 violações, 0 vazamentos populacionais, 0 reservas órfãs, 0 explosões de filas/históricos).
- **Memória heap retida (`runtime.GC()` + `runtime.ReadMemStats`):**
  - Baseline inicial: **438.936 B** (~428,6 KiB)
  - Pico observado ao longo das 3.000 épocas: **461.776 B** (~451,0 KiB)
  - Heap final retido: **423.992 B** (~414,1 KiB)
  - **Delta líquido:** **-14.944 B** — crescimento efetivamente **O(1)** graças à poda de cooldowns expirados, arquivamento em anel FIFO (`CompletedHistory`, `TerminalOutcomes`) e `PruneClosedReservations`.

## 4. Fuzzing Limitado (30s por Alvo, 16 Workers)

| Alvo de Fuzzing | Duração | Execuções Totais | Novos Inputs Interessantes | Falhas / Panics |
|---|---:|---:|---:|---:|
| `FuzzCampaignSchedulerAndCommands` (`internal/worldevents`) | 30s | **368.013** | 102 (total corpus: 106) | **0** |
| `FuzzOrchestratedSnapshotDecode` (`internal/worldevents`) | 30s | **288.422** | 186 (total corpus: 191) | **0** |
| `FuzzEcosystemCommandsAndInvariants` (`internal/ecosystem`) | 30s | **1.839.620** | 12 (total corpus: 184) | **0** |
| **Total combinado** | **90s** | **2.496.055** | **300** | **0** |

## 5. Gargalos Conhecidos e Margem de Otimização Futura

1. **`OrchestratedState.Clone()` por tick (atomicidade por cópia completa):** responsável pela maior parcela dos ~100–119 KB/op em `Step`. Garante atomicidade trivial e zero risco de mutação parcial em erro; caso o número de regiões/grupos cresça em ciclos futuros, estruturas copy-on-write ou validação incremental podem reduzir alocações sem alterar a semântica pura.
2. **Snapshots JSON v4 (~490 µs / 223 KB/op):** adequado para checkpoints periódicos e replay; para persistência de alta frequência em produção futura, codificação binária determinística pode ser avaliada em ADR dedicado.
