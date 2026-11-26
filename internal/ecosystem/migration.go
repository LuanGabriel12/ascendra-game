package ecosystem

import (
	"fmt"
	"slices"
	"strings"

	"ascendra-game/internal/ai"
)

// MigrationPlan captures a planned transfer computed from the immutable start-of-phase snapshot.
type MigrationPlan struct {
	SourcePopID    string
	SourceRegionID string
	DestRegionID   string
	SpeciesID      string
	FamilyID       ai.Family
	FactionID      string
	Count          int64
}

// processMigration executes strict two-phase deterministic migration:
//   Phase 1 (Plan): reads an immutable snapshot of regions and populations so that
//                   region processing order cannot alter decisions and no contingent
//                   migrates twice in the same epoch.
//   Phase 2 (Apply): executes transfers atomically with exact population conservation
//                    (sum(outflow) == sum(inflow), zero duplication, zero rounding loss).
func processMigration(state *EcosystemState, cfg Config, events *[]EcologicalEvent) error {
	if cfg.MaxMigrantsPerEpoch == 0 || cfg.MigrationShareBP == 0 {
		return nil
	}

	// Immutable view for Phase 1 planning.
	snapshot := state.Clone()
	plans := planMigrations(&snapshot, cfg)

	// Phase 2: apply all plans deterministically in canonical SourcePopID order.
	for _, plan := range plans {
		if plan.Count <= 0 {
			continue
		}
		srcIdx := findPopulationIndex(state.Populations, plan.SourcePopID)
		if srcIdx < 0 {
			continue
		}
		src := &state.Populations[srcIdx]
		if src.FreePopulation < plan.Count {
			continue
		}

		// Find existing destination population of same (Region, Species, Faction) or create one.
		dstIdx := findMatchingPopulation(state.Populations, plan.DestRegionID, plan.SpeciesID, plan.FactionID)
		if dstIdx < 0 {
			if len(state.Populations) >= cfg.MaxPopulations {
				// Respect operational population cap without losing any individuals.
				continue
			}
			destRegIdx := findRegionIndex(state.Regions, plan.DestRegionID)
			if destRegIdx < 0 {
				continue
			}
			state.PopSeq++
			newPopID := fmt.Sprintf("pop-%s-%s-%04d", plan.DestRegionID, plan.FactionID, state.PopSeq)
			newPop := Population{
				PopulationID:          newPopID,
				RegionID:              plan.DestRegionID,
				SpeciesID:             src.SpeciesID,
				FamilyID:              src.FamilyID,
				FactionID:             src.FactionID,
				FreePopulation:        0,
				MaterializedPopulation: 0,
				CarryingCapacity:      state.Regions[destRegIdx].CarryingCapacity,
				GrowthRateBP:          src.GrowthRateBP,
				MortalityRateBP:       src.MortalityRateBP,
				FoodPerCapitaMilli:    src.FoodPerCapitaMilli,
				WoodPerCapitaMilli:    src.WoodPerCapitaMilli,
				OrePerCapitaMilli:     src.OrePerCapitaMilli,
				WaterPerCapitaMilli:   src.WaterPerCapitaMilli,
				StrengthPerIndividual: src.StrengthPerIndividual,
			}
			insertIdx, _ := slices.BinarySearchFunc(state.Populations, newPop.PopulationID, func(p Population, id string) int {
				return strings.Compare(p.PopulationID, id)
			})
			state.Populations = slices.Insert(state.Populations, insertIdx, newPop)
			// Re-resolve indices after slice insertion.
			srcIdx = findPopulationIndex(state.Populations, plan.SourcePopID)
			dstIdx = findPopulationIndex(state.Populations, newPop.PopulationID)
		}

		// Exact conservation transfer: source -= Count, destination += Count.
		nextDst, err := safeAddInt64(state.Populations[dstIdx].FreePopulation, plan.Count)
		if err != nil {
			return err
		}
		state.Populations[srcIdx].FreePopulation -= plan.Count
		state.Populations[dstIdx].FreePopulation = nextDst

		ev, err := state.newEvent(
			EventPopulationMigrated,
			plan.SourceRegionID,
			plan.SourcePopID,
			plan.DestRegionID,
			fmt.Sprintf("%s->%s", plan.SourceRegionID, plan.DestRegionID),
			plan.Count,
		)
		if err != nil {
			return err
		}
		*events = append(*events, ev)
	}
	return nil
}

func planMigrations(snap *EcosystemState, cfg Config) []MigrationPlan {
	plans := make([]MigrationPlan, 0, len(snap.Populations))

	for _, pop := range snap.Populations {
		if pop.FreePopulation < cfg.MinMigrationGroupSize {
			continue
		}
		if pop.MigrationPressureBP < cfg.MigrationThresholdBP {
			continue
		}
		rIdx := findRegionIndex(snap.Regions, pop.RegionID)
		if rIdx < 0 || len(snap.Regions[rIdx].AdjacentRegions) == 0 {
			continue
		}
		srcRegion := snap.Regions[rIdx]

		destID, destHeadroom, ok := selectMigrationDestination(snap, srcRegion, pop)
		if !ok {
			continue
		}

		// Compute bounded migrant contingent strictly <= FreePopulation.
		migrants := mulDivBP(pop.FreePopulation, cfg.MigrationShareBP)
		if migrants < cfg.MinMigrationGroupSize {
			migrants = cfg.MinMigrationGroupSize
		}
		if migrants > cfg.MaxMigrantsPerEpoch {
			migrants = cfg.MaxMigrantsPerEpoch
		}
		if destHeadroom > 0 && migrants > destHeadroom {
			migrants = destHeadroom
		}
		if migrants > pop.FreePopulation {
			migrants = pop.FreePopulation
		}
		if migrants < cfg.MinMigrationGroupSize {
			continue
		}

		plans = append(plans, MigrationPlan{
			SourcePopID:    pop.PopulationID,
			SourceRegionID: pop.RegionID,
			DestRegionID:   destID,
			SpeciesID:      pop.SpeciesID,
			FamilyID:       pop.FamilyID,
			FactionID:      pop.FactionID,
			Count:          migrants,
		})
	}
	return plans
}

// selectMigrationDestination scores adjacent regions deterministically using capacity headroom,
// resource availability, and hostile rival pressure, with canonical RegionID tie-breaking.
func selectMigrationDestination(snap *EcosystemState, src Region, pop Population) (string, int64, bool) {
	bestID := ""
	var bestScore int64 = -1
	var bestHeadroom int64
	found := false

	srcScore := scoreRegionForPopulation(snap, src, pop)

	for _, adjID := range src.AdjacentRegions {
		adjIdx := findRegionIndex(snap.Regions, adjID)
		if adjIdx < 0 {
			continue
		}
		adj := snap.Regions[adjIdx]
		if adj.CarryingCapacity <= 0 {
			continue
		}
		occupied := totalRegionPopulation(snap.Populations, adj.RegionID)
		headroom := adj.CarryingCapacity - occupied
		if headroom <= 0 {
			continue
		}

		score := scoreRegionForPopulation(snap, adj, pop)
		// Only migrate if destination is strictly more attractive or source is under heavy scarcity/zero K.
		if score <= srcScore && pop.ScarcityBP < 4000 && pop.CarryingCapacity > 0 {
			continue
		}

		if !found || score > bestScore || (score == bestScore && adj.RegionID < bestID) {
			bestID = adj.RegionID
			bestScore = score
			bestHeadroom = headroom
			found = true
		}
	}
	return bestID, bestHeadroom, found
}

func scoreRegionForPopulation(snap *EcosystemState, reg Region, pop Population) int64 {
	if reg.CarryingCapacity <= 0 {
		return 0
	}
	occupied := totalRegionPopulation(snap.Populations, reg.RegionID)
	headroom := reg.CarryingCapacity - occupied
	if headroom < 0 {
		headroom = 0
	}
	headroomBP := ratioBP(headroom, reg.CarryingCapacity)
	foodBP := ratioBP(reg.Resources.Food.Amount, reg.Resources.Food.MaxCapacity)
	waterBP := ratioBP(reg.Resources.Water.Amount, reg.Resources.Water.MaxCapacity)
	secondaryBP := ratioBP(reg.Resources.Wood.Amount, reg.Resources.Wood.MaxCapacity)
	if pop.FamilyID == ai.FamilyOrc {
		secondaryBP = ratioBP(reg.Resources.Ore.Amount, reg.Resources.Ore.MaxCapacity)
	}

	// Hostile influence penalty discourages migrating directly into a hostile stronghold.
	var hostileInfBP int64
	for _, inf := range reg.FactionInfluences {
		if GetStance(snap.Factions, pop.FactionID, inf.FactionID) == StanceHostile {
			hostileInfBP += inf.InfluenceBP
		}
	}
	if hostileInfBP > BasisPointsScale {
		hostileInfBP = BasisPointsScale
	}

	score := (headroomBP*40 + foodBP*30 + waterBP*15 + secondaryBP*15) / 100
	score -= hostileInfBP / 3
	if score < 0 {
		score = 0
	}
	return score
}

func totalRegionPopulation(pops []Population, regionID string) int64 {
	var total int64
	for _, p := range pops {
		if p.RegionID == regionID {
			total += p.FreePopulation + p.MaterializedPopulation
		}
	}
	return total
}

func findMatchingPopulation(pops []Population, regionID, speciesID, factionID string) int {
	for i, p := range pops {
		if p.RegionID == regionID && p.SpeciesID == speciesID && p.FactionID == factionID {
			return i
		}
	}
	return -1
}
