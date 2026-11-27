package siege_test

import (
	"errors"
	"math"
	"testing"

	"ascendra-game/internal/ai"
	"ascendra-game/internal/ports"
	"ascendra-game/internal/siege"
)

func mustDefaultSiege(t *testing.T, family ai.Family) (siege.SiegeState, siege.Config) {
	t.Helper()
	cfg := siege.DefaultConfig()
	layout := siege.DefaultValewatchLayout()
	if err := siege.ValidateLayout(layout, cfg); err != nil {
		t.Fatalf("ValidateLayout failed: %v", err)
	}
	st, err := siege.NewSiegeStateFromLayout(layout, cfg, "cmp-1", "faction-hostile", family, false, 10)
	if err != nil {
		t.Fatalf("NewSiegeStateFromLayout failed: %v", err)
	}
	return st, cfg
}

func TestConfigAndLayoutValidation(t *testing.T) {
	cfg := siege.DefaultConfig()
	if err := cfg.Validate(); err != nil {
		t.Fatalf("DefaultConfig invalid: %v", err)
	}

	// Verify provisional layout lookup for both fixtures and custom proportional fallback.
	if l := siege.LookupProvisionalLayout("settlement-valewatch", "region-ashvale", 1000); l.LayoutID != "layout-valewatch-bastion" {
		t.Fatalf("unexpected valewatch layout: %s", l.LayoutID)
	}
	if l := siege.LookupProvisionalLayout("settlement-ironford", "region-thornreach", 1500); l.LayoutID != "layout-ironford-citadel" {
		t.Fatalf("unexpected ironford layout: %s", l.LayoutID)
	}
	custom := siege.LookupProvisionalLayout("settlement-highkeep", "region-north", 1234)
	if err := siege.ValidateLayout(custom, cfg); err != nil {
		t.Fatalf("custom proportional layout invalid: %v", err)
	}
	stCustom, err := siege.NewSiegeStateFromLayout(custom, cfg, "cmp-x", "fac-x", ai.FamilyOrc, false, 1)
	if err != nil {
		t.Fatal(err)
	}
	if stCustom.TotalStructureMaxHP() != 1234 {
		t.Fatalf("expected exact proportional sum 1234, got %d", stCustom.TotalStructureMaxHP())
	}

	// Config validation rejection cases.
	badCases := []func(*siege.Config){
		func(c *siege.Config) { c.RulesVersion = 99 },
		func(c *siege.Config) { c.MaxZones = 1 },
		func(c *siege.Config) { c.MaxSupplies = 0 },
		func(c *siege.Config) { c.SupplyRegenIntervalTicks = 0 },
		func(c *siege.Config) { c.DistrictCaptureThreshold = 0 },
		func(c *siege.Config) { c.NoProgressTimeoutTicks = 0 },
		func(c *siege.Config) { c.GoblinWithdrawMoraleBP = 20000 },
		func(c *siege.Config) { c.TowerFireDamage = -1 },
		func(c *siege.Config) { c.TowerFireCooldownTicks = 0 },
	}
	for i, mutate := range badCases {
		bad := cfg
		mutate(&bad)
		if err := bad.Validate(); !errors.Is(err, siege.ErrInvalidConfig) {
			t.Fatalf("bad config case %d expected ErrInvalidConfig, got %v", i, err)
		}
	}

	// Layout invalid cases: duplicate IDs, self-loop, unknown refs, disconnected graph, cyclic objectives, roster overflow.
	base := siege.DefaultValewatchLayout()

	// Duplicate zone ID.
	dupZone := base
	dupZone.Zones = append(append([]siege.Zone{}, base.Zones...), base.Zones[0])
	if err := siege.ValidateLayout(dupZone, cfg); err == nil {
		t.Fatal("expected error for duplicate zone_id")
	}

	// Self-loop connection.
	selfLoop := base
	selfLoop.Connections = append(append([]siege.ZoneConnection{}, base.Connections...), siege.ZoneConnection{
		ConnectionID: "conn-loop", FromZoneID: siege.ZoneIDMainGate, ToZoneID: siege.ZoneIDMainGate, Rule: siege.ConnAlwaysOpen,
	})
	if err := siege.ValidateLayout(selfLoop, cfg); !errors.Is(err, siege.ErrInvalidLayout) {
		t.Fatalf("expected ErrInvalidLayout for self-loop, got %v", err)
	}

	// Unknown blocker structure.
	badBlocker := base
	badBlocker.Connections = append([]siege.ZoneConnection{}, base.Connections...)
	badBlocker.Connections[2].BlockerStructureID = "str-nonexistent"
	if err := siege.ValidateLayout(badBlocker, cfg); !errors.Is(err, siege.ErrInvalidLayout) {
		t.Fatalf("expected ErrInvalidLayout for unknown blocker, got %v", err)
	}

	// Disconnected citadel.
	disconnected := base
	disconnected.Connections = []siege.ZoneConnection{
		{ConnectionID: "conn-only-1", FromZoneID: siege.ZoneIDExteriorField, ToZoneID: siege.ZoneIDWallApproach, Bidirectional: true, Rule: siege.ConnAlwaysOpen},
	}
	if err := siege.ValidateLayout(disconnected, cfg); !errors.Is(err, siege.ErrInvalidLayout) {
		t.Fatalf("expected ErrInvalidLayout for disconnected citadel, got %v", err)
	}

	// Cyclic objective prerequisites.
	cyclic := base
	cyclic.Objectives = []siege.Objective{
		{ObjectiveID: "obj-a", Side: siege.SideInvasion, Kind: siege.ObjOpenBreach, ZoneID: siege.ZoneIDMainGate, PrerequisiteIDs: []string{"obj-b"}, State: siege.ObjLocked, TargetProgress: 1},
		{ObjectiveID: "obj-b", Side: siege.SideInvasion, Kind: siege.ObjCaptureDistrict, ZoneID: siege.ZoneIDOuterDistrict, PrerequisiteIDs: []string{"obj-a"}, State: siege.ObjLocked, TargetProgress: 1},
	}
	if err := siege.ValidateLayout(cyclic, cfg); !errors.Is(err, siege.ErrInvalidLayout) {
		t.Fatalf("expected ErrInvalidLayout for cyclic objectives, got %v", err)
	}

	// Duplicate NPC defender ID & capacity overflow.
	dupDef := base
	dupDef.DefenderRoster = append(append([]siege.NPCDefenderSpec{}, base.DefenderRoster...), base.DefenderRoster[0])
	if err := siege.ValidateLayout(dupDef, cfg); !errors.Is(err, siege.ErrInvalidLayout) {
		t.Fatalf("expected ErrInvalidLayout for duplicate defender_id, got %v", err)
	}
	tightCfg := cfg
	tightCfg.MaxNPCDefenders = 1
	if err := siege.ValidateLayout(base, tightCfg); !errors.Is(err, siege.ErrCapacityExceeded) {
		t.Fatalf("expected ErrCapacityExceeded for roster > MaxNPCDefenders, got %v", err)
	}
}

func TestZoneGraphGateBlockingBreachAndAntiTeleportation(t *testing.T) {
	st, cfg := mustDefaultSiege(t, ai.FamilyOrc)

	// Closed Main Gate and intact Outer Wall must block invaders from entering Outer District.
	if siege.CanTraverse(st, siege.ZoneIDMainGate, siege.ZoneIDOuterDistrict, true) {
		t.Fatal("intact gate must block invader traversal to outer district")
	}
	if siege.CanTraverse(st, siege.ZoneIDWallApproach, siege.ZoneIDOuterDistrict, true) {
		t.Fatal("intact wall must block invader traversal to outer district")
	}
	// Defenders CAN pass through their own intact gate.
	if !siege.CanTraverse(st, siege.ZoneIDMainGate, siege.ZoneIDOuterDistrict, false) {
		t.Fatal("defenders must be able to traverse their own gate")
	}
	// Anti-teleportation: non-adjacent Exterior -> Citadel is ALWAYS forbidden.
	if siege.CanTraverse(st, siege.ZoneIDExteriorField, siege.ZoneIDCitadel, false) ||
		siege.CanTraverse(st, siege.ZoneIDExteriorField, siege.ZoneIDCitadel, true) {
		t.Fatal("direct teleportation Exterior -> Citadel must be rejected")
	}
	// Invader cannot reach Citadel while Gate & Wall are intact.
	if _, ok := siege.NextStepToward(st, siege.ZoneIDExteriorField, siege.ZoneIDCitadel, true); ok {
		t.Fatal("invader should have no open route to citadel before breach")
	}
	// Step-by-step path from Exterior to Main Gate goes through Wall Approach.
	step, ok := siege.NextStepToward(st, siege.ZoneIDExteriorField, siege.ZoneIDMainGate, true)
	if !ok || step != siege.ZoneIDWallApproach {
		t.Fatalf("expected next step %s, got %s (%v)", siege.ZoneIDWallApproach, step, ok)
	}

	// Damage Outer Wall past its 50% breach threshold -> opens wall breach route!
	wallIdx := st.FindStructureIndex(siege.StructIDOuterWall)
	for !st.Structures[wallIdx].State.IsCompromised() {
		_, _, _, _, err := siege.ApplyStructureDamage(&st, siege.StructIDOuterWall, 100, 14000, 20, cfg)
		if err != nil {
			t.Fatalf("ApplyStructureDamage wall: %v", err)
		}
	}
	if st.Structures[wallIdx].State != siege.StructureBreached {
		t.Fatalf("expected wall to enter Breached state at <=50%% HP, got %s (HP=%d/%d)",
			st.Structures[wallIdx].State, st.Structures[wallIdx].HP, st.Structures[wallIdx].MaxHP)
	}
	if !siege.CanTraverse(st, siege.ZoneIDWallApproach, siege.ZoneIDOuterDistrict, true) {
		t.Fatal("breached wall must unlock WallApproach -> OuterDistrict for invaders")
	}
	// Main Gate itself is STILL closed even though Wall is breached!
	if siege.CanTraverse(st, siege.ZoneIDMainGate, siege.ZoneIDOuterDistrict, true) {
		t.Fatal("intact Main Gate must remain blocked until Gate itself is breached/destroyed")
	}
	// Now invaders have a valid route to Citadel through the breached wall!
	if nextStep, ok := siege.NextStepToward(st, siege.ZoneIDWallApproach, siege.ZoneIDCitadel, true); !ok || nextStep != siege.ZoneIDOuterDistrict {
		t.Fatalf("expected route through breached wall into OuterDistrict, got %s (%v)", nextStep, ok)
	}
	if reached := siege.ReachableZones(st, siege.ZoneIDExteriorField, true); len(reached) != len(st.Zones) {
		t.Fatalf("expected all %d zones reachable after wall breach, got %d", len(st.Zones), len(reached))
	}
	if hop := siege.ZoneHopDistance(st, siege.ZoneIDExteriorField, siege.ZoneIDMainGate); hop != 2 {
		t.Fatalf("expected 2 hops Exterior->MainGate, got %d", hop)
	}
}

func TestStructureDamageResistanceRepairSuppliesAndDepotLoss(t *testing.T) {
	st, cfg := mustDefaultSiege(t, ai.FamilyGoblin)

	// Pure damage formula invariants & overflow/negative guards.
	if _, err := siege.CalculateStructureDamage(-1, 10000, 0, 0); !errors.Is(err, siege.ErrInvalidCommand) {
		t.Fatalf("expected error on negative damage, got %v", err)
	}
	if _, err := siege.CalculateStructureDamage(100, 10000, 0, 9000); !errors.Is(err, siege.ErrInvalidCommand) {
		t.Fatalf("expected error on resistance > 7500 BP, got %v", err)
	}
	if _, err := siege.CalculateStructureDamage(math.MaxInt64, 20000, 0, 0); !errors.Is(err, siege.ErrNumericOverflow) {
		t.Fatalf("expected ErrNumericOverflow on huge damage*mod, got %v", err)
	}
	// Armor + resistance math: 100 * 1.0 - 10 armor = 90; 90 * 0.80 (2000 BP resist) = 72.
	dmg, err := siege.CalculateStructureDamage(100, 10000, 10, 2000)
	if err != nil || dmg != 72 {
		t.Fatalf("expected exact integer damage 72, got %d (%v)", dmg, err)
	}
	// Very weak hit still deals min 1 (never negative or 0-lock).
	minDmg, err := siege.CalculateStructureDamage(1, 10000, 50, 5000)
	if err != nil || minDmg != 1 {
		t.Fatalf("expected minimum 1 effective damage, got %d (%v)", minDmg, err)
	}

	// Nonexistent structure rejected.
	if _, _, _, _, err := siege.ApplyStructureDamage(&st, "str-missing", 50, 10000, 11, cfg); !errors.Is(err, siege.ErrUnknownEntity) {
		t.Fatalf("expected ErrUnknownEntity, got %v", err)
	}

	// Damage Main Gate and repair WITH operational Supply Depot (+25% bonus: 45 * 1.25 = 56).
	eff, _, _, _, err := siege.ApplyStructureDamage(&st, siege.StructIDMainGate, 120, 10000, 12, cfg)
	if err != nil || eff <= 0 {
		t.Fatalf("damage gate failed: %d %v", eff, err)
	}
	// Out-of-reach repair rejected.
	if _, _, err := siege.ApplyStructureRepair(&st, siege.StructIDMainGate, "eng-1", siege.ZoneIDCitadel, 13, cfg); !errors.Is(err, siege.ErrZoneBlocked) {
		t.Fatalf("expected ErrZoneBlocked for far repair, got %v", err)
	}
	healedWithDepot, cost, err := siege.ApplyStructureRepair(&st, siege.StructIDMainGate, "eng-1", siege.ZoneIDMainGate, 13, cfg)
	if err != nil || healedWithDepot != 56 || cost != cfg.RepairSupplyCost {
		t.Fatalf("expected depot-boosted repair 56 (cost %d), got %d (cost %d, err %v)", cfg.RepairSupplyCost, healedWithDepot, cost, err)
	}
	// Cooldown blocks immediate second repair.
	if _, _, err := siege.ApplyStructureRepair(&st, siege.StructIDMainGate, "eng-1", siege.ZoneIDMainGate, 14, cfg); !errors.Is(err, siege.ErrCooldownActive) {
		t.Fatalf("expected ErrCooldownActive, got %v", err)
	}

	// Destroy Supply Depot -> immediate supply disruption loss + bonus drops to 0 + regen stops!
	suppliesBeforeDepotFall := st.Supplies.Current
	var disruptedTotal int64
	for st.HasOperationalSupplyDepot() {
		_, _, _, dis, err := siege.ApplyStructureDamage(&st, siege.StructIDSupplyDepot, 200, 12000, 30, cfg)
		if err != nil {
			t.Fatal(err)
		}
		disruptedTotal += dis
	}
	if disruptedTotal != cfg.SupplyDepotDestroyPenalty || st.Supplies.Current != suppliesBeforeDepotFall-disruptedTotal {
		t.Fatalf("expected supply disruption %d, got %d", cfg.SupplyDepotDestroyPenalty, disruptedTotal)
	}
	// Destroyed Supply Depot cannot be damaged again or repaired in battle (AllowDestroyedStructureRepairInBattle == false).
	if _, _, _, _, err := siege.ApplyStructureDamage(&st, siege.StructIDSupplyDepot, 50, 10000, 31, cfg); !errors.Is(err, siege.ErrDeadEntity) {
		t.Fatalf("expected ErrDeadEntity damaging destroyed depot, got %v", err)
	}
	if _, _, err := siege.ApplyStructureRepair(&st, siege.StructIDSupplyDepot, "eng-1", siege.ZoneIDSupplyDistrict, 31, cfg); !errors.Is(err, siege.ErrDeadEntity) {
		t.Fatalf("expected ErrDeadEntity repairing destroyed depot, got %v", err)
	}
	// Supply regen MUST return 0 once depot is destroyed.
	if gained := siege.TickSupplyRegen(&st, 100, cfg); gained != 0 {
		t.Fatalf("expected 0 supply regen after depot destruction, got %d", gained)
	}
	// Repair without Supply Depot yields base amount (45, NOT 56), clamped to missing HP.
	_, _, _, _, _ = siege.ApplyStructureDamage(&st, siege.StructIDMainGate, 120, 10000, 32, cfg)
	healedNoDepot, _, err := siege.ApplyStructureRepair(&st, siege.StructIDMainGate, "eng-1", siege.ZoneIDMainGate, 35, cfg)
	if err != nil || healedNoDepot != cfg.RepairBaseAmount {
		t.Fatalf("expected base repair %d without depot, got %d (%v)", cfg.RepairBaseAmount, healedNoDepot, err)
	}

	// Exhaust entity repair limit and verify rejection.
	for i := 0; i < cfg.MaxRepairsPerEntity-2; i++ {
		_, _, _, _, _ = siege.ApplyStructureDamage(&st, siege.StructIDMainGate, 100, 10000, uint64(40+i*15), cfg)
		if _, _, err := siege.ApplyStructureRepair(&st, siege.StructIDMainGate, "eng-1", siege.ZoneIDMainGate, uint64(50+i*15), cfg); err != nil {
			t.Fatalf("repair %d failed unexpectedly: %v", i, err)
		}
	}
	_, _, _, _, _ = siege.ApplyStructureDamage(&st, siege.StructIDMainGate, 100, 10000, 100, cfg)
	if _, _, err := siege.ApplyStructureRepair(&st, siege.StructIDMainGate, "eng-1", siege.ZoneIDMainGate, 120, cfg); !errors.Is(err, siege.ErrRepairLimitReached) {
		t.Fatalf("expected ErrRepairLimitReached for entity, got %v", err)
	}
}

func TestDistrictCaptureHysteresisObjectivesAndPhaseFSM(t *testing.T) {
	st, cfg := mustDefaultSiege(t, ai.FamilyOrc)

	// Invalid phase jumps rejected.
	if err := siege.ValidatePhaseTransition(siege.PhaseApproach, siege.PhaseCitadelAssault); !errors.Is(err, siege.ErrInvalidPhaseTransition) {
		t.Fatalf("expected forbidden phase skip error, got %v", err)
	}
	if err := siege.ValidatePhaseTransition(siege.PhaseDefended, siege.PhaseApproach); !errors.Is(err, siege.ErrInvalidPhaseTransition) {
		t.Fatalf("expected terminal re-entry error, got %v", err)
	}
	if siege.PhaseWithdrawn.ToInvasionOutcome() != ports.InvasionOutcomeDefended {
		t.Fatalf("expected PhaseWithdrawn -> Defended outcome mapping")
	}

	// Before outer breach, inner district capture does NOT progress.
	invadersInOuter := []siege.CombatantSnapshot{
		{ID: "g1", ZoneID: siege.ZoneIDOuterDistrict, HP: 400, MaxHP: 400, MoraleBP: 8000, Family: ai.FamilyOrc, IsInvader: true},
	}
	if _, prog := siege.EvaluateDistricts(&st, invadersInOuter, 12, cfg); prog {
		t.Fatal("inner district must not progress before outer fortification breach")
	}

	// Open breach via Main Gate destruction.
	for st.Structures[st.FindStructureIndex(siege.StructIDMainGate)].HP > 0 {
		_, _, _, _, _ = siege.ApplyStructureDamage(&st, siege.StructIDMainGate, 200, 15000, 15, cfg)
	}

	// Evaluate objectives: DestroyGate and OpenBreach complete -> CaptureDistrict & DisruptSupplies unlock!
	objChanges, _ := siege.EvaluateObjectives(&st, invadersInOuter, 16)
	if len(objChanges) == 0 {
		t.Fatal("expected DestroyGate/OpenBreach completion and follow-up unlocks")
	}
	if st.Objectives[st.FindObjectiveIndex(siege.ObjIDOpenBreach)].State != siege.ObjCompleted {
		t.Fatal("expected ObjOpenBreach completed")
	}
	// Run one more evaluation pass to unlock dependent objectives.
	siege.EvaluateObjectives(&st, invadersInOuter, 17)
	if st.Objectives[st.FindObjectiveIndex(siege.ObjIDCaptureDistrict)].State != siege.ObjActive {
		t.Fatalf("expected ObjCaptureDistrict unlocked to Active, got %s", st.Objectives[st.FindObjectiveIndex(siege.ObjIDCaptureDistrict)].State)
	}

	// Authoritative player objective claim MUST fail for blind/unmet conditions.
	if err := siege.ValidateAndCompletePlayerObjective(&st, siege.ObjIDDefendGate, "p1", siege.ZoneIDMainGate, 0, invadersInOuter, 18); !errors.Is(err, siege.ErrObjectiveConditionNotMet) {
		t.Fatalf("expected ErrObjectiveConditionNotMet for failed gate defense, got %v", err)
	}
	if err := siege.ValidateAndCompletePlayerObjective(&st, siege.ObjIDDestroyGate, "p1", siege.ZoneIDMainGate, 0, invadersInOuter, 18); !errors.Is(err, siege.ErrObjectiveConditionNotMet) {
		t.Fatalf("defenders must not complete invasion objectives, got %v", err)
	}
	if err := siege.ValidateAndCompletePlayerObjective(&st, siege.ObjIDHoldDistrict, "p1", siege.ZoneIDOuterDistrict, 0, invadersInOuter, 18); !errors.Is(err, siege.ErrObjectiveConditionNotMet) {
		t.Fatalf("expected ErrObjectiveConditionNotMet while invaders present in district, got %v", err)
	}
	if err := siege.ValidateAndCompletePlayerObjective(&st, "obj-nonexistent", "p1", siege.ZoneIDMainGate, 0, invadersInOuter, 18); !errors.Is(err, siege.ErrUnknownEntity) {
		t.Fatalf("expected ErrUnknownEntity, got %v", err)
	}

	// Capture Outer District over consecutive ticks -> transitions DefenderControlled -> Contested -> InvaderControlled.
	for tick := uint64(20); tick <= 30; tick++ {
		siege.EvaluateDistricts(&st, invadersInOuter, tick, cfg)
	}
	outerIdx := st.FindZoneIndex(siege.ZoneIDOuterDistrict)
	if st.Zones[outerIdx].ControlState != siege.DistrictInvaderControlled {
		t.Fatalf("expected OuterDistrict InvaderControlled, got %s (prog=%d)", st.Zones[outerIdx].ControlState, st.Zones[outerIdx].ControlProgress)
	}
	// Capturing Outer District alone must NOT end the siege as Captured!
	_, terminal, _, _, err := siege.EvaluatePhaseAndResolution(&st, invadersInOuter, 31, true, cfg)
	if err != nil || terminal {
		t.Fatalf("capturing a single outer district must NOT immediately capture the settlement (terminal=%v, err=%v)", terminal, err)
	}

	// Now capture Citadel -> authoritative PhaseCaptured!
	invadersInCitadel := []siege.CombatantSnapshot{
		{ID: "g1", ZoneID: siege.ZoneIDCitadel, HP: 400, MaxHP: 400, MoraleBP: 8000, Family: ai.FamilyOrc, IsInvader: true},
	}
	for tick := uint64(32); tick <= 45; tick++ {
		siege.EvaluateDistricts(&st, invadersInCitadel, tick, cfg)
	}
	_, terminal, outcome, _, err := siege.EvaluatePhaseAndResolution(&st, invadersInCitadel, 46, true, cfg)
	if err != nil || !terminal || outcome != ports.InvasionOutcomeCaptured || st.Phase != siege.PhaseCaptured {
		t.Fatalf("expected terminal PhaseCaptured, got terminal=%v outcome=%s phase=%s err=%v", terminal, outcome, st.Phase, err)
	}
}

func TestGoblinVsOrcTargetPolicyAndTowerAndWaveGuards(t *testing.T) {
	stGob, cfg := mustDefaultSiege(t, ai.FamilyGoblin)
	stOrc, _ := mustDefaultSiege(t, ai.FamilyOrc)

	// Open breach so both families choose inner destinations: Goblins prioritize SupplyDistrict, Orcs push OuterDistrict/Citadel.
	for stGob.Structures[stGob.FindStructureIndex(siege.StructIDMainGate)].HP > 0 {
		_, _, _, _, _ = siege.ApplyStructureDamage(&stGob, siege.StructIDMainGate, 250, 14000, 15, cfg)
		_, _, _, _, _ = siege.ApplyStructureDamage(&stOrc, siege.StructIDMainGate, 250, 14000, 15, cfg)
	}
	gobDest := siege.SelectInvaderDestinationZone(stGob, siege.ZoneIDOuterDistrict, ai.FamilyGoblin)
	orcDest := siege.SelectInvaderDestinationZone(stOrc, siege.ZoneIDOuterDistrict, ai.FamilyOrc)
	if gobDest != siege.ZoneIDSupplyDistrict {
		t.Fatalf("expected Goblins to prioritize SupplyDistrict after breach, got %s", gobDest)
	}
	if orcDest != siege.ZoneIDOuterDistrict && orcDest != siege.ZoneIDCitadel {
		t.Fatalf("expected Orcs to contest OuterDistrict/Citadel directly, got %s", orcDest)
	}

	// Structure modifiers: Orcs hit fortifications harder than Goblin skirmishers.
	gobMod := siege.StructureAttackModifierBP("goblin-skirmisher", ai.FamilyGoblin, siege.StructureWall, false, 0)
	orcMod := siege.StructureAttackModifierBP("orc-berserker", ai.FamilyOrc, siege.StructureWall, true, 2000)
	if orcMod <= gobMod {
		t.Fatalf("expected Orc wall siege modifier (%d) > Goblin (%d)", orcMod, gobMod)
	}

	// Tower targeting: operational tower targets invader within 1 hop; destroyed tower returns none.
	towerIdx := stGob.FindStructureIndex(siege.StructIDNorthTower)
	combatants := []siege.CombatantSnapshot{
		{ID: "inv-far", ZoneID: siege.ZoneIDExteriorField, HP: 100, MaxHP: 200, IsInvader: true},
		{ID: "inv-near", ZoneID: siege.ZoneIDWallApproach, HP: 150, MaxHP: 200, IsInvader: true},
	}
	tid, ok := siege.SelectTowerTarget(stGob, stGob.Structures[towerIdx], combatants)
	if !ok || tid != "inv-near" {
		t.Fatalf("expected tower to select inv-near within 1 hop, got %s (%v)", tid, ok)
	}
	stGob.Structures[towerIdx].HP = 0
	stGob.Structures[towerIdx].State = siege.StructureDestroyed
	if _, ok := siege.SelectTowerTarget(stGob, stGob.Structures[towerIdx], combatants); ok {
		t.Fatal("destroyed tower must never select a target")
	}

	// Wave upsert idempotency & cap enforcement.
	w1 := siege.SiegeWave{
		WaveID: "wave-1", CampaignID: "cmp-1", ReservationID: "res-1",
		Archetype: "goblin-skirmisher", Count: 1, ScheduledTick: 30,
		EntryZoneID: siege.ZoneIDExteriorField, State: siege.WaveScheduled,
	}
	if err := siege.UpsertWave(&stGob, w1, cfg); err != nil {
		t.Fatalf("UpsertWave w1: %v", err)
	}
	if err := siege.UpsertWave(&stGob, w1, cfg); !errors.Is(err, siege.ErrInvalidCommand) {
		t.Fatalf("expected duplicate wave rejection, got %v", err)
	}

	// Checksum determinism & clone isolation.
	sum1, err := stGob.Checksum(cfg)
	if err != nil {
		t.Fatalf("Checksum: %v", err)
	}
	clone := stGob.Clone()
	clone.Supplies.Current = 0
	sum2, err := stGob.Checksum(cfg)
	if err != nil || sum1 != sum2 {
		t.Fatalf("clone mutation leaked into original state checksum")
	}
	sumClone, err := clone.Checksum(cfg)
	if err != nil || sumClone == sum1 {
		t.Fatalf("modified clone should produce distinct checksum")
	}
}

func TestStructureSelectionSupplyRegenAndCoordinateMapping(t *testing.T) {
	st, cfg := mustDefaultSiege(t, ai.FamilyGoblin)

	// SelectStructureTarget: Goblin vs Orc priority in MainGate (Gate vs Tower) and SupplyDistrict (SupplyDepot).
	// Damage NorthTower slightly so Goblin opportunistic bonus picks weakened tower over intact gate, while Orc stays on Gate.
	_, _, _, _, _ = siege.ApplyStructureDamage(&st, siege.StructIDNorthTower, 30, 10000, 11, cfg)
	orcPick, okOrc := siege.SelectStructureTarget(st, siege.ZoneIDMainGate, ai.FamilyOrc, "orc-vanguard")
	gobPick, okGob := siege.SelectStructureTarget(st, siege.ZoneIDMainGate, ai.FamilyGoblin, "goblin-skirmisher")
	if !okOrc || orcPick.StructureID != siege.StructIDMainGate {
		t.Fatalf("expected Orc to focus MainGate, got %+v (%v)", orcPick, okOrc)
	}
	if !okGob || gobPick.StructureID != siege.StructIDNorthTower {
		t.Fatalf("expected Goblin to opportunistically target damaged NorthTower, got %+v (%v)", gobPick, okGob)
	}
	// Supply district target selection.
	depPick, okDep := siege.SelectStructureTarget(st, siege.ZoneIDSupplyDistrict, ai.FamilyGoblin, "goblin-raider-pack")
	if !okDep || depPick.StructureID != siege.StructIDSupplyDepot {
		t.Fatalf("expected SupplyDepot target in SupplyDistrict, got %+v (%v)", depPick, okDep)
	}
	// ExteriorField has no structures -> returns false.
	if _, ok := siege.SelectStructureTarget(st, siege.ZoneIDExteriorField, ai.FamilyOrc, "orc-berserker"); ok {
		t.Fatal("expected no structure target in ExteriorField")
	}
	// All archetype attack modifiers across families.
	for _, arch := range []string{"goblin-skirmisher", "goblin-raider-pack", "goblin-taskmaster", "orc-vanguard", "orc-berserker", "orc-warchief", "unknown-custom"} {
		for _, kind := range []siege.StructureKind{siege.StructureGate, siege.StructureWall, siege.StructureTower, siege.StructureSupplyDepot, siege.StructureCitadel} {
			if m := siege.StructureAttackModifierBP(arch, ai.FamilyOrc, kind, true, 1000); m <= 0 {
				t.Fatalf("modifier must be positive for %s/%s, got %d", arch, kind, m)
			}
		}
	}

	// Finite Supply Regeneration while SupplyDepot is operational, stopping at MaxTotalRegen.
	st.Supplies.Current = 100
	st.Supplies.TotalRegenerated = 0
	st.Supplies.LastRegenTick = 10
	var totalGained int64
	for tick := uint64(30); tick <= 300; tick += 20 {
		totalGained += siege.TickSupplyRegen(&st, tick, cfg)
	}
	if totalGained != cfg.MaxSupplyRegenTotal || st.Supplies.TotalRegenerated != cfg.MaxSupplyRegenTotal {
		t.Fatalf("expected finite supply regen capped at %d, got gained=%d totalRegen=%d", cfg.MaxSupplyRegenTotal, totalGained, st.Supplies.TotalRegenerated)
	}
	if extra := siege.TickSupplyRegen(&st, 400, cfg); extra != 0 {
		t.Fatalf("expected 0 extra regen after MaxSupplyRegenTotal, got %d", extra)
	}

	// PositionForZone and ZoneForPosition round-trip & unknown zone check.
	pos, ok := siege.PositionForZone(st, siege.ZoneIDMainGate)
	if !ok || pos != 6500 {
		t.Fatalf("expected MainGate position 6500, got %d (%v)", pos, ok)
	}
	if _, ok := siege.PositionForZone(st, "zone-unknown"); ok {
		t.Fatal("expected false for unknown zone")
	}
	if zid := siege.ZoneForPosition(st, 6400); zid != siege.ZoneIDMainGate {
		t.Fatalf("expected position 6400 -> MainGate, got %s", zid)
	}
	if zid := siege.ZoneForPosition(st, 0); zid != siege.ZoneIDCitadel {
		t.Fatalf("expected position 0 -> Citadel, got %s", zid)
	}

	// EntityRepairTotal, TotalStructureHP, StructuresDestroyedIDs, DistrictsCapturedIDs, Validate.
	if siege.EntityRepairTotal(st, "eng-none") != 0 {
		t.Fatal("expected 0 repairs for unknown entity")
	}
	if _, _, err := siege.ApplyStructureRepair(&st, siege.StructIDNorthTower, "eng-x", siege.ZoneIDMainGate, 20, cfg); err != nil {
		t.Fatal(err)
	}
	if siege.EntityRepairTotal(st, "eng-x") != 1 {
		t.Fatalf("expected 1 repair for eng-x, got %d", siege.EntityRepairTotal(st, "eng-x"))
	}
	if st.TotalStructureHP() <= 0 || st.TotalStructureHP() > st.TotalStructureMaxHP() {
		t.Fatalf("invalid TotalStructureHP: %d/%d", st.TotalStructureHP(), st.TotalStructureMaxHP())
	}
	if len(st.StructuresDestroyedIDs()) != 0 || len(st.DistrictsCapturedIDs()) != 0 {
		t.Fatal("expected 0 destroyed structures and 0 captured districts initially")
	}
	if err := st.Validate(); err != nil {
		t.Fatalf("Validate failed: %v", err)
	}
}

func TestAllPlayerObjectivesPhasesWithdrawalAndValidationBranches(t *testing.T) {
	st, cfg := mustDefaultSiege(t, ai.FamilyGoblin)

	// ConnDefenderOnly traversal check.
	st.Connections = append(st.Connections, siege.ZoneConnection{
		ConnectionID: "conn-99-def-shortcut", FromZoneID: siege.ZoneIDSupplyDistrict, ToZoneID: siege.ZoneIDCitadel,
		Bidirectional: true, Rule: siege.ConnDefenderOnly,
	})
	if siege.CanTraverse(st, siege.ZoneIDSupplyDistrict, siege.ZoneIDCitadel, true) {
		t.Fatal("invader must not traverse ConnDefenderOnly edge")
	}
	if !siege.CanTraverse(st, siege.ZoneIDSupplyDistrict, siege.ZoneIDCitadel, false) {
		t.Fatal("defender must be allowed on ConnDefenderOnly edge")
	}

	// Authoritative defense objective completions:
	// 1. ObjDefendGate: advance to Assault & damage gate, clear invaders -> succeeds!
	if err := siege.TransitionPhase(&st, siege.PhaseAssault, 15); err != nil {
		t.Fatal(err)
	}
	_, _, _, _, _ = siege.ApplyStructureDamage(&st, siege.StructIDMainGate, 50, 10000, 16, cfg)
	if err := siege.ValidateAndCompletePlayerObjective(&st, siege.ObjIDDefendGate, "p1", siege.ZoneIDMainGate, 0, nil, 17); err != nil {
		t.Fatalf("valid ObjDefendGate failed: %v", err)
	}
	// Duplicate claim fails with ErrDuplicateObjective.
	if err := siege.ValidateAndCompletePlayerObjective(&st, siege.ObjIDDefendGate, "p1", siege.ZoneIDMainGate, 0, nil, 18); !errors.Is(err, siege.ErrDuplicateObjective) {
		t.Fatalf("expected ErrDuplicateObjective, got %v", err)
	}

	// 2. ObjRepairFortification: fails before repair, succeeds after valid repair.
	if err := siege.ValidateAndCompletePlayerObjective(&st, siege.ObjIDRepairFortification, "p1", siege.ZoneIDMainGate, 0, nil, 18); !errors.Is(err, siege.ErrObjectiveConditionNotMet) {
		t.Fatalf("expected unmet repair objective before repair, got %v", err)
	}
	if _, _, err := siege.ApplyStructureRepair(&st, siege.StructIDMainGate, "p1", siege.ZoneIDMainGate, 19, cfg); err != nil {
		t.Fatal(err)
	}
	if err := siege.ValidateAndCompletePlayerObjective(&st, siege.ObjIDRepairFortification, "p1", siege.ZoneIDMainGate, 1, nil, 20); err != nil {
		t.Fatalf("valid ObjRepairFortification failed: %v", err)
	}

	// 3. Open Wall Breach -> ObjProtectSupplies & ObjHoldDistrict become claimable when clear of invaders.
	wallIdx := st.FindStructureIndex(siege.StructIDOuterWall)
	for !st.Structures[wallIdx].State.IsCompromised() {
		_, _, _, _, _ = siege.ApplyStructureDamage(&st, siege.StructIDOuterWall, 100, 14000, 22, cfg)
	}
	if err := siege.ValidateAndCompletePlayerObjective(&st, siege.ObjIDProtectSupplies, "p1", siege.ZoneIDSupplyDistrict, 1, nil, 23); err != nil {
		t.Fatalf("valid ObjProtectSupplies failed: %v", err)
	}
	if err := siege.ValidateAndCompletePlayerObjective(&st, siege.ObjIDHoldDistrict, "p1", siege.ZoneIDOuterDistrict, 1, nil, 24); err != nil {
		t.Fatalf("valid ObjHoldDistrict failed: %v", err)
	}

	// 4. ObjDefeatCommander: fails while commander alive, succeeds when deployed commander falls.
	st.Commanders[0].Deployed = true
	st.Commanders[0].Alive = true
	if err := siege.ValidateAndCompletePlayerObjective(&st, siege.ObjIDDefeatCommander, "p1", siege.ZoneIDWallApproach, 1, nil, 25); !errors.Is(err, siege.ErrObjectiveConditionNotMet) {
		t.Fatalf("expected unmet ObjDefeatCommander while commander alive, got %v", err)
	}
	st.Commanders[0].Alive = false
	st.Commanders[0].DefeatedTick = 26
	st.Commanders[0].DefeatedByPlayerID = "p1"
	if err := siege.ValidateAndCompletePlayerObjective(&st, siege.ObjIDDefeatCommander, "p1", siege.ZoneIDWallApproach, 1, nil, 26); err != nil {
		t.Fatalf("valid ObjDefeatCommander failed: %v", err)
	}

	// 5. Phase progression Assault -> Breach -> DistrictCombat -> CitadelAssault -> Resolving -> Withdrawn (morale collapse).
	cBreach := []siege.CombatantSnapshot{{ID: "g1", ZoneID: siege.ZoneIDOuterDistrict, HP: 200, MaxHP: 400, MoraleBP: 7000, Family: ai.FamilyGoblin, IsInvader: true}}
	if _, term, _, _, err := siege.EvaluatePhaseAndResolution(&st, cBreach, 27, true, cfg); err != nil || term || st.Phase != siege.PhaseDistrictCombat {
		t.Fatalf("expected transition to DistrictCombat, got phase=%s term=%v err=%v", st.Phase, term, err)
	}
	cCit := []siege.CombatantSnapshot{{ID: "g1", ZoneID: siege.ZoneIDCitadel, HP: 200, MaxHP: 400, MoraleBP: 7000, Family: ai.FamilyGoblin, IsInvader: true}}
	if _, term, _, _, err := siege.EvaluatePhaseAndResolution(&st, cCit, 28, true, cfg); err != nil || term || st.Phase != siege.PhaseCitadelAssault {
		t.Fatalf("expected transition to CitadelAssault, got phase=%s term=%v err=%v", st.Phase, term, err)
	}
	// Drop goblin morale below withdraw threshold after commander fell -> PhaseWithdrawn (Defended)!
	cLow := []siege.CombatantSnapshot{{ID: "g1", ZoneID: siege.ZoneIDCitadel, HP: 120, MaxHP: 400, MoraleBP: 1500, Family: ai.FamilyGoblin, IsInvader: true}}
	if _, term, out, _, err := siege.EvaluatePhaseAndResolution(&st, cLow, 29, false, cfg); err != nil || !term || st.Phase != siege.PhaseWithdrawn || out != ports.InvasionOutcomeDefended {
		t.Fatalf("expected morale collapse withdrawal, got phase=%s out=%s term=%v err=%v", st.Phase, out, term, err)
	}
	// Terminal phase rejects further objective claims.
	if err := siege.ValidateAndCompletePlayerObjective(&st, siege.ObjIDDefendGate, "p1", siege.ZoneIDMainGate, 1, nil, 30); !errors.Is(err, siege.ErrInvalidPhaseTransition) {
		t.Fatalf("expected ErrInvalidPhaseTransition in terminal phase, got %v", err)
	}

	// 6. Test Defended (zero invaders) and MaxDuration withdrawal on fresh states.
	stDef, _ := mustDefaultSiege(t, ai.FamilyOrc)
	if _, term, out, _, err := siege.EvaluatePhaseAndResolution(&stDef, nil, 20, false, cfg); err != nil || !term || stDef.Phase != siege.PhaseDefended || out != ports.InvasionOutcomeDefended {
		t.Fatalf("expected PhaseDefended with zero invaders, got %s %s %v", stDef.Phase, out, err)
	}
	stTimeout, _ := mustDefaultSiege(t, ai.FamilyOrc)
	cAlive := []siege.CombatantSnapshot{{ID: "g1", ZoneID: siege.ZoneIDWallApproach, HP: 300, MaxHP: 400, MoraleBP: 9000, Family: ai.FamilyOrc, IsInvader: true}}
	if _, term, out, _, err := siege.EvaluatePhaseAndResolution(&stTimeout, cAlive, 10+cfg.SiegeMaxDurationTicks, true, cfg); err != nil || !term || stTimeout.Phase != siege.PhaseWithdrawn || out != ports.InvasionOutcomeDefended {
		t.Fatalf("expected PhaseWithdrawn at SiegeMaxDurationTicks, got %s %s %v", stTimeout.Phase, out, err)
	}

	// 7. Tampered SiegeState validation branches.
	tamperCases := []func(*siege.SiegeState){
		func(s *siege.SiegeState) { s.LayoutID = "" },
		func(s *siege.SiegeState) { s.Phase = "Bogus" },
		func(s *siege.SiegeState) { s.InvaderCasualties = -1 },
		func(s *siege.SiegeState) { s.Supplies.Current = s.Supplies.Max + 1 },
		func(s *siege.SiegeState) { s.Zones[0].ControlProgress = -1 },
		func(s *siege.SiegeState) { s.Structures[0].HP = 0; s.Structures[0].State = siege.StructureIntact },
		func(s *siege.SiegeState) { s.Structures[0].State = siege.StructureDestroyed },
		func(s *siege.SiegeState) { s.Commanders[0].MoraleAuraBonusBP = 99999 },
		func(s *siege.SiegeState) {
			s.EntityRepairs = []siege.EntityRepairCount{{EntityID: "e1", Count: cfg.MaxRepairsPerEntity + 1}}
		},
	}
	for i, tc := range tamperCases {
		bad, _ := mustDefaultSiege(t, ai.FamilyOrc)
		tc(&bad)
		if err := bad.ValidateWithConfig(cfg); err == nil {
			t.Fatalf("tamper case %d unexpectedly passed ValidateWithConfig", i)
		}
	}

	// 8. Enum Codes & Valid invariants.
	for _, r := range []siege.DefenderRole{siege.RolePlayer, siege.RoleGuard, siege.RoleGateDefender, siege.RoleArcher, siege.RoleGuardCaptain, siege.RoleRepairUnit} {
		if !r.Valid() || r.Code() == 0 {
			t.Fatalf("invalid defender role %q", r)
		}
	}
	if siege.DefenderRole("Bogus").Valid() || siege.DefenderRole("Bogus").Code() != 0 {
		t.Fatal("bogus defender role accepted")
	}
	for _, p := range []siege.SiegePhase{siege.PhaseApproach, siege.PhaseAssault, siege.PhaseBreach, siege.PhaseDistrictCombat, siege.PhaseCitadelAssault, siege.PhaseResolving, siege.PhaseDefended, siege.PhaseCaptured, siege.PhaseWithdrawn} {
		if !p.Valid() || p.Code() == 0 {
			t.Fatalf("invalid phase %q", p)
		}
	}
	for _, ws := range []siege.WaveState{siege.WaveScheduled, siege.WaveMobilized, siege.WaveCancelled, siege.WaveExhausted} {
		if !ws.Valid() || ws.Code() == 0 {
			t.Fatalf("invalid wave state %q", ws)
		}
	}
}

func TestDistrictContestationReclaimObjectivesWavesAndValidationExhaustive(t *testing.T) {
	st, cfg := mustDefaultSiege(t, ai.FamilyOrc)

	// Pre-breach destination choices: Orc at WallApproach focuses wall, from ExteriorField aims MainGate.
	if dst := siege.SelectInvaderDestinationZone(st, siege.ZoneIDWallApproach, ai.FamilyOrc); dst != siege.ZoneIDWallApproach {
		t.Fatalf("expected Orc at WallApproach pre-breach to focus WallApproach, got %s", dst)
	}
	if dst := siege.SelectInvaderDestinationZone(st, siege.ZoneIDExteriorField, ai.FamilyGoblin); dst != siege.ZoneIDMainGate {
		t.Fatalf("expected Goblin pre-breach to head toward MainGate, got %s", dst)
	}

	// Open breach via Gate destruction.
	for st.Structures[st.FindStructureIndex(siege.StructIDMainGate)].HP > 0 {
		_, _, _, _, _ = siege.ApplyStructureDamage(&st, siege.StructIDMainGate, 250, 15000, 12, cfg)
	}

	// Contested district: 2 invaders vs 1 defender progresses, then 2 defenders vs 1 invader pushes back,
	// then uncontested defenders reclaim OuterDistrict to DefenderControlled.
	twoInvOneDef := []siege.CombatantSnapshot{
		{ID: "i1", ZoneID: siege.ZoneIDOuterDistrict, HP: 300, MaxHP: 400, MoraleBP: 8000, Family: ai.FamilyOrc, IsInvader: true},
		{ID: "i2", ZoneID: siege.ZoneIDOuterDistrict, HP: 300, MaxHP: 400, MoraleBP: 8000, Family: ai.FamilyOrc, IsInvader: true},
		{ID: "d1", ZoneID: siege.ZoneIDOuterDistrict, HP: 250, MaxHP: 300, IsInvader: false},
	}
	siege.EvaluateDistricts(&st, twoInvOneDef, 15, cfg)
	outerIdx := st.FindZoneIndex(siege.ZoneIDOuterDistrict)
	if st.Zones[outerIdx].ControlProgress <= 0 || st.Zones[outerIdx].ControlState != siege.DistrictContested {
		t.Fatalf("expected contested progress > 0, got state=%s prog=%d", st.Zones[outerIdx].ControlState, st.Zones[outerIdx].ControlProgress)
	}
	oneInvTwoDef := []siege.CombatantSnapshot{
		{ID: "i1", ZoneID: siege.ZoneIDOuterDistrict, HP: 300, MaxHP: 400, MoraleBP: 8000, Family: ai.FamilyOrc, IsInvader: true},
		{ID: "d1", ZoneID: siege.ZoneIDOuterDistrict, HP: 250, MaxHP: 300, IsInvader: false},
		{ID: "d2", ZoneID: siege.ZoneIDOuterDistrict, HP: 250, MaxHP: 300, IsInvader: false},
	}
	prevProg := st.Zones[outerIdx].ControlProgress
	siege.EvaluateDistricts(&st, oneInvTwoDef, 16, cfg)
	if st.Zones[outerIdx].ControlProgress >= prevProg {
		t.Fatalf("expected defenders to push back control progress from %d, got %d", prevProg, st.Zones[outerIdx].ControlProgress)
	}
	onlyDef := []siege.CombatantSnapshot{{ID: "d1", ZoneID: siege.ZoneIDOuterDistrict, HP: 250, MaxHP: 300, IsInvader: false}}
	for tick := uint64(17); tick <= 25; tick++ {
		siege.EvaluateDistricts(&st, onlyDef, tick, cfg)
	}
	if st.Zones[outerIdx].ControlState != siege.DistrictDefenderControlled || st.Zones[outerIdx].ControlProgress != 0 {
		t.Fatalf("expected defenders to reclaim OuterDistrict, got state=%s prog=%d", st.Zones[outerIdx].ControlState, st.Zones[outerIdx].ControlProgress)
	}

	// Capture OuterDistrict -> post-breach destination advances to Citadel; destroy SupplyDepot & Citadel -> objectives complete/fail cleanly.
	onlyInv := []siege.CombatantSnapshot{{ID: "i1", ZoneID: siege.ZoneIDOuterDistrict, HP: 300, MaxHP: 400, MoraleBP: 8000, Family: ai.FamilyOrc, IsInvader: true}}
	for tick := uint64(26); tick <= 35; tick++ {
		siege.EvaluateDistricts(&st, onlyInv, tick, cfg)
	}
	if dst := siege.SelectInvaderDestinationZone(st, siege.ZoneIDOuterDistrict, ai.FamilyOrc); dst != siege.ZoneIDCitadel {
		t.Fatalf("expected Orcs to advance to Citadel after OuterDistrict captured, got %s", dst)
	}
	// Unlock CaptureDistrict / DisruptSupplies / AssaultCitadel and destroy SupplyDepot + Citadel + defeat commander.
	siege.EvaluateObjectives(&st, onlyInv, 36)
	siege.EvaluateObjectives(&st, onlyInv, 37)
	for st.HasOperationalSupplyDepot() {
		_, _, _, _, _ = siege.ApplyStructureDamage(&st, siege.StructIDSupplyDepot, 250, 15000, 38, cfg)
	}
	for st.Structures[st.FindStructureIndex(siege.StructIDCitadelKeep)].HP > 0 {
		_, _, _, _, _ = siege.ApplyStructureDamage(&st, siege.StructIDCitadelKeep, 250, 15000, 39, cfg)
	}
	st.Commanders[0].Deployed = true
	st.Commanders[0].Alive = false
	st.Commanders[0].DefeatedByPlayerID = "p-slayer"
	siege.EvaluateObjectives(&st, onlyInv, 40)
	siege.EvaluateObjectives(&st, onlyInv, 41)
	if st.Objectives[st.FindObjectiveIndex(siege.ObjIDDisruptSupplies)].State != siege.ObjCompleted {
		t.Fatal("expected ObjDisruptSupplies completed after depot destruction")
	}
	if st.Objectives[st.FindObjectiveIndex(siege.ObjIDAssaultCitadel)].State != siege.ObjCompleted {
		t.Fatal("expected ObjAssaultCitadel completed after citadel destruction")
	}
	if st.Objectives[st.FindObjectiveIndex(siege.ObjIDDefeatCommander)].State != siege.ObjCompleted {
		t.Fatal("expected ObjDefeatCommander auto-completed when commander fell")
	}
	if st.Objectives[st.FindObjectiveIndex(siege.ObjIDProtectSupplies)].State != siege.ObjFailed {
		t.Fatal("expected ObjProtectSupplies failed when depot destroyed")
	}
	if st.Objectives[st.FindObjectiveIndex(siege.ObjIDHoldDistrict)].State != siege.ObjFailed {
		t.Fatal("expected ObjHoldDistrict failed when outer district captured")
	}
	if len(st.StructuresDestroyedIDs()) < 3 || len(st.DistrictsCapturedIDs()) == 0 {
		t.Fatalf("expected destroyed structures & captured districts, got %v / %v", st.StructuresDestroyedIDs(), st.DistrictsCapturedIDs())
	}

	// Wave validation & cap error branches + insufficient supply repair rejection.
	stW, cfgW := mustDefaultSiege(t, ai.FamilyGoblin)
	if err := siege.UpsertWave(&stW, siege.SiegeWave{WaveID: "", Archetype: "goblin-skirmisher", Count: 1, EntryZoneID: siege.ZoneIDExteriorField, State: siege.WaveScheduled}, cfgW); err == nil {
		t.Fatal("expected empty wave_id error")
	}
	if err := siege.UpsertWave(&stW, siege.SiegeWave{WaveID: "w-bad-arch", Archetype: "bogus", Count: 1, EntryZoneID: siege.ZoneIDExteriorField, State: siege.WaveScheduled}, cfgW); err == nil {
		t.Fatal("expected bad archetype error")
	}
	if err := siege.UpsertWave(&stW, siege.SiegeWave{WaveID: "w-bad-zone", Archetype: "goblin-skirmisher", Count: 1, EntryZoneID: "zone-none", State: siege.WaveScheduled}, cfgW); err == nil {
		t.Fatal("expected bad entry zone error")
	}
	tightWaveCfg := cfgW
	tightWaveCfg.MaxWaves = 0
	if err := siege.UpsertWave(&stW, siege.SiegeWave{WaveID: "w-cap", Archetype: "goblin-skirmisher", Count: 1, EntryZoneID: siege.ZoneIDExteriorField, State: siege.WaveScheduled}, tightWaveCfg); !errors.Is(err, siege.ErrCapacityExceeded) {
		t.Fatalf("expected ErrCapacityExceeded, got %v", err)
	}
	// Insufficient supplies & full HP repair rejections.
	if _, _, err := siege.ApplyStructureRepair(&stW, siege.StructIDMainGate, "eng", siege.ZoneIDMainGate, 20, cfgW); !errors.Is(err, siege.ErrInvalidCommand) {
		t.Fatalf("expected error repairing full-HP gate, got %v", err)
	}
	_, _, _, _, _ = siege.ApplyStructureDamage(&stW, siege.StructIDMainGate, 80, 10000, 21, cfgW)
	stW.Supplies.Current = 0
	if _, _, err := siege.ApplyStructureRepair(&stW, siege.StructIDMainGate, "eng", siege.ZoneIDMainGate, 22, cfgW); !errors.Is(err, siege.ErrInsufficientSupplies) {
		t.Fatalf("expected ErrInsufficientSupplies, got %v", err)
	}

	// Unsorted collections & reference validation branches in ValidateWithConfig.
	unsortedTests := []func(*siege.SiegeState){
		func(s *siege.SiegeState) { s.Zones[0], s.Zones[1] = s.Zones[1], s.Zones[0] },
		func(s *siege.SiegeState) { s.Connections[0], s.Connections[1] = s.Connections[1], s.Connections[0] },
		func(s *siege.SiegeState) { s.Structures[0], s.Structures[1] = s.Structures[1], s.Structures[0] },
		func(s *siege.SiegeState) { s.Objectives[0], s.Objectives[1] = s.Objectives[1], s.Objectives[0] },
		func(s *siege.SiegeState) { s.Structures[0].ZoneID = "zone-missing" },
		func(s *siege.SiegeState) { s.Objectives[0].ZoneID = "zone-missing" },
		func(s *siege.SiegeState) { s.Objectives[0].TargetStructureID = "str-missing" },
		func(s *siege.SiegeState) { s.Commanders[0].PriorityObjectiveID = "obj-missing" },
		func(s *siege.SiegeState) { s.CompletedTick = 5 },
		func(s *siege.SiegeState) { s.PhaseStartedTick = 0; s.StartedTick = 5 },
		func(s *siege.SiegeState) {
			s.Waves = []siege.SiegeWave{
				{WaveID: "w-2", Archetype: "goblin-skirmisher", Count: 1, EntryZoneID: siege.ZoneIDExteriorField, State: siege.WaveScheduled},
				{WaveID: "w-1", Archetype: "goblin-skirmisher", Count: 1, EntryZoneID: siege.ZoneIDExteriorField, State: siege.WaveScheduled},
			}
		},
	}
	for i, mutate := range unsortedTests {
		bad, _ := mustDefaultSiege(t, ai.FamilyGoblin)
		mutate(&bad)
		if err := bad.ValidateWithConfig(cfgW); err == nil {
			t.Fatalf("unsorted/ref validation case %d unexpectedly passed", i)
		}
	}
}

