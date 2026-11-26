package world_test

import (
	"fmt"
	"testing"

	"ascendra-game/internal/adapters/memory"
	"ascendra-game/internal/ai"
	"ascendra-game/internal/world"
)

func mustInitialStateForBenchmark(b *testing.B) world.WorldState {
	b.Helper()
	reader, err := memory.NewSettlementReader(memory.DefaultSettlementFixtures()...)
	if err != nil {
		b.Fatal(err)
	}
	st, err := world.NewWorldState("bench-scaling", "settlement-valewatch", 1, reader)
	if err != nil {
		b.Fatal(err)
	}
	return st
}

func BenchmarkCycle2Scaling(b *testing.B) {
	for _, n := range []int{100, 1000, 10000} {
		b.Run(fmt.Sprintf("groups_%d", n), func(b *testing.B) {
			cfg := world.DefaultConfig()
			cfg.MaxActiveGroups = n
			cfg.MaxReinforcementWaves = 0
			st := mustInitialStateForBenchmark(b)
			var err error
			st, _, err = world.Step(st, []world.Command{{Kind: world.CmdSpawnHostileGroup, Tick: 1, GroupID: "template", Archetype: "goblin-skirmisher", Count: 1}}, cfg)
			if err != nil {
				b.Fatal(err)
			}
			template := st.Groups[0]
			st.Groups = make([]world.CreatureGroup, n)
			profile, err := ai.LookupProfile(template.Archetype)
			if err != nil {
				b.Fatal(err)
			}
			peers := make([]ai.GroupSnapshot, n)
			for i := range st.Groups {
				g := template
				g.GroupID = fmt.Sprintf("group-%05d", i)
				st.Groups[i] = g
				peers[i] = ai.GroupSnapshot{GroupID: g.GroupID, Profile: profile, State: g.State, Position: g.DistanceToSettlement, HomePosition: g.HomePosition, HP: g.HP, MaxHP: g.MaxHP, MoraleBP: g.MoraleBP}
			}
			targets := []ai.PerceivedTarget{{TargetID: "defender", Kind: ai.TargetDefender, Position: 1000, HP: 100, MaxHP: 100}}
			raw, err := st.MarshalSnapshot()
			if err != nil {
				b.Fatal(err)
			}
			b.Run("coordinate", func(b *testing.B) {
				b.ReportAllocs()
				for i := 0; i < b.N; i++ {
					if _, err := ai.Coordinate(peers, targets, true); err != nil {
						b.Fatal(err)
					}
				}
			})
			b.Run("target", func(b *testing.B) {
				b.ReportAllocs()
				for i := 0; i < b.N; i++ {
					for range peers {
						ai.SelectTarget(12000, 12000, profile, targets, ai.CoordinationOrder{}, true)
					}
				}
			})
			b.Run("step", func(b *testing.B) {
				b.ReportAllocs()
				for i := 0; i < b.N; i++ {
					if _, _, err := world.Step(st, nil, cfg); err != nil {
						b.Fatal(err)
					}
				}
			})
			b.Run("checksum", func(b *testing.B) {
				b.ReportAllocs()
				for i := 0; i < b.N; i++ {
					if _, err := st.Checksum(); err != nil {
						b.Fatal(err)
					}
				}
			})
			b.Run("snapshot_decode", func(b *testing.B) {
				b.ReportAllocs()
				for i := 0; i < b.N; i++ {
					if _, err := world.UnmarshalSnapshot(raw); err != nil {
						b.Fatal(err)
					}
				}
			})
			b.Run("snapshot_encode", func(b *testing.B) {
				b.ReportAllocs()
				for i := 0; i < b.N; i++ {
					if _, err := st.MarshalSnapshot(); err != nil {
						b.Fatal(err)
					}
				}
			})
		})
	}
}
