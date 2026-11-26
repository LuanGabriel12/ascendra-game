package ai_test

import (
	"errors"
	"testing"

	"ascendra-game/internal/ai"
	"ascendra-game/internal/simulation"
)

func mustProfile(t *testing.T, archetype string) ai.Profile {
	t.Helper()
	p, err := ai.LookupProfile(archetype)
	if err != nil {
		t.Fatalf("LookupProfile(%q) failed: %v", archetype, err)
	}
	return p
}

func TestProfileCatalogGoblinAndOrcDifferentiation(t *testing.T) {
	catalog := ai.DefaultProfileCatalog()
	if len(catalog) < 5 {
		t.Fatalf("expected at least 5 goblin/orc profiles, got %d", len(catalog))
	}
	for i, p := range catalog {
		if err := p.Validate(); err != nil {
			t.Fatalf("profile %q invalid: %v", p.Archetype, err)
		}
		if i > 0 && catalog[i-1].Archetype >= p.Archetype {
			t.Fatalf("profile catalog not strictly sorted: %q >= %q", catalog[i-1].Archetype, p.Archetype)
		}
	}

	goblin := mustProfile(t, "goblin-skirmisher")
	orc := mustProfile(t, "orc-vanguard")

	if goblin.Family != ai.FamilyGoblin || orc.Family != ai.FamilyOrc {
		t.Fatalf("unexpected families: goblin=%s orc=%s", goblin.Family, orc.Family)
	}
	if goblin.MoveSpeedPerTick <= orc.MoveSpeedPerTick {
		t.Fatalf("expected goblin skirmisher faster than orc vanguard")
	}
	if goblin.BaseHP >= orc.BaseHP {
		t.Fatalf("expected orc vanguard tougher than goblin skirmisher")
	}
	if goblin.InitialMoraleBP >= orc.InitialMoraleBP || goblin.BreakMoraleBP <= orc.BreakMoraleBP {
		t.Fatalf("expected orc vanguard higher morale resilience than goblin skirmisher")
	}
	if goblin.WeightLowHP <= orc.WeightLowHP || orc.WeightThreat <= goblin.WeightThreat {
		t.Fatalf("expected goblin to prioritize low HP and orc to prioritize threat")
	}

	// Alias compatibility for Cycle 01 naming.
	alias, err := ai.LookupProfile("goblin-skirmishers")
	if err != nil || alias.Archetype != "goblin-skirmisher" {
		t.Fatalf("expected alias goblin-skirmishers -> goblin-skirmisher, got %+v err=%v", alias, err)
	}

	if _, err := ai.LookupProfile("dragon-lord-unknown"); !errors.Is(err, ai.ErrUnknownProfile) {
		t.Fatalf("expected ErrUnknownProfile, got %v", err)
	}
}

func TestTargetSelectionGoblinVsOrcAndDeterministicTieBreak(t *testing.T) {
	goblin := mustProfile(t, "goblin-skirmisher")
	orc := mustProfile(t, "orc-vanguard")

	targets := []ai.PerceivedTarget{
		{
			TargetID:    "defender-tank",
			Kind:        ai.TargetDefender,
			Position:    3000,
			HP:          300,
			MaxHP:       300, // Full HP, very high threat
			ThreatScore: 950,
		},
		{
			TargetID:    "defender-wounded",
			Kind:        ai.TargetDefender,
			Position:    3200,
			HP:          45,
			MaxHP:       300, // Heavily wounded, low threat
			ThreatScore: 50,
		},
		{
			TargetID:    "defender-out-of-vision",
			Kind:        ai.TargetDefender,
			Position:    19500, // Beyond VisionRange from pos 5000
			HP:          10,
			MaxHP:       300,
			ThreatScore: 1000,
		},
	}

	selGoblin, ok := ai.SelectTarget(5000, 5000, goblin, targets, ai.CoordinationOrder{}, true)
	if !ok || selGoblin.TargetID != "defender-wounded" {
		t.Fatalf("expected goblin to opportunistically pick wounded target, got ok=%v sel=%+v", ok, selGoblin)
	}

	selOrc, ok := ai.SelectTarget(5000, 5000, orc, targets, ai.CoordinationOrder{}, true)
	if !ok || selOrc.TargetID != "defender-tank" {
		t.Fatalf("expected orc to confront high-threat defender, got ok=%v sel=%+v", ok, selOrc)
	}

	// Deterministic tie-breaking: identical stats & distance -> lexicographically smallest TargetID.
	tiedTargets := []ai.PerceivedTarget{
		{TargetID: "defender-z", Kind: ai.TargetDefender, Position: 4000, HP: 200, MaxHP: 200, ThreatScore: 100},
		{TargetID: "defender-a", Kind: ai.TargetDefender, Position: 4000, HP: 200, MaxHP: 200, ThreatScore: 100},
	}
	selTie, ok := ai.SelectTarget(5000, 5000, orc, tiedTargets, ai.CoordinationOrder{}, true)
	if !ok || selTie.TargetID != "defender-a" {
		t.Fatalf("expected deterministic lexicographical tie-break to defender-a, got %+v", selTie)
	}
}

func TestCollectiveCoordinationCommanderFocusRallyAndPackFlank(t *testing.T) {
	warchief := mustProfile(t, "orc-warchief")
	vanguard := mustProfile(t, "orc-vanguard")
	goblinA := mustProfile(t, "goblin-raider-pack")
	goblinB := mustProfile(t, "goblin-skirmisher")

	targets := []ai.PerceivedTarget{
		{TargetID: "defender-alpha", Kind: ai.TargetDefender, Position: 2000, HP: 300, MaxHP: 300, ThreatScore: 900},
		{TargetID: "defender-beta", Kind: ai.TargetDefender, Position: 2500, HP: 60, MaxHP: 300, ThreatScore: 80},
	}

	// Strictly sorted by GroupID.
	groups := []ai.GroupSnapshot{
		{GroupID: "g-goblin-1", Profile: goblinA, State: ai.StateAdvance, Position: 4500, HomePosition: 10000, HP: 380, MaxHP: 400, MoraleBP: 6200},
		{GroupID: "g-goblin-2", Profile: goblinB, State: ai.StateAdvance, Position: 5000, HomePosition: 10000, HP: 300, MaxHP: 320, MoraleBP: 5600},
		{GroupID: "g-orc-1-vanguard", Profile: vanguard, State: ai.StateAdvance, Position: 4200, HomePosition: 10000, HP: 500, MaxHP: 550, MoraleBP: 7800},
		{GroupID: "g-orc-2-shaken", Profile: vanguard, State: ai.StateRetreat, Position: 6000, HomePosition: 10000, HP: 350, MaxHP: 550, MoraleBP: 3000},
		{GroupID: "g-orc-3-warchief", Profile: warchief, State: ai.StateAdvance, Position: 4800, HomePosition: 10000, HP: 780, MaxHP: 780, MoraleBP: 9200},
	}

	orders, err := ai.Coordinate(groups, targets, true)
	if err != nil {
		t.Fatalf("Coordinate failed: %v", err)
	}

	// Goblin pack without commander coordinates OrderFlankWeak on wounded defender-beta.
	if orders[0].Kind != ai.OrderFlankWeak || orders[0].TargetID != "defender-beta" {
		t.Fatalf("expected goblin pack to flank weakest defender-beta, got %+v", orders[0])
	}

	// Healthy orc vanguard receives Commander FocusTarget + MoraleAuraBP from orc-warchief.
	if orders[2].Kind != ai.OrderFocusTarget || orders[2].CommanderID != "g-orc-3-warchief" || orders[2].TargetID != "defender-alpha" {
		t.Fatalf("expected healthy orc vanguard to inherit warchief FocusTarget defender-alpha, got %+v", orders[2])
	}
	if orders[2].MoraleAuraBP != warchief.CommanderAuraBP {
		t.Fatalf("expected morale aura %d, got %d", warchief.CommanderAuraBP, orders[2].MoraleAuraBP)
	}

	// Retreating orc vanguard receives OrderRally toward warchief position.
	if orders[3].Kind != ai.OrderRally || orders[3].RallyPoint != 4800 {
		t.Fatalf("expected shaken orc to receive OrderRally toward 4800, got %+v", orders[3])
	}

	// Unsorted input groups must be rejected explicitly.
	unsorted := []ai.GroupSnapshot{groups[1], groups[0]}
	if _, err := ai.Coordinate(unsorted, targets, true); !errors.Is(err, ai.ErrInvalidPerception) {
		t.Fatalf("expected ErrInvalidPerception for unsorted groups, got %v", err)
	}
}

func TestMoraleBreakAndRallyHysteresis(t *testing.T) {
	vanguard := mustProfile(t, "orc-vanguard")
	rng := simulation.NewDeterministicRNG(101)

	// 1. Massive hit drops morale below BreakMoraleBP -> StateRetreat.
	p := ai.Perception{
		Tick:                 10,
		GroupID:              "orc-1",
		CurrentState:         ai.StateAttack,
		HP:                   200,
		MaxHP:                550,
		DistanceToSettlement: 2000,
		HomePosition:         10000,
		InvasionActive:       true,
		SettlementAlive:      true,
		Profile:              vanguard,
		MoraleBP:             2000,
		RecentDamageTaken:    250,
	}
	dBreak, err := ai.Evaluate(p, &rng)
	if err != nil {
		t.Fatalf("Evaluate break failed: %v", err)
	}
	if dBreak.NextState != ai.StateRetreat || dBreak.Action != ai.ActionRetreatStep {
		t.Fatalf("expected break into StateRetreat, got %+v", dBreak)
	}

	// 2. Hysteresis: while retreating at morale between BreakMoraleBP (1600) and RallyMoraleBP (3600),
	// stays in StateRetreat (no ping-pong oscillation).
	p.CurrentState = ai.StateRetreat
	p.RecentDamageTaken = 0
	p.MoraleBP = 2600
	dHoldRetreat, err := ai.Evaluate(p, &rng)
	if err != nil {
		t.Fatalf("Evaluate hysteresis failed: %v", err)
	}
	if dHoldRetreat.NextState != ai.StateRetreat {
		t.Fatalf("expected hysteresis to keep StateRetreat below RallyMoraleBP, got %+v", dHoldRetreat)
	}

	// 3. Commander rally aura raises morale >= RallyMoraleBP -> transitions to StateRally.
	p.MoraleBP = 3400
	p.Order = ai.CoordinationOrder{
		Kind:             ai.OrderRally,
		CommanderID:      "orc-warchief-1",
		RallyPoint:       5000,
		MoraleAuraBP:     1600,
		NearbySameFamily: 1,
	}
	dRally, err := ai.Evaluate(p, &rng)
	if err != nil {
		t.Fatalf("Evaluate rally failed: %v", err)
	}
	if dRally.NextState != ai.StateRally || dRally.Action != ai.ActionRallyStep {
		t.Fatalf("expected StateRally under commander rally order, got %+v", dRally)
	}
}

func TestTerritorialIntrusionAndLeashReturn(t *testing.T) {
	raider := mustProfile(t, "goblin-raider-pack")
	rng := simulation.NewDeterministicRNG(55)

	// 1. Outside active invasion, intruder enters territory -> group engages intruder.
	p := ai.Perception{
		Tick:                 5,
		GroupID:              "goblin-guard",
		CurrentState:         ai.StatePatrol,
		HP:                   400,
		MaxHP:                400,
		DistanceToSettlement: 12000,
		HomePosition:         12000,
		InvasionActive:       false,
		SettlementAlive:      true,
		Profile:              raider,
		MoraleBP:             6200,
		Targets: []ai.PerceivedTarget{
			{TargetID: "intruder-1", Kind: ai.TargetDefender, Position: 10000, HP: 250, MaxHP: 300, ThreatScore: 100},
		},
	}
	dEngage, err := ai.Evaluate(p, &rng)
	if err != nil {
		t.Fatalf("Evaluate territorial engage failed: %v", err)
	}
	if dEngage.NextState != ai.StateAdvance || dEngage.TargetID != "intruder-1" || !dEngage.TerritoryTriggered {
		t.Fatalf("expected territorial engagement on intruder-1, got %+v", dEngage)
	}

	// 2. Pulled past LeashRadius (7500) from HomePosition (12000 -> pos 3500, dist 8500) -> StateReturnHome.
	p.DistanceToSettlement = 3500
	p.CurrentState = ai.StateAdvance
	dLeash, err := ai.Evaluate(p, &rng)
	if err != nil {
		t.Fatalf("Evaluate leash return failed: %v", err)
	}
	if dLeash.NextState != ai.StateReturnHome || dLeash.Action != ai.ActionReturnHome || dLeash.MoveDelta <= 0 || !dLeash.TerritoryTriggered {
		t.Fatalf("expected StateReturnHome moving back toward 12000 (+delta), got %+v", dLeash)
	}
}

func TestReinforcementRequestAndCooldownBound(t *testing.T) {
	taskmaster := mustProfile(t, "goblin-taskmaster")
	rng := simulation.NewDeterministicRNG(77)

	p := ai.Perception{
		Tick:                        25,
		GroupID:                     "goblin-cmd-1",
		CurrentState:                ai.StateAttack,
		HP:                          300, // 62.5% <= ReinforceTriggerHPBP (75%)
		MaxHP:                       480,
		DistanceToSettlement:        2000,
		HomePosition:                10000,
		InvasionActive:              true,
		SettlementAlive:             true,
		Profile:                     taskmaster,
		MoraleBP:                    6500,
		ReinforceCooldownTicks:      0,
		RemainingReinforcementCalls: 2,
	}
	dCall, err := ai.Evaluate(p, &rng)
	if err != nil {
		t.Fatalf("Evaluate reinforcement failed: %v", err)
	}
	if !dCall.RequestReinforcements || dCall.ReinforcementArchetype != "goblin-skirmisher" || dCall.ReinforcementCount != 1 {
		t.Fatalf("expected reinforcement request for goblin-skirmisher x1, got %+v", dCall)
	}

	// With active cooldown, must NOT request reinforcements.
	p.ReinforceCooldownTicks = 10
	dCool, err := ai.Evaluate(p, &rng)
	if err != nil {
		t.Fatalf("Evaluate reinforcement cooldown failed: %v", err)
	}
	if dCool.RequestReinforcements {
		t.Fatalf("reinforcement request must be suppressed during cooldown")
	}

	// With 0 remaining calls, must NOT request reinforcements.
	p.ReinforceCooldownTicks = 0
	p.RemainingReinforcementCalls = 0
	dExhausted, err := ai.Evaluate(p, &rng)
	if err != nil {
		t.Fatalf("Evaluate exhausted reinforcements failed: %v", err)
	}
	if dExhausted.RequestReinforcements {
		t.Fatalf("reinforcement request must be suppressed when remaining calls == 0")
	}
}

// Standalone AI Engine Replay Test (per Codex Cycle 01 audit recommendation):
// Running the full Coordinate + Evaluate multi-actor loop twice with identical seed and inputs
// produces bit-for-bit identical trajectories across 300 ticks.
func TestAIEngineDeterministicReplay(t *testing.T) {
	runReplay := func(seed uint64) []ai.Decision {
		rng := simulation.NewDeterministicRNG(seed)
		warchief := mustProfile(t, "orc-warchief")
		vanguard := mustProfile(t, "orc-vanguard")
		goblin := mustProfile(t, "goblin-raider-pack")

		actors := []ai.GroupSnapshot{
			{GroupID: "a-goblin", Profile: goblin, State: ai.StateIdle, Position: 11000, HomePosition: 12000, HP: goblin.BaseHP, MaxHP: goblin.BaseHP, MoraleBP: goblin.InitialMoraleBP},
			{GroupID: "b-orc-vanguard", Profile: vanguard, State: ai.StateIdle, Position: 10500, HomePosition: 12000, HP: vanguard.BaseHP, MaxHP: vanguard.BaseHP, MoraleBP: vanguard.InitialMoraleBP},
			{GroupID: "c-orc-warchief", Profile: warchief, State: ai.StateIdle, Position: 10800, HomePosition: 12000, HP: warchief.BaseHP, MaxHP: warchief.BaseHP, MoraleBP: warchief.InitialMoraleBP},
		}
		targets := []ai.PerceivedTarget{
			{TargetID: "defender-1", Kind: ai.TargetDefender, Position: 2000, HP: 180, MaxHP: 300, ThreatScore: 600},
			{TargetID: "settlement", Kind: ai.TargetSettlement, Position: 0, HP: 1000, MaxHP: 1000, ThreatScore: 0},
		}

		history := make([]ai.Decision, 0, 300*len(actors))
		for tick := uint64(1); tick <= 300; tick++ {
			orders, err := ai.Coordinate(actors, targets, tick >= 20)
			if err != nil {
				t.Fatalf("Coordinate failed at tick %d: %v", tick, err)
			}
			for i := range actors {
				p := ai.Perception{
					Tick:                 tick,
					GroupID:              actors[i].GroupID,
					CurrentState:         actors[i].State,
					HP:                   actors[i].HP,
					MaxHP:                actors[i].MaxHP,
					DistanceToSettlement: actors[i].Position,
					HomePosition:         actors[i].HomePosition,
					InvasionActive:       tick >= 20,
					SettlementAlive:      true,
					Profile:              actors[i].Profile,
					MoraleBP:             actors[i].MoraleBP,
					Targets:              targets,
					Order:                orders[i],
				}
				d, err := ai.Evaluate(p, &rng)
				if err != nil {
					t.Fatalf("Evaluate failed at tick %d actor %s: %v", tick, actors[i].GroupID, err)
				}
				actors[i].State = d.NextState
				actors[i].MoraleBP = d.NewMoraleBP
				actors[i].Position += d.MoveDelta
				if actors[i].Position < 0 {
					actors[i].Position = 0
				}
				history = append(history, d)
			}
		}
		return history
	}

	traceA := runReplay(202602)
	traceB := runReplay(202602)
	if len(traceA) != len(traceB) {
		t.Fatalf("replay length mismatch: %d != %d", len(traceA), len(traceB))
	}
	for i := range traceA {
		if traceA[i] != traceB[i] {
			t.Fatalf("AI replay divergence at step %d: %+v != %+v", i, traceA[i], traceB[i])
		}
	}
}

func TestProfileValidationRejectsInvalidConfigs(t *testing.T) {
	base := mustProfile(t, "goblin-raider-pack")

	badRally := base
	badRally.RallyMoraleBP = badRally.BreakMoraleBP
	if err := badRally.Validate(); !errors.Is(err, ai.ErrInvalidProfile) {
		t.Fatalf("expected ErrInvalidProfile when RallyMoraleBP <= BreakMoraleBP, got %v", err)
	}

	badLeash := base
	badLeash.LeashRadius = badLeash.TerritoryRadius - 1
	if err := badLeash.Validate(); !errors.Is(err, ai.ErrInvalidProfile) {
		t.Fatalf("expected ErrInvalidProfile when LeashRadius < TerritoryRadius, got %v", err)
	}

	badReinf := base
	badReinf.MaxReinforcementCalls = 1
	badReinf.ReinforcementArchetype = ""
	if err := badReinf.Validate(); !errors.Is(err, ai.ErrInvalidProfile) {
		t.Fatalf("expected ErrInvalidProfile when reinforcement archetype empty, got %v", err)
	}
}

func TestExtremeRecentDamageDoesNotPanic(t *testing.T) {
	p := ai.Perception{GroupID: "g", CurrentState: ai.StateIdle, HP: 1, MaxHP: 1, Profile: mustProfile(t, "goblin-skirmisher"), MoraleBP: 5000, RecentDamageTaken: int64(^uint64(0) >> 1)}
	rng := simulation.NewDeterministicRNG(1)
	if _, err := ai.Evaluate(p, &rng); err != nil {
		t.Fatal(err)
	}
}

func FuzzTargetSelectionOrder(f *testing.F) {
	f.Add(uint16(10), uint16(20), uint16(40), uint16(60))
	f.Fuzz(func(t *testing.T, x, y, hp1, hp2 uint16) {
		p, err := ai.LookupProfile("orc-vanguard")
		if err != nil {
			t.Fatal(err)
		}
		a := ai.PerceivedTarget{TargetID: "a", Kind: ai.TargetDefender, Position: int64(x), HP: int64(hp1 % 101), MaxHP: 100}
		b := ai.PerceivedTarget{TargetID: "b", Kind: ai.TargetDefender, Position: int64(y), HP: int64(hp2 % 101), MaxHP: 100}
		left, ok1 := ai.SelectTarget(5000, 5000, p, []ai.PerceivedTarget{a, b}, ai.CoordinationOrder{}, false)
		right, ok2 := ai.SelectTarget(5000, 5000, p, []ai.PerceivedTarget{b, a}, ai.CoordinationOrder{}, false)
		if ok1 != ok2 || left != right {
			t.Fatalf("order changed selection: %+v %+v", left, right)
		}
	})
}
