package ecosystem

import (
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"

	"ascendra-game/internal/ai"
	"ascendra-game/internal/simulation"
)

const (
	// ConfigVersion versions deterministic regional ecosystem parameters.
	ConfigVersion uint32 = 1
	// BasisPointsScale represents 100.00% in integer fixed-point math.
	BasisPointsScale int64 = 10000
	// MilliScale represents 1.000 unit in per-capita resource demand math.
	MilliScale int64 = 1000
	// DefaultMaxSnapshotBytes enforces bounded memory before JSON decoding.
	DefaultMaxSnapshotBytes int = 1 * 1024 * 1024 // 1 MiB
	// DefaultMaxIdentifierLength bounds string IDs across ecosystem entities.
	DefaultMaxIdentifierLength int = 128
)

var (
	ErrInvalidConfig          = errors.New("invalid ecosystem config")
	ErrInvalidState           = errors.New("invalid ecosystem state")
	ErrInvalidCommand         = errors.New("invalid ecosystem command")
	ErrEpochMismatch          = errors.New("ecosystem command epoch mismatch")
	ErrUnknownEntity          = errors.New("unknown ecosystem entity")
	ErrCapacityExceeded       = errors.New("ecosystem capacity limit exceeded")
	ErrNumericOverflow        = errors.New("ecosystem integer overflow")
	ErrInsufficientPopulation = errors.New("insufficient free population for materialization")
	ErrCampUnavailable        = errors.New("camp cannot supply or spawn groups in current state")
	ErrInvalidReference       = errors.New("invalid cross-entity reference")
)

// Biome classifies a region's ecological profile.
type Biome string

const (
	BiomeValley   Biome = "valley"
	BiomeForest   Biome = "forest"
	BiomeFrontier Biome = "frontier"
)

func (b Biome) Valid() bool {
	return b == BiomeValley || b == BiomeForest || b == BiomeFrontier
}

func (b Biome) Code() uint8 {
	switch b {
	case BiomeValley:
		return 1
	case BiomeForest:
		return 2
	case BiomeFrontier:
		return 3
	default:
		return 0
	}
}

// EcologicalStatus summarizes regional resource health.
type EcologicalStatus string

const (
	EcoStatusThriving EcologicalStatus = "Thriving"
	EcoStatusBalanced EcologicalStatus = "Balanced"
	EcoStatusStrained EcologicalStatus = "Strained"
	EcoStatusDepleted EcologicalStatus = "Depleted"
)

func (s EcologicalStatus) Valid() bool {
	switch s {
	case EcoStatusThriving, EcoStatusBalanced, EcoStatusStrained, EcoStatusDepleted:
		return true
	default:
		return false
	}
}

func (s EcologicalStatus) Code() uint8 {
	switch s {
	case EcoStatusThriving:
		return 1
	case EcoStatusBalanced:
		return 2
	case EcoStatusStrained:
		return 3
	case EcoStatusDepleted:
		return 4
	default:
		return 0
	}
}

// ThreatLevel represents regional threat with explicit hysteresis bands.
type ThreatLevel string

const (
	ThreatStable   ThreatLevel = "Stable"
	ThreatGrowing  ThreatLevel = "Growing"
	ThreatHostile  ThreatLevel = "Hostile"
	ThreatCritical ThreatLevel = "Critical"
)

func (t ThreatLevel) Valid() bool {
	switch t {
	case ThreatStable, ThreatGrowing, ThreatHostile, ThreatCritical:
		return true
	default:
		return false
	}
}

func (t ThreatLevel) Code() uint8 {
	switch t {
	case ThreatStable:
		return 1
	case ThreatGrowing:
		return 2
	case ThreatHostile:
		return 3
	case ThreatCritical:
		return 4
	default:
		return 0
	}
}

// FactionStance explicitly configures inter-faction diplomatic relation.
type FactionStance string

const (
	StanceAllied  FactionStance = "Allied"
	StanceNeutral FactionStance = "Neutral"
	StanceHostile FactionStance = "Hostile"
)

func (s FactionStance) Valid() bool {
	return s == StanceAllied || s == StanceNeutral || s == StanceHostile
}

func (s FactionStance) Code() uint8 {
	switch s {
	case StanceAllied:
		return 1
	case StanceNeutral:
		return 2
	case StanceHostile:
		return 3
	default:
		return 0
	}
}

// CampState models the explicit lifecycle of a creature camp.
type CampState string

const (
	CampEstablishing    CampState = "Establishing"
	CampActive          CampState = "Active"
	CampExpanding       CampState = "Expanding"
	CampResourceStarved CampState = "ResourceStarved"
	CampThreatened      CampState = "Threatened"
	CampAbandoned       CampState = "Abandoned"
	CampDestroyed       CampState = "Destroyed"
)

func (s CampState) Valid() bool {
	switch s {
	case CampEstablishing, CampActive, CampExpanding, CampResourceStarved, CampThreatened, CampAbandoned, CampDestroyed:
		return true
	default:
		return false
	}
}

func (s CampState) Code() uint8 {
	switch s {
	case CampEstablishing:
		return 1
	case CampActive:
		return 2
	case CampExpanding:
		return 3
	case CampResourceStarved:
		return 4
	case CampThreatened:
		return 5
	case CampAbandoned:
		return 6
	case CampDestroyed:
		return 7
	default:
		return 0
	}
}

// CanSupplyMaterialization reports whether a camp may reserve/materialize tactical groups.
func (s CampState) CanSupplyMaterialization() bool {
	return s == CampActive || s == CampExpanding || s == CampThreatened
}

// ResourceSlot tracks a single ecological resource with strict conservation bounds.
// Ecological resources are NOT tradeable player inventory or currency (CARBON domain).
type ResourceSlot struct {
	Amount          int64 `json:"amount"`
	MaxCapacity     int64 `json:"max_capacity"`
	RegenPerEpoch   int64 `json:"regen_per_epoch"`
	RegenRateBP     int64 `json:"regen_rate_bp"`
	ExtractionLimit int64 `json:"extraction_limit"`
}

func (r ResourceSlot) Validate() error {
	if r.MaxCapacity < 0 || r.Amount < 0 || r.Amount > r.MaxCapacity {
		return fmt.Errorf("%w: resource amount %d out of [0, %d]", ErrInvalidState, r.Amount, r.MaxCapacity)
	}
	if r.RegenPerEpoch < 0 || r.RegenRateBP < 0 || r.RegenRateBP > BasisPointsScale || r.ExtractionLimit < 0 {
		return fmt.Errorf("%w: invalid resource regeneration or extraction limit", ErrInvalidState)
	}
	return nil
}

// ResourcePool holds the five ecological resource pools of a region.
type ResourcePool struct {
	Food  ResourceSlot `json:"food"`
	Wood  ResourceSlot `json:"wood"`
	Stone ResourceSlot `json:"stone"`
	Ore   ResourceSlot `json:"ore"`
	Water ResourceSlot `json:"water"`
}

func (p ResourcePool) Validate() error {
	if err := p.Food.Validate(); err != nil {
		return fmt.Errorf("food: %w", err)
	}
	if err := p.Wood.Validate(); err != nil {
		return fmt.Errorf("wood: %w", err)
	}
	if err := p.Stone.Validate(); err != nil {
		return fmt.Errorf("stone: %w", err)
	}
	if err := p.Ore.Validate(); err != nil {
		return fmt.Errorf("ore: %w", err)
	}
	if err := p.Water.Validate(); err != nil {
		return fmt.Errorf("water: %w", err)
	}
	return nil
}

// FactionRelation overrides the default stance toward a specific target faction.
type FactionRelation struct {
	TargetFactionID string        `json:"target_faction_id"`
	Stance          FactionStance `json:"stance"`
}

// FactionProfile defines a faction's ecological affiliation and diplomatic stance.
type FactionProfile struct {
	FactionID           string            `json:"faction_id"`
	Name                string            `json:"name"`
	HostileToSettlement bool              `json:"hostile_to_settlement"`
	DefaultStance       FactionStance     `json:"default_stance"`
	Relations           []FactionRelation `json:"relations"`
}

// FactionInfluence tracks a faction's regional territorial influence in BasisPoints [0, 10000].
type FactionInfluence struct {
	FactionID   string `json:"faction_id"`
	InfluenceBP int64  `json:"influence_bp"`
}

// Region models a macro ecological node connected by an adjacency graph.
type Region struct {
	RegionID             string             `json:"region_id"`
	Name                 string             `json:"name"`
	Biome                Biome              `json:"biome"`
	HasSettlement        bool               `json:"has_settlement"`
	SettlementID         string             `json:"settlement_id,omitempty"`
	CarryingCapacity     int64              `json:"carrying_capacity"`
	AdjacentRegions      []string           `json:"adjacent_regions"`
	Resources            ResourcePool       `json:"resources"`
	FactionInfluences    []FactionInfluence `json:"faction_influences"`
	ThreatScore          int64              `json:"threat_score"`
	ThreatLevel          ThreatLevel        `json:"threat_level"`
	RecentConflictScore  int64              `json:"recent_conflict_score"`
	Status               EcologicalStatus   `json:"status"`
	LastEventIntentEpoch uint64             `json:"last_event_intent_epoch"`
}

// Population models an abstract regional creature population.
// Total living population = FreePopulation + MaterializedPopulation.
type Population struct {
	PopulationID          string    `json:"population_id"`
	RegionID              string    `json:"region_id"`
	SpeciesID             string    `json:"species_id"`
	FamilyID              ai.Family `json:"family_id"`
	FactionID             string    `json:"faction_id"`
	FreePopulation        int64     `json:"free_population"`
	MaterializedPopulation int64    `json:"materialized_population"`
	CarryingCapacity      int64     `json:"carrying_capacity"`
	GrowthRateBP          int64     `json:"growth_rate_bp"`
	MortalityRateBP       int64     `json:"mortality_rate_bp"`
	GrowthResidualBP      int64     `json:"growth_residual_bp"`
	MortalityResidualBP   int64     `json:"mortality_residual_bp"`
	FoodPerCapitaMilli    int64     `json:"food_per_capita_milli"`
	WoodPerCapitaMilli    int64     `json:"wood_per_capita_milli"`
	OrePerCapitaMilli     int64     `json:"ore_per_capita_milli"`
	WaterPerCapitaMilli   int64     `json:"water_per_capita_milli"`
	StrengthPerIndividual int64     `json:"strength_per_individual"`
	ScarcityBP            int64     `json:"scarcity_bp"`
	MigrationPressureBP   int64     `json:"migration_pressure_bp"`
	ActiveCampCount       int       `json:"active_camp_count"`
}

// TotalSize returns FreePopulation + MaterializedPopulation safely.
func (p Population) TotalSize() (int64, error) {
	return safeAddInt64(p.FreePopulation, p.MaterializedPopulation)
}

// Camp models a dynamic regional creature camp tied to a population and faction.
type Camp struct {
	CampID                  string    `json:"camp_id"`
	RegionID                string    `json:"region_id"`
	FactionID               string    `json:"faction_id"`
	FamilyID                ai.Family `json:"family_id"`
	PopulationID            string    `json:"population_id"`
	AssignedPopulation      int64     `json:"assigned_population"`
	Capacity                int64     `json:"capacity"`
	Reserves                int64     `json:"reserves"`
	State                   CampState `json:"state"`
	ThreatContribution      int64     `json:"threat_contribution"`
	CreatedEpoch            uint64    `json:"created_epoch"`
	ExpansionCooldownEpochs int64     `json:"expansion_cooldown_epochs"`
	StarvationEpochs        int64     `json:"starvation_epochs"`
}

// Config holds versioned, purely integer configuration and operational safety caps.
type Config struct {
	Version                    uint32 `json:"version"`
	TicksPerEpoch              uint64 `json:"ticks_per_epoch"`
	MaxSnapshotBytes           int    `json:"max_snapshot_bytes"`
	MaxIdentifierLength        int    `json:"max_identifier_length"`
	MaxRegions                 int    `json:"max_regions"`
	MaxFactions                int    `json:"max_factions"`
	MaxPopulations             int    `json:"max_populations"`
	MaxCampsTotal              int    `json:"max_camps_total"`
	MaxCampsPerRegion          int    `json:"max_camps_per_region"`
	MaxCampsPerFaction         int    `json:"max_camps_per_faction"`
	MaxCommandsPerEpoch        int    `json:"max_commands_per_epoch"`
	MaxBirthsPerEpoch          int64  `json:"max_births_per_epoch"`
	StarvationMortalityBP      int64  `json:"starvation_mortality_bp"`
	OvercrowdingMortalityBP    int64  `json:"overcrowding_mortality_bp"`
	MigrationThresholdBP       int64  `json:"migration_threshold_bp"`
	MigrationShareBP           int64  `json:"migration_share_bp"`
	MinMigrationGroupSize      int64  `json:"min_migration_group_size"`
	MaxMigrantsPerEpoch        int64  `json:"max_migrants_per_epoch"`
	CampEstablishEpochs        uint64 `json:"camp_establish_epochs"`
	CampEstablishMinPop        int64  `json:"camp_establish_min_pop"`
	CampEstablishWoodCost      int64  `json:"camp_establish_wood_cost"`
	CampExpandWoodCost         int64  `json:"camp_expand_wood_cost"`
	CampExpandPopRatioBP       int64  `json:"camp_expand_pop_ratio_bp"`
	CampExpandCapacityGain     int64  `json:"camp_expand_capacity_gain"`
	CampMaxCapacity            int64  `json:"camp_max_capacity"`
	CampExpansionCooldown      int64  `json:"camp_expansion_cooldown"`
	CampAbandonStarveEpochs    int64  `json:"camp_abandon_starve_epochs"`
	CampRecreateCooldownEpochs uint64 `json:"camp_recreate_cooldown_epochs"`
	CompetitionAttritionBP     int64  `json:"competition_attrition_bp"`
	InfluenceShiftStepBP       int64  `json:"influence_shift_step_bp"`
	InfluenceEventThresholdBP  int64  `json:"influence_event_threshold_bp"`
	MaxRegionalThreat          int64  `json:"max_regional_threat"`
	ThreatGrowingEnter         int64  `json:"threat_growing_enter"`
	ThreatGrowingExit          int64  `json:"threat_growing_exit"`
	ThreatHostileEnter         int64  `json:"threat_hostile_enter"`
	ThreatHostileExit          int64  `json:"threat_hostile_exit"`
	ThreatCriticalEnter        int64  `json:"threat_critical_enter"`
	ThreatCriticalExit         int64  `json:"threat_critical_exit"`
	EventIntentCooldownEpochs  uint64 `json:"event_intent_cooldown_epochs"`
	ConflictDecayPerEpoch      int64  `json:"conflict_decay_per_epoch"`
}

// DefaultConfig returns balanced, provisional Cycle 03 ecosystem parameters.
func DefaultConfig() Config {
	return Config{
		Version:                    ConfigVersion,
		TicksPerEpoch:              20,
		MaxSnapshotBytes:           DefaultMaxSnapshotBytes,
		MaxIdentifierLength:        DefaultMaxIdentifierLength,
		MaxRegions:                 32,
		MaxFactions:                32,
		MaxPopulations:             128,
		MaxCampsTotal:              64,
		MaxCampsPerRegion:          6,
		MaxCampsPerFaction:         8,
		MaxCommandsPerEpoch:        64,
		MaxBirthsPerEpoch:          120,
		StarvationMortalityBP:      1800, // up to 18%/epoch under total scarcity
		OvercrowdingMortalityBP:    1200, // up to 12%/epoch when N > K
		MigrationThresholdBP:       4500, // 45% migration pressure triggers outflow
		MigrationShareBP:           2500, // up to 25% of free population migrates per epoch
		MinMigrationGroupSize:      5,
		MaxMigrantsPerEpoch:        80,
		CampEstablishEpochs:        2,
		CampEstablishMinPop:        30,
		CampEstablishWoodCost:      60,
		CampExpandWoodCost:         80,
		CampExpandPopRatioBP:       8000, // expand when population >= 80% of camp capacity
		CampExpandCapacityGain:     35,
		CampMaxCapacity:            180,
		CampExpansionCooldown:      4,
		CampAbandonStarveEpochs:    4,
		CampRecreateCooldownEpochs: 3,
		CompetitionAttritionBP:     450,  // up to 4.5% attrition per epoch between hostile rivals
		InfluenceShiftStepBP:       1500, // smooth 15%/epoch territorial influence shift
		InfluenceEventThresholdBP:  500,  // emit event when influence shifts >= 5% or leader flips
		MaxRegionalThreat:          2000,
		ThreatGrowingEnter:         400,
		ThreatGrowingExit:          260,
		ThreatHostileEnter:         900,
		ThreatHostileExit:          720,
		ThreatCriticalEnter:        1400,
		ThreatCriticalExit:         1150,
		EventIntentCooldownEpochs:  5,
		ConflictDecayPerEpoch:      40,
	}
}

// Validate checks all configuration limits, hysteresis ordering, and bounds.
func (c Config) Validate() error {
	if c.Version != ConfigVersion {
		return fmt.Errorf("%w: unsupported config version %d", ErrInvalidConfig, c.Version)
	}
	if c.TicksPerEpoch == 0 || c.MaxSnapshotBytes <= 0 || c.MaxIdentifierLength <= 0 {
		return fmt.Errorf("%w: ticks_per_epoch, max_snapshot_bytes, and max_identifier_length must be > 0", ErrInvalidConfig)
	}
	if c.MaxRegions <= 0 || c.MaxFactions <= 0 || c.MaxPopulations <= 0 || c.MaxCampsTotal <= 0 ||
		c.MaxCampsPerRegion <= 0 || c.MaxCampsPerFaction <= 0 || c.MaxCommandsPerEpoch <= 0 {
		return fmt.Errorf("%w: entity capacity limits must be > 0", ErrInvalidConfig)
	}
	if c.MaxBirthsPerEpoch < 0 || c.StarvationMortalityBP < 0 || c.StarvationMortalityBP > BasisPointsScale ||
		c.OvercrowdingMortalityBP < 0 || c.OvercrowdingMortalityBP > BasisPointsScale {
		return fmt.Errorf("%w: invalid population rate parameters", ErrInvalidConfig)
	}
	if c.MigrationThresholdBP < 0 || c.MigrationThresholdBP > BasisPointsScale ||
		c.MigrationShareBP < 0 || c.MigrationShareBP > BasisPointsScale ||
		c.MinMigrationGroupSize <= 0 || c.MaxMigrantsPerEpoch < 0 {
		return fmt.Errorf("%w: invalid migration parameters", ErrInvalidConfig)
	}
	if c.CampEstablishMinPop <= 0 || c.CampEstablishWoodCost < 0 || c.CampExpandWoodCost < 0 ||
		c.CampExpandPopRatioBP < 0 || c.CampExpandPopRatioBP > BasisPointsScale ||
		c.CampExpandCapacityGain <= 0 || c.CampMaxCapacity <= 0 ||
		c.CampExpansionCooldown < 0 || c.CampAbandonStarveEpochs <= 0 {
		return fmt.Errorf("%w: invalid camp parameters", ErrInvalidConfig)
	}
	if c.CompetitionAttritionBP < 0 || c.CompetitionAttritionBP > BasisPointsScale ||
		c.InfluenceShiftStepBP <= 0 || c.InfluenceShiftStepBP > BasisPointsScale ||
		c.InfluenceEventThresholdBP < 0 || c.ConflictDecayPerEpoch < 0 {
		return fmt.Errorf("%w: invalid territorial parameters", ErrInvalidConfig)
	}
	if c.MaxRegionalThreat <= 0 ||
		c.ThreatGrowingExit <= 0 || c.ThreatGrowingExit >= c.ThreatGrowingEnter ||
		c.ThreatGrowingEnter >= c.ThreatHostileExit || c.ThreatHostileExit >= c.ThreatHostileEnter ||
		c.ThreatHostileEnter >= c.ThreatCriticalExit || c.ThreatCriticalExit >= c.ThreatCriticalEnter ||
		c.ThreatCriticalEnter > c.MaxRegionalThreat {
		return fmt.Errorf("%w: invalid threat hysteresis bands", ErrInvalidConfig)
	}
	return nil
}

// CampCooldownRecord tracks cooldown after a camp is destroyed before recreating in the same region/faction.
type CampCooldownRecord struct {
	Key              string `json:"key"` // "<region_id>|<faction_id>"
	ReadyAtEpoch     uint64 `json:"ready_at_epoch"`
}

// EcosystemState is the complete, deterministic, serializable macro ecological state.
// All slices are maintained in strict canonical sorted order by stable ID.
type EcosystemState struct {
	SimulationID    string                     `json:"simulation_id"`
	Epoch           uint64                     `json:"epoch"`
	RNG             simulation.DeterministicRNG `json:"rng"`
	Factions        []FactionProfile           `json:"factions"`
	Regions         []Region                   `json:"regions"`
	Populations     []Population               `json:"populations"`
	Camps           []Camp                     `json:"camps"`
	CampCooldowns   []CampCooldownRecord       `json:"camp_cooldowns"`
	EventSeq        uint64                     `json:"event_seq"`
	CampSeq         uint64                     `json:"camp_seq"`
	PopSeq          uint64                     `json:"pop_seq"`
}

// Clone returns a deep copy of EcosystemState for atomic StepEpoch execution.
func (s EcosystemState) Clone() EcosystemState {
	out := s
	out.Factions = make([]FactionProfile, len(s.Factions))
	for i, f := range s.Factions {
		f.Relations = slices.Clone(f.Relations)
		if f.Relations == nil {
			f.Relations = []FactionRelation{}
		}
		out.Factions[i] = f
	}
	out.Regions = make([]Region, len(s.Regions))
	for i, r := range s.Regions {
		r.AdjacentRegions = slices.Clone(r.AdjacentRegions)
		if r.AdjacentRegions == nil {
			r.AdjacentRegions = []string{}
		}
		r.FactionInfluences = slices.Clone(r.FactionInfluences)
		if r.FactionInfluences == nil {
			r.FactionInfluences = []FactionInfluence{}
		}
		out.Regions[i] = r
	}
	out.Populations = slices.Clone(s.Populations)
	if out.Populations == nil {
		out.Populations = []Population{}
	}
	out.Camps = slices.Clone(s.Camps)
	if out.Camps == nil {
		out.Camps = []Camp{}
	}
	out.CampCooldowns = slices.Clone(s.CampCooldowns)
	if out.CampCooldowns == nil {
		out.CampCooldowns = []CampCooldownRecord{}
	}
	return out
}

// Validate enforces structural, referential, conservation, and capacity invariants.
func (s EcosystemState) Validate(cfg Config) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	if err := validateID(s.SimulationID, cfg.MaxIdentifierLength); err != nil {
		return fmt.Errorf("%w: simulation_id: %v", ErrInvalidState, err)
	}
	if len(s.Factions) > cfg.MaxFactions || len(s.Regions) > cfg.MaxRegions ||
		len(s.Populations) > cfg.MaxPopulations || len(s.Camps) > cfg.MaxCampsTotal {
		return fmt.Errorf("%w: state entity count exceeds config bounds", ErrCapacityExceeded)
	}

	factionSet := make(map[string]struct{}, len(s.Factions))
	for i, f := range s.Factions {
		if err := validateID(f.FactionID, cfg.MaxIdentifierLength); err != nil {
			return fmt.Errorf("%w: faction_id: %v", ErrInvalidState, err)
		}
		if i > 0 && s.Factions[i-1].FactionID >= f.FactionID {
			return fmt.Errorf("%w: factions not strictly sorted", ErrInvalidState)
		}
		if !f.DefaultStance.Valid() {
			return fmt.Errorf("%w: invalid faction stance %q", ErrInvalidState, f.DefaultStance)
		}
		factionSet[f.FactionID] = struct{}{}
	}
	for _, f := range s.Factions {
		for j, rel := range f.Relations {
			if j > 0 && f.Relations[j-1].TargetFactionID >= rel.TargetFactionID {
				return fmt.Errorf("%w: faction relations not strictly sorted", ErrInvalidState)
			}
			if _, ok := factionSet[rel.TargetFactionID]; !ok {
				return fmt.Errorf("%w: unknown relation target faction %q", ErrInvalidReference, rel.TargetFactionID)
			}
			if !rel.Stance.Valid() {
				return fmt.Errorf("%w: invalid relation stance %q", ErrInvalidState, rel.Stance)
			}
		}
	}

	regionSet := make(map[string]struct{}, len(s.Regions))
	for i, r := range s.Regions {
		if err := validateID(r.RegionID, cfg.MaxIdentifierLength); err != nil {
			return fmt.Errorf("%w: region_id: %v", ErrInvalidState, err)
		}
		if i > 0 && s.Regions[i-1].RegionID >= r.RegionID {
			return fmt.Errorf("%w: regions not strictly sorted", ErrInvalidState)
		}
		if !r.Biome.Valid() || !r.Status.Valid() || !r.ThreatLevel.Valid() {
			return fmt.Errorf("%w: invalid region enum in %q", ErrInvalidState, r.RegionID)
		}
		if r.CarryingCapacity < 0 || r.ThreatScore < 0 || r.ThreatScore > cfg.MaxRegionalThreat || r.RecentConflictScore < 0 {
			return fmt.Errorf("%w: invalid numeric bounds in region %q", ErrInvalidState, r.RegionID)
		}
		if err := r.Resources.Validate(); err != nil {
			return fmt.Errorf("region %q: %w", r.RegionID, err)
		}
		var totalInf int64
		for j, inf := range r.FactionInfluences {
			if j > 0 && r.FactionInfluences[j-1].FactionID >= inf.FactionID {
				return fmt.Errorf("%w: faction_influences not strictly sorted in region %q", ErrInvalidState, r.RegionID)
			}
			if _, ok := factionSet[inf.FactionID]; !ok {
				return fmt.Errorf("%w: unknown faction %q in region %q influences", ErrInvalidReference, inf.FactionID, r.RegionID)
			}
			if inf.InfluenceBP < 0 || inf.InfluenceBP > BasisPointsScale {
				return fmt.Errorf("%w: influence out of range in region %q", ErrInvalidState, r.RegionID)
			}
			totalInf += inf.InfluenceBP
		}
		if totalInf > BasisPointsScale {
			return fmt.Errorf("%w: region %q faction influence sum %d exceeds %d", ErrInvalidState, r.RegionID, totalInf, BasisPointsScale)
		}
		regionSet[r.RegionID] = struct{}{}
	}
	for _, r := range s.Regions {
		for j, adj := range r.AdjacentRegions {
			if j > 0 && r.AdjacentRegions[j-1] >= adj {
				return fmt.Errorf("%w: adjacent_regions not strictly sorted in %q", ErrInvalidState, r.RegionID)
			}
			if adj == r.RegionID {
				return fmt.Errorf("%w: region %q cannot be adjacent to itself", ErrInvalidReference, r.RegionID)
			}
			if _, ok := regionSet[adj]; !ok {
				return fmt.Errorf("%w: region %q references missing adjacent region %q", ErrInvalidReference, r.RegionID, adj)
			}
		}
	}

	popSet := make(map[string]Population, len(s.Populations))
	for i, p := range s.Populations {
		if err := validateID(p.PopulationID, cfg.MaxIdentifierLength); err != nil {
			return fmt.Errorf("%w: population_id: %v", ErrInvalidState, err)
		}
		if err := validateID(p.SpeciesID, cfg.MaxIdentifierLength); err != nil {
			return fmt.Errorf("%w: species_id: %v", ErrInvalidState, err)
		}
		if i > 0 && s.Populations[i-1].PopulationID >= p.PopulationID {
			return fmt.Errorf("%w: populations not strictly sorted", ErrInvalidState)
		}
		if _, ok := regionSet[p.RegionID]; !ok {
			return fmt.Errorf("%w: population %q references missing region %q", ErrInvalidReference, p.PopulationID, p.RegionID)
		}
		if _, ok := factionSet[p.FactionID]; !ok {
			return fmt.Errorf("%w: population %q references missing faction %q", ErrInvalidReference, p.PopulationID, p.FactionID)
		}
		if !p.FamilyID.Valid() {
			return fmt.Errorf("%w: population %q invalid family %q", ErrInvalidState, p.PopulationID, p.FamilyID)
		}
		if p.FreePopulation < 0 || p.MaterializedPopulation < 0 || p.CarryingCapacity < 0 {
			return fmt.Errorf("%w: population %q negative size or capacity", ErrInvalidState, p.PopulationID)
		}
		if _, err := p.TotalSize(); err != nil {
			return err
		}
		if p.GrowthRateBP < 0 || p.GrowthRateBP > BasisPointsScale ||
			p.MortalityRateBP < 0 || p.MortalityRateBP > BasisPointsScale ||
			p.GrowthResidualBP < 0 || p.GrowthResidualBP >= BasisPointsScale ||
			p.MortalityResidualBP < 0 || p.MortalityResidualBP >= BasisPointsScale ||
			p.ScarcityBP < 0 || p.ScarcityBP > BasisPointsScale ||
			p.MigrationPressureBP < 0 || p.MigrationPressureBP > BasisPointsScale {
			return fmt.Errorf("%w: population %q fixed-point BP field out of range", ErrInvalidState, p.PopulationID)
		}
		if p.FoodPerCapitaMilli < 0 || p.WoodPerCapitaMilli < 0 || p.OrePerCapitaMilli < 0 || p.WaterPerCapitaMilli < 0 || p.StrengthPerIndividual <= 0 || p.ActiveCampCount < 0 {
			return fmt.Errorf("%w: population %q invalid per-capita or strength field", ErrInvalidState, p.PopulationID)
		}
		popSet[p.PopulationID] = p
	}

	campsPerRegion := make(map[string]int, len(s.Regions))
	campsPerFaction := make(map[string]int, len(s.Factions))
	for i, c := range s.Camps {
		if err := validateID(c.CampID, cfg.MaxIdentifierLength); err != nil {
			return fmt.Errorf("%w: camp_id: %v", ErrInvalidState, err)
		}
		if i > 0 && s.Camps[i-1].CampID >= c.CampID {
			return fmt.Errorf("%w: camps not strictly sorted", ErrInvalidState)
		}
		if _, ok := regionSet[c.RegionID]; !ok {
			return fmt.Errorf("%w: camp %q references missing region %q", ErrInvalidReference, c.CampID, c.RegionID)
		}
		if _, ok := factionSet[c.FactionID]; !ok {
			return fmt.Errorf("%w: camp %q references missing faction %q", ErrInvalidReference, c.CampID, c.FactionID)
		}
		pop, ok := popSet[c.PopulationID]
		if !ok || pop.RegionID != c.RegionID || pop.FactionID != c.FactionID || pop.FamilyID != c.FamilyID {
			return fmt.Errorf("%w: camp %q population reference %q mismatch", ErrInvalidReference, c.CampID, c.PopulationID)
		}
		if !c.FamilyID.Valid() || !c.State.Valid() {
			return fmt.Errorf("%w: camp %q invalid family or state", ErrInvalidState, c.CampID)
		}
		if c.AssignedPopulation < 0 || c.Capacity <= 0 || c.Reserves < 0 || c.ThreatContribution < 0 || c.ExpansionCooldownEpochs < 0 || c.StarvationEpochs < 0 {
			return fmt.Errorf("%w: camp %q invalid numeric bounds", ErrInvalidState, c.CampID)
		}
		if c.State != CampAbandoned && c.State != CampDestroyed {
			campsPerRegion[c.RegionID]++
			campsPerFaction[c.FactionID]++
			if campsPerRegion[c.RegionID] > cfg.MaxCampsPerRegion || campsPerFaction[c.FactionID] > cfg.MaxCampsPerFaction {
				return fmt.Errorf("%w: active camp cap exceeded in region %q or faction %q", ErrCapacityExceeded, c.RegionID, c.FactionID)
			}
		}
	}

	for i, cd := range s.CampCooldowns {
		if strings.TrimSpace(cd.Key) == "" {
			return fmt.Errorf("%w: empty camp cooldown key", ErrInvalidState)
		}
		if i > 0 && s.CampCooldowns[i-1].Key >= cd.Key {
			return fmt.Errorf("%w: camp_cooldowns not strictly sorted", ErrInvalidState)
		}
	}
	return nil
}

// Checksum computes a canonical architecture-independent SHA-256 hash of EcosystemState.
func (s EcosystemState) Checksum(cfg Config) (string, error) {
	if err := s.Validate(cfg); err != nil {
		return "", err
	}
	h := simulation.NewCanonicalHasher()
	h.WriteString(s.SimulationID)
	h.WriteUint64(s.Epoch)
	h.WriteUint64(s.RNG.State)

	h.WriteUint64(uint64(len(s.Factions)))
	for _, f := range s.Factions {
		h.WriteString(f.FactionID)
		h.WriteString(f.Name)
		h.WriteBool(f.HostileToSettlement)
		h.WriteUint8(f.DefaultStance.Code())
		h.WriteUint64(uint64(len(f.Relations)))
		for _, rel := range f.Relations {
			h.WriteString(rel.TargetFactionID)
			h.WriteUint8(rel.Stance.Code())
		}
	}

	h.WriteUint64(uint64(len(s.Regions)))
	for _, r := range s.Regions {
		h.WriteString(r.RegionID)
		h.WriteString(r.Name)
		h.WriteUint8(r.Biome.Code())
		h.WriteBool(r.HasSettlement)
		h.WriteString(r.SettlementID)
		h.WriteInt64(r.CarryingCapacity)
		h.WriteUint64(uint64(len(r.AdjacentRegions)))
		for _, adj := range r.AdjacentRegions {
			h.WriteString(adj)
		}
		writeResourceSlot(h, r.Resources.Food)
		writeResourceSlot(h, r.Resources.Wood)
		writeResourceSlot(h, r.Resources.Stone)
		writeResourceSlot(h, r.Resources.Ore)
		writeResourceSlot(h, r.Resources.Water)
		h.WriteUint64(uint64(len(r.FactionInfluences)))
		for _, inf := range r.FactionInfluences {
			h.WriteString(inf.FactionID)
			h.WriteInt64(inf.InfluenceBP)
		}
		h.WriteInt64(r.ThreatScore)
		h.WriteUint8(r.ThreatLevel.Code())
		h.WriteInt64(r.RecentConflictScore)
		h.WriteUint8(r.Status.Code())
		h.WriteUint64(r.LastEventIntentEpoch)
	}

	h.WriteUint64(uint64(len(s.Populations)))
	for _, p := range s.Populations {
		h.WriteString(p.PopulationID)
		h.WriteString(p.RegionID)
		h.WriteString(p.SpeciesID)
		h.WriteUint8(p.FamilyID.Code())
		h.WriteString(p.FactionID)
		h.WriteInt64(p.FreePopulation)
		h.WriteInt64(p.MaterializedPopulation)
		h.WriteInt64(p.CarryingCapacity)
		h.WriteInt64(p.GrowthRateBP)
		h.WriteInt64(p.MortalityRateBP)
		h.WriteInt64(p.GrowthResidualBP)
		h.WriteInt64(p.MortalityResidualBP)
		h.WriteInt64(p.FoodPerCapitaMilli)
		h.WriteInt64(p.WoodPerCapitaMilli)
		h.WriteInt64(p.OrePerCapitaMilli)
		h.WriteInt64(p.WaterPerCapitaMilli)
		h.WriteInt64(p.StrengthPerIndividual)
		h.WriteInt64(p.ScarcityBP)
		h.WriteInt64(p.MigrationPressureBP)
		h.WriteInt64(int64(p.ActiveCampCount))
	}

	h.WriteUint64(uint64(len(s.Camps)))
	for _, c := range s.Camps {
		h.WriteString(c.CampID)
		h.WriteString(c.RegionID)
		h.WriteString(c.FactionID)
		h.WriteUint8(c.FamilyID.Code())
		h.WriteString(c.PopulationID)
		h.WriteInt64(c.AssignedPopulation)
		h.WriteInt64(c.Capacity)
		h.WriteInt64(c.Reserves)
		h.WriteUint8(c.State.Code())
		h.WriteInt64(c.ThreatContribution)
		h.WriteUint64(c.CreatedEpoch)
		h.WriteInt64(c.ExpansionCooldownEpochs)
		h.WriteInt64(c.StarvationEpochs)
	}

	h.WriteUint64(uint64(len(s.CampCooldowns)))
	for _, cd := range s.CampCooldowns {
		h.WriteString(cd.Key)
		h.WriteUint64(cd.ReadyAtEpoch)
	}

	h.WriteUint64(s.EventSeq)
	h.WriteUint64(s.CampSeq)
	h.WriteUint64(s.PopSeq)
	return h.SumHex(), nil
}

func writeResourceSlot(h *simulation.CanonicalHasher, r ResourceSlot) {
	h.WriteInt64(r.Amount)
	h.WriteInt64(r.MaxCapacity)
	h.WriteInt64(r.RegenPerEpoch)
	h.WriteInt64(r.RegenRateBP)
	h.WriteInt64(r.ExtractionLimit)
}

// MarshalSnapshot encodes EcosystemState into a versioned snapshot envelope with canonical checksum.
func (s EcosystemState) MarshalSnapshot(cfg Config) ([]byte, error) {
	sum, err := s.Checksum(cfg)
	if err != nil {
		return nil, err
	}
	raw, err := simulation.EncodeSnapshot(s, sum)
	if err != nil {
		return nil, err
	}
	if len(raw) > cfg.MaxSnapshotBytes {
		return nil, fmt.Errorf("%w: encoded size %d exceeds limit %d", simulation.ErrSnapshotTooLarge, len(raw), cfg.MaxSnapshotBytes)
	}
	return raw, nil
}

// UnmarshalSnapshot enforces byte-size limits BEFORE JSON decoding, validates schema version,
// checks all entity/reference/capacity bounds, and verifies the canonical SHA-256 checksum.
func UnmarshalSnapshot(data []byte, cfg Config) (EcosystemState, error) {
	if err := cfg.Validate(); err != nil {
		return EcosystemState{}, err
	}
	opts := simulation.DecodeOptions{MaxBytes: cfg.MaxSnapshotBytes}
	return simulation.DecodeSnapshotWithOptions(data, opts, func(st EcosystemState) (string, error) {
		return st.Checksum(cfg)
	})
}

// EventType enumerates deterministic internal ecological domain events.
type EventType string

const (
	EventPopulationGrew             EventType = "PopulationGrew"
	EventPopulationDeclined         EventType = "PopulationDeclined"
	EventResourceDepleted           EventType = "ResourceDepleted"
	EventResourceRegenerated        EventType = "ResourceRegenerated"
	EventCampEstablished            EventType = "CampEstablished"
	EventCampExpanded               EventType = "CampExpanded"
	EventCampAbandoned              EventType = "CampAbandoned"
	EventCampDestroyed              EventType = "CampDestroyed"
	EventPopulationMigrated         EventType = "PopulationMigrated"
	EventTerritorialInfluenceChanged EventType = "TerritorialInfluenceChanged"
	EventRegionalThreatChanged      EventType = "RegionalThreatChanged"
	EventCreatureGroupMaterialized  EventType = "CreatureGroupMaterialized"
	EventCreatureGroupDematerialized EventType = "CreatureGroupDematerialized"
)

// EcologicalEvent represents an immutable deterministic event emitted during an epoch or handoff.
type EcologicalEvent struct {
	EventID    string    `json:"event_id"`
	Type       EventType `json:"type"`
	RegionID   string    `json:"region_id"`
	Epoch      uint64    `json:"epoch"`
	EntityID   string    `json:"entity_id"`
	TargetID   string    `json:"target_id,omitempty"`
	Detail     string    `json:"detail,omitempty"`
	Amount     int64     `json:"amount,omitempty"`
}

// CommandKind enumerates explicit ecological epoch commands.
type CommandKind string

const (
	CmdDestroyCamp       CommandKind = "DestroyCamp"
	CmdAdjustResource    CommandKind = "AdjustResource"
	CmdEstablishCamp     CommandKind = "EstablishCamp"
	CmdApplyConflictLoss CommandKind = "ApplyConflictLoss"
)

// Command carries an explicit, authoritatively validated input targeting a single epoch.
type Command struct {
	Kind         CommandKind `json:"kind"`
	Epoch        uint64      `json:"epoch"`
	RegionID     string      `json:"region_id,omitempty"`
	PopulationID string      `json:"population_id,omitempty"`
	CampID       string      `json:"camp_id,omitempty"`
	ResourceName string      `json:"resource_name,omitempty"`
	Delta        int64       `json:"delta,omitempty"`
}

// CanonicalizeCommands orders epoch commands deterministically independent of caller order.
func CanonicalizeCommands(cmds []Command) []Command {
	if len(cmds) <= 1 {
		return slices.Clone(cmds)
	}
	out := slices.Clone(cmds)
	slices.SortStableFunc(out, func(a, b Command) int {
		if c := strings.Compare(string(a.Kind), string(b.Kind)); c != 0 {
			return c
		}
		if c := strings.Compare(a.RegionID, b.RegionID); c != 0 {
			return c
		}
		if c := strings.Compare(a.PopulationID, b.PopulationID); c != 0 {
			return c
		}
		if c := strings.Compare(a.CampID, b.CampID); c != 0 {
			return c
		}
		if c := strings.Compare(a.ResourceName, b.ResourceName); c != 0 {
			return c
		}
		if a.Delta < b.Delta {
			return -1
		}
		if a.Delta > b.Delta {
			return 1
		}
		return 0
	})
	return out
}

func validateID(id string, maxLen int) error {
	trimmed := strings.TrimSpace(id)
	if trimmed == "" {
		return errors.New("empty identifier")
	}
	if len(id) > maxLen {
		return fmt.Errorf("identifier length %d exceeds max %d", len(id), maxLen)
	}
	return nil
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

func (s *EcosystemState) newEvent(evType EventType, regionID, entityID, targetID, detail string, amount int64) (EcologicalEvent, error) {
	if s.EventSeq == math.MaxUint64 {
		return EcologicalEvent{}, ErrNumericOverflow
	}
	s.EventSeq++
	return EcologicalEvent{
		EventID:  fmt.Sprintf("eco:%s:ep:%d:seq:%d:%s", s.SimulationID, s.Epoch, s.EventSeq, evType),
		Type:     evType,
		RegionID: regionID,
		Epoch:    s.Epoch,
		EntityID: entityID,
		TargetID: targetID,
		Detail:   detail,
		Amount:   amount,
	}, nil
}

func findRegionIndex(regions []Region, id string) int {
	idx, ok := slices.BinarySearchFunc(regions, id, func(r Region, k string) int {
		return strings.Compare(r.RegionID, k)
	})
	if !ok {
		return -1
	}
	return idx
}

func findFactionIndex(factions []FactionProfile, id string) int {
	idx, ok := slices.BinarySearchFunc(factions, id, func(f FactionProfile, k string) int {
		return strings.Compare(f.FactionID, k)
	})
	if !ok {
		return -1
	}
	return idx
}

func findPopulationIndex(pops []Population, id string) int {
	idx, ok := slices.BinarySearchFunc(pops, id, func(p Population, k string) int {
		return strings.Compare(p.PopulationID, k)
	})
	if !ok {
		return -1
	}
	return idx
}

func findCampIndex(camps []Camp, id string) int {
	idx, ok := slices.BinarySearchFunc(camps, id, func(c Camp, k string) int {
		return strings.Compare(c.CampID, k)
	})
	if !ok {
		return -1
	}
	return idx
}

// GetStance resolves the explicit diplomatic stance between two factions symmetrically.
func GetStance(factions []FactionProfile, aID, bID string) FactionStance {
	if aID == bID {
		return StanceAllied
	}
	idxA := findFactionIndex(factions, aID)
	if idxA >= 0 {
		for _, rel := range factions[idxA].Relations {
			if rel.TargetFactionID == bID {
				return rel.Stance
			}
		}
	}
	idxB := findFactionIndex(factions, bID)
	if idxB >= 0 {
		for _, rel := range factions[idxB].Relations {
			if rel.TargetFactionID == aID {
				return rel.Stance
			}
		}
		if factions[idxB].DefaultStance == StanceHostile {
			return StanceHostile
		}
	}
	if idxA >= 0 {
		return factions[idxA].DefaultStance
	}
	return StanceNeutral
}
