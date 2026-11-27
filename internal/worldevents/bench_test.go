package worldevents_test

import (
	"fmt"
	"testing"

	"ascendra-game/internal/adapters/memory"
	"ascendra-game/internal/ecosystem"
	"ascendra-game/internal/ports"
	"ascendra-game/internal/worldevents"
)

func BenchmarkAcknowledgeTerminalOutcome(b *testing.B) {
	st, cfg := setupBenchState(b)
	st.Director.OutcomeSeq = 1
	st.Director.PendingOutcomes = []worldevents.TerminalSettlementOutcome{{Sequence: 1, EventID: "bench-outcome", SimulationID: st.Director.SimulationID, Outcome: ports.InvasionOutcomeDefended}}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := worldevents.AcknowledgeTerminalOutcome(st, 1, cfg); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkDirectorEventPagination(b *testing.B) {
	st, cfg := setupBenchState(b)
	cfg.Director.MaxEventsPerUpdate = 4
	events := make([]worldevents.DirectorEvent, 16)
	for i := range events {
		events[i] = worldevents.DirectorEvent{
			EventID:      fmt.Sprintf("bench-dir-%02d", i),
			SimulationID: st.Director.SimulationID,
			Type:         worldevents.DirEventCampaignPhaseChanged,
		}
	}
	st.Director.DirectorBatchSeq = 1
	st.Director.PendingDirectorBatches = []worldevents.DirectorEventBatch{{Sequence: 1, Events: events}}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		for offset := 0; ; {
			_, page, more, err := worldevents.PendingDirectorEventPage(st, offset, cfg)
			if err != nil {
				b.Fatal(err)
			}
			offset += len(page)
			if !more {
				break
			}
		}
	}
}

func BenchmarkAcknowledgeDirectorBatch(b *testing.B) {
	st, cfg := setupBenchState(b)
	st.Director.DirectorBatchSeq = 1
	st.Director.PendingDirectorBatches = []worldevents.DirectorEventBatch{{
		Sequence: 1,
		Events:   []worldevents.DirectorEvent{{EventID: "bench-dir-1", SimulationID: st.Director.SimulationID, Type: worldevents.DirEventCampaignPhaseChanged}},
	}}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := worldevents.AcknowledgeDirectorBatchVerified(st, 1, 1, cfg); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkAcknowledgeContribution(b *testing.B) {
	st, cfg := setupBenchState(b)
	st.Director.ContributionSeq = 1
	st.Director.PendingContributions = []worldevents.PendingContribution{{
		Sequence: 1,
		Result: ports.ContributionResult{
			EventID: "bench-con-1", SimulationID: st.Director.SimulationID, InvasionID: "inv-1",
			SettlementID: "settlement-valewatch", PlayerID: "player-1", Outcome: ports.InvasionOutcomeDefended,
		},
	}}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := worldevents.AcknowledgeContributionVerified(st, 1, "bench-con-1", cfg); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkBackpressureRecoveryCycle(b *testing.B) {
	st, cfg := setupBenchState(b)
	cfg.Director.MaxPendingDirectorBatches = 1
	cfg.Director.MaxEventsPerUpdate = 1
	// Advance until batch queue fills (tick 5 emits candidate + launch).
	cur := st
	for tick := uint64(1); tick <= 5; tick++ {
		var err error
		cur, _, err = worldevents.Step(cur, worldevents.StepInput{}, cfg)
		if err != nil {
			b.Fatalf("warmup tick %d: %v", tick, err)
		}
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		// Page through saturated batch -> verified ack -> resume next tick.
		var seq uint64
		count := 0
		for offset := 0; ; {
			var page []worldevents.DirectorEvent
			var more bool
			var err error
			seq, page, more, err = worldevents.PendingDirectorEventPage(cur, offset, cfg)
			if err != nil {
				b.Fatal(err)
			}
			count += len(page)
			offset += len(page)
			if !more {
				break
			}
		}
		recovered, err := worldevents.AcknowledgeDirectorBatchVerified(cur, seq, count, cfg)
		if err != nil {
			b.Fatal(err)
		}
		if _, _, err := worldevents.Step(recovered, worldevents.StepInput{}, cfg); err != nil {
			b.Fatal(err)
		}
	}
}

func setupBenchState(b *testing.B) (worldevents.OrchestratedState, worldevents.OrchestratedConfig) {
	b.Helper()
	reader, err := memory.NewSettlementReader(memory.DefaultSettlementFixtures()...)
	if err != nil {
		b.Fatalf("NewSettlementReader: %v", err)
	}
	cfg := worldevents.DefaultOrchestratedConfig()
	st, err := worldevents.NewOrchestratedState("bench-dir", "settlement-valewatch", 555, reader, worldevents.NewDualHostileConflictEco("bench-dir", 555))
	if err != nil {
		b.Fatalf("NewOrchestratedState: %v", err)
	}
	return st, cfg
}

func BenchmarkEvaluateCandidates(b *testing.B) {
	st, cfg := setupBenchState(b)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		cands, err := worldevents.EvaluateCandidates(st.Director, st.Ecosystem, st.World, cfg.Director, 2)
		if err != nil || len(cands) == 0 {
			b.Fatalf("EvaluateCandidates failed: len=%d err=%v", len(cands), err)
		}
	}
}

func BenchmarkSchedulerEnqueueAndStep(b *testing.B) {
	st, cfg := setupBenchState(b)
	cfg.Director.CandidateEvalIntervalTicks = 100000
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		dir := st.Director.Clone()
		for j := 0; j < 8; j++ {
			_, err := worldevents.EnqueueScheduledEvent(&dir, worldevents.ScheduledEvent{
				Kind:          worldevents.EventRecoveryFollowup,
				Category:      worldevents.CategoryCreature,
				RegionID:      ecosystem.RegionThornveilForest,
				Priority:      int64(100 + j*25),
				ScheduledTick: 1,
				DeadlineTick:  100,
			}, cfg.Director)
			if err != nil {
				b.Fatalf("EnqueueScheduledEvent: %v", err)
			}
		}
		tmp := st
		tmp.Director = dir
		if _, _, err := worldevents.Step(tmp, worldevents.StepInput{}, cfg); err != nil {
			b.Fatalf("Step: %v", err)
		}
	}
}

func BenchmarkCampaignProgressionStep(b *testing.B) {
	st, cfg := setupBenchState(b)
	// Advance until an Orc campaign is Active in combat.
	cur := st
	for tick := uint64(1); tick <= 35; tick++ {
		var err error
		cur, _, err = worldevents.Step(cur, worldevents.StepInput{}, cfg)
		if err != nil {
			b.Fatalf("warmup tick %d: %v", tick, err)
		}
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, _, err := worldevents.Step(cur, worldevents.StepInput{}, cfg); err != nil {
			b.Fatalf("Step active campaign: %v", err)
		}
	}
}

func BenchmarkReservationLifecycle(b *testing.B) {
	cfg := ecosystem.DefaultConfig()
	base := worldevents.NewHighThreatGoblinEco("bench-res", 42)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		st := base.Clone()
		res, _, _, err := ecosystem.CreateReservation(&st, ecosystem.ReservationRequest{
			IdempotencyKey: fmt.Sprintf("k-%d", i),
			CampaignID:     "cmp:bench:1",
			CampID:         "camp-thornveil-warren",
			Amount:         20,
			CreatedTick:    1,
			ExpiryTick:     100,
		}, cfg)
		if err != nil {
			b.Fatalf("CreateReservation: %v", err)
		}
		ticket, _, err := ecosystem.MaterializeFromReservation(&st, res.ReservationID, "op-mat", "goblin-skirmisher", 1, cfg)
		if err != nil {
			b.Fatalf("MaterializeFromReservation: %v", err)
		}
		if _, _, err := ecosystem.ReconcileReservationContingent(&st, res.ReservationID, "op-rec", ticket.ContingentSize, 50, 100, false, cfg); err != nil {
			b.Fatalf("ReconcileReservationContingent: %v", err)
		}
		if _, _, err := ecosystem.CompleteReservation(&st, res.ReservationID); err != nil {
			b.Fatalf("CompleteReservation: %v", err)
		}
	}
}

func BenchmarkOrchestratedStepIntegrated(b *testing.B) {
	st, cfg := setupBenchState(b)
	cur := st
	for tick := uint64(1); tick <= 19; tick++ {
		var err error
		cur, _, err = worldevents.Step(cur, worldevents.StepInput{}, cfg)
		if err != nil {
			b.Fatalf("warmup tick %d: %v", tick, err)
		}
	}
	// Tick 20 triggers Ecosystem StepEpoch + Candidate Eval + Scheduler + Campaign Advance + World Step!
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, _, err := worldevents.Step(cur, worldevents.StepInput{}, cfg); err != nil {
			b.Fatalf("Step epoch+campaign tick: %v", err)
		}
	}
}

func BenchmarkOrchestratedSnapshotRoundTrip(b *testing.B) {
	st, cfg := setupBenchState(b)
	cur := st
	for tick := uint64(1); tick <= 32; tick++ {
		var err error
		cur, _, err = worldevents.Step(cur, worldevents.StepInput{}, cfg)
		if err != nil {
			b.Fatalf("warmup tick %d: %v", tick, err)
		}
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		raw, err := cur.MarshalSnapshot(cfg)
		if err != nil {
			b.Fatalf("MarshalSnapshot: %v", err)
		}
		if _, err := worldevents.UnmarshalOrchestratedSnapshot(raw, cfg); err != nil {
			b.Fatalf("UnmarshalOrchestratedSnapshot: %v", err)
		}
	}
}
