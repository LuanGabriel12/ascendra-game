package world

import (
	"context"

	"ascendra-game/internal/ports"
)

// RunResult summarizes a completed headless simulation run.
type RunResult struct {
	FinalState              WorldState
	FinalChecksum           string
	Events                  []DomainEvent
	ContributionsDispatched int
}

// RunScenario executes a deterministic headless world simulation from initial.Tick+1
// through targetTick (inclusive). It never uses wall-clock time for gameplay rules.
func RunScenario(
	ctx context.Context,
	initial WorldState,
	script map[uint64][]Command,
	targetTick uint64,
	cfg Config,
	sink ports.ContributionSink,
) (RunResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}

	cur := initial.Clone()
	allEvents := make([]DomainEvent, 0, 32)
	dispatched := 0

	for cur.Tick < targetTick {
		select {
		case <-ctx.Done():
			return RunResult{}, ctx.Err()
		default:
		}

		nextTick := cur.Tick + 1
		var cmds []Command
		if script != nil {
			cmds = script[nextTick]
		}

		next, evs, err := Step(cur, cmds, cfg)
		if err != nil {
			return RunResult{}, err
		}
		if len(evs) > 0 {
			allEvents = append(allEvents, evs...)
			n, err := DispatchContributions(evs, sink)
			if err != nil {
				return RunResult{}, err
			}
			dispatched += n
		}
		cur = next
	}

	sum, err := cur.Checksum()
	if err != nil {
		return RunResult{}, err
	}
	return RunResult{
		FinalState:              cur,
		FinalChecksum:           sum,
		Events:                  allEvents,
		ContributionsDispatched: dispatched,
	}, nil
}

// BuildDefendedScenarioScript creates a deterministic command schedule where regional threat
// triggers an invasion with two hostile groups and two players defend the settlement,
// complete an objective, and defeat or rout all hostile forces.
func BuildDefendedScenarioScript() map[uint64][]Command {
	return map[uint64][]Command{
		5: {
			{Kind: CmdIncreaseThreat, Tick: 5, Delta: 550, Source: "region-ashvale-scouts"},
		},
		12: {
			{Kind: CmdIncreaseThreat, Tick: 12, Delta: 500, Source: "region-ashvale-raiders"},
		},
		15: {
			{Kind: CmdSpawnHostileGroup, Tick: 15, GroupID: "group-raiders-2", Archetype: "goblin-skirmishers", Count: 1},
		},
		20: {
			{Kind: CmdPlayerDefendStrike, Tick: 20, PlayerID: "player-kael", TargetGroupID: "group-vanguard-1"},
			{Kind: CmdPlayerSupportDefense, Tick: 20, PlayerID: "player-lyra"},
		},
		30: {
			{Kind: CmdPlayerDefendStrike, Tick: 30, PlayerID: "player-kael", TargetGroupID: "group-vanguard-1"},
			{Kind: CmdCompleteObjective, Tick: 30, PlayerID: "player-lyra", ObjectiveID: "obj-hold-north-gate"},
		},
		40: {
			{Kind: CmdPlayerDefendStrike, Tick: 40, PlayerID: "player-kael", TargetGroupID: "group-vanguard-1"},
			{Kind: CmdPlayerDefendStrike, Tick: 40, PlayerID: "player-lyra", TargetGroupID: "group-raiders-2"},
		},
		50: {
			{Kind: CmdPlayerDefendStrike, Tick: 50, PlayerID: "player-kael", TargetGroupID: "group-vanguard-1"},
			{Kind: CmdPlayerDefendStrike, Tick: 50, PlayerID: "player-lyra", TargetGroupID: "group-raiders-2"},
		},
		60: {
			{Kind: CmdPlayerDefendStrike, Tick: 60, PlayerID: "player-kael", TargetGroupID: "group-raiders-2"},
			{Kind: CmdPlayerSupportDefense, Tick: 60, PlayerID: "player-lyra"},
		},
		70: {
			{Kind: CmdPlayerDefendStrike, Tick: 70, PlayerID: "player-kael", TargetGroupID: "group-raiders-2"},
		},
	}
}

// BuildCapturedScenarioScript creates a deterministic command schedule where threat escalates
// into an undefended invasion with a heavy warband that breaches the settlement.
func BuildCapturedScenarioScript() map[uint64][]Command {
	return map[uint64][]Command{
		3: {
			{Kind: CmdIncreaseThreat, Tick: 3, Delta: 600, Source: "region-ashvale-scouts"},
		},
		8: {
			{Kind: CmdSpawnHostileGroup, Tick: 8, GroupID: "group-siege-ram-1", Archetype: "orc-vanguard", Count: 3},
			{Kind: CmdIncreaseThreat, Tick: 8, Delta: 500, Source: "region-ashvale-warband"},
		},
		12: {
			// A single minor support action records a non-eligible player contribution even on defeat.
			{Kind: CmdPlayerSupportDefense, Tick: 12, PlayerID: "player-scout"},
		},
	}
}
