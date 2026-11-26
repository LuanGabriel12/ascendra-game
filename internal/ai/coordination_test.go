package ai_test

import (
	"fmt"
	"reflect"
	"testing"

	"ascendra-game/internal/ai"
	"ascendra-game/internal/simulation"
)

// coordinateReference is the unoptimized O(G^2) reference implementation retained
// exclusively in tests to prove exact semantic equivalence with the Cycle 03
// O(G log G) spatial coordination engine across all distributions.
func coordinateReference(groups []ai.GroupSnapshot, targets []ai.PerceivedTarget, invasionActive bool) []ai.CoordinationOrder {
	orders := make([]ai.CoordinationOrder, len(groups))
	cmdrTarget := make([]ai.TargetRef, len(groups))
	for i, g := range groups {
		if g.HP <= 0 || g.State == ai.StateDead || g.Routed || g.Profile.Role != ai.RoleCommander {
			continue
		}
		if sel, ok := ai.SelectTarget(g.Position, g.HomePosition, g.Profile, targets, ai.CoordinationOrder{}, invasionActive); ok {
			cmdrTarget[i] = sel.Ref()
		}
	}

	absDiff := func(a, b int64) int64 {
		if a >= b {
			return a - b
		}
		return b - a
	}

	for i, self := range groups {
		ord := ai.CoordinationOrder{GroupID: self.GroupID, Kind: ai.OrderNone}
		if self.HP <= 0 || self.State == ai.StateDead || self.Routed {
			orders[i] = ord
			continue
		}

		bestCmdr := -1
		var bestDist int64
		for j, peer := range groups {
			if i == j || peer.HP <= 0 || peer.State == ai.StateDead || peer.Routed {
				continue
			}
			dist := absDiff(self.Position, peer.Position)
			if dist > self.Profile.AlertRange {
				continue
			}
			ord.NearbyAllies++
			if peer.Profile.Family == self.Profile.Family {
				ord.NearbySameFamily++
				if peer.State == ai.StateRetreat {
					ord.NearbyRetreating++
				}
				if peer.Profile.Role == ai.RoleCommander && peer.State != ai.StateRetreat {
					ord.MoraleAuraBP += peer.Profile.CommanderAuraBP
					if ord.MoraleAuraBP > ai.MaxCommanderAuraBP {
						ord.MoraleAuraBP = ai.MaxCommanderAuraBP
					}
					if bestCmdr < 0 || dist < bestDist || (dist == bestDist && peer.GroupID < groups[bestCmdr].GroupID) {
						bestCmdr = j
						bestDist = dist
					}
				}
			}
		}

		if bestCmdr >= 0 {
			cmdr := groups[bestCmdr]
			ord.CommanderID = cmdr.GroupID
			if self.State == ai.StateRetreat || self.MoraleBP <= self.Profile.RallyMoraleBP {
				ord.Kind = ai.OrderRally
				ord.RallyPoint = cmdr.Position
			} else if !cmdrTarget[bestCmdr].IsZero() {
				ord.Kind = ai.OrderFocusTarget
				ord.FocusTarget = cmdrTarget[bestCmdr]
				ord.TargetID = ord.FocusTarget.ID
			}
			orders[i] = ord
			continue
		}

		if self.Profile.Role == ai.RoleCommander && self.State != ai.StateRetreat {
			ord.CommanderID = self.GroupID
			if ord.NearbyRetreating > 0 {
				ord.Kind = ai.OrderRally
				ord.RallyPoint = self.Position
			} else if !cmdrTarget[i].IsZero() {
				ord.Kind = ai.OrderFocusTarget
				ord.FocusTarget = cmdrTarget[i]
				ord.TargetID = ord.FocusTarget.ID
			}
			orders[i] = ord
			continue
		}

		if self.Profile.Family == ai.FamilyGoblin && ord.NearbySameFamily >= 1 {
			var best ai.TargetRef
			var bestRatio int64 = -1
			var bestD int64
			found := false
			for _, tgt := range targets {
				if tgt.Kind != ai.TargetDefender || tgt.HP <= 0 {
					continue
				}
				d := absDiff(self.Position, tgt.Position)
				if d > self.Profile.AlertRange {
					continue
				}
				ratio := ((tgt.MaxHP - tgt.HP) * 1000) / tgt.MaxHP
				if !found || ratio > bestRatio || (ratio == bestRatio && d < bestD) || (ratio == bestRatio && d == bestD && tgt.TargetID < best.ID) {
					best = tgt.Ref()
					bestRatio = ratio
					bestD = d
					found = true
				}
			}
			if found {
				ord.Kind = ai.OrderFlankWeak
				ord.FocusTarget = best
				ord.TargetID = best.ID
			}
		} else if self.Profile.Family == ai.FamilyOrc && ord.NearbySameFamily >= 1 {
			var best ai.TargetRef
			var bestThreat int64 = -1
			var bestD int64
			found := false
			for _, tgt := range targets {
				if tgt.Kind != ai.TargetDefender || tgt.HP <= 0 {
					continue
				}
				d := absDiff(self.Position, tgt.Position)
				if d > self.Profile.AlertRange {
					continue
				}
				if !found || tgt.ThreatScore > bestThreat || (tgt.ThreatScore == bestThreat && d < bestD) || (tgt.ThreatScore == bestThreat && d == bestD && tgt.TargetID < best.ID) {
					best = tgt.Ref()
					bestThreat = tgt.ThreatScore
					bestD = d
					found = true
				}
			}
			if found {
				ord.Kind = ai.OrderFocusTarget
				ord.FocusTarget = best
				ord.TargetID = best.ID
			}
		}
		orders[i] = ord
	}
	return orders
}

func buildSpatialDataset(n int, distribution string) ([]ai.GroupSnapshot, []ai.PerceivedTarget) {
	profiles := ai.DefaultProfileCatalog()
	rng := simulation.NewDeterministicRNG(202603)
	groups := make([]ai.GroupSnapshot, n)
	for i := 0; i < n; i++ {
		prof := profiles[i%len(profiles)]
		var pos int64
		switch distribution {
		case "dense":
			pos = 12000 // Worst case: all G groups stacked on exact same 1D coordinate
		case "sparse":
			pos = int64(i) * 15000 // Spread wider than AlertRange
		default: // "uniform"
			pos = rng.Int64N(60000)
		}
		state := ai.StateAdvance
		morale := prof.InitialMoraleBP
		if i%11 == 0 {
			state = ai.StateRetreat
			morale = prof.BreakMoraleBP
		}
		if i%19 == 0 {
			state = ai.StateDead
		}
		hp := prof.BaseHP
		if state == ai.StateDead {
			hp = 0
		}
		groups[i] = ai.GroupSnapshot{
			GroupID:      fmt.Sprintf("group-%05d", i),
			Profile:      prof,
			State:        state,
			Position:     pos,
			HomePosition: pos,
			HP:           hp,
			MaxHP:        prof.BaseHP,
			MoraleBP:     morale,
		}
	}
	targets := []ai.PerceivedTarget{
		{TargetID: "settlement-valewatch", Kind: ai.TargetSettlement, Position: 0, HP: 1000, MaxHP: 1000},
		{TargetID: "defender-1", Kind: ai.TargetDefender, Position: 4000, HP: 120, MaxHP: 300, ThreatScore: 500},
		{TargetID: "defender-2", Kind: ai.TargetDefender, Position: 12000, HP: 280, MaxHP: 300, ThreatScore: 900},
		{TargetID: "defender-3", Kind: ai.TargetDefender, Position: 28000, HP: 80, MaxHP: 300, ThreatScore: 200},
	}
	return groups, targets
}

func TestCoordinateOptimizedMatchesReferenceAcrossDistributions(t *testing.T) {
	for _, dist := range []string{"uniform", "sparse", "dense"} {
		for _, n := range []int{1, 12, 80} {
			t.Run(fmt.Sprintf("%s_%d", dist, n), func(t *testing.T) {
				groups, targets := buildSpatialDataset(n, dist)
				got, err := ai.Coordinate(groups, targets, true)
				if err != nil {
					t.Fatalf("Coordinate failed: %v", err)
				}
				want := coordinateReference(groups, targets, true)
				if !reflect.DeepEqual(got, want) {
					for i := range got {
						if got[i] != want[i] {
							t.Fatalf("mismatch at index %d (%s):\n got=%+v\nwant=%+v", i, groups[i].GroupID, got[i], want[i])
						}
					}
				}
			})
		}
	}
}

func TestTypedTargetIdentityPreventsSettlementDefenderCollision(t *testing.T) {
	orc := mustProfile(t, "orc-vanguard")
	// Settlement and Defender intentionally share identical textual ID "valewatch".
	targets := []ai.PerceivedTarget{
		{TargetID: "valewatch", Kind: ai.TargetSettlement, Position: 0, HP: 1000, MaxHP: 1000, ThreatScore: 0},
		{TargetID: "valewatch", Kind: ai.TargetDefender, Position: 1500, HP: 250, MaxHP: 300, ThreatScore: 900},
	}
	order := ai.CoordinationOrder{
		Kind:        ai.OrderFocusTarget,
		FocusTarget: ai.TargetRef{Kind: ai.TargetDefender, ID: "valewatch"},
		TargetID:    "valewatch",
	}
	sel, ok := ai.SelectTarget(3000, 10000, orc, targets, order, true)
	if !ok || sel.Kind != ai.TargetDefender || sel.TargetID != "valewatch" {
		t.Fatalf("expected typed match on Defender valewatch, got ok=%v sel=%+v", ok, sel)
	}

	// Verify commander focus on Settlement does NOT match Defender of same name.
	orderSettle := ai.CoordinationOrder{
		Kind:        ai.OrderFocusTarget,
		FocusTarget: ai.TargetRef{Kind: ai.TargetSettlement, ID: "valewatch"},
		TargetID:    "valewatch",
	}
	sel2, ok := ai.SelectTarget(3000, 10000, orc, targets, orderSettle, true)
	if !ok || sel2.Kind != ai.TargetSettlement {
		t.Fatalf("expected typed match on Settlement valewatch, got ok=%v sel=%+v", ok, sel2)
	}
}

func TestOrcBerserkerProfileAndCommanderFallenShock(t *testing.T) {
	berserker := mustProfile(t, "orc-berserker")
	if berserker.Family != ai.FamilyOrc || berserker.BreakMoraleBP >= 1000 || berserker.BaseDamage <= 95 {
		t.Fatalf("unexpected orc-berserker profile: %+v", berserker)
	}

	goblin := mustProfile(t, "goblin-raider-pack")
	rng := simulation.NewDeterministicRNG(99)
	p := ai.Perception{
		Tick:                 15,
		GroupID:              "g-1",
		CurrentState:         ai.StateAttack,
		HP:                   320,
		MaxHP:                400,
		DistanceToSettlement: 1500,
		HomePosition:         10000,
		InvasionActive:       true,
		SettlementAlive:      true,
		Profile:              goblin,
		MoraleBP:             4000,
		CommanderFallenShock: true,
	}
	dec, err := ai.Evaluate(p, &rng)
	if err != nil {
		t.Fatalf("Evaluate with CommanderFallenShock failed: %v", err)
	}
	if dec.NextState != ai.StateRetreat || dec.NewMoraleBP >= 3000 {
		t.Fatalf("expected commander death shock to break goblin morale into Retreat, got %+v", dec)
	}
}

func TestTargetRetentionMemoryPreventsFlickering(t *testing.T) {
	orc := mustProfile(t, "orc-vanguard")
	targets := []ai.PerceivedTarget{
		{TargetID: "def-a", Kind: ai.TargetDefender, Position: 3000, HP: 250, MaxHP: 300, ThreatScore: 400},
		{TargetID: "def-b", Kind: ai.TargetDefender, Position: 2950, HP: 250, MaxHP: 300, ThreatScore: 410},
	}
	// Without memory, def-b slightly edges out def-a.
	selNoMem, _ := ai.SelectTarget(5000, 10000, orc, targets, ai.CoordinationOrder{}, true)
	if selNoMem.TargetID != "def-b" {
		t.Fatalf("expected def-b without memory, got %+v", selNoMem)
	}
	// With active memory retaining def-a, hysteresis retains def-a.
	selMem, _ := ai.SelectTargetWithMemory(5000, 10000, orc, targets, ai.CoordinationOrder{}, true, ai.TargetMemoryOptions{
		RetainedTarget: ai.TargetRef{Kind: ai.TargetDefender, ID: "def-a"},
		RetentionBonus: 750,
	})
	if selMem.TargetID != "def-a" {
		t.Fatalf("expected retention memory to keep def-a, got %+v", selMem)
	}
}

func TestAIValidationBoundariesAndPatrolHomeClamping(t *testing.T) {
	rng := simulation.NewDeterministicRNG(42)
	goblin := mustProfile(t, "goblin-skirmisher")

	// Patrol near edge of territory bounces cleanly without exiting TerritoryRadius or going < 0.
	pEdge := ai.Perception{
		Tick:                 1,
		GroupID:              "g-edge",
		CurrentState:         ai.StatePatrol,
		HP:                   goblin.BaseHP,
		MaxHP:                goblin.BaseHP,
		DistanceToSettlement: 100,
		HomePosition:         200,
		Profile:              goblin,
		MoraleBP:             goblin.InitialMoraleBP,
	}
	for tick := uint64(1); tick <= 30; tick++ {
		pEdge.Tick = tick
		dec, err := ai.Evaluate(pEdge, &rng)
		if err != nil {
			t.Fatalf("patrol tick %d failed: %v", tick, err)
		}
		pEdge.DistanceToSettlement += dec.MoveDelta
		if pEdge.DistanceToSettlement < 0 {
			t.Fatalf("patrol moved negative: %d", pEdge.DistanceToSettlement)
		}
		pEdge.CurrentState = dec.NextState
		pEdge.MoraleBP = dec.NewMoraleBP
	}

	// Validation rejection checks for Perception, TargetRef, PerceivedTarget, and Profile.
	badTarget := ai.PerceivedTarget{TargetID: "t1", Kind: ai.TargetDefender, Position: -1, HP: 10, MaxHP: 10}
	if err := badTarget.Validate(); err == nil {
		t.Fatal("expected error for negative target position")
	}
	badTarget2 := ai.PerceivedTarget{TargetID: "", Kind: ai.TargetDefender, Position: 0, HP: 10, MaxHP: 10}
	if err := badTarget2.Validate(); err == nil {
		t.Fatal("expected error for empty target_id")
	}
	badTarget3 := ai.PerceivedTarget{TargetID: "t1", Kind: ai.TargetDefender, Position: 0, HP: 20, MaxHP: 10}
	if err := badTarget3.Validate(); err == nil {
		t.Fatal("expected error for hp > max_hp")
	}
	badTarget4 := ai.PerceivedTarget{TargetID: "t1", Kind: ai.TargetDefender, Position: 0, HP: 10, MaxHP: 10, ThreatScore: -1}
	if err := badTarget4.Validate(); err == nil {
		t.Fatal("expected error for negative threat score")
	}
	if (ai.TargetRef{Kind: ai.TargetDefender, ID: ""}).Valid() {
		t.Fatal("TargetRef with kind but empty ID must be invalid")
	}
	badP := pEdge
	badP.MoraleBP = 10001
	if _, err := ai.Evaluate(badP, &rng); err == nil {
		t.Fatal("expected error for morale > 10000")
	}
	badP = pEdge
	badP.RecentDamageTaken = -1
	if _, err := ai.Evaluate(badP, &rng); err == nil {
		t.Fatal("expected error for negative recent damage")
	}
	badP = pEdge
	badP.TargetMemoryTicks = -1
	if _, err := ai.Evaluate(badP, &rng); err == nil {
		t.Fatal("expected error for negative target memory ticks")
	}
	badP = pEdge
	badP.HomePosition = -5
	if _, err := ai.Evaluate(badP, &rng); err == nil {
		t.Fatal("expected error for negative home position")
	}

	// Profile.Validate checks.
	for _, mod := range []func(*ai.Profile){
		func(p *ai.Profile) { p.Archetype = "" },
		func(p *ai.Profile) { p.Family = "undead" },
		func(p *ai.Profile) { p.Role = "wizard" },
		func(p *ai.Profile) { p.BaseHP = 0 },
		func(p *ai.Profile) { p.VisionRange = 0 },
		func(p *ai.Profile) { p.InitialMoraleBP = 20000 },
		func(p *ai.Profile) { p.BreakMoraleBP = 10000 },
		func(p *ai.Profile) { p.RetreatHPThresholdBP = -1 },
		func(p *ai.Profile) { p.PackMoraleBonusBP = -1 },
		func(p *ai.Profile) { p.ReinforceTriggerHPBP = 10001 },
		func(p *ai.Profile) { p.ReinforceCooldownTicks = -1 },
		func(p *ai.Profile) { p.WeightLowHP = -1 },
	} {
		pr := goblin
		mod(&pr)
		if err := pr.Validate(); err == nil {
			t.Fatalf("expected Profile.Validate error for mutated profile %+v", pr)
		}
	}
}

func BenchmarkCoordinateSpatialDistributions(b *testing.B) {
	for _, dist := range []string{"uniform", "sparse", "dense"} {
		for _, n := range []int{100, 1000, 10000} {
			b.Run(fmt.Sprintf("%s_%d", dist, n), func(b *testing.B) {
				groups, targets := buildSpatialDataset(n, dist)
				b.ReportAllocs()
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					if _, err := ai.Coordinate(groups, targets, true); err != nil {
						b.Fatal(err)
					}
				}
			})
		}
	}
}
