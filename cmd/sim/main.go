package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"time"

	"ascendra-game/internal/adapters/memory"
	"ascendra-game/internal/world"
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

	cfg := world.DefaultConfig()
	scenarios := []struct {
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

	for _, sc := range scenarios {
		if err := runAndVerify(logger, reader, cfg, sc.simID, sc.seed, sc.snapshotTick, sc.totalTicks, sc.script); err != nil {
			logger.Error("scenario_failed", slog.String("simulation_id", sc.simID), slog.String("error", err.Error()))
			return err
		}
	}
	return nil
}

func runAndVerify(
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

	logger.Info("simulation_started",
		slog.String("event", "simulation_started"),
		slog.Uint64("tick", initial.Tick),
		slog.String("simulation_id", simID),
		slog.String("entity_id", initial.SettlementID),
	)

	sinkA := memory.NewContributionSink()
	resA, err := world.RunScenario(context.Background(), initial, script, totalTicks, cfg, sinkA)
	if err != nil {
		return err
	}

	// Verify snapshot/restore determinism at snapshotTick -> totalTicks.
	atK, err := world.RunScenario(context.Background(), initial, script, snapshotTick, cfg, nil)
	if err != nil {
		return err
	}
	snapRaw, err := atK.FinalState.MarshalSnapshot()
	if err != nil {
		return err
	}
	restored, err := world.UnmarshalSnapshot(snapRaw)
	if err != nil {
		return err
	}
	sinkB := memory.NewContributionSink()
	resB, err := world.RunScenario(context.Background(), restored, script, totalTicks, cfg, sinkB)
	if err != nil {
		return err
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
