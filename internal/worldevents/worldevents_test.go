package worldevents_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"runtime"
	"strings"
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

	// Verify v5 snapshot encodes schema_version == 5 and explicitly rejects v1, v2, v3, v4, and oversized payloads.
	raw, err := resG.FinalState.MarshalSnapshot(cfg)
	if err != nil {
		t.Fatalf("MarshalSnapshot: %v", err)
	}
	var env map[string]any
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("json.Unmarshal envelope: %v", err)
	}
	if v, ok := env["schema_version"].(float64); !ok || uint32(v) != 5 {
		t.Fatalf("expected schema_version=5, got %v", env["schema_version"])
	}
	for _, legacyVer := range []uint32{1, 2, 3, 4} {
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
			if len(out.DirectorEvents) != 0 {
				seq, page, more, err := worldevents.PendingDirectorEventPage(cur, 0, cfg)
				if err != nil {
					t.Fatal(err)
				}
				collected := append([]worldevents.DirectorEvent(nil), page...)
				for more {
					_, page, more, err = worldevents.PendingDirectorEventPage(cur, len(collected), cfg)
					if err != nil {
						t.Fatal(err)
					}
					collected = append(collected, page...)
				}
				if len(collected) != len(out.DirectorEvents) {
					t.Fatal("director delivery count mismatch")
				}
				for i := range collected {
					if collected[i].EventID != out.DirectorEvents[i].EventID {
						t.Fatal("director delivery mismatch")
					}
				}
				cur, err = worldevents.AcknowledgeDirectorBatch(cur, seq, cfg)
				if err != nil {
					t.Fatal(err)
				}
			}
			// The long-running consumer explicitly confirms delivered facts. Compare
			// the outbox to this tick's output before acknowledging it.
			pendingContributions, err := worldevents.PendingContributionResults(cur, cfg)
			if err != nil {
				t.Fatal(err)
			}
			var emittedContributions []ports.ContributionResult
			for _, event := range out.WorldEvents {
				if event.Type == world.EventContributionRecorded && event.Contribution != nil {
					emittedContributions = append(emittedContributions, *event.Contribution)
				}
			}
			if len(pendingContributions) != len(emittedContributions) {
				t.Fatalf("contribution delivery count mismatch: %d != %d", len(pendingContributions), len(emittedContributions))
			}
			for i, pending := range pendingContributions {
				if pending.Result != emittedContributions[i] {
					t.Fatal("contribution outbox differs from emitted fact")
				}
				cur, err = worldevents.AcknowledgeContribution(cur, pending.Sequence, cfg)
				if err != nil {
					t.Fatal(err)
				}
			}
			pendingOutcomes, err := worldevents.PendingTerminalOutcomes(cur, cfg)
			if err != nil {
				t.Fatal(err)
			}
			if len(pendingOutcomes) != len(out.TerminalOutcomes) {
				t.Fatal("terminal delivery count mismatch")
			}
			for i, pending := range pendingOutcomes {
				if pending != out.TerminalOutcomes[i] {
					t.Fatal("terminal outbox differs from emitted fact")
				}
				cur, err = worldevents.AcknowledgeTerminalOutcome(cur, pending.Sequence, cfg)
				if err != nil {
					t.Fatal(err)
				}
			}

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

func TestDirectorEventLimitFailsAtomicallyWithoutTruncation(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	cfg.Director.MaxEventsPerUpdate = 1
	cfg.Director.MaxPendingDirectorBatches = 1
	eco := worldevents.NewHighThreatGoblinEco("limited-events", 101)
	st, err := worldevents.NewOrchestratedState("limited-events", "settlement-valewatch", 101, mustReader(t), eco)
	if err != nil {
		t.Fatal(err)
	}
	seenMultiEventTick := false
	var expected []worldevents.DirectorEvent
	for i := 0; i < 200; i++ {
		before, err := st.Checksum(cfg)
		if err != nil {
			t.Fatal(err)
		}
		next, out, err := worldevents.Step(st, worldevents.StepInput{}, cfg)
		if errors.Is(err, worldevents.ErrDirectorBackpressure) {
			after, checkErr := st.Checksum(cfg)
			if checkErr != nil || before != after {
				t.Fatal("backpressure mutated state")
			}
			raw, err := st.MarshalSnapshot(cfg)
			if err != nil {
				t.Fatal(err)
			}
			restored, err := worldevents.UnmarshalOrchestratedSnapshot(raw, cfg)
			if err != nil {
				t.Fatal(err)
			}
			var collected []worldevents.DirectorEvent
			var seq uint64
			for offset := 0; ; {
				var page []worldevents.DirectorEvent
				var more bool
				seq, page, more, err = worldevents.PendingDirectorEventPage(restored, offset, cfg)
				if err != nil || len(page) != 1 {
					t.Fatalf("page: %+v %v", page, err)
				}
				collected = append(collected, page...)
				offset += len(page)
				if !more {
					break
				}
			}
			if len(collected) > 1 {
				seenMultiEventTick = true
			}
			if !reflect.DeepEqual(collected, expected) {
				t.Fatalf("pending facts differ from committed tick: got %+v, want %+v", collected, expected)
			}
			if _, err := worldevents.AcknowledgeDirectorBatch(restored, seq+1, cfg); !errors.Is(err, worldevents.ErrInvalidCommand) {
				t.Fatalf("invalid ack: %v", err)
			}
			recovered, err := worldevents.AcknowledgeDirectorBatch(restored, seq, cfg)
			if err != nil {
				t.Fatal(err)
			}
			dup, err := worldevents.AcknowledgeDirectorBatch(recovered, seq, cfg)
			if err != nil {
				t.Fatal(err)
			}
			a, _ := recovered.Checksum(cfg)
			b, _ := dup.Checksum(cfg)
			if a != b {
				t.Fatal("duplicate ack changed state")
			}
			advanced, resumedOut, err := worldevents.Step(recovered, worldevents.StepInput{}, cfg)
			if err != nil || advanced.Director.Tick != st.Director.Tick+1 {
				t.Fatalf("tick did not advance: %v", err)
			}
			if err := advanced.Validate(cfg); err != nil {
				t.Fatal(err)
			}
			st = advanced
			expected = resumedOut.DirectorEvents
			if seenMultiEventTick {
				return
			}
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		if len(out.DirectorEvents) > 1 {
			seenMultiEventTick = true
		}
		if len(out.DirectorEvents) > 0 {
			expected = out.DirectorEvents
		}
		st = next
	}
	t.Fatal("scenario did not exercise saturation and multi-page events")
}

func TestRunnerReturnsRecoverableStateOnBackpressure(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	cfg.Director.MaxPendingDirectorBatches = 1
	st, err := worldevents.NewOrchestratedState("runner-backpressure", "settlement-valewatch", 101, mustReader(t), worldevents.NewHighThreatGoblinEco("runner-backpressure", 101))
	if err != nil {
		t.Fatal(err)
	}
	result, err := worldevents.RunOrchestrated(context.Background(), st, nil, 200, cfg, 1)
	if !errors.Is(err, worldevents.ErrCapacityExceeded) {
		t.Fatalf("expected bounded consumer capacity: %v", err)
	}
	if result.FinalChecksum == "" {
		t.Fatal("last committed state was not returned")
	}
	next, _, err := worldevents.Step(result.FinalState, worldevents.StepInput{}, cfg)
	if err != nil || next.Director.Tick != result.FinalState.Director.Tick+1 {
		t.Fatalf("runner state could not resume: %v", err)
	}
}

func TestCancellationReasonLimitFailsAtomically(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	st, err := worldevents.NewOrchestratedState("reason-limit", "settlement-valewatch", 1, mustReader(t), worldevents.NewHighThreatGoblinEco("reason-limit", 1))
	if err != nil {
		t.Fatal(err)
	}
	before, err := st.Checksum(cfg)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = worldevents.Step(st, worldevents.StepInput{DirectorCommands: []worldevents.DirectorCommand{{Kind: worldevents.DirCmdCancelCampaign, Tick: 1, CampaignID: "x", Reason: strings.Repeat("x", cfg.Director.MaxIdentifierLength+1)}}}, cfg)
	if !errors.Is(err, worldevents.ErrInvalidCommand) {
		t.Fatalf("oversized reason: %v", err)
	}
	after, err := st.Checksum(cfg)
	if err != nil || before != after {
		t.Fatal("rejected cancellation mutated state")
	}
}

func TestOneReservationSlotCanBeReusedByCampaigns(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	cfg.Ecosystem.MaxReservations = 1
	cfg.World.HostileBaseDamage = 1
	cfg.World.HostileDamageVariance = 0
	cfg.World.PlayerStrikeBaseDamage = 1000
	st, err := worldevents.NewOrchestratedState("one-reservation", "settlement-valewatch", 10001, mustReader(t), worldevents.NewDualHostileConflictEco("one-reservation", 10001))
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5000 && st.Ecosystem.ReservationSeq < 3; i++ {
		var input worldevents.StepInput
		if st.World.Invasion.State == world.InvasionUnderAttack {
			tick := st.World.Tick + 1
			if len(st.World.Defenders) == 0 {
				input.GameplayCommands = []world.GameplayCommand{{Kind: world.CmdDeployDefender, Tick: tick, PlayerID: "defender", Position: 3000}}
			} else if tick%9 == 0 && st.World.Defenders[0].HP > 0 {
				for _, group := range st.World.Groups {
					if group.HP > 0 && group.State != ai.StateDead && !group.Routed {
						input.GameplayCommands = []world.GameplayCommand{{Kind: world.CmdPlayerDefendStrike, Tick: tick, PlayerID: "defender", TargetGroupID: group.GroupID}}
						break
					}
				}
			}
		}
		next, _, err := worldevents.Step(st, input, cfg)
		if err != nil {
			t.Fatalf("tick %d: %v", st.Director.Tick+1, err)
		}
		st = next
		for len(st.Director.PendingDirectorBatches) > 0 {
			st, err = worldevents.AcknowledgeDirectorBatch(st, st.Director.PendingDirectorBatches[0].Sequence, cfg)
			if err != nil {
				t.Fatal(err)
			}
		}
		for len(st.Director.PendingOutcomes) > 0 {
			st, err = worldevents.AcknowledgeTerminalOutcome(st, st.Director.PendingOutcomes[0].Sequence, cfg)
			if err != nil {
				t.Fatal(err)
			}
		}
		for len(st.Director.PendingContributions) > 0 {
			st, err = worldevents.AcknowledgeContribution(st, st.Director.PendingContributions[0].Sequence, cfg)
			if err != nil {
				t.Fatal(err)
			}
		}
		if err := st.Validate(cfg); err != nil {
			t.Fatalf("population/campaign invariant: %v", err)
		}
	}
	if st.Ecosystem.ReservationSeq < 3 {
		t.Fatalf("reservation slot was not reused: seq=%d tick=%d invasion=%s hp=%d reservations=%d campaigns=%d history=%d", st.Ecosystem.ReservationSeq, st.Director.Tick, st.World.Invasion.State, st.World.SettlementDefenseHP, len(st.Ecosystem.Reservations), len(st.Director.Campaigns), len(st.Director.CompletedHistory))
	}
}

func TestDirectorPartialAcknowledgementSurvivesRestore(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	cfg.Director.MaxEventsPerUpdate = 1
	cfg.Director.MaxPendingDirectorBatches = 2
	st, err := worldevents.NewOrchestratedState("partial-ack", "settlement-valewatch", 7, mustReader(t), worldevents.NewHighThreatGoblinEco("partial-ack", 7))
	if err != nil {
		t.Fatal(err)
	}
	st.Director.DirectorBatchSeq = 2
	st.Director.PendingDirectorBatches = []worldevents.DirectorEventBatch{
		{Sequence: 1, Events: []worldevents.DirectorEvent{{EventID: "a", SimulationID: "partial-ack"}, {EventID: "b", SimulationID: "partial-ack"}}},
		{Sequence: 2, Events: []worldevents.DirectorEvent{{EventID: "c", SimulationID: "partial-ack"}}},
	}
	if _, err := worldevents.AcknowledgeDirectorBatch(st, 2, cfg); !errors.Is(err, worldevents.ErrInvalidCommand) {
		t.Fatalf("skipped batch: %v", err)
	}
	seq, first, more, err := worldevents.PendingDirectorEventPage(st, 0, cfg)
	if err != nil || seq != 1 || len(first) != 1 || !more {
		t.Fatalf("first page: %v %v", first, err)
	}
	first[0].EventID = "mutated"
	_, again, _, _ := worldevents.PendingDirectorEventPage(st, 0, cfg)
	if again[0].EventID != "a" {
		t.Fatal("query modified pending fact")
	}
	_, second, more, err := worldevents.PendingDirectorEventPage(st, 1, cfg)
	if err != nil || len(second) != 1 || second[0].EventID != "b" || more {
		t.Fatalf("second page: %v %v", second, err)
	}
	st, err = worldevents.AcknowledgeDirectorBatch(st, 1, cfg)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := st.MarshalSnapshot(cfg)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := worldevents.UnmarshalOrchestratedSnapshot(raw, cfg)
	if err != nil {
		t.Fatal(err)
	}
	seq, page, _, err := worldevents.PendingDirectorEventPage(restored, 0, cfg)
	if err != nil || seq != 2 || len(page) != 1 || page[0].EventID != "c" {
		t.Fatalf("restored page: %v %v", page, err)
	}
	dup, err := worldevents.AcknowledgeDirectorBatch(restored, 1, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(dup.Director.PendingDirectorBatches) != 1 {
		t.Fatal("duplicate ack lost a batch")
	}
}

func TestCampaignAdmissionKeepsFollowupSlot(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	cfg.Director.MaxPendingEvents = 2
	cfg.Director.CandidateEvalIntervalTicks = 100
	st, err := worldevents.NewOrchestratedState("reserved-slot", "settlement-valewatch", 101, mustReader(t), worldevents.NewHighThreatGoblinEco("reserved-slot", 101))
	if err != nil {
		t.Fatal(err)
	}
	_, err = worldevents.EnqueueScheduledEvent(&st.Director, worldevents.ScheduledEvent{Kind: worldevents.EventRecoveryFollowup, Category: worldevents.CategoryCreature, RegionID: ecosystem.RegionThornveilForest, ScheduledTick: 100, DeadlineTick: 150}, cfg.Director)
	if err != nil {
		t.Fatal(err)
	}
	before, err := st.Checksum(cfg)
	if err != nil {
		t.Fatal(err)
	}
	cmd := worldevents.DirectorCommand{Kind: worldevents.DirCmdScheduleCampaign, Tick: 1, TemplateID: worldevents.TemplateGoblinRaid, RegionID: ecosystem.RegionThornveilForest, SourcePopulationID: "pop-thornveil-goblins", SourceCampID: "camp-thornveil-warren"}
	if _, _, err := worldevents.Step(st, worldevents.StepInput{DirectorCommands: []worldevents.DirectorCommand{cmd}}, cfg); !errors.Is(err, worldevents.ErrCapacityExceeded) {
		t.Fatalf("expected admission capacity error: %v", err)
	}
	after, err := st.Checksum(cfg)
	if err != nil || before != after {
		t.Fatal("rejected admission changed state")
	}
	next, _, err := worldevents.Step(st, worldevents.StepInput{}, cfg)
	if err != nil || next.Director.Tick != 1 {
		t.Fatalf("normal tick after denied admission: %v", err)
	}
}

func TestInFlightCampaignRetainsItsFollowupSlot(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	cfg.Director.MaxPendingEvents = 2
	st, err := worldevents.NewOrchestratedState("followup-slot", "settlement-valewatch", 10001, mustReader(t), worldevents.NewHighThreatGoblinEco("followup-slot", 10001))
	if err != nil {
		t.Fatal(err)
	}
	filled := false
	for i := 0; i < 1000; i++ {
		if !filled && len(st.Director.Campaigns) > 0 && st.Director.Campaigns[0].State.IsInFlight() && len(st.Director.PendingEvents) == 0 {
			future := worldevents.ScheduledEvent{Kind: worldevents.EventRecoveryFollowup, Category: worldevents.CategoryCreature, RegionID: ecosystem.RegionThornveilForest, ScheduledTick: 10000, DeadlineTick: 10050}
			if _, err := worldevents.EnqueueScheduledEvent(&st.Director, future, cfg.Director); err != nil {
				t.Fatal(err)
			}
			if _, err := worldevents.EnqueueScheduledEvent(&st.Director, future, cfg.Director); !errors.Is(err, worldevents.ErrCapacityExceeded) {
				t.Fatalf("reserved slot was consumed: %v", err)
			}
			filled = true
		}
		next, out, err := worldevents.Step(st, worldevents.StepInput{}, cfg)
		if err != nil {
			t.Fatalf("tick %d: %v", st.Director.Tick+1, err)
		}
		st = next
		for len(st.Director.PendingDirectorBatches) > 0 {
			st, err = worldevents.AcknowledgeDirectorBatch(st, st.Director.PendingDirectorBatches[0].Sequence, cfg)
			if err != nil {
				t.Fatal(err)
			}
		}
		for len(st.Director.PendingOutcomes) > 0 {
			st, err = worldevents.AcknowledgeTerminalOutcome(st, st.Director.PendingOutcomes[0].Sequence, cfg)
			if err != nil {
				t.Fatal(err)
			}
		}
		for _, ev := range out.DirectorEvents {
			if ev.Type == worldevents.DirEventChainedEventScheduled {
				if !filled || len(st.Director.PendingEvents) != 2 {
					t.Fatalf("mandatory followup missing: %+v", st.Director.PendingEvents)
				}
				return
			}
		}
	}
	t.Fatal("campaign did not reach mandatory follow-up")
}

func TestContributionPressureDefersQueuedCampaignUntilAcknowledged(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	// Tight budget: MaxPendingContributions == World.MaxContributions so 1 unacked
	// contribution leaves < MaxContributions free slots and must pause optional admission.
	cfg.Director.MaxPendingContributions = cfg.World.MaxContributions
	const sim = "admission-pressure"
	st, err := worldevents.NewOrchestratedState(sim, "settlement-valewatch", 11, mustReader(t), worldevents.NewHighThreatGoblinEco(sim, 11))
	if err != nil {
		t.Fatal(err)
	}
	st.Director.ContributionSeq = 1
	st.Director.PendingContributions = []worldevents.PendingContribution{{Sequence: 1, Result: ports.ContributionResult{EventID: "old-contribution", SimulationID: sim, InvasionID: "old-invasion", SettlementID: "settlement-valewatch", PlayerID: "player", Outcome: ports.InvasionOutcomeDefended}}}
	_, err = worldevents.EnqueueScheduledEvent(&st.Director, worldevents.ScheduledEvent{TemplateID: worldevents.TemplateGoblinRaid, Kind: worldevents.EventGoblinRaidCampaign, Category: worldevents.CategoryCreature, RegionID: ecosystem.RegionThornveilForest, SettlementID: "settlement-valewatch", FactionID: ecosystem.FactionThornGoblins, SourcePopulationID: "pop-thornveil-goblins", SourceCampID: "camp-thornveil-warren", ScheduledTick: 1, DeadlineTick: 100}, cfg.Director)
	if err != nil {
		t.Fatal(err)
	}
	next, _, err := worldevents.Step(st, worldevents.StepInput{}, cfg)
	if err != nil || len(next.Director.PendingEvents) != 1 || len(next.Director.Campaigns) != 0 {
		t.Fatalf("campaign not deferred: %v", err)
	}
	next, err = worldevents.AcknowledgeContribution(next, 1, cfg)
	if err != nil {
		t.Fatal(err)
	}
	resumed, _, err := worldevents.Step(next, worldevents.StepInput{}, cfg)
	if err != nil || len(resumed.Director.Campaigns) != 1 {
		t.Fatalf("campaign did not resume after confirmation: %v", err)
	}
}

func TestReleaseCancelledScheduledEventsWithoutTick(t *testing.T) {
	cfg := worldevents.DefaultConfig()
	cfg.MaxPendingEvents = 2
	st := worldevents.NewDirectorState("cancelled-recovery", 1)
	for i := 0; i < 2; i++ {
		_, err := worldevents.EnqueueScheduledEvent(&st, worldevents.ScheduledEvent{Kind: worldevents.EventRecoveryFollowup, Category: worldevents.CategoryCreature, RegionID: ecosystem.RegionThornveilForest, ScheduledTick: 10, DeadlineTick: 20}, cfg)
		if err != nil {
			t.Fatal(err)
		}
	}
	st.PendingEvents[0].Cancelled = true
	original, _ := st.Checksum(cfg)
	recovered, removed, err := worldevents.ReleaseCancelledEvents(st, cfg)
	if err != nil || removed != 1 || len(recovered.PendingEvents) != 1 || recovered.Tick != st.Tick || recovered.PendingEvents[0].EventID != st.PendingEvents[1].EventID {
		t.Fatalf("unexpected recovery: %d %v", removed, err)
	}
	after, _ := st.Checksum(cfg)
	if original != after || len(st.PendingEvents) != 2 {
		t.Fatal("recovery mutated original")
	}
	if _, err := worldevents.EnqueueScheduledEvent(&recovered, worldevents.ScheduledEvent{Kind: worldevents.EventRecoveryFollowup, Category: worldevents.CategoryCreature, RegionID: ecosystem.RegionThornveilForest, ScheduledTick: 10, DeadlineTick: 20}, cfg); err != nil {
		t.Fatalf("capacity not recovered: %v", err)
	}
}

func TestFollowupCapacityConfiguration(t *testing.T) {
	cfg := worldevents.DefaultConfig()
	cfg.MaxPendingEvents = 1
	if err := cfg.Validate(); !errors.Is(err, worldevents.ErrInvalidConfig) {
		t.Fatalf("expected incompatible capacity to fail: %v", err)
	}
	cfg.MaxChainDepth = 0
	if err := cfg.Validate(); err != nil {
		t.Fatalf("single slot without followups: %v", err)
	}
}

func TestTerminalOutcomeBackpressureRestoreAndAcknowledge(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	cfg.Director.MaxPendingOutcomes = 1
	st, err := worldevents.NewOrchestratedState("outcome-backpressure", "settlement-valewatch", 4004, mustReader(t), worldevents.NewHighThreatOrcEco("outcome-backpressure", 4004))
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 1000; i++ {
		if st.World.Invasion.State == world.InvasionUnderAttack && st.Director.OutcomeSeq == 0 {
			st.Director.OutcomeSeq = 1
			st.Director.PendingOutcomes = []worldevents.TerminalSettlementOutcome{{Sequence: 1, EventID: "existing", SimulationID: "outcome-backpressure", Outcome: ports.InvasionOutcomeDefended}}
		}
		before, err := st.Checksum(cfg)
		if err != nil {
			t.Fatal(err)
		}
		next, _, stepErr := worldevents.Step(st, worldevents.StepInput{}, cfg)
		if errors.Is(stepErr, worldevents.ErrOutcomeBackpressure) {
			after, _ := st.Checksum(cfg)
			if before != after {
				t.Fatal("blocked step mutated state")
			}
			raw, err := st.MarshalSnapshot(cfg)
			if err != nil {
				t.Fatal(err)
			}
			restored, err := worldevents.UnmarshalOrchestratedSnapshot(raw, cfg)
			if err != nil {
				t.Fatal(err)
			}
			pending, err := worldevents.PendingTerminalOutcomes(restored, cfg)
			if err != nil || len(pending) != 1 || pending[0].Sequence != 1 {
				t.Fatalf("pending: %+v %v", pending, err)
			}
			if _, err := worldevents.AcknowledgeTerminalOutcome(restored, 2, cfg); !errors.Is(err, worldevents.ErrInvalidCommand) {
				t.Fatalf("out of order acknowledgement: %v", err)
			}
			recovered, err := worldevents.AcknowledgeTerminalOutcome(restored, 1, cfg)
			if err != nil {
				t.Fatal(err)
			}
			duplicate, err := worldevents.AcknowledgeTerminalOutcome(recovered, 1, cfg)
			if err != nil {
				t.Fatal(err)
			}
			recoveredSum, _ := recovered.Checksum(cfg)
			duplicateSum, _ := duplicate.Checksum(cfg)
			if recoveredSum != duplicateSum {
				t.Fatal("duplicate acknowledgement changed state")
			}
			advanced, out, err := worldevents.Step(recovered, worldevents.StepInput{}, cfg)
			if err != nil || advanced.Director.Tick != st.Director.Tick+1 || len(out.TerminalOutcomes) != 1 || out.TerminalOutcomes[0].Sequence != 2 {
				t.Fatalf("recovery failed: %+v %v", out.TerminalOutcomes, err)
			}
			pending, err = worldevents.PendingTerminalOutcomes(advanced, cfg)
			if err != nil || len(pending) != 1 || pending[0].Sequence != 2 {
				t.Fatalf("next outcome missing: %+v %v", pending, err)
			}
			return
		}
		if stepErr != nil {
			t.Fatal(stepErr)
		}
		st = next
	}
	t.Fatal("scenario did not reach backpressure")
}

func TestOutcomeAcknowledgementsRequireContiguousOrder(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	cfg.Director.MaxPendingOutcomes = 2
	st, err := worldevents.NewOrchestratedState("ack-order", "settlement-valewatch", 1, mustReader(t), worldevents.NewHighThreatGoblinEco("ack-order", 1))
	if err != nil {
		t.Fatal(err)
	}
	st.Director.OutcomeSeq = 2
	st.Director.PendingOutcomes = []worldevents.TerminalSettlementOutcome{{Sequence: 1, EventID: "o1", SimulationID: "ack-order", Outcome: ports.InvasionOutcomeDefended}, {Sequence: 2, EventID: "o2", SimulationID: "ack-order", Outcome: ports.InvasionOutcomeCaptured}}
	before, err := st.Checksum(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = worldevents.AcknowledgeTerminalOutcome(st, 2, cfg); !errors.Is(err, worldevents.ErrInvalidCommand) {
		t.Fatalf("out of order: %v", err)
	}
	after, err := st.Checksum(cfg)
	if err != nil || before != after {
		t.Fatal("invalid ack changed input")
	}
	one, err := worldevents.AcknowledgeTerminalOutcome(st, 1, cfg)
	if err != nil {
		t.Fatal(err)
	}
	copyPending, err := worldevents.PendingTerminalOutcomes(one, cfg)
	if err != nil || len(copyPending) != 1 {
		t.Fatal("missing pending fact")
	}
	copyPending[0].EventID = "mutated"
	again, err := worldevents.PendingTerminalOutcomes(one, cfg)
	if err != nil || again[0].EventID != "o2" {
		t.Fatal("query exposed mutable state")
	}
	two, err := worldevents.AcknowledgeTerminalOutcome(one, 2, cfg)
	if err != nil || len(two.Director.PendingOutcomes) != 0 {
		t.Fatalf("second ack: %v", err)
	}
	if _, err = worldevents.AcknowledgeTerminalOutcome(two, 1, cfg); !errors.Is(err, worldevents.ErrInvalidCommand) {
		t.Fatalf("stale ack accepted: %v", err)
	}
}

func TestContributionBackpressureRestoresAndRecoversWithoutTick(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	cfg.World.MaxContributions = 1
	cfg.Director.MaxPendingContributions = 1
	const sim = "contribution-backpressure"
	st, err := worldevents.NewOrchestratedState(sim, "settlement-valewatch", 4004, mustReader(t), worldevents.NewHighThreatOrcEco(sim, 4004))
	if err != nil {
		t.Fatal(err)
	}
	filled := false
	for i := 0; i < 1000; i++ {
		if !filled && st.World.Invasion.State == world.InvasionUnderAttack {
			st.Director.ContributionSeq = 1
			st.Director.PendingContributions = []worldevents.PendingContribution{{Sequence: 1, Result: ports.ContributionResult{EventID: "prior", SimulationID: sim, InvasionID: "prior-invasion", SettlementID: "settlement-valewatch", PlayerID: "prior-player", Outcome: ports.InvasionOutcomeDefended}}}
			filled = true
		}
		var input worldevents.StepInput
		if st.World.Invasion.State == world.InvasionUnderAttack && len(st.World.Defenders) == 0 {
			input.GameplayCommands = []world.GameplayCommand{{Kind: world.CmdDeployDefender, Tick: st.World.Tick + 1, PlayerID: "defender", Position: 3000}}
		} else if st.World.Invasion.State == world.InvasionUnderAttack && len(st.World.Defenders) > 0 && st.World.Defenders[0].HP > 0 && (st.World.Tick+1)%9 == 0 {
			for _, group := range st.World.Groups {
				if group.HP > 0 && group.State != ai.StateDead && !group.Routed {
					input.GameplayCommands = []world.GameplayCommand{{Kind: world.CmdPlayerDefendStrike, Tick: st.World.Tick + 1, PlayerID: "defender", TargetGroupID: group.GroupID}}
					break
				}
			}
		}
		before, err := st.Checksum(cfg)
		if err != nil {
			t.Fatal(err)
		}
		next, _, stepErr := worldevents.Step(st, input, cfg)
		if errors.Is(stepErr, worldevents.ErrContributionBackpressure) {
			after, _ := st.Checksum(cfg)
			if before != after {
				t.Fatal("blocked tick mutated state")
			}
			raw, err := st.MarshalSnapshot(cfg)
			if err != nil {
				t.Fatal(err)
			}
			restored, err := worldevents.UnmarshalOrchestratedSnapshot(raw, cfg)
			if err != nil {
				t.Fatal(err)
			}
			pending, err := worldevents.PendingContributionResults(restored, cfg)
			if err != nil || len(pending) != 1 || pending[0].Result.EventID != "prior" {
				t.Fatalf("pending: %+v %v", pending, err)
			}
			if _, err := worldevents.AcknowledgeContribution(restored, 2, cfg); !errors.Is(err, worldevents.ErrInvalidCommand) {
				t.Fatalf("invalid ack: %v", err)
			}
			recovered, err := worldevents.AcknowledgeContribution(restored, 1, cfg)
			if err != nil {
				t.Fatal(err)
			}
			duplicate, err := worldevents.AcknowledgeContribution(recovered, 1, cfg)
			if err != nil {
				t.Fatal(err)
			}
			a, _ := recovered.Checksum(cfg)
			b, _ := duplicate.Checksum(cfg)
			if a != b {
				t.Fatal("duplicate acknowledgement changed state")
			}
			advanced, out, err := worldevents.Step(recovered, input, cfg)
			if err != nil || advanced.World.Tick != st.World.Tick+1 {
				t.Fatalf("tick did not advance: %v", err)
			}
			pending, err = worldevents.PendingContributionResults(advanced, cfg)
			if err != nil || len(pending) != 1 || pending[0].Sequence != 2 {
				t.Fatalf("new contribution missing: %+v %v", pending, err)
			}
			found := false
			for _, ev := range out.WorldEvents {
				if ev.Contribution != nil && *ev.Contribution == pending[0].Result {
					found = true
				}
			}
			if !found {
				t.Fatal("outbox fact differs from tick output")
			}
			if err := advanced.Validate(cfg); err != nil {
				t.Fatalf("population conservation: %v", err)
			}
			return
		}
		if stepErr != nil {
			t.Fatal(stepErr)
		}
		st = next
	}
	t.Fatal("scenario did not reach contribution backpressure")
}

func TestOrchestratedV5RejectsLegacyReservationState(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	st, err := worldevents.NewOrchestratedState("legacy-reservation", "settlement-valewatch", 1, mustReader(t), worldevents.NewHighThreatGoblinEco("legacy-reservation", 1))
	if err != nil {
		t.Fatal(err)
	}
	_, _, created, err := ecosystem.CreateReservation(&st.Ecosystem, ecosystem.ReservationRequest{IdempotencyKey: "legacy", CampaignID: "c", CampID: "camp-thornveil-warren", Amount: 1, CreatedTick: 1, ExpiryTick: 2}, cfg.Ecosystem)
	if err != nil || !created {
		t.Fatalf("setup legacy: %v", err)
	}
	if err = st.Validate(cfg); !errors.Is(err, worldevents.ErrInvalidState) {
		t.Fatalf("legacy state accepted: %v", err)
	}
}

func TestBatchAndTotalDirectorEventLimits(t *testing.T) {
	// 1. Incompatible config: MaxPendingDirectorEvents < MaxEventsPerBatch must fail upfront.
	badCfg := worldevents.DefaultConfig()
	badCfg.MaxEventsPerBatch = 16
	badCfg.MaxPendingDirectorEvents = 8
	if err := badCfg.Validate(); !errors.Is(err, worldevents.ErrInvalidConfig) {
		t.Fatalf("expected ErrInvalidConfig for MaxPendingDirectorEvents < MaxEventsPerBatch, got %v", err)
	}

	// 2. Single-tick excess above MaxEventsPerBatch returns ErrTickEventCapacity atomically
	// (NOT silent truncation and NOT retriable without config fix).
	cfg := worldevents.DefaultOrchestratedConfig()
	cfg.Director.MaxEventsPerUpdate = 1
	cfg.Director.MaxEventsPerBatch = 1
	cfg.Director.MaxPendingDirectorEvents = 4
	st, err := worldevents.NewOrchestratedState("batch-cap", "settlement-valewatch", 101, mustReader(t), worldevents.NewHighThreatGoblinEco("batch-cap", 101))
	if err != nil {
		t.Fatal(err)
	}
	cur := st
	hitSingleTickCap := false
	for tick := uint64(1); tick <= 15; tick++ {
		before, _ := cur.Checksum(cfg)
		next, _, err := worldevents.Step(cur, worldevents.StepInput{}, cfg)
		if errors.Is(err, worldevents.ErrTickEventCapacity) {
			after, _ := cur.Checksum(cfg)
			if before != after {
				t.Fatal("ErrTickEventCapacity mutated state")
			}
			hitSingleTickCap = true
			break
		}
		if err != nil {
			t.Fatalf("tick %d unexpected err: %v", tick, err)
		}
		cur = next
	}
	if !hitSingleTickCap {
		t.Fatal("expected single tick producing >1 event to trigger ErrTickEventCapacity")
	}

	// 3. Accumulated total events exceeding MaxPendingDirectorEvents returns recoverable ErrDirectorBackpressure.
	cfg2 := worldevents.DefaultOrchestratedConfig()
	cfg2.Director.MaxEventsPerUpdate = 1
	cfg2.Director.MaxEventsPerBatch = 8
	cfg2.Director.MaxPendingDirectorBatches = 10
	cfg2.Director.MaxPendingDirectorEvents = 8 // holds 1 batch of ~3-4 events, blocks when total would exceed 8
	cur2, err := worldevents.NewOrchestratedState("total-dir-cap", "settlement-valewatch", 101, mustReader(t), worldevents.NewHighThreatGoblinEco("total-dir-cap", 101))
	if err != nil {
		t.Fatal(err)
	}
	recovered := false
	for tick := 0; tick < 80; tick++ {
		next, _, err := worldevents.Step(cur2, worldevents.StepInput{}, cfg2)
		if errors.Is(err, worldevents.ErrDirectorBackpressure) {
			stats, sErr := worldevents.PendingQueueStats(cur2, cfg2)
			if sErr != nil || stats.PendingDirectorEvents == 0 {
				t.Fatalf("expected non-empty pending events on backpressure: %+v %v", stats, sErr)
			}
			// Drain oldest batch via paging -> verified ack -> resume tick!
			var seq uint64
			count := 0
			for offset := 0; ; {
				var page []worldevents.DirectorEvent
				var more bool
				seq, page, more, err = worldevents.PendingDirectorEventPage(cur2, offset, cfg2)
				if err != nil {
					t.Fatal(err)
				}
				count += len(page)
				offset += len(page)
				if !more {
					break
				}
			}
			cur2, err = worldevents.AcknowledgeDirectorBatchVerified(cur2, seq, count, cfg2)
			if err != nil {
				t.Fatal(err)
			}
			resumed, _, err := worldevents.Step(cur2, worldevents.StepInput{}, cfg2)
			if err != nil || resumed.Director.Tick != cur2.Director.Tick+1 {
				t.Fatalf("failed to resume after total event recovery: %v", err)
			}
			recovered = true
			break
		}
		if err != nil {
			t.Fatalf("step %d: %v", tick, err)
		}
		cur2 = next
	}
	if !recovered {
		t.Fatal("expected accumulated total director events backpressure and recovery")
	}
}

func TestSlowConsumerAllowsIndependentCampaignWithinSafeBudget(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	// Default: World.MaxContributions=128, Director.MaxPendingContributions=256 (2x).
	// 5 unconfirmed contributions leave 251 >= 128 slots -> independent campaign MUST NOT be blocked!
	const sim = "slow-safe-budget"
	st, err := worldevents.NewOrchestratedState(sim, "settlement-valewatch", 12, mustReader(t), worldevents.NewHighThreatGoblinEco(sim, 12))
	if err != nil {
		t.Fatal(err)
	}
	for seq := uint64(1); seq <= 5; seq++ {
		st.Director.ContributionSeq = seq
		st.Director.PendingContributions = append(st.Director.PendingContributions, worldevents.PendingContribution{
			Sequence: seq,
			Result: ports.ContributionResult{
				EventID: fmt.Sprintf("old-c-%d", seq), SimulationID: sim, InvasionID: "old-inv",
				SettlementID: "settlement-valewatch", PlayerID: fmt.Sprintf("p-%d", seq), Outcome: ports.InvasionOutcomeDefended,
			},
		})
	}
	_, err = worldevents.EnqueueScheduledEvent(&st.Director, worldevents.ScheduledEvent{
		TemplateID: worldevents.TemplateGoblinRaid, Kind: worldevents.EventGoblinRaidCampaign,
		Category: worldevents.CategoryCreature, RegionID: ecosystem.RegionThornveilForest,
		SettlementID: "settlement-valewatch", FactionID: ecosystem.FactionThornGoblins,
		SourcePopulationID: "pop-thornveil-goblins", SourceCampID: "camp-thornveil-warren",
		ScheduledTick: 1, DeadlineTick: 100,
	}, cfg.Director)
	if err != nil {
		t.Fatal(err)
	}
	next, _, err := worldevents.Step(st, worldevents.StepInput{}, cfg)
	if err != nil || len(next.Director.Campaigns) != 1 {
		t.Fatalf("expected independent campaign admitted within safe contribution budget (251>=128), got camps=%d err=%v", len(next.Director.Campaigns), err)
	}

	// Now fill pending contributions to 129 (leaving 127 < 128): admission MUST pause, and partial recovery
	// acknowledging ONLY 1 contribution (to 128 pending, leaving 128 free) MUST unblock immediately!
	st2, err := worldevents.NewOrchestratedState(sim, "settlement-valewatch", 12, mustReader(t), worldevents.NewHighThreatGoblinEco(sim, 12))
	if err != nil {
		t.Fatal(err)
	}
	for seq := uint64(1); seq <= 129; seq++ {
		st2.Director.ContributionSeq = seq
		st2.Director.PendingContributions = append(st2.Director.PendingContributions, worldevents.PendingContribution{
			Sequence: seq,
			Result: ports.ContributionResult{
				EventID: fmt.Sprintf("c-%03d", seq), SimulationID: sim, InvasionID: "old-inv",
				SettlementID: "settlement-valewatch", PlayerID: fmt.Sprintf("p-%03d", seq), Outcome: ports.InvasionOutcomeDefended,
			},
		})
	}
	_, err = worldevents.EnqueueScheduledEvent(&st2.Director, worldevents.ScheduledEvent{
		TemplateID: worldevents.TemplateGoblinRaid, Kind: worldevents.EventGoblinRaidCampaign,
		Category: worldevents.CategoryCreature, RegionID: ecosystem.RegionThornveilForest,
		SettlementID: "settlement-valewatch", FactionID: ecosystem.FactionThornGoblins,
		SourcePopulationID: "pop-thornveil-goblins", SourceCampID: "camp-thornveil-warren",
		ScheduledTick: 1, DeadlineTick: 100,
	}, cfg.Director)
	if err != nil {
		t.Fatal(err)
	}
	paused, _, err := worldevents.Step(st2, worldevents.StepInput{}, cfg)
	if err != nil || len(paused.Director.Campaigns) != 0 {
		t.Fatalf("expected campaign paused when free contribution slots (127) < MaxContributions (128), camps=%d err=%v", len(paused.Director.Campaigns), err)
	}
	// Partial recovery: ack just 1 contribution -> 128 remaining pending, 128 free >= 128 -> unblocked!
	partialRecovered, err := worldevents.AcknowledgeContributionVerified(paused, 1, "c-001", cfg)
	if err != nil {
		t.Fatal(err)
	}
	unblocked, _, err := worldevents.Step(partialRecovered, worldevents.StepInput{}, cfg)
	if err != nil || len(unblocked.Director.Campaigns) != 1 {
		t.Fatalf("expected partial recovery to unblock admission immediately, camps=%d err=%v", len(unblocked.Director.Campaigns), err)
	}
}

func TestVerifiedAcknowledgementsRejectConflictsAndPartialBatch(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	const sim = "verified-acks"
	st, err := worldevents.NewOrchestratedState(sim, "settlement-valewatch", 7, mustReader(t), worldevents.NewHighThreatGoblinEco(sim, 7))
	if err != nil {
		t.Fatal(err)
	}
	st.Director.DirectorBatchSeq = 1
	st.Director.PendingDirectorBatches = []worldevents.DirectorEventBatch{{
		Sequence: 1,
		Events: []worldevents.DirectorEvent{
			{EventID: "ev-1", SimulationID: sim, Type: worldevents.DirEventCandidateScheduled},
			{EventID: "ev-2", SimulationID: sim, Type: worldevents.DirEventCampaignPhaseChanged},
		},
	}}
	st.Director.OutcomeSeq = 1
	st.Director.PendingOutcomes = []worldevents.TerminalSettlementOutcome{{
		Sequence: 1, EventID: "out-1", SimulationID: sim, Outcome: ports.InvasionOutcomeDefended,
	}}
	st.Director.TerminalOutcomes = []worldevents.TerminalSettlementOutcome{{
		Sequence: 1, EventID: "out-1", SimulationID: sim, Outcome: ports.InvasionOutcomeDefended,
	}}
	st.Director.ContributionSeq = 1
	st.Director.PendingContributions = []worldevents.PendingContribution{{
		Sequence: 1,
		Result: ports.ContributionResult{
			EventID: "con-1", SimulationID: sim, InvasionID: "inv-1",
			SettlementID: "settlement-valewatch", PlayerID: "p-1", Outcome: ports.InvasionOutcomeDefended,
		},
	}}

	before, _ := st.Checksum(cfg)
	// Partial-batch count rejected.
	if _, err := worldevents.AcknowledgeDirectorBatchVerified(st, 1, 1, cfg); !errors.Is(err, worldevents.ErrInvalidCommand) {
		t.Fatalf("expected partial-batch rejection, got %v", err)
	}
	if _, err := worldevents.AcknowledgeDirectorBatchVerified(st, 1, 0, cfg); !errors.Is(err, worldevents.ErrInvalidCommand) {
		t.Fatalf("expected zero-count rejection, got %v", err)
	}
	// Conflicting EventID rejected for outcome & contribution.
	if _, err := worldevents.AcknowledgeTerminalOutcomeVerified(st, 1, "wrong-out", cfg); !errors.Is(err, worldevents.ErrInvalidCommand) {
		t.Fatalf("expected conflicting outcome EventID rejection, got %v", err)
	}
	if _, err := worldevents.AcknowledgeContributionVerified(st, 1, "wrong-con", cfg); !errors.Is(err, worldevents.ErrInvalidCommand) {
		t.Fatalf("expected conflicting contribution EventID rejection, got %v", err)
	}
	after, _ := st.Checksum(cfg)
	if before != after {
		t.Fatal("rejected verified acks mutated state")
	}

	// Valid verified acks succeed; conflicting retry on outcome history rejected.
	st, err = worldevents.AcknowledgeDirectorBatchVerified(st, 1, 2, cfg)
	if err != nil {
		t.Fatal(err)
	}
	st, err = worldevents.AcknowledgeTerminalOutcomeVerified(st, 1, "out-1", cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := worldevents.AcknowledgeTerminalOutcomeVerified(st, 1, "forged-out", cfg); !errors.Is(err, worldevents.ErrInvalidCommand) {
		t.Fatalf("expected conflicting retry on outcome history rejected, got %v", err)
	}
	st, err = worldevents.AcknowledgeContributionVerified(st, 1, "con-1", cfg)
	if err != nil {
		t.Fatal(err)
	}
	stats, err := worldevents.PendingQueueStats(st, cfg)
	if err != nil || stats.PendingDirectorBatches != 0 || stats.PendingOutcomes != 0 || stats.PendingContributions != 0 {
		t.Fatalf("expected drained queues, got %+v %v", stats, err)
	}

	// Empty-queue & invalid-offset edge cases on pagination and verified acks.
	if _, _, _, err := worldevents.PendingDirectorEventPage(st, 1, cfg); !errors.Is(err, worldevents.ErrInvalidCommand) {
		t.Fatalf("expected error for non-zero offset on empty batch queue, got %v", err)
	}
	if _, _, _, err := worldevents.PendingDirectorEventPage(st, 0, cfg); err != nil {
		t.Fatalf("expected clean empty read at offset 0, got %v", err)
	}
	if _, err := worldevents.AcknowledgeDirectorBatchVerified(st, 2, 1, cfg); !errors.Is(err, worldevents.ErrInvalidCommand) {
		t.Fatalf("expected future batch ack rejected on empty queue, got %v", err)
	}
	if _, err := worldevents.AcknowledgeTerminalOutcomeVerified(st, 1, "", cfg); !errors.Is(err, worldevents.ErrInvalidCommand) {
		t.Fatalf("expected empty event_id rejected for outcome, got %v", err)
	}
	if _, err := worldevents.AcknowledgeTerminalOutcomeVerified(st, 2, "x", cfg); !errors.Is(err, worldevents.ErrInvalidCommand) {
		t.Fatalf("expected future outcome ack rejected on empty queue, got %v", err)
	}
	if _, err := worldevents.AcknowledgeContributionVerified(st, 1, "", cfg); !errors.Is(err, worldevents.ErrInvalidCommand) {
		t.Fatalf("expected empty event_id rejected for contribution, got %v", err)
	}
	if _, err := worldevents.AcknowledgeContributionVerified(st, 2, "x", cfg); !errors.Is(err, worldevents.ErrInvalidCommand) {
		t.Fatalf("expected future contribution ack rejected on empty queue, got %v", err)
	}
	// Idempotent repeat of last acknowledged sequence on all 3 verified endpoints.
	if _, err := worldevents.AcknowledgeDirectorBatchVerified(st, 1, 2, cfg); err != nil {
		t.Fatalf("idempotent verified batch ack failed: %v", err)
	}
	if _, err := worldevents.AcknowledgeTerminalOutcomeVerified(st, 1, "out-1", cfg); err != nil {
		t.Fatalf("idempotent verified outcome ack failed: %v", err)
	}
	if _, err := worldevents.AcknowledgeContributionVerified(st, 1, "con-1", cfg); err != nil {
		t.Fatalf("idempotent verified contribution ack failed: %v", err)
	}
	// Invalid state rejected cleanly by query & ack entrypoints.
	badSt := st.Clone()
	badSt.Director.Tick = 999
	if _, err := worldevents.PendingQueueStats(badSt, cfg); err == nil {
		t.Fatal("expected PendingQueueStats error on invalid state")
	}
	if _, _, _, err := worldevents.PendingDirectorEventPage(badSt, 0, cfg); err == nil {
		t.Fatal("expected PendingDirectorEventPage error on invalid state")
	}
	if _, err := worldevents.PendingTerminalOutcomes(badSt, cfg); err == nil {
		t.Fatal("expected PendingTerminalOutcomes error on invalid state")
	}
	if _, err := worldevents.PendingContributionResults(badSt, cfg); err == nil {
		t.Fatal("expected PendingContributionResults error on invalid state")
	}
	if _, err := worldevents.AcknowledgeDirectorBatchVerified(badSt, 1, 1, cfg); err == nil {
		t.Fatal("expected AcknowledgeDirectorBatchVerified error on invalid state")
	}
	if _, err := worldevents.AcknowledgeTerminalOutcomeVerified(badSt, 1, "out-1", cfg); err == nil {
		t.Fatal("expected AcknowledgeTerminalOutcomeVerified error on invalid state")
	}
	if _, err := worldevents.AcknowledgeContributionVerified(badSt, 1, "con-1", cfg); err == nil {
		t.Fatal("expected AcknowledgeContributionVerified error on invalid state")
	}
	// Snapshot budget check when single tick exceeds tiny MaxSnapshotBytes.
	tinySnapCfg := cfg
	tinySnapCfg.Director.CandidateEvalIntervalTicks = 1
	tinySnapCfg.Director.MaxSnapshotBytes = 256
	if _, _, err := worldevents.Step(st, worldevents.StepInput{}, tinySnapCfg); !errors.Is(err, worldevents.ErrTickEventCapacity) {
		t.Fatalf("expected ErrTickEventCapacity for impossible snapshot budget, got %v", err)
	}
}

func TestSemanticallyInvalidSnapshotsWithRecalculatedChecksumRejected(t *testing.T) {
	cfg := worldevents.DefaultOrchestratedConfig()
	st, err := worldevents.NewOrchestratedState("forged-snap", "settlement-valewatch", 99, mustReader(t), worldevents.NewHighThreatGoblinEco("forged-snap", 99))
	if err != nil {
		t.Fatal(err)
	}
	encodeForged := func(tampered worldevents.OrchestratedState) []byte {
		// Recompute a syntactically valid envelope with a matching SHA-256 checksum
		// bypassing Validate() via raw simulation.EncodeSnapshot!
		rawPayload, _ := json.Marshal(tampered)
		h := simulation.NewCanonicalHasher()
		h.WriteString(string(rawPayload))
		raw, _ := simulation.EncodeSnapshot(tampered, h.SumHex())
		return raw
	}

	assertSemanticReject := func(label string, tampered worldevents.OrchestratedState) {
		t.Helper()
		_, err := worldevents.UnmarshalOrchestratedSnapshot(encodeForged(tampered), cfg)
		if err == nil {
			t.Fatalf("%s: expected rejection, got nil", label)
		}
		if errors.Is(err, simulation.ErrSnapshotChecksumMismatch) {
			t.Fatalf("%s: rejected by checksum instead of semantic validation: %v", label, err)
		}
	}

	// Case 1: Forged cursor DirectorBatchAckSeq > DirectorBatchSeq.
	f1 := st.Clone()
	f1.Director.DirectorBatchAckSeq = 5
	assertSemanticReject("forged ack cursor", f1)

	// Case 2: Future CompletedTick in PendingOutcomes.
	f2 := st.Clone()
	f2.Director.OutcomeSeq = 1
	f2.Director.PendingOutcomes = []worldevents.TerminalSettlementOutcome{{
		Sequence: 1, EventID: "out-future", SimulationID: "forged-snap", Outcome: ports.InvasionOutcomeDefended, CompletedTick: 999,
	}}
	assertSemanticReject("future CompletedTick outcome", f2)

	// Case 3: Active campaign while World.Invasion.State == Peace.
	f3 := st.Clone()
	f3.Director.Campaigns = []worldevents.Campaign{{
		CampaignID: "cmp-ghost", TemplateID: worldevents.TemplateGoblinRaid, EventKind: worldevents.EventGoblinRaidCampaign,
		RegionID: ecosystem.RegionThornveilForest, SettlementID: "settlement-valewatch", FactionID: ecosystem.FactionThornGoblins,
		FamilyID: ai.FamilyGoblin, State: worldevents.CampaignActive, TerminalOutcome: ports.InvasionOutcomeNone,
		CreatedTick: 0, DeadlineTick: 50,
	}}
	assertSemanticReject("CampaignActive mismatch with Peace invasion", f3)

	// Case 4: Invalid DirectorEventType inside PendingDirectorBatches.
	f4 := st.Clone()
	f4.Director.DirectorBatchSeq = 1
	f4.Director.PendingDirectorBatches = []worldevents.DirectorEventBatch{{
		Sequence: 1, Events: []worldevents.DirectorEvent{{EventID: "bad-ev", SimulationID: "forged-snap", Type: worldevents.DirectorEventType("ForgedType")}},
	}}
	assertSemanticReject("invalid DirectorEventType", f4)

	// Case 5: Legacy arbitrary-key reservation embedded in v5 snapshot.
	f5 := st.Clone()
	if _, _, _, err := ecosystem.CreateReservation(&f5.Ecosystem, ecosystem.ReservationRequest{
		IdempotencyKey: "legacy-key", CampaignID: "c1", CampID: "camp-thornveil-warren", Amount: 2, CreatedTick: 0, ExpiryTick: 10,
	}, cfg.Ecosystem); err != nil {
		t.Fatal(err)
	}
	assertSemanticReject("legacy arbitrary-key reservation in v5 snapshot", f5)
}

func TestIndependentPopulationConservationEquationAndAckIsolation(t *testing.T) {
	// Independent verifier (does NOT rely on Validate()):
	// Checks Total == Free + Reserved + Materialized AND
	// P_final == P_initial + births - deaths + immigration - emigration across every tick,
	// AND verifies acknowledgements and failed steps NEVER alter any population bucket.
	cfg := worldevents.DefaultOrchestratedConfig()
	cfg.Director.MaxPendingDirectorBatches = 2
	st, err := worldevents.NewOrchestratedState("indep-conservation", "settlement-valewatch", 4020, mustReader(t), worldevents.NewHighThreatGoblinEco("indep-conservation", 4020))
	if err != nil {
		t.Fatal(err)
	}

	sumTotal := func(eco ecosystem.EcosystemState) (free, reserved, mat, total int64) {
		for _, p := range eco.Populations {
			if p.FreePopulation < 0 || p.ReservedPopulation < 0 || p.MaterializedPopulation < 0 {
				t.Fatalf("negative bucket: %+v", p)
			}
			free += p.FreePopulation
			reserved += p.ReservedPopulation
			mat += p.MaterializedPopulation
		}
		return free, reserved, mat, free + reserved + mat
	}

	_, _, _, initialTotal := sumTotal(st.Ecosystem)
	var cumulativeBirths, cumulativeDeaths int64
	var cumulativeImmig, cumulativeEmig int64

	cur := st
	for step := 0; step < 200 && cur.Director.Tick < 130; step++ {
		fBefore, rBefore, mBefore, totBefore := sumTotal(cur.Ecosystem)
		var in worldevents.StepInput
		if cur.World.Invasion.State == world.InvasionUnderAttack {
			if len(cur.World.Defenders) == 0 {
				in.GameplayCommands = []world.GameplayCommand{
					{Kind: world.CmdDeployDefender, Tick: cur.World.Tick + 1, PlayerID: "p-a", Position: 3000},
					{Kind: world.CmdDeployDefender, Tick: cur.World.Tick + 1, PlayerID: "p-b", Position: 2200},
				}
			} else if (cur.World.Tick+1)%9 == 0 {
				for _, g := range cur.World.Groups {
					if g.HP > 0 && g.State != ai.StateDead && !g.Routed {
						in.GameplayCommands = []world.GameplayCommand{{Kind: world.CmdPlayerDefendStrike, Tick: cur.World.Tick + 1, PlayerID: "p-a", TargetGroupID: g.GroupID}}
						break
					}
				}
			}
		}
		next, out, err := worldevents.Step(cur, in, cfg)
		if errors.Is(err, worldevents.ErrDirectorBackpressure) {
			// Failed/blocked Step MUST leave every population bucket completely untouched.
			fFail, rFail, mFail, totFail := sumTotal(cur.Ecosystem)
			if fFail != fBefore || rFail != rBefore || mFail != mBefore || totFail != totBefore {
				t.Fatal("blocked Step mutated population")
			}
			// Acknowledge MUST NEVER modify any population bucket.
			stats, _ := worldevents.PendingQueueStats(cur, cfg)
			if stats.PendingDirectorBatches > 0 {
				seq, _, _, _ := worldevents.PendingDirectorEventPage(cur, 0, cfg)
				cur, err = worldevents.AcknowledgeDirectorBatch(cur, seq, cfg)
				if err != nil {
					t.Fatal(err)
				}
				fAck, rAck, mAck, totAck := sumTotal(cur.Ecosystem)
				if fAck != fBefore || rAck != rBefore || mAck != mBefore || totAck != totBefore {
					t.Fatal("AcknowledgeDirectorBatch mutated population")
				}
			}
			continue
		}
		if err != nil {
			t.Fatalf("step %d: %v", step, err)
		}

		// Reconcile independent ecological accounting equation from emitted events!
		for _, ev := range out.EcosystemEvents {
			switch ev.Type {
			case ecosystem.EventPopulationGrew:
				cumulativeBirths += ev.Amount
			case ecosystem.EventPopulationDeclined:
				cumulativeDeaths += ev.Amount
			case ecosystem.EventPopulationMigrated:
				// Inter-region conserved transfer: outflow == inflow.
				cumulativeEmig += ev.Amount
				cumulativeImmig += ev.Amount
			case ecosystem.EventCreatureGroupDematerialized:
				// Parse casualties from detail "res=... survivors=X losses=Y".
				var surv, losses int64
				if idx := strings.Index(ev.Detail, "survivors="); idx >= 0 {
					_, _ = fmt.Sscanf(ev.Detail[idx:], "survivors=%d losses=%d", &surv, &losses)
					cumulativeDeaths += losses
				}
			}
		}

		_, _, _, totAfter := sumTotal(next.Ecosystem)
		expectedTotal := initialTotal + cumulativeBirths - cumulativeDeaths + cumulativeImmig - cumulativeEmig
		if totAfter != expectedTotal {
			t.Fatalf("tick %d independent conservation broken: got=%d want=%d (init=%d births=%d deaths=%d immig=%d emig=%d)",
				next.Director.Tick, totAfter, expectedTotal, initialTotal, cumulativeBirths, cumulativeDeaths, cumulativeImmig, cumulativeEmig)
		}

		// Confirm any outcomes/contributions and verify zero population change on ack.
		pendingOut, _ := worldevents.PendingTerminalOutcomes(next, cfg)
		for _, o := range pendingOut {
			f0, r0, m0, t0 := sumTotal(next.Ecosystem)
			next, err = worldevents.AcknowledgeTerminalOutcomeVerified(next, o.Sequence, o.EventID, cfg)
			if err != nil {
				t.Fatal(err)
			}
			f1, r1, m1, t1 := sumTotal(next.Ecosystem)
			if f0 != f1 || r0 != r1 || m0 != m1 || t0 != t1 {
				t.Fatal("AcknowledgeTerminalOutcome mutated population")
			}
		}
		pendingCon, _ := worldevents.PendingContributionResults(next, cfg)
		for _, c := range pendingCon {
			f0, r0, m0, t0 := sumTotal(next.Ecosystem)
			next, err = worldevents.AcknowledgeContributionVerified(next, c.Sequence, c.Result.EventID, cfg)
			if err != nil {
				t.Fatal(err)
			}
			f1, r1, m1, t1 := sumTotal(next.Ecosystem)
			if f0 != f1 || r0 != r1 || m0 != m1 || t0 != t1 {
				t.Fatal("AcknowledgeContribution mutated population")
			}
		}
		cur = next
	}
	if cur.Director.Tick != 130 {
		t.Fatalf("expected tick 130, reached %d", cur.Director.Tick)
	}
}

func TestAllFiveHeadlessConsumerScenariosJtoN(t *testing.T) {
	reader := mustReader(t)
	ctx := context.Background()

	sumJ, err := worldevents.RunScenarioJImmediateConsumer(ctx, reader)
	if err != nil || sumJ.CampaignsCompleted < 1 || sumJ.OutcomesAcked < 1 || sumJ.DirectorPagesRead <= sumJ.DirectorBatchesAcked {
		t.Fatalf("Scenario J failed: %+v err=%v", sumJ, err)
	}
	sumK, err := worldevents.RunScenarioKSlowConsumer(ctx, reader)
	if err != nil || sumK.CampaignsCompleted < 1 || sumK.OutcomesAcked < 1 || sumK.BackpressurePauses < 1 {
		t.Fatalf("Scenario K failed: %+v err=%v", sumK, err)
	}
	sumL, err := worldevents.RunScenarioLPartiallyUnavailableConsumer(ctx, reader)
	if err != nil || sumL.CampaignsCompleted < 1 || sumL.BackpressurePauses < 1 || !sumL.SnapshotVerified {
		t.Fatalf("Scenario L failed: %+v err=%v", sumL, err)
	}
	sumM, err := worldevents.RunScenarioMRecoveredConsumer(ctx, reader)
	if err != nil || sumM.CampaignsCompleted < 1 || sumM.BackpressurePauses < 1 || !sumM.SnapshotVerified || sumM.DirectorPagesRead <= sumM.DirectorBatchesAcked {
		t.Fatalf("Scenario M failed: %+v err=%v", sumM, err)
	}
	sumN, err := worldevents.RunScenarioNDuplicateDeliveryConsumer(ctx, reader)
	if err != nil || sumN.CampaignsCompleted < 1 || sumN.RedeliveriesDeduped < 1 || !sumN.SnapshotVerified {
		t.Fatalf("Scenario N failed: %+v err=%v", sumN, err)
	}
}

// TestLongDurationSlowConsumerWithSmallCapacities executes a prolonged multi-seed simulation
// with intentionally tiny capacities and a slow/stalling consumer + mid-run snapshot restore,
// verifying recovery progress, zero lost facts, zero duplicates, conservation, and bounded heap.
func TestLongDurationSlowConsumerWithSmallCapacities(t *testing.T) {
	reader := mustReader(t)
	seeds := []uint64{10001, 20002, 30003}
	const targetTicks = uint64(800) // 3 seeds * 800 = 2,400 ticks under slow consumer & tiny queues

	cfg := worldevents.DefaultOrchestratedConfig()
	cfg.Ecosystem.TicksPerEpoch = 4
	cfg.Ecosystem.MaxReservations = 2
	cfg.World.MaxContributions = 6
	cfg.Director.MaxPendingContributions = 12
	cfg.Director.MaxPendingOutcomes = 1
	cfg.Director.MaxPendingDirectorBatches = 2
	cfg.Director.MaxEventsPerUpdate = 2
	cfg.Director.MaxEventsPerBatch = 32
	cfg.Director.MaxPendingDirectorEvents = 64

	runtime.GC()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	baselineHeap := m.HeapAlloc
	var peakHeap uint64

	totalOutcomes := 0
	totalPauses := 0
	totalContribs := 0
	totalBatches := 0

	for _, seed := range seeds {
		simID := fmt.Sprintf("slow-long-%d", seed)
		st, err := worldevents.NewOrchestratedState(simID, "settlement-valewatch", seed, reader, worldevents.NewDualHostileConflictEco(simID, seed))
		if err != nil {
			t.Fatal(err)
		}
		seenDir := make(map[string]struct{})
		seenOut := make(map[string]struct{})
		seenCon := make(map[string]struct{})
		restoredOnce := false

		drainStep := func(cur worldevents.OrchestratedState, batchLimit, outLimit, conLimit int) (worldevents.OrchestratedState, error) {
			for b := 0; b < batchLimit; b++ {
				stats, err := worldevents.PendingQueueStats(cur, cfg)
				if err != nil || stats.PendingDirectorBatches == 0 {
					break
				}
				var seq uint64
				var evs []worldevents.DirectorEvent
				for offset := 0; ; {
					var page []worldevents.DirectorEvent
					var more bool
					seq, page, more, err = worldevents.PendingDirectorEventPage(cur, offset, cfg)
					if err != nil {
						return worldevents.OrchestratedState{}, err
					}
					evs = append(evs, page...)
					offset += len(page)
					if !more {
						break
					}
				}
				for _, ev := range evs {
					if _, dup := seenDir[ev.EventID]; dup {
						t.Fatalf("duplicate director event delivered: %s", ev.EventID)
					}
					seenDir[ev.EventID] = struct{}{}
				}
				cur, err = worldevents.AcknowledgeDirectorBatchVerified(cur, seq, len(evs), cfg)
				if err != nil {
					return worldevents.OrchestratedState{}, err
				}
				totalBatches++
			}
			outs, err := worldevents.PendingTerminalOutcomes(cur, cfg)
			if err != nil {
				return worldevents.OrchestratedState{}, err
			}
			for i := 0; i < len(outs) && i < outLimit; i++ {
				if _, dup := seenOut[outs[i].EventID]; dup {
					t.Fatalf("duplicate terminal outcome delivered: %s", outs[i].EventID)
				}
				seenOut[outs[i].EventID] = struct{}{}
				cur, err = worldevents.AcknowledgeTerminalOutcomeVerified(cur, outs[i].Sequence, outs[i].EventID, cfg)
				if err != nil {
					return worldevents.OrchestratedState{}, err
				}
				totalOutcomes++
			}
			cons, err := worldevents.PendingContributionResults(cur, cfg)
			if err != nil {
				return worldevents.OrchestratedState{}, err
			}
			for i := 0; i < len(cons) && i < conLimit; i++ {
				if _, dup := seenCon[cons[i].Result.EventID]; dup {
					t.Fatalf("duplicate contribution delivered: %s", cons[i].Result.EventID)
				}
				seenCon[cons[i].Result.EventID] = struct{}{}
				cur, err = worldevents.AcknowledgeContributionVerified(cur, cons[i].Sequence, cons[i].Result.EventID, cfg)
				if err != nil {
					return worldevents.OrchestratedState{}, err
				}
				totalContribs++
			}
			return cur, nil
		}

		for iter := 0; iter < 5000 && st.Director.Tick < targetTicks; iter++ {
			var in worldevents.StepInput
			if st.World.Invasion.State == world.InvasionUnderAttack {
				tick := st.World.Tick + 1
				if len(st.World.Defenders) == 0 {
					in.GameplayCommands = []world.GameplayCommand{
						{Kind: world.CmdDeployDefender, Tick: tick, PlayerID: "g-1", Position: 3000},
						{Kind: world.CmdDeployDefender, Tick: tick, PlayerID: "g-2", Position: 2200},
						{Kind: world.CmdDeployDefender, Tick: tick, PlayerID: "g-3", Position: 1600},
						{Kind: world.CmdDeployDefender, Tick: tick, PlayerID: "g-4", Position: 1000},
					}
				} else {
					targetID := ""
					for _, g := range st.World.Groups {
						if g.HP > 0 && g.State != ai.StateDead && !g.Routed {
							targetID = g.GroupID
							break
						}
					}
					if targetID != "" {
						for idx, id := range []string{"g-1", "g-2", "g-3", "g-4"} {
							if tick%9 == uint64(idx*2) {
								alive := true
								for _, d := range st.World.Defenders {
									if d.PlayerID == id && d.HP == 0 {
										alive = false
										break
									}
								}
								if alive {
									in.GameplayCommands = append(in.GameplayCommands, world.GameplayCommand{
										Kind: world.CmdPlayerDefendStrike, Tick: tick, PlayerID: id, TargetGroupID: targetID,
									})
								}
							}
						}
					}
				}
			}

			next, _, err := worldevents.Step(st, in, cfg)
			if errors.Is(err, worldevents.ErrDirectorBackpressure) || errors.Is(err, worldevents.ErrOutcomeBackpressure) || errors.Is(err, worldevents.ErrContributionBackpressure) {
				totalPauses++
				if !restoredOnce {
					raw, mErr := st.MarshalSnapshot(cfg)
					if mErr != nil {
						t.Fatal(mErr)
					}
					st, mErr = worldevents.UnmarshalOrchestratedSnapshot(raw, cfg)
					if mErr != nil {
						t.Fatal(mErr)
					}
					restoredOnce = true
				}
				st, err = drainStep(st, 1, 1, 3)
				if err != nil {
					t.Fatal(err)
				}
				continue
			}
			if err != nil {
				t.Fatalf("seed %d tick %d: %v", seed, st.Director.Tick+1, err)
			}
			st = next
			if iter%18 == 0 {
				st, err = drainStep(st, 1, 1, 2)
				if err != nil {
					t.Fatal(err)
				}
			}
			if st.Director.Tick%200 == 0 {
				runtime.GC()
				runtime.ReadMemStats(&m)
				if m.HeapAlloc > peakHeap {
					peakHeap = m.HeapAlloc
				}
			}
		}
		if st.Director.Tick != targetTicks {
			t.Fatalf("seed %d failed to reach target tick %d (stuck at %d)", seed, targetTicks, st.Director.Tick)
		}
		// Final drain to prove all pending facts finish cleanly.
		var errDrain error
		st, errDrain = drainStep(st, 100, 100, 100)
		if errDrain != nil {
			t.Fatal(errDrain)
		}
		if err := st.Validate(cfg); err != nil {
			t.Fatal(err)
		}
	}

	runtime.GC()
	runtime.ReadMemStats(&m)
	finalHeap := m.HeapAlloc
	if totalOutcomes < 6 || totalPauses < 3 {
		t.Fatalf("expected repeated outcomes and backpressure recovery across slow-consumer run: outcomes=%d pauses=%d", totalOutcomes, totalPauses)
	}
	t.Logf("Slow-consumer long run passed: 3 seeds x %d ticks, batches=%d outcomes=%d contribs=%d pauses=%d, baselineHeap=%dB peakHeap=%dB finalHeap=%dB",
		targetTicks, totalBatches, totalOutcomes, totalContribs, totalPauses, baselineHeap, peakHeap, finalHeap)
	if finalHeap > baselineHeap+32*1024*1024 {
		t.Fatalf("retained heap grew unexpectedly: baseline=%d final=%d", baselineHeap, finalHeap)
	}
}
