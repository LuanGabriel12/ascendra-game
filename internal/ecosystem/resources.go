package ecosystem

import "math/bits"

// processResources evaluates regional resource consumption with exact integer conservation
// (never creating or leaking units via rounding), computes per-population ScarcityBP,
// updates EcologicalStatus, and regenerates renewable pools within MaxCapacity.
func processResources(state *EcosystemState, events *[]EcologicalEvent) error {
	// Track total population demand per region for each resource.
	for rIdx := range state.Regions {
		reg := &state.Regions[rIdx]

		// Collect canonical population indices residing in this region.
		popIndices := make([]int, 0, 4)
		for pIdx := range state.Populations {
			if state.Populations[pIdx].RegionID == reg.RegionID {
				popIndices = append(popIndices, pIdx)
			}
		}

		n := len(popIndices)
		foodDemand := make([]int64, n)
		woodDemand := make([]int64, n)
		oreDemand := make([]int64, n)
		waterDemand := make([]int64, n)

		for i, pIdx := range popIndices {
			pop := &state.Populations[pIdx]
			if pop.FreePopulation <= 0 {
				pop.ScarcityBP = 0
				continue
			}
			var err error
			if foodDemand[i], err = ceilMilliDemand(pop.FreePopulation, pop.FoodPerCapitaMilli); err != nil {
				return err
			}
			if woodDemand[i], err = ceilMilliDemand(pop.FreePopulation, pop.WoodPerCapitaMilli); err != nil {
				return err
			}
			if oreDemand[i], err = ceilMilliDemand(pop.FreePopulation, pop.OrePerCapitaMilli); err != nil {
				return err
			}
			if waterDemand[i], err = ceilMilliDemand(pop.FreePopulation, pop.WaterPerCapitaMilli); err != nil {
				return err
			}
		}

		// Allocate each resource strictly conserving total units.
		foodAlloc, foodDepleted, err := allocateResource(&reg.Resources.Food, foodDemand)
		if err != nil {
			return err
		}
		woodAlloc, woodDepleted, err := allocateResource(&reg.Resources.Wood, woodDemand)
		if err != nil {
			return err
		}
		oreAlloc, oreDepleted, err := allocateResource(&reg.Resources.Ore, oreDemand)
		if err != nil {
			return err
		}
		waterAlloc, waterDepleted, err := allocateResource(&reg.Resources.Water, waterDemand)
		if err != nil {
			return err
		}

		if foodDepleted {
			ev, err := state.newEvent(EventResourceDepleted, reg.RegionID, reg.RegionID, "food", "Food depleted", 0)
			if err != nil {
				return err
			}
			*events = append(*events, ev)
		}
		if woodDepleted {
			ev, err := state.newEvent(EventResourceDepleted, reg.RegionID, reg.RegionID, "wood", "Wood depleted", 0)
			if err != nil {
				return err
			}
			*events = append(*events, ev)
		}
		if oreDepleted {
			ev, err := state.newEvent(EventResourceDepleted, reg.RegionID, reg.RegionID, "ore", "Ore depleted", 0)
			if err != nil {
				return err
			}
			*events = append(*events, ev)
		}
		if waterDepleted {
			ev, err := state.newEvent(EventResourceDepleted, reg.RegionID, reg.RegionID, "water", "Water depleted", 0)
			if err != nil {
				return err
			}
			*events = append(*events, ev)
		}

		// Compute weighted scarcity per population (Food 60%, Water 25%, Wood 10%, Ore 5%).
		for i, pIdx := range popIndices {
			pop := &state.Populations[pIdx]
			if pop.FreePopulation <= 0 {
				pop.ScarcityBP = 0
				continue
			}
			var weightedUnmet, totalWeight int64
			if foodDemand[i] > 0 {
				weightedUnmet += unmetRatioBP(foodDemand[i], foodAlloc[i]) * 60
				totalWeight += 60
			}
			if waterDemand[i] > 0 {
				weightedUnmet += unmetRatioBP(waterDemand[i], waterAlloc[i]) * 25
				totalWeight += 25
			}
			if woodDemand[i] > 0 {
				weightedUnmet += unmetRatioBP(woodDemand[i], woodAlloc[i]) * 10
				totalWeight += 10
			}
			if oreDemand[i] > 0 {
				weightedUnmet += unmetRatioBP(oreDemand[i], oreAlloc[i]) * 5
				totalWeight += 5
			}
			if totalWeight == 0 {
				pop.ScarcityBP = 0
			} else {
				pop.ScarcityBP = weightedUnmet / totalWeight
			}
		}

		// Regenerate pools strictly within MaxCapacity; emit event only on recovery from depletion.
		if regenAmt, recovered := regenerateResource(&reg.Resources.Food); recovered {
			ev, err := state.newEvent(EventResourceRegenerated, reg.RegionID, reg.RegionID, "food", "Food recovered", regenAmt)
			if err != nil {
				return err
			}
			*events = append(*events, ev)
		}
		if regenAmt, recovered := regenerateResource(&reg.Resources.Wood); recovered {
			ev, err := state.newEvent(EventResourceRegenerated, reg.RegionID, reg.RegionID, "wood", "Wood recovered", regenAmt)
			if err != nil {
				return err
			}
			*events = append(*events, ev)
		}
		_, _ = regenerateResource(&reg.Resources.Stone)
		_, _ = regenerateResource(&reg.Resources.Ore)
		if regenAmt, recovered := regenerateResource(&reg.Resources.Water); recovered {
			ev, err := state.newEvent(EventResourceRegenerated, reg.RegionID, reg.RegionID, "water", "Water recovered", regenAmt)
			if err != nil {
				return err
			}
			*events = append(*events, ev)
		}

		reg.Status = computeEcologicalStatus(reg.Resources)
	}
	return nil
}

// ceilMilliDemand computes ceil((count * perCapitaMilli) / 1000) safely using 128-bit arithmetic.
func ceilMilliDemand(count, perCapitaMilli int64) (int64, error) {
	if count <= 0 || perCapitaMilli <= 0 {
		return 0, nil
	}
	hi, lo := bits.Mul64(uint64(count), uint64(perCapitaMilli))
	// Add 999 for ceiling division.
	lo2, carry := bits.Add64(lo, uint64(MilliScale-1), 0)
	hi2 := hi + carry
	if hi2 >= uint64(MilliScale) {
		return 0, ErrNumericOverflow
	}
	q, _ := bits.Div64(hi2, lo2, uint64(MilliScale))
	if q > uint64(1<<63-1) {
		return 0, ErrNumericOverflow
	}
	return int64(q), nil
}

// allocateResource distributes at most min(slot.Amount, slot.ExtractionLimit) across demands.
// Guarantees exact integer conservation: sum(allocated) == consumed == initialAmount - finalAmount.
func allocateResource(slot *ResourceSlot, demands []int64) ([]int64, bool, error) {
	alloc := make([]int64, len(demands))
	var totalDemand int64
	for _, d := range demands {
		if d > 0 {
			if totalDemand > (1<<63-1)-d {
				return nil, false, ErrNumericOverflow
			} else {
				totalDemand += d
			}
		}
	}
	if totalDemand == 0 || slot.Amount == 0 || slot.ExtractionLimit == 0 {
		return alloc, false, nil
	}

	available := slot.Amount
	if slot.ExtractionLimit < available {
		available = slot.ExtractionLimit
	}

	wasPositive := slot.Amount > 0
	if totalDemand <= available {
		copy(alloc, demands)
		slot.Amount -= totalDemand
		return alloc, wasPositive && slot.Amount == 0, nil
	}

	// Proportional allocation with deterministic canonical remainder distribution.
	var distributed int64
	for i, d := range demands {
		if d <= 0 {
			continue
		}
		hi, lo := bits.Mul64(uint64(d), uint64(available))
		share, _ := bits.Div64(hi, lo, uint64(totalDemand))
		alloc[i] = int64(share)
		distributed += alloc[i]
	}

	remainder := available - distributed
	for i := 0; i < len(demands) && remainder > 0; i++ {
		if alloc[i] < demands[i] {
			alloc[i]++
			remainder--
			distributed++
		}
	}

	slot.Amount -= distributed
	return alloc, wasPositive && slot.Amount == 0, nil
}

func regenerateResource(slot *ResourceSlot) (int64, bool) {
	if slot.MaxCapacity <= 0 || slot.Amount >= slot.MaxCapacity {
		return 0, false
	}
	wasDepleted := slot.Amount == 0
	headroom := slot.MaxCapacity - slot.Amount
	rateGain := mulDivBP(headroom, slot.RegenRateBP)
	gain := rateGain + min(slot.RegenPerEpoch, headroom-rateGain)
	slot.Amount += gain
	return gain, wasDepleted && slot.Amount > 0
}

func unmetRatioBP(demand, allocated int64) int64 {
	if demand <= 0 || allocated >= demand {
		return 0
	}
	unmet := demand - allocated
	return ratioBP(unmet, demand)
}

func computeEcologicalStatus(p ResourcePool) EcologicalStatus {
	// Evaluate primary renewable pools (Food, Wood, Water) as percentage of MaxCapacity.
	var totalPct, count int64
	for _, slot := range []ResourceSlot{p.Food, p.Wood, p.Water} {
		if slot.MaxCapacity > 0 {
			totalPct += ratioBP(slot.Amount, slot.MaxCapacity)
			count++
		}
	}
	if count == 0 {
		return EcoStatusDepleted
	}
	avgBP := totalPct / count
	switch {
	case avgBP >= 7000:
		return EcoStatusThriving
	case avgBP >= 4000:
		return EcoStatusBalanced
	case avgBP >= 1500:
		return EcoStatusStrained
	default:
		return EcoStatusDepleted
	}
}

// ratioBP computes floor((num * 10000) / den) clamped to [0, 10000] safely via 128-bit math.
func ratioBP(num, den int64) int64 {
	if num <= 0 || den <= 0 {
		return 0
	}
	if num >= den {
		return BasisPointsScale
	}
	hi, lo := bits.Mul64(uint64(num), uint64(BasisPointsScale))
	q, _ := bits.Div64(hi, lo, uint64(den))
	if q > uint64(BasisPointsScale) {
		return BasisPointsScale
	}
	return int64(q)
}

// mulDivBP computes floor((val * bp) / 10000) safely via 128-bit math.
func mulDivBP(val, bp int64) int64 {
	if val <= 0 || bp <= 0 {
		return 0
	}
	hi, lo := bits.Mul64(uint64(val), uint64(bp))
	q, _ := bits.Div64(hi, lo, uint64(BasisPointsScale))
	if q > uint64(1<<63-1) {
		return 1<<63 - 1
	}
	return int64(q)
}
