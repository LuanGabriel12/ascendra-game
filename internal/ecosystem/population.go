package ecosystem

import "math/bits"

// PopulationDelta captures the exact integer births and deaths applied to one population
// in a single ecological epoch: FreeNext = Free + Births - Deaths.
type PopulationDelta struct {
	Births int64
	Deaths int64
}

// processPopulations applies the discrete, overflow-safe logistic growth and mortality model:
//
//   births = floor((Free * effGrowthBP + GrowthResidualBP) / 10000)
//   deaths = floor((Free * totalMortBP + MortalityResidualBP) / 10000)
//   Free_next = Free + births - deaths
//
// Guarantees:
// - Extinct populations (FreePopulation == 0) never spontaneously generate births.
// - K == 0 produces zero births and triggers scarcity mortality.
// - N >= K produces zero births and triggers overcrowding mortality.
// - Serializable GrowthResidualBP / MortalityResidualBP prevent permanent integer-truncation
//   stagnation on small populations without floats.
func processPopulations(state *EcosystemState, cfg Config, events *[]EcologicalEvent) error {
	for i := range state.Populations {
		pop := &state.Populations[i]
		if pop.FreePopulation == 0 {
			// Invariant: extinct free population cannot spontaneously regenerate.
			pop.GrowthResidualBP = 0
			pop.MortalityResidualBP = 0
			pop.MigrationPressureBP = 0
			continue
		}

		totalSize, err := pop.TotalSize()
		if err != nil {
			return err
		}

		// Determine effective carrying capacity bounded by both population and region capacity.
		k := pop.CarryingCapacity
		if rIdx := findRegionIndex(state.Regions, pop.RegionID); rIdx >= 0 {
			if state.Regions[rIdx].CarryingCapacity < k {
				k = state.Regions[rIdx].CarryingCapacity
			}
		}

		var births int64
		var overcrowdingMortBP int64

		if k > 0 && totalSize < k {
			// Density factor (1 - N/K) in BasisPoints [0, 10000].
			densityBP := ratioBP(k-totalSize, k)
			// Resource supply factor (1 - Scarcity) in BasisPoints [0, 10000].
			supplyBP := BasisPointsScale - pop.ScarcityBP
			effGrowthBP := mulDivBP(mulDivBP(pop.GrowthRateBP, densityBP), supplyBP)

			b, nextRes, err := applyRateWithResidual(pop.FreePopulation, effGrowthBP, pop.GrowthResidualBP)
			if err != nil {
				return err
			}
			if b > cfg.MaxBirthsPerEpoch {
				b = cfg.MaxBirthsPerEpoch
			}
			// Never grow past safe int64 limits.
			if _, err := safeAddInt64(totalSize, b); err != nil {
				return err
			}
			births = b
			pop.GrowthResidualBP = nextRes
		} else if k == 0 {
			// Zero carrying capacity: no births and maximal overcrowding/habitat pressure.
			overcrowdingMortBP = cfg.OvercrowdingMortalityBP
		} else {
			// Overcrowded (N >= K): no births, mortality rises proportionally to excess density.
			excess := totalSize - k
			excessBP := ratioBP(excess, k)
			overcrowdingMortBP = mulDivBP(cfg.OvercrowdingMortalityBP, excessBP)
		}

		// Total mortality combines natural mortality, scarcity starvation, and overcrowding.
		starveMortBP := mulDivBP(cfg.StarvationMortalityBP, pop.ScarcityBP)
		if k == 0 && starveMortBP < cfg.StarvationMortalityBP {
			starveMortBP = cfg.StarvationMortalityBP
		}
		totalMortBP := pop.MortalityRateBP + starveMortBP + overcrowdingMortBP
		if totalMortBP > BasisPointsScale {
			totalMortBP = BasisPointsScale
		}

		deaths, nextMortRes, err := applyRateWithResidual(pop.FreePopulation, totalMortBP, pop.MortalityResidualBP)
		if err != nil {
			return err
		}
		if deaths > pop.FreePopulation {
			deaths = pop.FreePopulation
		}
		pop.MortalityResidualBP = nextMortRes

		// Apply exact conservation equation: P_next = P + births - deaths.
		// Deaths are capped at pre-birth FreePopulation so net result is strictly >= 0.
		nextFree, err := safeAddInt64(pop.FreePopulation-deaths, births)
		if err != nil {
			return err
		}
		prevFree := pop.FreePopulation
		pop.FreePopulation = nextFree

		// Update migration pressure from density, scarcity, and habitat loss.
		var densityPressureBP int64
		if k == 0 {
			densityPressureBP = BasisPointsScale
		} else {
			densityPressureBP = ratioBP(totalSize, k)
		}
		// Weighted migration pressure: 55% scarcity + 45% density.
		pop.MigrationPressureBP = (pop.ScarcityBP*55 + densityPressureBP*45) / 100
		if pop.MigrationPressureBP > BasisPointsScale {
			pop.MigrationPressureBP = BasisPointsScale
		}

		netChange := pop.FreePopulation - prevFree
		if netChange > 0 {
			ev, err := state.newEvent(EventPopulationGrew, pop.RegionID, pop.PopulationID, "", "Ecological growth", netChange)
			if err != nil {
				return err
			}
			*events = append(*events, ev)
		} else if netChange < 0 {
			ev, err := state.newEvent(EventPopulationDeclined, pop.RegionID, pop.PopulationID, "", "Ecological decline", -netChange)
			if err != nil {
				return err
			}
			*events = append(*events, ev)
		}
	}
	return nil
}

// applyRateWithResidual computes (count * rateBP + residualBP) / 10000 and remainder % 10000
// using 128-bit unsigned arithmetic to guarantee zero overflow and deterministic residual tracking.
func applyRateWithResidual(count, rateBP, residualBP int64) (int64, int64, error) {
	if count <= 0 || (rateBP <= 0 && residualBP <= 0) {
		return 0, residualBP, nil
	}
	hi, lo := bits.Mul64(uint64(count), uint64(rateBP))
	lo2, carry := bits.Add64(lo, uint64(residualBP), 0)
	hi2 := hi + carry
	if hi2 >= uint64(BasisPointsScale) {
		return 0, 0, ErrNumericOverflow
	}
	q, rem := bits.Div64(hi2, lo2, uint64(BasisPointsScale))
	if q > uint64(1<<63-1) {
		return 0, 0, ErrNumericOverflow
	}
	return int64(q), int64(rem), nil
}
