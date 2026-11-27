package siege_test

import (
	"testing"

	"ascendra-game/internal/ai"
	"ascendra-game/internal/siege"
)

func FuzzSiegeStructuresRepairAndZones(f *testing.F) {
	f.Add([]byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11})
	f.Add([]byte{50, 99, 12, 200, 1, 0, 255, 44, 77, 88})
	f.Add([]byte{255, 255, 255, 0, 0, 1, 2, 3})

	cfg := siege.DefaultConfig()
	layout := siege.DefaultValewatchLayout()
	structIDs := []string{
		siege.StructIDMainGate,
		siege.StructIDOuterWall,
		siege.StructIDNorthTower,
		siege.StructIDSupplyDepot,
		siege.StructIDCitadelKeep,
	}
	zoneIDs := []string{
		siege.ZoneIDExteriorField,
		siege.ZoneIDWallApproach,
		siege.ZoneIDMainGate,
		siege.ZoneIDOuterDistrict,
		siege.ZoneIDSupplyDistrict,
		siege.ZoneIDCivilDistrict,
		siege.ZoneIDCentralSquare,
		siege.ZoneIDCitadel,
	}

	f.Fuzz(func(t *testing.T, ops []byte) {
		st, err := siege.NewSiegeStateFromLayout(layout, cfg, "cmp-fuzz", "fac-fuzz", ai.FamilyOrc, false, 1)
		if err != nil {
			t.Fatalf("init layout: %v", err)
		}
		tick := uint64(1)
		for i := 0; i+2 < len(ops) && i < 120; i += 3 {
			tick++
			op := ops[i] % 6
			a := int(ops[i+1])
			b := int(ops[i+2])
			switch op {
			case 0: // Damage structure
				sid := structIDs[a%len(structIDs)]
				raw := int64((b % 180) + 1)
				_, _, _, _, _ = siege.ApplyStructureDamage(&st, sid, raw, 12000, tick, cfg)
			case 1: // Repair structure
				sid := structIDs[a%len(structIDs)]
				zid := zoneIDs[b%len(zoneIDs)]
				_, _, _ = siege.ApplyStructureRepair(&st, sid, "eng-fuzz", zid, tick, cfg)
			case 2: // Tick supply regen
				_ = siege.TickSupplyRegen(&st, tick, cfg)
			case 3: // Evaluate districts
				invZone := zoneIDs[a%len(zoneIDs)]
				defZone := zoneIDs[b%len(zoneIDs)]
				combatants := []siege.CombatantSnapshot{
					{ID: "inv-1", ZoneID: invZone, HP: 200, MaxHP: 400, MoraleBP: 7000, Family: ai.FamilyOrc, IsInvader: true},
					{ID: "def-1", ZoneID: defZone, HP: 200, MaxHP: 300, IsInvader: false},
				}
				siege.EvaluateDistricts(&st, combatants, tick, cfg)
			case 4: // Evaluate objectives & traversal queries
				invZone := zoneIDs[a%len(zoneIDs)]
				dstZone := zoneIDs[b%len(zoneIDs)]
				_ = siege.CanTraverse(st, invZone, dstZone, true)
				_, _ = siege.NextStepToward(st, invZone, dstZone, true)
				siege.EvaluateObjectives(&st, nil, tick)
			case 5: // Phase evaluation
				combatants := []siege.CombatantSnapshot{
					{ID: "inv-1", ZoneID: zoneIDs[a%len(zoneIDs)], HP: 200, MaxHP: 400, MoraleBP: int64((b%100)*100), Family: ai.FamilyOrc, IsInvader: true},
				}
				_, _, _, _, _ = siege.EvaluatePhaseAndResolution(&st, combatants, tick, true, cfg)
			}
			// Hard invariants must hold after EVERY operation.
			if err := st.ValidateWithConfig(cfg); err != nil {
				t.Fatalf("siege invariant violated at op %d (tick %d): %v", i, tick, err)
			}
			for _, s := range st.Structures {
				if s.HP < 0 || s.HP > s.MaxHP {
					t.Fatalf("structure %s HP out of bounds: %d/%d", s.StructureID, s.HP, s.MaxHP)
				}
			}
			if st.Supplies.Current < 0 || st.Supplies.Current > st.Supplies.Max || st.Supplies.TotalRegenerated > st.Supplies.MaxTotalRegen {
				t.Fatalf("supply invariant broken: %+v", st.Supplies)
			}
		}
		if _, err := st.Checksum(cfg); err != nil {
			t.Fatalf("final checksum failed: %v", err)
		}
	})
}

func FuzzSiegeLayoutValidation(f *testing.F) {
	f.Add(uint8(0), uint8(1), int64(100), int64(2000))
	f.Add(uint8(3), uint8(3), int64(-10), int64(9000))

	cfg := siege.DefaultConfig()
	f.Fuzz(func(t *testing.T, fromIdx, toIdx uint8, hp, resist int64) {
		layout := siege.DefaultValewatchLayout()
		if len(layout.Zones) > 0 {
			fZone := layout.Zones[int(fromIdx)%len(layout.Zones)].ZoneID
			tZone := layout.Zones[int(toIdx)%len(layout.Zones)].ZoneID
			layout.Connections[0].FromZoneID = fZone
			layout.Connections[0].ToZoneID = tZone
		}
		layout.Structures[0].HP = hp
		layout.Structures[0].ResistanceBP = resist
		// Must never panic; must cleanly validate or return structured error.
		_ = siege.ValidateLayout(layout, cfg)
	})
}

func BenchmarkSiegeValidateLayout(b *testing.B) {
	cfg := siege.DefaultConfig()
	layout := siege.DefaultValewatchLayout()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := siege.ValidateLayout(layout, cfg); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkSiegeZoneQueries(b *testing.B) {
	cfg := siege.DefaultConfig()
	layout := siege.DefaultValewatchLayout()
	st, err := siege.NewSiegeStateFromLayout(layout, cfg, "cmp-bench", "fac-bench", ai.FamilyOrc, false, 1)
	if err != nil {
		b.Fatal(err)
	}
	// Breach wall so BFS spans the full settlement graph.
	st.Structures[st.FindStructureIndex(siege.StructIDOuterWall)].State = siege.StructureBreached
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, ok := siege.NextStepToward(st, siege.ZoneIDExteriorField, siege.ZoneIDCitadel, true); !ok {
			b.Fatal("expected path")
		}
		_ = siege.ZoneHopDistance(st, siege.ZoneIDMainGate, siege.ZoneIDCitadel)
	}
}

func BenchmarkSiegeObjectiveAndDistrictEvaluation(b *testing.B) {
	cfg := siege.DefaultConfig()
	layout := siege.DefaultValewatchLayout()
	base, err := siege.NewSiegeStateFromLayout(layout, cfg, "cmp-bench", "fac-bench", ai.FamilyOrc, false, 1)
	if err != nil {
		b.Fatal(err)
	}
	base.Structures[base.FindStructureIndex(siege.StructIDMainGate)].HP = 0
	base.Structures[base.FindStructureIndex(siege.StructIDMainGate)].State = siege.StructureDestroyed
	combatants := []siege.CombatantSnapshot{
		{ID: "inv-1", ZoneID: siege.ZoneIDOuterDistrict, HP: 300, MaxHP: 400, MoraleBP: 8000, Family: ai.FamilyOrc, IsInvader: true},
		{ID: "def-1", ZoneID: siege.ZoneIDCentralSquare, HP: 250, MaxHP: 300, IsInvader: false},
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		st := base.Clone()
		siege.EvaluateDistricts(st, combatants, 20, cfg)
		siege.EvaluateObjectives(st, combatants, 20)
	}
}

func BenchmarkSiegeStructureDamageAndRepair(b *testing.B) {
	cfg := siege.DefaultConfig()
	layout := siege.DefaultValewatchLayout()
	base, err := siege.NewSiegeStateFromLayout(layout, cfg, "cmp-bench", "fac-bench", ai.FamilyOrc, false, 1)
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		st := base.Clone()
		if _, _, _, _, err := siege.ApplyStructureDamage(st, siege.StructIDMainGate, 90, 12500, 10, cfg); err != nil {
			b.Fatal(err)
		}
		if _, _, err := siege.ApplyStructureRepair(st, siege.StructIDMainGate, "eng-1", siege.ZoneIDMainGate, 11, cfg); err != nil {
			b.Fatal(err)
		}
	}
}
