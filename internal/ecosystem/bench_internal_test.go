package ecosystem

import (
	"context"
	"testing"
)

// Internal white-box subsystem benchmarks (Section 27): separately measures resource consumption/regen,
// population growth/mortality, two-phase migration, territorial competition, and regional threat.
func BenchmarkEcosystemSubsystems(b *testing.B) {
	cfg := DefaultConfig()
	base := NewTerritorialDisputeState("bench-sub", 42)
	res, err := RunEpochs(context.Background(), base, nil, 5, cfg, 16)
	if err != nil {
		b.Fatal(err)
	}
	mid := res.FinalState

	b.Run("resources", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			st := mid.Clone()
			evs := make([]EcologicalEvent, 0, 8)
			if err := processResources(&st, &evs); err != nil {
				b.Fatal(err)
			}
		}
	})

	b.Run("populations", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			st := mid.Clone()
			evs := make([]EcologicalEvent, 0, 8)
			if err := processPopulations(&st, cfg, &evs); err != nil {
				b.Fatal(err)
			}
		}
	})

	b.Run("migration", func(b *testing.B) {
		scarcity := NewScarcityMigrationState("bench-mig", 42)
		for i := range scarcity.Populations {
			scarcity.Populations[i].MigrationPressureBP = 8000
		}
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			st := scarcity.Clone()
			evs := make([]EcologicalEvent, 0, 8)
			if err := processMigration(&st, cfg, &evs); err != nil {
				b.Fatal(err)
			}
		}
	})

	b.Run("territory", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			st := mid.Clone()
			evs := make([]EcologicalEvent, 0, 8)
			if err := processTerritory(&st, cfg, &evs); err != nil {
				b.Fatal(err)
			}
		}
	})

	b.Run("threat", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			st := mid.Clone()
			evs := make([]EcologicalEvent, 0, 8)
			if err := processRegionalThreat(&st, cfg, &evs); err != nil {
				b.Fatal(err)
			}
		}
	})
}
