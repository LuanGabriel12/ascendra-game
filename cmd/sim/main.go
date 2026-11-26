package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"time"

	"ascendra-game/internal/adapters/memory"
	"ascendra-game/internal/world"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	reader, err := memory.NewSettlementReader(memory.DefaultSettlementFixtures()...)
	if err != nil {
		logger.Error("bootstrap_failed", slog.String("error", err.Error()))
		os.Exit(1)
	}

	cfg := world.DefaultConfig()
	if err := runAndVerify(logger, reader, cfg, "sim-defended-01", 20261126, 35, 200, world.BuildDefendedScenarioScript()); err != nil {
		logger.Error("scenario_failed", slog.String("simulation_id", "sim-defended-01"), slog.String("error", err.Error()))
		os.Exit(1)
	}
	if err := runAndVerify(logger, reader, cfg, "sim-captured-01", 20261126, 25, 350, world.BuildCapturedScenarioScript()); err != nil {
		logger.Error("scenario_failed", slog.String("simulation_id", "sim-captured-01"), slog.String("error", err.Error()))
		os.Exit(1)
	}
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
		if ev.Type == world.EventInvasionPhaseChanged || ev.Type == world.EventContributionRecorded {
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
		slog.Int("contributions_dispatched", resA.ContributionsDispatched),
		slog.Bool("snapshot_verified", true),
		slog.Duration("duration", time.Since(start)),
	)
	return nil
}
