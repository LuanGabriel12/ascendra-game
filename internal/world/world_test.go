package world_test

import (
	"context"
	"errors"
	"math"
	"sync"
	"testing"

	"ascendra-game/internal/adapters/memory"
	"ascendra-game/internal/ports"
	"ascendra-game/internal/world"
)

func mustInitialState(t *testing.T, simID string, seed uint64) world.WorldState {
	t.Helper()
	reader, err := memory.NewSettlementReader(memory.DefaultSettlementFixtures()...)
	if err != nil {
		t.Fatalf("NewSettlementReader failed: %v", err)
	}
	st, err := world.NewWorldState(simID, "settlement-valewatch", seed, reader)
	if err != nil {
		t.Fatalf("NewWorldState failed: %v", err)
	}
	return st
}

// CA-01 + CA-03 + CA-06: Same initial state + same commands + same seed -> identical final checksum.
func TestDeterminismRunAEqualsRunB(t *testing.T) {
	cfg := world.DefaultConfig()
	script := world.BuildDefendedScenarioScript()
	const seed uint64 = 20261126
	const totalTicks uint64 = 1200

	initialA := mustInitialState(t, "sim-det", seed)
	initialB := mustInitialState(t, "sim-det", seed)

	sinkA := memory.NewContributionSink()
	sinkB := memory.NewContributionSink()

	resA, err := world.RunScenario(context.Background(), initialA, script, totalTicks, cfg, sinkA)
	if err != nil {
		t.Fatalf("run A failed: %v", err)
	}
	resB, err := world.RunScenario(context.Background(), initialB, script, totalTicks, cfg, sinkB)
	if err != nil {
		t.Fatalf("run B failed: %v", err)
	}

	if resA.FinalChecksum != resB.FinalChecksum {
		t.Fatalf("determinism failure: checksum A=%s != checksum B=%s", resA.FinalChecksum, resB.FinalChecksum)
	}
	if len(resA.Events) != len(resB.Events) {
		t.Fatalf("event count mismatch: %d != %d", len(resA.Events), len(resB.Events))
	}
	for i := range resA.Events {
		if resA.Events[i].EventID != resB.Events[i].EventID || resA.Events[i].Type != resB.Events[i].Type {
			t.Fatalf("event divergence at %d: %+v vs %+v", i, resA.Events[i], resB.Events[i])
		}
	}
}

// Snapshot/Restore contract:
// Simulate to tick K -> save snapshot -> continue K+1..N (result A).
// Restore snapshot K -> continue K+1..N (result B).
// Assert exact canonical state & checksum equality.
func TestSnapshotRestoreAtTickK(t *testing.T) {
	cfg := world.DefaultConfig()
	script := world.BuildDefendedScenarioScript()
	const seed uint64 = 777777
	const tickK uint64 = 35
	const totalTicks uint64 = 250

	initial := mustInitialState(t, "sim-snap", seed)

	// Run up to tick K.
	atK, err := world.RunScenario(context.Background(), initial, script, tickK, cfg, nil)
	if err != nil {
		t.Fatalf("run to tick K failed: %v", err)
	}

	snapBytes, err := atK.FinalState.MarshalSnapshot()
	if err != nil {
		t.Fatalf("MarshalSnapshot at tick K failed: %v", err)
	}
	if len(snapBytes) == 0 {
		t.Fatalf("expected non-empty snapshot bytes")
	}

	// Continue original execution from K+1..N.
	sinkA := memory.NewContributionSink()
	resA, err := world.RunScenario(context.Background(), atK.FinalState, script, totalTicks, cfg, sinkA)
	if err != nil {
		t.Fatalf("continuation A failed: %v", err)
	}

	// Restore snapshot K and simulate K+1..N.
	restoredK, err := world.UnmarshalSnapshot(snapBytes)
	if err != nil {
		t.Fatalf("UnmarshalSnapshot failed: %v", err)
	}
	sinkB := memory.NewContributionSink()
	resB, err := world.RunScenario(context.Background(), restoredK, script, totalTicks, cfg, sinkB)
	if err != nil {
		t.Fatalf("continuation B from snapshot failed: %v", err)
	}

	if resA.FinalChecksum != resB.FinalChecksum {
		t.Fatalf("snapshot/restore divergence: original=%s restored=%s", resA.FinalChecksum, resB.FinalChecksum)
	}
	if resA.FinalState.Invasion.Outcome != resB.FinalState.Invasion.Outcome {
		t.Fatalf("outcome mismatch: %s != %s", resA.FinalState.Invasion.Outcome, resB.FinalState.Invasion.Outcome)
	}
	if len(sinkA.Records()) != len(sinkB.Records()) {
		t.Fatalf("contribution records mismatch: %d != %d", len(sinkA.Records()), len(sinkB.Records()))
	}
}

// CA-01..CA-07 end-to-end defended scenario verifying progression, contribution handoff, and Carbon boundaries.
func TestWorldSliceDefendedEndToEnd(t *testing.T) {
	cfg := world.DefaultConfig()
	initial := mustInitialState(t, "sim-defended", 4242)
	sink := memory.NewContributionSink()

	res, err := world.RunScenario(context.Background(), initial, world.BuildDefendedScenarioScript(), 200, cfg, sink)
	if err != nil {
		t.Fatalf("RunScenario defended failed: %v", err)
	}

	if res.FinalState.Invasion.State != world.InvasionResolved {
		t.Fatalf("expected InvasionResolved, got %s", res.FinalState.Invasion.State)
	}
	if res.FinalState.Invasion.Outcome != ports.InvasionOutcomeDefended {
		t.Fatalf("expected Outcome Defended, got %s", res.FinalState.Invasion.Outcome)
	}
	if res.FinalState.SettlementDefenseHP <= 0 {
		t.Fatalf("expected surviving settlement HP > 0, got %d", res.FinalState.SettlementDefenseHP)
	}

	records := sink.Records()
	if len(records) != 2 {
		t.Fatalf("expected 2 player contributions delivered to Carbon port, got %d", len(records))
	}
	// Canonical alphabetical order by PlayerID.
	if records[0].PlayerID != "player-kael" || records[1].PlayerID != "player-lyra" {
		t.Fatalf("expected sorted players [player-kael, player-lyra], got [%s, %s]", records[0].PlayerID, records[1].PlayerID)
	}
	if !records[0].Eligible || records[0].Damage <= 0 {
		t.Fatalf("expected player-kael eligible with positive damage, got %+v", records[0])
	}
	if !records[1].Eligible || records[1].Objectives != 1 || records[1].Support <= 0 {
		t.Fatalf("expected player-lyra eligible with objective & support, got %+v", records[1])
	}

	// Re-dispatching the exact same events must trigger Carbon sink idempotency guard.
	_, err = world.DispatchContributions(res.Events, sink)
	if !errors.Is(err, ports.ErrDuplicateContribution) {
		t.Fatalf("expected ErrDuplicateContribution on redelivery, got %v", err)
	}
	if len(sink.Records()) != 2 {
		t.Fatalf("duplicate dispatch must not add records; got %d", len(sink.Records()))
	}
}

// End-to-end captured scenario verifying hostile breach produces SettlementCaptured.
func TestWorldSliceCapturedEndToEnd(t *testing.T) {
	cfg := world.DefaultConfig()
	initial := mustInitialState(t, "sim-captured", 8888)
	sink := memory.NewContributionSink()

	res, err := world.RunScenario(context.Background(), initial, world.BuildCapturedScenarioScript(), 350, cfg, sink)
	if err != nil {
		t.Fatalf("RunScenario captured failed: %v", err)
	}

	if res.FinalState.Invasion.State != world.InvasionResolved {
		t.Fatalf("expected InvasionResolved, got %s", res.FinalState.Invasion.State)
	}
	if res.FinalState.Invasion.Outcome != ports.InvasionOutcomeCaptured {
		t.Fatalf("expected Outcome Captured, got %s", res.FinalState.Invasion.Outcome)
	}
	if res.FinalState.SettlementDefenseHP != 0 {
		t.Fatalf("expected SettlementDefenseHP == 0 on capture, got %d", res.FinalState.SettlementDefenseHP)
	}

	records := sink.Records()
	if len(records) != 1 || records[0].PlayerID != "player-scout" || records[0].Eligible {
		t.Fatalf("expected 1 non-eligible contribution from player-scout, got %+v", records)
	}
}

// CA-02: Invalid invasion transitions must be explicitly rejected without mutating state.
func TestInvalidInvasionTransitionsRejected(t *testing.T) {
	cases := []struct {
		from world.InvasionState
		to   world.InvasionState
		ok   bool
	}{
		{world.InvasionPeace, world.InvasionThreatened, true},
		{world.InvasionPeace, world.InvasionUnderAttack, false},
		{world.InvasionPeace, world.InvasionResolved, false},
		{world.InvasionPeace, world.InvasionPeace, false},
		{world.InvasionThreatened, world.InvasionUnderAttack, true},
		{world.InvasionThreatened, world.InvasionPeace, true},
		{world.InvasionThreatened, world.InvasionResolved, false},
		{world.InvasionUnderAttack, world.InvasionResolved, true},
		{world.InvasionUnderAttack, world.InvasionPeace, false},
		{world.InvasionUnderAttack, world.InvasionThreatened, false},
		{world.InvasionResolved, world.InvasionPeace, false},
		{world.InvasionResolved, world.InvasionThreatened, false},
		{world.InvasionResolved, world.InvasionUnderAttack, false},
		{world.InvasionResolved, world.InvasionResolved, false},
		{world.InvasionState("Bogus"), world.InvasionPeace, false},
	}

	for _, tc := range cases {
		err := world.ValidateTransition(tc.from, tc.to)
		if tc.ok && err != nil {
			t.Fatalf("expected transition %s->%s to succeed, got %v", tc.from, tc.to, err)
		}
		if !tc.ok && !errors.Is(err, world.ErrInvalidInvasionTransition) {
			t.Fatalf("expected ErrInvalidInvasionTransition for %s->%s, got %v", tc.from, tc.to, err)
		}
	}

	// Verify Step rejects illegal transition command atomically without mutating input state.
	cfg := world.DefaultConfig()
	st := mustInitialState(t, "sim-illegal-trans", 1)
	sumBefore, _ := st.Checksum()
	_, _, err := world.Step(st, []world.Command{
		{Kind: world.CmdForceInvasionTransition, Tick: 1, TargetState: world.InvasionUnderAttack},
	}, cfg)
	if !errors.Is(err, world.ErrInvalidInvasionTransition) {
		t.Fatalf("expected ErrInvalidInvasionTransition from Step, got %v", err)
	}
	sumAfter, _ := st.Checksum()
	if sumBefore != sumAfter {
		t.Fatalf("failed Step mutated caller state")
	}
}

// Security & Gameplay Invariants: past/future tick tampering, negative values, overflow,
// unknown entities, cooldown bypass, dead targets, duplicate objectives.
func TestInvalidCommandsAndAuthorityInvariants(t *testing.T) {
	cfg := world.DefaultConfig()
	st := mustInitialState(t, "sim-inv", 123)

	// 1. Tick tampering (past tick 0 or future tick 5 on step 1).
	if _, _, err := world.Step(st, []world.Command{{Kind: world.CmdIncreaseThreat, Tick: 0, Delta: 100}}, cfg); !errors.Is(err, world.ErrCommandTickMismatch) {
		t.Fatalf("expected ErrCommandTickMismatch for past tick, got %v", err)
	}
	if _, _, err := world.Step(st, []world.Command{{Kind: world.CmdIncreaseThreat, Tick: 5, Delta: 100}}, cfg); !errors.Is(err, world.ErrCommandTickMismatch) {
		t.Fatalf("expected ErrCommandTickMismatch for future tick, got %v", err)
	}

	// 2. Negative threat delta rejected.
	if _, _, err := world.Step(st, []world.Command{{Kind: world.CmdIncreaseThreat, Tick: 1, Delta: -50}}, cfg); !errors.Is(err, world.ErrInvalidCommand) {
		t.Fatalf("expected ErrInvalidCommand for negative threat delta, got %v", err)
	}

	// 3. Overflow on threat increase rejected cleanly.
	stThreat, _, err := world.Step(st, []world.Command{{Kind: world.CmdIncreaseThreat, Tick: 1, Delta: 100}}, cfg)
	if err != nil {
		t.Fatalf("valid threat increase failed: %v", err)
	}
	if _, _, err := world.Step(stThreat, []world.Command{{Kind: world.CmdIncreaseThreat, Tick: 2, Delta: math.MaxInt64}}, cfg); !errors.Is(err, world.ErrNumericOverflow) {
		t.Fatalf("expected ErrNumericOverflow, got %v", err)
	}

	// 4. Player attack before invasion starts rejected.
	if _, _, err := world.Step(stThreat, []world.Command{{Kind: world.CmdPlayerDefendStrike, Tick: 2, PlayerID: "p1", TargetGroupID: "g1"}}, cfg); !errors.Is(err, world.ErrInvasionNotActive) {
		t.Fatalf("expected ErrInvasionNotActive, got %v", err)
	}

	// Bring simulation to UnderAttack.
	stAttack, _, err := world.Step(stThreat, []world.Command{{Kind: world.CmdIncreaseThreat, Tick: 2, Delta: 1000}}, cfg)
	if err != nil {
		t.Fatalf("escalating to UnderAttack failed: %v", err)
	}

	// 5. Unknown target group rejected.
	if _, _, err := world.Step(stAttack, []world.Command{{Kind: world.CmdPlayerDefendStrike, Tick: 3, PlayerID: "p1", TargetGroupID: "ghost-group"}}, cfg); !errors.Is(err, world.ErrUnknownEntity) {
		t.Fatalf("expected ErrUnknownEntity, got %v", err)
	}

	// 6. Cooldown bypass rejected on immediate next tick.
	stStruck, _, err := world.Step(stAttack, []world.Command{{Kind: world.CmdPlayerDefendStrike, Tick: 3, PlayerID: "p1", TargetGroupID: "group-vanguard-1"}}, cfg)
	if err != nil {
		t.Fatalf("first valid strike failed: %v", err)
	}
	if _, _, err := world.Step(stStruck, []world.Command{{Kind: world.CmdPlayerDefendStrike, Tick: 4, PlayerID: "p1", TargetGroupID: "group-vanguard-1"}}, cfg); !errors.Is(err, world.ErrCooldownActive) {
		t.Fatalf("expected ErrCooldownActive when bypassing cooldown, got %v", err)
	}

	// 7. Duplicate objective completion rejected.
	stObj, _, err := world.Step(stStruck, []world.Command{{Kind: world.CmdCompleteObjective, Tick: 4, PlayerID: "p1", ObjectiveID: "obj-1"}}, cfg)
	if err != nil {
		t.Fatalf("first objective completion failed: %v", err)
	}
	if _, _, err := world.Step(stObj, []world.Command{{Kind: world.CmdCompleteObjective, Tick: 5, PlayerID: "p2", ObjectiveID: "obj-1"}}, cfg); !errors.Is(err, world.ErrDuplicateObjective) {
		t.Fatalf("expected ErrDuplicateObjective on repeat objective, got %v", err)
	}
}

// Concurrency & Race Safety: multiple independent simulations execute concurrently without
// shared mutable state, orphan goroutines, or data races under `go test -race`.
func TestConcurrentSimulationsIsolated(t *testing.T) {
	const workers = 8
	const seed uint64 = 555123
	cfg := world.DefaultConfig()
	script := world.BuildDefendedScenarioScript()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	checksums := make([]string, workers)
	errs := make([]error, workers)
	var wg sync.WaitGroup

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			reader, err := memory.NewSettlementReader(memory.DefaultSettlementFixtures()...)
			if err != nil {
				errs[idx] = err
				return
			}
			initState, err := world.NewWorldState("sim-concurrent", "settlement-valewatch", seed, reader)
			if err != nil {
				errs[idx] = err
				return
			}
			sink := memory.NewContributionSink()
			res, err := world.RunScenario(ctx, initState, script, 150, cfg, sink)
			if err != nil {
				errs[idx] = err
				return
			}
			checksums[idx] = res.FinalChecksum
		}(i)
	}

	wg.Wait()
	for i := 0; i < workers; i++ {
		if errs[i] != nil {
			t.Fatalf("worker %d failed: %v", i, errs[i])
		}
		if checksums[i] != checksums[0] {
			t.Fatalf("worker %d checksum mismatch: %s != %s", i, checksums[i], checksums[0])
		}
	}
}

// Baseline performance benchmarks (per-tick step, canonical checksum, and snapshot round-trip).
func BenchmarkWorldStep(b *testing.B) {
	cfg := world.DefaultConfig()
	reader, _ := memory.NewSettlementReader(memory.DefaultSettlementFixtures()...)
	st, _ := world.NewWorldState("sim-bench", "settlement-valewatch", 42, reader)
	st, _, _ = world.Step(st, []world.Command{{Kind: world.CmdIncreaseThreat, Tick: 1, Delta: 1000}}, cfg)

	b.ReportAllocs()
	b.ResetTimer()
	cur := st
	for i := 0; i < b.N; i++ {
		var err error
		cur, _, err = world.Step(cur, nil, cfg)
		if err != nil {
			b.Fatalf("Step failed: %v", err)
		}
		if cur.Invasion.State == world.InvasionResolved {
			cur = st
		}
	}
}

func BenchmarkCanonicalChecksum(b *testing.B) {
	cfg := world.DefaultConfig()
	reader, _ := memory.NewSettlementReader(memory.DefaultSettlementFixtures()...)
	st, _ := world.NewWorldState("sim-bench", "settlement-valewatch", 42, reader)
	res, _ := world.RunScenario(context.Background(), st, world.BuildDefendedScenarioScript(), 40, cfg, nil)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := res.FinalState.Checksum(); err != nil {
			b.Fatalf("Checksum failed: %v", err)
		}
	}
}

func BenchmarkSnapshotRoundTrip(b *testing.B) {
	cfg := world.DefaultConfig()
	reader, _ := memory.NewSettlementReader(memory.DefaultSettlementFixtures()...)
	st, _ := world.NewWorldState("sim-bench", "settlement-valewatch", 42, reader)
	res, _ := world.RunScenario(context.Background(), st, world.BuildDefendedScenarioScript(), 40, cfg, nil)

	sample, err := res.FinalState.MarshalSnapshot()
	if err != nil {
		b.Fatalf("MarshalSnapshot failed: %v", err)
	}
	b.ReportMetric(float64(len(sample)), "snapshot_bytes")
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		raw, err := res.FinalState.MarshalSnapshot()
		if err != nil {
			b.Fatalf("MarshalSnapshot failed: %v", err)
		}
		if _, err := world.UnmarshalSnapshot(raw); err != nil {
			b.Fatalf("UnmarshalSnapshot failed: %v", err)
		}
	}
}

func TestNumericLimitsRejectOverflow(t *testing.T) {
	cfg := world.DefaultConfig()
	st := mustInitialState(t, "sim-limits", 1)
	st.Tick = math.MaxUint64
	if _, _, err := world.Step(st, nil, cfg); !errors.Is(err, world.ErrNumericOverflow) {
		t.Fatalf("tick overflow: %v", err)
	}
	st.Tick = 0
	st.EventSeq = math.MaxUint64
	if _, _, err := world.Step(st, []world.Command{{Kind: world.CmdIncreaseThreat, Tick: 1, Delta: 1}}, cfg); !errors.Is(err, world.ErrNumericOverflow) {
		t.Fatalf("event sequence overflow: %v", err)
	}
	cfg.PlayerDamageVariance = math.MaxInt64
	if err := cfg.Validate(); !errors.Is(err, world.ErrInvalidConfig) {
		t.Fatalf("player variance: %v", err)
	}
	cfg = world.DefaultConfig()
	cfg.HostileDamageVariance = math.MaxInt64
	if err := cfg.Validate(); !errors.Is(err, world.ErrInvalidConfig) {
		t.Fatalf("hostile variance: %v", err)
	}
	cfg = world.DefaultConfig()
	st = mustInitialState(t, "sim-cooldown-limit", 1)
	st.Tick = math.MaxUint64 - 2
	st.Invasion.State = world.InvasionUnderAttack
	st.Invasion.StartedTick = st.Tick
	if _, _, err := world.Step(st, []world.Command{{Kind: world.CmdPlayerSupportDefense, Tick: math.MaxUint64 - 1, PlayerID: "p"}}, cfg); !errors.Is(err, world.ErrNumericOverflow) {
		t.Fatalf("cooldown overflow: %v", err)
	}
}
