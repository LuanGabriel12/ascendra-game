package ports_test

import (
	"errors"
	"testing"

	"ascendra-game/internal/ports"
)

func TestSettlementSnapshotValidation(t *testing.T) {
	valid := ports.SettlementSnapshot{
		SettlementID: "settlement-valewatch",
		RegionID:     "region-ashvale",
		DefenseState: ports.SettlementDefenseSecure,
		MaxDefenseHP: 1000,
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("expected valid snapshot, got %v", err)
	}

	invalidCases := []struct {
		name string
		mod  func(*ports.SettlementSnapshot)
	}{
		{"empty_settlement", func(s *ports.SettlementSnapshot) { s.SettlementID = "  " }},
		{"empty_region", func(s *ports.SettlementSnapshot) { s.RegionID = "" }},
		{"bad_state", func(s *ports.SettlementSnapshot) { s.DefenseState = ports.SettlementDefenseState("Ruined") }},
		{"zero_hp", func(s *ports.SettlementSnapshot) { s.MaxDefenseHP = 0 }},
		{"neg_hp", func(s *ports.SettlementSnapshot) { s.MaxDefenseHP = -10 }},
	}

	for _, tc := range invalidCases {
		t.Run(tc.name, func(t *testing.T) {
			s := valid
			tc.mod(&s)
			if err := s.Validate(); !errors.Is(err, ports.ErrInvalidSettlementSnapshot) {
				t.Fatalf("expected ErrInvalidSettlementSnapshot, got %v", err)
			}
		})
	}
}

func TestContributionResultValidation(t *testing.T) {
	valid := ports.ContributionResult{
		EventID:      "sim:s1:inv:inv1:contrib:p1",
		SimulationID: "s1",
		InvasionID:   "inv1",
		SettlementID: "settlement-valewatch",
		Tick:         50,
		PlayerID:     "p1",
		Damage:       100,
		Support:      25,
		Objectives:   1,
		Eligible:     true,
		Outcome:      ports.InvasionOutcomeDefended,
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("expected valid contribution, got %v", err)
	}
	if !ports.InvasionOutcomeNone.Valid() || ports.InvasionOutcomeNone.ValidTerminal() {
		t.Fatalf("InvasionOutcomeNone validity flags incorrect")
	}

	invalidCases := []struct {
		name string
		mod  func(*ports.ContributionResult)
	}{
		{"empty_event", func(c *ports.ContributionResult) { c.EventID = "" }},
		{"empty_sim", func(c *ports.ContributionResult) { c.SimulationID = "" }},
		{"empty_inv", func(c *ports.ContributionResult) { c.InvasionID = "" }},
		{"empty_settlement", func(c *ports.ContributionResult) { c.SettlementID = "" }},
		{"empty_player", func(c *ports.ContributionResult) { c.PlayerID = "" }},
		{"neg_damage", func(c *ports.ContributionResult) { c.Damage = -1 }},
		{"neg_support", func(c *ports.ContributionResult) { c.Support = -1 }},
		{"neg_objectives", func(c *ports.ContributionResult) { c.Objectives = -1 }},
		{"non_terminal", func(c *ports.ContributionResult) { c.Outcome = ports.InvasionOutcomeNone }},
		{"bad_outcome", func(c *ports.ContributionResult) { c.Outcome = ports.InvasionOutcome("Draw") }},
	}

	for _, tc := range invalidCases {
		t.Run(tc.name, func(t *testing.T) {
			c := valid
			tc.mod(&c)
			if err := c.Validate(); !errors.Is(err, ports.ErrInvalidContribution) {
				t.Fatalf("expected ErrInvalidContribution, got %v", err)
			}
		})
	}
}
