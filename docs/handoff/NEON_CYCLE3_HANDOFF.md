# NEON — Cycle 03 Engineering Handoff (`neon/dynamic-ecosystem-engine`)

**Base auditada:** `349fe698dba57807bbcd1c674bf6e87afbd2a2f9` (`neon/creature-ai-engine`)  
**Branch atual:** `neon/dynamic-ecosystem-engine`  
**Pull Request base sugerido:** `neon/creature-ai-engine` (enquanto PR #2 ainda não estiver integrado à `main`)

## Entregas do Ciclo 03

1. **Dynamic Ecosystem & Population Simulation Engine (`internal/ecosystem`)**:
   - 3 regiões conectadas em grafo de adjacência (`region-valewatch-vale`, `region-thornveil-forest`, `region-ironfang-frontier`).
   - Modelo populacional discreto inteiro com acumuladores de resíduos (`GrowthResidualBP`, `MortalityResidualBP`), `K == 0`, superpopulação e guarda contra geração espontânea de populações extintas.
   - 5 recursos ecológicos (`Food`, `Wood`, `Stone`, `Ore`, `Water`) com consumo proporcional conservado ao inteiro exato e regeneração limitada.
   - Acampamentos dinâmicos (`Establishing`, `Active`, `Expanding`, `ResourceStarved`, `Threatened`, `Abandoned`, `Destroyed`) com limites por região/facção e cooldown após destruição.
   - Migração em duas fases (planejamento sobre snapshot imutável → aplicação com conservação exata `outflow == inflow`).
   - Competição territorial baseada em relações explícitas de facções (facções rivais da mesma família suportadas; facções neutras coexistem sem combate automático).
   - Ameaça regional com histerese (`Stable`, `Growing`, `Hostile`, `Critical`) e cooldown de intenção de evento.
2. **Integração multi-escala e ciclo de vida (`internal/world/ecosystem_bridge.go`, `director.go`, `types.go`)**:
   - `IntegratedState` mantém fonte única de verdade (`FreePopulation` + `MaterializedPopulation`) verificada por invariante cruzada.
   - `MaterializeGroup`, `DematerializeGroup` e `StepIntegrated` reconciliam baixas e sobreviventes estritamente uma vez (zero duplicação, zero ressurreição).
   - `cleanupTerminalGroups` remove grupos mortos/dispersos após reconciliação e janela de retenção (`GroupCleanupRetentionTicks`), liberando capacidade sob `MaxActiveGroups = 32` e registrando IDs no anel FIFO limitado `RetiredGroupIDs`.
3. **Otimização espacial 1D e segurança de snapshots (`internal/ai`, `internal/simulation`)**:
   - `ai.Coordinate` reescrito com índice espacial 1D + somas de prefixo + busca binária (`O(G log G)`): **679× mais rápido** em 10.000 grupos empilhados (`987,1 ms -> 1,45 ms`), com equivalência exata verificada contra referência `O(G²)`.
   - `SnapshotVersion = 3` com teto explícito de bytes (`MaxBytes`) verificado **antes** de instanciar `json.NewDecoder`.
   - Identidade tipada `ai.TargetRef{Kind, ID}`, perfil independente `orc-berserker`, `EventCommanderFallen` com choque de moral e memória de retenção de alvo (`TargetMemoryTicks`).

## Cobertura, Fuzzing e Longa Duração (evidências reais)

- **Cobertura (`go test -count=1 -cover ./...`)**: `internal/simulation` **100,0%**, `internal/adapters/memory` **97,1%**, `internal/ports` **96,8%**, `internal/ai` **85,3%**, `internal/ecosystem` **85,0%**, `internal/world` **78,3%**, `cmd/sim` **73,7%**.
- **Regressão & Concorrência**: `go vet`, `go build`, `go test -race -count=1 ./...` e `go test -shuffle=on -count=10 ./...` 100% verdes.
- **Fuzzing (30s por alvo, 16 workers, 0 falhas)**:
  - `FuzzEcosystemCommandsAndInvariants`: `1.127.880` execuções.
  - `FuzzEcosystemSnapshotDecode`: `95.018` execuções.
  - `FuzzCommandValidation`: `2.497.023` execuções.
- **Simulações de longa duração**: 3.000 epochs estáveis (`seed 20260301`) + 2.000 epochs adversos (`seed 20260302`) concluídos sem extinções involuntárias no cenário estável, sem explosão populacional, sem vazamento de acampamentos/eventos e sem erros numéricos.

## Fronteira com CARBON

- Contratos existentes em `internal/ports/carbon.go` não sofreram alterações breaking.
- Nenhum código TypeScript, PostgreSQL ou regra persistente do CARBON foi introduzido.
- Proposta inicial de projeções futuras (`RegionSnapshot`, `FactionSnapshot`, `PopulationSnapshot`, `CampSnapshot`, `SettlementDefenseSnapshot`, `WorldEventResult`) documentada em [NEON_ECOSYSTEM_CONTRACT_PROPOSAL.md](../contracts/NEON_ECOSYSTEM_CONTRACT_PROPOSAL.md) para revisão conjunta.
