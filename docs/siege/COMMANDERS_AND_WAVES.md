# Commanders, Population-Backed Waves, NPC Defenders & Family Siege Policies

## 1. Políticas Diferenciadas: Goblins vs Orcs (Reutilizando `internal/ai`)

Nenhuma implementação paralela de IA foi criada: o Siege Engine consome diretamente `ai.LookupProfile`, `ai.Coordinate` (`O(G log G)`) e `ai.Evaluate`, aplicando especializações de cerco orientadas a dados:

| Dimensão | Cerco Goblin (`goblin-raid-campaign`) | Cerco Orc (`orc-warband-campaign`) |
|---|---|---|
| **Arquétipos** | `goblin-skirmisher`, `goblin-raider-pack`, `goblin-taskmaster` | `orc-vanguard`, `orc-berserker`, `orc-warchief` |
| **Comandante Provisório** | **Skarv, o Rompe-Portões** (`cmdr-skarv`) | **Ghorvak, Punho de Ferro** (`cmdr-ghorvak`) |
| **Aura / Dano de Cerco** | `+900 BP` moral / `+1500 BP` dano estrutural | `+1200 BP` moral / `+2000 BP` dano estrutural |
| **Prioridade Pós-Brecha** | Alvos vulneráveis (`SupplyDepot`, torres/estruturas já danificadas, defensores com menor HP) | Pressão frontal direta (`MainGate`/`OuterWall` → `OuterDistrict` → `Citadel`, defensores de maior ameaça) |
| **Choque por Queda de Comandante** | `-1600 BP` de moral em todos os goblins ativos | `-1100 BP` de moral em todos os orcs ativos |
| **Limiar de Retirada Coletiva** | `<= 2800 BP` moral média | `<= 1400 BP` moral média |
| **Hostilidade** | Continua estritamente controlada por `FactionProfile.HostileToSettlement` (espécies nunca são inerentemente malignas) | Idem |

---

## 2. Comandantes de Cerco (`siege.CommanderState`)

- Cada comandante vincula-se **1-para-1** a um `CreatureGroup` real (`RoleCommander`) materializado a partir da `PopulationReservation` da campanha — **zero população fantasma**.
- Sua derrota dispara `EventCommanderFallen`, aplica choque de moral imediato na família, remove os bônus de aura/dano de cerco, completa automaticamente `ObjDefeatCommander` e pode desencadear retirada tática (`PhaseWithdrawn`).
- Mecânicas multi-fase de encontros avançados ficam reservadas ao futuro **Boss Engine**.

---

## 3. Ondas de Reforços Conservadas na População (`siege.SiegeWave`)

- `TemplateRequiredContingent(tpl)` contabiliza antecipadamente `Recon + MainForces + SiegeWaves + EcologicalReinforcements` dentro da única reserva sequencial (`ecosystem.CreateSequencedReservation`).
- Ao atingir `ScheduledTick` em `CampaignActive`, `processSiegeWaves` chama `ecosystem.MaterializeFromReservation` com `opKey = "wave:" + wave.WaveID` (idempotente) e `world.SpawnCampaignWaveGroup` (validando `CampaignID`, `ReservationID`, `WaveScheduled` e `MaxActiveGroups`).
- Ondas duplicadas são rejeitadas; se o acampamento de origem for destruído antes do disparo, a onda transiciona para `WaveCancelled`; se o cerco encerrar antes do disparo, ondas pendentes são canceladas e todo contingente não materializado retorna exatamente a `FreePopulation` via `CompleteReservation` / `CancelReservation`.
- **Conservação populacional exata:**
  - `TotalPopulation = FreePopulation + ReservedPopulation + MaterializedPopulation`
  - `P_final = P_inicial + births - deaths_nat - casualties_combat + immigration - emigration`
  - Regra explícita de cálculo de baixas em grupos agregados (herdada do Ciclo 03/04 em `internal/ecosystem/reservations.go`): grupos derrotados (`defeated == true` ou `HP == 0`) retornam `0` sobreviventes (`losses = ContingentSize`); grupos recuados/recolhidos vivos retornam $\min\left(\text{ContingentSize}, \max\left(1, \left\lceil \frac{\text{ContingentSize} \times \text{HP}}{\text{MaxHP}} \right\rceil\right)\right)$ via aritmética inteira 128-bit sem ressurreição.

---

## 4. Defensores NPCs (`DefenderEntity` com `IsNPC: true`)

Reutilizando e evoluindo `world.DefenderEntity` sem emitir `ContributionResult` para NPCs:

| Função (`DefenderRole`) | Zona Inicial | Comportamento Determinístico |
|---|---|---|
| `RoleGateDefender` | `ZoneMainGate` | Segura o Portão (`50` dano); reorganiza-se para `ZoneOuterDistrict` após brecha e `ZoneCitadel` em `CitadelAssault` |
| `RoleArcher` | `ZoneMainGate` | Ataque abstrato à distância até `1` hop (`36` dano, cooldown `8`); recua se a linha romper |
| `RoleGuard` | `ZoneOuterDistrict` | Intercepta invasores em distritos internos (`42` dano) e defende a Cidadela na fase final |
| `RoleGuardCaptain` | `ZoneCentralSquare` | Combate de linha de frente (`58` dano) + bônus de coordenação `+15%` de dano a NPCs defensores na mesma zona |
| `RoleRepairUnit` | `ZoneSupplyDistrict` | Desloca-se por arestas válidas até fortificações danificadas (não destruídas) e executa reparos obedecendo suprimentos, cooldown e limites |

Defensores derrotados (`HP == 0`) cessam toda ação, movimento, aura e reparo imediatamente. Comandos de jogadores (`ScopeGameplay`) jamais podem assumir controle de um `DefenderEntity` com `IsNPC == true` (`ErrUnauthorizedCommand`).
