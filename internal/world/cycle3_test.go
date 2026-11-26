package world_test

import (
	"errors"
	"fmt"
	"testing"

	"ascendra-game/internal/ai"
	"ascendra-game/internal/ecosystem"
	"ascendra-game/internal/simulation"
	"ascendra-game/internal/world"
)

func TestCycle03IntegratedMaterializationReconciliationAndNoResurrection(t *testing.T) {
	wCfg := world.DefaultConfig()
	eCfg := ecosystem.DefaultConfig()

	wInit := mustInitialState(t, "sim-int-mat", 808)
	ecoInit := ecosystem.NewDefaultEcosystemState("sim-int-mat", 808)
	initFree, _ := ecosystem.TotalEcosystemPopulation(ecoInit)

	state := world.IntegratedState{World: wInit, Ecosystem: ecoInit}

	// Materialize 1 goblin raider pack (weight = 6) and 1 orc vanguard (weight = 4).
	var err error
	state, _, _, err = world.MaterializeGroup(state, "camp-thornveil-warren", "mat-g1", "goblin-raider-pack", 1, 8000, wCfg, eCfg)
	if err != nil {
		t.Fatalf("MaterializeGroup goblin failed: %v", err)
	}
	state, _, _, err = world.MaterializeGroup(state, "camp-ironfang-bastion", "mat-o1", "orc-vanguard", 1, 9000, wCfg, eCfg)
	if err != nil {
		t.Fatalf("MaterializeGroup orc failed: %v", err)
	}

	midFree, midMat := ecosystem.TotalEcosystemPopulation(state.Ecosystem)
	if midFree != initFree-10 || midMat != 10 {
		t.Fatalf("expected free=%d mat=10, got free=%d mat=%d", initFree-10, midFree, midMat)
	}

	// Start invasion and kill mat-g1 completely over strikes -> must reconcile 0 survivors strictly once!
	state, _, _, err = world.StepIntegrated(state, []world.Command{{Kind: world.CmdIncreaseThreat, Tick: 1, Delta: 1000}}, nil, wCfg, eCfg)
	if err != nil {
		t.Fatalf("StepIntegrated escalate failed: %v", err)
	}

	reconciledEvents := 0
	for tick := uint64(2); tick <= 60; tick++ {
		var cmds []world.Command
		// Strike mat-g1 every 10 ticks until defeated.
		if tick%10 == 0 {
			for _, g := range state.World.Groups {
				if g.GroupID == "mat-g1" && g.HP > 0 && !g.Routed {
					cmds = append(cmds, world.Command{Kind: world.CmdPlayerDefendStrike, Tick: tick, PlayerID: "p-hero", TargetGroupID: "mat-g1"})
				}
			}
		}
		var ecoEvs []ecosystem.EcologicalEvent
		state, _, ecoEvs, err = world.StepIntegrated(state, cmds, nil, wCfg, eCfg)
		if err != nil {
			t.Fatalf("StepIntegrated tick %d failed: %v", tick, err)
		}
		for _, ev := range ecoEvs {
			if ev.Type == ecosystem.EventCreatureGroupDematerialized && ev.EntityID == "camp-thornveil-warren" {
				reconciledEvents++
			}
		}
	}
	if reconciledEvents != 1 {
		t.Fatalf("expected mat-g1 to be reconciled strictly once, got %d", reconciledEvents)
	}

	// After retention ticks elapse, dead/routed mat-g1 MUST be retired from World.Groups freeing capacity.
	for _, g := range state.World.Groups {
		if g.GroupID == "mat-g1" {
			t.Fatalf("expected accounted terminal group mat-g1 to be cleaned up from active Groups")
		}
	}
	// Unsafe ID reuse of retired group must be rejected.
	if _, _, _, err := world.MaterializeGroup(state, "camp-thornveil-warren", "mat-g1", "goblin-raider-pack", 1, 8000, wCfg, eCfg); !errors.Is(err, world.ErrRetiredGroupID) {
		t.Fatalf("expected ErrRetiredGroupID when reusing retired ID, got %v", err)
	}

	// Dematerialize surviving orc group cleanly and verify zero materialized population remains.
	var summary ecosystem.DematerializationSummary
	state, summary, _, err = world.DematerializeGroup(state, "mat-o1", wCfg, eCfg)
	if err != nil {
		t.Fatalf("DematerializeGroup mat-o1 failed: %v", err)
	}
	if summary.Survivors != 4 || summary.Losses != 0 {
		t.Fatalf("expected full 4 orc survivors on uninjured recall, got %+v", summary)
	}
	_, finalMat := ecosystem.TotalEcosystemPopulation(state.Ecosystem)
	if finalMat != 0 {
		t.Fatalf("expected 0 materialized population after all materialized groups exited, got %d", finalMat)
	}
}

func TestCycle03DeadGroupCleanupFreesActiveCapacity(t *testing.T) {
	cfg := world.DefaultConfig()
	cfg.MaxActiveGroups = 2
	cfg.GroupCleanupRetentionTicks = 2
	cfg.MaxReinforcementWaves = 0

	st := mustInitialState(t, "sim-cleanup", 91)
	st, _, err := world.Step(st, []world.Command{
		{Kind: world.CmdSpawnHostileGroup, Tick: 1, GroupID: "g-1", Archetype: "goblin-skirmisher", Count: 1},
		{Kind: world.CmdSpawnHostileGroup, Tick: 1, GroupID: "g-2", Archetype: "goblin-skirmisher", Count: 1},
		{Kind: world.CmdIncreaseThreat, Tick: 1, Delta: 1000},
	}, cfg)
	if err != nil {
		t.Fatalf("setup failed: %v", err)
	}

	// Kill g-1 cleanly via authoritative strikes.
	for tick := uint64(2); tick <= 42; tick++ {
		var cmds []world.Command
		if tick == 2 || tick == 12 || tick == 22 || tick == 32 {
			for _, g := range st.Groups {
				if g.GroupID == "g-1" && g.HP > 0 && !g.Routed {
					cmds = append(cmds, world.Command{Kind: world.CmdPlayerDefendStrike, Tick: tick, PlayerID: "p1", TargetGroupID: "g-1"})
				}
			}
		}
		st, _, err = world.Step(st, cmds, cfg)
		if err != nil {
			t.Fatalf("step %d failed: %v", tick, err)
		}
	}

	// g-1 must have been cleaned up, freeing capacity under MaxActiveGroups=2 to spawn g-3!
	if len(st.Groups) >= 2 {
		t.Fatalf("expected dead/routed g-1 to be evicted freeing capacity, len(Groups)=%d", len(st.Groups))
	}
	st, _, err = world.Step(st, []world.Command{
		{Kind: world.CmdSpawnHostileGroup, Tick: st.Tick + 1, GroupID: "g-3", Archetype: "orc-berserker", Count: 1},
	}, cfg)
	if err != nil {
		t.Fatalf("expected freed capacity to allow spawning g-3, got %v", err)
	}
}

func TestCycle03BoundedSnapshotLimitsAndCommanderFallenEvent(t *testing.T) {
	cfg := world.DefaultConfig()
	st := mustInitialState(t, "sim-cmdr-death", 55)
	st, _, err := world.Step(st, []world.Command{
		{Kind: world.CmdSpawnHostileGroup, Tick: 1, GroupID: "g-cmdr", Archetype: "goblin-taskmaster", Count: 1, HomePosition: 3000, Position: 3000},
		{Kind: world.CmdSpawnHostileGroup, Tick: 1, GroupID: "g-sub", Archetype: "goblin-skirmisher", Count: 1, HomePosition: 3200, Position: 3200},
		{Kind: world.CmdIncreaseThreat, Tick: 1, Delta: 1000},
	}, cfg)
	if err != nil {
		t.Fatalf("setup failed: %v", err)
	}

	// Verify bounded snapshot decode rejects oversized payload BEFORE JSON parsing.
	raw, err := st.MarshalSnapshot()
	if err != nil {
		t.Fatalf("MarshalSnapshot failed: %v", err)
	}
	tinyCfg := cfg
	tinyCfg.MaxSnapshotBytes = len(raw) - 1
	if _, err := world.UnmarshalSnapshotWithLimits(raw, tinyCfg); !errors.Is(err, simulation.ErrSnapshotTooLarge) {
		t.Fatalf("expected ErrSnapshotTooLarge, got %v", err)
	}

	// Bring commander HP down to 50 so next strike kills it and emits EventCommanderFallen.
	st.Groups[0].HP = 50
	st.Groups[1].MoraleBP = 4200
	next, evs, err := world.Step(st, []world.Command{
		{Kind: world.CmdPlayerDefendStrike, Tick: st.Tick + 1, PlayerID: "p-slayer", TargetGroupID: "g-cmdr"},
	}, cfg)
	if err != nil {
		t.Fatalf("killing commander failed: %v", err)
	}

	sawCommanderFallen := false
	for _, ev := range evs {
		if ev.Type == world.EventCommanderFallen && ev.SourceEntityID == "g-cmdr" {
			sawCommanderFallen = true
		}
	}
	if !sawCommanderFallen {
		t.Fatalf("expected dedicated EventCommanderFallen when commander dies")
	}
	if next.Groups[1].State != ai.StateRetreat {
		t.Fatalf("expected nearby goblin subordinate to break into Retreat from commander death shock, got %s (morale=%d)", next.Groups[1].State, next.Groups[1].MoraleBP)
	}
}

func TestCycle03IntegratedSnapshotRestoreEquivalence(t *testing.T) {
	wCfg := world.DefaultConfig()
	eCfg := ecosystem.DefaultConfig()
	eCfg.TicksPerEpoch = 10

	initInt := world.IntegratedState{
		World:     mustInitialState(t, "sim-int-snap", 909),
		Ecosystem: ecosystem.NewDefaultEcosystemState("sim-int-snap", 909),
	}
	var err error
	initInt, _, _, err = world.MaterializeGroup(initInt, "camp-thornveil-warren", "g-int-1", "goblin-raider-pack", 1, 9000, wCfg, eCfg)
	if err != nil {
		t.Fatalf("materialize failed: %v", err)
	}

	// Continuous 30 ticks (3 epochs).
	curA := initInt.Clone()
	var midSnap []byte
	for tick := uint64(1); tick <= 30; tick++ {
		curA, _, _, err = world.StepIntegrated(curA, nil, nil, wCfg, eCfg)
		if err != nil {
			t.Fatalf("continuous tick %d failed: %v", tick, err)
		}
		if tick == 14 {
			midSnap, err = curA.MarshalSnapshot(wCfg, eCfg)
			if err != nil {
				t.Fatalf("MarshalSnapshot at tick 14 failed: %v", err)
			}
		}
	}

	// Restore at tick 14 and continue ticks 15..30.
	curB, err := world.UnmarshalIntegratedSnapshot(midSnap, wCfg, eCfg)
	if err != nil {
		t.Fatalf("UnmarshalIntegratedSnapshot failed: %v", err)
	}
	for tick := uint64(15); tick <= 30; tick++ {
		curB, _, _, err = world.StepIntegrated(curB, nil, nil, wCfg, eCfg)
		if err != nil {
			t.Fatalf("restored tick %d failed: %v", tick, err)
		}
	}

	sumA, _ := curA.Checksum(wCfg, eCfg)
	sumB, _ := curB.Checksum(wCfg, eCfg)
	if sumA != sumB {
		t.Fatalf("integrated snapshot/restore divergence: %s != %s", sumA, sumB)
	}
}

func TestCycle03RetiredGroupIDRingBounded(t *testing.T) {
	cfg := world.DefaultConfig()
	cfg.MaxRetiredGroupIDs = 3
	cfg.GroupCleanupRetentionTicks = 0
	cfg.MaxReinforcementWaves = 0

	st := mustInitialState(t, "sim-ring", 4)
	for i := 0; i < 5; i++ {
		gid := fmt.Sprintf("g-%d", i)
		var err error
		st, _, err = world.Step(st, []world.Command{
			{Kind: world.CmdSpawnHostileGroup, Tick: st.Tick + 1, GroupID: gid, Archetype: "goblin-skirmisher", Count: 1},
		}, cfg)
		if err != nil {
			t.Fatalf("spawn %s failed: %v", gid, err)
		}
		// Mark terminal & accounted and advance 1 tick to trigger eviction.
		st.Groups[0].HP = 0
		st.Groups[0].State = ai.StateDead
		st.Groups[0].TerminalTick = st.Tick
		st.Groups[0].Accounted = true
		st, _, err = world.Step(st, nil, cfg)
		if err != nil {
			t.Fatalf("cleanup tick %d failed: %v", i, err)
		}
	}
	if len(st.RetiredGroupIDs) != 3 {
		t.Fatalf("expected bounded RetiredGroupIDs length 3, got %d (%v)", len(st.RetiredGroupIDs), st.RetiredGroupIDs)
	}
}

func TestAuditLinkedReinforcementDoesNotCreatePopulation(t *testing.T) {
	wCfg, eCfg := world.DefaultConfig(), ecosystem.DefaultConfig()
	st := world.IntegratedState{World: mustInitialState(t, "audit-reinforcement", 11), Ecosystem: ecosystem.NewDefaultEcosystemState("audit-reinforcement", 11)}
	st, _, _, err := world.MaterializeGroup(st, "camp-thornveil-warren", "linked", "goblin-raider-pack", 1, 8000, wCfg, eCfg)
	if err != nil {
		t.Fatal(err)
	}
	st.World.Groups[0].HP = st.World.Groups[0].MaxHP / 2
	beforeFree, beforeMat := ecosystem.TotalEcosystemPopulation(st.Ecosystem)
	next, _, _, err := world.StepIntegrated(st, []world.Command{{Kind: world.CmdIncreaseThreat, Tick: 1, Delta: 1000}}, nil, wCfg, eCfg)
	if err != nil {
		t.Fatal(err)
	}
	free, mat := ecosystem.TotalEcosystemPopulation(next.Ecosystem)
	if len(next.World.Groups) != 1 || next.World.Invasion.ReinforcementWaves != 0 || free != beforeFree || mat != beforeMat {
		t.Fatal("unreserved reinforcements changed integrated state")
	}
	st.World.Groups[0].SourcePopulationID = "missing"
	if st.Validate(wCfg, eCfg) == nil {
		t.Fatal("orphan group accepted")
	}
}
