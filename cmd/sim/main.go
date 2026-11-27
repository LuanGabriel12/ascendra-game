package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"reflect"
	"slices"
	"time"

	"ascendra-game/internal/adapters/memory"
	"ascendra-game/internal/ecosystem"
	"ascendra-game/internal/world"
	"ascendra-game/internal/worldevents"
)

func main() {
	if err := runAllScenarios(os.Stdout); err != nil {
		os.Exit(1)
	}
}

func runAllScenarios(out io.Writer) error {
	logger := slog.New(slog.NewJSONHandler(out, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	reader, err := memory.NewSettlementReader(memory.DefaultSettlementFixtures()...)
	if err != nil {
		logger.Error("bootstrap_failed", slog.String("error", err.Error()))
		return err
	}

	// 1. Preserve all four Cycle 01 & 02 tactical scenarios.
	cfg := world.DefaultConfig()
	tacticalScenarios := []struct {
		simID        string
		seed         uint64
		snapshotTick uint64
		totalTicks   uint64
		script       map[uint64][]world.Command
	}{
		{"sim-defended-01", 20261126, 35, 200, world.BuildDefendedScenarioScript()},
		{"sim-captured-01", 20261126, 25, 350, world.BuildCapturedScenarioScript()},
		{"sim-warband-02", 20260202, 32, 180, world.BuildWarbandCoordinationScenarioScript()},
		{"sim-territory-02", 31337, 20, 65, world.BuildTerritorialLeashScenarioScript()},
	}
	for _, sc := range tacticalScenarios {
		if err := runTacticalAndVerify(logger, reader, cfg, sc.simID, sc.seed, sc.snapshotTick, sc.totalTicks, sc.script); err != nil {
			logger.Error("scenario_failed", slog.String("simulation_id", sc.simID), slog.String("error", err.Error()))
			return err
		}
	}

	// 2. Run Cycle 03 Ecosystem Scenarios A-F.
	ecoCfg := ecosystem.DefaultConfig()
	if err := runEcosystemScenarios(logger, reader, cfg, ecoCfg); err != nil {
		logger.Error("ecosystem_scenario_failed", slog.String("error", err.Error()))
		return err
	}

	// 3. Run Cycle 04 World Event Director Scenarios A-I & Consumer Harness J-N.
	if err := runWorldEventScenarios(logger, reader); err != nil {
		logger.Error("world_event_scenario_failed", slog.String("error", err.Error()))
		return err
	}

	// 4. Run Cycle 05 Invasion, Siege & Settlement Battle Scenarios A-J.
	if err := runSiegeScenarios(logger, reader); err != nil {
		logger.Error("siege_scenario_failed", slog.String("error", err.Error()))
		return err
	}
	return nil
}

func runTacticalAndVerify(
	logger *slog.Logger,
	reader *memory.SettlementReader,
	cfg world.Config,
	simID string,
	seed uint64,
	snapshotTick uint64,
	totalTicks uint64,
	script map[uint64][]world.Command,
) error {
	start := time.Now()
	initial, err := world.NewWorldState(simID, "settlement-valewatch", seed, reader)
	if err != nil {
		return err
	}

	sinkA := memory.NewContributionSink()
	resA, err := world.RunScenario(context.Background(), initial, script, totalTicks, cfg, sinkA)
	if err != nil {
		return err
	}

	atK, err := world.RunScenario(context.Background(), initial, script, snapshotTick, cfg, nil)
	if err != nil {
		return err
	}
	snapRaw, err := atK.FinalState.MarshalSnapshot()
	if err != nil {
		return err
	}
	restored, err := world.UnmarshalSnapshotWithLimits(snapRaw, cfg)
	if err != nil {
		return err
	}
	sinkB := memory.NewContributionSink()
	resB, err := world.RunScenario(context.Background(), restored, script, totalTicks, cfg, sinkB)
	if err != nil {
		return err
	}
	cutA := 0
	for cutA < len(resA.Events) && resA.Events[cutA].Tick <= snapshotTick {
		cutA++
	}
	if !reflect.DeepEqual(resA.Events[cutA:], resB.Events) {
		return fmt.Errorf("snapshot continuation events diverged")
	}
	if resA.FinalChecksum != resB.FinalChecksum {
		return fmt.Errorf("snapshot/restore checksum mismatch: %s != %s", resA.FinalChecksum, resB.FinalChecksum)
	}

	for _, ev := range resA.Events {
		switch ev.Type {
		case world.EventInvasionPhaseChanged,
			world.EventContributionRecorded,
			world.EventReinforcementsCalled,
			world.EventMoraleChanged,
			world.EventTerritoryAlert:
			logger.Info(string(ev.Type),
				slog.String("event", string(ev.Type)),
				slog.Uint64("tick", ev.Tick),
				slog.String("simulation_id", ev.SimulationID),
				slog.String("entity_id", ev.SourceEntityID),
				slog.String("event_id", ev.EventID),
				slog.String("state_transition", ev.StateTransition),
			)
		}
	}

	logger.Info("simulation_completed",
		slog.String("event", "simulation_completed"),
		slog.Uint64("tick", resA.FinalState.Tick),
		slog.String("simulation_id", simID),
		slog.String("entity_id", resA.FinalState.SettlementID),
		slog.String("outcome", string(resA.FinalState.Invasion.Outcome)),
		slog.String("checksum", resA.FinalChecksum),
		slog.Int("snapshot_bytes", len(snapRaw)),
		slog.Int("reinforcement_waves", resA.FinalState.Invasion.ReinforcementWaves),
		slog.Int("contributions_dispatched", resA.ContributionsDispatched),
		slog.Bool("snapshot_verified", true),
		slog.Duration("duration", time.Since(start)),
	)
	return nil
}

func runEcosystemScenarios(
	logger *slog.Logger,
	reader *memory.SettlementReader,
	worldCfg world.Config,
	ecoCfg ecosystem.Config,
) error {
	// Scenario A — Goblin Growth & Camp Expansion.
	resA, err := ecosystem.RunEpochs(context.Background(), ecosystem.NewDefaultEcosystemState("eco-scenario-a-growth", 3001), nil, 15, ecoCfg, 256)
	if err != nil {
		return err
	}
	logEcoSummary(logger, "eco-scenario-a-growth", resA, true)

	// Scenario B — Scarcity & Conserved Migration.
	resB, err := ecosystem.RunEpochs(context.Background(), ecosystem.NewScarcityMigrationState("eco-scenario-b-migration", 3002), nil, 12, ecoCfg, 256)
	if err != nil {
		return err
	}
	logEcoSummary(logger, "eco-scenario-b-migration", resB, true)

	// Scenario C — Territorial Dispute (Goblins vs Orcs).
	resC, err := ecosystem.RunEpochs(context.Background(), ecosystem.NewTerritorialDisputeState("eco-scenario-c-dispute", 3003), nil, 15, ecoCfg, 256)
	if err != nil {
		return err
	}
	logEcoSummary(logger, "eco-scenario-c-dispute", resC, true)

	// Scenario D — Rising Regional Threat to Critical.
	resD, err := ecosystem.RunEpochs(context.Background(), ecosystem.NewRisingThreatState("eco-scenario-d-threat", 3004), nil, 10, ecoCfg, 256)
	if err != nil {
		return err
	}
	logEcoSummary(logger, "eco-scenario-d-threat", resD, true)

	// Scenario E — Tactical Materialization, Combat Losses & Conserved Dematerialization.
	wInit, err := world.NewWorldState("eco-scenario-e-materialize", "settlement-valewatch", 3005, reader)
	if err != nil {
		return err
	}
	intState := world.IntegratedState{
		World:     wInit,
		Ecosystem: ecosystem.NewDefaultEcosystemState("eco-scenario-e-materialize", 3005),
	}
	intState, _, _, err = world.MaterializeGroup(intState, "camp-thornveil-warren", "mat-goblin-1", "goblin-raider-pack", 2, 10000, worldCfg, ecoCfg)
	if err != nil {
		return err
	}
	intState, _, _, err = world.MaterializeGroup(intState, "camp-ironfang-bastion", "mat-orc-1", "orc-vanguard", 2, 11000, worldCfg, ecoCfg)
	if err != nil {
		return err
	}
	// Run 25 ticks (crosses 1 ecosystem epoch), then recall surviving orc group cleanly.
	for tick := uint64(1); tick <= 25; tick++ {
		var wCmds []world.Command
		if tick == 1 {
			wCmds = []world.Command{{Kind: world.CmdIncreaseThreat, Tick: 1, Delta: 1000}}
		}
		if tick == 5 || tick == 15 {
			wCmds = []world.Command{{Kind: world.CmdPlayerDefendStrike, Tick: tick, PlayerID: "player-kael", TargetGroupID: "mat-goblin-1"}}
		}
		intState, _, _, err = world.StepIntegrated(intState, wCmds, nil, worldCfg, ecoCfg)
		if err != nil {
			return err
		}
	}
	intState, recallSummary, _, err := world.DematerializeGroup(intState, "mat-orc-1", worldCfg, ecoCfg)
	if err != nil {
		return err
	}
	intChecksum, err := intState.Checksum(worldCfg, ecoCfg)
	if err != nil {
		return err
	}
	freeTotal, matTotal := ecosystem.TotalEcosystemPopulation(intState.Ecosystem)
	logger.Info("ecosystem_scenario_completed",
		slog.String("event", "ecosystem_scenario_completed"),
		slog.String("simulation_id", "eco-scenario-e-materialize"),
		slog.Uint64("tick", intState.World.Tick),
		slog.Uint64("epoch", intState.Ecosystem.Epoch),
		slog.Int64("free_population", freeTotal),
		slog.Int64("materialized_population", matTotal),
		slog.Int64("recalled_survivors", recallSummary.Survivors),
		slog.Int64("recalled_losses", recallSummary.Losses),
		slog.String("checksum", intChecksum),
	)

	// Scenario F — Ecosystem Snapshot Interrupt, Restore & Equivalence Verification.
	initF := ecosystem.NewDefaultEcosystemState("eco-scenario-f-snapshot", 3006)
	fullF, err := ecosystem.RunEpochs(context.Background(), initF, nil, 20, ecoCfg, 256)
	if err != nil {
		return err
	}
	midF, err := ecosystem.RunEpochs(context.Background(), initF, nil, 8, ecoCfg, 256)
	if err != nil {
		return err
	}
	rawF, err := midF.FinalState.MarshalSnapshot(ecoCfg)
	if err != nil {
		return err
	}
	restoredF, err := ecosystem.UnmarshalSnapshot(rawF, ecoCfg)
	if err != nil {
		return err
	}
	contF, err := ecosystem.RunEpochs(context.Background(), restoredF, nil, 20, ecoCfg, 256)
	if err != nil {
		return err
	}
	cutF := 0
	for cutF < len(fullF.Events) && fullF.Events[cutF].Epoch <= 8 {
		cutF++
	}
	if !slices.Equal(fullF.Events[cutF:], contF.Events) {
		return fmt.Errorf("snapshot continuation events diverged")
	}
	if fullF.FinalChecksum != contF.FinalChecksum {
		return fmt.Errorf("scenario F snapshot divergence: %s != %s", fullF.FinalChecksum, contF.FinalChecksum)
	}
	logger.Info("ecosystem_scenario_completed",
		slog.String("event", "ecosystem_scenario_completed"),
		slog.String("simulation_id", "eco-scenario-f-snapshot"),
		slog.Uint64("epoch", contF.FinalState.Epoch),
		slog.Int("snapshot_bytes", len(rawF)),
		slog.Bool("snapshot_verified", true),
		slog.String("checksum", contF.FinalChecksum),
	)
	return nil
}

func logEcoSummary(logger *slog.Logger, simID string, res ecosystem.EpochResult, includeEvents bool) {
	freeTotal, matTotal := ecosystem.TotalEcosystemPopulation(res.FinalState)
	eventCounts := make(map[ecosystem.EventType]int)
	for _, ev := range res.Events {
		eventCounts[ev.Type]++
	}
	if includeEvents {
		for _, ev := range res.Events {
			switch ev.Type {
			case ecosystem.EventCampExpanded,
				ecosystem.EventPopulationMigrated,
				ecosystem.EventTerritorialInfluenceChanged,
				ecosystem.EventRegionalThreatChanged:
				logger.Info(string(ev.Type),
					slog.String("event", string(ev.Type)),
					slog.String("simulation_id", simID),
					slog.Uint64("epoch", ev.Epoch),
					slog.String("region_id", ev.RegionID),
					slog.String("entity_id", ev.EntityID),
					slog.String("detail", ev.Detail),
					slog.Int64("amount", ev.Amount),
				)
			}
		}
	}
	logger.Info("ecosystem_scenario_completed",
		slog.String("event", "ecosystem_scenario_completed"),
		slog.String("simulation_id", simID),
		slog.Uint64("epoch", res.FinalState.Epoch),
		slog.Int64("free_population", freeTotal),
		slog.Int64("materialized_population", matTotal),
		slog.Int("active_camps", len(res.FinalState.Camps)),
		slog.Int("migrations", eventCounts[ecosystem.EventPopulationMigrated]),
		slog.Int("camp_expansions", eventCounts[ecosystem.EventCampExpanded]),
		slog.Int("threat_changes", eventCounts[ecosystem.EventRegionalThreatChanged]),
		slog.String("checksum", res.FinalChecksum),
	)
}

func runWorldEventScenarios(logger *slog.Logger, reader *memory.SettlementReader) error {
	ctx := context.Background()
	runners := []func(context.Context, *memory.SettlementReader) (worldevents.ScenarioSummary, worldevents.RunResult, error){
		func(c context.Context, r *memory.SettlementReader) (worldevents.ScenarioSummary, worldevents.RunResult, error) {
			return worldevents.RunScenarioA(c, r)
		},
		func(c context.Context, r *memory.SettlementReader) (worldevents.ScenarioSummary, worldevents.RunResult, error) {
			return worldevents.RunScenarioB(c, r)
		},
		func(c context.Context, r *memory.SettlementReader) (worldevents.ScenarioSummary, worldevents.RunResult, error) {
			return worldevents.RunScenarioC(c, r)
		},
		func(c context.Context, r *memory.SettlementReader) (worldevents.ScenarioSummary, worldevents.RunResult, error) {
			return worldevents.RunScenarioD(c, r)
		},
		func(c context.Context, r *memory.SettlementReader) (worldevents.ScenarioSummary, worldevents.RunResult, error) {
			return worldevents.RunScenarioE(c, r)
		},
		func(c context.Context, r *memory.SettlementReader) (worldevents.ScenarioSummary, worldevents.RunResult, error) {
			return worldevents.RunScenarioF(c, r)
		},
		func(c context.Context, r *memory.SettlementReader) (worldevents.ScenarioSummary, worldevents.RunResult, error) {
			return worldevents.RunScenarioG(c, r)
		},
		func(c context.Context, r *memory.SettlementReader) (worldevents.ScenarioSummary, worldevents.RunResult, error) {
			return worldevents.RunScenarioH(c, r)
		},
		func(c context.Context, r *memory.SettlementReader) (worldevents.ScenarioSummary, worldevents.RunResult, error) {
			return worldevents.RunScenarioI(c, r)
		},
	}
	for _, fn := range runners {
		start := time.Now()
		sum, _, err := fn(ctx, reader)
		if err != nil {
			return err
		}
		outcomeStr := "None"
		eligible := 0
		if len(sum.TerminalOutcomes) > 0 {
			last := sum.TerminalOutcomes[len(sum.TerminalOutcomes)-1]
			outcomeStr = string(last.Outcome)
			eligible = last.EligibleContributors
		}
		logger.Info("world_event_scenario_completed",
			slog.String("event", "world_event_scenario_completed"),
			slog.String("scenario", sum.Name),
			slog.String("simulation_id", sum.SimulationID),
			slog.Uint64("tick", sum.FinalTick),
			slog.Uint64("epoch", sum.FinalEpoch),
			slog.Int("campaigns_completed", sum.CampaignsCompleted),
			slog.Int("terminal_outcomes", len(sum.TerminalOutcomes)),
			slog.String("last_outcome", outcomeStr),
			slog.Int("eligible_contributors", eligible),
			slog.Int("reinforcements_deployed", sum.ReinforcementsDeployed),
			slog.Int64("free_population", sum.FreePopulationTotal),
			slog.Int64("reserved_population", sum.ReservedPopulationTotal),
			slog.Int64("materialized_population", sum.MaterializedPopTotal),
			slog.Int("snapshot_bytes", sum.SnapshotBytes),
			slog.Bool("snapshot_verified", sum.SnapshotVerified),
			slog.String("checksum", sum.FinalChecksum),
			slog.Duration("duration", time.Since(start)),
		)
	}

	// 4. Run Recovery 04.2 Headless Consumer Harness Scenarios J-N
	// (development in-memory consumer; does NOT represent durable production persistence).
	consumerRunners := []func(context.Context, *memory.SettlementReader) (worldevents.ConsumerScenarioSummary, error){
		func(c context.Context, r *memory.SettlementReader) (worldevents.ConsumerScenarioSummary, error) {
			return worldevents.RunScenarioJImmediateConsumer(c, r)
		},
		func(c context.Context, r *memory.SettlementReader) (worldevents.ConsumerScenarioSummary, error) {
			return worldevents.RunScenarioKSlowConsumer(c, r)
		},
		func(c context.Context, r *memory.SettlementReader) (worldevents.ConsumerScenarioSummary, error) {
			return worldevents.RunScenarioLPartiallyUnavailableConsumer(c, r)
		},
		func(c context.Context, r *memory.SettlementReader) (worldevents.ConsumerScenarioSummary, error) {
			return worldevents.RunScenarioMRecoveredConsumer(c, r)
		},
		func(c context.Context, r *memory.SettlementReader) (worldevents.ConsumerScenarioSummary, error) {
			return worldevents.RunScenarioNDuplicateDeliveryConsumer(c, r)
		},
	}
	for _, fn := range consumerRunners {
		start := time.Now()
		sum, err := fn(ctx, reader)
		if err != nil {
			return err
		}
		logger.Info("world_event_consumer_scenario_completed",
			slog.String("event", "world_event_consumer_scenario_completed"),
			slog.String("scenario", sum.Name),
			slog.String("simulation_id", sum.SimulationID),
			slog.String("consumer_mode", sum.Mode),
			slog.Uint64("tick", sum.FinalTick),
			slog.Int("campaigns_completed", sum.CampaignsCompleted),
			slog.Int("director_batches_acked", sum.DirectorBatchesAcked),
			slog.Int("director_events_consumed", sum.DirectorEventsConsumed),
			slog.Int("director_pages_read", sum.DirectorPagesRead),
			slog.Int("outcomes_acked", sum.OutcomesAcked),
			slog.Int("contributions_acked", sum.ContributionsAcked),
			slog.Int("backpressure_pauses", sum.BackpressurePauses),
			slog.Int("redeliveries_deduped", sum.RedeliveriesDeduped),
			slog.Int64("free_population", sum.FreePopulationTotal),
			slog.Int64("reserved_population", sum.ReservedPopTotal),
			slog.Int64("materialized_population", sum.MaterializedPopTotal),
			slog.Int("snapshot_bytes", sum.SnapshotBytes),
			slog.Bool("snapshot_verified", sum.SnapshotVerified),
			slog.String("checksum", sum.FinalChecksum),
			slog.Duration("duration", time.Since(start)),
		)
	}
	return nil
}

func runSiegeScenarios(logger *slog.Logger, reader *memory.SettlementReader) error {
	ctx := context.Background()
	runners := []func(context.Context, *memory.SettlementReader) (worldevents.SiegeScenarioSummary, worldevents.RunResult, error){
		func(c context.Context, r *memory.SettlementReader) (worldevents.SiegeScenarioSummary, worldevents.RunResult, error) {
			return worldevents.RunSiegeScenarioA(c, r)
		},
		func(c context.Context, r *memory.SettlementReader) (worldevents.SiegeScenarioSummary, worldevents.RunResult, error) {
			return worldevents.RunSiegeScenarioB(c, r)
		},
		func(c context.Context, r *memory.SettlementReader) (worldevents.SiegeScenarioSummary, worldevents.RunResult, error) {
			return worldevents.RunSiegeScenarioC(c, r)
		},
		func(c context.Context, r *memory.SettlementReader) (worldevents.SiegeScenarioSummary, worldevents.RunResult, error) {
			return worldevents.RunSiegeScenarioD(c, r)
		},
		func(c context.Context, r *memory.SettlementReader) (worldevents.SiegeScenarioSummary, worldevents.RunResult, error) {
			return worldevents.RunSiegeScenarioE(c, r)
		},
		func(c context.Context, r *memory.SettlementReader) (worldevents.SiegeScenarioSummary, worldevents.RunResult, error) {
			return worldevents.RunSiegeScenarioF(c, r)
		},
		func(c context.Context, r *memory.SettlementReader) (worldevents.SiegeScenarioSummary, worldevents.RunResult, error) {
			return worldevents.RunSiegeScenarioG(c, r)
		},
		func(c context.Context, r *memory.SettlementReader) (worldevents.SiegeScenarioSummary, worldevents.RunResult, error) {
			return worldevents.RunSiegeScenarioH(c, r)
		},
		func(c context.Context, r *memory.SettlementReader) (worldevents.SiegeScenarioSummary, worldevents.RunResult, error) {
			return worldevents.RunSiegeScenarioI(c, r)
		},
		func(c context.Context, r *memory.SettlementReader) (worldevents.SiegeScenarioSummary, worldevents.RunResult, error) {
			return worldevents.RunSiegeScenarioJ(c, r)
		},
	}
	for _, fn := range runners {
		start := time.Now()
		sum, _, err := fn(ctx, reader)
		if err != nil {
			return err
		}
		logger.Info("siege_scenario_completed",
			slog.String("event", "siege_scenario_completed"),
			slog.String("scenario", sum.Name),
			slog.String("simulation_id", sum.SimulationID),
			slog.Uint64("tick", sum.FinalTick),
			slog.String("outcome", string(sum.Outcome)),
			slog.String("siege_phase", string(sum.SiegePhase)),
			slog.Int("structures_destroyed", sum.StructuresDestroyed),
			slog.Int("districts_captured", sum.DistrictsCaptured),
			slog.Int("waves_mobilized", sum.WavesMobilized),
			slog.Bool("commander_fallen", sum.CommanderFallen),
			slog.Int("repairs_applied", sum.RepairsApplied),
			slog.Int64("supplies_spent", sum.SuppliesSpent),
			slog.Int("backpressure_pauses", sum.BackpressurePauses),
			slog.Bool("occupation_recorded", sum.OccupationRecorded),
			slog.Int64("free_population", sum.FreePopulationTotal),
			slog.Int64("reserved_population", sum.ReservedPopTotal),
			slog.Int64("materialized_population", sum.MaterializedPopTotal),
			slog.Int("snapshot_bytes", sum.SnapshotBytes),
			slog.Bool("snapshot_verified", sum.SnapshotVerified),
			slog.String("checksum", sum.FinalChecksum),
			slog.Duration("duration", time.Since(start)),
		)
	}
	return nil
}
