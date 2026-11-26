package ai

import (
	"errors"
	"fmt"
	"strings"
)

// Family identifies the creature family for tactical and morale grouping.
// Original ASCENDRA archetype definitions (no external protected lore).
type Family string

const (
	FamilyGoblin Family = "goblin"
	FamilyOrc    Family = "orc"
)

// Valid reports whether the creature family is supported.
func (f Family) Valid() bool {
	return f == FamilyGoblin || f == FamilyOrc
}

// Code returns a stable numeric identifier for canonical hashing.
func (f Family) Code() uint8 {
	switch f {
	case FamilyGoblin:
		return 1
	case FamilyOrc:
		return 2
	default:
		return 0
	}
}

// TacticalRole classifies a group's behavioral role inside pack/warband coordination.
type TacticalRole string

const (
	RoleSkirmisher TacticalRole = "skirmisher"
	RoleRaider     TacticalRole = "raider"
	RoleVanguard   TacticalRole = "vanguard"
	RoleCommander  TacticalRole = "commander"
)

// Valid reports whether the tactical role is recognized.
func (r TacticalRole) Valid() bool {
	switch r {
	case RoleSkirmisher, RoleRaider, RoleVanguard, RoleCommander:
		return true
	default:
		return false
	}
}

// Code returns a stable numeric identifier for canonical hashing.
func (r TacticalRole) Code() uint8 {
	switch r {
	case RoleSkirmisher:
		return 1
	case RoleRaider:
		return 2
	case RoleVanguard:
		return 3
	case RoleCommander:
		return 4
	default:
		return 0
	}
}

// Sentinel errors for profile lookup and validation.
var (
	ErrUnknownProfile = errors.New("unknown creature profile")
	ErrInvalidProfile = errors.New("invalid creature profile")
)

// Profile defines pure integer behavioral parameters for a creature archetype.
// All distances are in WorldUnits (1000 = 1.000 tile) and ratios in BasisPoints (10000 = 100.00%).
type Profile struct {
	Archetype               string       `json:"archetype"`
	Family                  Family       `json:"family"`
	Role                    TacticalRole `json:"role"`
	BaseHP                  int64        `json:"base_hp"`
	BaseDamage              int64        `json:"base_damage"`
	MoveSpeedPerTick        int64        `json:"move_speed_per_tick"`
	VisionRange             int64        `json:"vision_range"`
	AlertRange              int64        `json:"alert_range"`
	AttackRange             int64        `json:"attack_range"`
	AttackCooldownTicks     int64        `json:"attack_cooldown_ticks"`
	TerritoryRadius         int64        `json:"territory_radius"`
	LeashRadius             int64        `json:"leash_radius"`
	InitialMoraleBP         int64        `json:"initial_morale_bp"`
	BreakMoraleBP           int64        `json:"break_morale_bp"`
	RallyMoraleBP           int64        `json:"rally_morale_bp"`
	RetreatHPThresholdBP    int64        `json:"retreat_hp_threshold_bp"`
	PackMoraleBonusBP       int64        `json:"pack_morale_bonus_bp"`
	CommanderAuraBP         int64        `json:"commander_aura_bp"`
	MoraleRecoveryPerTickBP int64        `json:"morale_recovery_per_tick_bp"`
	MoraleLossPerHitBP      int64        `json:"morale_loss_per_hit_bp"`
	ReinforceTriggerHPBP    int64        `json:"reinforce_trigger_hp_bp"`
	ReinforceCooldownTicks  int64        `json:"reinforce_cooldown_ticks"`
	MaxReinforcementCalls   int          `json:"max_reinforcement_calls"`
	ReinforcementArchetype  string       `json:"reinforcement_archetype"`
	ReinforcementCount      int64        `json:"reinforcement_count"`
	WeightProximity         int64        `json:"weight_proximity"`
	WeightLowHP             int64        `json:"weight_low_hp"`
	WeightThreat            int64        `json:"weight_threat"`
	WeightObjective         int64        `json:"weight_objective"`
	WeightCommanderFocus    int64        `json:"weight_commander_focus"`
}

// Validate checks structural and numeric bounds on a creature profile.
func (p Profile) Validate() error {
	if strings.TrimSpace(p.Archetype) == "" {
		return fmt.Errorf("%w: empty archetype", ErrInvalidProfile)
	}
	if !p.Family.Valid() {
		return fmt.Errorf("%w: invalid family %q", ErrInvalidProfile, p.Family)
	}
	if !p.Role.Valid() {
		return fmt.Errorf("%w: invalid role %q", ErrInvalidProfile, p.Role)
	}
	if p.BaseHP <= 0 || p.BaseDamage <= 0 {
		return fmt.Errorf("%w: base_hp and base_damage must be > 0", ErrInvalidProfile)
	}
	if p.MoveSpeedPerTick < 0 || p.VisionRange <= 0 || p.AlertRange < 0 || p.AttackRange <= 0 || p.AttackCooldownTicks < 0 {
		return fmt.Errorf("%w: invalid movement/perception/attack bounds", ErrInvalidProfile)
	}
	if p.TerritoryRadius <= 0 || p.LeashRadius < p.TerritoryRadius {
		return fmt.Errorf("%w: leash_radius (%d) must be >= territory_radius (%d) > 0", ErrInvalidProfile, p.LeashRadius, p.TerritoryRadius)
	}
	if p.InitialMoraleBP < 0 || uint64(p.InitialMoraleBP) > BasisPointsScale {
		return fmt.Errorf("%w: initial_morale_bp out of range", ErrInvalidProfile)
	}
	if p.BreakMoraleBP < 0 || uint64(p.BreakMoraleBP) >= BasisPointsScale {
		return fmt.Errorf("%w: break_morale_bp out of range", ErrInvalidProfile)
	}
	if p.RallyMoraleBP <= p.BreakMoraleBP || uint64(p.RallyMoraleBP) > BasisPointsScale {
		return fmt.Errorf("%w: rally_morale_bp (%d) must exceed break_morale_bp (%d)", ErrInvalidProfile, p.RallyMoraleBP, p.BreakMoraleBP)
	}
	if p.RetreatHPThresholdBP < 0 || uint64(p.RetreatHPThresholdBP) > BasisPointsScale {
		return fmt.Errorf("%w: retreat_hp_threshold_bp out of range", ErrInvalidProfile)
	}
	if p.PackMoraleBonusBP < 0 || p.CommanderAuraBP < 0 || p.MoraleRecoveryPerTickBP < 0 || p.MoraleLossPerHitBP < 0 {
		return fmt.Errorf("%w: negative morale modifier", ErrInvalidProfile)
	}
	if p.ReinforceTriggerHPBP < 0 || uint64(p.ReinforceTriggerHPBP) > BasisPointsScale {
		return fmt.Errorf("%w: reinforce_trigger_hp_bp out of range", ErrInvalidProfile)
	}
	if p.ReinforceCooldownTicks < 0 || p.MaxReinforcementCalls < 0 || p.ReinforcementCount < 0 {
		return fmt.Errorf("%w: negative reinforcement parameters", ErrInvalidProfile)
	}
	if p.MaxReinforcementCalls > 0 && (strings.TrimSpace(p.ReinforcementArchetype) == "" || p.ReinforcementCount <= 0) {
		return fmt.Errorf("%w: reinforcement archetype and count required when max calls > 0", ErrInvalidProfile)
	}
	if p.WeightProximity < 0 || p.WeightLowHP < 0 || p.WeightThreat < 0 || p.WeightObjective < 0 || p.WeightCommanderFocus < 0 {
		return fmt.Errorf("%w: negative target weight", ErrInvalidProfile)
	}
	return nil
}

// DefaultProfileCatalog returns the canonical sorted catalog of Cycle 02 goblin and orc profiles.
func DefaultProfileCatalog() []Profile {
	return []Profile{
		{
			Archetype:               "goblin-raider-pack",
			Family:                  FamilyGoblin,
			Role:                    RoleRaider,
			BaseHP:                  400,
			BaseDamage:              65,
			MoveSpeedPerTick:        550,
			VisionRange:             7000,
			AlertRange:              6000,
			AttackRange:             1500,
			AttackCooldownTicks:     12,
			TerritoryRadius:         4000,
			LeashRadius:             7500,
			InitialMoraleBP:         6200,
			BreakMoraleBP:           3000,
			RallyMoraleBP:           5200,
			RetreatHPThresholdBP:    2200,
			PackMoraleBonusBP:       650,
			CommanderAuraBP:         0,
			MoraleRecoveryPerTickBP: 120,
			MoraleLossPerHitBP:      450,
			ReinforceTriggerHPBP:    6500,
			ReinforceCooldownTicks:  40,
			MaxReinforcementCalls:   1,
			ReinforcementArchetype:  "goblin-skirmisher",
			ReinforcementCount:      1,
			WeightProximity:         3,
			WeightLowHP:             8,
			WeightThreat:            2,
			WeightObjective:         4,
			WeightCommanderFocus:    5,
		},
		{
			Archetype:               "goblin-skirmisher",
			Family:                  FamilyGoblin,
			Role:                    RoleSkirmisher,
			BaseHP:                  320,
			BaseDamage:              55,
			MoveSpeedPerTick:        650,
			VisionRange:             8000,
			AlertRange:              6500,
			AttackRange:             1800,
			AttackCooldownTicks:     10,
			TerritoryRadius:         3500,
			LeashRadius:             6500,
			InitialMoraleBP:         5600,
			BreakMoraleBP:           3400,
			RallyMoraleBP:           5400,
			RetreatHPThresholdBP:    2500,
			PackMoraleBonusBP:       700,
			CommanderAuraBP:         0,
			MoraleRecoveryPerTickBP: 140,
			MoraleLossPerHitBP:      500,
			ReinforceTriggerHPBP:    5500,
			ReinforceCooldownTicks:  50,
			MaxReinforcementCalls:   0,
			ReinforcementArchetype:  "",
			ReinforcementCount:      0,
			WeightProximity:         4,
			WeightLowHP:             10,
			WeightThreat:            1,
			WeightObjective:         3,
			WeightCommanderFocus:    5,
		},
		{
			Archetype:               "goblin-taskmaster",
			Family:                  FamilyGoblin,
			Role:                    RoleCommander,
			BaseHP:                  480,
			BaseDamage:              70,
			MoveSpeedPerTick:        500,
			VisionRange:             8500,
			AlertRange:              9000,
			AttackRange:             1600,
			AttackCooldownTicks:     12,
			TerritoryRadius:         5000,
			LeashRadius:             9000,
			InitialMoraleBP:         7400,
			BreakMoraleBP:           2400,
			RallyMoraleBP:           4600,
			RetreatHPThresholdBP:    1800,
			PackMoraleBonusBP:       500,
			CommanderAuraBP:         1200,
			MoraleRecoveryPerTickBP: 160,
			MoraleLossPerHitBP:      320,
			ReinforceTriggerHPBP:    7500,
			ReinforceCooldownTicks:  35,
			MaxReinforcementCalls:   2,
			ReinforcementArchetype:  "goblin-skirmisher",
			ReinforcementCount:      1,
			WeightProximity:         3,
			WeightLowHP:             7,
			WeightThreat:            4,
			WeightObjective:         5,
			WeightCommanderFocus:    6,
		},
		{
			Archetype:               "orc-vanguard",
			Family:                  FamilyOrc,
			Role:                    RoleVanguard,
			BaseHP:                  550,
			BaseDamage:              80,
			MoveSpeedPerTick:        450,
			VisionRange:             6500,
			AlertRange:              7500,
			AttackRange:             1500,
			AttackCooldownTicks:     13,
			TerritoryRadius:         5000,
			LeashRadius:             9500,
			InitialMoraleBP:         8200,
			BreakMoraleBP:           1600,
			RallyMoraleBP:           3600,
			RetreatHPThresholdBP:    1200,
			PackMoraleBonusBP:       350,
			CommanderAuraBP:         0,
			MoraleRecoveryPerTickBP: 150,
			MoraleLossPerHitBP:      240,
			ReinforceTriggerHPBP:    4500,
			ReinforceCooldownTicks:  50,
			MaxReinforcementCalls:   1,
			ReinforcementArchetype:  "orc-vanguard",
			ReinforcementCount:      1,
			WeightProximity:         3,
			WeightLowHP:             2,
			WeightThreat:            9,
			WeightObjective:         7,
			WeightCommanderFocus:    7,
		},
		{
			Archetype:               "orc-warchief",
			Family:                  FamilyOrc,
			Role:                    RoleCommander,
			BaseHP:                  780,
			BaseDamage:              95,
			MoveSpeedPerTick:        420,
			VisionRange:             8000,
			AlertRange:              10000,
			AttackRange:             1600,
			AttackCooldownTicks:     12,
			TerritoryRadius:         6000,
			LeashRadius:             11000,
			InitialMoraleBP:         9200,
			BreakMoraleBP:           1000,
			RallyMoraleBP:           3000,
			RetreatHPThresholdBP:    800,
			PackMoraleBonusBP:       300,
			CommanderAuraBP:         1600,
			MoraleRecoveryPerTickBP: 200,
			MoraleLossPerHitBP:      180,
			ReinforceTriggerHPBP:    8000,
			ReinforceCooldownTicks:  30,
			MaxReinforcementCalls:   2,
			ReinforcementArchetype:  "orc-vanguard",
			ReinforcementCount:      1,
			WeightProximity:         2,
			WeightLowHP:             2,
			WeightThreat:            10,
			WeightObjective:         8,
			WeightCommanderFocus:    8,
		},
	}
}

// LookupProfile resolves a canonical archetype name (including Cycle 01 aliases) to its Profile.
func LookupProfile(archetype string) (Profile, error) {
	normalized := strings.TrimSpace(archetype)
	// Preserve compatibility with Cycle 01 fixture naming.
	if normalized == "goblin-skirmishers" {
		normalized = "goblin-skirmisher"
	}
	for _, p := range DefaultProfileCatalog() {
		if p.Archetype == normalized {
			return p, nil
		}
	}
	return Profile{}, fmt.Errorf("%w: %q", ErrUnknownProfile, archetype)
}
