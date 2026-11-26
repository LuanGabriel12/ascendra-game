package ports

import (
	"errors"
	"fmt"
	"strings"
)

// Sentinel errors for NEON <-> CARBON domain boundaries.
var (
	ErrSettlementNotFound        = errors.New("settlement not found")
	ErrInvalidSettlementSnapshot = errors.New("invalid settlement snapshot")
	ErrInvalidContribution       = errors.New("invalid contribution result")
	ErrDuplicateContribution     = errors.New("duplicate contribution event_id")
)

// SettlementDefenseState represents the minimal defense state read from CARBON
// to initialize a headless world simulation.
type SettlementDefenseState string

const (
	SettlementDefenseSecure    SettlementDefenseState = "Secure"
	SettlementDefenseFortified SettlementDefenseState = "Fortified"
	SettlementDefenseDamaged   SettlementDefenseState = "Damaged"
	SettlementDefenseCaptured  SettlementDefenseState = "Captured"
)

// Valid reports whether the defense state is a recognized contract value.
func (s SettlementDefenseState) Valid() bool {
	switch s {
	case SettlementDefenseSecure, SettlementDefenseFortified, SettlementDefenseDamaged, SettlementDefenseCaptured:
		return true
	default:
		return false
	}
}

// SettlementSnapshot is the minimal read-only gameplay projection of a Settlement
// owned by CARBON. NEON must never import persistent database schemas directly.
type SettlementSnapshot struct {
	SettlementID string
	RegionID     string
	DefenseState SettlementDefenseState
	MaxDefenseHP int64
}

// Validate enforces boundary invariants on a settlement snapshot.
func (s SettlementSnapshot) Validate() error {
	if strings.TrimSpace(s.SettlementID) == "" {
		return fmt.Errorf("%w: empty settlement_id", ErrInvalidSettlementSnapshot)
	}
	if strings.TrimSpace(s.RegionID) == "" {
		return fmt.Errorf("%w: empty region_id", ErrInvalidSettlementSnapshot)
	}
	if !s.DefenseState.Valid() {
		return fmt.Errorf("%w: unknown defense_state %q", ErrInvalidSettlementSnapshot, s.DefenseState)
	}
	if s.MaxDefenseHP <= 0 {
		return fmt.Errorf("%w: max_defense_hp must be > 0, got %d", ErrInvalidSettlementSnapshot, s.MaxDefenseHP)
	}
	return nil
}

// SettlementReader is the boundary port through which NEON queries CARBON's
// authoritative settlement metadata for simulation bootstrap.
type SettlementReader interface {
	GetSettlementSnapshot(settlementID string) (SettlementSnapshot, error)
}

// InvasionOutcome represents the terminal authoritative result of an invasion.
type InvasionOutcome string

const (
	InvasionOutcomeNone     InvasionOutcome = "None"
	InvasionOutcomeDefended InvasionOutcome = "Defended"
	InvasionOutcomeCaptured InvasionOutcome = "Captured"
)

// Valid reports whether the outcome is a recognized value.
func (o InvasionOutcome) Valid() bool {
	switch o {
	case InvasionOutcomeNone, InvasionOutcomeDefended, InvasionOutcomeCaptured:
		return true
	default:
		return false
	}
}

// ValidTerminal reports whether the outcome represents a completed invasion.
func (o InvasionOutcome) ValidTerminal() bool {
	return o == InvasionOutcomeDefended || o == InvasionOutcomeCaptured
}

// ContributionResult is the authoritative gameplay contribution summary validated
// by NEON and handed off to CARBON. It intentionally contains NO gold, items,
// Bounty, reputation, or title grants.
type ContributionResult struct {
	EventID      string          `json:"event_id"`
	SimulationID string          `json:"simulation_id"`
	InvasionID   string          `json:"invasion_id"`
	SettlementID string          `json:"settlement_id"`
	Tick         uint64          `json:"tick"`
	PlayerID     string          `json:"player_id"`
	Damage       int64           `json:"damage"`
	Support      int64           `json:"support"`
	Objectives   int64           `json:"objectives"`
	Eligible     bool            `json:"eligible"`
	Outcome      InvasionOutcome `json:"outcome"`
}

// Validate enforces contract invariants on an outgoing contribution result.
func (c ContributionResult) Validate() error {
	if strings.TrimSpace(c.EventID) == "" {
		return fmt.Errorf("%w: empty event_id", ErrInvalidContribution)
	}
	if strings.TrimSpace(c.SimulationID) == "" {
		return fmt.Errorf("%w: empty simulation_id", ErrInvalidContribution)
	}
	if strings.TrimSpace(c.InvasionID) == "" {
		return fmt.Errorf("%w: empty invasion_id", ErrInvalidContribution)
	}
	if strings.TrimSpace(c.SettlementID) == "" {
		return fmt.Errorf("%w: empty settlement_id", ErrInvalidContribution)
	}
	if strings.TrimSpace(c.PlayerID) == "" {
		return fmt.Errorf("%w: empty player_id", ErrInvalidContribution)
	}
	if c.Damage < 0 || c.Support < 0 || c.Objectives < 0 {
		return fmt.Errorf("%w: negative contribution metric (damage=%d, support=%d, objectives=%d)", ErrInvalidContribution, c.Damage, c.Support, c.Objectives)
	}
	if !c.Outcome.ValidTerminal() {
		return fmt.Errorf("%w: non-terminal outcome %q", ErrInvalidContribution, c.Outcome)
	}
	return nil
}

// ContributionSink is the boundary port through which NEON delivers validated
// event contributions to CARBON for idempotent persistence and reward decisions.
type ContributionSink interface {
	RecordContribution(result ContributionResult) error
}
