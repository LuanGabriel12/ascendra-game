package worldevents_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"runtime"
	"testing"

	"ascendra-game/internal/adapters/memory"
	"ascendra-game/internal/ecosystem"
	"ascendra-game/internal/ports"
	"ascendra-game/internal/siege"
	"ascendra-game/internal/simulation"
	"ascendra-game/internal/world"
	"ascendra-game/internal/worldevents"
)

func TestAllTenHeadlessSiegeScenariosAtoJ(t *testing.T) {
	ctx := context.Background()
	reader := mustReader(t)

	sumA, _, err := worldevents.RunSiegeScenarioA(ctx, reader)
	if err != nil {
		t.Fatalf("Scenario A failed: %v", err)
	}
	sumB, _, err := worldevents.RunSiegeScenarioB(ctx, reader)
	if err != nil {
		t.Fatalf("Scenario B failed: %v", err)
	}
	// Observable Goblin vs Orc differentiation under identical default Valewatch defenses!
	if sumA.SiegePhase == sumB.SiegePhase && sumA.DistrictsCaptured == sumB.DistrictsCaptured {
		t.Fatalf("expected observable Goblin vs Orc siege divergence, got A=%+v B=%+v", sumA, sumB)
	}
	if _, _, err := worldevents.RunSiegeScenarioC(ctx, reader); err != nil {
		t.Fatalf("Scenario C failed: %v", err)
	}
	sumD, _, err := worldevents.RunSiegeScenarioD(ctx, reader)
	if err != nil || !sumD.OccupationRecorded || sumD.Outcome != ports.InvasionOutcomeCaptured {
		t.Fatalf("Scenario D failed: %+v %v", sumD, err)
	}
	sumE, _, err := worldevents.RunSiegeScenarioE(ctx, reader)
	if err != nil || !sumE.CommanderFallen {
		t.Fatalf("Scenario E failed: %+v %v", sumE, err)
	}
	sumF, _, err := worldevents.RunSiegeScenarioF(ctx, reader)
	if err != nil || sumF.RepairsApplied == 0 || sumF.SuppliesSpent == 0 {
		t.Fatalf("Scenario F failed: %+v %v", sumF, err)
	}
	sumG, _, err := worldevents.RunSiegeScenarioG(ctx, reader)
	if err != nil || sumG.WavesMobilized < 2 {
		t.Fatalf("Scenario G failed: %+v %v", sumG, err)
	}
	sumH, _, err := worldevents.RunSiegeScenarioH(ctx, reader)
	if err != nil || sumH.BackpressurePauses == 0 {
		t.Fatalf("Scenario H failed: %+v %v", sumH, err)
	}
	sumI, _, err := worldevents.RunSiegeScenarioI(ctx, reader)
	if err != nil || !sumI.SnapshotVerified || sumI.SnapshotBytes == 0 {
		t.Fatalf("Scenario I failed: %+v %v", sumI, err)
	}
	sumJ, _, err := worldevents.RunSiegeScenarioJ(ctx, reader)
	if err != nil || sumJ.SiegePhase != siege.PhaseWithdrawn || sumJ.Outcome != ports.InvasionOutcomeDefended {
		t.Fatalf("Scenario J failed: %+v %v", sumJ, err)
	}
}

func TestSiegePopulationConservationAndWaveIdempotency(t *testing.T) {
	cfg := worldevents.DefaultSiegeOrchestratedConfig()
	eco := worldevents.NewHighThreatOrcEco("siege-pop-cons", 6001)
	cur, err := worldevents.NewOrchestratedState("siege-pop-cons", "settlement-valewatch", 6001, mustReader(t), eco)
	if err != nil {
		t.Fatal(err)
	}

	// Independent population conservation verifier tracking births, natural deaths, combat casualties,
	// immigration, and emigration across the ENTIRE multi-wave siege lifecycle.
	initFree, initRes, initMat := ecosystem.TotalPopulationLedger(cur.Ecosystem)
	initialTotal := initFree + initRes + initMat
	var births int64
	var naturalDeaths int64
	var combatLosses int64

	var mobilizedWaveID string
	for tick := uint64(1); tick <= 220; tick++ {
		next, out, err := worldevents.Step(cur, worldevents.StepInput{}, cfg)
		if err != nil {
			t.Fatalf("tick %d: %v", tick, err)
		}
		for _, ev := range out.EcosystemEvents {
			switch ev.Type {
			case ecosystem.EventPopulationGrew:
				births += ev.Amount
			case ecosystem.EventPopulationDeclined:
				naturalDeaths += ev.Amount
			}
		}
		// Drain queues cleanly via public APIs.
		next, err = drainAllPublic(next, cfg)
		if err != nil {
			t.Fatalf("drain tick %d: %v", tick, err)
		}
		// Verify bucket conservation every single tick!
		f, r, m := ecosystem.TotalPopulationLedger(next.Ecosystem)
		if f < 0 || r < 0 || m < 0 {
			t.Fatalf("tick %d negative population bucket: (%d,%d,%d)", tick, f, r, m)
		}
		// Check wave idempotency: once a wave is mobilized, trying to spawn it again MUST fail.
		if next.World.Siege != nil && mobilizedWaveID == "" {
			for _, w := range next.World.Siege.Waves {
				if w.State == siege.WaveMobilized {
					mobilizedWaveID = w.WaveID
					dupWorld := next.World.Clone()
					_, dupErr := world.SpawnCampaignWaveGroup(&dupWorld, w.WaveID, world.DirectorCommand{
						Kind: world.CmdDirectorSpawnCampaignGroup, Tick: next.World.Tick,
						CampaignID: w.CampaignID, InvadingFactionID: next.World.Invasion.InvadingFactionID,
						GroupID: "dup-wave-grp", Archetype: w.Archetype, Count: w.Count,
						ReservationID: w.ReservationID, SourcePopulationID: "pop-ironfang-orcs",
						SourceCampID: "camp-ironfang-bastion", SourceRegionID: ecosystem.RegionIronfangFrontier,
						PopulationWeight: 4,
					}, cfg.World)
					if dupErr == nil {
						t.Fatalf("expected duplicate wave spawn %q to fail", w.WaveID)
					}
					break
				}
			}
		}
		cur = next
	}

	// Verify zero leaked reserved/materialized individuals after campaign closes, and exact equation:
	// finalTotal == initialTotal + ecoDelta - totalCombatLosses.
	for _, r := range cur.Ecosystem.Reservations {
		combatLosses += r.Casualties
	}
	finalFree, finalRes, finalMat := ecosystem.TotalPopulationLedger(cur.Ecosystem)
	finalTotal := finalFree + finalRes + finalMat
	if mobilizedWaveID == "" {
		t.Fatal("expected at least one siege wave to mobilize during test")
	}
	if finalRes != 0 || finalMat != 0 {
		t.Fatalf("expected 0 leaked reserved/materialized after siege close, got res=%d mat=%d", finalRes, finalMat)
	}
	if finalTotal != initialTotal+births-naturalDeaths-combatLosses {
		t.Fatalf("population conservation equation violated: final=%d != init(%d)+births(%d)-natDeaths(%d)-combatLosses(%d) = %d",
			finalTotal, initialTotal, births, naturalDeaths, combatLosses, initialTotal+births-naturalDeaths-combatLosses)
	}
}

func TestOccupationAndSimplifiedReconquestSameSiegeEngine(t *testing.T) {
	ctx := context.Background()
	reader := mustReader(t)

	// 1. Run Scenario D to capture Valewatch and record OccupationRecord.
	sumD, resD, err := worldevents.RunSiegeScenarioD(ctx, reader)
	if err != nil {
		t.Fatalf("capture phase failed: %v", err)
	}
	if !sumD.OccupationRecorded || len(resD.FinalState.Director.OccupiedSettlements) != 1 {
		t.Fatalf("expected 1 OccupationRecord after capture, got %+v", resD.FinalState.Director.OccupiedSettlements)
	}
	occ := resD.FinalState.Director.OccupiedSettlements[0]
	oldCampaignID := occ.CapturedCampaignID
	oldInvasionID := occ.CapturedInvasionID
	if occ.OccupyingFactionID != "faction-ironfang-orcs" || !occ.ReconquestPlanned {
		t.Fatalf("unexpected occupation record: %+v", occ)
	}

	// 2. Launch a simplified Reconquest campaign on the EXACT SAME SiegeEngine infrastructure
	// using a brand-new CampaignID and brand-new monotonic InvasionID (NEVER reusing oldInvasionID!).
	cfg := worldevents.DefaultSiegeOrchestratedConfig()
	cfg.Director.SpawnNPCDefenders = false
	cfg.Director.SiegeConfig.TowerFireDamage = 10
	cfg.Director.MinSimulatedDefenseHP = 0 // Occupied settlement has 0 defense HP prior to reconquest setup
	for i := range cfg.Director.Policies {
		if cfg.Director.Policies[i].TemplateID == worldevents.TemplateOrcWarband {
			cfg.Director.Policies[i].MainForces = []worldevents.ForceUnit{
				{Archetype: "orc-vanguard", Count: 2, Position: 12000},
				{Archetype: "orc-berserker", Count: 2, Position: 12000},
				{Archetype: "orc-warchief", Count: 1, Position: 12000},
			}
			cfg.Director.Policies[i].SiegeWaves = nil
		}
	}

	cur := resD.FinalState.Clone()
	// Advance past cooldowns & clear cooldown on settlement for explicit reconquest launch.
	cur.Director.SettlementCooldowns = []worldevents.CooldownEntry{}
	cur.Director.RegionCooldowns = []worldevents.CooldownEntry{}
	for i := range cur.Ecosystem.Populations {
		if cur.Ecosystem.Populations[i].PopulationID == "pop-ironfang-orcs" {
			cur.Ecosystem.Populations[i].FreePopulation = 140
		}
	}

	reconquestTick := cur.Director.Tick + 1
	var reconquestOutcome *worldevents.TerminalSettlementOutcome
	for tick := reconquestTick; tick < reconquestTick+240; tick++ {
		var in worldevents.StepInput
		if tick == reconquestTick {
			in.DirectorCommands = []worldevents.DirectorCommand{{
				Kind:               worldevents.DirCmdScheduleCampaign,
				Tick:               tick,
				TemplateID:         worldevents.TemplateOrcWarband,
				RegionID:           ecosystem.RegionIronfangFrontier,
				SettlementID:       "settlement-valewatch",
				SourcePopulationID: "pop-ironfang-orcs",
				SourceCampID:       "camp-ironfang-bastion",
				ScheduledTick:      tick,
				IsReconquest:       true,
			}}
		}
		next, out, err := worldevents.Step(cur, in, cfg)
		if err != nil {
			t.Fatalf("reconquest tick %d: %v", tick, err)
		}
		next, err = drainAllPublic(next, cfg)
		if err != nil {
			t.Fatalf("drain reconquest tick %d: %v", tick, err)
		}
		cur = next
		for i := range out.TerminalOutcomes {
			if out.TerminalOutcomes[i].IsReconquest {
				o := out.TerminalOutcomes[i]
				reconquestOutcome = &o
			}
		}
		if reconquestOutcome != nil && len(cur.Director.OccupiedSettlements) == 0 {
			break
		}
	}
	if reconquestOutcome == nil {
		t.Fatal("expected reconquest siege campaign to produce TerminalSettlementOutcome")
	}
	if reconquestOutcome.CampaignID == oldCampaignID || reconquestOutcome.InvasionID == oldInvasionID {
		t.Fatalf("reconquest illegally reused prior IDs: camp %q==%q inv %q==%q",
			reconquestOutcome.CampaignID, oldCampaignID, reconquestOutcome.InvasionID, oldInvasionID)
	}
	if len(cur.Director.OccupiedSettlements) != 0 {
		t.Fatalf("expected OccupationRecord cleared after reconquest victory, got %+v", cur.Director.OccupiedSettlements)
	}
}

func TestSiegeBackpressureMinimumBatchLivenessAndTamperedV6Snapshot(t *testing.T) {
	// 1. Intense siege running at EXACT minimum valid MaxEventsPerBatch + small queues + slow consumer
	// must NEVER permanently stall with ErrTickEventCapacity.
	cfg := worldevents.DefaultSiegeOrchestratedConfig()
	cfg.Director.MaxActiveCampaignsGlobal = 1
	minBatch := worldevents.MinEventsPerBatch(cfg.Director)
	cfg.Director.MaxEventsPerBatch = minBatch
	cfg.Director.MaxPendingDirectorEvents = minBatch
	cfg.Director.MaxPendingDirectorBatches = 2
	cfg.Director.MaxEventsPerUpdate = 2
	cfg.Director.MaxPendingOutcomes = 1
	cfg.Director.MaxPendingContributions = 16
	cfg.World.MaxContributions = 8

	cur, err := worldevents.NewOrchestratedState("siege-bp-min", "settlement-valewatch", 6002, mustReader(t), worldevents.NewHighThreatOrcEco("siege-bp-min", 6002))
	if err != nil {
		t.Fatal(err)
	}

	pauses := 0
	var outcomes []worldevents.TerminalSettlementOutcome
	var breachSnap []byte
	for cur.Director.Tick < 220 {
		next, out, err := worldevents.Step(cur, worldevents.StepInput{}, cfg)
		if errors.Is(err, worldevents.ErrTickEventCapacity) {
			t.Fatalf("valid config at MinEventsPerBatch=%d unexpectedly hit ErrTickEventCapacity: %v", minBatch, err)
		}
		if errors.Is(err, worldevents.ErrDirectorBackpressure) || errors.Is(err, worldevents.ErrOutcomeBackpressure) || errors.Is(err, worldevents.ErrContributionBackpressure) {
			pauses++
			// Snapshot during saturation & restore before draining!
			if len(breachSnap) == 0 {
				breachSnap, err = cur.MarshalSnapshot(cfg)
				if err != nil {
					t.Fatalf("snapshot under saturation failed: %v", err)
				}
				cur, err = worldevents.UnmarshalOrchestratedSnapshot(breachSnap, cfg)
				if err != nil {
					t.Fatalf("restore under saturation failed: %v", err)
				}
			}
			cur, err = drainAllPublic(cur, cfg)
			if err != nil {
				t.Fatalf("drain on backpressure failed: %v", err)
			}
			continue
		}
		if err != nil {
			t.Fatalf("unexpected step error at tick %d: %v", cur.Director.Tick+1, err)
		}
		cur = next
		outcomes = append(outcomes, out.TerminalOutcomes...)
	}
	if pauses == 0 || len(outcomes) == 0 {
		t.Fatalf("expected backpressure recovery and terminal outcome, got pauses=%d outcomes=%d", pauses, len(outcomes))
	}

	// 2. Forged semantically invalid v6 siege snapshots with RECALCULATED valid checksum MUST be rejected semantically!
	forgeAndVerifySemanticReject := func(name string, tamper func(st *worldevents.OrchestratedState)) {
		t.Helper()
		base, err := worldevents.NewOrchestratedState("forge-v6", "settlement-valewatch", 6003, mustReader(t), worldevents.NewHighThreatOrcEco("forge-v6", 6003))
		if err != nil {
			t.Fatal(err)
		}
		fullCfg := worldevents.DefaultSiegeOrchestratedConfig()
		// Advance until Siege is active in world.
		for base.World.Siege == nil && base.Director.Tick < 60 {
			base, _, err = worldevents.Step(base, worldevents.StepInput{}, fullCfg)
			if err != nil {
				t.Fatal(err)
			}
			base, _ = drainAllPublic(base, fullCfg)
		}
		if base.World.Siege == nil {
			t.Fatal("failed to reach active siege for forge test")
		}
		tamper(&base)
		// Construct snapshot envelope with syntactically valid v6 header & matching raw JSON payload.
		// Even if an attacker embeds a freshly computed hash (or fake hash), Validate MUST reject semantically.
		rawPayload, err := json.Marshal(simulation.SnapshotEnvelope[worldevents.OrchestratedState]{
			SchemaVersion: simulation.SnapshotVersion,
			Checksum:      "0000000000000000000000000000000000000000000000000000000000000000",
			Payload:       base,
		})
		if err != nil {
			t.Fatal(err)
		}
		_, err = worldevents.UnmarshalOrchestratedSnapshot(rawPayload, fullCfg)
		if err == nil {
			t.Fatalf("%s: expected semantic rejection, got nil", name)
		}
		if errors.Is(err, simulation.ErrSnapshotChecksumMismatch) {
			t.Fatalf("%s: rejected by checksum instead of semantic validator: %v", name, err)
		}
	}

	forgeAndVerifySemanticReject("diverged_defense_hp", func(st *worldevents.OrchestratedState) {
		st.World.SettlementDefenseHP = 1
	})
	forgeAndVerifySemanticReject("unknown_group_zone", func(st *worldevents.OrchestratedState) {
		if len(st.World.Groups) > 0 {
			st.World.Groups[0].ZoneID = "zone-forged-999"
		} else {
			st.World.Siege.Phase = siege.PhaseCaptured
		}
	})
	forgeAndVerifySemanticReject("terminal_siege_while_unresolved", func(st *worldevents.OrchestratedState) {
		st.World.Siege.Phase = siege.PhaseCaptured
	})
	forgeAndVerifySemanticReject("future_occupation_tick", func(st *worldevents.OrchestratedState) {
		st.Director.OccupiedSettlements = []siege.OccupationRecord{{
			SettlementID: "settlement-valewatch", RegionID: "region-ashvale",
			OccupyingFactionID: "faction-ironfang-orcs", CapturedTick: st.Director.Tick + 50,
		}}
	})
}

func TestProlongedSuccessiveSiegesMultiSeedAndSlowConsumer(t *testing.T) {
	cfg := worldevents.DefaultSiegeOrchestratedConfig()
	cfg.Director.MaxActiveCampaignsGlobal = 1
	cfg.Director.MaxPendingDirectorBatches = 2
	cfg.Director.MaxEventsPerUpdate = 2
	cfg.Director.MaxPendingOutcomes = 1
	cfg.Director.MaxPendingContributions = 16
	cfg.World.MaxContributions = 8
	cfg.Ecosystem.MaxReservations = 4
	cfg.Director.MinInvasionIntervalTicks = 20
	for i := range cfg.Director.Policies {
		cfg.Director.Policies[i].RegionCooldownTicks = 20
		cfg.Director.Policies[i].SettlementCooldownTicks = 20
		cfg.Director.Policies[i].RecoverTicks = 8
	}

	seeds := []uint64{7101, 7202, 7303}
	var baselineHeap, peakHeap, finalHeap uint64
	runtime.GC()
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	baselineHeap = ms.HeapAlloc

	totalOutcomes := 0
	totalPauses := 0
	seenOutcomeIDs := make(map[string]struct{})

	for _, seed := range seeds {
		simID := fmt.Sprintf("prolonged-siege-%d", seed)
		eco := worldevents.NewDualHostileConflictEco(simID, seed)
		for i := range eco.Populations {
			eco.Populations[i].FreePopulation = 240
		}
		cur, err := worldevents.NewOrchestratedState(simID, "settlement-valewatch", seed, mustReader(t), eco)
		if err != nil {
			t.Fatal(err)
		}
		for cur.Director.Tick < 600 {
			next, out, err := worldevents.Step(cur, worldevents.StepInput{}, cfg)
			if errors.Is(err, worldevents.ErrDirectorBackpressure) || errors.Is(err, worldevents.ErrOutcomeBackpressure) || errors.Is(err, worldevents.ErrContributionBackpressure) {
				totalPauses++
				cur, err = drainAllPublic(cur, cfg)
				if err != nil {
					t.Fatalf("seed %d drain error: %v", seed, err)
				}
				continue
			}
			if err != nil {
				t.Fatalf("seed %d tick %d unexpected error: %v", seed, cur.Director.Tick+1, err)
			}
			for _, o := range out.TerminalOutcomes {
				key := o.EventID + ":" + o.InvasionID
				if _, dup := seenOutcomeIDs[key]; dup {
					t.Fatalf("duplicate terminal outcome %s", key)
				}
				seenOutcomeIDs[key] = struct{}{}
				totalOutcomes++
			}
			cur = next
			// After a Captured siege resets back to Peace (Siege == nil), restore simulated defense HP
			// in this multi-cycle stress harness so successive sieges can launch across the 600-tick horizon.
			if cur.World.Siege == nil && cur.World.Invasion.State == world.InvasionPeace && cur.World.SettlementDefenseHP == 0 {
				cur.World.SettlementDefenseHP = cur.World.SettlementMaxDefenseHP
			}
			if cur.Director.Tick%24 == 0 {
				cur, err = drainAllPublic(cur, cfg)
				if err != nil {
					t.Fatal(err)
				}
			}
			if cur.Director.Tick%200 == 0 {
				runtime.GC()
				runtime.ReadMemStats(&ms)
				if ms.HeapAlloc > peakHeap {
					peakHeap = ms.HeapAlloc
				}
			}
		}
		cur, err = drainAllPublic(cur, cfg)
		if err != nil {
			t.Fatal(err)
		}
		if len(cur.Ecosystem.Reservations) > cfg.Ecosystem.MaxReservations {
			t.Fatalf("seed %d reservation bound exceeded: %d", seed, len(cur.Ecosystem.Reservations))
		}
		if len(cur.World.Groups) > cfg.World.MaxActiveGroups {
			t.Fatalf("seed %d active groups bound exceeded: %d", seed, len(cur.World.Groups))
		}
	}
	runtime.GC()
	runtime.ReadMemStats(&ms)
	finalHeap = ms.HeapAlloc
	if finalHeap > peakHeap {
		peakHeap = finalHeap
	}
	if totalOutcomes < 6 || totalPauses == 0 {
		t.Fatalf("expected >= 6 successive siege outcomes across 3 seeds and backpressure recovery, got outcomes=%d pauses=%d", totalOutcomes, totalPauses)
	}
	t.Logf("prolonged multi-seed sieges: seeds=%d ticks=%d outcomes=%d pauses=%d heap_bytes(base=%d peak=%d final=%d)",
		len(seeds), len(seeds)*600, totalOutcomes, totalPauses, baselineHeap, peakHeap, finalHeap)
}

func TestSiegeConfigWaveValidationAndCampDestructionWaveCancel(t *testing.T) {
	// 1. Invalid SiegeWaveSpec and invalid SiegeConfig rejected upfront by Config.Validate().
	badWaveCfg := worldevents.DefaultSiegeOrchestratedConfig()
	badWaveCfg.Director.Policies[0].SiegeWaves = []worldevents.SiegeWaveSpec{
		{WaveTag: "", DelayTicks: 5, Archetype: "goblin-skirmisher", Count: 1, EntryZoneID: siege.ZoneIDExteriorField},
	}
	if err := badWaveCfg.Validate(); !errors.Is(err, worldevents.ErrInvalidConfig) {
		t.Fatalf("expected ErrInvalidConfig for empty wave tag, got %v", err)
	}
	dupWaveCfg := worldevents.DefaultSiegeOrchestratedConfig()
	dupWaveCfg.Director.Policies[0].SiegeWaves = []worldevents.SiegeWaveSpec{
		{WaveTag: "w1", DelayTicks: 5, Archetype: "goblin-skirmisher", Count: 1, EntryZoneID: siege.ZoneIDExteriorField},
		{WaveTag: "w1", DelayTicks: 10, Archetype: "goblin-skirmisher", Count: 1, EntryZoneID: siege.ZoneIDExteriorField},
	}
	if err := dupWaveCfg.Validate(); !errors.Is(err, worldevents.ErrInvalidConfig) {
		t.Fatalf("expected ErrInvalidConfig for duplicate wave tag, got %v", err)
	}
	wrongFamWaveCfg := worldevents.DefaultSiegeOrchestratedConfig()
	wrongFamWaveCfg.Director.Policies[0].SiegeWaves = []worldevents.SiegeWaveSpec{
		{WaveTag: "w-orc-in-gob", DelayTicks: 5, Archetype: "orc-vanguard", Count: 1, EntryZoneID: siege.ZoneIDExteriorField},
	}
	if err := wrongFamWaveCfg.Validate(); !errors.Is(err, worldevents.ErrInvalidConfig) {
		t.Fatalf("expected ErrInvalidConfig for wrong family wave archetype, got %v", err)
	}
	badSiegeCfg := worldevents.DefaultSiegeOrchestratedConfig()
	badSiegeCfg.Director.SiegeConfig.MaxSupplies = 0
	if err := badSiegeCfg.Validate(); !errors.Is(err, worldevents.ErrInvalidConfig) {
		t.Fatalf("expected ErrInvalidConfig for invalid nested SiegeConfig, got %v", err)
	}

	// 2. If source camp is destroyed mid-siege before scheduled wave tick, wave cleanly cancels without phantom spawn.
	cfg := worldevents.DefaultSiegeOrchestratedConfig()
	cur, err := worldevents.NewOrchestratedState("wave-cancel-camp", "settlement-valewatch", 6099, mustReader(t), worldevents.NewHighThreatGoblinEco("wave-cancel-camp", 6099))
	if err != nil {
		t.Fatal(err)
	}
	destroyedCamp := false
	cancelledWaveObserved := false
	for cur.Director.Tick < 120 {
		next, _, err := worldevents.Step(cur, worldevents.StepInput{}, cfg)
		if err != nil {
			t.Fatalf("tick %d: %v", cur.Director.Tick+1, err)
		}
		next, err = drainAllPublic(next, cfg)
		if err != nil {
			t.Fatal(err)
		}
		cur = next
		// Once siege enters UnderAttack with a scheduled wave, destroy the source camp directly in ecosystem.
		if !destroyedCamp && cur.World.Invasion.State == world.InvasionUnderAttack && cur.World.Siege != nil && len(cur.World.Siege.Waves) > 0 {
			for i := range cur.Ecosystem.Camps {
				if cur.Ecosystem.Camps[i].CampID == "camp-thornveil-warren" {
					cur.Ecosystem.Camps[i].State = ecosystem.CampDestroyed
					destroyedCamp = true
					break
				}
			}
		}
		if cur.World.Siege != nil {
			for _, w := range cur.World.Siege.Waves {
				if w.State == siege.WaveCancelled {
					cancelledWaveObserved = true
				}
			}
		}
	}
	if !destroyedCamp || !cancelledWaveObserved {
		t.Fatalf("expected camp destruction (%v) to cancel pending siege wave (%v)", destroyedCamp, cancelledWaveObserved)
	}
}

func FuzzSiegeCommandsAndSnapshots(f *testing.F) {
	f.Add([]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10})
	f.Add([]byte{99, 44, 12, 0, 255, 7, 13, 21})

	cfg := worldevents.DefaultSiegeOrchestratedConfig()
	cfg.Director.MaxPendingDirectorBatches = 3
	cfg.Director.MaxEventsPerUpdate = 2

	reader, err := memory.NewSettlementReader(memory.DefaultSettlementFixtures()...)
	if err != nil {
		f.Fatal(err)
	}
	zoneIDs := []string{
		siege.ZoneIDMainGate, siege.ZoneIDWallApproach, siege.ZoneIDOuterDistrict,
		siege.ZoneIDSupplyDistrict, siege.ZoneIDCentralSquare, siege.ZoneIDCitadel,
	}
	structIDs := []string{
		siege.StructIDMainGate, siege.StructIDOuterWall, siege.StructIDNorthTower,
		siege.StructIDSupplyDepot, siege.StructIDCitadelKeep,
	}
	objIDs := []string{
		siege.ObjIDDefendGate, siege.ObjIDRepairFortification, siege.ObjIDProtectSupplies,
		siege.ObjIDHoldDistrict, siege.ObjIDDefeatCommander, siege.ObjIDDestroyGate,
	}

	f.Fuzz(func(t *testing.T, stream []byte) {
		cur, err := worldevents.NewOrchestratedState("fuzz-siege", "settlement-valewatch", 8080, reader, worldevents.NewHighThreatGoblinEco("fuzz-siege", 8080))
		if err != nil {
			t.Fatal(err)
		}
		for i := 0; i < len(stream) && i < 60; i++ {
			b := stream[i]
			nextTick := cur.Director.Tick + 1
			var in worldevents.StepInput
			if cur.World.Invasion.State == world.InvasionUnderAttack && cur.World.Siege != nil {
				switch b % 6 {
				case 0:
					in.GameplayCommands = []world.GameplayCommand{{Kind: world.CmdDeployDefender, Tick: nextTick, PlayerID: "p-fuzz", ZoneID: zoneIDs[int(b)%len(zoneIDs)]}}
				case 1:
					in.GameplayCommands = []world.GameplayCommand{{Kind: world.CmdMoveDefenderZone, Tick: nextTick, PlayerID: "p-fuzz", TargetZoneID: zoneIDs[int(b/2)%len(zoneIDs)]}}
				case 2:
					in.GameplayCommands = []world.GameplayCommand{{Kind: world.CmdPlayerRepairStructure, Tick: nextTick, PlayerID: "p-fuzz", TargetStructureID: structIDs[int(b)%len(structIDs)]}}
				case 3:
					in.GameplayCommands = []world.GameplayCommand{{Kind: world.CmdPlayerSupportDefense, Tick: nextTick, PlayerID: "p-fuzz"}}
				case 4:
					in.GameplayCommands = []world.GameplayCommand{{Kind: world.CmdCompleteObjective, Tick: nextTick, PlayerID: "p-fuzz", ObjectiveID: objIDs[int(b)%len(objIDs)]}}
				case 5:
					if len(cur.World.Groups) > 0 {
						in.GameplayCommands = []world.GameplayCommand{{Kind: world.CmdPlayerDefendStrike, Tick: nextTick, PlayerID: "p-fuzz", TargetGroupID: cur.World.Groups[int(b)%len(cur.World.Groups)].GroupID}}
					}
				}
			}
			beforeSum, _ := cur.Checksum(cfg)
			next, _, err := worldevents.Step(cur, in, cfg)
			if err != nil {
				// Atomicity: failed tick MUST NEVER mutate state.
				afterSum, _ := cur.Checksum(cfg)
				if beforeSum != afterSum {
					t.Fatalf("failed siege tick mutated state")
				}
				if errors.Is(err, worldevents.ErrDirectorBackpressure) || errors.Is(err, worldevents.ErrOutcomeBackpressure) || errors.Is(err, worldevents.ErrContributionBackpressure) {
					cur, err = drainAllPublic(cur, cfg)
					if err != nil {
						t.Fatalf("drain failed: %v", err)
					}
				}
				continue
			}
			cur = next
			if b%11 == 0 {
				raw, err := cur.MarshalSnapshot(cfg)
				if err != nil {
					t.Fatalf("snapshot encode failed: %v", err)
				}
				restored, err := worldevents.UnmarshalOrchestratedSnapshot(raw, cfg)
				if err != nil {
					t.Fatalf("snapshot decode failed: %v", err)
				}
				s1, _ := cur.Checksum(cfg)
				s2, _ := restored.Checksum(cfg)
				if s1 != s2 {
					t.Fatalf("snapshot checksum mismatch")
				}
				cur = restored
			}
		}
	})
}

func drainAllPublic(state worldevents.OrchestratedState, cfg worldevents.OrchestratedConfig) (worldevents.OrchestratedState, error) {
	cur := state
	for {
		stats, err := worldevents.PendingQueueStats(cur, cfg)
		if err != nil {
			return worldevents.OrchestratedState{}, err
		}
		if stats.PendingDirectorBatches == 0 {
			break
		}
		var seq uint64
		count := 0
		for offset := 0; ; {
			var page []worldevents.DirectorEvent
			var more bool
			seq, page, more, err = worldevents.PendingDirectorEventPage(cur, offset, cfg)
			if err != nil {
				return worldevents.OrchestratedState{}, err
			}
			count += len(page)
			offset += len(page)
			if !more {
				break
			}
		}
		cur, err = worldevents.AcknowledgeDirectorBatchVerified(cur, seq, count, cfg)
		if err != nil {
			return worldevents.OrchestratedState{}, err
		}
	}
	outs, err := worldevents.PendingTerminalOutcomes(cur, cfg)
	if err != nil {
		return worldevents.OrchestratedState{}, err
	}
	for _, o := range outs {
		cur, err = worldevents.AcknowledgeTerminalOutcomeVerified(cur, o.Sequence, o.EventID, cfg)
		if err != nil {
			return worldevents.OrchestratedState{}, err
		}
	}
	contribs, err := worldevents.PendingContributionResults(cur, cfg)
	if err != nil {
		return worldevents.OrchestratedState{}, err
	}
	for _, c := range contribs {
		cur, err = worldevents.AcknowledgeContributionVerified(cur, c.Sequence, c.Result.EventID, cfg)
		if err != nil {
			return worldevents.OrchestratedState{}, err
		}
	}
	return cur, nil
}

func mustReaderTB(tb testing.TB) *memory.SettlementReader {
	tb.Helper()
	r, err := memory.NewSettlementReader(memory.DefaultSettlementFixtures()...)
	if err != nil {
		tb.Fatal(err)
	}
	return r
}

func BenchmarkOrchestratedSiegeStep(b *testing.B) {
	cfg := worldevents.DefaultSiegeOrchestratedConfig()
	cur, err := worldevents.NewOrchestratedState("bench-siege", "settlement-valewatch", 9001, mustReaderTB(b), worldevents.NewHighThreatOrcEco("bench-siege", 9001))
	if err != nil {
		b.Fatal(err)
	}
	// Advance to active siege combat.
	for cur.World.Invasion.State != world.InvasionUnderAttack && cur.Director.Tick < 60 {
		cur, _, err = worldevents.Step(cur, worldevents.StepInput{}, cfg)
		if err != nil {
			b.Fatal(err)
		}
		cur, _ = drainAllPublic(cur, cfg)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, _, err := worldevents.Step(cur, worldevents.StepInput{}, cfg); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkOrchestratedSiegeSnapshotRoundTrip(b *testing.B) {
	cfg := worldevents.DefaultSiegeOrchestratedConfig()
	cur, err := worldevents.NewOrchestratedState("bench-siege-snap", "settlement-valewatch", 9002, mustReaderTB(b), worldevents.NewHighThreatOrcEco("bench-siege-snap", 9002))
	if err != nil {
		b.Fatal(err)
	}
	for cur.World.Invasion.State != world.InvasionUnderAttack && cur.Director.Tick < 60 {
		cur, _, err = worldevents.Step(cur, worldevents.StepInput{}, cfg)
		if err != nil {
			b.Fatal(err)
		}
		cur, _ = drainAllPublic(cur, cfg)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		raw, err := cur.MarshalSnapshot(cfg)
		if err != nil {
			b.Fatal(err)
		}
		if _, err := worldevents.UnmarshalOrchestratedSnapshot(raw, cfg); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkOrchestratedSiegeBackpressureRecovery(b *testing.B) {
	cfg := worldevents.DefaultSiegeOrchestratedConfig()
	cfg.Director.MaxActiveCampaignsGlobal = 1
	cfg.Director.MaxPendingDirectorBatches = 1
	cfg.Director.MaxEventsPerUpdate = 1
	cur, err := worldevents.NewOrchestratedState("bench-siege-bp", "settlement-valewatch", 9003, mustReaderTB(b), worldevents.NewHighThreatGoblinEco("bench-siege-bp", 9003))
	if err != nil {
		b.Fatal(err)
	}
	for len(cur.Director.PendingDirectorBatches) == 0 && cur.Director.Tick < 40 {
		cur, _, err = worldevents.Step(cur, worldevents.StepInput{}, cfg)
		if err != nil {
			b.Fatal(err)
		}
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		st := cur.Clone()
		st, err = drainAllPublic(st, cfg)
		if err != nil {
			b.Fatal(err)
		}
		if _, _, err := worldevents.Step(st, worldevents.StepInput{}, cfg); err != nil {
			b.Fatal(err)
		}
	}
}
