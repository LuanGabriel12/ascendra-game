package siege

import (
	"fmt"
	"slices"
	"strings"

	"ascendra-game/internal/ai"
)

// StructureAttackModifierBP returns the deterministic integer fixed-point siege attack modifier
// (10000 = 1.00x) differentiating Goblin opportunistic raiding from Orc fortification smashing,
// plus live commander coordination bonus.
func StructureAttackModifierBP(
	archetype string,
	family ai.Family,
	targetKind StructureKind,
	hasLiveCommander bool,
	commanderBonusBP int64,
) int64 {
	var base int64 = BasisPointsScale
	switch archetype {
	case "goblin-skirmisher":
		base = 9000
		if targetKind == StructureSupplyDepot {
			base = 12000 // Opportunistic supply raiders
		}
	case "goblin-raider-pack":
		base = 10500
		if targetKind == StructureGate || targetKind == StructureSupplyDepot {
			base = 11500
		}
	case "goblin-taskmaster":
		base = 11500
	case "orc-vanguard":
		base = 12500
		if targetKind == StructureGate || targetKind == StructureWall {
			base = 13500
		}
	case "orc-berserker":
		base = 14000
		if targetKind == StructureWall || targetKind == StructureCitadel {
			base = 15000
		}
	case "orc-warchief":
		base = 15000
	default:
		if family == ai.FamilyOrc {
			base = 12500
		}
	}
	if hasLiveCommander && commanderBonusBP > 0 {
		sum, err := safeAddInt64(base, commanderBonusBP)
		if err == nil {
			base = sum
		}
	}
	return base
}

// CalculateStructureDamage computes purely integer, overflow-safe effective damage against
// a fortification structure:
//  1. scaled = floor(baseDamage * attackerModBP / 10000), min 1 when baseDamage > 0 && mod > 0
//  2. afterArmor = max(1, scaled - armorFlat)
//  3. effective = max(1, floor(afterArmor * (10000 - resistanceBP) / 10000))
func CalculateStructureDamage(baseDamage, attackerModBP, armorFlat, resistanceBP int64) (int64, error) {
	if baseDamage < 0 || attackerModBP < 0 || armorFlat < 0 || resistanceBP < 0 || resistanceBP > 7500 {
		return 0, fmt.Errorf("%w: invalid damage formula inputs", ErrInvalidCommand)
	}
	if baseDamage == 0 || attackerModBP == 0 {
		return 0, nil
	}
	scaled, err := safeMulDivBP(baseDamage, attackerModBP)
	if err != nil {
		return 0, err
	}
	if scaled < 1 {
		scaled = 1
	}
	afterArmor := scaled - armorFlat
	if afterArmor < 1 {
		afterArmor = 1
	}
	eff, err := safeMulDivBP(afterArmor, BasisPointsScale-resistanceBP)
	if err != nil {
		return 0, err
	}
	if eff < 1 {
		eff = 1
	}
	return eff, nil
}

// ApplyStructureDamage authoritatively damages a fortification structure, updating structural state
// (Intact -> Damaged -> Breached -> Destroyed) and applying immediate Supply Depot disruption loss
// if a supply depot falls. Never produces negative HP or damages nonexistent/destroyed structures.
func ApplyStructureDamage(
	state *SiegeState,
	structureID string,
	baseDamage int64,
	attackerModBP int64,
	tick uint64,
	cfg Config,
) (effectiveDamage int64, breachedNow bool, destroyedNow bool, supplyDisrupted int64, err error) {
	if state == nil {
		return 0, false, false, 0, fmt.Errorf("%w: nil siege state", ErrInvalidState)
	}
	if baseDamage <= 0 {
		return 0, false, false, 0, fmt.Errorf("%w: base damage must be > 0", ErrInvalidCommand)
	}
	idx := state.FindStructureIndex(structureID)
	if idx < 0 {
		return 0, false, false, 0, fmt.Errorf("%w: structure %q", ErrUnknownEntity, structureID)
	}
	st := &state.Structures[idx]
	if st.HP == 0 || st.State == StructureDestroyed {
		return 0, false, false, 0, fmt.Errorf("%w: structure %q already destroyed", ErrDeadEntity, structureID)
	}

	rawEff, err := CalculateStructureDamage(baseDamage, attackerModBP, st.ArmorFlat, st.ResistanceBP)
	if err != nil {
		return 0, false, false, 0, err
	}
	if rawEff > st.HP {
		rawEff = st.HP
	}
	prevCompromised := st.State.IsCompromised()
	st.HP -= rawEff

	if st.HP == 0 {
		st.State = StructureDestroyed
		st.DestroyedTick = tick
		st.FireCooldownTicks = 0
		destroyedNow = true
		if !prevCompromised {
			breachedNow = true
		}
		if st.Kind == StructureSupplyDepot && cfg.SupplyDepotDestroyPenalty > 0 && state.Supplies.Current > 0 {
			loss := cfg.SupplyDepotDestroyPenalty
			if loss > state.Supplies.Current {
				loss = state.Supplies.Current
			}
			state.Supplies.Current -= loss
			supplyDisrupted = loss
		}
	} else {
		// Check wall/structure breach threshold (e.g. Wall opens breach at <= 50% HP).
		if st.BreachThresholdBP > 0 && hpAtOrBelowBP(st.HP, st.MaxHP, st.BreachThresholdBP) {
			if !prevCompromised {
				breachedNow = true
			}
			st.State = StructureBreached
		} else if !prevCompromised {
			st.State = StructureDamaged
		}
	}
	return rawEff, breachedNow, destroyedNow, supplyDisrupted, nil
}

// ApplyStructureRepair executes a bounded, supply-backed fortification repair obeying:
//   - Policy on destroyed structures (AllowDestroyedStructureRepairInBattle == false by default),
//   - Zone proximity (same zone or adjacent connected zone),
//   - Supply availability (RepairSupplyCost),
//   - Entity cooldown, MaxRepairsPerStructure, MaxRepairsPerEntity,
//   - Supply Depot operational bonus (+SupplyDepotRepairBonusBP only while depot HP > 0),
//   - No HP above MaxHP and no zero-effect repairs.
func ApplyStructureRepair(
	state *SiegeState,
	structureID string,
	entityID string,
	entityZoneID string,
	tick uint64,
	cfg Config,
) (effectiveHeal int64, supplyCost int64, err error) {
	if state == nil {
		return 0, 0, fmt.Errorf("%w: nil siege state", ErrInvalidState)
	}
	if err := validateID(entityID, cfg.MaxIdentifierLength); err != nil {
		return 0, 0, fmt.Errorf("%w: entity_id: %v", ErrInvalidCommand, err)
	}
	idx := state.FindStructureIndex(structureID)
	if idx < 0 {
		return 0, 0, fmt.Errorf("%w: structure %q", ErrUnknownEntity, structureID)
	}
	st := &state.Structures[idx]
	if st.HP == 0 || st.State == StructureDestroyed {
		if !cfg.AllowDestroyedStructureRepairInBattle {
			return 0, 0, fmt.Errorf("%w: destroyed structure %q cannot be repaired during battle", ErrDeadEntity, structureID)
		}
	}
	if st.HP >= st.MaxHP {
		return 0, 0, fmt.Errorf("%w: structure %q already at full HP", ErrInvalidCommand, structureID)
	}
	if !AreAdjacent(*state, entityZoneID, st.ZoneID) {
		return 0, 0, fmt.Errorf("%w: entity in %q is out of reach of structure %q in %q", ErrZoneBlocked, entityZoneID, structureID, st.ZoneID)
	}
	if st.RepairsApplied >= cfg.MaxRepairsPerStructure {
		return 0, 0, fmt.Errorf("%w: structure %q reached max repairs %d", ErrRepairLimitReached, structureID, cfg.MaxRepairsPerStructure)
	}
	erIdx, found := slices.BinarySearchFunc(state.EntityRepairs, entityID, func(e EntityRepairCount, id string) int {
		return strings.Compare(e.EntityID, id)
	})
	if found {
		if state.EntityRepairs[erIdx].Count >= cfg.MaxRepairsPerEntity {
			return 0, 0, fmt.Errorf("%w: entity %q reached max repairs %d", ErrRepairLimitReached, entityID, cfg.MaxRepairsPerEntity)
		}
		if tick < state.EntityRepairs[erIdx].NextRepairTick {
			return 0, 0, fmt.Errorf("%w: entity %q repair cooldown ready at tick %d", ErrCooldownActive, entityID, state.EntityRepairs[erIdx].NextRepairTick)
		}
	}
	if state.Supplies.Current < cfg.RepairSupplyCost {
		return 0, 0, fmt.Errorf("%w: need %d supplies, have %d", ErrInsufficientSupplies, cfg.RepairSupplyCost, state.Supplies.Current)
	}

	bonusBP := int64(0)
	if state.HasOperationalSupplyDepot() {
		bonusBP = cfg.SupplyDepotRepairBonusBP
	}
	healAmount, err := safeMulDivBP(cfg.RepairBaseAmount, BasisPointsScale+bonusBP)
	if err != nil {
		return 0, 0, err
	}
	if healAmount < 1 {
		healAmount = 1
	}
	missing := st.MaxHP - st.HP
	if healAmount > missing {
		healAmount = missing
	}
	if healAmount <= 0 {
		return 0, 0, fmt.Errorf("%w: zero effective repair", ErrInvalidCommand)
	}

	nextSpent, err := safeAddInt64(state.Supplies.TotalSpent, cfg.RepairSupplyCost)
	if err != nil {
		return 0, 0, err
	}
	nextReady := tick + cfg.RepairCooldownTicks
	if nextReady < tick {
		return 0, 0, ErrNumericOverflow
	}

	st.HP += healAmount
	st.RepairsApplied++
	if st.HP == st.MaxHP {
		st.State = StructureIntact
	} else if st.BreachThresholdBP > 0 && hpAtOrBelowBP(st.HP, st.MaxHP, st.BreachThresholdBP) {
		st.State = StructureBreached
	} else {
		st.State = StructureDamaged
	}

	state.Supplies.Current -= cfg.RepairSupplyCost
	state.Supplies.TotalSpent = nextSpent
	if found {
		state.EntityRepairs[erIdx].Count++
		state.EntityRepairs[erIdx].NextRepairTick = nextReady
	} else {
		state.EntityRepairs = slices.Insert(state.EntityRepairs, erIdx, EntityRepairCount{
			EntityID:       entityID,
			Count:          1,
			NextRepairTick: nextReady,
		})
	}
	return healAmount, cfg.RepairSupplyCost, nil
}

// EntityRepairTotal returns how many valid repairs entityID has performed during this siege.
func EntityRepairTotal(state SiegeState, entityID string) int {
	idx, ok := slices.BinarySearchFunc(state.EntityRepairs, entityID, func(e EntityRepairCount, id string) int {
		return strings.Compare(e.EntityID, id)
	})
	if !ok {
		return 0
	}
	return state.EntityRepairs[idx].Count
}

// TickSupplyRegen grants bounded periodic tactical supplies ONLY while at least one
// SupplyDepot structure remains operational (HP > 0) and below MaxTotalRegen.
func TickSupplyRegen(state *SiegeState, tick uint64, cfg Config) int64 {
	if state == nil || cfg.SupplyDepotRegenPerInterval <= 0 || cfg.SupplyRegenIntervalTicks == 0 {
		return 0
	}
	if !state.HasOperationalSupplyDepot() {
		return 0
	}
	if tick < state.Supplies.LastRegenTick || (tick-state.Supplies.LastRegenTick) < cfg.SupplyRegenIntervalTicks {
		return 0
	}
	remainingCap := state.Supplies.MaxTotalRegen - state.Supplies.TotalRegenerated
	if remainingCap <= 0 {
		return 0
	}
	room := state.Supplies.Max - state.Supplies.Current
	if room <= 0 {
		state.Supplies.LastRegenTick = tick
		return 0
	}
	gain := cfg.SupplyDepotRegenPerInterval
	if gain > remainingCap {
		gain = remainingCap
	}
	if gain > room {
		gain = room
	}
	state.Supplies.Current += gain
	state.Supplies.TotalRegenerated += gain
	state.Supplies.LastRegenTick = tick
	return gain
}

// SelectStructureTarget chooses the highest-priority attackable fortification inside zoneID
// according to family siege policy (Goblin opportunistic vs Orc direct fortification assault).
func SelectStructureTarget(state SiegeState, zoneID string, family ai.Family, archetype string) (Structure, bool) {
	var best Structure
	bestScore := int64(-1)
	found := false

	for _, st := range state.Structures {
		if st.ZoneID != zoneID || st.HP <= 0 || st.State == StructureDestroyed {
			continue
		}
		score := structurePriorityScore(st, family, archetype)
		if !found || score > bestScore || (score == bestScore && st.StructureID < best.StructureID) {
			best = st
			bestScore = score
			found = true
		}
	}
	return best, found
}

func structurePriorityScore(st Structure, family ai.Family, archetype string) int64 {
	var base int64
	if family == ai.FamilyOrc {
		// Orcs prioritize heavy fortification breaking and direct Citadel assault.
		switch st.Kind {
		case StructureCitadel:
			base = 1000
		case StructureGate:
			base = 900
		case StructureWall:
			base = 880
		case StructureTower:
			base = 700
		case StructureSupplyDepot:
			base = 550
		}
		if archetype == "orc-berserker" && st.Kind == StructureWall {
			base += 80
		}
	} else {
		// Goblins opportunistically prioritize vulnerable Supply Depots, weak gates, and damaged targets.
		switch st.Kind {
		case StructureSupplyDepot:
			base = 960
		case StructureCitadel:
			base = 920
		case StructureGate:
			base = 860
		case StructureTower:
			base = 740
		case StructureWall:
			base = 650
		}
		if st.HP < st.MaxHP {
			base += 140 // Opportunistic focus on already-weakened structures
		}
	}
	return base
}

// SelectInvaderDestinationZone chooses the tactical target zone for an invading group
// respecting gate/wall accessibility and Goblin vs Orc strategic priorities.
func SelectInvaderDestinationZone(state SiegeState, currentZoneID string, family ai.Family) string {
	// Before any breach, invaders advance to attack Main Gate (default) or Outer Wall (orc berserkers / wall assault).
	if !state.HasOuterBreach() {
		if family == ai.FamilyOrc {
			// Orcs split pressure onto Gate and Wall Approach.
			if currentZoneID == ZoneIDWallApproach {
				if idx := state.FindStructureIndex(StructIDOuterWall); idx >= 0 && !state.Structures[idx].State.IsCompromised() {
					return ZoneIDWallApproach
				}
			}
			if idx := state.FindStructureIndex(StructIDMainGate); idx >= 0 && state.Structures[idx].HP > 0 {
				return ZoneIDMainGate
			}
		}
		if idx := state.FindStructureIndex(StructIDMainGate); idx >= 0 && state.Structures[idx].HP > 0 {
			return ZoneIDMainGate
		}
		if z := state.FindZoneByKind(ZoneMainGate); z != nil {
			return z.ZoneID
		}
		if z := state.FindZoneByKind(ZoneWallApproach); z != nil {
			return z.ZoneID
		}
	}

	// After breach: Goblins prioritize disrupting an intact Supply Depot before pushing Citadel;
	// Orcs push straight through Outer District -> Central Square -> Citadel.
	if family == ai.FamilyGoblin && state.HasOperationalSupplyDepot() {
		for _, st := range state.Structures {
			if st.Kind == StructureSupplyDepot && st.HP > 0 {
				if _, reachable := NextStepToward(state, currentZoneID, st.ZoneID, true); reachable || currentZoneID == st.ZoneID {
					return st.ZoneID
				}
			}
		}
	}

	// Capture Outer District if still defender-held and reachable, otherwise press Citadel.
	if outerIdx := state.FindZoneIndex(ZoneIDOuterDistrict); outerIdx >= 0 &&
		state.Zones[outerIdx].Capturable &&
		state.Zones[outerIdx].ControlState != DistrictInvaderControlled {
		if _, ok := NextStepToward(state, currentZoneID, ZoneIDOuterDistrict, true); ok || currentZoneID == ZoneIDOuterDistrict {
			return ZoneIDOuterDistrict
		}
	}

	if cit := state.FindZoneByKind(ZoneCitadel); cit != nil {
		return cit.ZoneID
	}
	return currentZoneID
}

// SelectTowerTarget selects the deterministic hostile target within a Tower's AttackRangeZones.
// Prefers closest hop distance, then lowest HP, then canonical GroupID.
func SelectTowerTarget(state SiegeState, tower Structure, combatants []CombatantSnapshot) (string, bool) {
	if tower.Kind != StructureTower || tower.HP <= 0 || tower.State == StructureDestroyed {
		return "", false
	}
	bestID := ""
	bestHops := int(1 << 20)
	bestHP := int64(1 << 62)
	for _, c := range combatants {
		if !c.IsInvader || c.HP <= 0 {
			continue
		}
		hops := ZoneHopDistance(state, tower.ZoneID, c.ZoneID)
		if hops < 0 || hops > tower.AttackRangeZones {
			continue
		}
		if bestID == "" || hops < bestHops ||
			(hops == bestHops && c.HP < bestHP) ||
			(hops == bestHops && c.HP == bestHP && c.ID < bestID) {
			bestID = c.ID
			bestHops = hops
			bestHP = c.HP
		}
	}
	return bestID, bestID != ""
}

func hpAtOrBelowBP(hp, maxHP, thresholdBP int64) bool {
	if maxHP <= 0 || thresholdBP <= 0 {
		return false
	}
	if hp <= 0 {
		return true
	}
	// Exact integer comparison: hp * 10000 <= maxHP * thresholdBP without overflow.
	scaled, err := safeMulDivBP(maxHP, thresholdBP)
	if err != nil {
		return false
	}
	return hp <= scaled
}
