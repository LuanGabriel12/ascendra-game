package worldevents_test

import (
	"testing"

	"ascendra-game/internal/adapters/memory"
	"ascendra-game/internal/ecosystem"
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

// FuzzOrchestratedSnapshotDecode fuzzes Snapshot v4 decoding with pre-decode byte caps.
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
