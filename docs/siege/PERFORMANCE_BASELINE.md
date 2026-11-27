# Siege Engine — Performance Baseline, Fuzzing & Stability Report (Cycle 05)

> **Aviso de escopo (obrigatório):** Todas as medições abaixo são execuções **locais, single-process e headless** da simulação determinística em Go (grupos táticos headless, **não** jogadores conectados em rede nem banco de dados PostgreSQL). Servem exclusivamente como baseline de regressão técnica; **não** representam prontidão de produção.

---

## 1. Ambiente de Medição

- **OS / Arch:** `windows/amd64`
- **CPU:** `AMD Ryzen 7 5800X3D 8-Core Processor` (16 threads)
- **Go Runtime:** `go1.27.4 windows/amd64`
- **Amostras:** `-benchmem -count=5` (executado integralmente após a última edição de código do Ciclo 05)

---

## 2. Benchmarks do Siege Engine e Regressão Comparável (`-count=5`, medianas)

### 2.1 Microbenchmarks e Motor Tático de Cerco (`internal/siege` & `internal/world`)

| Benchmark | Pacote | Mediana (ns/op) | Faixa (min–max ns/op) | Memória (B/op) | Alocações (allocs/op) | Escopo Medido |
|---|---|---:|---|---:|---:|---|
| `BenchmarkSiegeStructureDamageAndRepair-16` | `internal/siege` | **1.917** (~1,92 µs) | 1.843 – 1.965 | 5.360 | 10 | Dano com armadura/resistência + reparo limitado com suprimentos |
| `BenchmarkSiegeObjectiveAndDistrictEvaluation-16` | `internal/siege` | **2.678** (~2,68 µs) | 2.654 – 2.733 | 6.504 | 16 | Captura de distritos com histerese + avaliação de 10 objetivos |
| `BenchmarkSiegeZoneQueries-16` | `internal/siege` | **4.292** (~4,29 µs) | 4.174 – 4.399 | 1.584 | 37 | `NextStepToward` (BFS completo pós-brecha) + `ZoneHopDistance` |
| `BenchmarkSiegeValidateLayout-16` | `internal/siege` | **7.676** (~7,68 µs) | 7.499 – 8.080 | 9.560 | 55 | Validação completa de layout (8 zonas, 10 conexões, 5 estruturas, 10 objetivos, DAG, conectividade) |
| `BenchmarkWorldSiegeStep-16` | `internal/world` | **22.729** (~22,73 µs) | 21.977 – 23.242 | 42.368 | 94 | 1 tick tático completo de cerco (IA + grafo + estruturas + torre + 5 NPCs + distritos + objetivos + fases + `Validate`) |

### 2.2 Motor Orquestrado 3 Camadas — Regressão Direta vs Baseline Recovery 04.2 (`internal/worldevents`)

*Configurações idênticas (sem cerco) comparadas diretamente à Recovery 04.2, separadas das novas medições com cerco ativo:*

| Benchmark | Modo | Baseline 04.2 (ns/op) | Ciclo 05 Mediana (ns/op) | Faixa Ciclo 05 (ns/op) | B/op | allocs/op |
|---|---|---:|---:|---|---:|---:|
| `BenchmarkOrchestratedStepIntegrated-16` | Legado (sem cerco) | 147.287 | **129.738** | 120.781 – 148.077 | 101.935 | 198 |
| `BenchmarkCampaignProgressionStep-16` | Legado (sem cerco) | 162.720 | **126.202** | 121.327 – 133.786 | 122.981 | 131 |
| `BenchmarkBackpressureRecoveryCycle-16` | Legado (sem cerco) | 302.414 | **175.475** | 137.175 – 190.168 | 339.148 | 317 |
| `BenchmarkOrchestratedSnapshotRoundTrip-16` | Legado (v6 sem cerco) | 364.726 | **395.790** | 340.571 – 427.145 | 237.013 | 575 |
| `BenchmarkOrchestratedSiegeStep-16` | **Cerco Ativo Completo** | *Novo (Ciclo 05)* | **256.037** (~256 µs) | 234.067 – 273.308 | 192.380 | 520 |
| `BenchmarkOrchestratedSiegeBackpressureRecovery-16` | **Cerco + Saturação** | *Novo (Ciclo 05)* | **380.377** (~380 µs) | 362.536 – 404.883 | 534.239 | 465 |
| `BenchmarkOrchestratedSiegeSnapshotRoundTrip-16` | **Cerco Ativo (v6)** | *Novo (Ciclo 05)* | **598.586** (~599 µs) | 584.687 – 608.423 | 405.045 | 1.009 |

### Tamanho Real de Snapshot v6 em Cerco (`cmd/sim`)
- `Siege-I-SnapshotDuringBreach` (Snapshot v6 capturado no tick exato da brecha): **20.768 bytes** (~20,3 KiB, `snapshot_verified: true`).

---

## 3. Simulações Prolongadas e Memória Retida

1. **`TestProlongedSuccessiveSiegesMultiSeedAndSlowConsumer` (Ciclo 05):**
   - `3` seeds (`7101`, `7202`, `7303`) × `600` ticks = **1.800 ticks**, **12 cercos sucessivos** completos sob consumidor lento (`MaxPendingDirectorBatches=2`, `MaxEventsPerUpdate=2`, `MaxPendingOutcomes=1`, `MaxReservations=4`).
   - **15 pausas por backpressure** todas recuperadas; `0` resultados duplicados, `0` reservas abandonadas, `0` vazamentos de grupos.
   - Heap pós-GC (`runtime.GC()` + `runtime.ReadMemStats`): baseline **443.624 B**, pico **687.960 B**, final **638.416 B**.
2. **Regressões prolongadas dos Ciclos 03–04.2 (re-executadas no Ciclo 05):**
   - `TestSequencedReservationsRemainBoundedAfterTwoThousandCycles`: **PASS** (2.000 ciclos, `MaxReservations=2`, 0 vazamentos).
   - `TestLongDurationMultiSeedStabilityAndBoundedMemory`: **PASS** (3 seeds × 1.000 epochs = **12.000 ticks**, **78 campanhas**; heap: baseline `681.672 B`, pico `758.176 B`, final `662.840 B`).
   - `TestLongDurationSlowConsumerWithSmallCapacities`: **PASS** (3 seeds × 800 ticks = **2.400 ticks**, `139` lotes, `15` outcomes, `60` contribuições, `36` pausas recuperadas; heap: baseline `704.640 B`, pico `705.400 B`, final `659.392 B`).

---

## 4. Fuzzing Final Pós-Correções (6 Alvos × 60s, 16 Workers)

| Alvo de Fuzzing | Pacote | Duração | Execuções Totais | Novos Inputs (Corpus) | Falhas / Panics |
|---|---|---:|---:|---:|---:|
| `FuzzSiegeStructuresRepairAndZones` | `internal/siege` | 60s | **2.432.420** | +342 (345) | **0** |
| `FuzzSiegeLayoutValidation` | `internal/siege` | 60s | **7.442.537** | +11 (13) | **0** |
| `FuzzSiegeCommandsAndSnapshots` | `internal/worldevents` | 60s | **74.959** | +242 (244) | **0** |
| `FuzzOrchestratedSnapshotDecode` (v6) | `internal/worldevents` | 60s | **280.401** | +22 (366) | **0** |
| `FuzzOutcomeAcknowledgements` | `internal/worldevents` | 60s | **83.839** | +16 (206) | **0** |
| `FuzzEcosystemCommandsAndInvariants` | `internal/ecosystem` | 60s | **5.859.134** | +4 (229) | **0** |
| **Total combinado** | — | **360s** | **16.173.290** | **+637** | **0** |
