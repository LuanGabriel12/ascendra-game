package worldevents_test

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"runtime"
	"testing"

	"ascendra-game/internal/adapters/memory"
	"ascendra-game/internal/ai"
	"ascendra-game/internal/ecosystem"
	"ascendra-game/internal/ports"
	"ascendra-game/internal/simulation"
	"ascendra-game/internal/world"
	"ascendra-game/internal/worldevents"
)

func mustReader(t *testing.T) *memory.SettlementReader {
	t.Helper()
	r, err := memory.NewSettlementReader(memory.DefaultSettlementFixtures()...)
	if err != nil {
		t.Fatalf("NewSettlementReader: %v", err)
	}
	return r
}

func TestCandidateGenerationAndHostileOnly(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	eco := worldevents.NewHighThreatGoblinEco("cand-hostile", 101)
	// Make Thornveil Goblins neutral/allied to settlement -> MUST NEVER generate hostile invasion candidate!
	for i := range eco.Factions {
		if eco.Factions[i].FactionID == ecosystem.FactionThornGoblins {
			eco.Factions[i].HostileToSettlement = false
		}
	}
	st, err := worldevents.NewOrchestratedState("cand-hostile", "settlement-valewatch", 101, mustReader(t), eco)
	if err != nil {
		t.Fatalf("NewOrchestratedState: %v", err)
	}

	cands, err := worldevents.EvaluateCandidates(st.Director, st.Ecosystem, st.World, cfg.Director, 2)
	if err != nil {
		t.Fatalf("EvaluateCandidates: %v", err)
	}
	if len(cands) != 0 {
		t.Fatalf("neutral/allied faction generated hostile campaign candidates: %+v", cands)
	}

	// Explicit DirCmdScheduleCampaign against neutral/allied faction MUST also be rejected!
	_, _, err = worldevents.Step(st, worldevents.StepInput{
		DirectorCommands: []worldevents.DirectorCommand{{
			Kind:               worldevents.DirCmdScheduleCampaign,
			Tick:               1,
			TemplateID:         worldevents.TemplateGoblinRaid,
			RegionID:           ecosystem.RegionThornveilForest,
			SourcePopulationID: "pop-thornveil-goblins",
			SourceCampID:       "camp-thornveil-warren",
		}},
	}, cfg)
	if !errors.Is(err, worldevents.ErrInvalidCommand) {
		t.Fatalf("expected ErrInvalidCommand for non-hostile faction schedule, got %v", err)
	}

	// Restore hostility -> candidate appears deterministically.
	st.Ecosystem.Factions[0].HostileToSettlement = true
	for i := range st.Ecosystem.Factions {
		if st.Ecosystem.Factions[i].FactionID == ecosystem.FactionThornGoblins {
			st.Ecosystem.Factions[i].HostileToSettlement = true
		}
	}
	cands, err = worldevents.EvaluateCandidates(st.Director, st.Ecosystem, st.World, cfg.Director, 2)
	if err != nil {
		t.Fatalf("EvaluateCandidates hostile: %v", err)
	}
	if len(cands) != 1 || cands[0].TemplateID != worldevents.TemplateGoblinRaid {
		t.Fatalf("expected 1 goblin campaign candidate, got %+v", cands)
	}
}

func TestPrioritizationAndTieBreak(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	eco := worldevents.NewDualHostileConflictEco("prio-tie", 102)
	st, err := worldevents.NewOrchestratedState("prio-tie", "settlement-valewatch", 102, mustReader(t), eco)
	if err != nil {
		t.Fatalf("NewOrchestratedState: %v", err)
	}

	cands, err := worldevents.EvaluateCandidates(st.Director, st.Ecosystem, st.World, cfg.Director, 2)
	if err != nil {
		t.Fatalf("EvaluateCandidates: %v", err)
	}
	if len(cands) != 2 {
		t.Fatalf("expected 2 candidates (Orc + Goblin), got %d", len(cands))
	}
	// Orcs have higher ThreatScore (1450 vs 900) and higher PriorityWeightLeadership -> must rank first!
	if cands[0].FamilyID != ai.FamilyOrc || cands[1].FamilyID != ai.FamilyGoblin {
		t.Fatalf("expected Orc ranked before Goblin, got %+v", cands)
	}
	if cands[0].Priority <= cands[0].ThreatScore {
		t.Fatalf("expected scheduling Priority (%d) distinct from raw ThreatScore (%d)", cands[0].Priority, cands[0].ThreatScore)
	}

	// Exact tie-break in scheduler: equal Priority & ScheduledTick -> lexicographically smaller EventID wins!
	dir := worldevents.NewDirectorState("tie-sched", 1)
	ev1, err := worldevents.EnqueueScheduledEvent(&dir, worldevents.ScheduledEvent{
		TemplateID:         worldevents.TemplateGoblinRaid,
		Kind:               worldevents.EventGoblinRaidCampaign,
		Category:           worldevents.CategoryCreature,
		RegionID:           ecosystem.RegionThornveilForest,
		SettlementID:       "settlement-valewatch",
		FactionID:          ecosystem.FactionThornGoblins,
		SourcePopulationID: "pop-thornveil-goblins",
		SourceCampID:       "camp-thornveil-warren",
		Priority:           500,
		ScheduledTick:      1,
		DeadlineTick:       50,
	}, cfg.Director)
	if err != nil {
		t.Fatalf("EnqueueScheduledEvent 1: %v", err)
	}
	ev2, err := worldevents.EnqueueScheduledEvent(&dir, worldevents.ScheduledEvent{
		TemplateID:         worldevents.TemplateOrcWarband,
		Kind:               worldevents.EventOrcWarbandCampaign,
		Category:           worldevents.CategoryCreature,
		RegionID:           ecosystem.RegionIronfangFrontier,
		SettlementID:       "settlement-valewatch",
		FactionID:          ecosystem.FactionIronfangOrcs,
		SourcePopulationID: "pop-ironfang-orcs",
		SourceCampID:       "camp-ironfang-bastion",
		Priority:           500,
		ScheduledTick:      1,
		DeadlineTick:       50,
	}, cfg.Director)
	if err != nil {
		t.Fatalf("EnqueueScheduledEvent 2: %v", err)
	}
	if ev1.EventID >= ev2.EventID {
		t.Fatalf("expected ev1.EventID < ev2.EventID, got %q >= %q", ev1.EventID, ev2.EventID)
	}
	st.Director = dir
	// Disable auto-eval for tick 1 so only our 2 equal-priority scheduled events compete.
	cfg.Director.CandidateEvalIntervalTicks = 100
	next, _, err := worldevents.Step(st, worldevents.StepInput{}, cfg)
	if err != nil {
		t.Fatalf("Step tie-break: %v", err)
	}
	if len(next.Director.Campaigns) != 1 || next.Director.Campaigns[0].FamilyID != ai.FamilyGoblin {
		t.Fatalf("expected deterministic EventID tie-break to pick ev1 (Goblin), got %+v", next.Director.Campaigns)
	}
	if len(next.Director.PendingEvents) != 1 || next.Director.PendingEvents[0].AgeTicks != 1 {
		t.Fatalf("expected blocked ev2 to remain pending with AgeTicks=1, got %+v", next.Director.PendingEvents)
	}
}

func TestAntiStarvationAging(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	cfg.Director.CandidateEvalIntervalTicks = 1000
	cfg.Director.PriorityAgingPerTick = 50
	eco := worldevents.NewDualHostileConflictEco("aging", 103)
	st, err := worldevents.NewOrchestratedState("aging", "settlement-valewatch", 103, mustReader(t), eco)
	if err != nil {
		t.Fatalf("NewOrchestratedState: %v", err)
	}

	// Put settlement on cooldown until tick 6 so low-priority Goblin waits and ages 5 ticks (+250 priority -> 650).
	st.Director.SettlementCooldowns = []worldevents.CooldownEntry{
		{TargetID: "settlement-valewatch", ReadyAtTick: 6},
	}
	_, err = worldevents.EnqueueScheduledEvent(&st.Director, worldevents.ScheduledEvent{
		TemplateID:         worldevents.TemplateGoblinRaid,
		Kind:               worldevents.EventGoblinRaidCampaign,
		Category:           worldevents.CategoryCreature,
		RegionID:           ecosystem.RegionThornveilForest,
		SettlementID:       "settlement-valewatch",
		FactionID:          ecosystem.FactionThornGoblins,
		SourcePopulationID: "pop-thornveil-goblins",
		SourceCampID:       "camp-thornveil-warren",
		Priority:           400,
		ScheduledTick:      1,
		DeadlineTick:       100,
	}, cfg.Director)
	if err != nil {
		t.Fatalf("enqueue low-prio goblin: %v", err)
	}

	cur := st
	for tick := uint64(1); tick <= 5; tick++ {
		var in worldevents.StepInput
		// On tick 5, a newer higher-base-priority (550) Orc arrives, but Goblin has aged +200 -> 600 > 550!
		if tick == 5 {
			in.DirectorCommands = []worldevents.DirectorCommand{{
				Kind:               worldevents.DirCmdScheduleCampaign,
				Tick:               5,
				TemplateID:         worldevents.TemplateOrcWarband,
				RegionID:           ecosystem.RegionIronfangFrontier,
				SourcePopulationID: "pop-ironfang-orcs",
				SourceCampID:       "camp-ironfang-bastion",
				Priority:           550,
				ScheduledTick:      6,
			}}
		}
		cur, _, err = worldevents.Step(cur, in, cfg)
		if err != nil {
			t.Fatalf("tick %d: %v", tick, err)
		}
	}
	// Tick 6: cooldown expires; aged Goblin (400 + 5*50 = 650) MUST beat fresh Orc (550)!
	cur, _, err = worldevents.Step(cur, worldevents.StepInput{}, cfg)
	if err != nil {
		t.Fatalf("tick 6: %v", err)
	}
	if len(cur.Director.Campaigns) != 1 || cur.Director.Campaigns[0].FamilyID != ai.FamilyGoblin {
		t.Fatalf("anti-starvation aging failed: expected aged Goblin to launch ahead of fresh Orc, got %+v", cur.Director.Campaigns)
	}
}

func TestCooldownEnforcement(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	eco := worldevents.NewHighThreatGoblinEco("cooldown", 104)
	st, err := worldevents.NewOrchestratedState("cooldown", "settlement-valewatch", 104, mustReader(t), eco)
	if err != nil {
		t.Fatalf("NewOrchestratedState: %v", err)
	}

	st.Director.RegionCooldowns = []worldevents.CooldownEntry{
		{TargetID: ecosystem.RegionThornveilForest, ReadyAtTick: 50},
	}
	cands, err := worldevents.EvaluateCandidates(st.Director, st.Ecosystem, st.World, cfg.Director, 2)
	if err != nil || len(cands) != 0 {
		t.Fatalf("expected 0 candidates during region cooldown, got %+v (err=%v)", cands, err)
	}

	st.Director.RegionCooldowns = nil
	st.Director.SettlementCooldowns = []worldevents.CooldownEntry{
		{TargetID: "settlement-valewatch", ReadyAtTick: 50},
	}
	cands, err = worldevents.EvaluateCandidates(st.Director, st.Ecosystem, st.World, cfg.Director, 2)
	if err != nil || len(cands) != 0 {
		t.Fatalf("expected 0 candidates during settlement cooldown, got %+v (err=%v)", cands, err)
	}
}

func TestDeadlineExpirationReleasesReservation(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	cfg.Director.CandidateEvalIntervalTicks = 1000
	// Force short deadline slack so campaign expires during Reconnaissance/Preparing!
	cfg.Director.Policies[0].DeadlineSlackTicks = 5
	cfg.Director.Policies[0].ReconTicks = 10

	eco := worldevents.NewHighThreatGoblinEco("expire-test", 105)
	st, err := worldevents.NewOrchestratedState("expire-test", "settlement-valewatch", 105, mustReader(t), eco)
	if err != nil {
		t.Fatalf("NewOrchestratedState: %v", err)
	}
	initialFree, initialRes, initialMat := ecosystem.TotalPopulationLedger(st.Ecosystem)

	cur, _, err := worldevents.Step(st, worldevents.StepInput{
		DirectorCommands: []worldevents.DirectorCommand{{
			Kind:               worldevents.DirCmdScheduleCampaign,
			Tick:               1,
			TemplateID:         worldevents.TemplateGoblinRaid,
			RegionID:           ecosystem.RegionThornveilForest,
			SourcePopulationID: "pop-thornveil-goblins",
			SourceCampID:       "camp-thornveil-warren",
			ScheduledTick:      1,
		}},
	}, cfg)
	if err != nil {
		t.Fatalf("tick 1: %v", err)
	}
	if len(cur.Director.Campaigns) != 1 || cur.Director.Campaigns[0].ReservationID == "" {
		t.Fatalf("expected reserved campaign after tick 1, got %+v", cur.Director.Campaigns)
	}

	sawExpired := false
	for tick := uint64(2); tick <= 10; tick++ {
		var out worldevents.StepOutput
		cur, out, err = worldevents.Step(cur, worldevents.StepInput{}, cfg)
		if err != nil {
			t.Fatalf("tick %d: %v", tick, err)
		}
		for _, ev := range out.DirectorEvents {
			if ev.Type == worldevents.DirEventCampaignExpired {
				sawExpired = true
			}
		}
	}
	if !sawExpired {
		t.Fatalf("expected DirEventCampaignExpired after deadline elapsed")
	}
	freeAfter, resAfter, matAfter := ecosystem.TotalPopulationLedger(cur.Ecosystem)
	if resAfter != 0 || matAfter != 0 || freeAfter != initialFree || initialRes != 0 || initialMat != 0 {
		t.Fatalf("population conservation failed after expiration: before=(%d,%d,%d) after=(%d,%d,%d)",
			initialFree, initialRes, initialMat, freeAfter, resAfter, matAfter)
	}
}

func TestCancellationByCommandAndCampDestruction(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	cfg.Director.CandidateEvalIntervalTicks = 1000
	eco := worldevents.NewHighThreatGoblinEco("cancel-cmd", 106)
	st, err := worldevents.NewOrchestratedState("cancel-cmd", "settlement-valewatch", 106, mustReader(t), eco)
	if err != nil {
		t.Fatalf("NewOrchestratedState: %v", err)
	}
	initFree, _, _ := ecosystem.TotalPopulationLedger(st.Ecosystem)

	// Schedule on tick 1 -> reserves & deploys recon.
	cur, _, err := worldevents.Step(st, worldevents.StepInput{
		DirectorCommands: []worldevents.DirectorCommand{{
			Kind:               worldevents.DirCmdScheduleCampaign,
			Tick:               1,
			TemplateID:         worldevents.TemplateGoblinRaid,
			RegionID:           ecosystem.RegionThornveilForest,
			SourcePopulationID: "pop-thornveil-goblins",
			SourceCampID:       "camp-thornveil-warren",
		}},
	}, cfg)
	if err != nil {
		t.Fatalf("tick 1: %v", err)
	}
	campID := cur.Director.Campaigns[0].CampaignID

	// Cancel explicitly on tick 2 -> recalls recon, releases reservation, archives as Completed.
	cur, out, err := worldevents.Step(cur, worldevents.StepInput{
		DirectorCommands: []worldevents.DirectorCommand{{
			Kind:       worldevents.DirCmdCancelCampaign,
			Tick:       2,
			CampaignID: campID,
			Reason:     "manual cancel test",
		}},
	}, cfg)
	if err != nil {
		t.Fatalf("tick 2 cancel: %v", err)
	}
	sawCancel := false
	for _, ev := range out.DirectorEvents {
		if ev.Type == worldevents.DirEventCampaignCancelled && ev.CampaignID == campID {
			sawCancel = true
		}
	}
	if !sawCancel || len(cur.Director.Campaigns) != 0 || len(cur.World.Groups) != 0 {
		t.Fatalf("expected clean cancellation and recon recall, sawCancel=%v campaigns=%d groups=%d",
			sawCancel, len(cur.Director.Campaigns), len(cur.World.Groups))
	}
	freeAfter, resAfter, matAfter := ecosystem.TotalPopulationLedger(cur.Ecosystem)
	if freeAfter != initFree || resAfter != 0 || matAfter != 0 {
		t.Fatalf("expected exact population restoration on cancel: init=%d after=(%d,%d,%d)", initFree, freeAfter, resAfter, matAfter)
	}

	// Attempting to cancel an already completed/archived campaign MUST fail cleanly.
	if _, _, err := worldevents.Step(cur, worldevents.StepInput{
		DirectorCommands: []worldevents.DirectorCommand{{
			Kind:       worldevents.DirCmdCancelCampaign,
			Tick:       3,
			CampaignID: campID,
		}},
	}, cfg); !errors.Is(err, worldevents.ErrCampaignNotFound) {
		t.Fatalf("expected ErrCampaignNotFound cancelling completed campaign, got %v", err)
	}
}

func TestTerminalImmutabilityAndInvalidTransitions(t *testing.T) {
	forbidden := [][2]worldevents.CampaignState{
		{worldevents.CampaignCandidate, worldevents.CampaignActive},
		{worldevents.CampaignScheduled, worldevents.CampaignWarning},
		{worldevents.CampaignReconnaissance, worldevents.CampaignActive},
		{worldevents.CampaignActive, worldevents.CampaignCancelled},
		{worldevents.CampaignActive, worldevents.CampaignExpired},
		{worldevents.CampaignActive, worldevents.CampaignDefended},
		{worldevents.CampaignDefended, worldevents.CampaignCaptured},
		{worldevents.CampaignDefended, worldevents.CampaignActive},
		{worldevents.CampaignCaptured, worldevents.CampaignDefended},
		{worldevents.CampaignCompleted, worldevents.CampaignScheduled},
		{worldevents.CampaignCompleted, worldevents.CampaignActive},
		{worldevents.CampaignCompleted, worldevents.CampaignRecovering},
		{worldevents.CampaignState("Bogus"), worldevents.CampaignActive},
	}
	for _, pair := range forbidden {
		if err := worldevents.ValidateCampaignTransition(pair[0], pair[1]); !errors.Is(err, worldevents.ErrInvalidCampaignTransition) {
			t.Fatalf("expected ErrInvalidCampaignTransition for %s -> %s, got %v", pair[0], pair[1], err)
		}
	}

	valid := [][2]worldevents.CampaignState{
		{worldevents.CampaignCandidate, worldevents.CampaignScheduled},
		{worldevents.CampaignScheduled, worldevents.CampaignReconnaissance},
		{worldevents.CampaignReconnaissance, worldevents.CampaignPreparing},
		{worldevents.CampaignPreparing, worldevents.CampaignWarning},
		{worldevents.CampaignWarning, worldevents.CampaignMobilizing},
		{worldevents.CampaignMobilizing, worldevents.CampaignActive},
		{worldevents.CampaignActive, worldevents.CampaignResolving},
		{worldevents.CampaignResolving, worldevents.CampaignDefended},
		{worldevents.CampaignResolving, worldevents.CampaignCaptured},
		{worldevents.CampaignDefended, worldevents.CampaignRecovering},
		{worldevents.CampaignCaptured, worldevents.CampaignRecovering},
		{worldevents.CampaignRecovering, worldevents.CampaignCompleted},
		{worldevents.CampaignCancelled, worldevents.CampaignCompleted},
		{worldevents.CampaignExpired, worldevents.CampaignCompleted},
	}
	for _, pair := range valid {
		if err := worldevents.ValidateCampaignTransition(pair[0], pair[1]); err != nil {
			t.Fatalf("expected valid transition %s -> %s, got %v", pair[0], pair[1], err)
		}
	}
}

func TestConcurrencyLimitsAndDuplicatePrevention(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	eco := worldevents.NewDualHostileConflictEco("concur", 107)
	st, err := worldevents.NewOrchestratedState("concur", "settlement-valewatch", 107, mustReader(t), eco)
	if err != nil {
		t.Fatalf("NewOrchestratedState: %v", err)
	}

	cur := st
	for tick := uint64(1); tick <= 60; tick++ {
		cur, _, err = worldevents.Step(cur, worldevents.StepInput{}, cfg)
		if err != nil {
			t.Fatalf("tick %d: %v", tick, err)
		}
		inFlight := 0
		tacticalActive := 0
		for _, c := range cur.Director.Campaigns {
			if c.State.IsInFlight() {
				inFlight++
			}
			if c.State == worldevents.CampaignActive || c.State == worldevents.CampaignResolving {
				tacticalActive++
			}
		}
		if inFlight > cfg.Director.MaxActiveCampaignsPerSettlement {
			t.Fatalf("tick %d: concurrent in-flight settlement campaigns %d exceeded limit %d",
				tick, inFlight, cfg.Director.MaxActiveCampaignsPerSettlement)
		}
		if tacticalActive > 1 {
			t.Fatalf("tick %d: tactical active count %d > 1", tick, tacticalActive)
		}
	}
}

func TestOperationalLimitsAndBackpressure(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	cfg.Director.MaxPendingEvents = 2
	cfg.Director.MaxChainDepth = 1
	dir := worldevents.NewDirectorState("limits", 1)

	// Exceeding MaxChainDepth must fail cleanly.
	if _, err := worldevents.EnqueueScheduledEvent(&dir, worldevents.ScheduledEvent{
		Kind:          worldevents.EventRecoveryFollowup,
		Category:      worldevents.CategoryCreature,
		RegionID:      ecosystem.RegionThornveilForest,
		ScheduledTick: 10,
		DeadlineTick:  20,
		ChainDepth:    2,
	}, cfg.Director); !errors.Is(err, worldevents.ErrCapacityExceeded) {
		t.Fatalf("expected ErrCapacityExceeded on chain depth > MaxChainDepth, got %v", err)
	}

	// Fill MaxPendingEvents = 2, then 3rd fails with ErrCapacityExceeded.
	for i := 0; i < 2; i++ {
		if _, err := worldevents.EnqueueScheduledEvent(&dir, worldevents.ScheduledEvent{
			Kind:          worldevents.EventRecoveryFollowup,
			Category:      worldevents.CategoryCreature,
			RegionID:      ecosystem.RegionThornveilForest,
			ScheduledTick: 10,
			DeadlineTick:  20,
			ChainDepth:    0,
		}, cfg.Director); err != nil {
			t.Fatalf("enqueue %d: %v", i, err)
		}
	}
	if _, err := worldevents.EnqueueScheduledEvent(&dir, worldevents.ScheduledEvent{
		Kind:          worldevents.EventRecoveryFollowup,
		Category:      worldevents.CategoryCreature,
		RegionID:      ecosystem.RegionThornveilForest,
		ScheduledTick: 10,
		DeadlineTick:  20,
		ChainDepth:    0,
	}, cfg.Director); !errors.Is(err, worldevents.ErrCapacityExceeded) {
		t.Fatalf("expected ErrCapacityExceeded on pending queue full, got %v", err)
	}
}

func TestSettlementProtectionRules(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	eco := worldevents.NewHighThreatGoblinEco("protect", 108)
	st, err := worldevents.NewOrchestratedState("protect", "settlement-valewatch", 108, mustReader(t), eco)
	if err != nil {
		t.Fatalf("NewOrchestratedState: %v", err)
	}

	// 1. ProtectedRegions blocks region from automatic AND explicit scheduling.
	cfgProt := cfg
	cfgProt.Director.ProtectedRegions = []string{ecosystem.RegionThornveilForest}
	cands, err := worldevents.EvaluateCandidates(st.Director, st.Ecosystem, st.World, cfgProt.Director, 2)
	if err != nil || len(cands) != 0 {
		t.Fatalf("protected region generated candidates: %+v (err=%v)", cands, err)
	}
	if _, _, err := worldevents.Step(st, worldevents.StepInput{
		DirectorCommands: []worldevents.DirectorCommand{{
			Kind:               worldevents.DirCmdScheduleCampaign,
			Tick:               1,
			TemplateID:         worldevents.TemplateGoblinRaid,
			RegionID:           ecosystem.RegionThornveilForest,
			SourcePopulationID: "pop-thornveil-goblins",
			SourceCampID:       "camp-thornveil-warren",
		}},
	}, cfgProt); !errors.Is(err, worldevents.ErrProtectedTarget) {
		t.Fatalf("expected ErrProtectedTarget for protected region command, got %v", err)
	}

	// 2. MinSimulatedDefenseHP blocks attacks against collapsed settlement.
	stLowHP := st.Clone()
	stLowHP.World.SettlementDefenseHP = cfg.Director.MinSimulatedDefenseHP - 1
	cands, err = worldevents.EvaluateCandidates(stLowHP.Director, stLowHP.Ecosystem, stLowHP.World, cfg.Director, 2)
	if err != nil || len(cands) != 0 {
		t.Fatalf("collapsed settlement HP generated candidates: %+v", cands)
	}

	// 3. RequireAvailableDefenders blocks when 0 defenders deployed.
	cfgDef := cfg
	cfgDef.Director.RequireAvailableDefenders = true
	cands, err = worldevents.EvaluateCandidates(st.Director, st.Ecosystem, st.World, cfgDef.Director, 0)
	if err != nil || len(cands) != 0 {
		t.Fatalf("RequireAvailableDefenders=true generated candidates with 0 defenders: %+v", cands)
	}
	cands, err = worldevents.EvaluateCandidates(st.Director, st.Ecosystem, st.World, cfgDef.Director, 1)
	if err != nil || len(cands) != 1 {
		t.Fatalf("expected candidate once defender available, got %+v (err=%v)", cands, err)
	}
}

func TestGoblinVsOrcCampaignBehavior(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	gobTpl, ok := worldevents.LookupPolicy(cfg.Director, worldevents.TemplateGoblinRaid)
	if !ok {
		t.Fatalf("missing goblin template")
	}
	orcTpl, ok := worldevents.LookupPolicy(cfg.Director, worldevents.TemplateOrcWarband)
	if !ok {
		t.Fatalf("missing orc template")
	}
	gobReq, err := worldevents.TemplateRequiredContingent(gobTpl)
	if err != nil {
		t.Fatalf("TemplateRequiredContingent goblin: %v", err)
	}
	orcReq, err := worldevents.TemplateRequiredContingent(orcTpl)
	if err != nil {
		t.Fatalf("TemplateRequiredContingent orc: %v", err)
	}
	if gobReq <= 0 || orcReq <= 0 {
		t.Fatalf("expected positive required contingents, orc=%d gob=%d", orcReq, gobReq)
	}
	// Orc warbands demand higher free population, higher regional threat, longer preparation,
	// stronger leadership weight, more main force squads, and longer cooldowns than agile Goblin raids.
	if orcTpl.MinFreePopulation <= gobTpl.MinFreePopulation ||
		orcTpl.MinThreatScore <= gobTpl.MinThreatScore ||
		orcTpl.PrepTicks <= gobTpl.PrepTicks ||
		orcTpl.PriorityWeightLeadership <= gobTpl.PriorityWeightLeadership ||
		len(orcTpl.MainForces) <= len(gobTpl.MainForces) ||
		orcTpl.RegionCooldownTicks <= gobTpl.RegionCooldownTicks {
		t.Fatalf("expected Orc warband policy to diverge significantly from Goblin raid: orc=%+v gob=%+v", orcTpl, gobTpl)
	}
}

func TestInsufficientPopulationHandling(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	eco := worldevents.NewHighThreatGoblinEco("low-pop", 109)
	for i := range eco.Populations {
		if eco.Populations[i].PopulationID == "pop-thornveil-goblins" {
			eco.Populations[i].FreePopulation = 5
		}
	}
	st, err := worldevents.NewOrchestratedState("low-pop", "settlement-valewatch", 109, mustReader(t), eco)
	if err != nil {
		t.Fatalf("NewOrchestratedState: %v", err)
	}

	cands, err := worldevents.EvaluateCandidates(st.Director, st.Ecosystem, st.World, cfg.Director, 2)
	if err != nil || len(cands) != 0 {
		t.Fatalf("expected 0 candidates when FreePopulation < required, got %+v", cands)
	}
	if _, _, err := worldevents.Step(st, worldevents.StepInput{
		DirectorCommands: []worldevents.DirectorCommand{{
			Kind:               worldevents.DirCmdScheduleCampaign,
			Tick:               1,
			TemplateID:         worldevents.TemplateGoblinRaid,
			RegionID:           ecosystem.RegionThornveilForest,
			SourcePopulationID: "pop-thornveil-goblins",
			SourceCampID:       "camp-thornveil-warren",
		}},
	}, cfg); !errors.Is(err, ecosystem.ErrInsufficientPopulation) {
		t.Fatalf("expected ErrInsufficientPopulation, got %v", err)
	}
}

func TestEcologicalReinforcementsWithPopulationDebit(t *testing.T) {
	sum, res, err := worldevents.RunScenarioH(context.Background(), mustReader(t))
	if err != nil {
		t.Fatalf("RunScenarioH: %v", err)
	}
	if sum.ReinforcementsDeployed == 0 {
		t.Fatalf("expected at least 1 ecologically debited reinforcement in Scenario H, got 0")
	}
	if sum.ReservedPopulationTotal != 0 || sum.MaterializedPopTotal != 0 {
		t.Fatalf("expected all reserved/materialized balances reconciled at end of Scenario H, got res=%d mat=%d",
			sum.ReservedPopulationTotal, sum.MaterializedPopTotal)
	}
	// Verify every reinforcement event corresponds to a real population materialization event.
	matEvents := 0
	for _, ev := range res.EcosystemEvents {
		if ev.Type == ecosystem.EventCreatureGroupMaterialized {
			matEvents++
		}
	}
	// Orc campaign: 1 recon + 3 main forces + >=1 reinforcement = >= 5 materializations.
	if matEvents < 5 {
		t.Fatalf("expected >= 5 ecological materializations (recon+main+reinf), got %d", matEvents)
	}
}

func TestSequenceOverflowAndInvalidDeadlines(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	dir := worldevents.NewDirectorState("overflow", 1)

	// Invalid deadline < scheduled tick.
	if _, err := worldevents.EnqueueScheduledEvent(&dir, worldevents.ScheduledEvent{
		Kind:          worldevents.EventGoblinRaidCampaign,
		Category:      worldevents.CategoryCreature,
		RegionID:      ecosystem.RegionThornveilForest,
		ScheduledTick: 20,
		DeadlineTick:  10,
	}, cfg.Director); !errors.Is(err, worldevents.ErrInvalidCommand) {
		t.Fatalf("expected ErrInvalidCommand for deadline < scheduled, got %v", err)
	}

	// ScheduledEventSeq overflow.
	dir.ScheduledEventSeq = math.MaxUint64
	if _, err := worldevents.EnqueueScheduledEvent(&dir, worldevents.ScheduledEvent{
		Kind:          worldevents.EventGoblinRaidCampaign,
		Category:      worldevents.CategoryCreature,
		RegionID:      ecosystem.RegionThornveilForest,
		ScheduledTick: 10,
		DeadlineTick:  20,
	}, cfg.Director); !errors.Is(err, worldevents.ErrNumericOverflow) {
		t.Fatalf("expected ErrNumericOverflow on ScheduledEventSeq max, got %v", err)
	}

	// Tick overflow.
	eco := worldevents.NewHighThreatGoblinEco("tick-ovf", 1)
	st, err := worldevents.NewOrchestratedState("tick-ovf", "settlement-valewatch", 1, mustReader(t), eco)
	if err != nil {
		t.Fatalf("NewOrchestratedState: %v", err)
	}
	st.Director.Tick = math.MaxUint64
	st.World.Tick = math.MaxUint64
	if _, _, err := worldevents.Step(st, worldevents.StepInput{}, cfg); !errors.Is(err, worldevents.ErrNumericOverflow) {
		t.Fatalf("expected ErrNumericOverflow on Tick max, got %v", err)
	}
}

func TestErrorAtomicity(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	eco := worldevents.NewHighThreatGoblinEco("atomic", 110)
	st, err := worldevents.NewOrchestratedState("atomic", "settlement-valewatch", 110, mustReader(t), eco)
	if err != nil {
		t.Fatalf("NewOrchestratedState: %v", err)
	}
	beforeSum, err := st.Checksum(cfg)
	if err != nil {
		t.Fatalf("Checksum before: %v", err)
	}

	// Fail due to bad gameplay command scope AFTER director commands already ran on tick 1!
	_, _, err = worldevents.Step(st, worldevents.StepInput{
		DirectorCommands: []worldevents.DirectorCommand{{
			Kind:               worldevents.DirCmdScheduleCampaign,
			Tick:               1,
			TemplateID:         worldevents.TemplateGoblinRaid,
			RegionID:           ecosystem.RegionThornveilForest,
			SourcePopulationID: "pop-thornveil-goblins",
			SourceCampID:       "camp-thornveil-warren",
		}},
		GameplayCommands: []world.GameplayCommand{{
			Kind:     world.CmdIncreaseThreat, // forbidden in GameplayCommand!
			Tick:     1,
			PlayerID: "cheater",
		}},
	}, cfg)
	if !errors.Is(err, world.ErrUnauthorizedCommand) {
		t.Fatalf("expected ErrUnauthorizedCommand, got %v", err)
	}
	afterSum, err := st.Checksum(cfg)
	if err != nil || beforeSum != afterSum {
		t.Fatalf("failed Step mutated caller state! before=%s after=%s err=%v", beforeSum, afterSum, err)
	}
}

func TestChainedEventsDepthCapAndNoImmediateReinvasion(t *testing.T) {
	sumD, resD, err := worldevents.RunScenarioD(context.Background(), mustReader(t))
	if err != nil {
		t.Fatalf("RunScenarioD: %v", err)
	}
	if len(sumD.TerminalOutcomes) != 1 || sumD.TerminalOutcomes[0].Outcome != ports.InvasionOutcomeCaptured {
		t.Fatalf("expected exactly 1 Captured outcome in Scenario D, got %+v", sumD.TerminalOutcomes)
	}
	// Verify a bounded reconquest follow-up event was scheduled (not an immediate second invasion).
	sawChained := false
	for _, ev := range resD.DirectorEvents {
		if ev.Type == worldevents.DirEventChainedEventScheduled {
			sawChained = true
		}
	}
	if !sawChained {
		t.Fatalf("expected depth-capped chained follow-up event after resolution")
	}
	if sumD.CampaignsCompleted != 1 {
		t.Fatalf("captured settlement must NOT trigger an immediate second invasion, completed=%d", sumD.CampaignsCompleted)
	}
}

func TestTerminalOutcomeUniquenessAndZeroPlayers(t *testing.T) {
	sumI, resI, err := worldevents.RunScenarioI(context.Background(), mustReader(t))
	if err != nil {
		t.Fatalf("RunScenarioI: %v", err)
	}
	if len(sumI.TerminalOutcomes) != 1 {
		t.Fatalf("expected strictly 1 TerminalSettlementOutcome with 0 players, got %d", len(sumI.TerminalOutcomes))
	}
	fact := sumI.TerminalOutcomes[0]
	if fact.EligibleContributors != 0 {
		t.Fatalf("expected 0 eligible contributors in zero-player scenario, got %d", fact.EligibleContributors)
	}
	if fact.CampaignID == "" || fact.InvasionID == "" || fact.SettlementID != "settlement-valewatch" || fact.InvadingFactionID == "" || !fact.Outcome.ValidTerminal() {
		t.Fatalf("incomplete terminal settlement outcome fact: %+v", fact)
	}
	// Ensure no duplicate outcome emitted in DirectorEvents.
	outcomeEvents := 0
	for _, ev := range resI.DirectorEvents {
		if ev.Type == worldevents.DirEventSettlementOutcomeRecorded {
			outcomeEvents++
		}
	}
	if outcomeEvents != 1 {
		t.Fatalf("expected exactly 1 SettlementInvasionResolved director event, got %d", outcomeEvents)
	}
}

func TestMidCampaignSnapshotRestoreAndVersionRejection(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	sumG, resG, err := worldevents.RunScenarioG(context.Background(), mustReader(t))
	if err != nil {
		t.Fatalf("RunScenarioG: %v", err)
	}
	if !sumG.SnapshotVerified || sumG.SnapshotBytes <= 0 {
		t.Fatalf("expected verified mid-campaign snapshot, got %+v", sumG)
	}

	// Verify v4 snapshot encodes schema_version == 4 and explicitly rejects v1, v2, v3, and oversized payloads.
	raw, err := resG.FinalState.MarshalSnapshot(cfg)
	if err != nil {
		t.Fatalf("MarshalSnapshot: %v", err)
	}
	var env map[string]any
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("json.Unmarshal envelope: %v", err)
	}
	if v, ok := env["schema_version"].(float64); !ok || uint32(v) != 4 {
		t.Fatalf("expected schema_version=4, got %v", env["schema_version"])
	}
	for _, legacyVer := range []uint32{1, 2, 3} {
		env["schema_version"] = legacyVer
		badRaw, _ := json.Marshal(env)
		if _, err := worldevents.UnmarshalOrchestratedSnapshot(badRaw, cfg); !errors.Is(err, simulation.ErrUnsupportedSnapshotVersion) {
			t.Fatalf("expected ErrUnsupportedSnapshotVersion for v%d, got %v", legacyVer, err)
		}
	}

	// Pre-decode MaxSnapshotBytes enforcement.
	smallCfg := cfg
	smallCfg.Director.MaxSnapshotBytes = 64
	if _, err := worldevents.UnmarshalOrchestratedSnapshot(raw, smallCfg); !errors.Is(err, simulation.ErrSnapshotTooLarge) {
		t.Fatalf("expected ErrSnapshotTooLarge, got %v", err)
	}
}

func TestDeterministicReplayEquivalence(t *testing.T) {
	reader := mustReader(t)
	s1, r1, err := worldevents.RunScenarioF(context.Background(), reader)
	if err != nil {
		t.Fatalf("RunScenarioF run 1: %v", err)
	}
	s2, r2, err := worldevents.RunScenarioF(context.Background(), reader)
	if err != nil {
		t.Fatalf("RunScenarioF run 2: %v", err)
	}
	if s1.FinalChecksum != s2.FinalChecksum {
		t.Fatalf("replay checksum divergence: %s != %s", s1.FinalChecksum, s2.FinalChecksum)
	}
	if !reflect.DeepEqual(r1.DirectorEvents, r2.DirectorEvents) ||
		!reflect.DeepEqual(r1.WorldEvents, r2.WorldEvents) ||
		!reflect.DeepEqual(r1.TerminalOutcomes, r2.TerminalOutcomes) {
		t.Fatalf("replay event streams diverged")
	}
}

func TestAllCycle04ScenariosAtoI(t *testing.T) {
	reader := mustReader(t)
	ctx := context.Background()

	sumA, _, err := worldevents.RunScenarioA(ctx, reader)
	if err != nil || sumA.CampaignsCompleted < 1 || len(sumA.TerminalOutcomes) != 1 {
		t.Fatalf("Scenario A failed: sum=%+v err=%v", sumA, err)
	}
	sumB, _, err := worldevents.RunScenarioB(ctx, reader)
	if err != nil || sumB.CampaignsCompleted < 1 || len(sumB.TerminalOutcomes) != 1 {
		t.Fatalf("Scenario B failed: sum=%+v err=%v", sumB, err)
	}
	sumC, _, err := worldevents.RunScenarioC(ctx, reader)
	if err != nil || len(sumC.TerminalOutcomes) != 1 || sumC.TerminalOutcomes[0].Outcome != ports.InvasionOutcomeDefended {
		t.Fatalf("Scenario C expected Defended outcome, got sum=%+v err=%v", sumC, err)
	}
	sumD, _, err := worldevents.RunScenarioD(ctx, reader)
	if err != nil || len(sumD.TerminalOutcomes) != 1 || sumD.TerminalOutcomes[0].Outcome != ports.InvasionOutcomeCaptured {
		t.Fatalf("Scenario D expected Captured outcome, got sum=%+v err=%v", sumD, err)
	}
	sumE, _, err := worldevents.RunScenarioE(ctx, reader)
	if err != nil || sumE.CampaignsCompleted != 1 || len(sumE.TerminalOutcomes) != 0 || sumE.ReservedPopulationTotal != 0 || sumE.MaterializedPopTotal != 0 {
		t.Fatalf("Scenario E expected clean cancellation with 0 leaks, got sum=%+v err=%v", sumE, err)
	}
	sumF, _, err := worldevents.RunScenarioF(ctx, reader)
	if err != nil || sumF.CampaignsCompleted < 2 || len(sumF.TerminalOutcomes) < 2 {
		t.Fatalf("Scenario F expected >=2 sequential campaigns resolved (Orc + aged Goblin), got sum=%+v err=%v", sumF, err)
	}
	sumG, _, err := worldevents.RunScenarioG(ctx, reader)
	if err != nil || !sumG.SnapshotVerified {
		t.Fatalf("Scenario G failed: sum=%+v err=%v", sumG, err)
	}
	sumH, _, err := worldevents.RunScenarioH(ctx, reader)
	if err != nil || sumH.ReinforcementsDeployed < 1 {
		t.Fatalf("Scenario H failed: sum=%+v err=%v", sumH, err)
	}
	sumI, _, err := worldevents.RunScenarioI(ctx, reader)
	if err != nil || len(sumI.TerminalOutcomes) != 1 || sumI.TerminalOutcomes[0].EligibleContributors != 0 {
		t.Fatalf("Scenario I failed: sum=%+v err=%v", sumI, err)
	}
}

// TestLongDurationMultiSeedStabilityAndBoundedMemory verifies thousands of ecological epochs
// across multiple seeds checking cross-layer invariants on every single step and verifying
// retained heap memory stays bounded (no unbounded history/reservation/cooldown leaks).
func TestLongDurationMultiSeedStabilityAndBoundedMemory(t *testing.T) {
	reader := mustReader(t)
	seeds := []uint64{10001, 20002, 30003}
	const epochsPerSeed = 1000 // 3 seeds * 1000 epochs = 3,000 total epochs!
	const ticksPerEpoch = 4    // 4,000 ticks per seed = 12,000 orchestrated ticks total

	cfg := worldevents.DefaultOrchestratedConfig()
	cfg.Ecosystem.TicksPerEpoch = ticksPerEpoch

	var baselineHeap, peakHeap, finalHeap uint64
	runtime.GC()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	baselineHeap = m.HeapAlloc

	totalCampaignsResolved := 0
	for sIdx, seed := range seeds {
		simID := "longrun-seed"
		eco := worldevents.NewDualHostileConflictEco(simID, seed)
		cur, err := worldevents.NewOrchestratedState(simID, "settlement-valewatch", seed, reader, eco)
		if err != nil {
			t.Fatalf("seed %d init: %v", seed, err)
		}

		for tick := uint64(1); tick <= epochsPerSeed*ticksPerEpoch; tick++ {
			// Active 4-defender garrison keeps defending across repeated campaign waves.
			var in worldevents.StepInput
			if cur.World.Invasion.State == world.InvasionUnderAttack {
				if len(cur.World.Defenders) == 0 {
					in.GameplayCommands = []world.GameplayCommand{
						{Kind: world.CmdDeployDefender, Tick: tick, PlayerID: "garrison-1", Position: 3000},
						{Kind: world.CmdDeployDefender, Tick: tick, PlayerID: "garrison-2", Position: 2400},
						{Kind: world.CmdDeployDefender, Tick: tick, PlayerID: "garrison-3", Position: 1800},
						{Kind: world.CmdDeployDefender, Tick: tick, PlayerID: "garrison-4", Position: 1200},
					}
				} else {
					targetID := ""
					for _, g := range cur.World.Groups {
						if g.HP > 0 && g.State != ai.StateDead && !g.Routed {
							targetID = g.GroupID
							break
						}
					}
					garrison := []struct {
						id    string
						phase uint64
					}{
						{"garrison-1", 0},
						{"garrison-2", 2},
						{"garrison-3", 4},
						{"garrison-4", 6},
					}
					if targetID != "" {
						for _, gDef := range garrison {
							if tick%9 != gDef.phase {
								continue
							}
							alive := true
							for _, d := range cur.World.Defenders {
								if d.PlayerID == gDef.id && d.HP == 0 {
									alive = false
									break
								}
							}
							if alive {
								in.GameplayCommands = append(in.GameplayCommands, world.GameplayCommand{
									Kind:          world.CmdPlayerDefendStrike,
									Tick:          tick,
									PlayerID:      gDef.id,
									TargetGroupID: targetID,
								})
							}
						}
					}
					if tick%9 == 3 && cur.World.SettlementDefenseHP < cur.World.SettlementMaxDefenseHP {
						in.GameplayCommands = append(in.GameplayCommands, world.GameplayCommand{Kind: world.CmdPlayerSupportDefense, Tick: tick, PlayerID: "garrison-healer"})
					}
				}
			}

			var out worldevents.StepOutput
			cur, out, err = worldevents.Step(cur, in, cfg)
			if err != nil {
				t.Fatalf("seed %d tick %d failed: %v", seed, tick, err)
			}
			totalCampaignsResolved += len(out.TerminalOutcomes)

			// Verify bounded collections every 500 ticks.
			if tick%500 == 0 {
				if len(cur.Director.CompletedHistory) > cfg.Director.MaxCompletedHistory ||
					len(cur.Director.TerminalOutcomes) > cfg.Director.MaxOutcomesHistory ||
					len(cur.Director.PendingEvents) > cfg.Director.MaxPendingEvents ||
					len(cur.Ecosystem.Reservations) > cfg.Ecosystem.MaxReservations {
					t.Fatalf("seed %d tick %d exceeded collection caps", seed, tick)
				}
				runtime.GC()
				runtime.ReadMemStats(&m)
				if m.HeapAlloc > peakHeap {
					peakHeap = m.HeapAlloc
				}
			}
		}

		if cur.Ecosystem.Epoch != epochsPerSeed {
			t.Fatalf("seed %d expected epoch %d, got %d", seed, epochsPerSeed, cur.Ecosystem.Epoch)
		}
		if _, err := cur.Checksum(cfg); err != nil {
			t.Fatalf("seed %d final checksum failed: %v", seed, err)
		}
		if sIdx == len(seeds)-1 {
			runtime.GC()
			runtime.ReadMemStats(&m)
			finalHeap = m.HeapAlloc
		}
	}

	if totalCampaignsResolved < 6 {
		t.Fatalf("expected repeated multi-campaign lifecycle across 3,000 epochs, resolved=%d", totalCampaignsResolved)
	}
	t.Logf("Long-duration stability passed: 3 seeds x %d epochs (%d ticks), resolved=%d campaigns, baselineHeap=%dB peakHeap=%dB finalHeap=%dB",
		epochsPerSeed, len(seeds)*epochsPerSeed*ticksPerEpoch, totalCampaignsResolved, baselineHeap, peakHeap, finalHeap)
	// Retained heap growth must remain tightly bounded (< 32 MiB).
	if finalHeap > baselineHeap+32*1024*1024 {
		t.Fatalf("suspected memory leak: baselineHeap=%d finalHeap=%d", baselineHeap, finalHeap)
	}
}

func TestValidationConfigEnumsAndCrossLayerInvariants(t *testing.T) {
	// Enum coverage: EventCategory, WorldEventKind, CampaignState.
	for _, cat := range []worldevents.EventCategory{worldevents.CategoryCreature, worldevents.CategoryEnvironmental} {
		if !cat.Valid() || cat.Code() == 0 {
			t.Fatalf("expected valid category %q", cat)
		}
	}
	if worldevents.EventCategory("Bad").Valid() || worldevents.EventCategory("Bad").Code() != 0 {
		t.Fatalf("expected invalid category")
	}
	if worldevents.WorldEventKind("Bad").Valid() {
		t.Fatalf("expected invalid event kind")
	}
	allStates := []worldevents.CampaignState{
		worldevents.CampaignCandidate, worldevents.CampaignScheduled, worldevents.CampaignReconnaissance,
		worldevents.CampaignPreparing, worldevents.CampaignWarning, worldevents.CampaignMobilizing,
		worldevents.CampaignActive, worldevents.CampaignResolving, worldevents.CampaignDefended,
		worldevents.CampaignCaptured, worldevents.CampaignCancelled, worldevents.CampaignExpired,
		worldevents.CampaignRecovering, worldevents.CampaignCompleted,
	}
	for _, st := range allStates {
		if !st.Valid() || st.Code() == 0 {
			t.Fatalf("expected valid state %q", st)
		}
	}
	if worldevents.CampaignState("Bad").Valid() || worldevents.CampaignState("Bad").Code() != 0 {
		t.Fatalf("expected invalid state")
	}
	if !worldevents.CampaignCompleted.IsTerminalOutcome() || worldevents.CampaignActive.IsTerminalOutcome() {
		t.Fatalf("IsTerminalOutcome check failed")
	}

	// Config and policy validation error paths.
	cfg := worldevents.DefaultOrchestratedConfig()
	if _, ok := worldevents.LookupPolicy(cfg.Director, "nonexistent"); ok {
		t.Fatalf("expected LookupPolicy miss")
	}
	if _, ok := worldevents.LookupPolicyByFamily(cfg.Director, ai.Family("unknown")); ok {
		t.Fatalf("expected LookupPolicyByFamily miss")
	}

	badCfg := cfg
	badCfg.World.OrchestrationMode = world.OrchestrationLegacyThreat
	if err := badCfg.Validate(); !errors.Is(err, worldevents.ErrInvalidConfig) {
		t.Fatalf("expected ErrInvalidConfig for LegacyThreat in OrchestratedConfig, got %v", err)
	}

	badDir := worldevents.DefaultConfig()
	badDir.RulesVersion = 99
	if err := badDir.Validate(); err == nil {
		t.Fatalf("expected rules_version error")
	}
	badDir = worldevents.DefaultConfig()
	badDir.CandidateEvalIntervalTicks = 0
	if err := badDir.Validate(); err == nil {
		t.Fatalf("expected eval interval error")
	}
	badDir = worldevents.DefaultConfig()
	badDir.MaxPendingEvents = 0
	if err := badDir.Validate(); err == nil {
		t.Fatalf("expected capacity error")
	}
	badDir = worldevents.DefaultConfig()
	badDir.PriorityAgingPerTick = -1
	if err := badDir.Validate(); err == nil {
		t.Fatalf("expected negative aging error")
	}
	badDir = worldevents.DefaultConfig()
	badDir.Policies = nil
	if err := badDir.Validate(); err == nil {
		t.Fatalf("expected empty policies error")
	}
	badDir = worldevents.DefaultConfig()
	badDir.Policies = append(badDir.Policies, badDir.Policies[0])
	if err := badDir.Validate(); err == nil {
		t.Fatalf("expected duplicate policy template error")
	}

	// Policy template validation edge cases.
	badTpl := worldevents.DefaultCampaignPolicies()[0]
	badTpl.TemplateID = ""
	if err := badTpl.Validate(); err == nil {
		t.Fatalf("expected empty template_id error")
	}
	badTpl = worldevents.DefaultCampaignPolicies()[0]
	badTpl.MinFreePopulation = 0
	if err := badTpl.Validate(); err == nil {
		t.Fatalf("expected min_free_population error")
	}
	badTpl = worldevents.DefaultCampaignPolicies()[0]
	badTpl.ReconCount = 0
	if err := badTpl.Validate(); err == nil {
		t.Fatalf("expected recon_count error")
	}
	badTpl = worldevents.DefaultCampaignPolicies()[0]
	badTpl.ReconArchetype = "orc-vanguard" // family mismatch!
	if err := badTpl.Validate(); err == nil {
		t.Fatalf("expected recon family mismatch error")
	}
	badTpl = worldevents.DefaultCampaignPolicies()[0]
	badTpl.MainForces = nil
	if err := badTpl.Validate(); err == nil {
		t.Fatalf("expected empty main_forces error")
	}
	badTpl = worldevents.DefaultCampaignPolicies()[0]
	badTpl.MainForces = []worldevents.ForceUnit{{Archetype: "orc-vanguard", Count: 1, Position: 1000}}
	if err := badTpl.Validate(); err == nil {
		t.Fatalf("expected main force family mismatch error")
	}
	badTpl = worldevents.DefaultCampaignPolicies()[0]
	badTpl.ReinforcementArchetype = "orc-vanguard"
	if err := badTpl.Validate(); err == nil {
		t.Fatalf("expected reinforcement family mismatch error")
	}
	badTpl = worldevents.DefaultCampaignPolicies()[0]
	badTpl.PriorityWeightLeadership = -5
	if err := badTpl.Validate(); err == nil {
		t.Fatalf("expected negative priority weight error")
	}

	// DirectorState.Clone handles nil slices cleanly.
	var emptyDir worldevents.DirectorState
	clonedDir := emptyDir.Clone()
	if clonedDir.PendingEvents == nil || clonedDir.Campaigns == nil || clonedDir.RegionCooldowns == nil ||
		clonedDir.SettlementCooldowns == nil || clonedDir.CompletedHistory == nil || clonedDir.TerminalOutcomes == nil {
		t.Fatalf("Clone should initialize nil slices to non-nil empty slices")
	}

	// Non-epoch ecosystem command MUST fail explicitly.
	eco := worldevents.NewHighThreatGoblinEco("val-cross", 200)
	st, err := worldevents.NewOrchestratedState("val-cross", "settlement-valewatch", 200, mustReader(t), eco)
	if err != nil {
		t.Fatalf("NewOrchestratedState: %v", err)
	}
	if _, _, err := worldevents.Step(st, worldevents.StepInput{
		EcosystemCommands: []ecosystem.Command{{Kind: ecosystem.CmdDestroyCamp, Epoch: 1, CampID: "camp-thornveil-warren"}},
	}, cfg); !errors.Is(err, worldevents.ErrInvalidCommand) {
		t.Fatalf("expected ErrInvalidCommand for eco command on non-epoch tick, got %v", err)
	}

	// Cross-layer validation mismatches.
	badTick := st.Clone()
	badTick.Director.Tick = 5
	if err := badTick.Validate(cfg); !errors.Is(err, worldevents.ErrInvalidState) {
		t.Fatalf("expected tick mismatch error, got %v", err)
	}

	badMat := st.Clone()
	badMat.Ecosystem.Populations[0].MaterializedPopulation = 7
	if err := badMat.Validate(cfg); !errors.Is(err, worldevents.ErrInvalidState) {
		t.Fatalf("expected tactical vs materialized mismatch error, got %v", err)
	}

	// Warning-phase cancellation cleanly aborts Threatened -> Peace!
	cur := st.Clone()
	cfgFast := cfg
	cfgFast.Director.CandidateEvalIntervalTicks = 1
	cfgFast.Director.Policies[0].ReconTicks = 1
	cfgFast.Director.Policies[0].PrepTicks = 1
	cfgFast.Director.Policies[0].WarningTicks = 10
	reachedWarning := false
	for tick := uint64(1); tick <= 10; tick++ {
		cur, _, err = worldevents.Step(cur, worldevents.StepInput{}, cfgFast)
		if err != nil {
			t.Fatalf("tick %d: %v", tick, err)
		}
		if len(cur.Director.Campaigns) == 1 && cur.Director.Campaigns[0].State == worldevents.CampaignWarning {
			reachedWarning = true
			break
		}
	}
	if !reachedWarning || cur.World.Invasion.State != world.InvasionThreatened {
		t.Fatalf("expected Warning + Threatened, got reached=%v inv=%s", reachedWarning, cur.World.Invasion.State)
	}
	warnCampID := cur.Director.Campaigns[0].CampaignID
	cur, _, err = worldevents.Step(cur, worldevents.StepInput{
		DirectorCommands: []worldevents.DirectorCommand{{
			Kind:       worldevents.DirCmdCancelCampaign,
			Tick:       cur.Director.Tick + 1,
			CampaignID: warnCampID,
			Reason:     "abort during warning",
		}},
	}, cfgFast)
	if err != nil {
		t.Fatalf("cancel during Warning failed: %v", err)
	}
	if cur.World.Invasion.State != world.InvasionPeace || cur.World.Invasion.CampaignID != "" {
		t.Fatalf("expected Threatened aborted cleanly back to Peace, got %+v", cur.World.Invasion)
	}

	// Context cancellation in RunOrchestrated.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := worldevents.RunOrchestrated(ctx, st, nil, 10, cfg, 64); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
}

func TestDirectorStateValidationAndDispatchEdgeCases(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	dirCfg := cfg.Director

	// DirectorState.Validate exhaustive invariants.
	bad := worldevents.NewDirectorState("", 1)
	if err := bad.Validate(dirCfg); err == nil {
		t.Fatalf("expected empty simID error")
	}
	bad = worldevents.NewDirectorState("v", 1)
	bad.RulesVersion = 77
	if err := bad.Validate(dirCfg); err == nil {
		t.Fatalf("expected rules_version mismatch error")
	}
	bad = worldevents.NewDirectorState("v", 1)
	bad.PendingEvents = []worldevents.ScheduledEvent{
		{EventID: "b", Kind: worldevents.EventRecoveryFollowup, Category: worldevents.CategoryCreature, ScheduledTick: 1, DeadlineTick: 2},
		{EventID: "a", Kind: worldevents.EventRecoveryFollowup, Category: worldevents.CategoryCreature, ScheduledTick: 1, DeadlineTick: 2},
	}
	if err := bad.Validate(dirCfg); err == nil {
		t.Fatalf("expected unsorted pending_events error")
	}
	bad.PendingEvents = []worldevents.ScheduledEvent{
		{EventID: "a", Kind: worldevents.WorldEventKind("Bad"), Category: worldevents.CategoryCreature, ScheduledTick: 1, DeadlineTick: 2},
	}
	if err := bad.Validate(dirCfg); err == nil {
		t.Fatalf("expected invalid pending_events kind error")
	}
	bad.PendingEvents = []worldevents.ScheduledEvent{
		{EventID: "a", Kind: worldevents.EventRecoveryFollowup, Category: worldevents.CategoryCreature, ScheduledTick: 10, DeadlineTick: 5},
	}
	if err := bad.Validate(dirCfg); err == nil {
		t.Fatalf("expected invalid pending_events deadline error")
	}

	// Campaign validation & concurrency cap rejection in DirectorState.Validate.
	mkCamp := func(id, reg, set string, st worldevents.CampaignState) worldevents.Campaign {
		return worldevents.Campaign{
			CampaignID: id, TemplateID: worldevents.TemplateGoblinRaid, EventKind: worldevents.EventGoblinRaidCampaign,
			RegionID: reg, SettlementID: set, FactionID: ecosystem.FactionThornGoblins, FamilyID: ai.FamilyGoblin,
			State: st, TerminalOutcome: ports.InvasionOutcomeNone, CreatedTick: 1, DeadlineTick: 50,
		}
	}
	bad = worldevents.NewDirectorState("v", 1)
	bad.Campaigns = []worldevents.Campaign{mkCamp("c2", "r1", "s1", worldevents.CampaignScheduled), mkCamp("c1", "r2", "s2", worldevents.CampaignScheduled)}
	if err := bad.Validate(dirCfg); err == nil {
		t.Fatalf("expected unsorted campaigns error")
	}
	bad.Campaigns = []worldevents.Campaign{mkCamp("c1", "r1", "s1", worldevents.CampaignActive), mkCamp("c2", "r2", "s2", worldevents.CampaignActive)}
	if err := bad.Validate(dirCfg); !errors.Is(err, worldevents.ErrCapacityExceeded) {
		t.Fatalf("expected ErrCapacityExceeded for 2 tactical active campaigns, got %v", err)
	}
	bad.Campaigns = []worldevents.Campaign{mkCamp("c1", "r1", "s1", worldevents.CampaignScheduled), mkCamp("c2", "r1", "s2", worldevents.CampaignScheduled)}
	if err := bad.Validate(dirCfg); !errors.Is(err, worldevents.ErrCapacityExceeded) {
		t.Fatalf("expected ErrCapacityExceeded for 2 same-region campaigns, got %v", err)
	}
	bad.Campaigns = []worldevents.Campaign{mkCamp("c1", "r1", "s1", worldevents.CampaignScheduled), mkCamp("c2", "r2", "s1", worldevents.CampaignScheduled)}
	if err := bad.Validate(dirCfg); !errors.Is(err, worldevents.ErrCapacityExceeded) {
		t.Fatalf("expected ErrCapacityExceeded for 2 same-settlement campaigns, got %v", err)
	}
	bad.Campaigns = nil
	bad.RegionCooldowns = []worldevents.CooldownEntry{{TargetID: "r2", ReadyAtTick: 10}, {TargetID: "r1", ReadyAtTick: 10}}
	if err := bad.Validate(dirCfg); err == nil {
		t.Fatalf("expected unsorted region cooldowns error")
	}
	bad.RegionCooldowns = nil
	bad.SettlementCooldowns = []worldevents.CooldownEntry{{TargetID: "s2", ReadyAtTick: 10}, {TargetID: "s1", ReadyAtTick: 10}}
	if err := bad.Validate(dirCfg); err == nil {
		t.Fatalf("expected unsorted settlement cooldowns error")
	}

	// OrchestratedState cross-layer validation errors.
	eco := worldevents.NewHighThreatGoblinEco("cross-err", 300)
	st, err := worldevents.NewOrchestratedState("cross-err", "settlement-valewatch", 300, mustReader(t), eco)
	if err != nil {
		t.Fatalf("NewOrchestratedState: %v", err)
	}
	badMissRes := st.Clone()
	cMissing := mkCamp("c1", ecosystem.RegionThornveilForest, "settlement-valewatch", worldevents.CampaignReconnaissance)
	cMissing.ReservationID = "res-missing"
	badMissRes.Director.Campaigns = []worldevents.Campaign{cMissing}
	if err := badMissRes.Validate(cfg); !errors.Is(err, worldevents.ErrInvalidState) {
		t.Fatalf("expected missing reservation error, got %v", err)
	}

	// Oversized MarshalSnapshot rejected.
	tinyCfg := cfg
	tinyCfg.Director.MaxSnapshotBytes = 32
	if _, err := st.MarshalSnapshot(tinyCfg); !errors.Is(err, simulation.ErrSnapshotTooLarge) {
		t.Fatalf("expected ErrSnapshotTooLarge on MarshalSnapshot, got %v", err)
	}

	// Cancelled and expired pending events + dispatch skipped when camp destroyed / HP collapsed after scheduling.
	cfgNoEval := cfg
	cfgNoEval.Director.CandidateEvalIntervalTicks = 1000
	stSched := st.Clone()
	// 1) Cancelled event in PendingEvents -> cleanly dropped.
	_, err = worldevents.EnqueueScheduledEvent(&stSched.Director, worldevents.ScheduledEvent{
		Kind: worldevents.EventRecoveryFollowup, Category: worldevents.CategoryCreature,
		RegionID: ecosystem.RegionThornveilForest, ScheduledTick: 1, DeadlineTick: 10, Cancelled: true,
	}, cfgNoEval.Director)
	if err != nil {
		t.Fatalf("enqueue cancelled: %v", err)
	}
	// 2) Expired event in PendingEvents -> emits DirEventCampaignExpired.
	_, err = worldevents.EnqueueScheduledEvent(&stSched.Director, worldevents.ScheduledEvent{
		Kind: worldevents.EventGoblinRaidCampaign, Category: worldevents.CategoryCreature, TemplateID: worldevents.TemplateGoblinRaid,
		RegionID: ecosystem.RegionThornveilForest, SettlementID: "settlement-valewatch", FactionID: ecosystem.FactionThornGoblins,
		SourcePopulationID: "pop-thornveil-goblins", SourceCampID: "camp-thornveil-warren",
		ScheduledTick: 0, DeadlineTick: 0,
	}, cfgNoEval.Director)
	if err != nil {
		t.Fatalf("enqueue expired: %v", err)
	}
	// 3) Scheduled campaign whose camp gets destroyed before dispatch -> cleanly skipped with DirEventCampaignCancelled.
	_, err = worldevents.EnqueueScheduledEvent(&stSched.Director, worldevents.ScheduledEvent{
		Kind: worldevents.EventGoblinRaidCampaign, Category: worldevents.CategoryCreature, TemplateID: worldevents.TemplateGoblinRaid,
		RegionID: ecosystem.RegionThornveilForest, SettlementID: "settlement-valewatch", FactionID: ecosystem.FactionThornGoblins,
		SourcePopulationID: "pop-thornveil-goblins", SourceCampID: "camp-thornveil-warren",
		ScheduledTick: 1, DeadlineTick: 10,
	}, cfgNoEval.Director)
	if err != nil {
		t.Fatalf("enqueue camp-dead: %v", err)
	}
	// Verify EvaluateCandidates skips source population that already has pending event!
	cands, err := worldevents.EvaluateCandidates(stSched.Director, stSched.Ecosystem, stSched.World, cfgNoEval.Director, 2)
	if err != nil || len(cands) != 0 {
		t.Fatalf("expected EvaluateCandidates to skip already-pending source population, got %+v (err=%v)", cands, err)
	}
	// Destroy camp directly in fixture before tick 1 dispatch.
	for i := range stSched.Ecosystem.Camps {
		if stSched.Ecosystem.Camps[i].CampID == "camp-thornveil-warren" {
			stSched.Ecosystem.Camps[i].State = ecosystem.CampDestroyed
		}
	}
	afterSched, outSched, err := worldevents.Step(stSched, worldevents.StepInput{}, cfgNoEval)
	if err != nil {
		t.Fatalf("Step cancelled/expired/destroyed-dispatch: %v", err)
	}
	if len(afterSched.Director.PendingEvents) != 0 || len(afterSched.Director.Campaigns) != 0 {
		t.Fatalf("expected all 3 pending events processed/dropped, got pending=%d campaigns=%d",
			len(afterSched.Director.PendingEvents), len(afterSched.Director.Campaigns))
	}
	sawExp, sawCan := false, false
	for _, ev := range outSched.DirectorEvents {
		if ev.Type == worldevents.DirEventCampaignExpired {
			sawExp = true
		}
		if ev.Type == worldevents.DirEventCampaignCancelled {
			sawCan = true
		}
	}
	if !sawExp || !sawCan {
		t.Fatalf("expected both Expired and Cancelled director events, got exp=%v can=%v", sawExp, sawCan)
	}

	// DirectorCommand validation errors: wrong tick, unknown kind, cancelling an Active campaign.
	if _, _, err := worldevents.Step(st, worldevents.StepInput{
		DirectorCommands: []worldevents.DirectorCommand{{Kind: worldevents.DirCmdCancelCampaign, Tick: 99, CampaignID: "x"}},
	}, cfg); !errors.Is(err, worldevents.ErrInvalidCommand) {
		t.Fatalf("expected wrong tick error, got %v", err)
	}
	if _, _, err := worldevents.Step(st, worldevents.StepInput{
		DirectorCommands: []worldevents.DirectorCommand{{Kind: worldevents.DirectorCommandKind("Bogus"), Tick: 1}},
	}, cfg); !errors.Is(err, worldevents.ErrInvalidCommand) {
		t.Fatalf("expected unknown director command error, got %v", err)
	}

	// Advance a campaign to Active and verify DirCmdCancelCampaign is rejected with ErrInvalidCampaignTransition.
	cur := st.Clone()
	cfgFast := cfg
	cfgFast.Director.CandidateEvalIntervalTicks = 1
	cfgFast.Director.Policies[0].ReconTicks = 1
	cfgFast.Director.Policies[0].PrepTicks = 1
	cfgFast.Director.Policies[0].WarningTicks = 1
	for tick := uint64(1); tick <= 12; tick++ {
		cur, _, err = worldevents.Step(cur, worldevents.StepInput{}, cfgFast)
		if err != nil {
			t.Fatalf("fast tick %d: %v", tick, err)
		}
		if len(cur.Director.Campaigns) == 1 && cur.Director.Campaigns[0].State == worldevents.CampaignActive {
			break
		}
	}
	if len(cur.Director.Campaigns) != 1 || cur.Director.Campaigns[0].State != worldevents.CampaignActive {
		t.Fatalf("expected Active campaign, got %+v", cur.Director.Campaigns)
	}
	// EvaluateCandidates while region has in-flight campaign skips it.
	cur.Director.SettlementCooldowns = nil
	if cands2, err := worldevents.EvaluateCandidates(cur.Director, cur.Ecosystem, cur.World, cfgFast.Director, 2); err != nil || len(cands2) != 0 {
		t.Fatalf("expected 0 candidates during active campaign, got %+v", cands2)
	}
	if _, _, err := worldevents.Step(cur, worldevents.StepInput{
		DirectorCommands: []worldevents.DirectorCommand{{
			Kind:       worldevents.DirCmdCancelCampaign,
			Tick:       cur.Director.Tick + 1,
			CampaignID: cur.Director.Campaigns[0].CampaignID,
		}},
	}, cfgFast); !errors.Is(err, worldevents.ErrInvalidCampaignTransition) {
		t.Fatalf("expected ErrInvalidCampaignTransition cancelling Active campaign, got %v", err)
	}

	// Cross-layer tactical group provenance & reservation invariant rejections in OrchestratedState.Validate.
	badGroup := cur.Clone()
	badGroup.World.Groups[0].Accounted = true
	if err := badGroup.Validate(cfgFast); !errors.Is(err, worldevents.ErrInvalidState) {
		t.Fatalf("expected active accounted group error, got %v", err)
	}
	badGroup = cur.Clone()
	badGroup.World.Groups[0].SourcePopulationID = "pop-missing"
	if err := badGroup.Validate(cfgFast); !errors.Is(err, worldevents.ErrInvalidState) {
		t.Fatalf("expected bad group provenance error, got %v", err)
	}
	badGroup = cur.Clone()
	badGroup.World.Groups[0].ReservationID = "res-wrong"
	if err := badGroup.Validate(cfgFast); !errors.Is(err, worldevents.ErrInvalidState) {
		t.Fatalf("expected bad group reservation mismatch error, got %v", err)
	}

	// Campaign provenance mismatch & duplicate reservation reference in OrchestratedState.Validate.
	badCampRes := cur.Clone()
	badCampRes.Director.Campaigns[0].SourceCampID = "camp-wrong"
	if err := badCampRes.Validate(cfgFast); !errors.Is(err, worldevents.ErrInvalidState) {
		t.Fatalf("expected campaign reservation provenance mismatch error, got %v", err)
	}
	badDupRes := cur.Clone()
	cDup := badDupRes.Director.Campaigns[0]
	cDup.CampaignID = "cmp:dup:999"
	cDup.State = worldevents.CampaignCompleted
	badDupRes.Director.Campaigns = append(badDupRes.Director.Campaigns, cDup)
	if err := badDupRes.Validate(cfgFast); !errors.Is(err, worldevents.ErrInvalidState) {
		t.Fatalf("expected duplicate campaign reservation error, got %v", err)
	}

	// OrchestratedConfig invalid world/ecosystem sub-configs & nil reader in NewOrchestratedState.
	badWorldCfg := cfg
	badWorldCfg.World.Version = 999
	if err := badWorldCfg.Validate(); err == nil {
		t.Fatalf("expected invalid world config error")
	}
	badEcoCfg := cfg
	badEcoCfg.Ecosystem.Version = 999
	if err := badEcoCfg.Validate(); err == nil {
		t.Fatalf("expected invalid ecosystem config error")
	}
	if _, err := worldevents.NewOrchestratedState("nil-rdr", "settlement-valewatch", 1, nil, eco); err == nil {
		t.Fatalf("expected error on nil reader")
	}

	// Multiple DirectorCommands in same tick (canonical sort) + validateDirectCandidate rejections.
	dualEco := worldevents.NewDualHostileConflictEco("multi-dir-cmd", 301)
	stDual, err := worldevents.NewOrchestratedState("multi-dir-cmd", "settlement-valewatch", 301, mustReader(t), dualEco)
	if err != nil {
		t.Fatalf("NewOrchestratedState dual: %v", err)
	}
	stDualAfter, _, err := worldevents.Step(stDual, worldevents.StepInput{
		DirectorCommands: []worldevents.DirectorCommand{
			{
				Kind: worldevents.DirCmdScheduleCampaign, Tick: 1, TemplateID: worldevents.TemplateOrcWarband,
				RegionID: ecosystem.RegionIronfangFrontier, SourcePopulationID: "pop-ironfang-orcs", SourceCampID: "camp-ironfang-bastion",
			},
			{
				Kind: worldevents.DirCmdScheduleCampaign, Tick: 1, TemplateID: worldevents.TemplateGoblinRaid,
				RegionID: ecosystem.RegionThornveilForest, SourcePopulationID: "pop-thornveil-goblins", SourceCampID: "camp-thornveil-warren",
			},
		},
	}, cfgNoEval)
	if err != nil || len(stDualAfter.Director.Campaigns) != 1 || len(stDualAfter.Director.PendingEvents) != 1 {
		t.Fatalf("expected 1 launched and 1 queued from dual DirectorCommands, got camp=%d pend=%d err=%v",
			len(stDualAfter.Director.Campaigns), len(stDualAfter.Director.PendingEvents), err)
	}
	for _, badCmd := range []worldevents.DirectorCommand{
		{Kind: worldevents.DirCmdScheduleCampaign, Tick: 1, TemplateID: "bad-tpl", RegionID: ecosystem.RegionThornveilForest, SourcePopulationID: "pop-thornveil-goblins", SourceCampID: "camp-thornveil-warren"},
		{Kind: worldevents.DirCmdScheduleCampaign, Tick: 1, TemplateID: worldevents.TemplateGoblinRaid, RegionID: ecosystem.RegionThornveilForest, SourcePopulationID: "pop-missing", SourceCampID: "camp-thornveil-warren"},
		{Kind: worldevents.DirCmdScheduleCampaign, Tick: 1, TemplateID: worldevents.TemplateOrcWarband, RegionID: ecosystem.RegionThornveilForest, SourcePopulationID: "pop-thornveil-goblins", SourceCampID: "camp-thornveil-warren"},
		{Kind: worldevents.DirCmdScheduleCampaign, Tick: 1, TemplateID: worldevents.TemplateGoblinRaid, RegionID: ecosystem.RegionThornveilForest, SourcePopulationID: "pop-thornveil-goblins", SourceCampID: "camp-missing"},
	} {
		if _, _, err := worldevents.Step(stDual, worldevents.StepInput{DirectorCommands: []worldevents.DirectorCommand{badCmd}}, cfgNoEval); !errors.Is(err, worldevents.ErrInvalidCommand) {
			t.Fatalf("expected ErrInvalidCommand for %+v, got %v", badCmd, err)
		}
	}

	// Preparing -> Cancelled when settlement HP drops below MinSimulatedDefenseHP mid-preparation,
	// and Scheduled -> Cancelled when FreePopulation drops below required contingent right after scheduling.
	stCollapse := st.Clone()
	stCollapse.World.SettlementDefenseHP = 10 // below MinSimulatedDefenseHP
	_, err = worldevents.EnqueueScheduledEvent(&stCollapse.Director, worldevents.ScheduledEvent{
		Kind: worldevents.EventGoblinRaidCampaign, Category: worldevents.CategoryCreature, TemplateID: worldevents.TemplateGoblinRaid,
		RegionID: ecosystem.RegionThornveilForest, SettlementID: "settlement-valewatch", FactionID: ecosystem.FactionThornGoblins,
		SourcePopulationID: "pop-thornveil-goblins", SourceCampID: "camp-thornveil-warren",
		ScheduledTick: 1, DeadlineTick: 20,
	}, cfgNoEval.Director)
	if err != nil {
		t.Fatalf("enqueue collapse: %v", err)
	}
	afterCollapse, outCollapse, err := worldevents.Step(stCollapse, worldevents.StepInput{}, cfgNoEval)
	if err != nil || len(afterCollapse.Director.Campaigns) != 0 {
		t.Fatalf("expected dispatch skipped on collapsed settlement, got camp=%d err=%v", len(afterCollapse.Director.Campaigns), err)
	}
	foundCancel := false
	for _, ev := range outCollapse.DirectorEvents {
		if ev.Type == worldevents.DirEventCampaignCancelled {
			foundCancel = true
		}
	}
	if !foundCancel {
		t.Fatalf("expected DirEventCampaignCancelled when settlement defense collapsed before dispatch")
	}

	// Scheduled -> Cancelled when FreePopulation drops insufficient before reservation executes.
	stLowPop := st.Clone()
	for i := range stLowPop.Ecosystem.Populations {
		if stLowPop.Ecosystem.Populations[i].PopulationID == "pop-thornveil-goblins" {
			stLowPop.Ecosystem.Populations[i].FreePopulation = 3
		}
	}
	_, err = worldevents.EnqueueScheduledEvent(&stLowPop.Director, worldevents.ScheduledEvent{
		Kind: worldevents.EventGoblinRaidCampaign, Category: worldevents.CategoryCreature, TemplateID: worldevents.TemplateGoblinRaid,
		RegionID: ecosystem.RegionThornveilForest, SettlementID: "settlement-valewatch", FactionID: ecosystem.FactionThornGoblins,
		SourcePopulationID: "pop-thornveil-goblins", SourceCampID: "camp-thornveil-warren",
		ScheduledTick: 1, DeadlineTick: 20,
	}, cfgNoEval.Director)
	if err != nil {
		t.Fatalf("enqueue lowpop: %v", err)
	}
	afterLowPop, _, err := worldevents.Step(stLowPop, worldevents.StepInput{}, cfgNoEval)
	if err != nil || len(afterLowPop.Director.Campaigns) != 0 || len(afterLowPop.Director.CompletedHistory) != 1 {
		t.Fatalf("expected scheduled campaign cancelled cleanly on insufficient pop, got camp=%d hist=%d err=%v",
			len(afterLowPop.Director.Campaigns), len(afterLowPop.Director.CompletedHistory), err)
	}

	// Too many director commands rejected with ErrCapacityExceeded.
	manyCmds := make([]worldevents.DirectorCommand, cfg.World.MaxCommandsPerTick+1)
	if _, _, err := worldevents.Step(st, worldevents.StepInput{DirectorCommands: manyCmds}, cfg); !errors.Is(err, worldevents.ErrCapacityExceeded) {
		t.Fatalf("expected ErrCapacityExceeded on excessive director commands, got %v", err)
	}

	// MaxActiveCampaignsGlobal exceeded in DirectorState.Validate.
	badGlobal := worldevents.NewDirectorState("g", 1)
	badGlobal.Campaigns = []worldevents.Campaign{
		mkCamp("c1", "r1", "s1", worldevents.CampaignScheduled),
		mkCamp("c2", "r2", "s2", worldevents.CampaignScheduled),
		mkCamp("c3", "r3", "s3", worldevents.CampaignScheduled),
		mkCamp("c4", "r4", "s4", worldevents.CampaignScheduled),
	}
	if err := badGlobal.Validate(dirCfg); !errors.Is(err, worldevents.ErrCapacityExceeded) {
		t.Fatalf("expected ErrCapacityExceeded for 4 global campaigns (>3), got %v", err)
	}
}
