package worldevents_test

import (
	"errors"
	"fmt"
	"testing"

	"ascendra-game/internal/adapters/memory"
	"ascendra-game/internal/ecosystem"
	"ascendra-game/internal/ports"
	"ascendra-game/internal/world"
	"ascendra-game/internal/worldevents"
)

// FuzzCampaignSchedulerAndCommands fuzzes arbitrary Director, Gameplay, and Ecosystem commands
// against OrchestratedState Step() verifying zero panics, error atomicity, valid invariants,
// and exact 3-bucket population conservation.
func FuzzCampaignSchedulerAndCommands(f *testing.F) {
	f.Add(uint8(0), uint8(0), uint64(1), worldevents.TemplateGoblinRaid, ecosystem.RegionThornveilForest, "pop-thornveil-goblins", "camp-thornveil-warren", "cmp:fuzz:000001", int64(500))
	f.Add(uint8(1), uint8(1), uint64(1), worldevents.TemplateOrcWarband, ecosystem.RegionIronfangFrontier, "pop-ironfang-orcs", "camp-ironfang-bastion", "cmp:fuzz:000001", int64(900))
	f.Add(uint8(2), uint8(2), uint64(2), "unknown-tpl", "region-x", "pop-x", "camp-x", "", int64(-50))
	f.Add(uint8(0), uint8(3), uint64(1), worldevents.TemplateGoblinRaid, ecosystem.RegionValewatchVale, "pop-thornveil-goblins", "camp-thornveil-warren", "cmp:bad", int64(9999999999))

	reader, err := memory.NewSettlementReader(memory.DefaultSettlementFixtures()...)
	if err != nil {
		f.Fatalf("NewSettlementReader: %v", err)
	}
	cfg := worldevents.DefaultOrchestratedConfig()
	base, err := worldevents.NewOrchestratedState("fuzz-dir", "settlement-valewatch", 777, reader, worldevents.NewDualHostileConflictEco("fuzz-dir", 777))
	if err != nil {
		f.Fatalf("NewOrchestratedState: %v", err)
	}

	dirKinds := []worldevents.DirectorCommandKind{
		worldevents.DirCmdScheduleCampaign,
		worldevents.DirCmdCancelCampaign,
		worldevents.DirectorCommandKind("InvalidDirCmd"),
	}
	gpKinds := []world.CommandKind{
		world.CmdDeployDefender,
		world.CmdPlayerDefendStrike,
		world.CmdIncreaseThreat, // forbidden in GameplayCommand
		world.CmdForceInvasionTransition,
	}

	f.Fuzz(func(t *testing.T, dIdx, gIdx uint8, tick uint64, tplID, regID, popID, campID, cmpID string, prio int64) {
		sumBefore, err := base.Checksum(cfg)
		if err != nil {
			t.Fatalf("base checksum failed: %v", err)
		}

		in := worldevents.StepInput{
			DirectorCommands: []worldevents.DirectorCommand{{
				Kind:               dirKinds[int(dIdx)%len(dirKinds)],
				Tick:               tick,
				TemplateID:         tplID,
				RegionID:           regID,
				SourcePopulationID: popID,
				SourceCampID:       campID,
				CampaignID:         cmpID,
				Priority:           prio,
				ScheduledTick:      tick,
			}},
		}
		if gIdx%2 == 1 {
			in.GameplayCommands = []world.GameplayCommand{{
				Kind:     gpKinds[int(gIdx)%len(gpKinds)],
				Tick:     tick,
				PlayerID: "fuzz-player",
				Position: prio,
			}}
		}

		next, _, stepErr := worldevents.Step(base, in, cfg)
		sumAfter, err := base.Checksum(cfg)
		if err != nil || sumBefore != sumAfter {
			t.Fatalf("Step mutated caller state")
		}
		if stepErr == nil {
			if err := next.Validate(cfg); err != nil {
				t.Fatalf("Step produced invalid OrchestratedState: %v", err)
			}
			for _, p := range next.Ecosystem.Populations {
				if p.FreePopulation < 0 || p.ReservedPopulation < 0 || p.MaterializedPopulation < 0 {
					t.Fatalf("negative population invariant broken: %+v", p)
				}
			}
		}
	})
}

// FuzzOutcomeAcknowledgements checks arbitrary duplicate, skipped, conflicting and ordered
// acknowledgements across terminal outcomes, contributions, and director event batches
// against independent cursor models.
func FuzzOutcomeAcknowledgements(f *testing.F) {
	f.Add([]byte{2, 1, 1, 3, 2, 3, 0, 7, 13, 14})
	f.Add([]byte{0, 255, 3, 2, 1, 18, 19, 20})
	reader, err := memory.NewSettlementReader(memory.DefaultSettlementFixtures()...)
	if err != nil {
		f.Fatal(err)
	}
	cfg := worldevents.DefaultOrchestratedConfig()
	cfg.Director.MaxPendingOutcomes = 3
	cfg.Director.MaxPendingDirectorBatches = 3
	cfg.Director.MaxEventsPerUpdate = 1
	base, err := worldevents.NewOrchestratedState("fuzz-acks", "settlement-valewatch", 7, reader, worldevents.NewHighThreatGoblinEco("fuzz-acks", 7))
	if err != nil {
		f.Fatal(err)
	}
	base.Director.OutcomeSeq = 3
	base.Director.ContributionSeq = 3
	base.Director.DirectorBatchSeq = 3
	for seq := uint64(1); seq <= 3; seq++ {
		base.Director.PendingOutcomes = append(base.Director.PendingOutcomes, worldevents.TerminalSettlementOutcome{
			Sequence: seq, EventID: fmt.Sprintf("out-%d", seq), SimulationID: "fuzz-acks", Outcome: ports.InvasionOutcomeDefended,
		})
		base.Director.PendingContributions = append(base.Director.PendingContributions, worldevents.PendingContribution{
			Sequence: seq,
			Result: ports.ContributionResult{
				EventID: fmt.Sprintf("con-%d", seq), SimulationID: "fuzz-acks", InvasionID: "inv-1",
				SettlementID: "settlement-valewatch", PlayerID: fmt.Sprintf("p-%d", seq), Outcome: ports.InvasionOutcomeDefended,
			},
		})
		base.Director.PendingDirectorBatches = append(base.Director.PendingDirectorBatches, worldevents.DirectorEventBatch{
			Sequence: seq,
			Events: []worldevents.DirectorEvent{
				{EventID: fmt.Sprintf("dir-%d-a", seq), SimulationID: "fuzz-acks", Type: worldevents.DirEventCampaignPhaseChanged},
				{EventID: fmt.Sprintf("dir-%d-b", seq), SimulationID: "fuzz-acks", Type: worldevents.DirEventSettlementWarning},
			},
		})
	}
	f.Fuzz(func(t *testing.T, ops []byte) {
		if len(ops) > 64 {
			ops = ops[:64]
		}
		state := base.Clone()
		var outCursor, conCursor, dirCursor uint64
		for _, op := range ops {
			queue := (op >> 4) % 3
			seq := uint64(op % 6)
			conflict := (op & 0x08) != 0
			before, err := state.Checksum(cfg)
			if err != nil {
				t.Fatal(err)
			}
			switch queue {
			case 0: // Outcomes
				var next worldevents.OrchestratedState
				var ackErr error
				if conflict {
					next, ackErr = worldevents.AcknowledgeTerminalOutcomeVerified(state, seq, "wrong-id", cfg)
				} else {
					next, ackErr = worldevents.AcknowledgeTerminalOutcome(state, seq, cfg)
				}
				if !conflict && seq != 0 && (seq == outCursor || (outCursor < 3 && seq == outCursor+1)) {
					if ackErr != nil {
						t.Fatalf("valid outcome ack %d: %v", seq, ackErr)
					}
					if seq == outCursor+1 {
						outCursor++
					}
					state = next
				} else if conflict && seq != 0 && seq == outCursor {
					// Idempotent retry against empty diagnostic history succeeds only when not conflicting.
					if ackErr == nil {
						state = next
					}
				} else {
					if !errors.Is(ackErr, worldevents.ErrInvalidCommand) {
						t.Fatalf("invalid outcome ack seq=%d conflict=%v: %v", seq, conflict, ackErr)
					}
					after, _ := state.Checksum(cfg)
					if before != after {
						t.Fatal("invalid outcome ack mutated state")
					}
				}
			case 1: // Contributions
				var next worldevents.OrchestratedState
				var ackErr error
				if conflict {
					next, ackErr = worldevents.AcknowledgeContributionVerified(state, seq, "wrong-con", cfg)
				} else {
					next, ackErr = worldevents.AcknowledgeContribution(state, seq, cfg)
				}
				if !conflict && seq != 0 && (seq == conCursor || (conCursor < 3 && seq == conCursor+1)) {
					if ackErr != nil {
						t.Fatalf("valid contrib ack %d: %v", seq, ackErr)
					}
					if seq == conCursor+1 {
						conCursor++
					}
					state = next
				} else if conflict && seq != 0 && seq == conCursor {
					if ackErr == nil {
						state = next
					}
				} else {
					if !errors.Is(ackErr, worldevents.ErrInvalidCommand) {
						t.Fatalf("invalid contrib ack seq=%d conflict=%v: %v", seq, conflict, ackErr)
					}
					after, _ := state.Checksum(cfg)
					if before != after {
						t.Fatal("invalid contrib ack mutated state")
					}
				}
			default: // Director batches
				var next worldevents.OrchestratedState
				var ackErr error
				if conflict {
					// Partial event count (1 != 2) must be rejected on pending batch!
					next, ackErr = worldevents.AcknowledgeDirectorBatchVerified(state, seq, 1, cfg)
				} else {
					next, ackErr = worldevents.AcknowledgeDirectorBatchVerified(state, seq, 2, cfg)
				}
				if !conflict && seq != 0 && (seq == dirCursor || (dirCursor < 3 && seq == dirCursor+1)) {
					if ackErr != nil {
						t.Fatalf("valid batch ack %d: %v", seq, ackErr)
					}
					if seq == dirCursor+1 {
						dirCursor++
					}
					state = next
				} else if conflict && seq != 0 && seq == dirCursor {
					if ackErr == nil {
						state = next
					}
				} else {
					if !errors.Is(ackErr, worldevents.ErrInvalidCommand) {
						t.Fatalf("invalid batch ack seq=%d conflict=%v: %v", seq, conflict, ackErr)
					}
					after, _ := state.Checksum(cfg)
					if before != after {
						t.Fatal("invalid batch ack mutated state")
					}
				}
			}

			pendingOut, err := worldevents.PendingTerminalOutcomes(state, cfg)
			if err != nil || len(pendingOut) != int(3-outCursor) {
				t.Fatalf("unexpected pending outcomes: %v %v", pendingOut, err)
			}
			for i, fact := range pendingOut {
				if fact.Sequence != outCursor+uint64(i)+1 {
					t.Fatal("outcome lost, duplicated, or reordered")
				}
			}
			pendingCon, err := worldevents.PendingContributionResults(state, cfg)
			if err != nil || len(pendingCon) != int(3-conCursor) {
				t.Fatalf("unexpected pending contributions: %v %v", pendingCon, err)
			}
			for i, item := range pendingCon {
				if item.Sequence != conCursor+uint64(i)+1 {
					t.Fatal("contribution lost, duplicated, or reordered")
				}
			}
			stats, err := worldevents.PendingQueueStats(state, cfg)
			if err != nil || stats.PendingDirectorBatches != int(3-dirCursor) {
				t.Fatalf("unexpected pending batches: %+v %v", stats, err)
			}
		}
	})
}

// FuzzOrchestratedSnapshotDecode fuzzes Snapshot v5 decoding with pre-decode byte caps.
func FuzzOrchestratedSnapshotDecode(f *testing.F) {
	reader, err := memory.NewSettlementReader(memory.DefaultSettlementFixtures()...)
	if err != nil {
		f.Fatalf("NewSettlementReader: %v", err)
	}
	cfg := worldevents.DefaultOrchestratedConfig()
	cfg.Director.MaxSnapshotBytes = 65536
	cfg.World.MaxSnapshotBytes = 65536
	cfg.Ecosystem.MaxSnapshotBytes = 65536

	st, err := worldevents.NewOrchestratedState("fuzz-snap", "settlement-valewatch", 888, reader, worldevents.NewHighThreatGoblinEco("fuzz-snap", 888))
	if err != nil {
		f.Fatalf("NewOrchestratedState: %v", err)
	}
	valid, err := st.MarshalSnapshot(cfg)
	if err != nil {
		f.Fatalf("MarshalSnapshot: %v", err)
	}

	f.Add(valid)
	f.Add([]byte(`{}`))
	f.Add([]byte(`{"schema_version":3,"checksum":"deadbeef","payload":{}}`))
	f.Add([]byte(`{"schema_version":4,"checksum":"deadbeef","payload":{}}`))
	f.Add([]byte(`{"schema_version":5,"checksum":"deadbeef","payload":{}}`))
	f.Add([]byte(`corrupt-json`))

	f.Fuzz(func(t *testing.T, data []byte) {
		decoded, err := worldevents.UnmarshalOrchestratedSnapshot(data, cfg)
		if err != nil {
			return
		}
		if err := decoded.Validate(cfg); err != nil {
			t.Fatalf("decoded snapshot violated invariants: %v", err)
		}
		reencoded, err := decoded.MarshalSnapshot(cfg)
		if err != nil {
			t.Fatalf("re-encoding decoded snapshot failed: %v", err)
		}
		rt, err := worldevents.UnmarshalOrchestratedSnapshot(reencoded, cfg)
		if err != nil {
			t.Fatalf("round-trip decode failed: %v", err)
		}
		s1, _ := decoded.Checksum(cfg)
		s2, _ := rt.Checksum(cfg)
		if s1 != s2 {
			t.Fatalf("round-trip checksum mismatch: %s != %s", s1, s2)
		}
	})
}
