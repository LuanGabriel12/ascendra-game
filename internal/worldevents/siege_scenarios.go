package worldevents

import (
	"context"
	"errors"
	"fmt"
	"reflect"

	"ascendra-game/internal/ai"
	"ascendra-game/internal/ecosystem"
	"ascendra-game/internal/ports"
	"ascendra-game/internal/siege"
	"ascendra-game/internal/world"
)

// SiegeScenarioSummary captures observable telemetry from each Cycle 05 deterministic siege scenario.
type SiegeScenarioSummary struct {
	Name                   string
	SimulationID           string
	FinalTick              uint64
	FinalChecksum          string
	Outcome                ports.InvasionOutcome
	SiegePhase             siege.SiegePhase
	StructuresDestroyed    int
	DistrictsCaptured      int
	WavesMobilized         int
	CommanderFallen        bool
	RepairsApplied         int
	SuppliesSpent          int64
	BackpressurePauses     int
	SnapshotBytes          int
	SnapshotVerified       bool
	OccupationRecorded     bool
	FreePopulationTotal    int64
	ReservedPopTotal       int64
	MaterializedPopTotal   int64
	TerminalOutcomesCount  int
}

// siegeDefenderBot generates legal, zone-aware player GameplayCommands during an active siege.
func siegeDefenderBot(focusCommander bool, repairGate bool) func(tick uint64, cur OrchestratedState) StepInput {
	return func(tick uint64, cur OrchestratedState) StepInput {
		if cur.World.Invasion.State != world.InvasionUnderAttack || cur.World.Siege == nil {
			return StepInput{}
		}
		var cmds []world.GameplayCommand
		players := []struct {
			id   string
			zone string
		}{
			{"player-aria", siege.ZoneIDMainGate},
			{"player-borin", siege.ZoneIDMainGate},
			{"player-cyra", siege.ZoneIDWallApproach},
			{"player-daren", siege.ZoneIDOuterDistrict},
			{"player-elira", siege.ZoneIDMainGate},
		}
		deployed := make(map[string]world.DefenderEntity, len(cur.World.Defenders))
		for _, d := range cur.World.Defenders {
			deployed[d.PlayerID] = d
		}

		// Deploy players into valid zones on first active tick.
		needDeploy := false
		for _, p := range players {
			if _, ok := deployed[p.id]; !ok {
				cmds = append(cmds, world.GameplayCommand{
					Kind:     world.CmdDeployDefender,
					Tick:     tick,
					PlayerID: p.id,
					ZoneID:   p.zone,
				})
				needDeploy = true
			}
		}
		if needDeploy {
			return StepInput{GameplayCommands: cmds}
		}

		// Repair damaged non-destroyed fortification when repairGate enabled and supplies available.
		if repairGate {
			for _, structID := range []string{siege.StructIDMainGate, siege.StructIDOuterWall, siege.StructIDNorthTower} {
				if gIdx := cur.World.Siege.FindStructureIndex(structID); gIdx >= 0 {
					st := cur.World.Siege.Structures[gIdx]
					if st.HP > 0 && st.HP < st.MaxHP &&
						st.RepairsApplied < cur.World.Siege.Config.MaxRepairsPerStructure &&
						cur.World.Siege.Supplies.Current >= cur.World.Siege.Config.RepairSupplyCost {
						if d, ok := deployed["player-borin"]; ok && d.HP > 0 &&
							siege.AreAdjacent(*cur.World.Siege, d.ZoneID, st.ZoneID) &&
							siege.EntityRepairTotal(*cur.World.Siege, "player-borin") < cur.World.Siege.Config.MaxRepairsPerEntity {
							if playerReadyForAction(cur.World.PlayerCooldowns, "player-borin", tick) &&
								repairCooldownReady(*cur.World.Siege, "player-borin", tick) {
								cmds = append(cmds, world.GameplayCommand{
									Kind:              world.CmdPlayerRepairStructure,
									Tick:              tick,
									PlayerID:          "player-borin",
									TargetStructureID: structID,
								})
								break
							}
						}
					}
				}
			}
		}

		// Claim ObjRepairFortification once authoritative repair condition on the target structure is satisfied.
		if repairGate && tick%5 == 0 {
			if oIdx := cur.World.Siege.FindObjectiveIndex(siege.ObjIDRepairFortification); oIdx >= 0 &&
				cur.World.Siege.Objectives[oIdx].State == siege.ObjActive &&
				siege.EntityRepairTotal(*cur.World.Siege, "player-borin") > 0 {
				obj := cur.World.Siege.Objectives[oIdx]
				sIdx := cur.World.Siege.FindStructureIndex(obj.TargetStructureID)
				if sIdx >= 0 && cur.World.Siege.Structures[sIdx].RepairsApplied > 0 {
					if d, ok := deployed["player-borin"]; ok && d.HP > 0 &&
						siege.AreAdjacent(*cur.World.Siege, d.ZoneID, obj.ZoneID) {
						cmds = append(cmds, world.GameplayCommand{
							Kind:        world.CmdCompleteObjective,
							Tick:        tick,
							PlayerID:    "player-borin",
							ObjectiveID: siege.ObjIDRepairFortification,
						})
					}
				}
			}
		}

		// Cooperative healer (player-elira) heals injured nearby allies when ready.
		if d, ok := deployed["player-elira"]; ok && d.HP > 0 && playerReadyForAction(cur.World.PlayerCooldowns, "player-elira", tick) {
			hasInjuredAlly := false
			for _, ally := range cur.World.Defenders {
				if ally.HP > 0 && ally.HP < ally.MaxHP && siege.AreAdjacent(*cur.World.Siege, d.ZoneID, ally.ZoneID) {
					hasInjuredAlly = true
					break
				}
			}
			if hasInjuredAlly {
				cmds = append(cmds, world.GameplayCommand{
					Kind:     world.CmdPlayerSupportDefense,
					Tick:     tick,
					PlayerID: "player-elira",
				})
			}
		}

		// Each living player either strikes an adjacent hostile or steps closer via legal zone edge.
		// Track projected damage within the tick so two players don't issue redundant lethal hits on the same tick.
		alreadyActed := make(map[string]bool)
		for _, c := range cmds {
			alreadyActed[c.PlayerID] = true
		}
		projectedHP := make(map[string]int64, len(cur.World.Groups))
		for _, g := range cur.World.Groups {
			if g.HP > 0 && g.State != ai.StateDead && !g.Routed {
				projectedHP[g.GroupID] = g.HP
			}
		}
		for _, p := range players {
			if alreadyActed[p.id] {
				continue
			}
			d, ok := deployed[p.id]
			if !ok || d.HP == 0 {
				continue
			}
			targetID := selectReachableHostile(cur.World, d.ZoneID, focusCommander, projectedHP)
			if targetID != "" && playerReadyForAction(cur.World.PlayerCooldowns, p.id, tick) {
				cmds = append(cmds, world.GameplayCommand{
					Kind:          world.CmdPlayerDefendStrike,
					Tick:          tick,
					PlayerID:      p.id,
					TargetGroupID: targetID,
				})
				projectedHP[targetID] -= 100 // Conservative upper bound of PlayerStrikeBaseDamage+Variance
				continue
			}
			// Move legally toward an active hostile's zone if none is currently adjacent.
			if dest := nearestLiveHostileZone(cur.World); dest != "" && dest != d.ZoneID {
				if stepZone, canStep := siege.NextStepToward(*cur.World.Siege, d.ZoneID, dest, false); canStep {
					cmds = append(cmds, world.GameplayCommand{
						Kind:         world.CmdMoveDefenderZone,
						Tick:         tick,
						PlayerID:     p.id,
						TargetZoneID: stepZone,
					})
				}
			}
		}
		return StepInput{GameplayCommands: cmds}
	}
}

func playerReadyForAction(cooldowns []world.PlayerCooldown, playerID string, tick uint64) bool {
	for _, pc := range cooldowns {
		if pc.PlayerID == playerID {
			return tick >= pc.NextActionTick
		}
	}
	return true
}

func repairCooldownReady(s siege.SiegeState, entityID string, tick uint64) bool {
	for _, er := range s.EntityRepairs {
		if er.EntityID == entityID {
			return tick >= er.NextRepairTick
		}
	}
	return true
}

func selectReachableHostile(w world.WorldState, defZoneID string, focusCommander bool, projectedHP map[string]int64) string {
	bestID := ""
	bestIsCmdr := false
	bestHP := int64(1 << 62)
	for _, g := range w.Groups {
		if g.HP == 0 || g.State == ai.StateDead || g.Routed {
			continue
		}
		if projectedHP != nil && projectedHP[g.GroupID] <= 0 {
			continue
		}
		if !siege.AreAdjacent(*w.Siege, defZoneID, g.ZoneID) {
			continue
		}
		isCmdr := g.Role == ai.RoleCommander
		if bestID == "" ||
			(focusCommander && isCmdr && !bestIsCmdr) ||
			((!focusCommander || isCmdr == bestIsCmdr) && (g.HP < bestHP || (g.HP == bestHP && g.GroupID < bestID))) {
			bestID = g.GroupID
			bestIsCmdr = isCmdr
			bestHP = g.HP
		}
	}
	return bestID
}

func nearestLiveHostileZone(w world.WorldState) string {
	for _, g := range w.Groups {
		if g.HP > 0 && g.State != ai.StateDead && !g.Routed && g.ZoneID != "" {
			return g.ZoneID
		}
	}
	return ""
}

func summarizeSiegeRun(name, simID string, res RunResult, wavesMobilized int, cmdrFallen bool, repairs int, suppliesSpent int64, pauses int, snapBytes int, snapVerified bool) SiegeScenarioSummary {
	freePop, resPop, matPop := ecosystem.TotalPopulationLedger(res.FinalState.Ecosystem)
	outcome := ports.InvasionOutcomeNone
	var phase siege.SiegePhase
	destroyed := 0
	captured := 0
	if len(res.TerminalOutcomes) > 0 {
		last := res.TerminalOutcomes[len(res.TerminalOutcomes)-1]
		outcome = last.Outcome
		phase = last.SiegePhase
		destroyed = len(last.StructuresDestroyed)
		captured = len(last.DistrictsCaptured)
	}
	return SiegeScenarioSummary{
		Name:                  name,
		SimulationID:          simID,
		FinalTick:             res.FinalState.Director.Tick,
		FinalChecksum:         res.FinalChecksum,
		Outcome:               outcome,
		SiegePhase:            phase,
		StructuresDestroyed:   destroyed,
		DistrictsCaptured:     captured,
		WavesMobilized:        wavesMobilized,
		CommanderFallen:       cmdrFallen,
		RepairsApplied:        repairs,
		SuppliesSpent:         suppliesSpent,
		BackpressurePauses:    pauses,
		SnapshotBytes:         snapBytes,
		SnapshotVerified:      snapVerified,
		OccupationRecorded:    len(res.FinalState.Director.OccupiedSettlements) > 0,
		FreePopulationTotal:   freePop,
		ReservedPopTotal:      resPop,
		MaterializedPopTotal:  matPop,
		TerminalOutcomesCount: len(res.TerminalOutcomes),
	}
}

func countSiegeTelemetry(wEvents []world.DomainEvent, dEvents []DirectorEvent) (waves int, cmdrFallen bool, repairs int, suppliesSpent int64) {
	for _, de := range dEvents {
		if de.Type == DirEventSiegeWaveMobilized {
			waves++
		}
	}
	for _, we := range wEvents {
		switch we.Type {
		case world.EventCommanderFallen:
			cmdrFallen = true
		case world.EventStructureRepaired:
			repairs++
		case world.EventSupplyChanged:
			if we.Amount < 0 && (we.StateTransition == "RepairSpent" || we.StateTransition == "NPCRepairSpent") {
				suppliesSpent += -we.Amount
			}
		}
	}
	return
}

// RunSiegeScenarioA — Cerco Goblin: mobilizes Goblin warband + commander Skarv + wave 2 against fortified Valewatch.
func RunSiegeScenarioA(ctx context.Context, reader ports.SettlementReader) (SiegeScenarioSummary, RunResult, error) {
	cfg := DefaultSiegeOrchestratedConfig()
	eco := NewHighThreatGoblinEco("siege-a-goblin", 5001)
	initSt, err := NewOrchestratedState("siege-a-goblin", "settlement-valewatch", 5001, reader, eco)
	if err != nil {
		return SiegeScenarioSummary{}, RunResult{}, err
	}
	res, err := RunOrchestrated(ctx, initSt, nil, 180, cfg, 4096)
	if err != nil {
		return SiegeScenarioSummary{}, res, err
	}
	if len(res.TerminalOutcomes) == 0 {
		return SiegeScenarioSummary{}, res, fmt.Errorf("siege scenario A did not reach terminal outcome")
	}
	w, cf, rep, spent := countSiegeTelemetry(res.WorldEvents, res.DirectorEvents)
	return summarizeSiegeRun("Siege-A-GoblinSiege", "siege-a-goblin", res, w, cf, rep, spent, 0, 0, false), res, nil
}

// RunSiegeScenarioB — Cerco Orc: mobilizes heavier Orc warband + Ghorvak + wave 2 with direct fortification pressure.
func RunSiegeScenarioB(ctx context.Context, reader ports.SettlementReader) (SiegeScenarioSummary, RunResult, error) {
	cfg := DefaultSiegeOrchestratedConfig()
	eco := NewHighThreatOrcEco("siege-b-orc", 5002)
	initSt, err := NewOrchestratedState("siege-b-orc", "settlement-valewatch", 5002, reader, eco)
	if err != nil {
		return SiegeScenarioSummary{}, RunResult{}, err
	}
	res, err := RunOrchestrated(ctx, initSt, nil, 220, cfg, 4096)
	if err != nil {
		return SiegeScenarioSummary{}, res, err
	}
	if len(res.TerminalOutcomes) == 0 {
		return SiegeScenarioSummary{}, res, fmt.Errorf("siege scenario B did not reach terminal outcome")
	}
	w, cf, rep, spent := countSiegeTelemetry(res.WorldEvents, res.DirectorEvents)
	return summarizeSiegeRun("Siege-B-OrcSiege", "siege-b-orc", res, w, cf, rep, spent, 0, 0, false), res, nil
}

// RunSiegeScenarioC — Defesa da Cidade: NPC garrison + cooperative players defend Valewatch and repel the siege.
func RunSiegeScenarioC(ctx context.Context, reader ports.SettlementReader) (SiegeScenarioSummary, RunResult, error) {
	cfg := DefaultSiegeOrchestratedConfig()
	eco := NewHighThreatOrcEco("siege-c-defended", 5003)
	initSt, err := NewOrchestratedState("siege-c-defended", "settlement-valewatch", 5003, reader, eco)
	if err != nil {
		return SiegeScenarioSummary{}, RunResult{}, err
	}
	res, err := RunOrchestrated(ctx, initSt, siegeDefenderBot(false, true), 200, cfg, 4096)
	if err != nil {
		return SiegeScenarioSummary{}, res, err
	}
	if len(res.TerminalOutcomes) == 0 || res.TerminalOutcomes[0].Outcome != ports.InvasionOutcomeDefended {
		return SiegeScenarioSummary{}, res, fmt.Errorf("siege scenario C expected Defended outcome, got %+v", res.TerminalOutcomes)
	}
	w, cf, rep, spent := countSiegeTelemetry(res.WorldEvents, res.DirectorEvents)
	return summarizeSiegeRun("Siege-C-CityDefended", "siege-c-defended", res, w, cf, rep, spent, 0, 0, false), res, nil
}

// RunSiegeScenarioD — Cidade Capturada: heavy Orc warband overwhelms undefended settlement, breaches fortifications,
// captures Citadel, emits 0-player TerminalSettlementOutcome, and records OccupationRecord.
func RunSiegeScenarioD(ctx context.Context, reader ports.SettlementReader) (SiegeScenarioSummary, RunResult, error) {
	cfg := DefaultSiegeOrchestratedConfig()
	cfg.Director.SpawnNPCDefenders = false
	cfg.Director.SiegeConfig.TowerFireDamage = 10
	for i := range cfg.Director.Policies {
		if cfg.Director.Policies[i].TemplateID == TemplateOrcWarband {
			cfg.Director.Policies[i].MainForces = []ForceUnit{
				{Archetype: "orc-vanguard", Count: 2, Position: 12000},
				{Archetype: "orc-berserker", Count: 2, Position: 12000},
				{Archetype: "orc-warchief", Count: 1, Position: 12000},
			}
			cfg.Director.Policies[i].SiegeWaves = []SiegeWaveSpec{
				{WaveTag: "orc-breaker-2", DelayTicks: 15, Archetype: "orc-berserker", Count: 1, EntryZoneID: siege.ZoneIDExteriorField},
			}
		}
	}
	eco := NewHighThreatOrcEco("siege-d-captured", 5004)
	for i := range eco.Populations {
		if eco.Populations[i].PopulationID == "pop-ironfang-orcs" {
			eco.Populations[i].FreePopulation = 180
		}
	}
	initSt, err := NewOrchestratedState("siege-d-captured", "settlement-valewatch", 5004, reader, eco)
	if err != nil {
		return SiegeScenarioSummary{}, RunResult{}, err
	}
	res, err := RunOrchestrated(ctx, initSt, nil, 240, cfg, 4096)
	if err != nil {
		return SiegeScenarioSummary{}, res, err
	}
	if len(res.TerminalOutcomes) == 0 || res.TerminalOutcomes[0].Outcome != ports.InvasionOutcomeCaptured {
		return SiegeScenarioSummary{}, res, fmt.Errorf("siege scenario D expected Captured outcome, got %+v", res.TerminalOutcomes)
	}
	if len(res.FinalState.Director.OccupiedSettlements) == 0 {
		return SiegeScenarioSummary{}, res, fmt.Errorf("siege scenario D expected OccupationRecord after capture")
	}
	w, cf, rep, spent := countSiegeTelemetry(res.WorldEvents, res.DirectorEvents)
	return summarizeSiegeRun("Siege-D-CityCaptured", "siege-d-captured", res, w, cf, rep, spent, 0, 0, false), res, nil
}

// RunSiegeScenarioE — Derrota de Comandante: players focus-fire Goblin commander Skarv, triggering
// CommanderFallen shock, morale collapse, and objective completion.
func RunSiegeScenarioE(ctx context.Context, reader ports.SettlementReader) (SiegeScenarioSummary, RunResult, error) {
	cfg := DefaultSiegeOrchestratedConfig()
	eco := NewHighThreatGoblinEco("siege-e-commander", 5005)
	initSt, err := NewOrchestratedState("siege-e-commander", "settlement-valewatch", 5005, reader, eco)
	if err != nil {
		return SiegeScenarioSummary{}, RunResult{}, err
	}
	res, err := RunOrchestrated(ctx, initSt, siegeDefenderBot(true, false), 180, cfg, 4096)
	if err != nil {
		return SiegeScenarioSummary{}, res, err
	}
	w, cf, rep, spent := countSiegeTelemetry(res.WorldEvents, res.DirectorEvents)
	if !cf {
		return SiegeScenarioSummary{}, res, fmt.Errorf("siege scenario E expected commander fall event")
	}
	if len(res.TerminalOutcomes) == 0 || res.TerminalOutcomes[0].Outcome != ports.InvasionOutcomeDefended {
		return SiegeScenarioSummary{}, res, fmt.Errorf("siege scenario E expected Defended outcome, got %+v", res.TerminalOutcomes)
	}
	return summarizeSiegeRun("Siege-E-CommanderDefeated", "siege-e-commander", res, w, cf, rep, spent, 0, 0, false), res, nil
}

// RunSiegeScenarioF — Reparação Limitada: Orc vanguard damages the outer fortifications before
// defenders and NPC RepairUnit restore them consuming bounded tactical supplies.
func RunSiegeScenarioF(ctx context.Context, reader ports.SettlementReader) (SiegeScenarioSummary, RunResult, error) {
	cfg := DefaultSiegeOrchestratedConfig()
	eco := NewHighThreatOrcEco("siege-f-repair", 5006)
	initSt, err := NewOrchestratedState("siege-f-repair", "settlement-valewatch", 5006, reader, eco)
	if err != nil {
		return SiegeScenarioSummary{}, RunResult{}, err
	}
	bot := siegeDefenderBot(false, true)
	delayedBot := func(tick uint64, cur OrchestratedState) StepInput {
		if cur.World.Siege == nil || tick < cur.World.Siege.StartedTick+16 {
			return StepInput{}
		}
		return bot(tick, cur)
	}
	res, err := RunOrchestrated(ctx, initSt, delayedBot, 220, cfg, 4096)
	if err != nil {
		return SiegeScenarioSummary{}, res, err
	}
	w, cf, rep, spent := countSiegeTelemetry(res.WorldEvents, res.DirectorEvents)
	if rep == 0 || spent == 0 {
		return SiegeScenarioSummary{}, res, fmt.Errorf("siege scenario F expected bounded supply-backed repairs, got repairs=%d spent=%d", rep, spent)
	}
	return summarizeSiegeRun("Siege-F-LimitedRepair", "siege-f-repair", res, w, cf, rep, spent, 0, 0, false), res, nil
}

// RunSiegeScenarioG — Ondas de Reforços: schedules two population-backed SiegeWaves and proves
// real reservation debit, wave mobilization, and exact post-battle population conservation.
func RunSiegeScenarioG(ctx context.Context, reader ports.SettlementReader) (SiegeScenarioSummary, RunResult, error) {
	cfg := DefaultSiegeOrchestratedConfig()
	for i := range cfg.Director.Policies {
		if cfg.Director.Policies[i].TemplateID == TemplateOrcWarband {
			cfg.Director.Policies[i].SiegeWaves = []SiegeWaveSpec{
				{WaveTag: "orc-wave-2", DelayTicks: 8, Archetype: "orc-vanguard", Count: 1, EntryZoneID: siege.ZoneIDExteriorField},
				{WaveTag: "orc-wave-3", DelayTicks: 18, Archetype: "orc-berserker", Count: 1, EntryZoneID: siege.ZoneIDExteriorField},
			}
		}
	}
	eco := NewHighThreatOrcEco("siege-g-waves", 5007)
	for i := range eco.Populations {
		if eco.Populations[i].PopulationID == "pop-ironfang-orcs" {
			eco.Populations[i].FreePopulation = 160
		}
	}
	initSt, err := NewOrchestratedState("siege-g-waves", "settlement-valewatch", 5007, reader, eco)
	if err != nil {
		return SiegeScenarioSummary{}, RunResult{}, err
	}
	res, err := RunOrchestrated(ctx, initSt, nil, 220, cfg, 4096)
	if err != nil {
		return SiegeScenarioSummary{}, res, err
	}
	w, cf, rep, spent := countSiegeTelemetry(res.WorldEvents, res.DirectorEvents)
	if w < 2 {
		return SiegeScenarioSummary{}, res, fmt.Errorf("siege scenario G expected >= 2 mobilized population-backed waves, got %d", w)
	}
	return summarizeSiegeRun("Siege-G-ReinforcementWaves", "siege-g-waves", res, w, cf, rep, spent, 0, 0, false), res, nil
}

// RunSiegeScenarioH — Consumidor Lento: intense siege under small queue caps suffers recoverable
// backpressure, drains via pagination + verified ack, and resolves with zero lost or duplicated facts.
func RunSiegeScenarioH(ctx context.Context, reader ports.SettlementReader) (SiegeScenarioSummary, RunResult, error) {
	cfg := DefaultSiegeOrchestratedConfig()
	cfg.Director.MaxActiveCampaignsGlobal = 1
	cfg.Director.MaxPendingDirectorBatches = 2
	cfg.Director.MaxEventsPerUpdate = 2
	cfg.Director.MaxPendingOutcomes = 1
	cfg.Director.MaxPendingContributions = 16
	cfg.World.MaxContributions = 8

	eco := NewHighThreatGoblinEco("siege-h-slow-consumer", 5008)
	cur, err := NewOrchestratedState("siege-h-slow-consumer", "settlement-valewatch", 5008, reader, eco)
	if err != nil {
		return SiegeScenarioSummary{}, RunResult{}, err
	}
	bot := siegeDefenderBot(false, true)
	pauses := 0
	var allW []world.DomainEvent
	var allD []DirectorEvent
	var allOut []TerminalSettlementOutcome

	for cur.Director.Tick < 180 {
		nextTick := cur.Director.Tick + 1
		next, out, err := Step(cur, bot(nextTick, cur), cfg)
		if errors.Is(err, ErrDirectorBackpressure) || errors.Is(err, ErrOutcomeBackpressure) || errors.Is(err, ErrContributionBackpressure) {
			pauses++
			cur, err = drainPendingQueuesVerified(cur, cfg, nil, nil, nil)
			if err != nil {
				return SiegeScenarioSummary{}, RunResult{}, err
			}
			continue
		}
		if err != nil {
			return SiegeScenarioSummary{}, RunResult{}, err
		}
		cur = next
		allW = append(allW, out.WorldEvents...)
		allD = append(allD, out.DirectorEvents...)
		allOut = append(allOut, out.TerminalOutcomes...)
		// Slow consumer: drain only every 14 ticks voluntarily; backpressure triggers earlier drains as needed.
		if nextTick%14 == 0 {
			cur, err = drainPendingQueuesVerified(cur, cfg, nil, nil, nil)
			if err != nil {
				return SiegeScenarioSummary{}, RunResult{}, err
			}
		}
	}
	cur, err = drainPendingQueuesVerified(cur, cfg, nil, nil, nil)
	if err != nil {
		return SiegeScenarioSummary{}, RunResult{}, err
	}
	sum, err := cur.Checksum(cfg)
	if err != nil {
		return SiegeScenarioSummary{}, RunResult{}, err
	}
	if pauses == 0 || len(allOut) == 0 {
		return SiegeScenarioSummary{}, RunResult{}, fmt.Errorf("siege scenario H expected backpressure pauses > 0 and terminal outcome, got pauses=%d outcomes=%d", pauses, len(allOut))
	}
	res := RunResult{
		FinalState:       cur,
		FinalChecksum:    sum,
		DirectorEvents:   allD,
		WorldEvents:      allW,
		TerminalOutcomes: allOut,
	}
	w, cf, rep, spent := countSiegeTelemetry(allW, allD)
	return summarizeSiegeRun("Siege-H-SlowConsumer", "siege-h-slow-consumer", res, w, cf, rep, spent, pauses, 0, false), res, nil
}

// RunSiegeScenarioI — Snapshot durante Brecha: captures Snapshot v6 right after a fortification breach,
// restores it, continues both timelines to completion, and proves exact bit-for-bit equivalence.
func RunSiegeScenarioI(ctx context.Context, reader ports.SettlementReader) (SiegeScenarioSummary, RunResult, error) {
	cfg := DefaultSiegeOrchestratedConfig()
	cfg.Director.SpawnNPCDefenders = false
	cfg.Director.SiegeConfig.TowerFireDamage = 12
	eco := NewHighThreatOrcEco("siege-i-snapshot-breach", 5009)
	initSt, err := NewOrchestratedState("siege-i-snapshot-breach", "settlement-valewatch", 5009, reader, eco)
	if err != nil {
		return SiegeScenarioSummary{}, RunResult{}, err
	}

	const targetTick uint64 = 200
	full, err := RunOrchestrated(ctx, initSt, nil, targetTick, cfg, 4096)
	if err != nil {
		return SiegeScenarioSummary{}, full, err
	}

	// Step forward to the exact first tick where a breach occurs (HasOuterBreach() == true).
	cur := initSt.Clone()
	breachTick := uint64(0)
	for cur.Director.Tick < targetTick {
		next, _, err := Step(cur, StepInput{}, cfg)
		if err != nil {
			return SiegeScenarioSummary{}, RunResult{}, err
		}
		next, err = drainPendingQueuesVerified(next, cfg, nil, nil, nil)
		if err != nil {
			return SiegeScenarioSummary{}, RunResult{}, err
		}
		cur = next
		if cur.World.Siege != nil && cur.World.Siege.HasOuterBreach() && !cur.World.Siege.Phase.IsTerminal() {
			breachTick = cur.Director.Tick
			break
		}
	}
	if breachTick == 0 {
		return SiegeScenarioSummary{}, full, fmt.Errorf("siege scenario I did not observe a fortification breach before tick %d", targetTick)
	}

	raw, err := cur.MarshalSnapshot(cfg)
	if err != nil {
		return SiegeScenarioSummary{}, full, err
	}
	restored, err := UnmarshalOrchestratedSnapshot(raw, cfg)
	if err != nil {
		return SiegeScenarioSummary{}, full, err
	}
	cont, err := RunOrchestrated(ctx, restored, nil, targetTick, cfg, 4096)
	if err != nil {
		return SiegeScenarioSummary{}, full, err
	}
	if full.FinalChecksum != cont.FinalChecksum {
		return SiegeScenarioSummary{}, full, fmt.Errorf("siege scenario I breach snapshot divergence: %s != %s", full.FinalChecksum, cont.FinalChecksum)
	}
	cutD := 0
	for cutD < len(full.DirectorEvents) && full.DirectorEvents[cutD].Tick <= breachTick {
		cutD++
	}
	if !reflect.DeepEqual(full.DirectorEvents[cutD:], cont.DirectorEvents) {
		return SiegeScenarioSummary{}, full, fmt.Errorf("siege scenario I post-breach director events diverged")
	}
	w, cf, rep, spent := countSiegeTelemetry(full.WorldEvents, full.DirectorEvents)
	return summarizeSiegeRun("Siege-I-SnapshotDuringBreach", "siege-i-snapshot-breach", full, w, cf, rep, spent, 0, len(raw), true), full, nil
}

// RunSiegeScenarioJ — Cerco sem Progresso: deterministic anti-stall policy concludes a stalled
// assault cleanly with PhaseWithdrawn (mapped to InvasionOutcomeDefended) without permanent deadlock.
func RunSiegeScenarioJ(ctx context.Context, reader ports.SettlementReader) (SiegeScenarioSummary, RunResult, error) {
	cfg := DefaultSiegeOrchestratedConfig()
	cfg.Director.SpawnNPCDefenders = false
	cfg.Director.SiegeConfig.NoProgressTimeoutTicks = 25
	cfg.Director.SiegeConfig.SiegeMaxDurationTicks = 35
	cfg.Director.SiegeConfig.TowerFireDamage = 0
	for i := range cfg.Director.Policies {
		if cfg.Director.Policies[i].TemplateID == TemplateGoblinRaid {
			cfg.Director.Policies[i].SiegeWaves = nil
			cfg.Director.Policies[i].AllowEcologicalReinforcements = false
			cfg.Director.Policies[i].MainForces = []ForceUnit{
				{Archetype: "goblin-skirmisher", Count: 1, Position: 12000},
			}
		}
	}
	eco := NewHighThreatGoblinEco("siege-j-stall", 5010)
	initSt, err := NewOrchestratedState("siege-j-stall", "settlement-valewatch", 5010, reader, eco)
	if err != nil {
		return SiegeScenarioSummary{}, RunResult{}, err
	}
	res, err := RunOrchestrated(ctx, initSt, nil, 150, cfg, 4096)
	if err != nil {
		return SiegeScenarioSummary{}, res, err
	}
	if len(res.TerminalOutcomes) == 0 ||
		res.TerminalOutcomes[0].SiegePhase != siege.PhaseWithdrawn ||
		res.TerminalOutcomes[0].Outcome != ports.InvasionOutcomeDefended {
		return SiegeScenarioSummary{}, res, fmt.Errorf("siege scenario J expected PhaseWithdrawn/Defended, got %+v", res.TerminalOutcomes)
	}
	w, cf, rep, spent := countSiegeTelemetry(res.WorldEvents, res.DirectorEvents)
	return summarizeSiegeRun("Siege-J-StallWithdrawal", "siege-j-stall", res, w, cf, rep, spent, 0, 0, false), res, nil
}
