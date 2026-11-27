package siege

import (
	"errors"
	"fmt"
	"math"
	"math/bits"
	"slices"
	"strings"

	"ascendra-game/internal/ai"
	"ascendra-game/internal/ports"
	"ascendra-game/internal/simulation"
)

const (
	// RulesVersion identifies the Cycle 05 deterministic siege rule set.
	RulesVersion uint32 = 1
	// BasisPointsScale represents 100.00% in integer fixed-point math (no floats).
	BasisPointsScale int64 = 10000
)

var (
	ErrInvalidConfig           = errors.New("invalid siege config")
	ErrInvalidLayout           = errors.New("invalid settlement siege layout")
	ErrInvalidState            = errors.New("invalid siege state")
	ErrInvalidCommand          = errors.New("invalid siege command")
	ErrInvalidPhaseTransition  = errors.New("invalid siege phase transition")
	ErrZoneBlocked             = errors.New("zone transition is blocked")
	ErrUnknownEntity           = errors.New("unknown siege entity")
	ErrDeadEntity              = errors.New("siege entity or structure is destroyed")
	ErrCapacityExceeded        = errors.New("siege capacity limit exceeded")
	ErrNumericOverflow         = errors.New("siege integer overflow")
	ErrInsufficientSupplies    = errors.New("insufficient tactical siege supplies")
	ErrRepairLimitReached      = errors.New("structure or entity repair limit reached")
	ErrCooldownActive          = errors.New("siege action cooldown active")
	ErrObjectiveConditionNotMet = errors.New("strategic objective conditions not met")
	ErrDuplicateObjective      = errors.New("strategic objective already completed")
)

// SiegePhase models the explicit finite state machine of an active settlement siege.
// It is strictly subordinate to world.InvasionState (UnderAttack -> Resolved) so there
// is always a single tactical authority.
type SiegePhase string

const (
	PhaseApproach       SiegePhase = "Approach"
	PhaseAssault        SiegePhase = "Assault"
	PhaseBreach         SiegePhase = "Breach"
	PhaseDistrictCombat SiegePhase = "DistrictCombat"
	PhaseCitadelAssault SiegePhase = "CitadelAssault"
	PhaseResolving      SiegePhase = "Resolving"
	PhaseDefended       SiegePhase = "Defended"
	PhaseCaptured       SiegePhase = "Captured"
	PhaseWithdrawn      SiegePhase = "Withdrawn"
)

func (p SiegePhase) Valid() bool {
	switch p {
	case PhaseApproach, PhaseAssault, PhaseBreach, PhaseDistrictCombat,
		PhaseCitadelAssault, PhaseResolving, PhaseDefended, PhaseCaptured, PhaseWithdrawn:
		return true
	default:
		return false
	}
}

func (p SiegePhase) Code() uint8 {
	switch p {
	case PhaseApproach:
		return 1
	case PhaseAssault:
		return 2
	case PhaseBreach:
		return 3
	case PhaseDistrictCombat:
		return 4
	case PhaseCitadelAssault:
		return 5
	case PhaseResolving:
		return 6
	case PhaseDefended:
		return 7
	case PhaseCaptured:
		return 8
	case PhaseWithdrawn:
		return 9
	default:
		return 0
	}
}

// IsTerminal reports whether the siege has concluded with an immutable outcome.
func (p SiegePhase) IsTerminal() bool {
	return p == PhaseDefended || p == PhaseCaptured || p == PhaseWithdrawn
}

// ToInvasionOutcome maps a terminal siege phase into the shared CARBON-compatible
// ports.InvasionOutcome without inventing an incompatible third contract enum.
// Tactical withdrawals map to InvasionOutcomeDefended while preserving PhaseWithdrawn internally.
func (p SiegePhase) ToInvasionOutcome() ports.InvasionOutcome {
	switch p {
	case PhaseCaptured:
		return ports.InvasionOutcomeCaptured
	case PhaseDefended, PhaseWithdrawn:
		return ports.InvasionOutcomeDefended
	default:
		return ports.InvasionOutcomeNone
	}
}

// ZoneKind classifies topological zones inside a fortified settlement graph.
type ZoneKind string

const (
	ZoneExteriorField  ZoneKind = "ExteriorField"
	ZoneWallApproach   ZoneKind = "WallApproach"
	ZoneMainGate       ZoneKind = "MainGate"
	ZoneOuterDistrict  ZoneKind = "OuterDistrict"
	ZoneSupplyDistrict ZoneKind = "SupplyDistrict"
	ZoneCivilDistrict  ZoneKind = "CivilDistrict"
	ZoneCentralSquare  ZoneKind = "CentralSquare"
	ZoneCitadel        ZoneKind = "Citadel"
)

func (k ZoneKind) Valid() bool {
	switch k {
	case ZoneExteriorField, ZoneWallApproach, ZoneMainGate, ZoneOuterDistrict,
		ZoneSupplyDistrict, ZoneCivilDistrict, ZoneCentralSquare, ZoneCitadel:
		return true
	default:
		return false
	}
}

func (k ZoneKind) Code() uint8 {
	switch k {
	case ZoneExteriorField:
		return 1
	case ZoneWallApproach:
		return 2
	case ZoneMainGate:
		return 3
	case ZoneOuterDistrict:
		return 4
	case ZoneSupplyDistrict:
		return 5
	case ZoneCivilDistrict:
		return 6
	case ZoneCentralSquare:
		return 7
	case ZoneCitadel:
		return 8
	default:
		return 0
	}
}

// ConnectionRule specifies authoritative traversal rules along a zone graph edge.
type ConnectionRule string

const (
	ConnAlwaysOpen                   ConnectionRule = "AlwaysOpen"
	ConnRequiresStructureCompromised ConnectionRule = "RequiresStructureCompromised"
	ConnDefenderOnly                 ConnectionRule = "DefenderOnly"
)

func (r ConnectionRule) Valid() bool {
	return r == ConnAlwaysOpen || r == ConnRequiresStructureCompromised || r == ConnDefenderOnly
}

func (r ConnectionRule) Code() uint8 {
	switch r {
	case ConnAlwaysOpen:
		return 1
	case ConnRequiresStructureCompromised:
		return 2
	case ConnDefenderOnly:
		return 3
	default:
		return 0
	}
}

// DistrictState models territorial control inside a capturable settlement zone.
type DistrictState string

const (
	DistrictDefenderControlled DistrictState = "DefenderControlled"
	DistrictContested          DistrictState = "Contested"
	DistrictInvaderControlled  DistrictState = "InvaderControlled"
	DistrictNeutralized        DistrictState = "Neutralized"
)

func (d DistrictState) Valid() bool {
	switch d {
	case DistrictDefenderControlled, DistrictContested, DistrictInvaderControlled, DistrictNeutralized:
		return true
	default:
		return false
	}
}

func (d DistrictState) Code() uint8 {
	switch d {
	case DistrictDefenderControlled:
		return 1
	case DistrictContested:
		return 2
	case DistrictInvaderControlled:
		return 3
	case DistrictNeutralized:
		return 4
	default:
		return 0
	}
}

// StructureKind enumerates active defensive structures with distinct gameplay behavior.
type StructureKind string

const (
	StructureGate        StructureKind = "Gate"
	StructureWall        StructureKind = "Wall"
	StructureTower       StructureKind = "Tower"
	StructureSupplyDepot StructureKind = "SupplyDepot"
	StructureCitadel     StructureKind = "Citadel"
)

func (k StructureKind) Valid() bool {
	switch k {
	case StructureGate, StructureWall, StructureTower, StructureSupplyDepot, StructureCitadel:
		return true
	default:
		return false
	}
}

func (k StructureKind) Code() uint8 {
	switch k {
	case StructureGate:
		return 1
	case StructureWall:
		return 2
	case StructureTower:
		return 3
	case StructureSupplyDepot:
		return 4
	case StructureCitadel:
		return 5
	default:
		return 0
	}
}

// StructureState tracks structural integrity and breach status.
type StructureState string

const (
	StructureIntact    StructureState = "Intact"
	StructureDamaged   StructureState = "Damaged"
	StructureBreached  StructureState = "Breached"
	StructureDestroyed StructureState = "Destroyed"
)

func (s StructureState) Valid() bool {
	return s == StructureIntact || s == StructureDamaged || s == StructureBreached || s == StructureDestroyed
}

func (s StructureState) Code() uint8 {
	switch s {
	case StructureIntact:
		return 1
	case StructureDamaged:
		return 2
	case StructureBreached:
		return 3
	case StructureDestroyed:
		return 4
	default:
		return 0
	}
}

// IsCompromised reports whether a blocking fortification allows hostile passage through.
func (s StructureState) IsCompromised() bool {
	return s == StructureBreached || s == StructureDestroyed
}

// ObjectiveSide classifies whether a strategic objective belongs to defenders or invaders.
type ObjectiveSide string

const (
	SideDefense  ObjectiveSide = "Defense"
	SideInvasion ObjectiveSide = "Invasion"
)

func (s ObjectiveSide) Valid() bool {
	return s == SideDefense || s == SideInvasion
}

func (s ObjectiveSide) Code() uint8 {
	switch s {
	case SideDefense:
		return 1
	case SideInvasion:
		return 2
	default:
		return 0
	}
}

// ObjectiveKind defines authoritative strategic siege objectives.
type ObjectiveKind string

const (
	ObjDefendGate          ObjectiveKind = "DefendGate"
	ObjRepairFortification ObjectiveKind = "RepairFortification"
	ObjProtectSupplies     ObjectiveKind = "ProtectSupplies"
	ObjHoldDistrict        ObjectiveKind = "HoldDistrict"
	ObjDefeatCommander     ObjectiveKind = "DefeatCommander"

	ObjDestroyGate     ObjectiveKind = "DestroyGate"
	ObjOpenBreach      ObjectiveKind = "OpenBreach"
	ObjCaptureDistrict ObjectiveKind = "CaptureDistrict"
	ObjDisruptSupplies ObjectiveKind = "DisruptSupplies"
	ObjAssaultCitadel  ObjectiveKind = "AssaultCitadel"
)

func (k ObjectiveKind) Valid() bool {
	switch k {
	case ObjDefendGate, ObjRepairFortification, ObjProtectSupplies, ObjHoldDistrict, ObjDefeatCommander,
		ObjDestroyGate, ObjOpenBreach, ObjCaptureDistrict, ObjDisruptSupplies, ObjAssaultCitadel:
		return true
	default:
		return false
	}
}

func (k ObjectiveKind) Code() uint8 {
	switch k {
	case ObjDefendGate:
		return 1
	case ObjRepairFortification:
		return 2
	case ObjProtectSupplies:
		return 3
	case ObjHoldDistrict:
		return 4
	case ObjDefeatCommander:
		return 5
	case ObjDestroyGate:
		return 6
	case ObjOpenBreach:
		return 7
	case ObjCaptureDistrict:
		return 8
	case ObjDisruptSupplies:
		return 9
	case ObjAssaultCitadel:
		return 10
	default:
		return 0
	}
}

// ObjectiveState tracks lifecycle progression of a strategic objective.
type ObjectiveState string

const (
	ObjLocked    ObjectiveState = "Locked"
	ObjActive    ObjectiveState = "Active"
	ObjCompleted ObjectiveState = "Completed"
	ObjFailed    ObjectiveState = "Failed"
)

func (s ObjectiveState) Valid() bool {
	return s == ObjLocked || s == ObjActive || s == ObjCompleted || s == ObjFailed
}

func (s ObjectiveState) Code() uint8 {
	switch s {
	case ObjLocked:
		return 1
	case ObjActive:
		return 2
	case ObjCompleted:
		return 3
	case ObjFailed:
		return 4
	default:
		return 0
	}
}

// WaveState models lifecycle state of a scheduled population-backed siege wave.
type WaveState string

const (
	WaveScheduled WaveState = "Scheduled"
	WaveMobilized WaveState = "Mobilized"
	WaveCancelled WaveState = "Cancelled"
	WaveExhausted WaveState = "Exhausted"
)

func (s WaveState) Valid() bool {
	return s == WaveScheduled || s == WaveMobilized || s == WaveCancelled || s == WaveExhausted
}

func (s WaveState) Code() uint8 {
	switch s {
	case WaveScheduled:
		return 1
	case WaveMobilized:
		return 2
	case WaveCancelled:
		return 3
	case WaveExhausted:
		return 4
	default:
		return 0
	}
}

// DefenderRole differentiates players and representative NPC garrison units.
type DefenderRole string

const (
	RolePlayer       DefenderRole = ""
	RoleGuard        DefenderRole = "Guard"
	RoleGateDefender DefenderRole = "GateDefender"
	RoleArcher       DefenderRole = "Archer"
	RoleGuardCaptain DefenderRole = "GuardCaptain"
	RoleRepairUnit   DefenderRole = "RepairUnit"
)

func (r DefenderRole) Valid() bool {
	switch r {
	case RolePlayer, RoleGuard, RoleGateDefender, RoleArcher, RoleGuardCaptain, RoleRepairUnit:
		return true
	default:
		return false
	}
}

func (r DefenderRole) Code() uint8 {
	switch r {
	case RolePlayer:
		return 1
	case RoleGuard:
		return 2
	case RoleGateDefender:
		return 3
	case RoleArcher:
		return 4
	case RoleGuardCaptain:
		return 5
	case RoleRepairUnit:
		return 6
	default:
		return 0
	}
}

// IsNPC reports whether the defender role represents a simulated NPC defender.
func (r DefenderRole) IsNPC() bool {
	return r != RolePlayer
}

// Config configures deterministic siege limits, repair economy, capture hysteresis,
// tower combat, withdrawal thresholds, and anti-stall policy.
type Config struct {
	RulesVersion                          uint32 `json:"rules_version"`
	MaxZones                              int    `json:"max_zones"`
	MaxConnections                        int    `json:"max_connections"`
	MaxStructures                         int    `json:"max_structures"`
	MaxObjectives                         int    `json:"max_objectives"`
	MaxWaves                              int    `json:"max_waves"`
	MaxCommanders                         int    `json:"max_commanders"`
	MaxNPCDefenders                       int    `json:"max_npc_defenders"`
	MaxIdentifierLength                   int    `json:"max_identifier_length"`
	MaxSupplies                           int64  `json:"max_supplies"`
	RepairSupplyCost                      int64  `json:"repair_supply_cost"`
	RepairBaseAmount                      int64  `json:"repair_base_amount"`
	RepairCooldownTicks                   uint64 `json:"repair_cooldown_ticks"`
	MaxRepairsPerStructure                int    `json:"max_repairs_per_structure"`
	MaxRepairsPerEntity                   int    `json:"max_repairs_per_entity"`
	AllowDestroyedStructureRepairInBattle bool   `json:"allow_destroyed_structure_repair_in_battle"`
	DistrictCaptureThreshold              int64  `json:"district_capture_threshold"`
	DistrictControlStep                   int64  `json:"district_control_step"`
	DistrictHysteresisTicks               uint64 `json:"district_hysteresis_ticks"`
	CitadelCaptureThreshold               int64  `json:"citadel_capture_threshold"`
	NoProgressTimeoutTicks                uint64 `json:"no_progress_timeout_ticks"`
	SiegeMaxDurationTicks                 uint64 `json:"siege_max_duration_ticks"`
	PhaseTimeLimitTicks                   uint64 `json:"phase_time_limit_ticks"`
	GoblinWithdrawMoraleBP                int64  `json:"goblin_withdraw_morale_bp"`
	OrcWithdrawMoraleBP                   int64  `json:"orc_withdraw_morale_bp"`
	CommanderFallenMoraleShockGoblinBP    int64  `json:"commander_fallen_morale_shock_goblin_bp"`
	CommanderFallenMoraleShockOrcBP       int64  `json:"commander_fallen_morale_shock_orc_bp"`
	TowerFireDamage                       int64  `json:"tower_fire_damage"`
	TowerFireCooldownTicks                uint64 `json:"tower_fire_cooldown_ticks"`
	SupplyDepotRepairBonusBP              int64  `json:"supply_depot_repair_bonus_bp"`
	SupplyDepotRegenPerInterval           int64  `json:"supply_depot_regen_per_interval"`
	SupplyRegenIntervalTicks              uint64 `json:"supply_regen_interval_ticks"`
	MaxSupplyRegenTotal                   int64  `json:"max_supply_regen_total"`
	SupplyDepotDestroyPenalty             int64  `json:"supply_depot_destroy_penalty"`
}

// DefaultConfig returns balanced, provisional, bounded Cycle 05 siege defaults.
func DefaultConfig() Config {
	return Config{
		RulesVersion:                          RulesVersion,
		MaxZones:                              16,
		MaxConnections:                        32,
		MaxStructures:                         16,
		MaxObjectives:                         16,
		MaxWaves:                              8,
		MaxCommanders:                         4,
		MaxNPCDefenders:                       16,
		MaxIdentifierLength:                   128,
		MaxSupplies:                           500,
		RepairSupplyCost:                      25,
		RepairBaseAmount:                      45,
		RepairCooldownTicks:                   12,
		MaxRepairsPerStructure:                6,
		MaxRepairsPerEntity:                   4,
		AllowDestroyedStructureRepairInBattle: false,
		DistrictCaptureThreshold:              100,
		DistrictControlStep:                   20,
		DistrictHysteresisTicks:               3,
		CitadelCaptureThreshold:               120,
		NoProgressTimeoutTicks:                160,
		SiegeMaxDurationTicks:                 480,
		PhaseTimeLimitTicks:                   160,
		GoblinWithdrawMoraleBP:                2800,
		OrcWithdrawMoraleBP:                   1400,
		CommanderFallenMoraleShockGoblinBP:    1600,
		CommanderFallenMoraleShockOrcBP:       1100,
		TowerFireDamage:                       40,
		TowerFireCooldownTicks:                10,
		SupplyDepotRepairBonusBP:              2500,
		SupplyDepotRegenPerInterval:           10,
		SupplyRegenIntervalTicks:              20,
		MaxSupplyRegenTotal:                   100,
		SupplyDepotDestroyPenalty:             40,
	}
}

// Validate enforces all operational bounds and numeric invariants upfront.
func (c Config) Validate() error {
	if c.RulesVersion != RulesVersion {
		return fmt.Errorf("%w: unsupported rules_version %d", ErrInvalidConfig, c.RulesVersion)
	}
	if c.MaxZones < 2 || c.MaxConnections < 1 || c.MaxStructures < 2 || c.MaxObjectives < 1 ||
		c.MaxWaves < 0 || c.MaxCommanders < 1 || c.MaxNPCDefenders < 0 || c.MaxIdentifierLength < 16 {
		return fmt.Errorf("%w: invalid structural capacity limits", ErrInvalidConfig)
	}
	if c.MaxSupplies <= 0 || c.RepairSupplyCost <= 0 || c.RepairBaseAmount <= 0 ||
		c.MaxRepairsPerStructure < 0 || c.MaxRepairsPerEntity < 0 || c.MaxSupplyRegenTotal < 0 ||
		c.SupplyDepotRegenPerInterval < 0 || c.SupplyDepotDestroyPenalty < 0 ||
		c.SupplyDepotRepairBonusBP < 0 || c.SupplyDepotRepairBonusBP > BasisPointsScale {
		return fmt.Errorf("%w: invalid supply or repair bounds", ErrInvalidConfig)
	}
	if c.SupplyDepotRegenPerInterval > 0 && c.SupplyRegenIntervalTicks == 0 {
		return fmt.Errorf("%w: supply_regen_interval_ticks must be > 0 when regen > 0", ErrInvalidConfig)
	}
	if c.DistrictCaptureThreshold <= 0 || c.DistrictControlStep <= 0 || c.CitadelCaptureThreshold <= 0 {
		return fmt.Errorf("%w: capture thresholds and step must be > 0", ErrInvalidConfig)
	}
	if c.NoProgressTimeoutTicks == 0 || c.SiegeMaxDurationTicks == 0 || c.PhaseTimeLimitTicks == 0 {
		return fmt.Errorf("%w: siege time limits must be > 0", ErrInvalidConfig)
	}
	if c.GoblinWithdrawMoraleBP < 0 || c.GoblinWithdrawMoraleBP > BasisPointsScale ||
		c.OrcWithdrawMoraleBP < 0 || c.OrcWithdrawMoraleBP > BasisPointsScale ||
		c.CommanderFallenMoraleShockGoblinBP < 0 || c.CommanderFallenMoraleShockGoblinBP > BasisPointsScale ||
		c.CommanderFallenMoraleShockOrcBP < 0 || c.CommanderFallenMoraleShockOrcBP > BasisPointsScale {
		return fmt.Errorf("%w: morale thresholds out of [0, %d]", ErrInvalidConfig, BasisPointsScale)
	}
	if c.TowerFireDamage < 0 {
		return fmt.Errorf("%w: negative tower_fire_damage", ErrInvalidConfig)
	}
	if c.TowerFireDamage > 0 && c.TowerFireCooldownTicks == 0 {
		return fmt.Errorf("%w: tower_fire_cooldown_ticks must be > 0 when tower damage > 0", ErrInvalidConfig)
	}
	return nil
}

// Zone models a node in the deterministic settlement zone graph.
// PositionHint anchors scalar distance for compatibility with 1D perception while remaining
// extensible to future 2D coordinates.
type Zone struct {
	ZoneID               string        `json:"zone_id"`
	Kind                 ZoneKind      `json:"kind"`
	Name                 string        `json:"name"`
	Depth                int           `json:"depth"`
	PositionHint         int64         `json:"position_hint"`
	Capturable           bool          `json:"capturable"`
	ControlState         DistrictState `json:"control_state"`
	ControlProgress      int64         `json:"control_progress"`
	ControllingFactionID string        `json:"controlling_faction_id,omitempty"`
	LastControlTick      uint64        `json:"last_control_tick,omitempty"`
}

// ZoneConnection models an explicit edge between two settlement zones with accessibility rules.
type ZoneConnection struct {
	ConnectionID       string         `json:"connection_id"`
	FromZoneID         string         `json:"from_zone_id"`
	ToZoneID           string         `json:"to_zone_id"`
	Bidirectional      bool           `json:"bidirectional"`
	Rule               ConnectionRule `json:"rule"`
	BlockerStructureID string         `json:"blocker_structure_id,omitempty"`
}

// Structure models a real defensive fortification or strategic installation inside a zone.
type Structure struct {
	StructureID       string         `json:"structure_id"`
	Kind              StructureKind  `json:"kind"`
	ZoneID            string         `json:"zone_id"`
	HP                int64          `json:"hp"`
	MaxHP             int64          `json:"max_hp"`
	ResistanceBP      int64          `json:"resistance_bp"`
	ArmorFlat         int64          `json:"armor_flat"`
	BreachThresholdBP int64          `json:"breach_threshold_bp"`
	State             StructureState `json:"state"`
	AttackRangeZones  int            `json:"attack_range_zones,omitempty"`
	FireCooldownTicks uint64         `json:"fire_cooldown_ticks,omitempty"`
	RepairsApplied    int            `json:"repairs_applied,omitempty"`
	DestroyedTick     uint64         `json:"destroyed_tick,omitempty"`
}

// Objective tracks an authoritative defense or invasion strategic goal.
type Objective struct {
	ObjectiveID       string         `json:"objective_id"`
	Side              ObjectiveSide  `json:"side"`
	Kind              ObjectiveKind  `json:"kind"`
	ZoneID            string         `json:"zone_id"`
	TargetStructureID string         `json:"target_structure_id,omitempty"`
	PrerequisiteIDs   []string       `json:"prerequisite_ids,omitempty"`
	State             ObjectiveState `json:"state"`
	Progress          int64          `json:"progress"`
	TargetProgress    int64          `json:"target_progress"`
	CompletedTick     uint64         `json:"completed_tick,omitempty"`
	CompletedByID     string         `json:"completed_by_id,omitempty"`
}

// CommanderState models a tactical siege leader linked 1-to-1 with a real CreatureGroup
// materialized from an ecological PopulationReservation.
type CommanderState struct {
	CommanderID         string    `json:"commander_id"`
	DisplayName         string    `json:"display_name"`
	GroupID             string    `json:"group_id,omitempty"`
	Family              ai.Family `json:"family"`
	Archetype           string    `json:"archetype"`
	MoraleAuraBonusBP   int64     `json:"morale_aura_bonus_bp"`
	SiegeDamageBonusBP  int64     `json:"siege_damage_bonus_bp"`
	PriorityObjectiveID string    `json:"priority_objective_id,omitempty"`
	Alive               bool      `json:"alive"`
	Deployed            bool      `json:"deployed"`
	DefeatedTick        uint64    `json:"defeated_tick,omitempty"`
	DefeatedByPlayerID  string    `json:"defeated_by_player_id,omitempty"`
	FallenShockApplied  bool      `json:"fallen_shock_applied,omitempty"`
}

// SiegeWave tracks a scheduled population-backed reinforcement wave during a siege.
type SiegeWave struct {
	WaveID         string    `json:"wave_id"`
	CampaignID     string    `json:"campaign_id"`
	ReservationID  string    `json:"reservation_id"`
	Archetype      string    `json:"archetype"`
	Count          int64     `json:"count"`
	ScheduledTick  uint64    `json:"scheduled_tick"`
	EntryZoneID    string    `json:"entry_zone_id"`
	LeaderID       string    `json:"leader_id,omitempty"`
	State          WaveState `json:"state"`
	SpawnedGroupID string    `json:"spawned_group_id,omitempty"`
}

// SiegeSupplies tracks temporary tactical battle resources (NOT persistent currency/inventory).
type SiegeSupplies struct {
	Current          int64  `json:"current"`
	Max              int64  `json:"max"`
	TotalSpent       int64  `json:"total_spent"`
	TotalRegenerated int64  `json:"total_regenerated"`
	MaxTotalRegen    int64  `json:"max_total_regen"`
	LastRegenTick    uint64 `json:"last_regen_tick,omitempty"`
}

// EntityRepairCount tracks per-entity repair count canonically sorted by EntityID.
type EntityRepairCount struct {
	EntityID       string `json:"entity_id"`
	Count          int    `json:"count"`
	NextRepairTick uint64 `json:"next_repair_tick,omitempty"`
}

// NPCDefenderSpec defines an initial garrison defender spawned when a siege starts.
type NPCDefenderSpec struct {
	DefenderID string       `json:"defender_id"`
	Role       DefenderRole `json:"role"`
	ZoneID     string       `json:"zone_id"`
	MaxHP      int64        `json:"max_hp"`
}

// SettlementLayout is a data-driven fortified settlement blueprint (provisional local fixture
// until CARBON supplies authoritative settlement geometry/structures).
type SettlementLayout struct {
	LayoutID        string            `json:"layout_id"`
	SettlementID    string            `json:"settlement_id"`
	RegionID        string            `json:"region_id"`
	RulesVersion    uint32            `json:"rules_version"`
	Zones           []Zone            `json:"zones"`
	Connections     []ZoneConnection  `json:"connections"`
	Structures      []Structure       `json:"structures"`
	Objectives      []Objective       `json:"objectives"`
	InitialSupplies int64             `json:"initial_supplies"`
	DefenderRoster  []NPCDefenderSpec `json:"defender_roster"`
}

// OccupationRecord preserves post-capture tactical aftermath for future reconquest campaigns
// without directly mutating CARBON persistent tables.
type OccupationRecord struct {
	SettlementID        string   `json:"settlement_id"`
	RegionID            string   `json:"region_id"`
	OccupyingFactionID  string   `json:"occupying_faction_id"`
	CapturedCampaignID  string   `json:"captured_campaign_id"`
	CapturedInvasionID  string   `json:"captured_invasion_id"`
	CapturedTick        uint64   `json:"captured_tick"`
	StructuresDestroyed []string `json:"structures_destroyed,omitempty"`
	DistrictsCaptured   []string `json:"districts_captured,omitempty"`
	ReconquestPlanned   bool     `json:"reconquest_planned,omitempty"`
}

// SiegeState holds the complete, deterministic, serializable runtime state of an active or
// resolved settlement siege embedded inside world.WorldState.
type SiegeState struct {
	LayoutID          string              `json:"layout_id"`
	SettlementID      string              `json:"settlement_id"`
	RegionID          string              `json:"region_id"`
	RulesVersion      uint32              `json:"rules_version"`
	CampaignID        string              `json:"campaign_id,omitempty"`
	InvadingFactionID string              `json:"invading_faction_id,omitempty"`
	InvadingFamily    ai.Family           `json:"invading_family,omitempty"`
	IsReconquest      bool                `json:"is_reconquest,omitempty"`
	Phase             SiegePhase          `json:"phase"`
	StartedTick       uint64              `json:"started_tick"`
	PhaseStartedTick  uint64              `json:"phase_started_tick"`
	LastProgressTick  uint64              `json:"last_progress_tick"`
	CompletedTick     uint64              `json:"completed_tick,omitempty"`
	TerminalReason    string              `json:"terminal_reason,omitempty"`
	Zones             []Zone              `json:"zones"`
	Connections       []ZoneConnection    `json:"connections"`
	Structures        []Structure         `json:"structures"`
	Objectives        []Objective         `json:"objectives"`
	Commanders        []CommanderState    `json:"commanders"`
	Waves             []SiegeWave         `json:"waves"`
	Supplies          SiegeSupplies       `json:"supplies"`
	EntityRepairs     []EntityRepairCount `json:"entity_repairs"`
	InvaderCasualties int64               `json:"invader_casualties"`
	DefenderCasualties int64              `json:"defender_casualties"`
	Config            Config              `json:"config"`
}

// Clone returns a deep copy of SiegeState so failed ticks never mutate caller state.
func (s *SiegeState) Clone() *SiegeState {
	if s == nil {
		return nil
	}
	out := *s
	out.Zones = slices.Clone(s.Zones)
	if out.Zones == nil {
		out.Zones = []Zone{}
	}
	out.Connections = slices.Clone(s.Connections)
	if out.Connections == nil {
		out.Connections = []ZoneConnection{}
	}
	out.Structures = slices.Clone(s.Structures)
	if out.Structures == nil {
		out.Structures = []Structure{}
	}
	out.Objectives = make([]Objective, len(s.Objectives))
	for i, obj := range s.Objectives {
		objCopy := obj
		objCopy.PrerequisiteIDs = slices.Clone(obj.PrerequisiteIDs)
		out.Objectives[i] = objCopy
	}
	out.Commanders = slices.Clone(s.Commanders)
	if out.Commanders == nil {
		out.Commanders = []CommanderState{}
	}
	out.Waves = slices.Clone(s.Waves)
	if out.Waves == nil {
		out.Waves = []SiegeWave{}
	}
	out.EntityRepairs = slices.Clone(s.EntityRepairs)
	if out.EntityRepairs == nil {
		out.EntityRepairs = []EntityRepairCount{}
	}
	return &out
}

// TotalStructureHP computes the single authoritative structural defense HP projection.
func (s SiegeState) TotalStructureHP() int64 {
	var total int64
	for _, st := range s.Structures {
		total += st.HP
	}
	return total
}

// TotalStructureMaxHP computes the maximum structural defense HP projection.
func (s SiegeState) TotalStructureMaxHP() int64 {
	var total int64
	for _, st := range s.Structures {
		total += st.MaxHP
	}
	return total
}

// StructuresDestroyedIDs returns sorted IDs of all destroyed structures.
func (s SiegeState) StructuresDestroyedIDs() []string {
	out := make([]string, 0)
	for _, st := range s.Structures {
		if st.HP == 0 || st.State == StructureDestroyed {
			out = append(out, st.StructureID)
		}
	}
	return out
}

// DistrictsCapturedIDs returns sorted IDs of all invader-controlled capturable zones.
func (s SiegeState) DistrictsCapturedIDs() []string {
	out := make([]string, 0)
	for _, z := range s.Zones {
		if z.Capturable && z.ControlState == DistrictInvaderControlled {
			out = append(out, z.ZoneID)
		}
	}
	return out
}

// HasOuterBreach reports whether any Gate or Wall has been breached or destroyed.
func (s SiegeState) HasOuterBreach() bool {
	for _, st := range s.Structures {
		if (st.Kind == StructureGate || st.Kind == StructureWall) && st.State.IsCompromised() {
			return true
		}
	}
	return false
}

// HasOperationalSupplyDepot reports whether at least one SupplyDepot has HP > 0.
func (s SiegeState) HasOperationalSupplyDepot() bool {
	for _, st := range s.Structures {
		if st.Kind == StructureSupplyDepot && st.HP > 0 && st.State != StructureDestroyed {
			return true
		}
	}
	return false
}

// Validate verifies structural, topological, referential, and capacity invariants of SiegeState.
func (s SiegeState) Validate() error {
	return s.ValidateWithConfig(s.Config)
}

// ValidateWithConfig verifies all siege invariants against an explicit Config.
func (s SiegeState) ValidateWithConfig(cfg Config) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	maxID := cfg.MaxIdentifierLength
	if err := validateID(s.LayoutID, maxID); err != nil {
		return fmt.Errorf("%w: layout_id: %v", ErrInvalidState, err)
	}
	if err := validateID(s.SettlementID, maxID); err != nil {
		return fmt.Errorf("%w: settlement_id: %v", ErrInvalidState, err)
	}
	if err := validateID(s.RegionID, maxID); err != nil {
		return fmt.Errorf("%w: region_id: %v", ErrInvalidState, err)
	}
	if s.RulesVersion != cfg.RulesVersion {
		return fmt.Errorf("%w: rules_version %d != %d", ErrInvalidState, s.RulesVersion, cfg.RulesVersion)
	}
	if len(s.CampaignID) > maxID || len(s.InvadingFactionID) > maxID || len(s.TerminalReason) > maxID {
		return fmt.Errorf("%w: siege identifier exceeds max length %d", ErrInvalidState, maxID)
	}
	if s.InvadingFamily != "" && !s.InvadingFamily.Valid() {
		return fmt.Errorf("%w: invalid invading_family %q", ErrInvalidState, s.InvadingFamily)
	}
	if !s.Phase.Valid() {
		return fmt.Errorf("%w: invalid phase %q", ErrInvalidState, s.Phase)
	}
	if s.PhaseStartedTick < s.StartedTick {
		return fmt.Errorf("%w: phase_started_tick %d < started_tick %d", ErrInvalidState, s.PhaseStartedTick, s.StartedTick)
	}
	if s.CompletedTick > 0 && !s.Phase.IsTerminal() {
		return fmt.Errorf("%w: non-terminal phase %q cannot have completed_tick %d", ErrInvalidState, s.Phase, s.CompletedTick)
	}
	if s.InvaderCasualties < 0 || s.DefenderCasualties < 0 {
		return fmt.Errorf("%w: negative casualties", ErrInvalidState)
	}

	if len(s.Zones) == 0 || len(s.Zones) > cfg.MaxZones {
		return fmt.Errorf("%w: zones count %d out of [1, %d]", ErrCapacityExceeded, len(s.Zones), cfg.MaxZones)
	}
	if len(s.Connections) == 0 || len(s.Connections) > cfg.MaxConnections {
		return fmt.Errorf("%w: connections count %d out of [1, %d]", ErrCapacityExceeded, len(s.Connections), cfg.MaxConnections)
	}
	if len(s.Structures) == 0 || len(s.Structures) > cfg.MaxStructures {
		return fmt.Errorf("%w: structures count %d out of [1, %d]", ErrCapacityExceeded, len(s.Structures), cfg.MaxStructures)
	}
	if len(s.Objectives) > cfg.MaxObjectives {
		return fmt.Errorf("%w: objectives count %d exceeds %d", ErrCapacityExceeded, len(s.Objectives), cfg.MaxObjectives)
	}
	if len(s.Commanders) > cfg.MaxCommanders {
		return fmt.Errorf("%w: commanders count %d exceeds %d", ErrCapacityExceeded, len(s.Commanders), cfg.MaxCommanders)
	}
	if len(s.Waves) > cfg.MaxWaves {
		return fmt.Errorf("%w: waves count %d exceeds %d", ErrCapacityExceeded, len(s.Waves), cfg.MaxWaves)
	}

	// Validate supplies.
	if s.Supplies.Max <= 0 || s.Supplies.Max > cfg.MaxSupplies ||
		s.Supplies.Current < 0 || s.Supplies.Current > s.Supplies.Max ||
		s.Supplies.TotalSpent < 0 || s.Supplies.TotalRegenerated < 0 ||
		s.Supplies.MaxTotalRegen < 0 || s.Supplies.TotalRegenerated > s.Supplies.MaxTotalRegen {
		return fmt.Errorf("%w: invalid siege supplies %+v", ErrInvalidState, s.Supplies)
	}

	// Validate zones (strictly sorted by ZoneID).
	zoneByID := make(map[string]Zone, len(s.Zones))
	hasExterior := false
	hasCitadelZone := false
	for i, z := range s.Zones {
		if err := validateID(z.ZoneID, maxID); err != nil {
			return fmt.Errorf("%w: zone_id: %v", ErrInvalidState, err)
		}
		if i > 0 && s.Zones[i-1].ZoneID >= z.ZoneID {
			return fmt.Errorf("%w: zones not strictly sorted by zone_id", ErrInvalidState)
		}
		if !z.Kind.Valid() || !z.ControlState.Valid() {
			return fmt.Errorf("%w: zone %q has invalid kind or control_state", ErrInvalidState, z.ZoneID)
		}
		if z.Depth < 0 || z.PositionHint < 0 {
			return fmt.Errorf("%w: zone %q has negative depth or position_hint", ErrInvalidState, z.ZoneID)
		}
		maxProg := cfg.DistrictCaptureThreshold
		if z.Kind == ZoneCitadel {
			maxProg = cfg.CitadelCaptureThreshold
			hasCitadelZone = true
		}
		if z.Kind == ZoneExteriorField {
			hasExterior = true
		}
		if z.ControlProgress < 0 || z.ControlProgress > maxProg {
			return fmt.Errorf("%w: zone %q control_progress %d out of [0, %d]", ErrInvalidState, z.ZoneID, z.ControlProgress, maxProg)
		}
		if len(z.ControllingFactionID) > maxID {
			return fmt.Errorf("%w: zone %q controlling_faction_id too long", ErrInvalidState, z.ZoneID)
		}
		zoneByID[z.ZoneID] = z
	}
	if !hasExterior || !hasCitadelZone {
		return fmt.Errorf("%w: siege layout requires both ExteriorField and Citadel zones", ErrInvalidLayout)
	}

	// Validate structures (strictly sorted by StructureID).
	structByID := make(map[string]Structure, len(s.Structures))
	hasCitadelStruct := false
	var totalMaxHP int64
	for i, st := range s.Structures {
		if err := validateID(st.StructureID, maxID); err != nil {
			return fmt.Errorf("%w: structure_id: %v", ErrInvalidState, err)
		}
		if i > 0 && s.Structures[i-1].StructureID >= st.StructureID {
			return fmt.Errorf("%w: structures not strictly sorted by structure_id", ErrInvalidState)
		}
		if !st.Kind.Valid() || !st.State.Valid() {
			return fmt.Errorf("%w: structure %q invalid kind or state", ErrInvalidState, st.StructureID)
		}
		if _, ok := zoneByID[st.ZoneID]; !ok {
			return fmt.Errorf("%w: structure %q references unknown zone %q", ErrInvalidState, st.StructureID, st.ZoneID)
		}
		if st.MaxHP <= 0 || st.HP < 0 || st.HP > st.MaxHP {
			return fmt.Errorf("%w: structure %q hp %d out of [0, %d]", ErrInvalidState, st.StructureID, st.HP, st.MaxHP)
		}
		var err error
		if totalMaxHP, err = safeAddInt64(totalMaxHP, st.MaxHP); err != nil {
			return err
		}
		if st.ResistanceBP < 0 || st.ResistanceBP > 7500 || st.ArmorFlat < 0 ||
			st.BreachThresholdBP < 0 || st.BreachThresholdBP > BasisPointsScale {
			return fmt.Errorf("%w: structure %q invalid resistance/armor/breach threshold", ErrInvalidState, st.StructureID)
		}
		if st.AttackRangeZones < 0 || st.RepairsApplied < 0 || st.RepairsApplied > cfg.MaxRepairsPerStructure {
			return fmt.Errorf("%w: structure %q invalid attack range or repair count %d", ErrInvalidState, st.StructureID, st.RepairsApplied)
		}
		if st.HP == 0 && st.State != StructureDestroyed {
			return fmt.Errorf("%w: structure %q has 0 hp but state is %q", ErrInvalidState, st.StructureID, st.State)
		}
		if st.HP > 0 && st.State == StructureDestroyed {
			return fmt.Errorf("%w: structure %q marked Destroyed with hp %d", ErrInvalidState, st.StructureID, st.HP)
		}
		if st.Kind == StructureCitadel {
			hasCitadelStruct = true
		}
		structByID[st.StructureID] = st
	}
	if !hasCitadelStruct || totalMaxHP <= 0 {
		return fmt.Errorf("%w: siege requires a Citadel structure with positive total HP", ErrInvalidLayout)
	}

	// Validate connections (strictly sorted by ConnectionID).
	for i, conn := range s.Connections {
		if err := validateID(conn.ConnectionID, maxID); err != nil {
			return fmt.Errorf("%w: connection_id: %v", ErrInvalidState, err)
		}
		if i > 0 && s.Connections[i-1].ConnectionID >= conn.ConnectionID {
			return fmt.Errorf("%w: connections not strictly sorted by connection_id", ErrInvalidState)
		}
		if !conn.Rule.Valid() {
			return fmt.Errorf("%w: connection %q invalid rule %q", ErrInvalidState, conn.ConnectionID, conn.Rule)
		}
		if conn.FromZoneID == conn.ToZoneID {
			return fmt.Errorf("%w: self-loop connection %q", ErrInvalidLayout, conn.ConnectionID)
		}
		if _, ok := zoneByID[conn.FromZoneID]; !ok {
			return fmt.Errorf("%w: connection %q unknown from_zone %q", ErrInvalidLayout, conn.ConnectionID, conn.FromZoneID)
		}
		if _, ok := zoneByID[conn.ToZoneID]; !ok {
			return fmt.Errorf("%w: connection %q unknown to_zone %q", ErrInvalidLayout, conn.ConnectionID, conn.ToZoneID)
		}
		if conn.Rule == ConnRequiresStructureCompromised {
			if _, ok := structByID[conn.BlockerStructureID]; !ok {
				return fmt.Errorf("%w: connection %q references unknown blocker structure %q", ErrInvalidLayout, conn.ConnectionID, conn.BlockerStructureID)
			}
		}
	}

	// Validate objectives (strictly sorted by ObjectiveID, acyclic prerequisites).
	objByID := make(map[string]Objective, len(s.Objectives))
	for i, obj := range s.Objectives {
		if err := validateID(obj.ObjectiveID, maxID); err != nil {
			return fmt.Errorf("%w: objective_id: %v", ErrInvalidState, err)
		}
		if i > 0 && s.Objectives[i-1].ObjectiveID >= obj.ObjectiveID {
			return fmt.Errorf("%w: objectives not strictly sorted by objective_id", ErrInvalidState)
		}
		if !obj.Side.Valid() || !obj.Kind.Valid() || !obj.State.Valid() {
			return fmt.Errorf("%w: objective %q invalid enum", ErrInvalidState, obj.ObjectiveID)
		}
		if _, ok := zoneByID[obj.ZoneID]; !ok {
			return fmt.Errorf("%w: objective %q references unknown zone %q", ErrInvalidState, obj.ObjectiveID, obj.ZoneID)
		}
		if obj.TargetStructureID != "" {
			if _, ok := structByID[obj.TargetStructureID]; !ok {
				return fmt.Errorf("%w: objective %q references unknown structure %q", ErrInvalidState, obj.ObjectiveID, obj.TargetStructureID)
			}
		}
		if obj.TargetProgress <= 0 || obj.Progress < 0 || obj.Progress > obj.TargetProgress {
			return fmt.Errorf("%w: objective %q progress %d out of [0, %d]", ErrInvalidState, obj.ObjectiveID, obj.Progress, obj.TargetProgress)
		}
		if len(obj.CompletedByID) > maxID {
			return fmt.Errorf("%w: objective %q completed_by_id too long", ErrInvalidState, obj.ObjectiveID)
		}
		objByID[obj.ObjectiveID] = obj
	}
	for _, obj := range s.Objectives {
		for _, pre := range obj.PrerequisiteIDs {
			if pre == obj.ObjectiveID {
				return fmt.Errorf("%w: objective %q cannot depend on itself", ErrInvalidLayout, obj.ObjectiveID)
			}
			if _, ok := objByID[pre]; !ok {
				return fmt.Errorf("%w: objective %q unknown prerequisite %q", ErrInvalidLayout, obj.ObjectiveID, pre)
			}
		}
	}
	if hasObjectiveCycle(s.Objectives) {
		return fmt.Errorf("%w: cyclic objective prerequisites detected", ErrInvalidLayout)
	}

	// Validate commanders (strictly sorted by CommanderID).
	for i, cmdr := range s.Commanders {
		if err := validateID(cmdr.CommanderID, maxID); err != nil {
			return fmt.Errorf("%w: commander_id: %v", ErrInvalidState, err)
		}
		if i > 0 && s.Commanders[i-1].CommanderID >= cmdr.CommanderID {
			return fmt.Errorf("%w: commanders not strictly sorted by commander_id", ErrInvalidState)
		}
		if !cmdr.Family.Valid() || strings.TrimSpace(cmdr.DisplayName) == "" {
			return fmt.Errorf("%w: commander %q invalid family or name", ErrInvalidState, cmdr.CommanderID)
		}
		if _, err := ai.LookupProfile(cmdr.Archetype); err != nil {
			return fmt.Errorf("%w: commander %q unknown archetype %q", ErrInvalidState, cmdr.CommanderID, cmdr.Archetype)
		}
		if cmdr.MoraleAuraBonusBP < 0 || cmdr.MoraleAuraBonusBP > BasisPointsScale ||
			cmdr.SiegeDamageBonusBP < 0 || cmdr.SiegeDamageBonusBP > BasisPointsScale {
			return fmt.Errorf("%w: commander %q invalid bonuses", ErrInvalidState, cmdr.CommanderID)
		}
		if cmdr.PriorityObjectiveID != "" {
			if _, ok := objByID[cmdr.PriorityObjectiveID]; !ok {
				return fmt.Errorf("%w: commander %q unknown priority objective %q", ErrInvalidState, cmdr.CommanderID, cmdr.PriorityObjectiveID)
			}
		}
	}

	// Validate waves (strictly sorted by WaveID).
	for i, w := range s.Waves {
		if err := validateID(w.WaveID, maxID); err != nil {
			return fmt.Errorf("%w: wave_id: %v", ErrInvalidState, err)
		}
		if i > 0 && s.Waves[i-1].WaveID >= w.WaveID {
			return fmt.Errorf("%w: waves not strictly sorted by wave_id", ErrInvalidState)
		}
		if !w.State.Valid() || w.Count <= 0 {
			return fmt.Errorf("%w: wave %q invalid state or count", ErrInvalidState, w.WaveID)
		}
		if _, err := ai.LookupProfile(w.Archetype); err != nil {
			return fmt.Errorf("%w: wave %q unknown archetype %q", ErrInvalidState, w.WaveID, w.Archetype)
		}
		if _, ok := zoneByID[w.EntryZoneID]; !ok {
			return fmt.Errorf("%w: wave %q unknown entry_zone %q", ErrInvalidState, w.WaveID, w.EntryZoneID)
		}
		if len(w.CampaignID) > maxID || len(w.ReservationID) > maxID || len(w.LeaderID) > maxID || len(w.SpawnedGroupID) > maxID {
			return fmt.Errorf("%w: wave %q identifier exceeds max length", ErrInvalidState, w.WaveID)
		}
	}

	// Validate entity repair ledgers (strictly sorted by EntityID).
	for i, er := range s.EntityRepairs {
		if err := validateID(er.EntityID, maxID); err != nil {
			return fmt.Errorf("%w: entity_repair entity_id: %v", ErrInvalidState, err)
		}
		if i > 0 && s.EntityRepairs[i-1].EntityID >= er.EntityID {
			return fmt.Errorf("%w: entity_repairs not strictly sorted", ErrInvalidState)
		}
		if er.Count < 0 || er.Count > cfg.MaxRepairsPerEntity {
			return fmt.Errorf("%w: entity %q repair count %d out of [0, %d]", ErrInvalidState, er.EntityID, er.Count, cfg.MaxRepairsPerEntity)
		}
	}

	return nil
}

// WriteChecksum streams every canonical logical field of SiegeState into a CanonicalHasher.
func (s SiegeState) WriteChecksum(h *simulation.CanonicalHasher) {
	h.WriteString(s.LayoutID)
	h.WriteString(s.SettlementID)
	h.WriteString(s.RegionID)
	h.WriteUint32(s.RulesVersion)
	h.WriteString(s.CampaignID)
	h.WriteString(s.InvadingFactionID)
	h.WriteUint8(s.InvadingFamily.Code())
	h.WriteBool(s.IsReconquest)
	h.WriteUint8(s.Phase.Code())
	h.WriteUint64(s.StartedTick)
	h.WriteUint64(s.PhaseStartedTick)
	h.WriteUint64(s.LastProgressTick)
	h.WriteUint64(s.CompletedTick)
	h.WriteString(s.TerminalReason)

	h.WriteUint64(uint64(len(s.Zones)))
	for _, z := range s.Zones {
		h.WriteString(z.ZoneID)
		h.WriteUint8(z.Kind.Code())
		h.WriteString(z.Name)
		h.WriteInt64(int64(z.Depth))
		h.WriteInt64(z.PositionHint)
		h.WriteBool(z.Capturable)
		h.WriteUint8(z.ControlState.Code())
		h.WriteInt64(z.ControlProgress)
		h.WriteString(z.ControllingFactionID)
		h.WriteUint64(z.LastControlTick)
	}

	h.WriteUint64(uint64(len(s.Connections)))
	for _, c := range s.Connections {
		h.WriteString(c.ConnectionID)
		h.WriteString(c.FromZoneID)
		h.WriteString(c.ToZoneID)
		h.WriteBool(c.Bidirectional)
		h.WriteUint8(c.Rule.Code())
		h.WriteString(c.BlockerStructureID)
	}

	h.WriteUint64(uint64(len(s.Structures)))
	for _, st := range s.Structures {
		h.WriteString(st.StructureID)
		h.WriteUint8(st.Kind.Code())
		h.WriteString(st.ZoneID)
		h.WriteInt64(st.HP)
		h.WriteInt64(st.MaxHP)
		h.WriteInt64(st.ResistanceBP)
		h.WriteInt64(st.ArmorFlat)
		h.WriteInt64(st.BreachThresholdBP)
		h.WriteUint8(st.State.Code())
		h.WriteInt64(int64(st.AttackRangeZones))
		h.WriteUint64(st.FireCooldownTicks)
		h.WriteInt64(int64(st.RepairsApplied))
		h.WriteUint64(st.DestroyedTick)
	}

	h.WriteUint64(uint64(len(s.Objectives)))
	for _, obj := range s.Objectives {
		h.WriteString(obj.ObjectiveID)
		h.WriteUint8(obj.Side.Code())
		h.WriteUint8(obj.Kind.Code())
		h.WriteString(obj.ZoneID)
		h.WriteString(obj.TargetStructureID)
		h.WriteUint64(uint64(len(obj.PrerequisiteIDs)))
		for _, pre := range obj.PrerequisiteIDs {
			h.WriteString(pre)
		}
		h.WriteUint8(obj.State.Code())
		h.WriteInt64(obj.Progress)
		h.WriteInt64(obj.TargetProgress)
		h.WriteUint64(obj.CompletedTick)
		h.WriteString(obj.CompletedByID)
	}

	h.WriteUint64(uint64(len(s.Commanders)))
	for _, cmdr := range s.Commanders {
		h.WriteString(cmdr.CommanderID)
		h.WriteString(cmdr.DisplayName)
		h.WriteString(cmdr.GroupID)
		h.WriteUint8(cmdr.Family.Code())
		h.WriteString(cmdr.Archetype)
		h.WriteInt64(cmdr.MoraleAuraBonusBP)
		h.WriteInt64(cmdr.SiegeDamageBonusBP)
		h.WriteString(cmdr.PriorityObjectiveID)
		h.WriteBool(cmdr.Alive)
		h.WriteBool(cmdr.Deployed)
		h.WriteUint64(cmdr.DefeatedTick)
		h.WriteString(cmdr.DefeatedByPlayerID)
		h.WriteBool(cmdr.FallenShockApplied)
	}

	h.WriteUint64(uint64(len(s.Waves)))
	for _, w := range s.Waves {
		h.WriteString(w.WaveID)
		h.WriteString(w.CampaignID)
		h.WriteString(w.ReservationID)
		h.WriteString(w.Archetype)
		h.WriteInt64(w.Count)
		h.WriteUint64(w.ScheduledTick)
		h.WriteString(w.EntryZoneID)
		h.WriteString(w.LeaderID)
		h.WriteUint8(w.State.Code())
		h.WriteString(w.SpawnedGroupID)
	}

	h.WriteInt64(s.Supplies.Current)
	h.WriteInt64(s.Supplies.Max)
	h.WriteInt64(s.Supplies.TotalSpent)
	h.WriteInt64(s.Supplies.TotalRegenerated)
	h.WriteInt64(s.Supplies.MaxTotalRegen)
	h.WriteUint64(s.Supplies.LastRegenTick)

	h.WriteUint64(uint64(len(s.EntityRepairs)))
	for _, er := range s.EntityRepairs {
		h.WriteString(er.EntityID)
		h.WriteInt64(int64(er.Count))
		h.WriteUint64(er.NextRepairTick)
	}

	h.WriteInt64(s.InvaderCasualties)
	h.WriteInt64(s.DefenderCasualties)
}

// Checksum computes a canonical SHA-256 hash of SiegeState.
func (s SiegeState) Checksum(cfg Config) (string, error) {
	if err := s.ValidateWithConfig(cfg); err != nil {
		return "", err
	}
	h := simulation.NewCanonicalHasher()
	s.WriteChecksum(h)
	return h.SumHex(), nil
}

func validateID(id string, maxLen int) error {
	if strings.TrimSpace(id) == "" {
		return errors.New("empty identifier")
	}
	if len(id) > maxLen {
		return fmt.Errorf("identifier exceeds max length %d", maxLen)
	}
	return nil
}

func safeAddInt64(a, b int64) (int64, error) {
	if b > 0 && a > math.MaxInt64-b {
		return 0, fmt.Errorf("%w: %d + %d overflows int64", ErrNumericOverflow, a, b)
	}
	if b < 0 && a < math.MinInt64-b {
		return 0, fmt.Errorf("%w: %d + %d underflows int64", ErrNumericOverflow, a, b)
	}
	return a + b, nil
}

func safeMulDivBP(value, bp int64) (int64, error) {
	if value < 0 || bp < 0 {
		return 0, fmt.Errorf("%w: negative operand (%d, %d)", ErrInvalidCommand, value, bp)
	}
	if value == 0 || bp == 0 {
		return 0, nil
	}
	hi, lo := bits.Mul64(uint64(value), uint64(bp))
	q, _ := bits.Div64(hi, lo, uint64(BasisPointsScale))
	if q > math.MaxInt64 {
		return 0, fmt.Errorf("%w: scaled result overflows int64", ErrNumericOverflow)
	}
	return int64(q), nil
}

func hasObjectiveCycle(objectives []Objective) bool {
	byID := make(map[string][]string, len(objectives))
	for _, o := range objectives {
		byID[o.ObjectiveID] = o.PrerequisiteIDs
	}
	// 0 = unvisited, 1 = visiting, 2 = done
	color := make(map[string]uint8, len(objectives))
	var visit func(id string) bool
	visit = func(id string) bool {
		if color[id] == 1 {
			return true
		}
		if color[id] == 2 {
			return false
		}
		color[id] = 1
		for _, dep := range byID[id] {
			if visit(dep) {
				return true
			}
		}
		color[id] = 2
		return false
	}
	for _, o := range objectives {
		if visit(o.ObjectiveID) {
			return true
		}
	}
	return false
}
