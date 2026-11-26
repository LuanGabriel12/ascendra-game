# ASCENDRA — Dynamic Ecosystem Engine (`internal/ecosystem` + `internal/world`)

## Visão arquitetural em múltiplas escalas

O Ciclo 03 introduz simulação em **duas escalas determinísticas** sem duplicar fontes de verdade:

1. **Escala A — Simulação Tática (`internal/world` + `internal/ai`)**:
   - Frequência: `Tactical Tick` (1 tick por `world.Step`).
   - Simula grupos táticos ativos (`CreatureGroup`), HP, moral, seleção tipada de alvos (`ai.TargetRef`), coordenação espacial 1D otimizada (`O(G log G)`), combate, invasões e limpeza controlada de entidades terminais (`RetiredGroupIDs` limitado).
   - Preserva o teto padrão `MaxActiveGroups = 32`.

2. **Escala B — Simulação de Ecossistema Regional (`internal/ecosystem`)**:
   - Frequência: `Ecosystem Epoch` (1 epoch a cada `Config.TicksPerEpoch` ticks táticos; padrão provisório: `20 ticks`).
   - Simula populações abstratas (`FreePopulation` + `MaterializedPopulation`), 5 recursos ecológicos (`Food`, `Wood`, `Stone`, `Ore`, `Water`), acampamentos dinâmicos, migração determinística em duas fases, competição territorial entre facções e ameaça regional com histerese.
   - Nunca usa `time.Now()`, `float32`/`float64`, `math/rand` global, banco de dados ou ordem de iteração de `map`.

## Grafo de dependências (sem ciclos)

```text
internal/simulation  (RNG SplitMix64, CanonicalHasher SHA-256, Snapshot v3 com MaxBytes)
        ▲
        ├── internal/ports      (Fronteiras CARBON preservadas sem alteração breaking)
        ├── internal/ai         (6 perfis goblin/orc, TargetRef tipado, Coordinate O(G log G))
        ├── internal/ecosystem  (Regiões, recursos, populações, acampamentos, migração, território, ameaça)
        └── internal/world      (World Director + IntegratedState + Materialização/Limpeza)
                ▲
                └── cmd/sim     (Harness CLI headless com 4 cenários táticos + 6 cenários ecológicos A-F)
```

## Ordem determinística das fases de `StepEpoch`

1. Validação de `Config`, `EcosystemState`, limites de capacidade e `Epoch != math.MaxUint64`.
2. Validação e ordenação canônica de comandos (`CanonicalizeCommands`) com verificação estrita de `cmd.Epoch == next.Epoch`.
3. Consumo conservado de recursos naturais, cálculo de `ScarcityBP` e regeneração limitada a `MaxCapacity`.
4. Crescimento populacional discreto inteiro com acumuladores seriais de resíduos e mortalidade (natural + escassez + superpopulação).
5. Migração inter-regional em duas fases (planejamento sobre snapshot imutável → aplicação com conservação exata).
6. Ciclo de vida de acampamentos (estabelecimento, atividade, expansão, fome, ameaça, abandono; respeito a limites e cooldown após destruição).
7. Influência territorial e atrito competitivo exclusivo entre facções explicitamente `StanceHostile` (coexistência pacífica entre `Neutral`/`Allied`).
8. Cálculo de ameaça regional com histerese (`Stable`, `Growing`, `Hostile`, `Critical`) e cooldown de intenção de evento.
9. Revalidação final de todas as invariantes; em qualquer erro, o estado original do chamador permanece intacto.

## Materialização, desmaterialização e ciclo de vida

- **Contabilidade única**: cada população separa `FreePopulation` (indivíduos abstratos livres) e `MaterializedPopulation` (indivíduos atualmente materializados em grupos táticos ativos).
- **Peso populacional explícito (`UnitPopulationWeight`)**: `goblin-skirmisher = 5`, `goblin-raider-pack = 6`, `goblin-taskmaster = 4`, `orc-vanguard = 4`, `orc-berserker = 3`, `orc-warchief = 2` (multiplicado por `Count`).
- **Reserva atômica (`world.MaterializeGroup`)**: valida acampamento operacional (`Active`/`Expanding`/`Threatened`, jamais `Destroyed`/`Abandoned`), move `weight` de `FreePopulation` para `MaterializedPopulation`, verifica `MaxActiveGroups` e ausência em `RetiredGroupIDs`, e cria o `CreatureGroup` vinculado (`SourcePopulationID`, `SourceCampID`, `PopulationWeight`).
- **Reconciliação única (`StepIntegrated` / `DematerializeGroup`)**:
  - Se derrotado (`HP == 0` ou `StateDead`): `survivors = 0`, `losses = PopulationWeight` (ressurreição impossível).
  - Se fugiu vivo ou recolhido: `survivors = ceil(PopulationWeight * HP / MaxHP)` limitado a `[1, PopulationWeight]`; apenas `survivors` retornam a `FreePopulation`.
  - Flag `Accounted = true` impede contabilização duplicada.
- **Limpeza controlada (`cleanupTerminalGroups`)**: após `Accounted == true` e `GroupCleanupRetentionTicks` ticks (padrão `4`), o grupo terminal é removido de `WorldState.Groups` (liberando `MaxActiveGroups`) e seu `GroupID` entra no anel FIFO limitado `RetiredGroupIDs` (`MaxRetiredGroupIDs = 256`), impedindo reuso imediato inseguro sem crescimento infinito de tombstones.

## Eventos ecológicos internos e fronteira futura com CARBON

- **Internos (NEON)**: `PopulationGrew`, `PopulationDeclined`, `ResourceDepleted`, `ResourceRegenerated`, `CampEstablished`, `CampExpanded`, `CampAbandoned`, `CampDestroyed`, `PopulationMigrated`, `TerritorialInfluenceChanged`, `RegionalThreatChanged`, `CreatureGroupMaterialized`, `CreatureGroupDematerialized`.
- **Candidatos futuros para atravessar a fronteira NEON → CARBON** (documentados na proposta de contrato, sem alteração unilateral dos contratos atuais): mudanças relevantes de `CampDestroyed`/`CampEstablished`, `TerritorialInfluenceChanged` de liderança regional, e intenções de `RegionalThreatChanged` em nível `Critical` / resultados consolidados de `WorldEventResult`.
