package ecosystem

import (
	"errors"
	"math"
	"math/big"
	"math/rand"
	"slices"
	"testing"

	"ascendra-game/internal/ai"
)

func TestAuditMigrationSharesDestinationCapacity(t *testing.T) {
	cfg := DefaultConfig()
	cfg.MigrationShareBP = 10000
	cfg.MaxMigrantsPerEpoch = 20
	cfg.MinMigrationGroupSize = 1
	state := EcosystemState{
		Regions: []Region{
			{RegionID: "a", AdjacentRegions: []string{"c"}},
			{RegionID: "b", AdjacentRegions: []string{"c"}},
			{RegionID: "c", CarryingCapacity: 10},
		},
		Populations: []Population{
			{PopulationID: "a", RegionID: "a", FactionID: "g", SpeciesID: "g", FamilyID: ai.FamilyGoblin, FreePopulation: 20, ScarcityBP: 10000, MigrationPressureBP: 10000},
			{PopulationID: "b", RegionID: "b", FactionID: "g", SpeciesID: "g", FamilyID: ai.FamilyGoblin, FreePopulation: 20, ScarcityBP: 10000, MigrationPressureBP: 10000},
		},
	}
	var events []EcologicalEvent
	if err := processMigration(&state, cfg, &events); err != nil {
		t.Fatal(err)
	}
	if got := totalRegionPopulation(state.Populations, "c"); got != 10 {
		t.Fatalf("destination population = %d", got)
	}
	free, reserved := TotalEcosystemPopulation(state)
	if free != 40 || reserved != 0 || len(events) != 1 || events[0].Amount != 10 {
		t.Fatalf("bad migration ledger: %d free, %d reserved, %+v", free, reserved, events)
	}
}

func TestAuditResourceOverflowAndFractionalRates(t *testing.T) {
	slot := ResourceSlot{Amount: math.MaxInt64, MaxCapacity: math.MaxInt64, ExtractionLimit: math.MaxInt64}
	if _, _, err := allocateResource(&slot, []int64{math.MaxInt64, 1}); !errors.Is(err, ErrNumericOverflow) || slot.Amount != math.MaxInt64 {
		t.Fatalf("allocation changed stock or accepted overflow: %+v, %v", slot, err)
	}
	slot.Amount = 0
	slot.RegenPerEpoch = math.MaxInt64
	slot.RegenRateBP = 10000
	if gain, _ := regenerateResource(&slot); gain != math.MaxInt64 || slot.Amount != math.MaxInt64 {
		t.Fatalf("regeneration did not saturate: %+v", slot)
	}

	rng := rand.New(rand.NewSource(20260303))
	for i := 0; i < 1000; i++ {
		n, rate, residual := rng.Int63(), rng.Int63n(10001), rng.Int63n(10000)
		num := new(big.Int).Mul(big.NewInt(n), big.NewInt(rate))
		num.Add(num, big.NewInt(residual))
		want, rem := new(big.Int).QuoRem(num, big.NewInt(10000), new(big.Int))
		got, gotRem, err := applyRateWithResidual(n, rate, residual)
		if err != nil || got != want.Int64() || gotRem != rem.Int64() {
			t.Fatalf("rate mismatch at %d: %d/%d %v", i, got, gotRem, err)
		}
	}
}

func TestAuditReserveAndRecallAreAtomicAtSequenceLimit(t *testing.T) {
	state := NewDefaultEcosystemState("atomic", 1)
	before := state.Clone()
	state.EventSeq = math.MaxUint64
	if _, _, err := ReserveForMaterialization(&state, "camp-thornveil-warren", "goblin-raider-pack", 1); !errors.Is(err, ErrNumericOverflow) {
		t.Fatal(err)
	}
	if free, mat := TotalEcosystemPopulation(state); mat != 0 || free != totalRegionPopulation(before.Populations, RegionValewatchVale)+totalRegionPopulation(before.Populations, RegionThornveilForest)+totalRegionPopulation(before.Populations, RegionIronfangFrontier) {
		t.Fatal("failed reservation mutated population")
	}
	state = before
	ticket, _, err := ReserveForMaterialization(&state, "camp-thornveil-warren", "goblin-raider-pack", 1)
	if err != nil {
		t.Fatal(err)
	}
	free, mat := TotalEcosystemPopulation(state)
	state.EventSeq = math.MaxUint64
	if _, _, err = ReconcileDematerialization(&state, ticket, 100, 100, false); !errors.Is(err, ErrNumericOverflow) {
		t.Fatal(err)
	}
	if afterFree, afterMat := TotalEcosystemPopulation(state); afterFree != free || afterMat != mat {
		t.Fatal("failed recall mutated population")
	}
}

func TestAuditLongReplayAndPopulationLedger(t *testing.T) {
	cfg := DefaultConfig()
	for _, seed := range []uint64{20260301, 20260302, 20260303} {
		current := NewTerritorialDisputeState("audit-long", seed)
		for epoch := 0; epoch < 700; epoch++ {
			beforeFree, beforeMat := TotalEcosystemPopulation(current)
			next, events, err := StepEpoch(current, nil, cfg)
			if err != nil {
				t.Fatalf("seed %d epoch %d: %v", seed, epoch, err)
			}
			expected := beforeFree + beforeMat
			for _, event := range events {
				switch event.Type {
				case EventPopulationGrew:
					expected += event.Amount
				case EventPopulationDeclined:
					expected -= event.Amount
				}
			}
			free, mat := TotalEcosystemPopulation(next)
			if free+mat != expected {
				t.Fatalf("seed %d epoch %d: %d != %d", seed, epoch, free+mat, expected)
			}
			if epoch%100 == 0 {
				raw, err := current.MarshalSnapshot(cfg)
				if err != nil {
					t.Fatal(err)
				}
				restored, err := UnmarshalSnapshot(raw, cfg)
				if err != nil {
					t.Fatal(err)
				}
				replay, replayedEvents, err := StepEpoch(restored, nil, cfg)
				if err != nil {
					t.Fatal(err)
				}
				want, err := next.Checksum(cfg)
				if err != nil {
					t.Fatal(err)
				}
				got, err := replay.Checksum(cfg)
				if err != nil || want != got || !slices.Equal(events, replayedEvents) {
					t.Fatalf("replay diverged at seed %d epoch %d: %v", seed, epoch, err)
				}
			}
			current = next
		}
	}
}
