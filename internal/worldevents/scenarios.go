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

// ConsumerScenarioSummary captures delivery, backpressure, pagination, and recovery metrics
// for the headless development consumer harness scenarios (NOT durable production persistence).
type ConsumerScenarioSummary struct {
	Name                   string
	SimulationID           string
	Mode                   string
	FinalTick              uint64
	FinalChecksum          string
	CampaignsCompleted     int
	DirectorBatchesAcked   int
	DirectorEventsConsumed int
	DirectorPagesRead      int
	OutcomesAcked          int
	ContributionsAcked     int
	BackpressurePauses     int
	RedeliveriesDeduped    int
	SnapshotBytes          int
	SnapshotVerified       bool
	FreePopulationTotal    int64
	ReservedPopTotal       int64
	MaterializedPopTotal   int64
}

// headlessInbox simulates an in-memory idempotent consumer inbox for development scenarios.
// It explicitly does NOT represent durable PostgreSQL persistence (CARBON's domain).
type headlessInbox struct {
	seenDirectorEvents map[string]struct{}
	seenOutcomes       map[string]struct{}
	seenContributions  map[string]struct{}
	batchesAcked       int
	eventsConsumed     int
	pagesRead          int
	outcomesAcked      int
	contribsAcked      int
	redeliveries       int
}

func newHeadlessInbox() *headlessInbox {
	return &headlessInbox{
		seenDirectorEvents: make(map[string]struct{}),
		seenOutcomes:       make(map[string]struct{}),
		seenContributions:  make(map[string]struct{}),
	}
}

func (in *headlessInbox) consumeOneBatch(st OrchestratedState, cfg OrchestratedConfig, ack bool) (OrchestratedState, bool, error) {
	stats, err := PendingQueueStats(st, cfg)
	if err != nil || stats.PendingDirectorBatches == 0 {
		return st, false, err
	}
	var seq uint64
	var batchEvents []DirectorEvent
	for offset := 0; ; {
		var page []DirectorEvent
		var more bool
		seq, page, more, err = PendingDirectorEventPage(st, offset, cfg)
		if err != nil {
			return OrchestratedState{}, false, err
		}
		in.pagesRead++
		batchEvents = append(batchEvents, page...)
		offset += len(page)
		if !more {
			break
		}
	}
	for _, ev := range batchEvents {
		if _, dup := in.seenDirectorEvents[ev.EventID]; dup {
			in.redeliveries++
			continue
		}
		in.seenDirectorEvents[ev.EventID] = struct{}{}
		in.eventsConsumed++
	}
	if !ack {
		return st, true, nil
	}
	next, err := AcknowledgeDirectorBatchVerified(st, seq, len(batchEvents), cfg)
	if err != nil {
		return OrchestratedState{}, false, err
	}
	in.batchesAcked++
	return next, true, nil
}

func (in *headlessInbox) consumeOutcomes(st OrchestratedState, cfg OrchestratedConfig, maxCount int, ack bool) (OrchestratedState, error) {
	pending, err := PendingTerminalOutcomes(st, cfg)
	if err != nil {
		return OrchestratedState{}, err
	}
	cur := st
	processed := 0
	for _, fact := range pending {
		if maxCount > 0 && processed >= maxCount {
			break
		}
		if _, dup := in.seenOutcomes[fact.EventID]; dup {
			in.redeliveries++
		} else {
			in.seenOutcomes[fact.EventID] = struct{}{}
		}
		if ack {
			cur, err = AcknowledgeTerminalOutcomeVerified(cur, fact.Sequence, fact.EventID, cfg)
			if err != nil {
				return OrchestratedState{}, err
			}
			in.outcomesAcked++
		}
		processed++
	}
	return cur, nil
}

func (in *headlessInbox) consumeContributions(st OrchestratedState, cfg OrchestratedConfig, maxCount int, ack bool) (OrchestratedState, error) {
	pending, err := PendingContributionResults(st, cfg)
	if err != nil {
		return OrchestratedState{}, err
	}
	cur := st
	processed := 0
	for _, item := range pending {
		if maxCount > 0 && processed >= maxCount {
			break
		}
		if _, dup := in.seenContributions[item.Result.EventID]; dup {
			in.redeliveries++
		} else {
			in.seenContributions[item.Result.EventID] = struct{}{}
		}
		if ack {
			cur, err = AcknowledgeContributionVerified(cur, item.Sequence, item.Result.EventID, cfg)
			if err != nil {
				return OrchestratedState{}, err
			}
			in.contribsAcked++
		}
		processed++
	}
	return cur, nil
}

func (in *headlessInbox) drainAll(st OrchestratedState, cfg OrchestratedConfig) (OrchestratedState, error) {
	cur := st
	for {
		next, did, err := in.consumeOneBatch(cur, cfg, true)
		if err != nil {
			return OrchestratedState{}, err
		}
		cur = next
		if !did {
			break
		}
	}
	var err error
	cur, err = in.consumeOutcomes(cur, cfg, 0, true)
	if err != nil {
		return OrchestratedState{}, err
	}
	return in.consumeContributions(cur, cfg, 0, true)
}

func buildConsumerSummary(name, mode string, st OrchestratedState, cfg OrchestratedConfig, in *headlessInbox, pauses, snapBytes int, snapVerified bool) (ConsumerScenarioSummary, error) {
	sum, err := st.Checksum(cfg)
	if err != nil {
		return ConsumerScenarioSummary{}, err
	}
	freeTot, resTot, matTot := ecosystem.TotalPopulationLedger(st.Ecosystem)
	return ConsumerScenarioSummary{
		Name:                   name,
		SimulationID:           st.Director.SimulationID,
		Mode:                   mode,
		FinalTick:              st.Director.Tick,
		FinalChecksum:          sum,
		CampaignsCompleted:     len(st.Director.CompletedHistory),
		DirectorBatchesAcked:   in.batchesAcked,
		DirectorEventsConsumed: in.eventsConsumed,
		DirectorPagesRead:      in.pagesRead,
		OutcomesAcked:          in.outcomesAcked,
		ContributionsAcked:     in.contribsAcked,
		BackpressurePauses:     pauses,
		RedeliveriesDeduped:    in.redeliveries,
		SnapshotBytes:          snapBytes,
		SnapshotVerified:       snapVerified,
		FreePopulationTotal:    freeTot,
		ReservedPopTotal:       resTot,
		MaterializedPopTotal:   matTot,
	}, nil
}

// RunScenarioJImmediateConsumer exercises an immediate headless consumer that pages,
// processes, and confirms every durable outbox on every tick.
func RunScenarioJImmediateConsumer(ctx context.Context, reader ports.SettlementReader) (ConsumerScenarioSummary, error) {
	cfg := DefaultOrchestratedConfig()
	cfg.Director.MaxEventsPerUpdate = 2 // force multi-page reads even under immediate consumption
	st, err := NewOrchestratedState("wev-scenario-j-consumer-immediate", "settlement-valewatch", 4010, reader, NewHighThreatGoblinEco("wev-scenario-j-consumer-immediate", 4010))
	if err != nil {
		return ConsumerScenarioSummary{}, err
	}
	inbox := newHeadlessInbox()
	for st.Director.Tick < 130 {
		if ctx != nil && ctx.Err() != nil {
			return ConsumerScenarioSummary{}, ctx.Err()
		}
		next, _, err := Step(st, activeDefenderBot(st.Director.Tick+1, st), cfg)
		if err != nil {
			return ConsumerScenarioSummary{}, err
		}
		st, err = inbox.drainAll(next, cfg)
		if err != nil {
			return ConsumerScenarioSummary{}, err
		}
	}
	return buildConsumerSummary("Scenario J — Immediate Consumer", "immediate", st, cfg, inbox, 0, 0, false)
}

// RunScenarioKSlowConsumer exercises a slow headless consumer under intentionally tight
// capacities that drains only 1 batch/fact every 15 ticks and recovers cleanly from backpressure.
func RunScenarioKSlowConsumer(ctx context.Context, reader ports.SettlementReader) (ConsumerScenarioSummary, error) {
	cfg := DefaultOrchestratedConfig()
	cfg.World.MaxContributions = 8
	cfg.Director.MaxPendingContributions = 16
	cfg.Director.MaxPendingDirectorBatches = 2
	cfg.Director.MaxEventsPerUpdate = 2
	cfg.Director.MaxPendingOutcomes = 1
	st, err := NewOrchestratedState("wev-scenario-k-consumer-slow", "settlement-valewatch", 4011, reader, NewDualHostileConflictEco("wev-scenario-k-consumer-slow", 4011))
	if err != nil {
		return ConsumerScenarioSummary{}, err
	}
	inbox := newHeadlessInbox()
	pauses := 0
	for stepCount := 0; stepCount < 600 && st.Director.Tick < 220; stepCount++ {
		if ctx != nil && ctx.Err() != nil {
			return ConsumerScenarioSummary{}, ctx.Err()
		}
		next, _, err := Step(st, activeDefenderBot(st.Director.Tick+1, st), cfg)
		if err != nil {
			if err == ErrDirectorBackpressure || err == ErrOutcomeBackpressure || err == ErrContributionBackpressure {
				pauses++
				st, _, err = inbox.consumeOneBatch(st, cfg, true)
				if err != nil {
					return ConsumerScenarioSummary{}, err
				}
				st, err = inbox.consumeOutcomes(st, cfg, 1, true)
				if err != nil {
					return ConsumerScenarioSummary{}, err
				}
				st, err = inbox.consumeContributions(st, cfg, 2, true)
				if err != nil {
					return ConsumerScenarioSummary{}, err
				}
				continue
			}
			return ConsumerScenarioSummary{}, err
		}
		st = next
		if stepCount%15 == 0 {
			st, _, err = inbox.consumeOneBatch(st, cfg, true)
			if err != nil {
				return ConsumerScenarioSummary{}, err
			}
			st, err = inbox.consumeOutcomes(st, cfg, 1, true)
			if err != nil {
				return ConsumerScenarioSummary{}, err
			}
			st, err = inbox.consumeContributions(st, cfg, 2, true)
			if err != nil {
				return ConsumerScenarioSummary{}, err
			}
		}
	}
	st, err = inbox.drainAll(st, cfg)
	if err != nil {
		return ConsumerScenarioSummary{}, err
	}
	return buildConsumerSummary("Scenario K — Slow Consumer", "slow", st, cfg, inbox, pauses, 0, false)
}

// RunScenarioLPartiallyUnavailableConsumer exercises an offline consumer period that pauses
// progression with backpressure, takes a Snapshot v5 while blocked, restores, recovers partially,
// and resumes cleanly to campaign completion.
func RunScenarioLPartiallyUnavailableConsumer(ctx context.Context, reader ports.SettlementReader) (ConsumerScenarioSummary, error) {
	cfg := DefaultOrchestratedConfig()
	cfg.Director.MaxPendingDirectorBatches = 2
	cfg.Director.MaxEventsPerUpdate = 1
	st, err := NewOrchestratedState("wev-scenario-l-consumer-partial-outage", "settlement-valewatch", 4012, reader, NewHighThreatGoblinEco("wev-scenario-l-consumer-partial-outage", 4012))
	if err != nil {
		return ConsumerScenarioSummary{}, err
	}
	inbox := newHeadlessInbox()
	pauses := 0
	snapBytes := 0
	snapVerified := false
	outageDone := false

	for stepCount := 0; stepCount < 400 && st.Director.Tick < 130; stepCount++ {
		if ctx != nil && ctx.Err() != nil {
			return ConsumerScenarioSummary{}, ctx.Err()
		}
		next, _, err := Step(st, activeDefenderBot(st.Director.Tick+1, st), cfg)
		if err != nil {
			if err == ErrDirectorBackpressure || err == ErrOutcomeBackpressure || err == ErrContributionBackpressure {
				pauses++
				if !snapVerified {
					raw, mErr := st.MarshalSnapshot(cfg)
					if mErr != nil {
						return ConsumerScenarioSummary{}, mErr
					}
					snapBytes = len(raw)
					st, mErr = UnmarshalOrchestratedSnapshot(raw, cfg)
					if mErr != nil {
						return ConsumerScenarioSummary{}, mErr
					}
					snapVerified = true
				}
				// Partial recovery first: drain only 1 batch so progression can resume incrementally.
				st, _, err = inbox.consumeOneBatch(st, cfg, true)
				if err != nil {
					return ConsumerScenarioSummary{}, err
				}
				st, err = inbox.consumeOutcomes(st, cfg, 1, true)
				if err != nil {
					return ConsumerScenarioSummary{}, err
				}
				st, err = inbox.consumeContributions(st, cfg, 4, true)
				if err != nil {
					return ConsumerScenarioSummary{}, err
				}
				outageDone = true
				continue
			}
			return ConsumerScenarioSummary{}, err
		}
		st = next
		// Simulate outage during ticks 1..25 (no consumer acks until backpressure triggers).
		if outageDone {
			st, err = inbox.drainAll(st, cfg)
			if err != nil {
				return ConsumerScenarioSummary{}, err
			}
		}
	}
	st, err = inbox.drainAll(st, cfg)
	if err != nil {
		return ConsumerScenarioSummary{}, err
	}
	return buildConsumerSummary("Scenario L — Partially Unavailable Consumer", "partial_outage", st, cfg, inbox, pauses, snapBytes, snapVerified)
}

// RunScenarioMRecoveredConsumer saturates a 1-batch / 1-event-per-page outbox, verifies
// queries work while Step is blocked, snapshots/restores, drains multi-page batches, and resumes.
func RunScenarioMRecoveredConsumer(ctx context.Context, reader ports.SettlementReader) (ConsumerScenarioSummary, error) {
	cfg := DefaultOrchestratedConfig()
	cfg.Director.MaxPendingDirectorBatches = 1
	cfg.Director.MaxEventsPerUpdate = 1
	st, err := NewOrchestratedState("wev-scenario-m-consumer-recovered", "settlement-valewatch", 4013, reader, NewHighThreatGoblinEco("wev-scenario-m-consumer-recovered", 4013))
	if err != nil {
		return ConsumerScenarioSummary{}, err
	}
	inbox := newHeadlessInbox()
	pauses := 0
	snapBytes := 0
	snapVerified := false

	for stepCount := 0; stepCount < 500 && st.Director.Tick < 130; stepCount++ {
		if ctx != nil && ctx.Err() != nil {
			return ConsumerScenarioSummary{}, ctx.Err()
		}
		next, _, err := Step(st, activeDefenderBot(st.Director.Tick+1, st), cfg)
		if err != nil {
			if err == ErrDirectorBackpressure || err == ErrOutcomeBackpressure || err == ErrContributionBackpressure {
				pauses++
				if !snapVerified {
					raw, mErr := st.MarshalSnapshot(cfg)
					if mErr != nil {
						return ConsumerScenarioSummary{}, mErr
					}
					snapBytes = len(raw)
					st, mErr = UnmarshalOrchestratedSnapshot(raw, cfg)
					if mErr != nil {
						return ConsumerScenarioSummary{}, mErr
					}
					snapVerified = true
				}
				st, err = inbox.drainAll(st, cfg)
				if err != nil {
					return ConsumerScenarioSummary{}, err
				}
				continue
			}
			return ConsumerScenarioSummary{}, err
		}
		st = next
	}
	st, err = inbox.drainAll(st, cfg)
	if err != nil {
		return ConsumerScenarioSummary{}, err
	}
	return buildConsumerSummary("Scenario M — Recovered Consumer (Saturation -> Restore -> Resume)", "recovered", st, cfg, inbox, pauses, snapBytes, snapVerified)
}

// RunScenarioNDuplicateDeliveryConsumer simulates consumer crashes between processing and
// acknowledgement, proving stable EventIDs, inbox deduplication, idempotent repeat acks,
// and zero duplicate side effects.
func RunScenarioNDuplicateDeliveryConsumer(ctx context.Context, reader ports.SettlementReader) (ConsumerScenarioSummary, error) {
	cfg := DefaultOrchestratedConfig()
	cfg.Director.MaxEventsPerUpdate = 2
	st, err := NewOrchestratedState("wev-scenario-n-consumer-redelivery", "settlement-valewatch", 4014, reader, NewHighThreatGoblinEco("wev-scenario-n-consumer-redelivery", 4014))
	if err != nil {
		return ConsumerScenarioSummary{}, err
	}
	inbox := newHeadlessInbox()
	snapBytes := 0
	snapVerified := false
	for st.Director.Tick < 130 {
		if ctx != nil && ctx.Err() != nil {
			return ConsumerScenarioSummary{}, ctx.Err()
		}
		next, _, err := Step(st, activeDefenderBot(st.Director.Tick+1, st), cfg)
		if err != nil {
			return ConsumerScenarioSummary{}, err
		}
		st = next
		stats, err := PendingQueueStats(st, cfg)
		if err != nil {
			return ConsumerScenarioSummary{}, err
		}
		// Simulate crash before ack: process WITHOUT acking, snapshot/restore, then re-consume and ack!
		if stats.PendingDirectorBatches > 0 {
			if _, _, err = inbox.consumeOneBatch(st, cfg, false); err != nil {
				return ConsumerScenarioSummary{}, err
			}
			if !snapVerified {
				raw, mErr := st.MarshalSnapshot(cfg)
				if mErr != nil {
					return ConsumerScenarioSummary{}, mErr
				}
				snapBytes = len(raw)
				st, mErr = UnmarshalOrchestratedSnapshot(raw, cfg)
				if mErr != nil {
					return ConsumerScenarioSummary{}, mErr
				}
				snapVerified = true
			}
			seqBefore := st.Director.PendingDirectorBatches[0].Sequence
			st, _, err = inbox.consumeOneBatch(st, cfg, true)
			if err != nil {
				return ConsumerScenarioSummary{}, err
			}
			// Repeat last acknowledgement idempotently (must be a no-op).
			st, err = AcknowledgeDirectorBatch(st, seqBefore, cfg)
			if err != nil {
				return ConsumerScenarioSummary{}, err
			}
		}
		if stats.PendingOutcomes > 0 {
			if _, err = inbox.consumeOutcomes(st, cfg, 0, false); err != nil {
				return ConsumerScenarioSummary{}, err
			}
			lastSeq := st.Director.PendingOutcomes[0].Sequence
			lastID := st.Director.PendingOutcomes[0].EventID
			st, err = inbox.consumeOutcomes(st, cfg, 0, true)
			if err != nil {
				return ConsumerScenarioSummary{}, err
			}
			st, err = AcknowledgeTerminalOutcomeVerified(st, lastSeq, lastID, cfg)
			if err != nil {
				return ConsumerScenarioSummary{}, err
			}
		}
		if stats.PendingContributions > 0 {
			if _, err = inbox.consumeContributions(st, cfg, 0, false); err != nil {
				return ConsumerScenarioSummary{}, err
			}
			st, err = inbox.consumeContributions(st, cfg, 0, true)
			if err != nil {
				return ConsumerScenarioSummary{}, err
			}
		}
	}
	return buildConsumerSummary("Scenario N — Duplicate Delivery & Idempotent Ack Consumer", "redelivery", st, cfg, inbox, 0, snapBytes, snapVerified)
}
