package memory_test

import (
	"errors"
	"testing"

	"ascendra-game/internal/adapters/memory"
	"ascendra-game/internal/ports"
)

func TestSettlementReaderFixturesAndErrors(t *testing.T) {
	reader, err := memory.NewSettlementReader(memory.DefaultSettlementFixtures()...)
	if err != nil {
		t.Fatalf("NewSettlementReader failed: %v", err)
	}

	snap, err := reader.GetSettlementSnapshot("settlement-valewatch")
	if err != nil {
		t.Fatalf("GetSettlementSnapshot failed: %v", err)
	}
	if snap.RegionID != "region-ashvale" || snap.MaxDefenseHP != 1000 || snap.DefenseState != ports.SettlementDefenseSecure {
		t.Fatalf("unexpected snapshot: %+v", snap)
	}

	_, err = reader.GetSettlementSnapshot("unknown-settlement")
	if !errors.Is(err, ports.ErrSettlementNotFound) {
		t.Fatalf("expected ErrSettlementNotFound, got %v", err)
	}

	_, err = memory.NewSettlementReader(ports.SettlementSnapshot{
		SettlementID: "broken",
		RegionID:     "region-x",
		DefenseState: ports.SettlementDefenseSecure,
		MaxDefenseHP: 0,
	})
	if !errors.Is(err, ports.ErrInvalidSettlementSnapshot) {
		t.Fatalf("expected ErrInvalidSettlementSnapshot, got %v", err)
	}
}

func TestContributionSinkValidationAndIdempotency(t *testing.T) {
	sink := memory.NewContributionSink()

	valid := ports.ContributionResult{
		EventID:      "sim:s1:inv:inv-1:contrib:player-1",
		SimulationID: "s1",
		InvasionID:   "inv-1",
		SettlementID: "settlement-valewatch",
		Tick:         120,
		PlayerID:     "player-1",
		Damage:       250,
		Support:      80,
		Objectives:   1,
		Eligible:     true,
		Outcome:      ports.InvasionOutcomeDefended,
	}

	if err := sink.RecordContribution(valid); err != nil {
		t.Fatalf("first RecordContribution failed: %v", err)
	}
	if !sink.HasEvent(valid.EventID) {
		t.Fatalf("expected sink to track EventID %q", valid.EventID)
	}

	// Duplicate EventID must be rejected to prevent double-rewarding.
	err := sink.RecordContribution(valid)
	if !errors.Is(err, ports.ErrDuplicateContribution) {
		t.Fatalf("expected ErrDuplicateContribution on duplicate EventID, got %v", err)
	}
	if len(sink.Records()) != 1 {
		t.Fatalf("expected 1 stored record after duplicate attempt, got %d", len(sink.Records()))
	}

	// Negative contribution must be rejected.
	invalid := valid
	invalid.EventID = "sim:s1:inv:inv-1:contrib:player-2"
	invalid.Damage = -5
	err = sink.RecordContribution(invalid)
	if !errors.Is(err, ports.ErrInvalidContribution) {
		t.Fatalf("expected ErrInvalidContribution on negative damage, got %v", err)
	}

	// Non-terminal outcome must be rejected.
	nonTerminal := valid
	nonTerminal.EventID = "sim:s1:inv:inv-1:contrib:player-3"
	nonTerminal.Outcome = ports.InvasionOutcomeNone
	err = sink.RecordContribution(nonTerminal)
	if !errors.Is(err, ports.ErrInvalidContribution) {
		t.Fatalf("expected ErrInvalidContribution on non-terminal outcome, got %v", err)
	}
}
