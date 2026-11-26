package world

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
	// ConfigVersion versions deterministic simulation tuning parameters.
	ConfigVersion uint32 = 1
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
)

// Config holds versioned, purely integer deterministic simulation rules.
type Config struct {
	Version                    uint32 `json:"version"`
	ThreatThreshold            int64  `json:"threat_threshold"`
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
	PlayerAttackCooldown       int64  `json:"player_attack_cooldown"`
	PlayerStrikeBaseDamage     int64  `json:"player_strike_base_damage"`
	PlayerDamageVariance       int64  `json:"player_damage_variance"`
	PlayerSupportHeal          int64  `json:"player_support_heal"`
	EligibilityMinScore        int64  `json:"eligibility_min_score"`
}

// DefaultConfig returns a balanced deterministic configuration for the Cycle 1 vertical slice.
func DefaultConfig() Config {
	return Config{
		Version:                    ConfigVersion,
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
		HostileRetreatThresholdBP:  1500, // 15.00%
		HostileRetreatExitDistance: 16 * UnitsPerTile,
		PlayerAttackCooldown:       8,
		PlayerStrikeBaseDamage:     85,
		PlayerDamageVariance:       15,
		PlayerSupportHeal:          45,
		EligibilityMinScore:        100,
	}
}

// Validate enforces structural and numeric bounds on simulation configuration.
func (c Config) Validate() error {
	if c.Version != ConfigVersion {
		return fmt.Errorf("%w: unsupported config version %d", ErrInvalidConfig, c.Version)
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

// Valid reports whether the invasion state is recognized.
func (s InvasionState) Valid() bool {
	switch s {
	case InvasionPeace, InvasionThreatened, InvasionUnderAttack, InvasionResolved:
		return true
	default:
		return false
	}
}

// Code returns a stable numeric code for canonical hashing.
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
	State                InvasionState         `json:"state"`
	Outcome              ports.InvasionOutcome `json:"outcome"`
	StartedTick          uint64                `json:"started_tick"`
	ResolvedTick         uint64                `json:"resolved_tick"`
	ObjectivesCompleted  []string              `json:"objectives_completed"`
	ContributionsEmitted bool                  `json:"contributions_emitted"`
}

// CreatureGroup models a hostile warband simulated by the World Director and AI FSM.
type CreatureGroup struct {
	GroupID              string   `json:"group_id"`
	Archetype            string   `json:"archetype"`
	State                ai.State `json:"state"`
	HP                   int64    `json:"hp"`
	MaxHP                int64    `json:"max_hp"`
	DistanceToSettlement int64    `json:"distance_to_settlement"`
	AttackCooldownTicks  int64    `json:"attack_cooldown_ticks"`
	Routed               bool     `json:"routed"`
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

// WorldState is the complete, deterministic, serializable logical state of a world slice.
// All slices are maintained in strict canonical sorted order by stable ID.
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
	Groups                 []CreatureGroup              `json:"groups"`
	PlayerCooldowns        []PlayerCooldown             `json:"player_cooldowns"`
	Contributions          []PlayerContribution         `json:"contributions"`
	EventSeq               uint64                       `json:"event_seq"`
}

// Clone returns a deep copy of WorldState so failed ticks never mutate caller state.
func (s WorldState) Clone() WorldState {
	out := s
	out.Invasion.ObjectivesCompleted = slices.Clone(s.Invasion.ObjectivesCompleted)
	if out.Invasion.ObjectivesCompleted == nil {
		out.Invasion.ObjectivesCompleted = []string{}
	}
	out.Groups = slices.Clone(s.Groups)
	if out.Groups == nil {
		out.Groups = []CreatureGroup{}
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

// Validate verifies all authoritative state invariants.
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

	for i, g := range s.Groups {
		if strings.TrimSpace(g.GroupID) == "" || strings.TrimSpace(g.Archetype) == "" {
			return fmt.Errorf("%w: empty group_id or archetype", ErrInvalidState)
		}
		if i > 0 && s.Groups[i-1].GroupID >= g.GroupID {
			return fmt.Errorf("%w: groups not strictly sorted by group_id", ErrInvalidState)
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
		if g.DistanceToSettlement < 0 || g.AttackCooldownTicks < 0 {
			return fmt.Errorf("%w: group %q has negative distance or cooldown", ErrInvalidState, g.GroupID)
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
	h.WriteUint8(s.Invasion.State.Code())
	h.WriteString(string(s.Invasion.Outcome))
	h.WriteUint64(s.Invasion.StartedTick)
	h.WriteUint64(s.Invasion.ResolvedTick)
	h.WriteBool(s.Invasion.ContributionsEmitted)
	h.WriteUint64(uint64(len(s.Invasion.ObjectivesCompleted)))
	for _, obj := range s.Invasion.ObjectivesCompleted {
		h.WriteString(obj)
	}

	h.WriteUint64(uint64(len(s.Groups)))
	for _, g := range s.Groups {
		h.WriteString(g.GroupID)
		h.WriteString(g.Archetype)
		h.WriteUint8(g.State.Code())
		h.WriteInt64(g.HP)
		h.WriteInt64(g.MaxHP)
		h.WriteInt64(g.DistanceToSettlement)
		h.WriteInt64(g.AttackCooldownTicks)
		h.WriteBool(g.Routed)
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

// UnmarshalSnapshot decodes a versioned snapshot, validates all invariants, and verifies its checksum.
func UnmarshalSnapshot(data []byte) (WorldState, error) {
	return simulation.DecodeSnapshot(data, func(st WorldState) (string, error) {
		return st.Checksum()
	})
}

// CommandKind enumerates untrusted external or scripted intentions processed authoritatively.
type CommandKind string

const (
	CmdIncreaseThreat          CommandKind = "IncreaseThreat"
	CmdSpawnHostileGroup       CommandKind = "SpawnHostileGroup"
	CmdForceInvasionTransition CommandKind = "ForceInvasionTransition"
	CmdPlayerDefendStrike      CommandKind = "PlayerDefendStrike"
	CmdPlayerSupportDefense    CommandKind = "PlayerSupportDefense"
	CmdCompleteObjective       CommandKind = "CompleteObjective"
)

// Command carries an explicit intention targeting a single logical tick.
// Players never specify damage, HP, rewards, or cooldown values in commands.
type Command struct {
	Kind          CommandKind   `json:"kind"`
	Tick          uint64        `json:"tick"`
	PlayerID      string        `json:"player_id,omitempty"`
	TargetGroupID string        `json:"target_group_id,omitempty"`
	GroupID       string        `json:"group_id,omitempty"`
	Archetype     string        `json:"archetype,omitempty"`
	Count         int64         `json:"count,omitempty"`
	Delta         int64         `json:"delta,omitempty"`
	Source        string        `json:"source,omitempty"`
	ObjectiveID   string        `json:"objective_id,omitempty"`
	TargetState   InvasionState `json:"target_state,omitempty"`
}

// EventType enumerates domain events produced by the World Director.
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
