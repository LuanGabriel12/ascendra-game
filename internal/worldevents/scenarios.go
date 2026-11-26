package worldevents

import (
	"context"
	"fmt"
	"reflect"

	"ascendra-game/internal/ai"
	"ascendra-game/internal/ecosystem"
	"ascendra-game/internal/ports"
	"ascendra-game/internal/world"
)

// ScenarioSummary captures key observable metrics from each Cycle 04 deterministic scenario.
type ScenarioSummary struct {
	Name                     string
	SimulationID             string
	FinalTick                uint64
	FinalEpoch               uint64
	FinalChecksum            string
	CampaignsCompleted       int
	TerminalOutcomes         []TerminalSettlementOutcome
	ReinforcementsDeployed   int
	SnapshotBytes            int
	SnapshotVerified         bool
	FreePopulationTotal      int64
	ReservedPopulationTotal  int64
	MaterializedPopTotal     int64
	DirectorEventsCount      int
}

// NewHighThreatGoblinEco builds a deterministic ecosystem where Thornveil Goblins have strong
// free population, an operational camp, and high threat while Orcs remain below campaign threshold.
func NewHighThreatGoblinEco(simID string, seed uint64) ecosystem.EcosystemState {
	eco := ecosystem.NewDefaultEcosystemState(simID, seed)
	for i := range eco.Regions {
		if eco.Regions[i].RegionID == ecosystem.RegionThornveilForest {
			eco.Regions[i].ThreatScore = 950
			eco.Regions[i].ThreatLevel = ecosystem.ThreatHostile
		}
		if eco.Regions[i].RegionID == ecosystem.RegionIronfangFrontier {
			eco.Regions[i].ThreatScore = 200
			eco.Regions[i].ThreatLevel = ecosystem.ThreatStable
		}
	}
	for i := range eco.Populations {
		if eco.Populations[i].PopulationID == "pop-thornveil-goblins" {
			eco.Populations[i].FreePopulation = 110
		}
		if eco.Populations[i].PopulationID == "pop-ironfang-orcs" {
			eco.Populations[i].FreePopulation = 30
		}
	}
	return eco
}

// NewHighThreatOrcEco builds a deterministic ecosystem where Ironfang Orcs meet the higher
// Orc Warband campaign threshold while Goblins remain calm below threshold.
func NewHighThreatOrcEco(simID string, seed uint64) ecosystem.EcosystemState {
	eco := ecosystem.NewDefaultEcosystemState(simID, seed)
	for i := range eco.Regions {
		if eco.Regions[i].RegionID == ecosystem.RegionIronfangFrontier {
			eco.Regions[i].ThreatScore = 1450
			eco.Regions[i].ThreatLevel = ecosystem.ThreatCritical
		}
		if eco.Regions[i].RegionID == ecosystem.RegionThornveilForest {
			eco.Regions[i].ThreatScore = 150
			eco.Regions[i].ThreatLevel = ecosystem.ThreatStable
		}
	}
	for i := range eco.Populations {
		if eco.Populations[i].PopulationID == "pop-ironfang-orcs" {
			eco.Populations[i].FreePopulation = 120
		}
		if eco.Populations[i].PopulationID == "pop-thornveil-goblins" {
			eco.Populations[i].FreePopulation = 20
		}
	}
	return eco
}

// NewDualHostileConflictEco builds an ecosystem where BOTH Thornveil Goblins AND Ironfang Orcs
// qualify simultaneously so the deterministic scheduler must prioritize and enforce concurrency caps.
func NewDualHostileConflictEco(simID string, seed uint64) ecosystem.EcosystemState {
	eco := ecosystem.NewDefaultEcosystemState(simID, seed)
	for i := range eco.Regions {
		if eco.Regions[i].RegionID == ecosystem.RegionThornveilForest {
			eco.Regions[i].ThreatScore = 900
			eco.Regions[i].ThreatLevel = ecosystem.ThreatHostile
		}
		if eco.Regions[i].RegionID == ecosystem.RegionIronfangFrontier {
			eco.Regions[i].ThreatScore = 1450
			eco.Regions[i].ThreatLevel = ecosystem.ThreatCritical
		}
	}
	for i := range eco.Populations {
		if eco.Populations[i].PopulationID == "pop-thornveil-goblins" {
			eco.Populations[i].FreePopulation = 115
		}
		if eco.Populations[i].PopulationID == "pop-ironfang-orcs" {
			eco.Populations[i].FreePopulation = 125
		}
	}
	return eco
}

// activeDefenderBot generates deterministic player GameplayCommands for a coordinated 5-player
// defense party during an active invasion to defend the settlement against live hostile groups.
func activeDefenderBot(tick uint64, cur OrchestratedState) StepInput {
	if cur.World.Invasion.State != world.InvasionUnderAttack {
		return StepInput{}
	}
	var cmds []world.GameplayCommand
	// Deploy coordinated defenders on first active tick (re-deploying if any haven't joined yet).
	if len(cur.World.Defenders) == 0 {
		cmds = append(cmds,
			world.GameplayCommand{Kind: world.CmdDeployDefender, Tick: tick, PlayerID: "player-aria", Position: 3500},
			world.GameplayCommand{Kind: world.CmdDeployDefender, Tick: tick, PlayerID: "player-borin", Position: 2800},
			world.GameplayCommand{Kind: world.CmdDeployDefender, Tick: tick, PlayerID: "player-daren", Position: 2200},
			world.GameplayCommand{Kind: world.CmdDeployDefender, Tick: tick, PlayerID: "player-elira", Position: 1600},
		)
		return StepInput{GameplayCommands: cmds}
	}

	// Find first alive hostile target deterministically (focus fire on closest threat).
	targetID := ""
	bestDist := int64(1<<62 - 1)
	for _, g := range cur.World.Groups {
		if g.HP > 0 && g.State != ai.StateDead && !g.Routed {
			if g.DistanceToSettlement < bestDist || (g.DistanceToSettlement == bestDist && g.GroupID < targetID) {
				bestDist = g.DistanceToSettlement
				targetID = g.GroupID
			}
		}
	}

	strikers := []struct {
		id    string
		phase uint64
	}{
		{"player-aria", 0},
		{"player-borin", 2},
		{"player-daren", 4},
		{"player-elira", 6},
	}
	if targetID != "" {
		for _, s := range strikers {
			if tick%9 != s.phase {
				continue
			}
			// Only strike if defender is still alive.
			alive := true
			for _, d := range cur.World.Defenders {
				if d.PlayerID == s.id && d.HP == 0 {
					alive = false
					break
				}
			}
			if alive {
				cmds = append(cmds, world.GameplayCommand{
					Kind:          world.CmdPlayerDefendStrike,
					Tick:          tick,
					PlayerID:      s.id,
					TargetGroupID: targetID,
				})
			}
		}
	}
	if tick%9 == 3 && cur.World.SettlementDefenseHP < cur.World.SettlementMaxDefenseHP {
		cmds = append(cmds, world.GameplayCommand{
			Kind:     world.CmdPlayerSupportDefense,
			Tick:     tick,
			PlayerID: "player-clara",
		})
	}
	if len(cur.World.Invasion.ObjectivesCompleted) == 0 && tick%15 == 1 {
		cmds = append(cmds, world.GameplayCommand{
			Kind:        world.CmdCompleteObjective,
			Tick:        tick,
			PlayerID:    "player-clara",
			ObjectiveID: "obj-hold-north-gate",
		})
	}
	return StepInput{GameplayCommands: cmds}
}

// RunScenarioA executes Scenario A — Goblin Campaign (candidate -> recon -> prep -> warning -> active -> resolved).
func RunScenarioA(ctx context.Context, reader ports.SettlementReader) (ScenarioSummary, RunResult, error) {
	cfg := DefaultOrchestratedConfig()
	st, err := NewOrchestratedState("wev-scenario-a-goblin", "settlement-valewatch", 4001, reader, NewHighThreatGoblinEco("wev-scenario-a-goblin", 4001))
	if err != nil {
		return ScenarioSummary{}, RunResult{}, err
	}
	res, err := RunOrchestrated(ctx, st, activeDefenderBot, 130, cfg, 512)
	if err != nil {
		return ScenarioSummary{}, RunResult{}, err
	}
	return buildScenarioSummary("Scenario A — Goblin Campaign", res, 0, false), res, nil
}

// RunScenarioB executes Scenario B — Orc Warband Campaign (distinct orc forces, cadence, leadership priority).
func RunScenarioB(ctx context.Context, reader ports.SettlementReader) (ScenarioSummary, RunResult, error) {
	cfg := DefaultOrchestratedConfig()
	st, err := NewOrchestratedState("wev-scenario-b-orc", "settlement-valewatch", 4002, reader, NewHighThreatOrcEco("wev-scenario-b-orc", 4002))
	if err != nil {
		return ScenarioSummary{}, RunResult{}, err
	}
	res, err := RunOrchestrated(ctx, st, activeDefenderBot, 180, cfg, 512)
	if err != nil {
		return ScenarioSummary{}, RunResult{}, err
	}
	return buildScenarioSummary("Scenario B — Orc Campaign", res, 0, false), res, nil
}

// RunScenarioC executes Scenario C — Successful Settlement Defense with player contributions & recovery.
func RunScenarioC(ctx context.Context, reader ports.SettlementReader) (ScenarioSummary, RunResult, error) {
	cfg := DefaultOrchestratedConfig()
	st, err := NewOrchestratedState("wev-scenario-c-defended", "settlement-valewatch", 4003, reader, NewHighThreatGoblinEco("wev-scenario-c-defended", 4003))
	if err != nil {
		return ScenarioSummary{}, RunResult{}, err
	}
	res, err := RunOrchestrated(ctx, st, activeDefenderBot, 130, cfg, 512)
	if err != nil {
		return ScenarioSummary{}, RunResult{}, err
	}
	return buildScenarioSummary("Scenario C — Successful Defense", res, 0, false), res, nil
}

// RunScenarioD executes Scenario D — Settlement Captured under heavy uncontested orc assault + reconquest intent.
func RunScenarioD(ctx context.Context, reader ports.SettlementReader) (ScenarioSummary, RunResult, error) {
	cfg := DefaultOrchestratedConfig()
	st, err := NewOrchestratedState("wev-scenario-d-captured", "settlement-valewatch", 4004, reader, NewHighThreatOrcEco("wev-scenario-d-captured", 4004))
	if err != nil {
		return ScenarioSummary{}, RunResult{}, err
	}
	res, err := RunOrchestrated(ctx, st, nil, 260, cfg, 512)
	if err != nil {
		return ScenarioSummary{}, RunResult{}, err
	}
	return buildScenarioSummary("Scenario D — Settlement Captured", res, 0, false), res, nil
}

// RunScenarioE executes Scenario E — Cancelled Campaign when source camp is destroyed mid-preparation,
// cleanly releasing reserved population and recalling recon units with zero population leakage.
func RunScenarioE(ctx context.Context, reader ports.SettlementReader) (ScenarioSummary, RunResult, error) {
	cfg := DefaultOrchestratedConfig()
	st, err := NewOrchestratedState("wev-scenario-e-cancelled", "settlement-valewatch", 4005, reader, NewHighThreatGoblinEco("wev-scenario-e-cancelled", 4005))
	if err != nil {
		return ScenarioSummary{}, RunResult{}, err
	}
	// Destroy source camp on epoch 1 (tick 20) while campaign is in Preparing/Warning!
	script := func(tick uint64, cur OrchestratedState) StepInput {
		if tick == cfg.Ecosystem.TicksPerEpoch {
			return StepInput{
				EcosystemCommands: []ecosystem.Command{{
					Kind:   ecosystem.CmdDestroyCamp,
					Epoch:  cur.Ecosystem.Epoch + 1,
					CampID: "camp-thornveil-warren",
				}},
			}
		}
		return StepInput{}
	}
	res, err := RunOrchestrated(ctx, st, script, 60, cfg, 512)
	if err != nil {
		return ScenarioSummary{}, RunResult{}, err
	}
	return buildScenarioSummary("Scenario E — Cancelled Campaign (Camp Destroyed)", res, 0, false), res, nil
}

// RunScenarioF executes Scenario F — Scheduling Conflict where Goblins & Orcs both qualify simultaneously;
// deterministic priority selects Orc warband first while Goblins age cleanly without overlapping combat.
func RunScenarioF(ctx context.Context, reader ports.SettlementReader) (ScenarioSummary, RunResult, error) {
	cfg := DefaultOrchestratedConfig()
	st, err := NewOrchestratedState("wev-scenario-f-conflict", "settlement-valewatch", 4006, reader, NewDualHostileConflictEco("wev-scenario-f-conflict", 4006))
	if err != nil {
		return ScenarioSummary{}, RunResult{}, err
	}
	res, err := RunOrchestrated(ctx, st, activeDefenderBot, 450, cfg, 1024)
	if err != nil {
		return ScenarioSummary{}, RunResult{}, err
	}
	return buildScenarioSummary("Scenario F — Scheduling Conflict & Aging", res, 0, false), res, nil
}

// RunScenarioG executes Scenario G — Mid-Campaign Snapshot v4 Interrupt, Restore & Equivalence Verification.
func RunScenarioG(ctx context.Context, reader ports.SettlementReader) (ScenarioSummary, RunResult, error) {
	cfg := DefaultOrchestratedConfig()
	initSt, err := NewOrchestratedState("wev-scenario-g-snapshot", "settlement-valewatch", 4007, reader, NewHighThreatGoblinEco("wev-scenario-g-snapshot", 4007))
	if err != nil {
		return ScenarioSummary{}, RunResult{}, err
	}
	const snapTick = uint64(32)
	const endTick = uint64(220)

	fullRes, err := RunOrchestrated(ctx, initSt, activeDefenderBot, endTick, cfg, 2048)
	if err != nil {
		return ScenarioSummary{}, RunResult{}, err
	}
	midRes, err := RunOrchestrated(ctx, initSt, activeDefenderBot, snapTick, cfg, 2048)
	if err != nil {
		return ScenarioSummary{}, RunResult{}, err
	}
	raw, err := midRes.FinalState.MarshalSnapshot(cfg)
	if err != nil {
		return ScenarioSummary{}, RunResult{}, err
	}
	restored, err := UnmarshalOrchestratedSnapshot(raw, cfg)
	if err != nil {
		return ScenarioSummary{}, RunResult{}, err
	}
	contRes, err := RunOrchestrated(ctx, restored, activeDefenderBot, endTick, cfg, 2048)
	if err != nil {
		return ScenarioSummary{}, RunResult{}, err
	}
	if fullRes.FinalChecksum != contRes.FinalChecksum {
		return ScenarioSummary{}, RunResult{}, fmt.Errorf("scenario G snapshot divergence: %s != %s", fullRes.FinalChecksum, contRes.FinalChecksum)
	}
	cutDir := 0
	for cutDir < len(fullRes.DirectorEvents) && fullRes.DirectorEvents[cutDir].Tick <= snapTick {
		cutDir++
	}
	if !reflect.DeepEqual(fullRes.DirectorEvents[cutDir:], contRes.DirectorEvents) {
		return ScenarioSummary{}, RunResult{}, fmt.Errorf("scenario G post-snapshot director events diverged")
	}
	cutWorld := 0
	for cutWorld < len(fullRes.WorldEvents) && fullRes.WorldEvents[cutWorld].Tick <= snapTick {
		cutWorld++
	}
	if !reflect.DeepEqual(fullRes.WorldEvents[cutWorld:], contRes.WorldEvents) {
		return ScenarioSummary{}, RunResult{}, fmt.Errorf("scenario G post-snapshot world events diverged")
	}
	cutOut := 0
	for cutOut < len(fullRes.TerminalOutcomes) && fullRes.TerminalOutcomes[cutOut].CompletedTick <= snapTick {
		cutOut++
	}
	if !reflect.DeepEqual(fullRes.TerminalOutcomes[cutOut:], contRes.TerminalOutcomes) {
		return ScenarioSummary{}, RunResult{}, fmt.Errorf("scenario G post-snapshot terminal outcomes diverged")
	}
	return buildScenarioSummary("Scenario G — Mid-Campaign Snapshot & Restore", contRes, len(raw), true), contRes, nil
}

// RunScenarioH executes Scenario H — Ecological Reinforcements with exact reservation debit.
// Orc Warchief/Goblin Taskmaster takes non-lethal hits during active assault -> requests reinforcement
// -> Director validates camp & reservation -> materializes linked reinforcement group with population debit!
func RunScenarioH(ctx context.Context, reader ports.SettlementReader) (ScenarioSummary, RunResult, error) {
	cfg := DefaultOrchestratedConfig()
	st, err := NewOrchestratedState("wev-scenario-h-reinforcements", "settlement-valewatch", 4008, reader, NewHighThreatOrcEco("wev-scenario-h-reinforcements", 4008))
	if err != nil {
		return ScenarioSummary{}, RunResult{}, err
	}
	// Strike the Orc Warchief once it is active to trigger morale/damage threshold and reinforcement call!
	script := func(tick uint64, cur OrchestratedState) StepInput {
		if cur.World.Invasion.State != world.InvasionUnderAttack {
			return StepInput{}
		}
		if len(cur.World.Defenders) == 0 {
			return StepInput{
				GameplayCommands: []world.GameplayCommand{
					{Kind: world.CmdDeployDefender, Tick: tick, PlayerID: "player-vanguard", Position: 6000},
				},
			}
		}
		// Focus commander (orc-warchief) until wounded (< 75% HP) so it calls reinforcements cleanly.
		for _, g := range cur.World.Groups {
			if g.Role == ai.RoleCommander && g.HP > 0 && g.State != ai.StateDead && !g.Routed && tick%9 == 0 {
				return StepInput{
					GameplayCommands: []world.GameplayCommand{
						{Kind: world.CmdPlayerDefendStrike, Tick: tick, PlayerID: "player-vanguard", TargetGroupID: g.GroupID},
					},
				}
			}
		}
		return activeDefenderBot(tick, cur)
	}
	res, err := RunOrchestrated(ctx, st, script, 280, cfg, 1024)
	if err != nil {
		return ScenarioSummary{}, RunResult{}, err
	}
	return buildScenarioSummary("Scenario H — Ecological Reinforcements", res, 0, false), res, nil
}

// RunScenarioI executes Scenario I — Terminal Settlement Outcome with Zero Players.
// Proves the authoritative TerminalSettlementOutcome fact is emitted strictly once even when
// EligibleContributors == 0 (no defenders, no player commands).
func RunScenarioI(ctx context.Context, reader ports.SettlementReader) (ScenarioSummary, RunResult, error) {
	cfg := DefaultOrchestratedConfig()
	st, err := NewOrchestratedState("wev-scenario-i-zero-players", "settlement-valewatch", 4009, reader, NewHighThreatGoblinEco("wev-scenario-i-zero-players", 4009))
	if err != nil {
		return ScenarioSummary{}, RunResult{}, err
	}
	res, err := RunOrchestrated(ctx, st, nil, 300, cfg, 512)
	if err != nil {
		return ScenarioSummary{}, RunResult{}, err
	}
	return buildScenarioSummary("Scenario I — Terminal Outcome With Zero Players", res, 0, false), res, nil
}

func buildScenarioSummary(name string, res RunResult, snapBytes int, snapVerified bool) ScenarioSummary {
	freeTot, resTot, matTot := ecosystem.TotalPopulationLedger(res.FinalState.Ecosystem)
	reinfCount := 0
	for _, ev := range res.DirectorEvents {
		if ev.Type == DirEventReinforcementDeployed {
			reinfCount++
		}
	}
	return ScenarioSummary{
		Name:                    name,
		SimulationID:            res.FinalState.Director.SimulationID,
		FinalTick:               res.FinalState.Director.Tick,
		FinalEpoch:              res.FinalState.Ecosystem.Epoch,
		FinalChecksum:           res.FinalChecksum,
		CampaignsCompleted:      len(res.FinalState.Director.CompletedHistory),
		TerminalOutcomes:        res.TerminalOutcomes,
		ReinforcementsDeployed:  reinfCount,
		SnapshotBytes:           snapBytes,
		SnapshotVerified:        snapVerified,
		FreePopulationTotal:     freeTot,
		ReservedPopulationTotal: resTot,
		MaterializedPopTotal:    matTot,
		DirectorEventsCount:     len(res.DirectorEvents),
	}
}
