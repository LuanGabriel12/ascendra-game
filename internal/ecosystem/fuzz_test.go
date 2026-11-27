package ecosystem_test

import (
	"testing"

	"ascendra-game/internal/ecosystem"
)

// FuzzEcosystemCommandsAndInvariants fuzzes arbitrary ecological commands against StepEpoch
// and verifies zero panics, atomic error safety, valid invariants, and zero negative populations.
func FuzzEcosystemCommandsAndInvariants(f *testing.F) {
	f.Add(uint8(0), uint64(1), ecosystem.RegionThornveilForest, "pop-thornveil-goblins", "camp-thornveil-warren", "food", int64(-500))
	f.Add(uint8(1), uint64(1), ecosystem.RegionIronfangFrontier, "pop-ironfang-orcs", "camp-ironfang-bastion", "wood", int64(250))
	f.Add(uint8(2), uint64(2), "region-unknown", "pop-missing", "camp-missing", "ore", int64(999999999999))
	f.Add(uint8(3), uint64(1), ecosystem.RegionValewatchVale, "pop-thornveil-goblins", "", "water", int64(-10))

	kinds := []ecosystem.CommandKind{
		ecosystem.CmdDestroyCamp,
		ecosystem.CmdAdjustResource,
		ecosystem.CmdEstablishCamp,
		ecosystem.CmdApplyConflictLoss,
		ecosystem.CommandKind("InvalidEcoCmd"),
	}
	cfg := ecosystem.DefaultConfig()
	base := ecosystem.NewTerritorialDisputeState("fuzz-eco", 99)

	f.Fuzz(func(t *testing.T, kindIdx uint8, epoch uint64, regionID, popID, campID, resName string, delta int64) {
		cmd := ecosystem.Command{
			Kind:         kinds[int(kindIdx)%len(kinds)],
			Epoch:        epoch,
			RegionID:     regionID,
			PopulationID: popID,
			CampID:       campID,
			ResourceName: resName,
			Delta:        delta,
		}

		sumBefore, err := base.Checksum(cfg)
		if err != nil {
			t.Fatalf("base checksum failed: %v", err)
		}

		next, _, stepErr := ecosystem.StepEpoch(base, []ecosystem.Command{cmd}, cfg)
		sumAfter, err := base.Checksum(cfg)
		if err != nil || sumBefore != sumAfter {
			t.Fatalf("StepEpoch mutated caller state")
		}
		if stepErr == nil {
			if err := next.Validate(cfg); err != nil {
				t.Fatalf("StepEpoch produced invalid state: %v", err)
			}
			for _, p := range next.Populations {
				if p.FreePopulation < 0 || p.ReservedPopulation < 0 || p.MaterializedPopulation < 0 {
					t.Fatalf("negative population invariant broken: %+v", p)
				}
			}
		}
	})
}

// FuzzEcosystemSnapshotDecode fuzzes bounded snapshot decoding against adversarial payloads.
func FuzzEcosystemSnapshotDecode(f *testing.F) {
	cfg := ecosystem.DefaultConfig()
	cfg.MaxSnapshotBytes = 32768
	st := ecosystem.NewDefaultEcosystemState("fuzz-snap", 7)
	valid, _ := st.MarshalSnapshot(cfg)

	f.Add(valid)
	f.Add([]byte(`{}`))
	f.Add([]byte(`{"schema_version":4,"checksum":"deadbeef","payload":{}}`))
	f.Add([]byte(`{"schema_version":5,"checksum":"deadbeef","payload":{}}`))
	f.Add([]byte(`corrupt`))

	f.Fuzz(func(t *testing.T, data []byte) {
		decoded, err := ecosystem.UnmarshalSnapshot(data, cfg)
		if err != nil {
			return
		}
		if err := decoded.Validate(cfg); err != nil {
			t.Fatalf("decoded ecosystem snapshot violated invariants: %v", err)
		}
		reencoded, err := decoded.MarshalSnapshot(cfg)
		if err != nil {
			t.Fatalf("re-encoding decoded snapshot failed: %v", err)
		}
		roundTrip, err := ecosystem.UnmarshalSnapshot(reencoded, cfg)
		if err != nil {
			t.Fatalf("round-trip decode failed: %v", err)
		}
		s1, _ := decoded.Checksum(cfg)
		s2, _ := roundTrip.Checksum(cfg)
		if s1 != s2 {
			t.Fatalf("round-trip checksum mismatch: %s != %s", s1, s2)
		}
	})
}
