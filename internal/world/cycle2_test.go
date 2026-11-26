package world_test

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"

	"ascendra-game/internal/adapters/memory"
	"ascendra-game/internal/ai"
	"ascendra-game/internal/world"
)

// Cycle 02: Explicit canonical command ordering guarantees that network/caller arrival order
// within the same tick produces identical canonical state and checksum.
func TestCanonicalCommandOrderIndependence(t *testing.T) {
	cfg := world.DefaultConfig()
	const seed uint64 = 90909

	scriptA := map[uint64][]world.Command{
		2: {
			{Kind: world.CmdDeployDefender, Tick: 2, PlayerID: "p-alpha", Position: 2000},
			{Kind: world.CmdDeployDefender, Tick: 2, PlayerID: "p-beta", Position: 3000},
			{Kind: world.CmdSpawnHostileGroup, Tick: 2, GroupID: "g-orc-1", Archetype: "orc-vanguard", Count: 1},
			{Kind: world.CmdIncreaseThreat, Tick: 2, Delta: 1000},
		},
		10: {
			{Kind: world.CmdPlayerDefendStrike, Tick: 10, PlayerID: "p-alpha", TargetGroupID: "g-orc-1"},
			{Kind: world.CmdPlayerSupportDefense, Tick: 10, PlayerID: "p-beta"},
			{Kind: world.CmdCompleteObjective, Tick: 10, PlayerID: "p-alpha", ObjectiveID: "obj-wall"},
		},
	}

	// Reverse every tick's command slice order.
	scriptB := map[uint64][]world.Command{
		2: {
			{Kind: world.CmdIncreaseThreat, Tick: 2, Delta: 1000},
			{Kind: world.CmdSpawnHostileGroup, Tick: 2, GroupID: "g-orc-1", Archetype: "orc-vanguard", Count: 1},
			{Kind: world.CmdDeployDefender, Tick: 2, PlayerID: "p-beta", Position: 3000},
			{Kind: world.CmdDeployDefender, Tick: 2, PlayerID: "p-alpha", Position: 2000},
		},
		10: {
			{Kind: world.CmdCompleteObjective, Tick: 10, PlayerID: "p-alpha", ObjectiveID: "obj-wall"},
			{Kind: world.CmdPlayerSupportDefense, Tick: 10, PlayerID: "p-beta"},
			{Kind: world.CmdPlayerDefendStrike, Tick: 10, PlayerID: "p-alpha", TargetGroupID: "g-orc-1"},
		},
	}

	resA, err := world.RunScenario(context.Background(), mustInitialState(t, "sim-order", seed), scriptA, 60, cfg, nil)
	if err != nil {
		t.Fatalf("run A failed: %v", err)
	}
	resB, err := world.RunScenario(context.Background(), mustInitialState(t, "sim-order", seed), scriptB, 60, cfg, nil)
	if err != nil {
		t.Fatalf("run B failed: %v", err)
	}
	if resA.FinalChecksum != resB.FinalChecksum {
		t.Fatalf("command order affected checksum: %s != %s", resA.FinalChecksum, resB.FinalChecksum)
	}
}

// Cycle 02: Warband coordination, commander morale aura, target selection, bounded reinforcements,
// determinism, and mid-battle snapshot/restore verification.
func TestCycle02WarbandCoordinationReinforcementsAndSnapshot(t *testing.T) {
	cfg := world.DefaultConfig()
	script := world.BuildWarbandCoordinationScenarioScript()
	const seed uint64 = 20260202
	const tickK uint64 = 32
	const totalTicks uint64 = 180

	initial := mustInitialState(t, "sim-warband", seed)
	sinkA := memory.NewContributionSink()
	resA, err := world.RunScenario(context.Background(), initial, script, totalTicks, cfg, sinkA)
	if err != nil {
		t.Fatalf("warband scenario failed: %v", err)
	}

	// Verify reinforcements were called and bounded by MaxReinforcementWaves.
	reinfEvents := 0
	targetEvents := 0
	for _, ev := range resA.Events {
		if ev.Type == world.EventReinforcementsCalled {
			reinfEvents++
		}
		if ev.Type == world.EventTargetAcquired {
			targetEvents++
		}
	}
	if reinfEvents == 0 {
		t.Fatalf("expected at least 1 EventReinforcementsCalled during warband battle")
	}
	if resA.FinalState.Invasion.ReinforcementWaves > cfg.MaxReinforcementWaves {
		t.Fatalf("reinforcement waves %d exceeded cap %d", resA.FinalState.Invasion.ReinforcementWaves, cfg.MaxReinforcementWaves)
	}
	if targetEvents == 0 {
		t.Fatalf("expected EventTargetAcquired emissions during target selection")
	}

	// Verify snapshot/restore at tick K mid-coordination produces identical final checksum.
	atK, err := world.RunScenario(context.Background(), initial, script, tickK, cfg, nil)
	if err != nil {
		t.Fatalf("run to tick K failed: %v", err)
	}
	snapRaw, err := atK.FinalState.MarshalSnapshot()
	if err != nil {
		t.Fatalf("MarshalSnapshot failed: %v", err)
	}
	restored, err := world.UnmarshalSnapshot(snapRaw)
	if err != nil {
		t.Fatalf("UnmarshalSnapshot failed: %v", err)
	}
	sinkB := memory.NewContributionSink()
	resB, err := world.RunScenario(context.Background(), restored, script, totalTicks, cfg, sinkB)
	if err != nil {
		t.Fatalf("restored continuation failed: %v", err)
	}
	if resA.FinalChecksum != resB.FinalChecksum {
		t.Fatalf("Cycle 02 snapshot/restore mismatch: %s != %s", resA.FinalChecksum, resB.FinalChecksum)
	}
	var subsequent []world.DomainEvent
	for _, event := range resA.Events {
		if event.Tick > tickK {
			subsequent = append(subsequent, event)
		}
	}
	if !reflect.DeepEqual(subsequent, resB.Events) {
		t.Fatal("snapshot continuation produced different events")
	}
}

// Cycle 02: Territorial engagement and leash return in World Director without an active invasion.
func TestCycle02TerritorialIntrusionAndLeashReturn(t *testing.T) {
	cfg := world.DefaultConfig()
	initial := mustInitialState(t, "sim-territory", 31337)
	script := world.BuildTerritorialLeashScenarioScript()

	res, err := world.RunScenario(context.Background(), initial, script, 65, cfg, nil)
	if err != nil {
		t.Fatalf("territorial scenario failed: %v", err)
	}

	sawTerritoryAlert := false
	sawTargetAcquired := false
	for _, ev := range res.Events {
		if ev.Type == world.EventTerritoryAlert {
			sawTerritoryAlert = true
		}
		if ev.Type == world.EventTargetAcquired {
			sawTargetAcquired = true
		}
	}
	if !sawTerritoryAlert || !sawTargetAcquired {
		t.Fatalf("expected territory alert and target acquired events (alert=%v target=%v)", sawTerritoryAlert, sawTargetAcquired)
	}
	if len(res.FinalState.Groups) != 1 {
		t.Fatalf("expected 1 territorial group, got %d", len(res.FinalState.Groups))
	}
	// After intruder pulls outside LeashRadius, group must return inside its TerritoryRadius around 14000.
	g := res.FinalState.Groups[0]
	distFromHome := g.DistanceToSettlement - g.HomePosition
	if distFromHome < 0 {
		distFromHome = -distFromHome
	}
	if distFromHome > 4000 {
		t.Fatalf("expected group to return inside territory radius (4000), final pos=%d home=%d state=%s", g.DistanceToSettlement, g.HomePosition, g.State)
	}
	if g.State != ai.StatePatrol && g.State != ai.StateIdle && g.State != ai.StateReturnHome {
		t.Fatalf("expected peaceful territorial state after leash return, got %s", g.State)
	}
}

// Cycle 02: Bounded capacity enforcement prevents unbounded state growth (Codex P2 finding).
func TestCapacityBoundsRejectedExplicitly(t *testing.T) {
	cfg := world.DefaultConfig()
	cfg.MaxActiveGroups = 2
	cfg.MaxDefenders = 1
	cfg.MaxObjectives = 1

	st := mustInitialState(t, "sim-cap", 10)
	st, _, err := world.Step(st, []world.Command{
		{Kind: world.CmdDeployDefender, Tick: 1, PlayerID: "def-1", Position: 2000},
		{Kind: world.CmdSpawnHostileGroup, Tick: 1, GroupID: "g-1", Archetype: "goblin-skirmisher", Count: 1},
		{Kind: world.CmdSpawnHostileGroup, Tick: 1, GroupID: "g-2", Archetype: "orc-vanguard", Count: 1},
	}, cfg)
	if err != nil {
		t.Fatalf("setup within capacity failed: %v", err)
	}

	// Exceeding MaxActiveGroups returns ErrCapacityExceeded.
	if _, _, err := world.Step(st, []world.Command{
		{Kind: world.CmdSpawnHostileGroup, Tick: 2, GroupID: "g-3", Archetype: "goblin-skirmisher", Count: 1},
	}, cfg); !errors.Is(err, world.ErrCapacityExceeded) {
		t.Fatalf("expected ErrCapacityExceeded for groups, got %v", err)
	}

	// Exceeding MaxDefenders returns ErrCapacityExceeded.
	if _, _, err := world.Step(st, []world.Command{
		{Kind: world.CmdDeployDefender, Tick: 2, PlayerID: "def-2", Position: 2500},
	}, cfg); !errors.Is(err, world.ErrCapacityExceeded) {
		t.Fatalf("expected ErrCapacityExceeded for defenders, got %v", err)
	}

	// Exceeding MaxObjectives returns ErrCapacityExceeded.
	stActive, _, err := world.Step(st, []world.Command{
		{Kind: world.CmdIncreaseThreat, Tick: 2, Delta: 1000},
	}, cfg)
	if err != nil {
		t.Fatalf("activate invasion failed: %v", err)
	}
	stObj, _, err := world.Step(stActive, []world.Command{
		{Kind: world.CmdCompleteObjective, Tick: 3, PlayerID: "def-1", ObjectiveID: "obj-1"},
	}, cfg)
	if err != nil {
		t.Fatalf("first objective failed: %v", err)
	}
	if _, _, err := world.Step(stObj, []world.Command{
		{Kind: world.CmdCompleteObjective, Tick: 4, PlayerID: "def-1", ObjectiveID: "obj-2"},
	}, cfg); !errors.Is(err, world.ErrCapacityExceeded) {
		t.Fatalf("expected ErrCapacityExceeded for objectives, got %v", err)
	}
}

// Scaling benchmark under multi-group Creature AI load (16 active goblin/orc groups + 4 defenders).
func BenchmarkWorldStepMultiGroup16(b *testing.B) {
	cfg := world.DefaultConfig()
	cfg.MaxReinforcementWaves = 0 // Keep steady 16-group population for clean per-tick scaling baseline.
	reader, _ := memory.NewSettlementReader(memory.DefaultSettlementFixtures()...)
	st, _ := world.NewWorldState("sim-scale16", "settlement-valewatch", 77, reader)

	cmds := make([]world.Command, 0, 21)
	archetypes := []string{"goblin-skirmisher", "goblin-raider-pack", "goblin-taskmaster", "orc-vanguard", "orc-warchief"}
	for i := 0; i < 16; i++ {
		cmds = append(cmds, world.Command{
			Kind:         world.CmdSpawnHostileGroup,
			Tick:         1,
			GroupID:      fmt.Sprintf("g-%02d", i),
			Archetype:    archetypes[i%len(archetypes)],
			Count:        1,
			HomePosition: int64(8000 + (i%5)*1000),
			Position:     int64(5000 + (i%6)*800),
		})
	}
	for i := 0; i < 4; i++ {
		cmds = append(cmds, world.Command{
			Kind:     world.CmdDeployDefender,
			Tick:     1,
			PlayerID: fmt.Sprintf("def-%d", i),
			Position: int64(1500 + i*600),
		})
	}
	cmds = append(cmds, world.Command{Kind: world.CmdIncreaseThreat, Tick: 1, Delta: 1000})

	var err error
	st, _, err = world.Step(st, cmds, cfg)
	if err != nil {
		b.Fatalf("setup 16-group state failed: %v", err)
	}

	b.ReportAllocs()
	b.ResetTimer()
	cur := st
	for i := 0; i < b.N; i++ {
		cur, _, err = world.Step(cur, nil, cfg)
		if err != nil {
			b.Fatalf("Step failed: %v", err)
		}
		if cur.Invasion.State == world.InvasionResolved {
			cur = st
		}
	}
}

func TestDefeatedDefenderCannotCompleteObjective(t *testing.T) {
	cfg := world.DefaultConfig()
	st := mustInitialState(t, "dead-objective", 1)
	st.Invasion.State = world.InvasionUnderAttack
	st.Defenders = []world.DefenderEntity{{PlayerID: "p", MaxHP: 100, HP: 0}}
	before, _ := st.Checksum()
	_, _, err := world.Step(st, []world.Command{{Kind: world.CmdCompleteObjective, Tick: 1, PlayerID: "p", ObjectiveID: "gate"}}, cfg)
	if !errors.Is(err, world.ErrDeadEntity) {
		t.Fatalf("expected dead defender rejection, got %v", err)
	}
	after, _ := st.Checksum()
	if before != after {
		t.Fatal("failed tick mutated state")
	}
}

func TestStepRejectsRestoredStateOverCapacity(t *testing.T) {
	cfg := world.DefaultConfig()
	cfg.MaxDefenders = 1
	st := mustInitialState(t, "capacity-restore", 1)
	st.Defenders = []world.DefenderEntity{{PlayerID: "a", HP: 1, MaxHP: 1}, {PlayerID: "b", HP: 1, MaxHP: 1}}
	raw, err := st.MarshalSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	restored, err := world.UnmarshalSnapshot(raw)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = world.Step(restored, nil, cfg)
	if !errors.Is(err, world.ErrCapacityExceeded) {
		t.Fatalf("expected capacity error, got %v", err)
	}
}

func TestLostTargetIsCleared(t *testing.T) {
	cfg := world.DefaultConfig()
	st := mustInitialState(t, "lost-target", 1)
	st, _, err := world.Step(st, []world.Command{{Kind: world.CmdSpawnHostileGroup, Tick: 1, GroupID: "g", Archetype: "goblin-skirmisher", Count: 1}}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	st.Groups[0].CurrentTargetID = "gone"
	st, _, err = world.Step(st, nil, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if st.Groups[0].CurrentTargetID != "" {
		t.Fatalf("stale target %q", st.Groups[0].CurrentTargetID)
	}
}

func TestRoutedGroupDoesNotSpawnReinforcements(t *testing.T) {
	cfg := world.DefaultConfig()
	st := mustInitialState(t, "routed-reinforcement", 1)
	st, _, err := world.Step(st, []world.Command{{Kind: world.CmdSpawnHostileGroup, Tick: 1, GroupID: "g", Archetype: "goblin-raider-pack", Count: 1}}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	st.Invasion.State = world.InvasionUnderAttack
	st.Invasion.StartedTick = st.Tick
	st.Groups[0].State = ai.StateRetreat
	st.Groups[0].HP = st.Groups[0].MaxHP / 2
	st.Groups[0].DistanceToSettlement = cfg.HostileRetreatExitDistance - 1
	st.Groups[0].MoraleBP = 6000
	next, _, err := world.Step(st, nil, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if !next.Groups[0].Routed {
		t.Fatal("group did not route")
	}
	if next.Invasion.ReinforcementWaves != 0 {
		t.Fatal("routed group spawned reinforcements")
	}
}
