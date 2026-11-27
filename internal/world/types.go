package world

import (
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"

	"ascendra-game/internal/ai"
	"ascendra-game/internal/ports"
	"ascendra-game/internal/siege"
	"ascendra-game/internal/simulation"
)

const (
	// ConfigVersion versions deterministic simulation tuning parameters.
	ConfigVersion uint32 = 3
	// UnitsPerTile defines fixed-point spatial resolution: 1000 WorldUnits = 1.000 tile.
	UnitsPerTile int64 = 1000
	// BasisPointsScale defines integer percentage resolution: 10000 = 100.00%.
	BasisPointsScale int64 = 10000
)

var (
	ErrInvalidConfig             = errors.New("invalid world config")
	ErrInvalidState              = errors.New("invalid world state")
	ErrInvalidCommand            = errors.New("invalid command")
	ErrCommandTickMismatch       = errors.New("command tick does not match step tick")
	ErrInvalidInvasionTransition = errors.New("invalid invasion state transition")
	ErrUnknownEntity             = errors.New("unknown entity")
	ErrDeadEntity                = errors.New("entity is dead or routed")
	ErrCooldownActive            = errors.New("action cooldown is active")
	ErrDuplicateObjective        = errors.New("objective already completed")
	ErrInvasionNotActive         = errors.New("invasion is not active")
	ErrNumericOverflow           = errors.New("integer overflow detected")
	ErrCapacityExceeded          = errors.New("simulation capacity limit exceeded")
	ErrRetiredGroupID            = errors.New("group_id was recently retired and cannot be reused")
)

// OrchestrationMode defines the sole authority permitted to initiate invasions.
//   - OrchestrationLegacyThreat: Cycle 01-03 threshold-driven progression inside Step().
//   - OrchestrationCampaignDirector: Cycle 04 World Event Director is the SOLE authority
//     permitted to prepare/start invasions; automatic threshold transitions are disabled.
type OrchestrationMode string

const (
	OrchestrationLegacyThreat     OrchestrationMode = "LegacyThreat"
	OrchestrationCampaignDirector OrchestrationMode = "CampaignDirector"
)

func (m OrchestrationMode) Valid() bool {
	return m == "" || m == OrchestrationLegacyThreat || m == OrchestrationCampaignDirector
}

// Config holds versioned, purely integer deterministic simulation rules and capacity bounds.
type Config struct {
	Version                    uint32            `json:"version"`
	OrchestrationMode          OrchestrationMode `json:"orchestration_mode,omitempty"`
	ThreatThreshold            int64             `json:"threat_threshold"`
	InvasionThreshold          int64  `json:"invasion_threshold"`
	MaxThreat                  int64  `json:"max_threat"`
	ThreatDecayPerTick         int64  `json:"threat_decay_per_tick"`
	InvasionMaxDurationTicks   uint64 `json:"invasion_max_duration_ticks"`
	HostileSpawnDistance       int64  `json:"hostile_spawn_distance"`
	HostileAttackRange         int64  `json:"hostile_attack_range"`
	HostileMoveSpeed           int64  `json:"hostile_move_speed"`
	HostileAttackCooldown      int64  `json:"hostile_attack_cooldown"`
	HostileBaseDamage          int64  `json:"hostile_base_damage"`
	HostileDamageVariance      int64  `json:"hostile_damage_variance"`
	HostileBaseHP              int64  `json:"hostile_base_hp"`
	HostileRetreatThresholdBP  int64  `json:"hostile_retreat_threshold_bp"`
	HostileRetreatExitDistance int64  `json:"hostile_retreat_exit_distance"`
	MaxBattlefieldDistance     int64  `json:"max_battlefield_distance"`
	PlayerAttackCooldown       int64  `json:"player_attack_cooldown"`
	PlayerStrikeBaseDamage     int64  `json:"player_strike_base_damage"`
	PlayerDamageVariance       int64  `json:"player_damage_variance"`
	PlayerSupportHeal          int64  `json:"player_support_heal"`
	EligibilityMinScore        int64  `json:"eligibility_min_score"`

	// Cycle 02 defender and bounded capacity limits.
	DefenderBaseHP             int64 `json:"defender_base_hp"`
	DefenderStrikeThreatGain   int64 `json:"defender_strike_threat_gain"`
	DefenderSupportThreatGain  int64 `json:"defender_support_threat_gain"`
	DefenderThreatDecayPerTick int64 `json:"defender_threat_decay_per_tick"`
	MaxActiveGroups            int   `json:"max_active_groups"`
	MaxReinforcementWaves      int   `json:"max_reinforcement_waves"`
	MaxDefenders               int   `json:"max_defenders"`
	MaxObjectives              int   `json:"max_objectives"`
	MaxContributions           int   `json:"max_contributions"`

	// Cycle 03 operational safety & entity lifecycle cleanup limits.
	MaxSnapshotBytes           int    `json:"max_snapshot_bytes"`
	MaxIdentifierLength        int    `json:"max_identifier_length"`
	MaxCommandsPerTick         int    `json:"max_commands_per_tick"`
	MaxPlayerCooldowns         int    `json:"max_player_cooldowns"`
	GroupCleanupRetentionTicks uint64 `json:"group_cleanup_retention_ticks"`
	MaxRetiredGroupIDs         int    `json:"max_retired_group_ids"`
}

// DefaultConfig returns a balanced deterministic configuration preserving the standard
// 32-group tactical ceiling while adding Cycle 03 lifecycle and snapshot safety limits.
func DefaultConfig() Config {
	return Config{
		Version:                    ConfigVersion,
		OrchestrationMode:          OrchestrationLegacyThreat,
		ThreatThreshold:            500,
		InvasionThreshold:          1000,
		MaxThreat:                  2000,
		ThreatDecayPerTick:         1,
		InvasionMaxDurationTicks:   600,
		HostileSpawnDistance:       12 * UnitsPerTile,
		HostileAttackRange:         1500,
		HostileMoveSpeed:           500,
		HostileAttackCooldown:      12,
		HostileBaseDamage:          65,
		HostileDamageVariance:      15,
		HostileBaseHP:              400,
		HostileRetreatThresholdBP:  1500,
		HostileRetreatExitDistance: 16 * UnitsPerTile,
		MaxBattlefieldDistance:     24 * UnitsPerTile,
		PlayerAttackCooldown:       8,
		PlayerStrikeBaseDamage:     85,
		PlayerDamageVariance:       15,
		PlayerSupportHeal:          45,
		EligibilityMinScore:        100,
		DefenderBaseHP:             300,
		DefenderStrikeThreatGain:   180,
		DefenderSupportThreatGain:  70,
		DefenderThreatDecayPerTick: 4,
		MaxActiveGroups:            32,
		MaxReinforcementWaves:      4,
		MaxDefenders:               64,
		MaxObjectives:              32,
		MaxContributions:           128,
		MaxSnapshotBytes:           simulation.DefaultMaxSnapshotBytes,
		MaxIdentifierLength:        128,
		MaxCommandsPerTick:         64,
		MaxPlayerCooldowns:         128,
		GroupCleanupRetentionTicks: 4,
		MaxRetiredGroupIDs:         256,
	}
}

// Validate enforces structural, numeric, overflow, and capacity bounds on simulation configuration.
func (c Config) Validate() error {
	if c.Version != ConfigVersion {
		return fmt.Errorf("%w: unsupported config version %d", ErrInvalidConfig, c.Version)
	}
	if !c.OrchestrationMode.Valid() {
		return fmt.Errorf("%w: unknown orchestration_mode %q", ErrInvalidConfig, c.OrchestrationMode)
	}
	if c.ThreatThreshold <= 0 || c.InvasionThreshold <= c.ThreatThreshold || c.MaxThreat < c.InvasionThreshold {
		return fmt.Errorf("%w: threat thresholds must satisfy 0 < threat < invasion <= max", ErrInvalidConfig)
	}
	if c.ThreatDecayPerTick < 0 {
		return fmt.Errorf("%w: negative threat_decay_per_tick", ErrInvalidConfig)
	}
	if c.InvasionMaxDurationTicks == 0 {
		return fmt.Errorf("%w: invasion_max_duration_ticks must be > 0", ErrInvalidConfig)
	}
	if c.HostileSpawnDistance <= 0 || c.HostileAttackRange <= 0 || c.HostileMoveSpeed < 0 {
		return fmt.Errorf("%w: invalid spatial parameters", ErrInvalidConfig)
	}
	if c.HostileRetreatExitDistance <= c.HostileAttackRange {
		return fmt.Errorf("%w: hostile_retreat_exit_distance must exceed attack_range", ErrInvalidConfig)
	}
	if c.MaxBattlefieldDistance < c.HostileRetreatExitDistance || c.HostileSpawnDistance > c.MaxBattlefieldDistance {
		return fmt.Errorf("%w: max_battlefield_distance must cover spawn and retreat exit distances", ErrInvalidConfig)
	}
	if c.HostileAttackCooldown < 0 || c.HostileBaseDamage <= 0 || c.HostileDamageVariance < 0 || c.HostileDamageVariance == math.MaxInt64 || c.HostileBaseHP <= 0 {
		return fmt.Errorf("%w: invalid hostile combat parameters", ErrInvalidConfig)
	}
	if c.HostileRetreatThresholdBP < 0 || c.HostileRetreatThresholdBP > BasisPointsScale {
		return fmt.Errorf("%w: retreat threshold out of [0, %d]", ErrInvalidConfig, BasisPointsScale)
	}
	if c.PlayerAttackCooldown < 0 || c.PlayerStrikeBaseDamage <= 0 || c.PlayerDamageVariance < 0 || c.PlayerDamageVariance == math.MaxInt64 || c.PlayerSupportHeal <= 0 {
		return fmt.Errorf("%w: invalid player defense parameters", ErrInvalidConfig)
	}
	if c.EligibilityMinScore < 0 {
		return fmt.Errorf("%w: negative eligibility_min_score", ErrInvalidConfig)
	}
	if c.DefenderBaseHP <= 0 || c.DefenderStrikeThreatGain < 0 || c.DefenderSupportThreatGain < 0 || c.DefenderThreatDecayPerTick < 0 {
		return fmt.Errorf("%w: invalid defender parameters", ErrInvalidConfig)
	}
	if c.MaxActiveGroups <= 0 || c.MaxReinforcementWaves < 0 || c.MaxDefenders <= 0 || c.MaxObjectives <= 0 || c.MaxContributions <= 0 {
		return fmt.Errorf("%w: invalid capacity bounds", ErrInvalidConfig)
	}
	if c.MaxSnapshotBytes <= 0 || c.MaxIdentifierLength <= 0 || c.MaxCommandsPerTick <= 0 || c.MaxPlayerCooldowns <= 0 || c.MaxRetiredGroupIDs <= 0 {
		return fmt.Errorf("%w: invalid operational safety bounds", ErrInvalidConfig)
	}
	return nil
}

// InvasionState represents the explicit state machine of a settlement invasion.
type InvasionState string

const (
	InvasionPeace       InvasionState = "Peace"
	InvasionThreatened  InvasionState = "Threatened"
	InvasionUnderAttack InvasionState = "UnderAttack"
	InvasionResolved    InvasionState = "Resolved"
)

func (s InvasionState) Valid() bool {
	switch s {
	case InvasionPeace, InvasionThreatened, InvasionUnderAttack, InvasionResolved:
		return true
	default:
		return false
	}
}

func (s InvasionState) Code() uint8 {
	switch s {
	case InvasionPeace:
		return 1
	case InvasionThreatened:
		return 2
	case InvasionUnderAttack:
		return 3
	case InvasionResolved:
		return 4
	default:
		return 0
	}
}

// InvasionRecord captures the authoritative lifecycle state of an invasion instance.
type InvasionRecord struct {
	InvasionID           string                `json:"invasion_id"`
	Sequence             uint64                `json:"sequence"`
	CampaignID           string                `json:"campaign_id,omitempty"`
	InvadingFactionID    string                `json:"invading_faction_id,omitempty"`
	State                InvasionState         `json:"state"`
	Outcome              ports.InvasionOutcome `json:"outcome"`
	StartedTick          uint64                `json:"started_tick"`
	ResolvedTick         uint64                `json:"resolved_tick"`
	ObjectivesCompleted  []string              `json:"objectives_completed"`
	ContributionsEmitted bool                  `json:"contributions_emitted"`
	ReinforcementWaves   int                   `json:"reinforcement_waves"`
	TotalGroupsSpawned   int                   `json:"total_groups_spawned"`
}

// CreatureGroup models a hostile tactical warband simulated by the World Director and AI Engine.
// When materialized from the regional ecosystem, SourcePopulationID/SourceCampID/PopulationWeight
// link it cleanly back to its abstract population for conserved loss/survivor reconciliation.
type CreatureGroup struct {
	GroupID                string          `json:"group_id"`
	Archetype              string          `json:"archetype"`
	Family                 ai.Family       `json:"family"`
	Role                   ai.TacticalRole `json:"role"`
	State                  ai.State        `json:"state"`
	HP                     int64           `json:"hp"`
	MaxHP                  int64           `json:"max_hp"`
	MoraleBP               int64           `json:"morale_bp"`
	HomePosition           int64           `json:"home_position"`
	DistanceToSettlement   int64           `json:"distance_to_settlement"`
	AttackCooldownTicks    int64           `json:"attack_cooldown_ticks"`
	ReinforceCooldownTicks int64           `json:"reinforce_cooldown_ticks"`
	ReinforcementsCalled   int             `json:"reinforcements_called"`
	MaxReinforcementCalls  int             `json:"max_reinforcement_calls"`
	RecentDamageTaken      int64           `json:"recent_damage_taken"`
	CurrentTargetID        string          `json:"current_target_id,omitempty"`
	CurrentTarget          ai.TargetRef    `json:"current_target,omitempty"`
	TargetMemoryTicks      int64           `json:"target_memory_ticks,omitempty"`
	Routed                 bool            `json:"routed"`
	TerminalTick           uint64          `json:"terminal_tick,omitempty"`
	Accounted              bool            `json:"accounted,omitempty"`
	SourcePopulationID     string          `json:"source_population_id,omitempty"`
	SourceCampID           string          `json:"source_camp_id,omitempty"`
	SourceRegionID         string          `json:"source_region_id,omitempty"`
	FactionID              string          `json:"faction_id,omitempty"`
	ReservationID          string          `json:"reservation_id,omitempty"`
	CampaignID             string          `json:"campaign_id,omitempty"`
	PopulationWeight       int64           `json:"population_weight,omitempty"`
	ZoneID                 string          `json:"zone_id,omitempty"`
}

// DefenderEntity models a deployed defender (player or representative NPC garrison unit)
// on the battlefield perceivable by Creature AI and Siege Engine.
type DefenderEntity struct {
	PlayerID            string             `json:"player_id"`
	HP                  int64              `json:"hp"`
	MaxHP               int64              `json:"max_hp"`
	Position            int64              `json:"position"`
	ThreatScore         int64              `json:"threat_score"`
	Role                siege.DefenderRole `json:"role,omitempty"`
	ZoneID              string             `json:"zone_id,omitempty"`
	ActionCooldownTicks uint64             `json:"action_cooldown_ticks,omitempty"`
	RepairsPerformed    int                `json:"repairs_performed,omitempty"`
	IsNPC               bool               `json:"is_npc,omitempty"`
}

// PlayerCooldown tracks authoritative action cooldowns in logical ticks.
type PlayerCooldown struct {
	PlayerID       string `json:"player_id"`
	NextActionTick uint64 `json:"next_action_tick"`
}

// PlayerContribution accumulates authoritative gameplay contribution during an invasion.
type PlayerContribution struct {
	PlayerID   string `json:"player_id"`
	Damage     int64  `json:"damage"`
	Support    int64  `json:"support"`
	Objectives int64  `json:"objectives"`
}

// WorldState is the complete, deterministic, serializable logical state of a tactical world slice.
// All slices are maintained in strict canonical sorted order by stable ID (except RetiredGroupIDs,
// which is a bounded FIFO retention ring).
type WorldState struct {
	SimulationID           string                       `json:"simulation_id"`
	Tick                   uint64                       `json:"tick"`
	RNG                    simulation.DeterministicRNG  `json:"rng"`
	SettlementID           string                       `json:"settlement_id"`
	RegionID               string                       `json:"region_id"`
	SettlementDefenseHP    int64                        `json:"settlement_defense_hp"`
	SettlementMaxDefenseHP int64                        `json:"settlement_max_defense_hp"`
	InitialDefenseState    ports.SettlementDefenseState `json:"initial_defense_state"`
	RegionalThreat         int64                        `json:"regional_threat"`
	Invasion               InvasionRecord               `json:"invasion"`
	Siege                  *siege.SiegeState            `json:"siege,omitempty"`
	Groups                 []CreatureGroup              `json:"groups"`
	RetiredGroupIDs        []string                     `json:"retired_group_ids,omitempty"`
	Defenders              []DefenderEntity             `json:"defenders"`
	PlayerCooldowns        []PlayerCooldown             `json:"player_cooldowns"`
	Contributions          []PlayerContribution         `json:"contributions"`
	EventSeq               uint64                       `json:"event_seq"`
	GroupSeq               uint64                       `json:"group_seq,omitempty"`
	InvasionSeq            uint64                       `json:"invasion_seq,omitempty"`
}

// Clone returns a deep copy of WorldState so failed ticks never mutate caller state.
func (s WorldState) Clone() WorldState {
	out := s
	out.Siege = s.Siege.Clone()
	out.Invasion.ObjectivesCompleted = slices.Clone(s.Invasion.ObjectivesCompleted)
	if out.Invasion.ObjectivesCompleted == nil {
		out.Invasion.ObjectivesCompleted = []string{}
	}
	out.Groups = slices.Clone(s.Groups)
	if out.Groups == nil {
		out.Groups = []CreatureGroup{}
	}
	out.RetiredGroupIDs = slices.Clone(s.RetiredGroupIDs)
	if out.RetiredGroupIDs == nil {
		out.RetiredGroupIDs = []string{}
	}
	out.Defenders = slices.Clone(s.Defenders)
	if out.Defenders == nil {
		out.Defenders = []DefenderEntity{}
	}
	out.PlayerCooldowns = slices.Clone(s.PlayerCooldowns)
	if out.PlayerCooldowns == nil {
		out.PlayerCooldowns = []PlayerCooldown{}
	}
	out.Contributions = slices.Clone(s.Contributions)
	if out.Contributions == nil {
		out.Contributions = []PlayerContribution{}
	}
	return out
}

// Validate verifies core authoritative state invariants.
func (s WorldState) Validate() error {
	if strings.TrimSpace(s.SimulationID) == "" {
		return fmt.Errorf("%w: empty simulation_id", ErrInvalidState)
	}
	if strings.TrimSpace(s.SettlementID) == "" || strings.TrimSpace(s.RegionID) == "" {
		return fmt.Errorf("%w: empty settlement_id or region_id", ErrInvalidState)
	}
	if !s.InitialDefenseState.Valid() {
		return fmt.Errorf("%w: invalid initial_defense_state %q", ErrInvalidState, s.InitialDefenseState)
	}
	if s.SettlementMaxDefenseHP <= 0 {
		return fmt.Errorf("%w: settlement_max_defense_hp must be > 0", ErrInvalidState)
	}
	if s.SettlementDefenseHP < 0 || s.SettlementDefenseHP > s.SettlementMaxDefenseHP {
		return fmt.Errorf("%w: settlement_defense_hp %d out of [0, %d]", ErrInvalidState, s.SettlementDefenseHP, s.SettlementMaxDefenseHP)
	}
	if s.RegionalThreat < 0 {
		return fmt.Errorf("%w: negative regional_threat %d", ErrInvalidState, s.RegionalThreat)
	}
	if !s.Invasion.State.Valid() {
		return fmt.Errorf("%w: invalid invasion state %q", ErrInvalidState, s.Invasion.State)
	}
	if !s.Invasion.Outcome.Valid() {
		return fmt.Errorf("%w: invalid invasion outcome %q", ErrInvalidState, s.Invasion.Outcome)
	}
	if s.Invasion.ReinforcementWaves < 0 || s.Invasion.TotalGroupsSpawned < 0 {
		return fmt.Errorf("%w: negative reinforcement_waves or total_groups_spawned", ErrInvalidState)
	}
	if s.Invasion.State == InvasionResolved && !s.Invasion.Outcome.ValidTerminal() {
		return fmt.Errorf("%w: resolved invasion must have terminal outcome", ErrInvalidState)
	}
	if s.Invasion.State != InvasionResolved && s.Invasion.Outcome != ports.InvasionOutcomeNone {
		return fmt.Errorf("%w: unresolved invasion cannot have terminal outcome %q", ErrInvalidState, s.Invasion.Outcome)
	}

	for i, obj := range s.Invasion.ObjectivesCompleted {
		if strings.TrimSpace(obj) == "" {
			return fmt.Errorf("%w: empty completed objective", ErrInvalidState)
		}
		if i > 0 && s.Invasion.ObjectivesCompleted[i-1] >= obj {
			return fmt.Errorf("%w: completed objectives not strictly sorted", ErrInvalidState)
		}
	}

	retiredSet := make(map[string]struct{}, len(s.RetiredGroupIDs))
	for _, rid := range s.RetiredGroupIDs {
		if strings.TrimSpace(rid) == "" {
			return fmt.Errorf("%w: empty retired_group_id", ErrInvalidState)
		}
		retiredSet[rid] = struct{}{}
	}

	for i, g := range s.Groups {
		if strings.TrimSpace(g.GroupID) == "" || strings.TrimSpace(g.Archetype) == "" {
			return fmt.Errorf("%w: empty group_id or archetype", ErrInvalidState)
		}
		if i > 0 && s.Groups[i-1].GroupID >= g.GroupID {
			return fmt.Errorf("%w: groups not strictly sorted by group_id", ErrInvalidState)
		}
		if _, collision := retiredSet[g.GroupID]; collision {
			return fmt.Errorf("%w: active group %q collides with retired_group_ids", ErrInvalidState, g.GroupID)
		}
		prof, err := ai.LookupProfile(g.Archetype)
		if err != nil {
			return fmt.Errorf("%w: group %q unknown archetype %q", ErrInvalidState, g.GroupID, g.Archetype)
		}
		if g.Family != prof.Family || g.Role != prof.Role {
			return fmt.Errorf("%w: group %q family/role (%s/%s) does not match catalog (%s/%s)", ErrInvalidState, g.GroupID, g.Family, g.Role, prof.Family, prof.Role)
		}
		if !g.State.Valid() {
			return fmt.Errorf("%w: invalid group state %q", ErrInvalidState, g.State)
		}
		if g.MaxHP <= 0 || g.HP < 0 || g.HP > g.MaxHP {
			return fmt.Errorf("%w: group %q hp %d out of [0, %d]", ErrInvalidState, g.GroupID, g.HP, g.MaxHP)
		}
		if g.HP == 0 && g.State != ai.StateDead {
			return fmt.Errorf("%w: group %q has 0 hp but state is %q", ErrInvalidState, g.GroupID, g.State)
		}
		if g.MoraleBP < 0 || g.MoraleBP > BasisPointsScale {
			return fmt.Errorf("%w: group %q morale %d out of [0, %d]", ErrInvalidState, g.GroupID, g.MoraleBP, BasisPointsScale)
		}
		if g.HomePosition < 0 || g.DistanceToSettlement < 0 || g.AttackCooldownTicks < 0 || g.ReinforceCooldownTicks < 0 {
			return fmt.Errorf("%w: group %q has negative position or cooldown", ErrInvalidState, g.GroupID)
		}
		if g.ReinforcementsCalled < 0 || g.MaxReinforcementCalls < 0 || g.ReinforcementsCalled > g.MaxReinforcementCalls {
			return fmt.Errorf("%w: group %q invalid reinforcement call counts (%d/%d)", ErrInvalidState, g.GroupID, g.ReinforcementsCalled, g.MaxReinforcementCalls)
		}
		if g.RecentDamageTaken < 0 || g.TargetMemoryTicks < 0 || g.PopulationWeight < 0 {
			return fmt.Errorf("%w: group %q negative damage/memory/weight", ErrInvalidState, g.GroupID)
		}
		if !g.CurrentTarget.Valid() {
			return fmt.Errorf("%w: group %q invalid typed target %+v", ErrInvalidState, g.GroupID, g.CurrentTarget)
		}
	}

	for i, d := range s.Defenders {
		if strings.TrimSpace(d.PlayerID) == "" {
			return fmt.Errorf("%w: empty defender player_id", ErrInvalidState)
		}
		if i > 0 && s.Defenders[i-1].PlayerID >= d.PlayerID {
			return fmt.Errorf("%w: defenders not strictly sorted by player_id", ErrInvalidState)
		}
		if d.MaxHP <= 0 || d.HP < 0 || d.HP > d.MaxHP || d.Position < 0 || d.ThreatScore < 0 {
			return fmt.Errorf("%w: invalid defender %q stats", ErrInvalidState, d.PlayerID)
		}
		if !d.Role.Valid() || d.IsNPC != d.Role.IsNPC() || d.RepairsPerformed < 0 {
			return fmt.Errorf("%w: invalid defender %q role/npc/repair state", ErrInvalidState, d.PlayerID)
		}
	}

	// Single Tactical Authority & Single Source of Truth cross-checks when Siege is active.
	if s.Siege != nil {
		if err := s.Siege.Validate(); err != nil {
			return fmt.Errorf("%w: %v", ErrInvalidState, err)
		}
		if s.Siege.SettlementID != s.SettlementID || s.Siege.RegionID != s.RegionID {
			return fmt.Errorf("%w: siege settlement/region mismatch", ErrInvalidState)
		}
		if s.SettlementMaxDefenseHP != s.Siege.TotalStructureMaxHP() || s.SettlementDefenseHP != s.Siege.TotalStructureHP() {
			return fmt.Errorf("%w: settlement defense HP (%d/%d) diverged from siege structures (%d/%d)",
				ErrInvalidState, s.SettlementDefenseHP, s.SettlementMaxDefenseHP, s.Siege.TotalStructureHP(), s.Siege.TotalStructureMaxHP())
		}
		if s.Siege.CampaignID != "" && s.Invasion.CampaignID != "" && s.Siege.CampaignID != s.Invasion.CampaignID {
			return fmt.Errorf("%w: siege campaign %q != invasion campaign %q", ErrInvalidState, s.Siege.CampaignID, s.Invasion.CampaignID)
		}
		if s.Invasion.State == InvasionResolved {
			if !s.Siege.Phase.IsTerminal() || s.Siege.Phase.ToInvasionOutcome() != s.Invasion.Outcome {
				return fmt.Errorf("%w: resolved invasion outcome %q inconsistent with siege phase %q", ErrInvalidState, s.Invasion.Outcome, s.Siege.Phase)
			}
		} else if s.Siege.Phase.IsTerminal() {
			return fmt.Errorf("%w: unresolved invasion state %q cannot have terminal siege phase %q", ErrInvalidState, s.Invasion.State, s.Siege.Phase)
		}
		for _, g := range s.Groups {
			if g.ZoneID != "" && s.Siege.FindZoneIndex(g.ZoneID) < 0 {
				return fmt.Errorf("%w: group %q references unknown siege zone %q", ErrInvalidState, g.GroupID, g.ZoneID)
			}
		}
		for _, d := range s.Defenders {
			if d.ZoneID != "" && s.Siege.FindZoneIndex(d.ZoneID) < 0 {
				return fmt.Errorf("%w: defender %q references unknown siege zone %q", ErrInvalidState, d.PlayerID, d.ZoneID)
			}
		}
		for _, cmdr := range s.Siege.Commanders {
			if !s.Siege.Phase.IsTerminal() && cmdr.GroupID != "" && cmdr.Alive {
				gIdx := findGroupIndex(s.Groups, cmdr.GroupID)
				if gIdx < 0 || s.Groups[gIdx].HP == 0 || s.Groups[gIdx].State == ai.StateDead || s.Groups[gIdx].Routed {
					return fmt.Errorf("%w: alive siege commander %q references missing, routed, or dead group %q", ErrInvalidState, cmdr.CommanderID, cmdr.GroupID)
				}
			}
		}
	}

	for i, pc := range s.PlayerCooldowns {
		if strings.TrimSpace(pc.PlayerID) == "" {
			return fmt.Errorf("%w: empty cooldown player_id", ErrInvalidState)
		}
		if i > 0 && s.PlayerCooldowns[i-1].PlayerID >= pc.PlayerID {
			return fmt.Errorf("%w: player_cooldowns not strictly sorted", ErrInvalidState)
		}
	}

	for i, c := range s.Contributions {
		if strings.TrimSpace(c.PlayerID) == "" {
			return fmt.Errorf("%w: empty contribution player_id", ErrInvalidState)
		}
		if i > 0 && s.Contributions[i-1].PlayerID >= c.PlayerID {
			return fmt.Errorf("%w: contributions not strictly sorted", ErrInvalidState)
		}
		if c.Damage < 0 || c.Support < 0 || c.Objectives < 0 {
			return fmt.Errorf("%w: negative contribution for player %q", ErrInvalidState, c.PlayerID)
		}
	}

	return nil
}

// ValidateWithConfig enforces both state invariants and explicit operational/capacity caps.
func (s WorldState) ValidateWithConfig(cfg Config) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	if err := s.Validate(); err != nil {
		return err
	}
	if len(s.Groups) > cfg.MaxActiveGroups ||
		len(s.Defenders) > cfg.MaxDefenders ||
		len(s.Invasion.ObjectivesCompleted) > cfg.MaxObjectives ||
		len(s.Contributions) > cfg.MaxContributions ||
		len(s.PlayerCooldowns) > cfg.MaxPlayerCooldowns ||
		len(s.RetiredGroupIDs) > cfg.MaxRetiredGroupIDs ||
		s.Invasion.ReinforcementWaves > cfg.MaxReinforcementWaves {
		return ErrCapacityExceeded
	}
	maxID := cfg.MaxIdentifierLength
	if len(s.SimulationID) > maxID || len(s.SettlementID) > maxID || len(s.RegionID) > maxID ||
		len(s.Invasion.InvasionID) > maxID || len(s.Invasion.CampaignID) > maxID || len(s.Invasion.InvadingFactionID) > maxID {
		return fmt.Errorf("%w: top-level identifier exceeds max length %d", ErrInvalidState, maxID)
	}
	for _, g := range s.Groups {
		if len(g.GroupID) > maxID || len(g.Archetype) > maxID || len(g.SourcePopulationID) > maxID ||
			len(g.SourceCampID) > maxID || len(g.SourceRegionID) > maxID || len(g.FactionID) > maxID ||
			len(g.ReservationID) > maxID || len(g.CampaignID) > maxID || len(g.ZoneID) > maxID {
			return fmt.Errorf("%w: group identifier exceeds max length %d", ErrInvalidState, maxID)
		}
	}
	for _, d := range s.Defenders {
		if len(d.PlayerID) > maxID || len(d.ZoneID) > maxID {
			return fmt.Errorf("%w: defender identifier exceeds max length %d", ErrInvalidState, maxID)
		}
	}
	return nil
}

// Checksum computes a canonical, architecture-independent SHA-256 digest of WorldState.
func (s WorldState) Checksum() (string, error) {
	if err := s.Validate(); err != nil {
		return "", err
	}
	h := simulation.NewCanonicalHasher()
	h.WriteString(s.SimulationID)
	h.WriteUint64(s.Tick)
	h.WriteUint64(s.RNG.State)
	h.WriteString(s.SettlementID)
	h.WriteString(s.RegionID)
	h.WriteInt64(s.SettlementDefenseHP)
	h.WriteInt64(s.SettlementMaxDefenseHP)
	h.WriteString(string(s.InitialDefenseState))
	h.WriteInt64(s.RegionalThreat)

	h.WriteString(s.Invasion.InvasionID)
	h.WriteUint64(s.Invasion.Sequence)
	h.WriteString(s.Invasion.CampaignID)
	h.WriteString(s.Invasion.InvadingFactionID)
	h.WriteUint8(s.Invasion.State.Code())
	h.WriteString(string(s.Invasion.Outcome))
	h.WriteUint64(s.Invasion.StartedTick)
	h.WriteUint64(s.Invasion.ResolvedTick)
	h.WriteBool(s.Invasion.ContributionsEmitted)
	h.WriteInt64(int64(s.Invasion.ReinforcementWaves))
	h.WriteInt64(int64(s.Invasion.TotalGroupsSpawned))
	h.WriteUint64(uint64(len(s.Invasion.ObjectivesCompleted)))
	for _, obj := range s.Invasion.ObjectivesCompleted {
		h.WriteString(obj)
	}

	h.WriteUint64(uint64(len(s.Groups)))
	for _, g := range s.Groups {
		h.WriteString(g.GroupID)
		h.WriteString(g.Archetype)
		h.WriteUint8(g.Family.Code())
		h.WriteUint8(g.Role.Code())
		h.WriteUint8(g.State.Code())
		h.WriteInt64(g.HP)
		h.WriteInt64(g.MaxHP)
		h.WriteInt64(g.MoraleBP)
		h.WriteInt64(g.HomePosition)
		h.WriteInt64(g.DistanceToSettlement)
		h.WriteInt64(g.AttackCooldownTicks)
		h.WriteInt64(g.ReinforceCooldownTicks)
		h.WriteInt64(int64(g.ReinforcementsCalled))
		h.WriteInt64(int64(g.MaxReinforcementCalls))
		h.WriteInt64(g.RecentDamageTaken)
		h.WriteString(g.CurrentTargetID)
		h.WriteUint8(g.CurrentTarget.Kind.Code())
		h.WriteString(g.CurrentTarget.ID)
		h.WriteInt64(g.TargetMemoryTicks)
		h.WriteBool(g.Routed)
		h.WriteUint64(g.TerminalTick)
		h.WriteBool(g.Accounted)
		h.WriteString(g.SourcePopulationID)
		h.WriteString(g.SourceCampID)
		h.WriteString(g.SourceRegionID)
		h.WriteString(g.FactionID)
		h.WriteString(g.ReservationID)
		h.WriteString(g.CampaignID)
		h.WriteInt64(g.PopulationWeight)
		h.WriteString(g.ZoneID)
	}

	h.WriteUint64(uint64(len(s.RetiredGroupIDs)))
	for _, rid := range s.RetiredGroupIDs {
		h.WriteString(rid)
	}

	h.WriteUint64(uint64(len(s.Defenders)))
	for _, d := range s.Defenders {
		h.WriteString(d.PlayerID)
		h.WriteInt64(d.HP)
		h.WriteInt64(d.MaxHP)
		h.WriteInt64(d.Position)
		h.WriteInt64(d.ThreatScore)
		h.WriteUint8(d.Role.Code())
		h.WriteString(d.ZoneID)
		h.WriteUint64(d.ActionCooldownTicks)
		h.WriteInt64(int64(d.RepairsPerformed))
		h.WriteBool(d.IsNPC)
	}

	h.WriteBool(s.Siege != nil)
	if s.Siege != nil {
		s.Siege.WriteChecksum(h)
	}

	h.WriteUint64(uint64(len(s.PlayerCooldowns)))
	for _, pc := range s.PlayerCooldowns {
		h.WriteString(pc.PlayerID)
		h.WriteUint64(pc.NextActionTick)
	}

	h.WriteUint64(uint64(len(s.Contributions)))
	for _, c := range s.Contributions {
		h.WriteString(c.PlayerID)
		h.WriteInt64(c.Damage)
		h.WriteInt64(c.Support)
		h.WriteInt64(c.Objectives)
	}

	h.WriteUint64(s.EventSeq)
	h.WriteUint64(s.GroupSeq)
	h.WriteUint64(s.InvasionSeq)
	return h.SumHex(), nil
}

// MarshalSnapshot encodes WorldState into a versioned snapshot envelope with canonical checksum.
func (s WorldState) MarshalSnapshot() ([]byte, error) {
	sum, err := s.Checksum()
	if err != nil {
		return nil, err
	}
	return simulation.EncodeSnapshot(s, sum)
}

// UnmarshalSnapshot decodes a versioned snapshot enforcing DefaultMaxSnapshotBytes before
// JSON allocation, validating invariants and verifying its canonical checksum.
func UnmarshalSnapshot(data []byte) (WorldState, error) {
	return simulation.DecodeSnapshot(data, func(st WorldState) (string, error) {
		return st.Checksum()
	})
}

// UnmarshalSnapshotWithLimits enforces cfg.MaxSnapshotBytes BEFORE JSON decoding and
// validates all operational capacity limits in cfg immediately upon restoration.
func UnmarshalSnapshotWithLimits(data []byte, cfg Config) (WorldState, error) {
	if err := cfg.Validate(); err != nil {
		return WorldState{}, err
	}
	opts := simulation.DecodeOptions{MaxBytes: cfg.MaxSnapshotBytes}
	st, err := simulation.DecodeSnapshotWithOptions(data, opts, func(st WorldState) (string, error) {
		return st.Checksum()
	})
	if err != nil {
		return WorldState{}, err
	}
	if err := st.ValidateWithConfig(cfg); err != nil {
		return WorldState{}, err
	}
	return st, nil
}

// CommandKind enumerates untrusted external or scripted intentions processed authoritatively.
type CommandKind string

const (
	CmdIncreaseThreat                CommandKind = "IncreaseThreat"
	CmdSpawnHostileGroup             CommandKind = "SpawnHostileGroup"
	CmdForceInvasionTransition       CommandKind = "ForceInvasionTransition"
	CmdDeployDefender                CommandKind = "DeployDefender"
	CmdMoveDefenderZone              CommandKind = "MoveDefenderZone"
	CmdPlayerDefendStrike            CommandKind = "PlayerDefendStrike"
	CmdPlayerSupportDefense          CommandKind = "PlayerSupportDefense"
	CmdPlayerRepairStructure         CommandKind = "PlayerRepairStructure"
	CmdCompleteObjective             CommandKind = "CompleteObjective"
	CmdConfigureSiege                CommandKind = "ConfigureSiege"
	CmdDirectorPrepareInvasion       CommandKind = "DirectorPrepareInvasion"
	CmdDirectorStartInvasion         CommandKind = "DirectorStartInvasion"
	CmdDirectorSpawnCampaignGroup    CommandKind = "DirectorSpawnCampaignGroup"
	CmdDirectorResetResolvedInvasion CommandKind = "DirectorResetResolvedInvasion"
	CmdDirectorAbortPreparedInvasion CommandKind = "DirectorAbortPreparedInvasion"
	CmdDirectorConfigureSiege        CommandKind = "DirectorConfigureSiege"
	CmdDirectorScheduleSiegeWave     CommandKind = "DirectorScheduleSiegeWave"
)

// Command carries an explicit intention targeting a single logical tick.
// Players never specify damage, HP, threat, rewards, or cooldown values in commands.
type Command struct {
	Kind               CommandKind             `json:"kind"`
	Tick               uint64                  `json:"tick"`
	PlayerID           string                  `json:"player_id,omitempty"`
	TargetGroupID      string                  `json:"target_group_id,omitempty"`
	TargetStructureID  string                  `json:"target_structure_id,omitempty"`
	ZoneID             string                  `json:"zone_id,omitempty"`
	TargetZoneID       string                  `json:"target_zone_id,omitempty"`
	GroupID            string                  `json:"group_id,omitempty"`
	Archetype          string                  `json:"archetype,omitempty"`
	Count              int64                   `json:"count,omitempty"`
	Position           int64                   `json:"position,omitempty"`
	HomePosition       int64                   `json:"home_position,omitempty"`
	Delta              int64                   `json:"delta,omitempty"`
	Source             string                  `json:"source,omitempty"`
	ObjectiveID        string                  `json:"objective_id,omitempty"`
	TargetState        InvasionState           `json:"target_state,omitempty"`
	CampaignID         string                  `json:"campaign_id,omitempty"`
	InvadingFactionID  string                  `json:"invading_faction_id,omitempty"`
	InvadingFamily     ai.Family               `json:"invading_family,omitempty"`
	IsReconquest       bool                    `json:"is_reconquest,omitempty"`
	SpawnNPCDefenders  bool                    `json:"spawn_npc_defenders,omitempty"`
	ReservationID      string                  `json:"reservation_id,omitempty"`
	SourcePopulationID string                  `json:"source_population_id,omitempty"`
	SourceCampID       string                  `json:"source_camp_id,omitempty"`
	SourceRegionID     string                  `json:"source_region_id,omitempty"`
	PopulationWeight   int64                   `json:"population_weight,omitempty"`
	SiegeLayout        *siege.SettlementLayout `json:"siege_layout,omitempty"`
	SiegeConfig        *siege.Config           `json:"siege_config,omitempty"`
	Wave               *siege.SiegeWave        `json:"wave,omitempty"`
}

// CanonicalizeCommands returns a deterministically ordered copy of tick commands covering
// all payload fields so execution order is independent of caller slice ordering.
// Note: deterministic ordering ensures replay equivalence, NOT competitive fairness policy.
func CanonicalizeCommands(cmds []Command) []Command {
	if len(cmds) <= 1 {
		return slices.Clone(cmds)
	}
	out := slices.Clone(cmds)
	slices.SortStableFunc(out, compareCommands)
	return out
}

func commandPriority(k CommandKind) int {
	switch k {
	case CmdDirectorResetResolvedInvasion, CmdDirectorAbortPreparedInvasion:
		return 0
	case CmdConfigureSiege, CmdDirectorConfigureSiege:
		return 1
	case CmdDirectorScheduleSiegeWave:
		return 2
	case CmdDeployDefender, CmdMoveDefenderZone:
		return 3
	case CmdSpawnHostileGroup, CmdDirectorSpawnCampaignGroup:
		return 4
	case CmdIncreaseThreat:
		return 5
	case CmdForceInvasionTransition, CmdDirectorPrepareInvasion, CmdDirectorStartInvasion:
		return 6
	case CmdPlayerSupportDefense, CmdPlayerRepairStructure:
		return 7
	case CmdPlayerDefendStrike:
		return 8
	case CmdCompleteObjective:
		return 9
	default:
		return 99
	}
}

func compareCommands(a, b Command) int {
	if pa, pb := commandPriority(a.Kind), commandPriority(b.Kind); pa != pb {
		if pa < pb {
			return -1
		}
		return 1
	}
	if c := strings.Compare(string(a.Kind), string(b.Kind)); c != 0 {
		return c
	}
	if c := strings.Compare(a.PlayerID, b.PlayerID); c != 0 {
		return c
	}
	if c := strings.Compare(a.GroupID, b.GroupID); c != 0 {
		return c
	}
	if c := strings.Compare(a.Archetype, b.Archetype); c != 0 {
		return c
	}
	if c := strings.Compare(a.TargetGroupID, b.TargetGroupID); c != 0 {
		return c
	}
	if c := strings.Compare(a.ObjectiveID, b.ObjectiveID); c != 0 {
		return c
	}
	if c := strings.Compare(a.Source, b.Source); c != 0 {
		return c
	}
	if a.Count != b.Count {
		if a.Count < b.Count {
			return -1
		}
		return 1
	}
	if a.Position != b.Position {
		if a.Position < b.Position {
			return -1
		}
		return 1
	}
	if a.HomePosition != b.HomePosition {
		if a.HomePosition < b.HomePosition {
			return -1
		}
		return 1
	}
	if a.Delta != b.Delta {
		if a.Delta < b.Delta {
			return -1
		}
		return 1
	}
	if c := strings.Compare(string(a.TargetState), string(b.TargetState)); c != 0 {
		return c
	}
	if c := strings.Compare(a.CampaignID, b.CampaignID); c != 0 {
		return c
	}
	if c := strings.Compare(a.InvadingFactionID, b.InvadingFactionID); c != 0 {
		return c
	}
	if c := strings.Compare(a.ReservationID, b.ReservationID); c != 0 {
		return c
	}
	if c := strings.Compare(a.SourcePopulationID, b.SourcePopulationID); c != 0 {
		return c
	}
	if c := strings.Compare(a.SourceCampID, b.SourceCampID); c != 0 {
		return c
	}
	if c := strings.Compare(a.SourceRegionID, b.SourceRegionID); c != 0 {
		return c
	}
	if a.PopulationWeight != b.PopulationWeight {
		if a.PopulationWeight < b.PopulationWeight {
			return -1
		}
		return 1
	}
	if c := strings.Compare(a.ZoneID, b.ZoneID); c != 0 {
		return c
	}
	if c := strings.Compare(a.TargetZoneID, b.TargetZoneID); c != 0 {
		return c
	}
	if c := strings.Compare(a.TargetStructureID, b.TargetStructureID); c != 0 {
		return c
	}
	if a.Wave != nil && b.Wave != nil {
		if c := strings.Compare(a.Wave.WaveID, b.Wave.WaveID); c != 0 {
			return c
		}
	}
	return 0
}

// EventType enumerates domain events produced by the World Director and Creature AI Engine.
type EventType string

const (
	EventThreatChanged             EventType = "ThreatChanged"
	EventCreaturePopulationChanged EventType = "CreaturePopulationChanged"
	EventInvasionPrepared          EventType = "InvasionPrepared"
	EventInvasionStarted           EventType = "InvasionStarted"
	EventInvasionPhaseChanged      EventType = "InvasionPhaseChanged"
	EventSettlementDefended        EventType = "SettlementDefended"
	EventSettlementCaptured        EventType = "SettlementCaptured"
	EventContributionRecorded      EventType = "ContributionRecorded"
	EventTargetAcquired            EventType = "TargetAcquired"
	EventMoraleChanged             EventType = "MoraleChanged"
	EventReinforcementsCalled      EventType = "ReinforcementsCalled"
	EventTerritoryAlert            EventType = "TerritoryAlert"
	EventCommanderFallen           EventType = "CommanderFallen"
	EventGroupRetired              EventType = "GroupRetired"
	EventReinforcementRequested    EventType = "ReinforcementRequested"
	EventSiegePhaseChanged         EventType = "SiegePhaseChanged"
	EventStructureDamaged          EventType = "StructureDamaged"
	EventStructureBreached         EventType = "StructureBreached"
	EventStructureDestroyed        EventType = "StructureDestroyed"
	EventStructureRepaired         EventType = "StructureRepaired"
	EventDistrictStateChanged      EventType = "DistrictStateChanged"
	EventObjectiveUpdated          EventType = "ObjectiveUpdated"
	EventSiegeWaveScheduled        EventType = "SiegeWaveScheduled"
	EventTowerFired                EventType = "TowerFired"
	EventSupplyChanged             EventType = "SupplyChanged"
)

// DomainEvent represents a deterministic, immutable fact emitted during a tick.
// Every event carries a stable EventID for downstream observability and idempotency.
type DomainEvent struct {
	EventID         string                    `json:"event_id"`
	SimulationID    string                    `json:"simulation_id"`
	Tick            uint64                    `json:"tick"`
	Type            EventType                 `json:"type"`
	SourceEntityID  string                    `json:"source_entity_id"`
	StateTransition string                    `json:"state_transition,omitempty"`
	Amount          int64                     `json:"amount,omitempty"`
	Contribution    *ports.ContributionResult `json:"contribution,omitempty"`
}

func safeAddInt64(a, b int64) (int64, error) {
	if b > 0 && a > math.MaxInt64-b {
		return 0, fmt.Errorf("%w: %d + %d exceeds int64 max", ErrNumericOverflow, a, b)
	}
	if b < 0 && a < math.MinInt64-b {
		return 0, fmt.Errorf("%w: %d + %d below int64 min", ErrNumericOverflow, a, b)
	}
	return a + b, nil
}

func safeMulPositiveInt64(a, b int64) (int64, error) {
	if a <= 0 || b <= 0 {
		return 0, fmt.Errorf("%w: expected positive operands (%d, %d)", ErrInvalidCommand, a, b)
	}
	if a > math.MaxInt64/b {
		return 0, fmt.Errorf("%w: %d * %d exceeds int64 max", ErrNumericOverflow, a, b)
	}
	return a * b, nil
}
