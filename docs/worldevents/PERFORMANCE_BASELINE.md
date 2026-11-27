# World Event Director — Performance Baseline & Stability Report (Cycle 04 / Recovery 04.2)

> **Aviso de escopo (obrigatório):** Todos os números abaixo são medições **locais, single-process e headless** da simulação determinística em Go. Eles servem exclusivamente como linha de base técnica para regressão de custo por tick, alocações, memória retida e tamanho de snapshot — **não** representam capacidade de servidor multiplayer em produção, carga de rede real ou throughput com banco de dados.

## 1. Ambiente de Medição

- **OS / Arch:** `windows/amd64`
- **CPU:** `AMD Ryzen 7 5800X3D 8-Core Processor` (16 threads)
- **Go Runtime:** `go1.27.4 windows/amd64`
- **Comandos executados após todas as correções finais da Recuperação 04.2:**
  - `go test '-bench=.' -benchmem -count=5 '-run=^$' ./internal/worldevents`
  - `go test '-bench=^BenchmarkSequencedReservationRecovery$' -benchmem -count=5 '-run=^$' ./internal/ecosystem`

## 2. Benchmarks (`-count=5`, mediana das 5 amostras)

| Benchmark | Mediana (ns/op) | Faixa (min–max ns/op) | Memória (B/op) | Alocações (allocs/op) | Escopo Medido |
|---|---:|---|---:|---:|---|
| `BenchmarkSequencedReservationRecovery-16` (`ecosystem`) | **3.258** (~3,26 µs) | 3.225 – 3.332 | 4.578 | 32 | Ciclo completo sequencial (`CreateSequencedReservation` → materializar → reconciliar → concluir → podar) |
| `BenchmarkReservationLifecycle-16` | **11.624** (~11,62 µs) | 11.401 – 12.444 | 7.479 | 45 | Ciclo de reserva completa com `Clone()` do ecossistema |
| `BenchmarkAcknowledgeTerminalOutcome-16` | **20.428** (~20,43 µs) | 19.728 – 23.076 | 69.240 | 59 | Confirmação de resultado terminal + `Validate` cross-layer |
| `BenchmarkEvaluateCandidates-16` | **26.893** (~26,89 µs) | 19.994 – 28.523 | 17.600 | 13 | Avaliação determinística de candidatos (ecossistema dual-hostil) |
| `BenchmarkAcknowledgeDirectorBatch-16` | **33.870** (~33,87 µs) | 31.476 – 34.466 | 102.344 | 82 | Confirmação verificada de lote do diretor + `Validate` cross-layer |
| `BenchmarkAcknowledgeContribution-16` | **36.545** (~36,55 µs) | 33.982 – 37.299 | 102.296 | 81 | Confirmação verificada de contribuição + `Validate` cross-layer |
| `BenchmarkDirectorEventPagination-16` | **48.157** (~48,16 µs) | 45.672 – 49.394 | 140.448 | 112 | Leitura paginada completa de lote de 16 eventos em 4 páginas (`MaxEventsPerUpdate=4`) |
| `BenchmarkOrchestratedStepIntegrated-16` | **147.287** (~147,29 µs) | 121.010 – 153.019 | 101.500 | 198 | Tick pesado de fronteira de epoch (`StepEpoch` + candidatos + escalonador + campanhas + `StepWithDirector` + `Validate`) |
| `BenchmarkCampaignProgressionStep-16` | **162.720** (~162,72 µs) | 141.253 – 183.557 | 122.263 | 131 | `Step` durante campanha `Active` com combate tático + IA + validação 3 camadas |
| `BenchmarkSchedulerEnqueueAndStep-16` | **239.577** (~239,58 µs) | 214.147 – 268.683 | 154.543 | 291 | Enfileiramento de 8 `ScheduledEvent` + `Step` + verificação de orçamento de snapshot v5 |
| `BenchmarkBackpressureRecoveryCycle-16` | **302.414** (~302,41 µs) | 190.762 – 334.893 | 338.677 | 317 | Ciclo completo sob saturação (`MaxPendingDirectorBatches=1`, `MaxEventsPerUpdate=1`): paginação completa → `AcknowledgeDirectorBatchVerified` → retomada do `Step` |
| `BenchmarkOrchestratedSnapshotRoundTrip-16` | **364.726** (~364,73 µs) | 343.821 – 378.351 | 236.554 | 573 | `MarshalSnapshot` v5 (JSON + SHA-256) + `UnmarshalOrchestratedSnapshot` (pré-checagem de bytes + decodificação + `Validate` cross-layer) |

### Tamanhos Reais de Snapshot v5 (`cmd/sim`)
- `Scenario G` (mid-campaign, tick 32): **13.137 bytes** (~12,8 KiB)
- `Scenario L` (bloqueado em backpressure com filas pendentes): **11.415 bytes**
- `Scenario M` (saturação 1-lote / 1-evento-por-página): **10.864 bytes**
- `Scenario N` (reentrega pós-queda): **10.883 bytes**

## 3. Estabilidade de Longa Duração e Memória Retida

1. **Simulação multi-seed de 12.000 ticks (`TestLongDurationMultiSeedStabilityAndBoundedMemory`):**
   - `3` seeds (`10001`, `20002`, `30003`) × `1.000` epochs (`4.000` ticks/seed) = **3.000 epochs / 12.000 ticks**, **78 campanhas** completas resolvidas e confirmadas via APIs públicas.
   - Heap retido (`runtime.GC()` + `runtime.ReadMemStats`): baseline **439.648 B**, pico **669.096 B**, final **586.176 B**.
2. **Simulação prolongada com consumidor lento e capacidades reduzidas (`TestLongDurationSlowConsumerWithSmallCapacities`):**
   - `3` seeds × `800` ticks = **2.400 ticks** sob `MaxPendingDirectorBatches=2`, `MaxEventsPerUpdate=2`, `MaxPendingOutcomes=1`, `MaxPendingContributions=12`, `World.MaxContributions=6`, `MaxReservations=2`.
   - Entregas sem perda/duplicação: `139` lotes, `15` resultados terminais, `60` contribuições, `36` pausas por backpressure todas recuperadas com snapshot/restore no meio da execução.
   - Heap retido: baseline **628.048 B**, pico **630.400 B**, final **583.984 B** (delta líquido **-44.064 B**).
3. **Estresse de 2.000 ciclos de reservas sequenciais (`TestSequencedReservationsRemainBoundedAfterTwoThousandCycles`):**
   - `2.000` ciclos sob `MaxReservations=2` e `MaxRetiredReservationKeys=2`, 0 vazamentos, `len(Reservations) == 0` ao final de cada ciclo e replay rejeitado pós-snapshot (`~10 ms` total).

## 4. Fuzzing Final Pós-Correções (60s por Alvo, 16 Workers)

| Alvo de Fuzzing | Duração | Execuções Totais | Novos Inputs Interessantes | Falhas / Panics |
|---|---:|---:|---:|---:|
| `FuzzCampaignSchedulerAndCommands` (`internal/worldevents`) | 60s | **2.654.904** | 14 (corpus: 178) | **0** |
| `FuzzOutcomeAcknowledgements` (`internal/worldevents` — 3 filas + conflitos) | 60s | **137.081** | 101 (corpus: 190) | **0** |
| `FuzzOrchestratedSnapshotDecode` (`internal/worldevents` — v5) | 60s | **388.971** | 77 (corpus: 344) | **0** |
| `FuzzEcosystemCommandsAndInvariants` (`internal/ecosystem`) | 60s | **5.766.711** | 20 (corpus: 225) | **0** |
| **Total combinado** | **240s** | **8.947.667** | **212** | **0** |

## 5. Gargalos Conhecidos e Margem de Otimização Futura

1. **`OrchestratedState.Clone()` por operação atômica (`Step`, `Acknowledge*`):** principal fonte dos `~69–122 KB/op`. Garante atomicidade trivial sem risco de mutação parcial em erro; otimizações copy-on-write podem ser avaliadas no Ciclo 05+ se o número de regiões/arenas crescer significativamente.
2. **Verificação de orçamento de snapshot via `MarshalSnapshot` em ticks com novos fatos nas filas:** adiciona ~150–200 µs nos ticks em que há emissão de eventos/contribuições, garantindo que nenhum fato enfileirado torne o estado impossível de serializar dentro de `MaxSnapshotBytes`.
