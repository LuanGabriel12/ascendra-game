package worldevents

import (
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"

	"ascendra-game/internal/ai"
	"ascendra-game/internal/ports"
	"ascendra-game/internal/simulation"
)

const (
	// RulesVersion identifies the Cycle 04 World Event Director rule set.
	RulesVersion uint32 = 1
	// DefaultMaxSnapshotBytes caps orchestrated snapshots BEFORE JSON decoding.
	DefaultMaxSnapshotBytes int = 2 * 1024 * 1024
)

var (
	ErrInvalidConfig             = errors.New("invalid world event director config")
	ErrInvalidState              = errors.New("invalid world event director state")
	ErrInvalidCommand            = errors.New("invalid director command")
	ErrInvalidCampaignTransition = errors.New("invalid campaign state transition")
	ErrCampaignNotFound          = errors.New("campaign not found")
	ErrCapacityExceeded          = errors.New("world event director capacity exceeded")
	ErrNumericOverflow           = errors.New("world event director integer overflow")
	ErrDuplicateCampaign         = errors.New("duplicate active campaign for target")
	ErrProtectedTarget           = errors.New("region or settlement is protected")
)

// EventCategory classifies high-level world event families (extensible without empty stubs).
type EventCategory string

const (
	CategoryCreature      EventCategory = "Creature"
	CategoryEnvironmental EventCategory = "Environmental"
)

func (c EventCategory) Valid() bool {
	return c == CategoryCreature || c == CategoryEnvironmental
}

func (c EventCategory) Code() uint8 {
	switch c {
	case CategoryCreature:
		return 1
	case CategoryEnvironmental:
		return 2
	default:
		return 0
	}
}

// WorldEventKind enumerates implemented Cycle 04 world event types.
type WorldEventKind string

const (
	EventGoblinRecon            WorldEventKind = "GoblinRecon"
	EventGoblinRaidCampaign     WorldEventKind = "GoblinRaidCampaign"
	EventOrcWarbandCampaign     WorldEventKind = "OrcWarbandCampaign"
	EventSettlementWarning      WorldEventKind = "SettlementWarning"
	EventEcologicalScarcity     WorldEventKind = "EcologicalScarcity"
	EventRecoveryFollowup       WorldEventKind = "RecoveryFollowup"
	EventReconquestIntent       WorldEventKind = "ReconquestIntent"
)

func (k WorldEventKind) Valid() bool {
	switch k {
	case EventGoblinRecon, EventGoblinRaidCampaign, EventOrcWarbandCampaign,
		EventSettlementWarning, EventEcologicalScarcity, EventRecoveryFollowup, EventReconquestIntent:
		return true
	default:
		return false
	}
}

// CampaignState models the explicit lifecycle finite state machine of a dynamic campaign.
type CampaignState string

const (
	CampaignCandidate      CampaignState = "Candidate"
	CampaignScheduled      CampaignState = "Scheduled"
	CampaignReconnaissance CampaignState = "Reconnaissance"
	CampaignPreparing      CampaignState = "Preparing"
	CampaignWarning        CampaignState = "Warning"
	CampaignMobilizing     CampaignState = "Mobilizing"
	CampaignActive         CampaignState = "Active"
	CampaignResolving      CampaignState = "Resolving"
	CampaignDefended       CampaignState = "Defended"
	CampaignCaptured       CampaignState = "Captured"
	CampaignCancelled      CampaignState = "Cancelled"
	CampaignExpired        CampaignState = "Expired"
	CampaignRecovering     CampaignState = "Recovering"
	CampaignCompleted      CampaignState = "Completed"
)

func (s CampaignState) Valid() bool {
	switch s {
	case CampaignCandidate, CampaignScheduled, CampaignReconnaissance, CampaignPreparing,
		CampaignWarning, CampaignMobilizing, CampaignActive, CampaignResolving,
		CampaignDefended, CampaignCaptured, CampaignCancelled, CampaignExpired,
		CampaignRecovering, CampaignCompleted:
		return true
	default:
		return false
	}
}

func (s CampaignState) Code() uint8 {
	switch s {
	case CampaignCandidate:
		return 1
	case CampaignScheduled:
		return 2
	case CampaignReconnaissance:
		return 3
	case CampaignPreparing:
		return 4
	case CampaignWarning:
		return 5
	case CampaignMobilizing:
		return 6
	case CampaignActive:
		return 7
	case CampaignResolving:
		return 8
	case CampaignDefended:
		return 9
	case CampaignCaptured:
		return 10
	case CampaignCancelled:
		return 11
	case CampaignExpired:
		return 12
	case CampaignRecovering:
		return 13
	case CampaignCompleted:
		return 14
	default:
		return 0
	}
}

// IsInFlight reports whether the campaign occupies an active region/settlement slot.
func (s CampaignState) IsInFlight() bool {
	switch s {
	case CampaignScheduled, CampaignReconnaissance, CampaignPreparing, CampaignWarning,
		CampaignMobilizing, CampaignActive, CampaignResolving:
		return true
	default:
		return false
	}
}

// IsTerminalOutcome reports whether the campaign has reached an immutable final result.
func (s CampaignState) IsTerminalOutcome() bool {
	switch s {
	case CampaignDefended, CampaignCaptured, CampaignCancelled, CampaignExpired, CampaignRecovering, CampaignCompleted:
		return true
	default:
		return false
	}
}

// ForceUnit defines a single tactical squad entry inside a data-driven campaign template.
type ForceUnit struct {
	Archetype string `json:"archetype"`
	Count     int64  `json:"count"`
	Position  int64  `json:"position"`
}

// CampaignPolicyTemplate configures data-driven goblin, orc, or future faction campaign behavior.
type CampaignPolicyTemplate struct {
	TemplateID                    string         `json:"template_id"`
	EventKind                     WorldEventKind `json:"event_kind"`
	Family                        ai.Family      `json:"family"`
	MinFreePopulation             int64          `json:"min_free_population"`
	MinThreatScore                int64          `json:"min_threat_score"`
	ReconTicks                    uint64         `json:"recon_ticks"`
	PrepTicks                     uint64         `json:"prep_ticks"`
	WarningTicks                  uint64         `json:"warning_ticks"`
	DeadlineSlackTicks            uint64         `json:"deadline_slack_ticks"`
	RecoverTicks                  uint64         `json:"recover_ticks"`
	RegionCooldownTicks           uint64         `json:"region_cooldown_ticks"`
	SettlementCooldownTicks       uint64         `json:"settlement_cooldown_ticks"`
	ReconArchetype                string         `json:"recon_archetype"`
	ReconCount                    int64          `json:"recon_count"`
	MainForces                    []ForceUnit    `json:"main_forces"`
	AllowEcologicalReinforcements bool           `json:"allow_ecological_reinforcements"`
	ReinforcementArchetype        string         `json:"reinforcement_archetype,omitempty"`
	ReinforcementCount            int64          `json:"reinforcement_count,omitempty"`
	MaxCampaignReinforcements     int            `json:"max_campaign_reinforcements,omitempty"`
	PriorityWeightLeadership      int64          `json:"priority_weight_leadership"`
	PriorityWeightTerritory       int64          `json:"priority_weight_territory"`
}

// Validate enforces numeric and catalog integrity on a campaign policy template.
func (p CampaignPolicyTemplate) Validate() error {
	if strings.TrimSpace(p.TemplateID) == "" || !p.EventKind.Valid() || !p.Family.Valid() {
		return fmt.Errorf("%w: invalid campaign template header %q", ErrInvalidConfig, p.TemplateID)
	}
	if p.MinFreePopulation <= 0 || p.MinThreatScore < 0 || p.DeadlineSlackTicks == 0 {
		return fmt.Errorf("%w: invalid thresholds in template %q", ErrInvalidConfig, p.TemplateID)
	}
	if p.ReconCount <= 0 {
		return fmt.Errorf("%w: recon_count must be > 0 in template %q", ErrInvalidConfig, p.TemplateID)
	}
	prof, err := ai.LookupProfile(p.ReconArchetype)
	if err != nil || prof.Family != p.Family {
		return fmt.Errorf("%w: invalid recon archetype %q in template %q", ErrInvalidConfig, p.ReconArchetype, p.TemplateID)
	}
	if len(p.MainForces) == 0 {
		return fmt.Errorf("%w: main_forces cannot be empty in template %q", ErrInvalidConfig, p.TemplateID)
	}
	for _, fu := range p.MainForces {
		if fu.Count <= 0 || fu.Position < 0 {
			return fmt.Errorf("%w: invalid force unit in template %q", ErrInvalidConfig, p.TemplateID)
		}
		fp, err := ai.LookupProfile(fu.Archetype)
		if err != nil || fp.Family != p.Family {
			return fmt.Errorf("%w: invalid main force archetype %q in template %q", ErrInvalidConfig, fu.Archetype, p.TemplateID)
		}
	}
	if p.AllowEcologicalReinforcements {
		if p.MaxCampaignReinforcements < 0 || p.ReinforcementCount <= 0 {
			return fmt.Errorf("%w: invalid reinforcement params in template %q", ErrInvalidConfig, p.TemplateID)
		}
		rp, err := ai.LookupProfile(p.ReinforcementArchetype)
		if err != nil || rp.Family != p.Family {
			return fmt.Errorf("%w: invalid reinforcement archetype %q in template %q", ErrInvalidConfig, p.ReinforcementArchetype, p.TemplateID)
		}
	}
	if p.PriorityWeightLeadership < 0 || p.PriorityWeightTerritory < 0 {
		return fmt.Errorf("%w: negative priority weights in template %q", ErrInvalidConfig, p.TemplateID)
	}
	return nil
}

// Config configures the deterministic World Event Director and all operational safety limits.
type Config struct {
	RulesVersion                    uint32                   `json:"rules_version"`
	CandidateEvalIntervalTicks      uint64                   `json:"candidate_eval_interval_ticks"`
	MaxActiveCampaignsGlobal        int                      `json:"max_active_campaigns_global"`
	MaxActiveCampaignsPerRegion     int                      `json:"max_active_campaigns_per_region"`
	MaxActiveCampaignsPerSettlement int                      `json:"max_active_campaigns_per_settlement"`
	MaxPendingEvents                int                      `json:"max_pending_events"`
	MaxCandidatesPerUpdate          int                      `json:"max_candidates_per_update"`
	MaxChainDepth                   int                      `json:"max_chain_depth"`
	MaxEventsPerUpdate              int                      `json:"max_events_per_update"`
	MaxCompletedHistory             int                      `json:"max_completed_history"`
	MaxOutcomesHistory              int                      `json:"max_outcomes_history"`
	MaxCooldownEntries              int                      `json:"max_cooldown_entries"`
	MaxIdentifierLength             int                      `json:"max_identifier_length"`
	MaxSnapshotBytes                int                      `json:"max_snapshot_bytes"`
	PriorityAgingPerTick            int64                    `json:"priority_aging_per_tick"`
	MinInvasionIntervalTicks        uint64                   `json:"min_invasion_interval_ticks"`
	MinSimulatedDefenseHP           int64                    `json:"min_simulated_defense_hp"`
	RequireAvailableDefenders       bool                     `json:"require_available_defenders"`
	ProtectedRegions                []string                 `json:"protected_regions,omitempty"`
	Policies                        []CampaignPolicyTemplate `json:"policies"`
}

// Validate checks all director config bounds and policy templates.
func (c Config) Validate() error {
	if c.RulesVersion != RulesVersion {
		return fmt.Errorf("%w: unsupported rules_version %d", ErrInvalidConfig, c.RulesVersion)
	}
	if c.CandidateEvalIntervalTicks == 0 {
		return fmt.Errorf("%w: candidate_eval_interval_ticks must be > 0", ErrInvalidConfig)
	}
	if c.MaxActiveCampaignsGlobal <= 0 || c.MaxActiveCampaignsPerRegion <= 0 || c.MaxActiveCampaignsPerSettlement <= 0 ||
		c.MaxPendingEvents <= 0 || c.MaxCandidatesPerUpdate <= 0 || c.MaxChainDepth < 0 ||
		c.MaxEventsPerUpdate <= 0 || c.MaxCompletedHistory <= 0 || c.MaxOutcomesHistory <= 0 ||
		c.MaxCooldownEntries <= 0 || c.MaxIdentifierLength <= 0 || c.MaxSnapshotBytes <= 0 {
		return fmt.Errorf("%w: operational capacity limits must be > 0", ErrInvalidConfig)
	}
	if c.PriorityAgingPerTick < 0 || c.MinSimulatedDefenseHP < 0 {
		return fmt.Errorf("%w: negative aging or defense floor", ErrInvalidConfig)
	}
	if len(c.Policies) == 0 {
		return fmt.Errorf("%w: at least one campaign policy template is required", ErrInvalidConfig)
	}
	seen := make(map[string]struct{}, len(c.Policies))
	for _, p := range c.Policies {
		if err := p.Validate(); err != nil {
			return err
		}
		if _, dup := seen[p.TemplateID]; dup {
			return fmt.Errorf("%w: duplicate policy template %q", ErrInvalidConfig, p.TemplateID)
		}
		seen[p.TemplateID] = struct{}{}
	}
	return nil
}

// CandidateProposal is an ephemeral evaluation proposal produced before scheduling.
type CandidateProposal struct {
	TemplateID         string
	EventKind          WorldEventKind
	RegionID           string
	SettlementID       string
	FactionID          string
	FamilyID           ai.Family
	SourcePopulationID string
	SourceCampID       string
	Priority           int64
	ThreatScore        int64
	RequiredPopulation int64
}

// ScheduledEvent represents a future planned action waiting in the deterministic scheduler.
// Explicitly distinct from emitted historical DirectorEvent facts.
type ScheduledEvent struct {
	EventID            string         `json:"event_id"`
	CampaignID         string         `json:"campaign_id,omitempty"`
	TemplateID         string         `json:"template_id,omitempty"`
	Kind               WorldEventKind `json:"kind"`
	Category           EventCategory  `json:"category"`
	RegionID           string         `json:"region_id"`
	SettlementID       string         `json:"settlement_id,omitempty"`
	FactionID          string         `json:"faction_id,omitempty"`
	SourcePopulationID string         `json:"source_population_id,omitempty"`
	SourceCampID       string         `json:"source_camp_id,omitempty"`
	Priority           int64          `json:"priority"`
	ThreatScore        int64          `json:"threat_score"`
	AgeTicks           uint64         `json:"age_ticks"`
	CreatedTick        uint64         `json:"created_tick"`
	ScheduledTick      uint64         `json:"scheduled_tick"`
	DeadlineTick       uint64         `json:"deadline_tick"`
	ParentEventID      string         `json:"parent_event_id,omitempty"`
	ChainDepth         int            `json:"chain_depth"`
	Cancelled          bool           `json:"cancelled,omitempty"`
}

// Campaign tracks a live or recovering multi-phase dynamic world campaign.
type Campaign struct {
	CampaignID             string                `json:"campaign_id"`
	TemplateID             string                `json:"template_id"`
	EventKind              WorldEventKind        `json:"event_kind"`
	RegionID               string                `json:"region_id"`
	SettlementID           string                `json:"settlement_id"`
	FactionID              string                `json:"faction_id"`
	FamilyID               ai.Family             `json:"family_id"`
	SourcePopulationID     string                `json:"source_population_id"`
	SourceCampID           string                `json:"source_camp_id"`
	ReservationID          string                `json:"reservation_id,omitempty"`
	InvasionID             string                `json:"invasion_id,omitempty"`
	ParentEventID          string                `json:"parent_event_id,omitempty"`
	RulesVersion           uint32                `json:"rules_version"`
	Priority               int64                 `json:"priority"`
	ThreatScore            int64                 `json:"threat_score"`
	State                  CampaignState         `json:"state"`
	TerminalOutcome        ports.InvasionOutcome `json:"terminal_outcome"`
	TerminalReason         string                `json:"terminal_reason,omitempty"`
	CreatedTick            uint64                `json:"created_tick"`
	ScheduledTick          uint64                `json:"scheduled_tick"`
	PhaseStartedTick       uint64                `json:"phase_started_tick"`
	DeadlineTick           uint64                `json:"deadline_tick"`
	CompletedTick          uint64                `json:"completed_tick,omitempty"`
	ReservedPopulation     int64                 `json:"reserved_population"`
	ReinforcementsDeployed int                   `json:"reinforcements_deployed"`
	ChainDepth             int                   `json:"chain_depth"`
	ReconMobilized         bool                  `json:"recon_mobilized,omitempty"`
	MainForcesMobilized    bool                  `json:"main_forces_mobilized,omitempty"`
	TerminalFactEmitted    bool                  `json:"terminal_fact_emitted,omitempty"`
}

// CampaignSummary is a compact immutable archive entry for bounded completed campaign history.
type CampaignSummary struct {
	CampaignID      string                `json:"campaign_id"`
	TemplateID      string                `json:"template_id"`
	RegionID        string                `json:"region_id"`
	SettlementID    string                `json:"settlement_id"`
	FactionID       string                `json:"faction_id"`
	FinalState      CampaignState         `json:"final_state"`
	TerminalOutcome ports.InvasionOutcome `json:"terminal_outcome"`
	CompletedTick   uint64                `json:"completed_tick"`
}

// TerminalSettlementOutcome is the authoritative global settlement resolution fact emitted
// strictly once per resolved invasion — EVEN WHEN ZERO PLAYERS PARTICIPATED (Section 20).
type TerminalSettlementOutcome struct {
	EventID              string                `json:"event_id"`
	SimulationID         string                `json:"simulation_id"`
	CampaignID           string                `json:"campaign_id"`
	InvasionID           string                `json:"invasion_id"`
	SettlementID         string                `json:"settlement_id"`
	RegionID             string                `json:"region_id"`
	InvadingFactionID    string                `json:"invading_faction_id"`
	Outcome              ports.InvasionOutcome `json:"outcome"`
	StartedTick          uint64                `json:"started_tick"`
	CompletedTick        uint64                `json:"completed_tick"`
	RulesVersion         uint32                `json:"rules_version"`
	EligibleContributors int                   `json:"eligible_contributors"`
}

// CooldownEntry tracks deterministic regional or settlement cooldown expiry ticks.
type CooldownEntry struct {
	TargetID    string `json:"target_id"`
	ReadyAtTick uint64 `json:"ready_at_tick"`
}

// DirectorEventType enumerates immutable emitted facts from the World Event Director.
type DirectorEventType string

const (
	DirEventCandidateScheduled        DirectorEventType = "WorldCampaignScheduled"
	DirEventCampaignPhaseChanged      DirectorEventType = "WorldCampaignPhaseChanged"
	DirEventSettlementWarning         DirectorEventType = "SettlementWarningIssued"
	DirEventCampaignStarted           DirectorEventType = "WorldCampaignStarted"
	DirEventCampaignCancelled         DirectorEventType = "WorldCampaignCancelled"
	DirEventCampaignExpired           DirectorEventType = "WorldCampaignExpired"
	DirEventCampaignCompleted         DirectorEventType = "WorldCampaignCompleted"
	DirEventSettlementOutcomeRecorded DirectorEventType = "SettlementInvasionResolved"
	DirEventReinforcementDeployed     DirectorEventType = "CampaignReinforcementDeployed"
	DirEventChainedEventScheduled     DirectorEventType = "ChainedWorldEventScheduled"
)

// DirectorEvent represents an immutable historical fact emitted by the Director on a tick.
type DirectorEvent struct {
	EventID         string                     `json:"event_id"`
	SimulationID    string                     `json:"simulation_id"`
	Tick            uint64                     `json:"tick"`
	Type            DirectorEventType          `json:"type"`
	CampaignID      string                     `json:"campaign_id,omitempty"`
	RegionID        string                     `json:"region_id,omitempty"`
	SettlementID    string                     `json:"settlement_id,omitempty"`
	FactionID       string                     `json:"faction_id,omitempty"`
	Detail          string                     `json:"detail,omitempty"`
	Amount          int64                      `json:"amount,omitempty"`
	TerminalOutcome *TerminalSettlementOutcome `json:"terminal_outcome,omitempty"`
}

// DirectorCommandKind enumerates explicit commands addressed to the World Event Director.
type DirectorCommandKind string

const (
	DirCmdScheduleCampaign DirectorCommandKind = "ScheduleCampaign"
	DirCmdCancelCampaign   DirectorCommandKind = "CancelCampaign"
)

// DirectorCommand allows explicit deterministic campaign scheduling or cancellation.
type DirectorCommand struct {
	Kind               DirectorCommandKind `json:"kind"`
	Tick               uint64              `json:"tick"`
	TemplateID         string              `json:"template_id,omitempty"`
	RegionID           string              `json:"region_id,omitempty"`
	SettlementID       string              `json:"settlement_id,omitempty"`
	SourcePopulationID string              `json:"source_population_id,omitempty"`
	SourceCampID       string              `json:"source_camp_id,omitempty"`
	CampaignID         string              `json:"campaign_id,omitempty"`
	Priority           int64               `json:"priority,omitempty"`
	ScheduledTick      uint64              `json:"scheduled_tick,omitempty"`
	Reason             string              `json:"reason,omitempty"`
}

// DirectorState holds the complete, deterministic, serializable state of the World Event Director.
type DirectorState struct {
	SimulationID        string                      `json:"simulation_id"`
	RulesVersion        uint32                      `json:"rules_version"`
	Tick                uint64                      `json:"tick"`
	RNG                 simulation.DeterministicRNG `json:"rng"`
	PendingEvents       []ScheduledEvent            `json:"pending_events"`
	Campaigns           []Campaign                  `json:"campaigns"`
	RegionCooldowns     []CooldownEntry             `json:"region_cooldowns"`
	SettlementCooldowns []CooldownEntry             `json:"settlement_cooldowns"`
	CompletedHistory    []CampaignSummary           `json:"completed_history"`
	TerminalOutcomes    []TerminalSettlementOutcome `json:"terminal_outcomes"`
	CampaignSeq         uint64                      `json:"campaign_seq"`
	ScheduledEventSeq   uint64                      `json:"scheduled_event_seq"`
	DirectorEventSeq    uint64                      `json:"director_event_seq"`
	OutcomeSeq          uint64                      `json:"outcome_seq"`
}

// NewDirectorState initializes a clean deterministic World Event Director state.
func NewDirectorState(simulationID string, seed uint64) DirectorState {
	return DirectorState{
		SimulationID:        simulationID,
		RulesVersion:        RulesVersion,
		Tick:                0,
		RNG:                 simulation.NewDeterministicRNG(seed),
		PendingEvents:       []ScheduledEvent{},
		Campaigns:           []Campaign{},
		RegionCooldowns:     []CooldownEntry{},
		SettlementCooldowns: []CooldownEntry{},
		CompletedHistory:    []CampaignSummary{},
		TerminalOutcomes:    []TerminalSettlementOutcome{},
	}
}

// Clone returns a deep copy of DirectorState for atomic tick execution.
func (s DirectorState) Clone() DirectorState {
	out := s
	out.PendingEvents = slices.Clone(s.PendingEvents)
	if out.PendingEvents == nil {
		out.PendingEvents = []ScheduledEvent{}
	}
	out.Campaigns = slices.Clone(s.Campaigns)
	if out.Campaigns == nil {
		out.Campaigns = []Campaign{}
	}
	out.RegionCooldowns = slices.Clone(s.RegionCooldowns)
	if out.RegionCooldowns == nil {
		out.RegionCooldowns = []CooldownEntry{}
	}
	out.SettlementCooldowns = slices.Clone(s.SettlementCooldowns)
	if out.SettlementCooldowns == nil {
		out.SettlementCooldowns = []CooldownEntry{}
	}
	out.CompletedHistory = slices.Clone(s.CompletedHistory)
	if out.CompletedHistory == nil {
		out.CompletedHistory = []CampaignSummary{}
	}
	out.TerminalOutcomes = slices.Clone(s.TerminalOutcomes)
	if out.TerminalOutcomes == nil {
		out.TerminalOutcomes = []TerminalSettlementOutcome{}
	}
	return out
}

// Validate enforces structural, ordering, capacity, and FSM invariants on DirectorState.
func (s DirectorState) Validate(cfg Config) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	if strings.TrimSpace(s.SimulationID) == "" || len(s.SimulationID) > cfg.MaxIdentifierLength {
		return fmt.Errorf("%w: invalid simulation_id", ErrInvalidState)
	}
	if s.RulesVersion != cfg.RulesVersion {
		return fmt.Errorf("%w: rules_version mismatch (%d != %d)", ErrInvalidState, s.RulesVersion, cfg.RulesVersion)
	}
	if len(s.PendingEvents) > cfg.MaxPendingEvents ||
		len(s.RegionCooldowns) > cfg.MaxCooldownEntries ||
		len(s.SettlementCooldowns) > cfg.MaxCooldownEntries ||
		len(s.CompletedHistory) > cfg.MaxCompletedHistory ||
		len(s.TerminalOutcomes) > cfg.MaxOutcomesHistory {
		return ErrCapacityExceeded
	}

	activeGlobal := 0
	activeByRegion := make(map[string]int)
	activeBySettlement := make(map[string]int)
	tacticalActiveCount := 0

	for i, ev := range s.PendingEvents {
		if strings.TrimSpace(ev.EventID) == "" || len(ev.EventID) > cfg.MaxIdentifierLength {
			return fmt.Errorf("%w: invalid scheduled event_id", ErrInvalidState)
		}
		if i > 0 && s.PendingEvents[i-1].EventID >= ev.EventID {
			return fmt.Errorf("%w: pending_events not strictly sorted by event_id", ErrInvalidState)
		}
		if !ev.Kind.Valid() || !ev.Category.Valid() {
			return fmt.Errorf("%w: invalid scheduled event kind/category", ErrInvalidState)
		}
		if ev.DeadlineTick < ev.ScheduledTick || ev.ChainDepth < 0 || ev.ChainDepth > cfg.MaxChainDepth {
			return fmt.Errorf("%w: invalid scheduled event %q deadline or chain_depth", ErrInvalidState, ev.EventID)
		}
	}

	for i, c := range s.Campaigns {
		if strings.TrimSpace(c.CampaignID) == "" || len(c.CampaignID) > cfg.MaxIdentifierLength {
			return fmt.Errorf("%w: invalid campaign_id", ErrInvalidState)
		}
		if i > 0 && s.Campaigns[i-1].CampaignID >= c.CampaignID {
			return fmt.Errorf("%w: campaigns not strictly sorted by campaign_id", ErrInvalidState)
		}
		if !c.State.Valid() || !c.EventKind.Valid() || !c.FamilyID.Valid() || !c.TerminalOutcome.Valid() {
			return fmt.Errorf("%w: campaign %q has invalid enum", ErrInvalidState, c.CampaignID)
		}
		if c.DeadlineTick < c.CreatedTick || c.ReservedPopulation < 0 || c.ReinforcementsDeployed < 0 || c.ChainDepth < 0 || c.ChainDepth > cfg.MaxChainDepth {
			return fmt.Errorf("%w: campaign %q invalid bounds", ErrInvalidState, c.CampaignID)
		}
		if c.State.IsInFlight() {
			activeGlobal++
			activeByRegion[c.RegionID]++
			if c.SettlementID != "" {
				activeBySettlement[c.SettlementID]++
			}
		}
		if c.State == CampaignActive || c.State == CampaignResolving {
			tacticalActiveCount++
		}
	}

	if activeGlobal > cfg.MaxActiveCampaignsGlobal {
		return fmt.Errorf("%w: active campaigns %d exceeds global limit %d", ErrCapacityExceeded, activeGlobal, cfg.MaxActiveCampaignsGlobal)
	}
	for regID, n := range activeByRegion {
		if n > cfg.MaxActiveCampaignsPerRegion {
			return fmt.Errorf("%w: region %q active campaigns %d exceeds limit %d", ErrCapacityExceeded, regID, n, cfg.MaxActiveCampaignsPerRegion)
		}
	}
	for setID, n := range activeBySettlement {
		if n > cfg.MaxActiveCampaignsPerSettlement {
			return fmt.Errorf("%w: settlement %q active campaigns %d exceeds limit %d", ErrCapacityExceeded, setID, n, cfg.MaxActiveCampaignsPerSettlement)
		}
	}
	if tacticalActiveCount > 1 {
		return fmt.Errorf("%w: tactical engine supports at most 1 active settlement combat at a time, got %d", ErrCapacityExceeded, tacticalActiveCount)
	}

	for i, cd := range s.RegionCooldowns {
		if strings.TrimSpace(cd.TargetID) == "" {
			return fmt.Errorf("%w: empty region cooldown id", ErrInvalidState)
		}
		if i > 0 && s.RegionCooldowns[i-1].TargetID >= cd.TargetID {
			return fmt.Errorf("%w: region_cooldowns not strictly sorted", ErrInvalidState)
		}
	}
	for i, cd := range s.SettlementCooldowns {
		if strings.TrimSpace(cd.TargetID) == "" {
			return fmt.Errorf("%w: empty settlement cooldown id", ErrInvalidState)
		}
		if i > 0 && s.SettlementCooldowns[i-1].TargetID >= cd.TargetID {
			return fmt.Errorf("%w: settlement_cooldowns not strictly sorted", ErrInvalidState)
		}
	}
	return nil
}

// Checksum computes a canonical SHA-256 hash over every logical field of DirectorState.
func (s DirectorState) Checksum(cfg Config) (string, error) {
	if err := s.Validate(cfg); err != nil {
		return "", err
	}
	h := simulation.NewCanonicalHasher()
	h.WriteString(s.SimulationID)
	h.WriteUint32(s.RulesVersion)
	h.WriteUint64(s.Tick)
	h.WriteUint64(s.RNG.State)

	h.WriteUint64(uint64(len(s.PendingEvents)))
	for _, ev := range s.PendingEvents {
		h.WriteString(ev.EventID)
		h.WriteString(ev.CampaignID)
		h.WriteString(ev.TemplateID)
		h.WriteString(string(ev.Kind))
		h.WriteUint8(ev.Category.Code())
		h.WriteString(ev.RegionID)
		h.WriteString(ev.SettlementID)
		h.WriteString(ev.FactionID)
		h.WriteString(ev.SourcePopulationID)
		h.WriteString(ev.SourceCampID)
		h.WriteInt64(ev.Priority)
		h.WriteInt64(ev.ThreatScore)
		h.WriteUint64(ev.AgeTicks)
		h.WriteUint64(ev.CreatedTick)
		h.WriteUint64(ev.ScheduledTick)
		h.WriteUint64(ev.DeadlineTick)
		h.WriteString(ev.ParentEventID)
		h.WriteInt64(int64(ev.ChainDepth))
		h.WriteBool(ev.Cancelled)
	}

	h.WriteUint64(uint64(len(s.Campaigns)))
	for _, c := range s.Campaigns {
		h.WriteString(c.CampaignID)
		h.WriteString(c.TemplateID)
		h.WriteString(string(c.EventKind))
		h.WriteString(c.RegionID)
		h.WriteString(c.SettlementID)
		h.WriteString(c.FactionID)
		h.WriteUint8(c.FamilyID.Code())
		h.WriteString(c.SourcePopulationID)
		h.WriteString(c.SourceCampID)
		h.WriteString(c.ReservationID)
		h.WriteString(c.InvasionID)
		h.WriteString(c.ParentEventID)
		h.WriteUint32(c.RulesVersion)
		h.WriteInt64(c.Priority)
		h.WriteInt64(c.ThreatScore)
		h.WriteUint8(c.State.Code())
		h.WriteString(string(c.TerminalOutcome))
		h.WriteString(c.TerminalReason)
		h.WriteUint64(c.CreatedTick)
		h.WriteUint64(c.ScheduledTick)
		h.WriteUint64(c.PhaseStartedTick)
		h.WriteUint64(c.DeadlineTick)
		h.WriteUint64(c.CompletedTick)
		h.WriteInt64(c.ReservedPopulation)
		h.WriteInt64(int64(c.ReinforcementsDeployed))
		h.WriteInt64(int64(c.ChainDepth))
		h.WriteBool(c.ReconMobilized)
		h.WriteBool(c.MainForcesMobilized)
		h.WriteBool(c.TerminalFactEmitted)
	}

	h.WriteUint64(uint64(len(s.RegionCooldowns)))
	for _, cd := range s.RegionCooldowns {
		h.WriteString(cd.TargetID)
		h.WriteUint64(cd.ReadyAtTick)
	}

	h.WriteUint64(uint64(len(s.SettlementCooldowns)))
	for _, cd := range s.SettlementCooldowns {
		h.WriteString(cd.TargetID)
		h.WriteUint64(cd.ReadyAtTick)
	}

	h.WriteUint64(uint64(len(s.CompletedHistory)))
	for _, cs := range s.CompletedHistory {
		h.WriteString(cs.CampaignID)
		h.WriteString(cs.TemplateID)
		h.WriteString(cs.RegionID)
		h.WriteString(cs.SettlementID)
		h.WriteString(cs.FactionID)
		h.WriteUint8(cs.FinalState.Code())
		h.WriteString(string(cs.TerminalOutcome))
		h.WriteUint64(cs.CompletedTick)
	}

	h.WriteUint64(uint64(len(s.TerminalOutcomes)))
	for _, o := range s.TerminalOutcomes {
		h.WriteString(o.EventID)
		h.WriteString(o.SimulationID)
		h.WriteString(o.CampaignID)
		h.WriteString(o.InvasionID)
		h.WriteString(o.SettlementID)
		h.WriteString(o.RegionID)
		h.WriteString(o.InvadingFactionID)
		h.WriteString(string(o.Outcome))
		h.WriteUint64(o.StartedTick)
		h.WriteUint64(o.CompletedTick)
		h.WriteUint32(o.RulesVersion)
		h.WriteInt64(int64(o.EligibleContributors))
	}

	h.WriteUint64(s.CampaignSeq)
	h.WriteUint64(s.ScheduledEventSeq)
	h.WriteUint64(s.DirectorEventSeq)
	h.WriteUint64(s.OutcomeSeq)
	return h.SumHex(), nil
}

func safeAddUint64(a, b uint64) (uint64, error) {
	if a > math.MaxUint64-b {
		return 0, ErrNumericOverflow
	}
	return a + b, nil
}

func safeAddInt64(a, b int64) (int64, error) {
	if b > 0 && a > math.MaxInt64-b {
		return 0, ErrNumericOverflow
	}
	if b < 0 && a < math.MinInt64-b {
		return 0, ErrNumericOverflow
	}
	return a + b, nil
}

func (s *DirectorState) newDirectorEvent(evType DirectorEventType, campaignID, regionID, settlementID, factionID, detail string, amount int64, outcome *TerminalSettlementOutcome) (DirectorEvent, error) {
	if s.DirectorEventSeq == math.MaxUint64 {
		return DirectorEvent{}, ErrNumericOverflow
	}
	s.DirectorEventSeq++
	return DirectorEvent{
		EventID:         fmt.Sprintf("dir:%s:t:%d:seq:%d:%s", s.SimulationID, s.Tick, s.DirectorEventSeq, evType),
		SimulationID:    s.SimulationID,
		Tick:            s.Tick,
		Type:            evType,
		CampaignID:      campaignID,
		RegionID:        regionID,
		SettlementID:    settlementID,
		FactionID:       factionID,
		Detail:          detail,
		Amount:          amount,
		TerminalOutcome: outcome,
	}, nil
}

func findCampaignIndex(campaigns []Campaign, id string) int {
	idx, ok := slices.BinarySearchFunc(campaigns, id, func(c Campaign, k string) int {
		return strings.Compare(c.CampaignID, k)
	})
	if !ok {
		return -1
	}
	return idx
}

func insertCampaignSorted(campaigns []Campaign, c Campaign) []Campaign {
	idx, _ := slices.BinarySearchFunc(campaigns, c.CampaignID, func(existing Campaign, k string) int {
		return strings.Compare(existing.CampaignID, k)
	})
	return slices.Insert(campaigns, idx, c)
}

func insertPendingEventSorted(events []ScheduledEvent, e ScheduledEvent) []ScheduledEvent {
	idx, _ := slices.BinarySearchFunc(events, e.EventID, func(existing ScheduledEvent, k string) int {
		return strings.Compare(existing.EventID, k)
	})
	return slices.Insert(events, idx, e)
}

func cooldownReady(list []CooldownEntry, targetID string, tick uint64) bool {
	idx, ok := slices.BinarySearchFunc(list, targetID, func(e CooldownEntry, k string) int {
		return strings.Compare(e.TargetID, k)
	})
	if !ok {
		return true
	}
	return tick >= list[idx].ReadyAtTick
}

func setCooldown(list *[]CooldownEntry, targetID string, readyAt uint64, maxEntries int) error {
	idx, ok := slices.BinarySearchFunc(*list, targetID, func(e CooldownEntry, k string) int {
		return strings.Compare(e.TargetID, k)
	})
	if ok {
		if readyAt > (*list)[idx].ReadyAtTick {
			(*list)[idx].ReadyAtTick = readyAt
		}
		return nil
	}
	if len(*list) >= maxEntries {
		return ErrCapacityExceeded
	}
	*list = slices.Insert(*list, idx, CooldownEntry{TargetID: targetID, ReadyAtTick: readyAt})
	return nil
}
