package ecosystem_test

import (
	"context"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"

	"ascendra-game/internal/ecosystem"
	"ascendra-game/internal/simulation"
)

func TestScenarioAGoblinGrowthAndCampExpansion(t *testing.T) {
	cfg := ecosystem.DefaultConfig()
	initState := ecosystem.NewDefaultEcosystemState("test-growth", 101)
	res, err := ecosystem.RunEpochs(context.Background(), initState, nil, 15, cfg, 500)
	if err != nil {
		t.Fatalf("RunEpochs failed: %v", err)
	}

	var goblinPop ecosystem.Population
	for _, p := range res.FinalState.Populations {
		if p.PopulationID == "pop-thornveil-goblins" {
			goblinPop = p
		}
	}
	if goblinPop.FreePopulation <= 90 {
		t.Fatalf("expected goblin population to grow above initial 90, got %d", goblinPop.FreePopulation)
	}

	expanded := false
	for _, ev := range res.Events {
		if ev.Type == ecosystem.EventCampExpanded {
			expanded = true
			break
		}
	}
	if !expanded {
		t.Fatalf("expected camp expansion event during goblin growth")
	}
}

func TestPopulationMathEdgeCasesZeroKExtinctOvercrowdedAndResiduals(t *testing.T) {
	cfg := ecosystem.DefaultConfig()

	// 1. Extinct population must NEVER spontaneously generate births.
	stExtinct := ecosystem.NewDefaultEcosystemState("test-extinct", 1)
	for i := range stExtinct.Populations {
		stExtinct.Populations[i].FreePopulation = 0
		stExtinct.Populations[i].MaterializedPopulation = 0
	}
	resExt, err := ecosystem.RunEpochs(context.Background(), stExtinct, nil, 25, cfg, 100)
	if err != nil {
		t.Fatalf("extinct run failed: %v", err)
	}
	freeTot, matTot := ecosystem.TotalEcosystemPopulation(resExt.FinalState)
	if freeTot != 0 || matTot != 0 {
		t.Fatalf("extinct population spontaneously regenerated: free=%d mat=%d", freeTot, matTot)
	}

	// 2. K == 0 must produce zero births and apply scarcity/overcrowding mortality cleanly without div-by-zero.
	stZeroK := ecosystem.NewDefaultEcosystemState("test-zerok", 2)
	cfgNoMigrate := cfg
	cfgNoMigrate.MaxMigrantsPerEpoch = 0
	for i := range stZeroK.Regions {
		stZeroK.Regions[i].CarryingCapacity = 0
	}
	for i := range stZeroK.Populations {
		stZeroK.Populations[i].CarryingCapacity = 0
	}
	beforeFree, _ := ecosystem.TotalEcosystemPopulation(stZeroK)
	nextZeroK, _, err := ecosystem.StepEpoch(stZeroK, nil, cfgNoMigrate)
	if err != nil {
		t.Fatalf("K==0 StepEpoch failed: %v", err)
	}
	afterFree, _ := ecosystem.TotalEcosystemPopulation(nextZeroK)
	if afterFree >= beforeFree {
		t.Fatalf("expected population decline when K==0: before=%d after=%d", beforeFree, afterFree)
	}

	// 3. Overcrowded population (N > K) produces zero births and declines toward K.
	stOver := ecosystem.NewDefaultEcosystemState("test-over", 3)
	stOver.Populations[1].FreePopulation = 800
	stOver.Populations[1].CarryingCapacity = 400
	nextOver, _, err := ecosystem.StepEpoch(stOver, nil, cfgNoMigrate)
	if err != nil {
		t.Fatalf("overcrowded StepEpoch failed: %v", err)
	}
	if nextOver.Populations[1].FreePopulation >= 800 {
		t.Fatalf("expected overcrowded population to decline from 800, got %d", nextOver.Populations[1].FreePopulation)
	}

	// 4. Small population residual accumulator prevents permanent integer-truncation stagnation.
	stSmall := ecosystem.NewDefaultEcosystemState("test-small-residual", 4)
	stSmall.Populations[1].FreePopulation = 3
	stSmall.Populations[1].MortalityRateBP = 0
	stSmall.Populations[1].GrowthRateBP = 1200 // 3 * 0.12 = 0.36/epoch -> without residual would stay 3 forever!
	resSmall, err := ecosystem.RunEpochs(context.Background(), stSmall, nil, 12, cfgNoMigrate, 100)
	if err != nil {
		t.Fatalf("small residual run failed: %v", err)
	}
	if resSmall.FinalState.Populations[1].FreePopulation <= 3 {
		t.Fatalf("expected serializable residual accumulator to grow small population above 3, got %d", resSmall.FinalState.Populations[1].FreePopulation)
	}
}

func TestResourceConservationScarcityAndRegeneration(t *testing.T) {
	cfg := ecosystem.DefaultConfig()
	cfg.MaxMigrantsPerEpoch = 0
	st := ecosystem.NewDefaultEcosystemState("test-resources", 5)

	// Drain Thornveil food to scarcity and verify depletion -> regeneration events and exact bounds.
	for i := range st.Regions {
		if st.Regions[i].RegionID == ecosystem.RegionThornveilForest {
			st.Regions[i].Resources.Food = ecosystem.ResourceSlot{
				Amount:          50,
				MaxCapacity:     500,
				RegenPerEpoch:   30,
				RegenRateBP:     500,
				ExtractionLimit: 50,
			}
		}
	}
	next, evs, err := ecosystem.StepEpoch(st, nil, cfg)
	if err != nil {
		t.Fatalf("StepEpoch scarcity failed: %v", err)
	}
	// Verify food was depleted then regenerated cleanly within MaxCapacity, and goblin scarcity > 0.
	var goblin ecosystem.Population
	for _, p := range next.Populations {
		if p.PopulationID == "pop-thornveil-goblins" {
			goblin = p
		}
	}
	if goblin.ScarcityBP == 0 {
		t.Fatalf("expected positive ScarcityBP when food supply (50) < demand")
	}
	sawDepleted := false
	sawRecovered := false
	for _, ev := range evs {
		if ev.Type == ecosystem.EventResourceDepleted && ev.TargetID == "food" {
			sawDepleted = true
		}
		if ev.Type == ecosystem.EventResourceRegenerated && ev.TargetID == "food" {
			sawRecovered = true
		}
	}
	if !sawDepleted || !sawRecovered {
		t.Fatalf("expected food depletion and regeneration events (depleted=%v recovered=%v)", sawDepleted, sawRecovered)
	}

	// Verify resource never exceeds MaxCapacity even with CmdAdjustResource.
	capped, _, err := ecosystem.StepEpoch(next, []ecosystem.Command{
		{Kind: ecosystem.CmdAdjustResource, Epoch: next.Epoch + 1, RegionID: ecosystem.RegionThornveilForest, ResourceName: "food", Delta: 100000},
	}, cfg)
	if err != nil {
		t.Fatalf("CmdAdjustResource failed: %v", err)
	}
	for _, r := range capped.Regions {
		if r.Resources.Food.Amount > r.Resources.Food.MaxCapacity {
			t.Fatalf("resource exceeded MaxCapacity: %d > %d", r.Resources.Food.Amount, r.Resources.Food.MaxCapacity)
		}
	}
}

func TestScenarioBScarcityMigrationAndExactPopulationConservation(t *testing.T) {
	cfg := ecosystem.DefaultConfig()
	st := ecosystem.NewScarcityMigrationState("test-migration", 202)
	// Isolate migration conservation cleanly by zeroing births and mortality for 1 epoch.
	stPure := st.Clone()
	for i := range stPure.Populations {
		stPure.Populations[i].GrowthRateBP = 0
		stPure.Populations[i].MortalityRateBP = 0
	}
	cfgPure := cfg
	cfgPure.StarvationMortalityBP = 0
	cfgPure.OvercrowdingMortalityBP = 0
	cfgPure.CompetitionAttritionBP = 0

	beforeFree, beforeMat := ecosystem.TotalEcosystemPopulation(stPure)
	next, evs, err := ecosystem.StepEpoch(stPure, nil, cfgPure)
	if err != nil {
		t.Fatalf("pure migration StepEpoch failed: %v", err)
	}
	afterFree, afterMat := ecosystem.TotalEcosystemPopulation(next)
	if beforeFree != afterFree || beforeMat != afterMat {
		t.Fatalf("migration violated exact population conservation: before=(%d,%d) after=(%d,%d)", beforeFree, beforeMat, afterFree, afterMat)
	}

	migratedCount := int64(0)
	for _, ev := range evs {
		if ev.Type == ecosystem.EventPopulationMigrated {
			migratedCount += ev.Amount
		}
	}
	if migratedCount <= 0 {
		t.Fatalf("expected positive migration under severe scarcity")
	}

	// Also test full multi-epoch Scenario B with natural growth/mortality enabled.
	resB, err := ecosystem.RunEpochs(context.Background(), st, nil, 10, cfg, 256)
	if err != nil {
		t.Fatalf("Scenario B run failed: %v", err)
	}
	if len(resB.FinalState.Populations) <= 2 {
		t.Fatalf("expected migrants to recolonize an adjacent region (populations=%d)", len(resB.FinalState.Populations))
	}
}

func TestSimultaneousTwoWayMigrationNoDoubleTransfer(t *testing.T) {
	cfg := ecosystem.DefaultConfig()
	cfg.StarvationMortalityBP = 0
	cfg.OvercrowdingMortalityBP = 0
	cfg.CompetitionAttritionBP = 0
	cfg.MigrationThresholdBP = 1000

	st := ecosystem.NewDefaultEcosystemState("test-sim-migrate", 77)
	// Both Thornveil and Ironfang overcrowded, while Valewatch has open carrying capacity headroom.
	for i := range st.Regions {
		if st.Regions[i].RegionID == ecosystem.RegionThornveilForest || st.Regions[i].RegionID == ecosystem.RegionIronfangFrontier {
			st.Regions[i].CarryingCapacity = 150
		}
		if st.Regions[i].RegionID == ecosystem.RegionValewatchVale {
			st.Regions[i].FactionInfluences = []ecosystem.FactionInfluence{}
		}
	}
	for i := range st.Populations {
		st.Populations[i].GrowthRateBP = 0
		st.Populations[i].MortalityRateBP = 0
		st.Populations[i].FreePopulation = 200
		st.Populations[i].CarryingCapacity = 150
	}
	before, _ := ecosystem.TotalEcosystemPopulation(st)
	next, evs, err := ecosystem.StepEpoch(st, nil, cfg)
	if err != nil {
		t.Fatalf("simultaneous migration failed: %v", err)
	}
	after, _ := ecosystem.TotalEcosystemPopulation(next)
	if before != after {
		t.Fatalf("simultaneous migration violated conservation: %d != %d", before, after)
	}
	migrations := 0
	for _, ev := range evs {
		if ev.Type == ecosystem.EventPopulationMigrated {
			migrations++
		}
	}
	if migrations < 2 {
		t.Fatalf("expected both pressured populations to plan migration in same epoch, got %d", migrations)
	}
}

func TestCampLifecycleDestroyedRestrictionsAndLimits(t *testing.T) {
	cfg := ecosystem.DefaultConfig()
	st := ecosystem.NewDefaultEcosystemState("test-camps", 303)

	// Destroy Thornveil camp and verify it CANNOT materialize groups and blocks immediate recreation.
	next, evs, err := ecosystem.StepEpoch(st, []ecosystem.Command{
		{Kind: ecosystem.CmdDestroyCamp, Epoch: 1, CampID: "camp-thornveil-warren"},
	}, cfg)
	if err != nil {
		t.Fatalf("CmdDestroyCamp failed: %v", err)
	}
	destroyedEvent := false
	for _, ev := range evs {
		if ev.Type == ecosystem.EventCampDestroyed && ev.EntityID == "camp-thornveil-warren" {
			destroyedEvent = true
		}
	}
	if !destroyedEvent {
		t.Fatalf("expected EventCampDestroyed")
	}

	// Materialization from destroyed camp MUST fail with ErrCampUnavailable.
	if _, _, err := ecosystem.ReserveForMaterialization(&next, "camp-thornveil-warren", "goblin-raider-pack", 1); !errors.Is(err, ecosystem.ErrCampUnavailable) {
		t.Fatalf("expected ErrCampUnavailable for destroyed camp, got %v", err)
	}

	// Immediate CmdEstablishCamp MUST fail while camp recreation cooldown is active.
	if _, _, err := ecosystem.StepEpoch(next, []ecosystem.Command{
		{Kind: ecosystem.CmdEstablishCamp, Epoch: 2, PopulationID: "pop-thornveil-goblins"},
	}, cfg); !errors.Is(err, ecosystem.ErrCampUnavailable) {
		t.Fatalf("expected ErrCampUnavailable during camp cooldown, got %v", err)
	}

	// After cooldown elapses, camp can be established again cleanly.
	afterCD, err := ecosystem.RunEpochs(context.Background(), next, nil, 1+cfg.CampRecreateCooldownEpochs+1, cfg, 100)
	if err != nil {
		t.Fatalf("post-cooldown run failed: %v", err)
	}
	activeThornCamps := 0
	for _, c := range afterCD.FinalState.Camps {
		if c.RegionID == ecosystem.RegionThornveilForest && c.State != ecosystem.CampDestroyed && c.State != ecosystem.CampAbandoned {
			activeThornCamps++
		}
	}
	if activeThornCamps == 0 {
		t.Fatalf("expected organic or allowed camp recreation after cooldown elapsed")
	}

	// Test camp abandonment under sustained starvation.
	stStarve := ecosystem.NewDefaultEcosystemState("test-starve-camp", 304)
	cfgStarve := cfg
	cfgStarve.MaxMigrantsPerEpoch = 0
	cfgStarve.CampAbandonStarveEpochs = 2
	for i := range stStarve.Regions {
		if stStarve.Regions[i].RegionID == ecosystem.RegionThornveilForest {
			stStarve.Regions[i].Resources.Food = ecosystem.ResourceSlot{Amount: 0, MaxCapacity: 100, RegenPerEpoch: 0, RegenRateBP: 0, ExtractionLimit: 0}
			stStarve.Regions[i].Resources.Water = ecosystem.ResourceSlot{Amount: 0, MaxCapacity: 100, RegenPerEpoch: 0, RegenRateBP: 0, ExtractionLimit: 0}
		}
	}
	for i := range stStarve.Camps {
		if stStarve.Camps[i].CampID == "camp-thornveil-warren" {
			stStarve.Camps[i].Reserves = 0
		}
	}
	resStarve, err := ecosystem.RunEpochs(context.Background(), stStarve, nil, 4, cfgStarve, 100)
	if err != nil {
		t.Fatalf("starvation run failed: %v", err)
	}
	abandoned := false
	for _, ev := range resStarve.Events {
		if ev.Type == ecosystem.EventCampAbandoned && ev.EntityID == "camp-thornveil-warren" {
			abandoned = true
		}
	}
	if !abandoned {
		t.Fatalf("expected camp-thornveil-warren to transition to Abandoned under sustained starvation")
	}
}

func TestTerritorialCompetitionHostileVsNeutralCoexistence(t *testing.T) {
	cfg := ecosystem.DefaultConfig()
	cfg.MaxMigrantsPerEpoch = 0

	// 1. Hostile rivalry (Scenario C): Thornveil Goblins vs Ironfang Orcs incur territorial conflict losses.
	stHostile := ecosystem.NewTerritorialDisputeState("test-hostile-dispute", 401)
	resH, err := ecosystem.RunEpochs(context.Background(), stHostile, nil, 8, cfg, 256)
	if err != nil {
		t.Fatalf("hostile dispute run failed: %v", err)
	}
	sawRivalryLoss := false
	sawInfluenceChange := false
	for _, ev := range resH.Events {
		if ev.Type == ecosystem.EventPopulationDeclined && strings.Contains(ev.Detail, "Territorial rivalry") {
			sawRivalryLoss = true
		}
		if ev.Type == ecosystem.EventTerritorialInfluenceChanged {
			sawInfluenceChange = true
		}
	}
	if !sawRivalryLoss || !sawInfluenceChange {
		t.Fatalf("expected territorial rivalry losses and influence change (rivalry=%v inf=%v)", sawRivalryLoss, sawInfluenceChange)
	}

	// 2. Neutral coexistence: Cinder Goblins & Ironfang Orcs have explicit StanceNeutral -> ZERO rivalry losses!
	stNeutral := ecosystem.NewTerritorialDisputeState("test-neutral-coexist", 402)
	for i := range stNeutral.Populations {
		if stNeutral.Populations[i].PopulationID == "pop-thornveil-goblins" {
			stNeutral.Populations[i].FactionID = ecosystem.FactionCinderGoblins
		}
	}
	for i := range stNeutral.Camps {
		if stNeutral.Camps[i].CampID == "camp-thornveil-warren" {
			stNeutral.Camps[i].FactionID = ecosystem.FactionCinderGoblins
		}
	}
	resN, err := ecosystem.RunEpochs(context.Background(), stNeutral, nil, 6, cfg, 256)
	if err != nil {
		t.Fatalf("neutral coexistence run failed: %v", err)
	}
	for _, ev := range resN.Events {
		if ev.Type == ecosystem.EventPopulationDeclined && strings.Contains(ev.Detail, "Territorial rivalry") {
			t.Fatalf("neutral factions must NOT incur automatic territorial rivalry losses: %+v", ev)
		}
	}
}

func TestRegionalThreatHysteresisAndThrottledEventIntent(t *testing.T) {
	cfg := ecosystem.DefaultConfig()
	st := ecosystem.NewRisingThreatState("test-threat", 501)
	res, err := ecosystem.RunEpochs(context.Background(), st, nil, 12, cfg, 256)
	if err != nil {
		t.Fatalf("rising threat run failed: %v", err)
	}

	var ironfang ecosystem.Region
	for _, r := range res.FinalState.Regions {
		if r.RegionID == ecosystem.RegionIronfangFrontier {
			ironfang = r
		}
	}
	if ironfang.ThreatLevel != ecosystem.ThreatCritical {
		t.Fatalf("expected Ironfang Frontier to reach ThreatCritical, got %s (score=%d)", ironfang.ThreatLevel, ironfang.ThreatScore)
	}

	// Verify Critical intent is throttled by EventIntentCooldownEpochs (never spammed every epoch).
	intentCount := 0
	for _, ev := range res.Events {
		if ev.RegionID == ecosystem.RegionIronfangFrontier && strings.Contains(ev.Detail, "intent=InvasionPressure") {
			intentCount++
		}
	}
	if intentCount == 0 || intentCount > 4 {
		t.Fatalf("expected throttled critical event intents in [1..4] over 12 epochs, got %d", intentCount)
	}

	// Verify hysteresis deadband: score in (ThreatCriticalExit=1150, ThreatCriticalEnter=1400) stays Critical
	// when already Critical, rather than oscillating down on small fluctuations.
	stDeadband := res.FinalState.Clone()
	for i := range stDeadband.Populations {
		if stDeadband.Populations[i].PopulationID == "pop-ironfang-orcs" {
			stDeadband.Populations[i].FreePopulation = 205 // yields ~1250 threat (inside hysteresis deadband)
		}
	}
	nextDB, _, err := ecosystem.StepEpoch(stDeadband, nil, cfg)
	if err != nil {
		t.Fatalf("deadband step failed: %v", err)
	}
	for _, r := range nextDB.Regions {
		if r.RegionID == ecosystem.RegionIronfangFrontier {
			if r.ThreatScore > cfg.ThreatCriticalExit && r.ThreatScore < cfg.ThreatCriticalEnter && r.ThreatLevel != ecosystem.ThreatCritical {
				t.Fatalf("hysteresis violated: dropped out of Critical at score %d (exit=%d)", r.ThreatScore, cfg.ThreatCriticalExit)
			}
		}
	}
}

func TestMaterializationAccountingAndZeroResurrection(t *testing.T) {
	st := ecosystem.NewDefaultEcosystemState("test-mat", 601)
	initFree, initMat := ecosystem.TotalEcosystemPopulation(st)

	// Reserve 2 goblin raider packs (2 * 6 = 12 individuals).
	ticket, evMat, err := ecosystem.ReserveForMaterialization(&st, "camp-thornveil-warren", "goblin-raider-pack", 2)
	if err != nil {
		t.Fatalf("ReserveForMaterialization failed: %v", err)
	}
	if ticket.ContingentSize != 12 || evMat.Type != ecosystem.EventCreatureGroupMaterialized {
		t.Fatalf("unexpected ticket/event: %+v / %+v", ticket, evMat)
	}
	midFree, midMat := ecosystem.TotalEcosystemPopulation(st)
	if midFree != initFree-12 || midMat != initMat+12 || midFree+midMat != initFree+initMat {
		t.Fatalf("materialization failed conservation: init=(%d,%d) mid=(%d,%d)", initFree, initMat, midFree, midMat)
	}

	// Reconcile partial survival (50% HP -> 6 survivors, 6 losses).
	sum, evDemat, err := ecosystem.ReconcileDematerialization(&st, ticket, 400, 800, false)
	if err != nil {
		t.Fatalf("ReconcileDematerialization failed: %v", err)
	}
	if sum.Survivors != 6 || sum.Losses != 6 || evDemat.Type != ecosystem.EventCreatureGroupDematerialized {
		t.Fatalf("unexpected dematerialization summary: %+v", sum)
	}
	endFree, endMat := ecosystem.TotalEcosystemPopulation(st)
	if endFree != initFree-6 || endMat != 0 {
		t.Fatalf("post-dematerialization accounting wrong: free=%d mat=%d", endFree, endMat)
	}

	// Double reconciliation MUST be rejected (prevents resurrection/duplication).
	if _, _, err := ecosystem.ReconcileDematerialization(&st, ticket, 400, 800, false); !errors.Is(err, ecosystem.ErrInvalidState) {
		t.Fatalf("expected ErrInvalidState on double reconciliation, got %v", err)
	}

	// Defeated group MUST return 0 survivors (zero resurrection).
	ticket2, _, err := ecosystem.ReserveForMaterialization(&st, "camp-ironfang-bastion", "orc-berserker", 2)
	if err != nil {
		t.Fatalf("second reserve failed: %v", err)
	}
	sumDead, _, err := ecosystem.ReconcileDematerialization(&st, ticket2, 0, 960, true)
	if err != nil {
		t.Fatalf("dead reconciliation failed: %v", err)
	}
	if sumDead.Survivors != 0 || sumDead.Losses != ticket2.ContingentSize {
		t.Fatalf("defeated group resurrected units: %+v", sumDead)
	}

	// Family mismatch rejected (orc archetype from goblin camp).
	if _, _, err := ecosystem.ReserveForMaterialization(&st, "camp-thornveil-warren", "orc-vanguard", 1); !errors.Is(err, ecosystem.ErrInvalidCommand) {
		t.Fatalf("expected ErrInvalidCommand for family mismatch, got %v", err)
	}

	// Insufficient free population rejected cleanly without mutating state.
	if _, _, err := ecosystem.ReserveForMaterialization(&st, "camp-thornveil-warren", "goblin-raider-pack", 100); !errors.Is(err, ecosystem.ErrInsufficientPopulation) {
		t.Fatalf("expected ErrInsufficientPopulation, got %v", err)
	}
}

func TestDeterminismSnapshotSafetyAtomicErrorsAndLimits(t *testing.T) {
	cfg := ecosystem.DefaultConfig()
	initState := ecosystem.NewDefaultEcosystemState("test-det-snap", 707)

	// 1. Deterministic replay (Run A == Run B).
	resA, err := ecosystem.RunEpochs(context.Background(), initState, nil, 25, cfg, 500)
	if err != nil {
		t.Fatalf("Run A failed: %v", err)
	}
	resB, err := ecosystem.RunEpochs(context.Background(), initState, nil, 25, cfg, 500)
	if err != nil {
		t.Fatalf("Run B failed: %v", err)
	}
	if resA.FinalChecksum != resB.FinalChecksum || !reflect.DeepEqual(resA.Events, resB.Events) {
		t.Fatalf("ecosystem non-determinism detected")
	}

	// 2. Snapshot at epoch K=10 -> restore -> continue 11..25 matches continuous 0..25 (state + subsequent events!).
	atK, err := ecosystem.RunEpochs(context.Background(), initState, nil, 10, cfg, 500)
	if err != nil {
		t.Fatalf("run to K failed: %v", err)
	}
	raw, err := atK.FinalState.MarshalSnapshot(cfg)
	if err != nil {
		t.Fatalf("MarshalSnapshot failed: %v", err)
	}
	restored, err := ecosystem.UnmarshalSnapshot(raw, cfg)
	if err != nil {
		t.Fatalf("UnmarshalSnapshot failed: %v", err)
	}
	cont, err := ecosystem.RunEpochs(context.Background(), restored, nil, 25, cfg, 500)
	if err != nil {
		t.Fatalf("continuation failed: %v", err)
	}
	if cont.FinalChecksum != resA.FinalChecksum {
		t.Fatalf("snapshot continuation checksum mismatch: %s != %s", cont.FinalChecksum, resA.FinalChecksum)
	}
	var expectedAfterK []ecosystem.EcologicalEvent
	for _, ev := range resA.Events {
		if ev.Epoch > 10 {
			expectedAfterK = append(expectedAfterK, ev)
		}
	}
	if !reflect.DeepEqual(expectedAfterK, cont.Events) {
		t.Fatalf("snapshot continuation events diverged")
	}

	// 3. Oversized snapshot rejected BEFORE JSON decode.
	smallCfg := cfg
	smallCfg.MaxSnapshotBytes = len(raw) - 1
	if _, err := ecosystem.UnmarshalSnapshot(raw, smallCfg); !errors.Is(err, simulation.ErrSnapshotTooLarge) {
		t.Fatalf("expected ErrSnapshotTooLarge, got %v", err)
	}

	// 4. Tampered snapshot rejected.
	tampered := []byte(strings.Replace(string(raw), `"epoch":10`, `"epoch":11`, 1))
	if _, err := ecosystem.UnmarshalSnapshot(tampered, cfg); !errors.Is(err, simulation.ErrSnapshotChecksumMismatch) {
		t.Fatalf("expected ErrSnapshotChecksumMismatch, got %v", err)
	}

	// 5. Invalid references (non-existent adjacent region) rejected explicitly.
	badRef := initState.Clone()
	badRef.Regions[0].AdjacentRegions = append(badRef.Regions[0].AdjacentRegions, "region-zzz-does-not-exist")
	if err := badRef.Validate(cfg); !errors.Is(err, ecosystem.ErrInvalidReference) {
		t.Fatalf("expected ErrInvalidReference for missing adjacent region, got %v", err)
	}

	// 6. Atomic failure on epoch mismatch, unknown command, overflow -> original state untouched.
	beforeSum, _ := initState.Checksum(cfg)
	if _, _, err := ecosystem.StepEpoch(initState, []ecosystem.Command{{Kind: ecosystem.CmdDestroyCamp, Epoch: 99, CampID: "x"}}, cfg); !errors.Is(err, ecosystem.ErrEpochMismatch) {
		t.Fatalf("expected ErrEpochMismatch, got %v", err)
	}
	stOverflow := initState.Clone()
	stOverflow.Epoch = math.MaxUint64
	if _, _, err := ecosystem.StepEpoch(stOverflow, nil, cfg); !errors.Is(err, ecosystem.ErrNumericOverflow) {
		t.Fatalf("expected ErrNumericOverflow on MaxUint64 epoch, got %v", err)
	}
	afterSum, _ := initState.Checksum(cfg)
	if beforeSum != afterSum {
		t.Fatalf("failed StepEpoch mutated caller state")
	}

	// 7. Canonical command ordering independence.
	cmdsA := []ecosystem.Command{
		{Kind: ecosystem.CmdApplyConflictLoss, Epoch: 1, PopulationID: "pop-ironfang-orcs", Delta: 5},
		{Kind: ecosystem.CmdAdjustResource, Epoch: 1, RegionID: ecosystem.RegionThornveilForest, ResourceName: "wood", Delta: -50},
	}
	cmdsB := []ecosystem.Command{cmdsA[1], cmdsA[0]}
	sA, _, err := ecosystem.StepEpoch(initState, cmdsA, cfg)
	if err != nil {
		t.Fatalf("cmdsA failed: %v", err)
	}
	sB, _, err := ecosystem.StepEpoch(initState, cmdsB, cfg)
	if err != nil {
		t.Fatalf("cmdsB failed: %v", err)
	}
	sumA, _ := sA.Checksum(cfg)
	sumB, _ := sB.Checksum(cfg)
	if sumA != sumB {
		t.Fatalf("command ordering affected ecosystem checksum: %s != %s", sumA, sumB)
	}
}

func TestEcosystemValidationConfigBoundsAndErrorPaths(t *testing.T) {
	cfg := ecosystem.DefaultConfig()
	base := ecosystem.NewDefaultEcosystemState("test-val", 11)

	// Invalid config variants.
	badVer := cfg
	badVer.Version = 99
	if err := badVer.Validate(); !errors.Is(err, ecosystem.ErrInvalidConfig) {
		t.Fatalf("expected ErrInvalidConfig for bad version, got %v", err)
	}
	badHyst := cfg
	badHyst.ThreatGrowingExit = badHyst.ThreatGrowingEnter
	if err := badHyst.Validate(); !errors.Is(err, ecosystem.ErrInvalidConfig) {
		t.Fatalf("expected ErrInvalidConfig for broken hysteresis, got %v", err)
	}
	badCaps := cfg
	badCaps.MaxRegions = 0
	if err := badCaps.Validate(); !errors.Is(err, ecosystem.ErrInvalidConfig) {
		t.Fatalf("expected ErrInvalidConfig for zero MaxRegions, got %v", err)
	}
	badSnap := cfg
	badSnap.MaxSnapshotBytes = 0
	if err := badSnap.Validate(); !errors.Is(err, ecosystem.ErrInvalidConfig) {
		t.Fatalf("expected ErrInvalidConfig for zero MaxSnapshotBytes, got %v", err)
	}

	// State validation edge cases: oversized ID, self-adjacent region, bad influence sum,
	// missing faction/population reference, bad resource amount, bad camp bounds.
	longID := base.Clone()
	longID.SimulationID = strings.Repeat("a", cfg.MaxIdentifierLength+1)
	if err := longID.Validate(cfg); !errors.Is(err, ecosystem.ErrInvalidState) {
		t.Fatalf("expected ErrInvalidState for oversized SimulationID, got %v", err)
	}

	selfAdj := base.Clone()
	selfAdj.Regions[0].AdjacentRegions = []string{selfAdj.Regions[0].RegionID}
	if err := selfAdj.Validate(cfg); !errors.Is(err, ecosystem.ErrInvalidReference) {
		t.Fatalf("expected ErrInvalidReference for self-adjacent region, got %v", err)
	}

	badInf := base.Clone()
	badInf.Regions[0].FactionInfluences = []ecosystem.FactionInfluence{
		{FactionID: ecosystem.FactionIronfangOrcs, InfluenceBP: 6000},
		{FactionID: ecosystem.FactionThornGoblins, InfluenceBP: 5000},
	}
	if err := badInf.Validate(cfg); !errors.Is(err, ecosystem.ErrInvalidState) {
		t.Fatalf("expected ErrInvalidState for influence sum > 10000, got %v", err)
	}

	badRes := base.Clone()
	badRes.Regions[0].Resources.Ore.Amount = badRes.Regions[0].Resources.Ore.MaxCapacity + 1
	if err := badRes.Validate(cfg); !errors.Is(err, ecosystem.ErrInvalidState) {
		t.Fatalf("expected ErrInvalidState for resource amount > MaxCapacity, got %v", err)
	}

	badCampRef := base.Clone()
	badCampRef.Camps[0].PopulationID = "pop-missing"
	if err := badCampRef.Validate(cfg); !errors.Is(err, ecosystem.ErrInvalidReference) {
		t.Fatalf("expected ErrInvalidReference for missing camp population, got %v", err)
	}

	// Command rejections: too many commands, unknown resource, negative conflict loss, unknown camp destroy.
	tooMany := make([]ecosystem.Command, cfg.MaxCommandsPerEpoch+1)
	for i := range tooMany {
		tooMany[i] = ecosystem.Command{Kind: ecosystem.CmdAdjustResource, Epoch: 1, RegionID: ecosystem.RegionThornveilForest, ResourceName: "food", Delta: 1}
	}
	if _, _, err := ecosystem.StepEpoch(base, tooMany, cfg); !errors.Is(err, ecosystem.ErrCapacityExceeded) {
		t.Fatalf("expected ErrCapacityExceeded for too many commands, got %v", err)
	}
	if _, _, err := ecosystem.StepEpoch(base, []ecosystem.Command{{Kind: ecosystem.CmdAdjustResource, Epoch: 1, RegionID: ecosystem.RegionThornveilForest, ResourceName: "mithril", Delta: 1}}, cfg); !errors.Is(err, ecosystem.ErrInvalidCommand) {
		t.Fatalf("expected ErrInvalidCommand for unknown resource, got %v", err)
	}
	if _, _, err := ecosystem.StepEpoch(base, []ecosystem.Command{{Kind: ecosystem.CmdApplyConflictLoss, Epoch: 1, PopulationID: "pop-ironfang-orcs", Delta: -5}}, cfg); !errors.Is(err, ecosystem.ErrInvalidCommand) {
		t.Fatalf("expected ErrInvalidCommand for negative conflict loss, got %v", err)
	}
	if _, _, err := ecosystem.StepEpoch(base, []ecosystem.Command{{Kind: ecosystem.CmdDestroyCamp, Epoch: 1, CampID: "camp-missing"}}, cfg); !errors.Is(err, ecosystem.ErrUnknownEntity) {
		t.Fatalf("expected ErrUnknownEntity for missing camp destroy, got %v", err)
	}

	// UnitPopulationWeight covers all 6 profiles and rejects count <= 0 / overflow.
	for _, arch := range []string{"goblin-skirmisher", "goblin-raider-pack", "goblin-taskmaster", "orc-vanguard", "orc-berserker", "orc-warchief"} {
		w, err := ecosystem.UnitPopulationWeight(arch, 2)
		if err != nil || w <= 0 {
			t.Fatalf("UnitPopulationWeight(%q, 2) failed: w=%d err=%v", arch, w, err)
		}
	}
	if _, err := ecosystem.UnitPopulationWeight("orc-vanguard", 0); !errors.Is(err, ecosystem.ErrInvalidCommand) {
		t.Fatalf("expected ErrInvalidCommand for count 0, got %v", err)
	}
	if _, err := ecosystem.UnitPopulationWeight("orc-vanguard", math.MaxInt64); !errors.Is(err, ecosystem.ErrNumericOverflow) {
		t.Fatalf("expected ErrNumericOverflow for MaxInt64 count, got %v", err)
	}

	// Verify GetStance symmetric/default/self/unknown resolution.
	if ecosystem.GetStance(base.Factions, ecosystem.FactionIronfangOrcs, ecosystem.FactionIronfangOrcs) != ecosystem.StanceAllied {
		t.Fatal("same faction must be Allied")
	}
	if ecosystem.GetStance(base.Factions, ecosystem.FactionCinderGoblins, ecosystem.FactionIronfangOrcs) != ecosystem.StanceNeutral {
		t.Fatal("Cinder Goblins and Ironfang Orcs must be Neutral")
	}
	if ecosystem.GetStance(base.Factions, "unknown-a", "unknown-b") != ecosystem.StanceNeutral {
		t.Fatal("unknown factions must default to Neutral")
	}
	if ecosystem.GetStance(base.Factions, "unknown-a", ecosystem.FactionIronfangOrcs) != ecosystem.StanceHostile {
		t.Fatal("Ironfang Orcs default stance toward unknown must be Hostile")
	}

	// Verify all 5 resource names in CmdAdjustResource and strict CmdEstablishCamp error paths.
	for _, resName := range []string{"food", "wood", "stone", "ore", "water"} {
		if _, _, err := ecosystem.StepEpoch(base, []ecosystem.Command{
			{Kind: ecosystem.CmdAdjustResource, Epoch: 1, RegionID: ecosystem.RegionThornveilForest, ResourceName: resName, Delta: -10},
		}, cfg); err != nil {
			t.Fatalf("CmdAdjustResource(%s) failed: %v", resName, err)
		}
	}
	// Strict CmdEstablishCamp fails cleanly when wood is insufficient or population too small.
	lowWood := base.Clone()
	lowWood.Regions[1].Resources.Wood.Amount = 0
	if _, _, err := ecosystem.StepEpoch(lowWood, []ecosystem.Command{
		{Kind: ecosystem.CmdEstablishCamp, Epoch: 1, PopulationID: "pop-thornveil-goblins"},
	}, cfg); !errors.Is(err, ecosystem.ErrCampUnavailable) {
		t.Fatalf("expected ErrCampUnavailable for insufficient wood, got %v", err)
	}
	lowPop := base.Clone()
	lowPop.Populations[1].FreePopulation = 5
	if _, _, err := ecosystem.StepEpoch(lowPop, []ecosystem.Command{
		{Kind: ecosystem.CmdEstablishCamp, Epoch: 1, PopulationID: "pop-thornveil-goblins"},
	}, cfg); !errors.Is(err, ecosystem.ErrInsufficientPopulation) {
		t.Fatalf("expected ErrInsufficientPopulation for strict establish camp, got %v", err)
	}

	// Verify RunEpochs respects context cancellation cleanly.
	cancelCtx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ecosystem.RunEpochs(cancelCtx, base, nil, 10, cfg, 10); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}

	// Verify threat downgrade path across Critical -> Hostile -> Growing -> Stable when hostile pops vanish.
	crit := ecosystem.NewRisingThreatState("test-threat-down", 510)
	resUp, err := ecosystem.RunEpochs(context.Background(), crit, nil, 4, cfg, 64)
	if err != nil {
		t.Fatalf("rising threat setup failed: %v", err)
	}
	cooled := resUp.FinalState.Clone()
	for i := range cooled.Populations {
		if cooled.Populations[i].RegionID == ecosystem.RegionIronfangFrontier {
			cooled.Populations[i].FreePopulation = 0
		}
	}
	for i := range cooled.Camps {
		if cooled.Camps[i].RegionID == ecosystem.RegionIronfangFrontier {
			cooled.Camps[i].State = ecosystem.CampDestroyed
		}
	}
	resDown, err := ecosystem.RunEpochs(context.Background(), cooled, nil, cooled.Epoch+8, cfg, 64)
	if err != nil {
		t.Fatalf("threat cooldown run failed: %v", err)
	}
	if resDown.FinalState.Regions[0].ThreatLevel != ecosystem.ThreatStable {
		t.Fatalf("expected Ironfang threat to cool back to Stable after wipeout, got %s", resDown.FinalState.Regions[0].ThreatLevel)
	}

	// Verify CanonicalizeCommands deterministic tie-breaks across all command fields.
	unsortedCmds := []ecosystem.Command{
		{Kind: ecosystem.CmdAdjustResource, Epoch: 1, RegionID: "r2", ResourceName: "wood", Delta: 5},
		{Kind: ecosystem.CmdAdjustResource, Epoch: 1, RegionID: "r1", ResourceName: "wood", Delta: 10},
		{Kind: ecosystem.CmdAdjustResource, Epoch: 1, RegionID: "r1", ResourceName: "food", Delta: 10},
		{Kind: ecosystem.CmdAdjustResource, Epoch: 1, RegionID: "r1", ResourceName: "food", Delta: -5},
	}
	sortedCmds := ecosystem.CanonicalizeCommands(unsortedCmds)
	if sortedCmds[0].Delta != -5 || sortedCmds[1].ResourceName != "food" || sortedCmds[3].RegionID != "r2" {
		t.Fatalf("unexpected canonical command ordering: %+v", sortedCmds)
	}
}

// Section 26: Long-duration accelerated simulations (3,000 stable epochs + 2,000 adverse epochs)
// without wall-clock dependence, verifying boundedness, stability, zero leaks, and zero numeric failures.
func TestLongDurationEcosystemStability(t *testing.T) {
	cfg := ecosystem.DefaultConfig()

	// 1. Stable scenario: 3,000 epochs (Seed 20260301).
	stableInit := ecosystem.NewDefaultEcosystemState("long-stable", 20260301)
	resStable, err := ecosystem.RunEpochs(context.Background(), stableInit, nil, 3000, cfg, 200)
	if err != nil {
		t.Fatalf("3000-epoch stable simulation failed: %v", err)
	}
	if err := resStable.FinalState.Validate(cfg); err != nil {
		t.Fatalf("final stable state invalid: %v", err)
	}
	if len(resStable.Events) > 200 {
		t.Fatalf("retained event history exceeded bound 200: got %d", len(resStable.Events))
	}
	freeTot, matTot := ecosystem.TotalEcosystemPopulation(resStable.FinalState)
	if freeTot <= 0 || freeTot > 1500 || matTot != 0 {
		t.Fatalf("unexpected 3000-epoch stable population bounds: free=%d mat=%d", freeTot, matTot)
	}
	if len(resStable.FinalState.Camps) > cfg.MaxCampsTotal {
		t.Fatalf("camp count exceeded MaxCampsTotal: %d", len(resStable.FinalState.Camps))
	}

	// 2. Adverse scenario: contested regions + scarcity stress over 2,000 epochs (Seed 20260302).
	adverseInit := ecosystem.NewTerritorialDisputeState("long-adverse", 20260302)
	for i := range adverseInit.Regions {
		adverseInit.Regions[i].Resources.Food.RegenPerEpoch /= 2
	}
	resAdverse, err := ecosystem.RunEpochs(context.Background(), adverseInit, nil, 2000, cfg, 200)
	if err != nil {
		t.Fatalf("2000-epoch adverse simulation failed: %v", err)
	}
	if err := resAdverse.FinalState.Validate(cfg); err != nil {
		t.Fatalf("final adverse state invalid: %v", err)
	}
	if len(resAdverse.Events) > 200 {
		t.Fatalf("adverse retained event history exceeded bound: %d", len(resAdverse.Events))
	}
	if len(resAdverse.FinalState.Populations) > cfg.MaxPopulations || len(resAdverse.FinalState.Camps) > cfg.MaxCampsTotal {
		t.Fatalf("entity bounds exceeded in adverse long run")
	}
}

// Section 27: Separated ecosystem benchmarks measuring each subsystem clearly.
func BenchmarkEcosystemStepEpoch(b *testing.B) {
	cfg := ecosystem.DefaultConfig()
	base := ecosystem.NewTerritorialDisputeState("bench-eco", 42)
	b.ReportAllocs()
	b.ResetTimer()
	cur := base
	for i := 0; i < b.N; i++ {
		next, _, err := ecosystem.StepEpoch(cur, nil, cfg)
		if err != nil {
			b.Fatal(err)
		}
		cur = next
		if cur.Epoch%100 == 0 {
			cur = base
		}
	}
}

func BenchmarkEcosystemChecksum(b *testing.B) {
	cfg := ecosystem.DefaultConfig()
	st := ecosystem.NewTerritorialDisputeState("bench-sum", 42)
	res, err := ecosystem.RunEpochs(context.Background(), st, nil, 15, cfg, 64)
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := res.FinalState.Checksum(cfg); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkEcosystemSnapshotRoundTrip(b *testing.B) {
	cfg := ecosystem.DefaultConfig()
	st := ecosystem.NewTerritorialDisputeState("bench-snap", 42)
	res, err := ecosystem.RunEpochs(context.Background(), st, nil, 15, cfg, 64)
	if err != nil {
		b.Fatal(err)
	}
	sample, err := res.FinalState.MarshalSnapshot(cfg)
	if err != nil {
		b.Fatal(err)
	}
	b.ReportMetric(float64(len(sample)), "snapshot_bytes")
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		raw, err := res.FinalState.MarshalSnapshot(cfg)
		if err != nil {
			b.Fatal(err)
		}
		if _, err := ecosystem.UnmarshalSnapshot(raw, cfg); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkEcosystemMaterializeDematerialize(b *testing.B) {
	base := ecosystem.NewDefaultEcosystemState("bench-mat", 42)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		st := base.Clone()
		ticket, _, err := ecosystem.ReserveForMaterialization(&st, "camp-thornveil-warren", "goblin-raider-pack", 2)
		if err != nil {
			b.Fatal(err)
		}
		if _, _, err := ecosystem.ReconcileDematerialization(&st, ticket, 300, 800, false); err != nil {
			b.Fatal(err)
		}
	}
}
