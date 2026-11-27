package siege

import (
	"fmt"
	"slices"
	"strings"

	"ascendra-game/internal/ai"
)

// Canonical provisional zone IDs for Cycle 05 settlement siege layouts.
const (
	ZoneIDExteriorField  = "zone-01-exterior-field"
	ZoneIDWallApproach   = "zone-02-wall-approach"
	ZoneIDMainGate       = "zone-03-main-gate"
	ZoneIDOuterDistrict  = "zone-04-outer-district"
	ZoneIDSupplyDistrict = "zone-05-supply-district"
	ZoneIDCivilDistrict  = "zone-06-civil-district"
	ZoneIDCentralSquare  = "zone-07-central-square"
	ZoneIDCitadel        = "zone-08-citadel"
)

// Canonical provisional structure IDs for Cycle 05 settlement siege layouts.
const (
	StructIDMainGate    = "str-01-main-gate"
	StructIDOuterWall   = "str-02-outer-wall"
	StructIDNorthTower  = "str-03-north-tower"
	StructIDSupplyDepot = "str-04-supply-depot"
	StructIDCitadelKeep = "str-05-citadel-keep"
)

// Canonical provisional strategic objective IDs for Cycle 05 settlement siege layouts.
const (
	ObjIDDefendGate          = "obj-def-01-defend-gate"
	ObjIDRepairFortification = "obj-def-02-repair-fortification"
	ObjIDProtectSupplies     = "obj-def-03-protect-supplies"
	ObjIDHoldDistrict        = "obj-def-04-hold-outer-district"
	ObjIDDefeatCommander     = "obj-def-05-defeat-commander"

	ObjIDDestroyGate     = "obj-inv-01-destroy-gate"
	ObjIDOpenBreach      = "obj-inv-02-open-breach"
	ObjIDCaptureDistrict = "obj-inv-03-capture-outer-district"
	ObjIDDisruptSupplies = "obj-inv-04-disrupt-supplies"
	ObjIDAssaultCitadel  = "obj-inv-05-assault-citadel"
)

// DefaultValewatchLayout returns the provisional fortified layout for settlement-valewatch.
// Total structure MaxHP == 1000, matching ports.SettlementSnapshot.MaxDefenseHP exactly so
// SettlementDefenseHP remains a single derived source of truth.
func DefaultValewatchLayout() SettlementLayout {
	return buildStandardLayout("layout-valewatch-bastion", "settlement-valewatch", "region-ashvale", 240, 260, 140, 120, 240, 150)
}

// DefaultIronfordLayout returns the provisional fortified layout for settlement-ironford.
// Total structure MaxHP == 1500, matching ports.SettlementSnapshot.MaxDefenseHP exactly.
func DefaultIronfordLayout() SettlementLayout {
	return buildStandardLayout("layout-ironford-citadel", "settlement-ironford", "region-thornreach", 360, 400, 220, 160, 360, 200)
}

// LookupProvisionalLayout selects a deterministic provisional layout for a settlement ID.
func LookupProvisionalLayout(settlementID, regionID string, targetTotalHP int64) SettlementLayout {
	switch settlementID {
	case "settlement-valewatch":
		if targetTotalHP == 0 || targetTotalHP == 1000 {
			return DefaultValewatchLayout()
		}
	case "settlement-ironford":
		if targetTotalHP == 0 || targetTotalHP == 1500 {
			return DefaultIronfordLayout()
		}
	}
	if targetTotalHP < 100 {
		targetTotalHP = 1000
	}
	// Deterministic proportional integer allocation preserving exact sum == targetTotalHP.
	gateHP := (targetTotalHP * 24) / 100
	wallHP := (targetTotalHP * 26) / 100
	towerHP := (targetTotalHP * 14) / 100
	depotHP := (targetTotalHP * 12) / 100
	citadelHP := targetTotalHP - gateHP - wallHP - towerHP - depotHP
	if regionID == "" {
		regionID = "region-ashvale"
	}
	return buildStandardLayout("layout-"+settlementID, settlementID, regionID, gateHP, wallHP, towerHP, depotHP, citadelHP, 150)
}

func buildStandardLayout(
	layoutID, settlementID, regionID string,
	gateHP, wallHP, towerHP, depotHP, citadelHP, initialSupplies int64,
) SettlementLayout {
	return SettlementLayout{
		LayoutID:        layoutID,
		SettlementID:    settlementID,
		RegionID:        regionID,
		RulesVersion:    RulesVersion,
		InitialSupplies: initialSupplies,
		Zones: []Zone{
			{ZoneID: ZoneIDExteriorField, Kind: ZoneExteriorField, Name: "Exterior Field", Depth: 0, PositionHint: 12000, Capturable: false, ControlState: DistrictNeutralized},
			{ZoneID: ZoneIDWallApproach, Kind: ZoneWallApproach, Name: "Wall Approach", Depth: 1, PositionHint: 9000, Capturable: false, ControlState: DistrictNeutralized},
			{ZoneID: ZoneIDMainGate, Kind: ZoneMainGate, Name: "Main Gate", Depth: 2, PositionHint: 6500, Capturable: false, ControlState: DistrictDefenderControlled},
			{ZoneID: ZoneIDOuterDistrict, Kind: ZoneOuterDistrict, Name: "Outer District", Depth: 3, PositionHint: 4500, Capturable: true, ControlState: DistrictDefenderControlled},
			{ZoneID: ZoneIDSupplyDistrict, Kind: ZoneSupplyDistrict, Name: "Supply District", Depth: 4, PositionHint: 3200, Capturable: true, ControlState: DistrictDefenderControlled},
			{ZoneID: ZoneIDCivilDistrict, Kind: ZoneCivilDistrict, Name: "Civil District", Depth: 4, PositionHint: 2800, Capturable: true, ControlState: DistrictDefenderControlled},
			{ZoneID: ZoneIDCentralSquare, Kind: ZoneCentralSquare, Name: "Central Square", Depth: 5, PositionHint: 1800, Capturable: true, ControlState: DistrictDefenderControlled},
			{ZoneID: ZoneIDCitadel, Kind: ZoneCitadel, Name: "Citadel", Depth: 6, PositionHint: 0, Capturable: true, ControlState: DistrictDefenderControlled},
		},
		Connections: []ZoneConnection{
			{ConnectionID: "conn-01-ext-approach", FromZoneID: ZoneIDExteriorField, ToZoneID: ZoneIDWallApproach, Bidirectional: true, Rule: ConnAlwaysOpen},
			{ConnectionID: "conn-02-approach-gate", FromZoneID: ZoneIDWallApproach, ToZoneID: ZoneIDMainGate, Bidirectional: true, Rule: ConnAlwaysOpen},
			{ConnectionID: "conn-03-gate-outer", FromZoneID: ZoneIDMainGate, ToZoneID: ZoneIDOuterDistrict, Bidirectional: true, Rule: ConnRequiresStructureCompromised, BlockerStructureID: StructIDMainGate},
			{ConnectionID: "conn-04-wall-breach", FromZoneID: ZoneIDWallApproach, ToZoneID: ZoneIDOuterDistrict, Bidirectional: true, Rule: ConnRequiresStructureCompromised, BlockerStructureID: StructIDOuterWall},
			{ConnectionID: "conn-05-outer-supply", FromZoneID: ZoneIDOuterDistrict, ToZoneID: ZoneIDSupplyDistrict, Bidirectional: true, Rule: ConnAlwaysOpen},
			{ConnectionID: "conn-06-outer-civil", FromZoneID: ZoneIDOuterDistrict, ToZoneID: ZoneIDCivilDistrict, Bidirectional: true, Rule: ConnAlwaysOpen},
			{ConnectionID: "conn-07-outer-square", FromZoneID: ZoneIDOuterDistrict, ToZoneID: ZoneIDCentralSquare, Bidirectional: true, Rule: ConnAlwaysOpen},
			{ConnectionID: "conn-08-supply-square", FromZoneID: ZoneIDSupplyDistrict, ToZoneID: ZoneIDCentralSquare, Bidirectional: true, Rule: ConnAlwaysOpen},
			{ConnectionID: "conn-09-civil-square", FromZoneID: ZoneIDCivilDistrict, ToZoneID: ZoneIDCentralSquare, Bidirectional: true, Rule: ConnAlwaysOpen},
			{ConnectionID: "conn-10-square-citadel", FromZoneID: ZoneIDCentralSquare, ToZoneID: ZoneIDCitadel, Bidirectional: true, Rule: ConnAlwaysOpen},
		},
		Structures: []Structure{
			{StructureID: StructIDMainGate, Kind: StructureGate, ZoneID: ZoneIDMainGate, HP: gateHP, MaxHP: gateHP, ResistanceBP: 2000, ArmorFlat: 10, BreachThresholdBP: 0, State: StructureIntact},
			{StructureID: StructIDOuterWall, Kind: StructureWall, ZoneID: ZoneIDWallApproach, HP: wallHP, MaxHP: wallHP, ResistanceBP: 3000, ArmorFlat: 15, BreachThresholdBP: 5000, State: StructureIntact},
			{StructureID: StructIDNorthTower, Kind: StructureTower, ZoneID: ZoneIDMainGate, HP: towerHP, MaxHP: towerHP, ResistanceBP: 1500, ArmorFlat: 8, BreachThresholdBP: 0, State: StructureIntact, AttackRangeZones: 1},
			{StructureID: StructIDSupplyDepot, Kind: StructureSupplyDepot, ZoneID: ZoneIDSupplyDistrict, HP: depotHP, MaxHP: depotHP, ResistanceBP: 1000, ArmorFlat: 5, BreachThresholdBP: 0, State: StructureIntact},
			{StructureID: StructIDCitadelKeep, Kind: StructureCitadel, ZoneID: ZoneIDCitadel, HP: citadelHP, MaxHP: citadelHP, ResistanceBP: 2500, ArmorFlat: 12, BreachThresholdBP: 0, State: StructureIntact},
		},
		Objectives: []Objective{
			{ObjectiveID: ObjIDDefendGate, Side: SideDefense, Kind: ObjDefendGate, ZoneID: ZoneIDMainGate, TargetStructureID: StructIDMainGate, State: ObjActive, TargetProgress: 1},
			{ObjectiveID: ObjIDRepairFortification, Side: SideDefense, Kind: ObjRepairFortification, ZoneID: ZoneIDMainGate, TargetStructureID: StructIDMainGate, State: ObjActive, TargetProgress: 1},
			{ObjectiveID: ObjIDProtectSupplies, Side: SideDefense, Kind: ObjProtectSupplies, ZoneID: ZoneIDSupplyDistrict, TargetStructureID: StructIDSupplyDepot, State: ObjActive, TargetProgress: 1},
			{ObjectiveID: ObjIDHoldDistrict, Side: SideDefense, Kind: ObjHoldDistrict, ZoneID: ZoneIDOuterDistrict, State: ObjActive, TargetProgress: 1},
			{ObjectiveID: ObjIDDefeatCommander, Side: SideDefense, Kind: ObjDefeatCommander, ZoneID: ZoneIDWallApproach, State: ObjActive, TargetProgress: 1},

			{ObjectiveID: ObjIDDestroyGate, Side: SideInvasion, Kind: ObjDestroyGate, ZoneID: ZoneIDMainGate, TargetStructureID: StructIDMainGate, State: ObjActive, TargetProgress: gateHP},
			{ObjectiveID: ObjIDOpenBreach, Side: SideInvasion, Kind: ObjOpenBreach, ZoneID: ZoneIDWallApproach, TargetStructureID: StructIDOuterWall, State: ObjActive, TargetProgress: 1},
			{ObjectiveID: ObjIDCaptureDistrict, Side: SideInvasion, Kind: ObjCaptureDistrict, ZoneID: ZoneIDOuterDistrict, PrerequisiteIDs: []string{ObjIDOpenBreach}, State: ObjLocked, TargetProgress: 100},
			{ObjectiveID: ObjIDDisruptSupplies, Side: SideInvasion, Kind: ObjDisruptSupplies, ZoneID: ZoneIDSupplyDistrict, TargetStructureID: StructIDSupplyDepot, PrerequisiteIDs: []string{ObjIDOpenBreach}, State: ObjLocked, TargetProgress: depotHP},
			{ObjectiveID: ObjIDAssaultCitadel, Side: SideInvasion, Kind: ObjAssaultCitadel, ZoneID: ZoneIDCitadel, TargetStructureID: StructIDCitadelKeep, PrerequisiteIDs: []string{ObjIDCaptureDistrict}, State: ObjLocked, TargetProgress: citadelHP},
		},
		DefenderRoster: []NPCDefenderSpec{
			{DefenderID: "npc-gate-sentinel", Role: RoleGateDefender, ZoneID: ZoneIDMainGate, MaxHP: 340},
			{DefenderID: "npc-wall-archer", Role: RoleArcher, ZoneID: ZoneIDMainGate, MaxHP: 240},
			{DefenderID: "npc-outer-guard", Role: RoleGuard, ZoneID: ZoneIDOuterDistrict, MaxHP: 300},
			{DefenderID: "npc-guard-captain", Role: RoleGuardCaptain, ZoneID: ZoneIDCentralSquare, MaxHP: 420},
			{DefenderID: "npc-siege-sapper", Role: RoleRepairUnit, ZoneID: ZoneIDSupplyDistrict, MaxHP: 260},
		},
	}
}

// DefaultCommanderForFamily returns a provisional original ASCENDRA siege commander profile
// linked to an existing Creature AI commander archetype.
func DefaultCommanderForFamily(family ai.Family) CommanderState {
	if family == ai.FamilyOrc {
		return CommanderState{
			CommanderID:         "cmdr-ghorvak",
			DisplayName:         "Ghorvak, Punho de Ferro",
			Family:              ai.FamilyOrc,
			Archetype:           "orc-warchief",
			MoraleAuraBonusBP:   1200,
			SiegeDamageBonusBP:  2000,
			PriorityObjectiveID: ObjIDDestroyGate,
			Alive:               false,
			Deployed:            false,
		}
	}
	return CommanderState{
		CommanderID:         "cmdr-skarv",
		DisplayName:         "Skarv, o Rompe-Portões",
		Family:              ai.FamilyGoblin,
		Archetype:           "goblin-taskmaster",
		MoraleAuraBonusBP:   900,
		SiegeDamageBonusBP:  1500,
		PriorityObjectiveID: ObjIDDisruptSupplies,
		Alive:               false,
		Deployed:            false,
	}
}

// ValidateLayout validates a SettlementLayout blueprint and checks graph connectivity
// from ExteriorField to Citadel (considering breachable connections).
func ValidateLayout(layout SettlementLayout, cfg Config) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	if len(layout.DefenderRoster) > cfg.MaxNPCDefenders {
		return fmt.Errorf("%w: defender roster %d exceeds max_npc_defenders %d", ErrCapacityExceeded, len(layout.DefenderRoster), cfg.MaxNPCDefenders)
	}
	st, err := NewSiegeStateFromLayout(layout, cfg, "", "", "", false, 0)
	if err != nil {
		return err
	}
	// Verify graph topology has at least one structural path from ExteriorField to Citadel.
	extZone := st.FindZoneByKind(ZoneExteriorField)
	citZone := st.FindZoneByKind(ZoneCitadel)
	if extZone == nil || citZone == nil {
		return fmt.Errorf("%w: missing exterior or citadel zone", ErrInvalidLayout)
	}
	if ZoneHopDistance(st, extZone.ZoneID, citZone.ZoneID) < 0 {
		return fmt.Errorf("%w: citadel %q is unreachable from exterior %q", ErrInvalidLayout, citZone.ZoneID, extZone.ZoneID)
	}
	// Validate initial defender specs.
	seenDef := make(map[string]struct{}, len(layout.DefenderRoster))
	for _, d := range layout.DefenderRoster {
		if err := validateID(d.DefenderID, cfg.MaxIdentifierLength); err != nil {
			return fmt.Errorf("%w: defender_id: %v", ErrInvalidLayout, err)
		}
		if _, dup := seenDef[d.DefenderID]; dup {
			return fmt.Errorf("%w: duplicate defender_id %q", ErrInvalidLayout, d.DefenderID)
		}
		seenDef[d.DefenderID] = struct{}{}
		if !d.Role.Valid() || !d.Role.IsNPC() || d.MaxHP <= 0 {
			return fmt.Errorf("%w: invalid NPC defender spec %q", ErrInvalidLayout, d.DefenderID)
		}
		if st.FindZoneIndex(d.ZoneID) < 0 {
			return fmt.Errorf("%w: defender %q references unknown zone %q", ErrInvalidLayout, d.DefenderID, d.ZoneID)
		}
	}
	return nil
}

// NewSiegeStateFromLayout constructs a canonically sorted, validated SiegeState from a layout.
func NewSiegeStateFromLayout(
	layout SettlementLayout,
	cfg Config,
	campaignID string,
	invadingFactionID string,
	invadingFamily ai.Family,
	isReconquest bool,
	startTick uint64,
) (SiegeState, error) {
	if err := cfg.Validate(); err != nil {
		return SiegeState{}, err
	}
	zones := slices.Clone(layout.Zones)
	slices.SortFunc(zones, func(a, b Zone) int { return strings.Compare(a.ZoneID, b.ZoneID) })

	conns := slices.Clone(layout.Connections)
	slices.SortFunc(conns, func(a, b ZoneConnection) int { return strings.Compare(a.ConnectionID, b.ConnectionID) })

	structs := slices.Clone(layout.Structures)
	slices.SortFunc(structs, func(a, b Structure) int { return strings.Compare(a.StructureID, b.StructureID) })

	objs := make([]Objective, len(layout.Objectives))
	for i, o := range layout.Objectives {
		copyO := o
		copyO.PrerequisiteIDs = slices.Clone(o.PrerequisiteIDs)
		slices.Sort(copyO.PrerequisiteIDs)
		objs[i] = copyO
	}
	slices.SortFunc(objs, func(a, b Objective) int { return strings.Compare(a.ObjectiveID, b.ObjectiveID) })

	supplies := layout.InitialSupplies
	if supplies <= 0 {
		supplies = 150
	}
	if supplies > cfg.MaxSupplies {
		supplies = cfg.MaxSupplies
	}

	commanders := []CommanderState{}
	if invadingFamily.Valid() {
		cmdr := DefaultCommanderForFamily(invadingFamily)
		// Clear PriorityObjectiveID if layout omitted that objective.
		hasPrio := false
		for _, o := range objs {
			if o.ObjectiveID == cmdr.PriorityObjectiveID {
				hasPrio = true
				break
			}
		}
		if !hasPrio {
			cmdr.PriorityObjectiveID = ""
		}
		commanders = append(commanders, cmdr)
	}

	st := SiegeState{
		LayoutID:          layout.LayoutID,
		SettlementID:      layout.SettlementID,
		RegionID:          layout.RegionID,
		RulesVersion:      cfg.RulesVersion,
		CampaignID:        campaignID,
		InvadingFactionID: invadingFactionID,
		InvadingFamily:    invadingFamily,
		IsReconquest:      isReconquest,
		Phase:             PhaseApproach,
		StartedTick:       startTick,
		PhaseStartedTick:  startTick,
		LastProgressTick:  startTick,
		Zones:             zones,
		Connections:       conns,
		Structures:        structs,
		Objectives:        objs,
		Commanders:        commanders,
		Waves:             []SiegeWave{},
		Supplies: SiegeSupplies{
			Current:          supplies,
			Max:              cfg.MaxSupplies,
			TotalSpent:       0,
			TotalRegenerated: 0,
			MaxTotalRegen:    cfg.MaxSupplyRegenTotal,
			LastRegenTick:    startTick,
		},
		EntityRepairs: []EntityRepairCount{},
		Config:        cfg,
	}
	if err := st.ValidateWithConfig(cfg); err != nil {
		return SiegeState{}, err
	}
	return st, nil
}

// FindZoneIndex returns the canonical sorted index of zoneID or -1.
func (s SiegeState) FindZoneIndex(zoneID string) int {
	idx, ok := slices.BinarySearchFunc(s.Zones, zoneID, func(z Zone, id string) int {
		return strings.Compare(z.ZoneID, id)
	})
	if !ok {
		return -1
	}
	return idx
}

// FindZoneByKind returns the first canonically sorted zone matching kind or nil.
func (s SiegeState) FindZoneByKind(kind ZoneKind) *Zone {
	for i := range s.Zones {
		if s.Zones[i].Kind == kind {
			z := s.Zones[i]
			return &z
		}
	}
	return nil
}

// FindStructureIndex returns the canonical sorted index of structureID or -1.
func (s SiegeState) FindStructureIndex(structureID string) int {
	idx, ok := slices.BinarySearchFunc(s.Structures, structureID, func(st Structure, id string) int {
		return strings.Compare(st.StructureID, id)
	})
	if !ok {
		return -1
	}
	return idx
}

// FindObjectiveIndex returns the canonical sorted index of objectiveID or -1.
func (s SiegeState) FindObjectiveIndex(objectiveID string) int {
	idx, ok := slices.BinarySearchFunc(s.Objectives, objectiveID, func(o Objective, id string) int {
		return strings.Compare(o.ObjectiveID, id)
	})
	if !ok {
		return -1
	}
	return idx
}

// FindWaveIndex returns the canonical sorted index of waveID or -1.
func (s SiegeState) FindWaveIndex(waveID string) int {
	idx, ok := slices.BinarySearchFunc(s.Waves, waveID, func(w SiegeWave, id string) int {
		return strings.Compare(w.WaveID, id)
	})
	if !ok {
		return -1
	}
	return idx
}

// CanTraverse enforces authoritative edge accessibility between two zones (anti-teleportation).
// Closed gates or intact walls block invaders; breached or destroyed blockers unlock passage.
func CanTraverse(state SiegeState, fromZoneID, toZoneID string, isInvader bool) bool {
	if fromZoneID == toZoneID {
		return state.FindZoneIndex(fromZoneID) >= 0
	}
	for _, c := range state.Connections {
		matches := (c.FromZoneID == fromZoneID && c.ToZoneID == toZoneID) ||
			(c.Bidirectional && c.ToZoneID == fromZoneID && c.FromZoneID == toZoneID)
		if !matches {
			continue
		}
		if connectionPermits(state, c, isInvader) {
			return true
		}
	}
	return false
}

func connectionPermits(state SiegeState, c ZoneConnection, isInvader bool) bool {
	switch c.Rule {
	case ConnAlwaysOpen:
		return true
	case ConnDefenderOnly:
		return !isInvader
	case ConnRequiresStructureCompromised:
		if !isInvader {
			return true
		}
		idx := state.FindStructureIndex(c.BlockerStructureID)
		if idx < 0 {
			return false
		}
		return state.Structures[idx].State.IsCompromised()
	default:
		return false
	}
}

// AreAdjacent reports whether two zones share any edge in the graph (regardless of gate state).
func AreAdjacent(state SiegeState, zoneA, zoneB string) bool {
	if zoneA == zoneB {
		return state.FindZoneIndex(zoneA) >= 0
	}
	for _, c := range state.Connections {
		if (c.FromZoneID == zoneA && c.ToZoneID == zoneB) ||
			(c.Bidirectional && c.ToZoneID == zoneA && c.FromZoneID == zoneB) {
			return true
		}
	}
	return false
}

// ZoneHopDistance computes the deterministic shortest topological distance (in hops) ignoring
// gate/wall blockers, used for layout connectivity validation and abstract tower/archer reach.
func ZoneHopDistance(state SiegeState, fromZoneID, toZoneID string) int {
	if state.FindZoneIndex(fromZoneID) < 0 || state.FindZoneIndex(toZoneID) < 0 {
		return -1
	}
	if fromZoneID == toZoneID {
		return 0
	}
	type node struct {
		id   string
		dist int
	}
	visited := map[string]struct{}{fromZoneID: {}}
	queue := []node{{id: fromZoneID, dist: 0}}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		neighbors := structuralNeighbors(state, cur.id)
		for _, nb := range neighbors {
			if nb == toZoneID {
				return cur.dist + 1
			}
			if _, seen := visited[nb]; !seen {
				visited[nb] = struct{}{}
				queue = append(queue, node{id: nb, dist: cur.dist + 1})
			}
		}
	}
	return -1
}

// NextStepToward runs deterministic lexicographical BFS obeying connection accessibility rules
// and returns the immediate adjacent zone to move into (anti-teleportation).
func NextStepToward(state SiegeState, fromZoneID, toZoneID string, isInvader bool) (string, bool) {
	if fromZoneID == toZoneID || state.FindZoneIndex(fromZoneID) < 0 || state.FindZoneIndex(toZoneID) < 0 {
		return "", false
	}
	type node struct {
		id        string
		firstStep string
	}
	visited := map[string]struct{}{fromZoneID: {}}
	queue := make([]node, 0, len(state.Zones))
	for _, nb := range traversableNeighbors(state, fromZoneID, isInvader) {
		if nb == toZoneID {
			return nb, true
		}
		visited[nb] = struct{}{}
		queue = append(queue, node{id: nb, firstStep: nb})
	}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, nb := range traversableNeighbors(state, cur.id, isInvader) {
			if nb == toZoneID {
				return cur.firstStep, true
			}
			if _, seen := visited[nb]; !seen {
				visited[nb] = struct{}{}
				queue = append(queue, node{id: nb, firstStep: cur.firstStep})
			}
		}
	}
	return "", false
}

// ReachableZones returns all zones reachable from fromZoneID in canonical sorted order.
func ReachableZones(state SiegeState, fromZoneID string, isInvader bool) []string {
	if state.FindZoneIndex(fromZoneID) < 0 {
		return nil
	}
	visited := map[string]struct{}{fromZoneID: {}}
	queue := []string{fromZoneID}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, nb := range traversableNeighbors(state, cur, isInvader) {
			if _, seen := visited[nb]; !seen {
				visited[nb] = struct{}{}
				queue = append(queue, nb)
			}
		}
	}
	out := make([]string, 0, len(visited))
	for id := range visited {
		out = append(out, id)
	}
	slices.Sort(out)
	return out
}

func traversableNeighbors(state SiegeState, zoneID string, isInvader bool) []string {
	var out []string
	for _, c := range state.Connections {
		if !connectionPermits(state, c, isInvader) {
			continue
		}
		if c.FromZoneID == zoneID {
			out = append(out, c.ToZoneID)
		} else if c.Bidirectional && c.ToZoneID == zoneID {
			out = append(out, c.FromZoneID)
		}
	}
	slices.Sort(out)
	return slices.Compact(out)
}

func structuralNeighbors(state SiegeState, zoneID string) []string {
	var out []string
	for _, c := range state.Connections {
		if c.FromZoneID == zoneID {
			out = append(out, c.ToZoneID)
		} else if c.Bidirectional && c.ToZoneID == zoneID {
			out = append(out, c.FromZoneID)
		}
	}
	slices.Sort(out)
	return slices.Compact(out)
}

// PositionForZone returns the scalar WorldUnit PositionHint associated with zoneID.
func PositionForZone(state SiegeState, zoneID string) (int64, bool) {
	idx := state.FindZoneIndex(zoneID)
	if idx < 0 {
		return 0, false
	}
	return state.Zones[idx].PositionHint, true
}

// ZoneForPosition deterministically maps a scalar battlefield position to the nearest zone.
func ZoneForPosition(state SiegeState, pos int64) string {
	if len(state.Zones) == 0 {
		return ""
	}
	bestID := state.Zones[0].ZoneID
	bestDiff := absDiff(state.Zones[0].PositionHint, pos)
	for _, z := range state.Zones[1:] {
		d := absDiff(z.PositionHint, pos)
		if d < bestDiff || (d == bestDiff && z.ZoneID < bestID) {
			bestDiff = d
			bestID = z.ZoneID
		}
	}
	return bestID
}

func absDiff(a, b int64) int64 {
	if a >= b {
		return a - b
	}
	return b - a
}
