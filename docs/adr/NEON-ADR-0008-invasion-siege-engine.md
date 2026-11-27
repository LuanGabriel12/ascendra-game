# NEON-ADR-0008: Invasion, Siege & Settlement Battle Engine (`internal/siege`), Single Tactical Authority e Snapshot v6

- **Status:** `Proposed` (sujeito a auditoria independente CODEX e revisão de contratos com CARBON)
- **Data:** 2026-11-26
- **Owner:** NEON
- **Identificador exclusivo:** `NEON-ADR-0008` (prefixo `NEON-` garantindo ausência de colisão com ADRs do CARBON)

---

## 1. Contexto

Ao término da Recuperação 04.2 (`b0a2088`), o núcleo determinístico do ASCENDRA contava com:
- **Ecosystem Engine (`internal/ecosystem`)**: populações em 3 compartimentos (`Free + Reserved + Materialized`), reservas sequenciais contíguas (`CreateSequencedReservation`), acampamentos dinâmicos, recursos conservados e ameaça regional;
- **World Event Director (`internal/worldevents`)**: campanhas data-driven de Goblins e Orcs, escalonador determinístico, filas confirmáveis (`PendingDirectorBatches`, `PendingOutcomes`, `PendingContributions`) e recuperação de backpressure;
- **Tactical World Engine (`internal/world`) + Creature AI (`internal/ai`)**: invasões lineares em 1D com `SettlementDefenseHP` escalar único, sem grafo de zonas, sem fortificações diferenciadas, sem fases internas de cerco, sem comandantes táticos dedicados, sem ondas estruturadas, sem reparação limitada por suprimentos e com `CmdCompleteObjective` ainda aceitando conclusão por ID arbitrário.

Para transformar invasões em batalhas estruturadas de cerco preservando determinismo, conservação populacional, filas confirmáveis e autoridade tática única, é necessário introduzir uma fundação extensível de cerco sem criar um segundo motor decisor nem mover lógica de combate para `internal/worldevents`.

---

## 2. Decisão Arquitetural

### 2.1 Novo Pacote Acíclico `internal/siege`

Introduzimos o pacote puro e headless `internal/siege` posicionado abaixo de `internal/world` no grafo de dependências:

```text
internal/simulation ◄── internal/ai ◄── internal/siege ◄── internal/world ◄── internal/worldevents ◄── cmd/sim
internal/ports      ◄─────────────────┘                ▲                  ▲
internal/ecosystem  ───────────────────────────────────┴──────────────────┘
```

- `internal/siege` depende apenas de `internal/ai`, `internal/simulation` e `internal/ports` (exclusivamente enum de desfecho somente leitura). **Zero** dependências de `internal/world`, `internal/ecosystem`, `internal/worldevents`, I/O, rede, clock ou ponto flutuante.
- **`internal/world` permanece a ÚNICA autoridade tática** (`world.Step`): `WorldState` carrega um ponteiro opcional `Siege *siege.SiegeState`.
  - Quando `Siege == nil`: `world.Step` preserva integralmente o comportamento dos Ciclos 01–04 (100% de regressão dos 24 cenários existentes).
  - Quando `Siege != nil`: `world.Step` executa o ciclo de cerco integrado (movimento no grafo de zonas, dano a fortificações, brechas, fogo de torres, ações de defensores NPCs, objetivos autoritativos, captura de distritos, moral de comandante, retirada/anti-stall e resolução tática única), chamando `resolveInvasion` exatamente uma vez na transição terminal.
- `internal/worldevents` **não** executa regras de combate nem decisão de vitória/derrota; apenas orquestra o layout inicial do cerco, o agendamento/materialização de ondas via reservas sequenciais (`MaterializeFromReservation`), o registro de ocupação pós-`Captured` e o encaminhamento das filas confirmáveis.

### 2.2 Modelo Espacial: Grafo Determinístico de Zonas Conectadas

Em vez de fingir navegação 2D completa ou adicionar navmesh/física, modelamos a cidade fortificada como um grafo dirigido/bidirecional de zonas com regras explícitas de travessia:
- Zonas padrão (`layout-valewatch-bastion`, provisória local): `zone-exterior-field` → `zone-wall-approach` → `zone-main-gate` → `zone-outer-district` → (`zone-supply-district`, `zone-civil-district`, `zone-central-square`) → `zone-citadel`, mais conexão de brecha `zone-wall-approach` → `zone-outer-district` condicionada à brecha da muralha (`str-outer-wall`).
- Cada `Zone` possui `PositionHint` escalar (`WorldUnits`) para compatibilidade com a coordenação 1D existente (`internal/ai`) e extensibilidade limpa para futuras coordenadas `(X, Y)` 2D.
- **Anti-teletransporte:** movimentação entre zonas só ocorre por arestas válidas verificadas por `CanTraverse(from, to, isInvader)` (portão intacto bloqueia invasores; brecha na muralha ou destruição do portão libera passagem).

### 2.3 Fonte Única de Verdade para Condição Defensiva (`SettlementDefenseHP`)

Quando `WorldState.Siege != nil`:
- `WorldState.SettlementMaxDefenseHP == Siege.TotalStructureMaxHP()`
- `WorldState.SettlementDefenseHP == Siege.TotalStructureHP()`
- Essas igualdades são verificadas continuamente em `WorldState.Validate()` e ressincronizadas atomicamente após qualquer dano ou reparo estrutural. É estruturalmente impossível haver duas fontes divergentes para a integridade da cidade.
- Os layouts provisórios padrão (`settlement-valewatch`: 1000 HP total; `settlement-ironford`: 1500 HP total) preservam exatamente o `MaxDefenseHP` do `ports.SettlementSnapshot` sem alterar `internal/ports/carbon.go`.

### 2.4 Fases do Cerco e Mapeamento para Contratos Compartilhados

- Fases explícitas de cerco (`siege.SiegePhase`): `Approach -> Assault -> Breach -> DistrictCombat -> CitadelAssault -> Resolving -> Defended | Captured | Withdrawn`, com FSM estrita (`ValidatePhaseTransition`).
- Separação clara: `CampaignState` (`internal/worldevents`) controla a campanha mundial; `InvasionState` (`internal/world`) controla o ciclo de invasão da arena; `SiegePhase` (`internal/siege`) controla a progressão interna durante `InvasionUnderAttack`.
- Mapeamento conservador para `ports.InvasionOutcome` sem quebrar contratos CARBON:
  - `PhaseDefended` → `ports.InvasionOutcomeDefended`
  - `PhaseWithdrawn` → `ports.InvasionOutcomeDefended` (com `SiegePhase = "Withdrawn"` preservado no fato estendido `TerminalSettlementOutcome` para observabilidade/proposta futura, sem criar terceiro enum incompatível em `ports.InvasionOutcome`)
  - `PhaseCaptured` → `ports.InvasionOutcomeCaptured`

### 2.5 Suprimentos Táticos, Reparação Finita e Política de Estruturas Destruídas

- Suprimentos (`SiegeSupplies`) são recursos temporários de batalha, **não** inventário ou moeda persistente.
- **Política explícita:** `AllowDestroyedStructureRepairInBattle = false` por padrão — estruturas com `HP == 0` (`Destroyed`) **não** podem ser restauradas durante o combate; sua reconstrução pertence ao período pós-batalha/CARBON.
- Reparação finita garantida por cinco limites simultâneos: custo em suprimentos, teto global `MaxSupplyRegenTotal` (regeneração cessa imediatamente se o Depósito de Suprimentos for destruído), cooldown por entidade, `MaxRepairsPerStructure` e `MaxRepairsPerEntity`.

### 2.6 Comandantes e Ondas 100% Conservados na População

- Todo comandante de cerco (ex.: `Skarv, o Rompe-Portões` goblin; `Ghorvak, Punho de Ferro` orc — nomes provisórios) vincula-se 1-para-1 a um `CreatureGroup` real materializado a partir da `PopulationReservation` da campanha.
- Ondas de cerco (`SiegeWave`) utilizam exclusivamente `ecosystem.MaterializeFromReservation` com `opKey` idempotente (`"wave:" + WaveID`). Ondas duplicadas são rejeitadas e ondas não disparadas devolvem seu contingente reservado via `CompleteReservation`/`CancelReservation`.

### 2.7 Eliminação de Bloqueio Permanente por `ErrTickEventCapacity`

- Introduzimos `worldevents.MinEventsPerBatch(cfg)` verificado antecipadamente em `Config.Validate()` e `OrchestratedConfig.Validate()`, impedindo que configurações incapazes de comportar os eventos obrigatórios de um tick sejam aceitas.
- Operações opcionais em `worldevents.Step` (agendamento de novos candidatos e expiração/despacho em massa do escalonador) reservam capacidade obrigatória e limitam o volume por tick, deixando trabalho opcional excedente para o tick seguinte de forma determinística.

### 2.8 Snapshot v6 (`simulation.SnapshotVersion = 6`)

- Incrementamos `SnapshotVersion` de `5` para `6` devido à inclusão do estado completo de cerco (`WorldState.Siege`, `CreatureGroup.ZoneID`, `DefenderEntity` estendido, `DirectorState.OccupiedSettlements`, campos estendidos de `TerminalSettlementOutcome`).
- Versões `v1`–`v5` são explicitamente rejeitadas com `simulation.ErrUnsupportedSnapshotVersion` (sem migração automática silenciosa).

---

## 3. Alternativas Consideradas

1. **Colocar toda a lógica de cerco diretamente em `internal/world`**: descartada por inflar `internal/world`, misturar grafo de zonas/estruturas/objetivos com comandos gerais e reduzir modularidade e testabilidade isolada.
2. **Criar um loop paralelo em `internal/siege` que decide vitória/derrota fora de `world.Step`**: descartada; violaria o princípio de autoridade tática única e arriscaria divergência com `InvasionState` e `ContributionResult`.
3. **Adicionar um terceiro valor `Withdrawn` em `ports.InvasionOutcome`**: descartada; quebraria `contracts/neon-carbon/contribution-result.v1.schema.json` publicado pelo CARBON (`enum: ["Defended", "Captured"]`).
4. **Manter `SnapshotVersion = 5` com campos opcionais**: descartada; novos invariantes cross-layer (como sincronização `SettlementDefenseHP == TotalStructureHP` e `ZoneID` obrigatório em cerco) tornam v5 semanticamente distinto de v6.

---

## 4. Consequências e Limitações

- **Positivas:** batalhas de cerco estruturadas, observáveis e determinísticas; autoridade única preservada; conservação populacional estrita (`Total == Free + Reserved + Materialized`); zero quebra dos contratos CARBON (`internal/ports/carbon.go`) e dos 24 cenários anteriores; fechamento de `ErrTickEventCapacity` para configurações válidas; fundação pronta para reconquista usando a mesma infraestrutura.
- **Negativas / Trade-offs:** quebra explícita de snapshot `v5 -> v6`; escopo continua limitado a 1 arena de cerco simultânea por simulação; o grafo de zonas é uma abstração topológica determinística (física 2D, hitboxes, frame data e netcode pertencem a ciclos futuros).

---

## 5. Reversibilidade

**Alta** para balanceamento (HP, armadura, resistência, custos de reparo, limiares de captura/moral, nomes provisórios de layouts e comandantes); **Média** para `SnapshotVersion = 6` e contrato estendido de `TerminalSettlementOutcome`.
