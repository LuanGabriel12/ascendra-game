package ecosystem

import (
	"fmt"
	"math"
	"slices"
	"strings"
)

// processTerritory updates faction territorial influence per region and resolves
// competitive attrition exclusively between explicitly StanceHostile factions.
// Neutral and Allied factions coexist without automatic conflict losses.
func processTerritory(state *EcosystemState, cfg Config, events *[]EcologicalEvent) error {
	for rIdx := range state.Regions {
		reg := &state.Regions[rIdx]

		// Decay recent conflict score cleanly each epoch.
		if cfg.ConflictDecayPerEpoch > 0 && reg.RecentConflictScore > 0 {
			if cfg.ConflictDecayPerEpoch >= reg.RecentConflictScore {
				reg.RecentConflictScore = 0
			} else {
				reg.RecentConflictScore -= cfg.ConflictDecayPerEpoch
			}
		}

		// Compute aggregate regional strength per faction from populations + active camps.
		type factionPower struct {
			factionID string
			power     int64
		}
		powers := make([]factionPower, 0, len(state.Factions))
		for _, f := range state.Factions {
			var pwr int64
			for _, pop := range state.Populations {
				if pop.RegionID != reg.RegionID || pop.FactionID != f.FactionID {
					continue
				}
				tot, err := pop.TotalSize()
				if err != nil {
					return err
				}
				if tot <= 0 {
					continue
				}
				// Bounded strength calculation.
				if pop.StrengthPerIndividual > (math.MaxInt64-pwr)/tot {
					return ErrNumericOverflow
				}
				pwr += tot * pop.StrengthPerIndividual
			}
			for _, c := range state.Camps {
				if c.RegionID == reg.RegionID && c.FactionID == f.FactionID && c.State.CanSupplyMaterialization() {
					if c.Reserves > math.MaxInt64-pwr || c.Capacity > (math.MaxInt64-pwr-c.Reserves)/2 {
						return ErrNumericOverflow
					}
					pwr += c.Capacity*2 + c.Reserves
				}
			}
			if pwr > 0 {
				powers = append(powers, factionPower{factionID: f.FactionID, power: pwr})
			}
		}

		var totalPower int64
		for _, fp := range powers {
			if fp.power > math.MaxInt64-totalPower {
				return ErrNumericOverflow
			}
			totalPower += fp.power
		}

		// 1. Resolve hostile rivalry attrition between explicitly StanceHostile factions present in region.
		if len(powers) >= 2 && cfg.CompetitionAttritionBP > 0 {
			// Precompute opposing hostile power faced by each faction from the consistent pre-attrition snapshot.
			hostilePressure := make([]int64, len(powers))
			for i := range powers {
				for j := range powers {
					if i == j {
						continue
					}
					if GetStance(state.Factions, powers[i].factionID, powers[j].factionID) == StanceHostile {
						hostilePressure[i] += powers[j].power
					}
				}
			}

			for i, fp := range powers {
				opp := hostilePressure[i]
				if opp <= 0 {
					continue
				}
				// Attrition rate scales with opponent's share of local hostile contest:
				// rateBP = CompetitionAttritionBP * opp / (fp.power + opp).
				shareBP := ratioBP(opp, fp.power+opp)
				attritionBP := mulDivBP(cfg.CompetitionAttritionBP, shareBP)
				if attritionBP <= 0 {
					continue
				}

				for pIdx := range state.Populations {
					pop := &state.Populations[pIdx]
					if pop.RegionID != reg.RegionID || pop.FactionID != fp.factionID || pop.FreePopulation == 0 {
						continue
					}
					losses := mulDivBP(pop.FreePopulation, attritionBP)
					if losses == 0 && shareBP >= 5000 && pop.FreePopulation > 1 {
						losses = 1
					}
					if losses > pop.FreePopulation {
						losses = pop.FreePopulation
					}
					if losses > 0 {
						pop.FreePopulation -= losses
						// Hostile pressure pushes weaker faction toward migrating out.
						boost := shareBP / 2
						if pop.MigrationPressureBP+boost > BasisPointsScale {
							pop.MigrationPressureBP = BasisPointsScale
						} else {
							pop.MigrationPressureBP += boost
						}
						room := max(0, cfg.MaxRegionalThreat-reg.RecentConflictScore)
						if losses > room/5 {
							reg.RecentConflictScore = cfg.MaxRegionalThreat
						} else {
							reg.RecentConflictScore += losses * 5
						}
						ev, err := state.newEvent(
							EventPopulationDeclined,
							reg.RegionID,
							pop.PopulationID,
							fp.factionID,
							"Territorial rivalry losses",
							losses,
						)
						if err != nil {
							return err
						}
						*events = append(*events, ev)
					}
				}
			}
		}

		// 2. Recompute target influence shares and shift smoothly (sum <= 10000).
		prevLeader := dominantFaction(reg.FactionInfluences)
		prevMap := make(map[string]int64, len(reg.FactionInfluences))
		for _, inf := range reg.FactionInfluences {
			prevMap[inf.FactionID] = inf.InfluenceBP
		}

		nextInf := make([]FactionInfluence, 0, len(powers))
		if totalPower > 0 {
			var sumBP int64
			for _, fp := range powers {
				targetBP := ratioBP(fp.power, totalPower)
				oldBP := prevMap[fp.factionID]
				updated := moveTowardBP(oldBP, targetBP, cfg.InfluenceShiftStepBP)
				if updated > 0 {
					nextInf = append(nextInf, FactionInfluence{
						FactionID:   fp.factionID,
						InfluenceBP: updated,
					})
					sumBP += updated
				}
			}
			// Also smoothly decay factions that no longer have active power in this region.
			for _, old := range reg.FactionInfluences {
				if hasFactionInSlice(nextInf, old.FactionID) {
					continue
				}
				decayed := moveTowardBP(old.InfluenceBP, 0, cfg.InfluenceShiftStepBP)
				if decayed > 0 {
					nextInf = append(nextInf, FactionInfluence{
						FactionID:   old.FactionID,
						InfluenceBP: decayed,
					})
					sumBP += decayed
				}
			}

			slices.SortFunc(nextInf, func(a, b FactionInfluence) int {
				return strings.Compare(a.FactionID, b.FactionID)
			})
			// Normalize strictly if sumBP > 10000 to preserve invariant sum(InfluenceBP) <= 10000.
			if sumBP > BasisPointsScale {
				excess := sumBP - BasisPointsScale
				for idx := len(nextInf) - 1; idx >= 0 && excess > 0; idx-- {
					trim := excess
					if trim > nextInf[idx].InfluenceBP {
						trim = nextInf[idx].InfluenceBP
					}
					nextInf[idx].InfluenceBP -= trim
					excess -= trim
				}
			}
			// Remove any zeroed entries.
			filtered := nextInf[:0]
			for _, inf := range nextInf {
				if inf.InfluenceBP > 0 {
					filtered = append(filtered, inf)
				}
			}
			nextInf = filtered
		} else {
			// No active power: gently decay residual influence.
			for _, old := range reg.FactionInfluences {
				decayed := moveTowardBP(old.InfluenceBP, 0, cfg.InfluenceShiftStepBP)
				if decayed > 0 {
					nextInf = append(nextInf, FactionInfluence{
						FactionID:   old.FactionID,
						InfluenceBP: decayed,
					})
				}
			}
		}

		reg.FactionInfluences = nextInf
		newLeader := dominantFaction(reg.FactionInfluences)

		// Emit TerritorialInfluenceChanged only on meaningful shift or leadership change (avoid spam).
		significantShift := prevLeader != newLeader
		var maxDelta int64
		for _, inf := range reg.FactionInfluences {
			d := inf.InfluenceBP - prevMap[inf.FactionID]
			if d < 0 {
				d = -d
			}
			if d > maxDelta {
				maxDelta = d
			}
		}
		if maxDelta >= cfg.InfluenceEventThresholdBP {
			significantShift = true
		}
		if significantShift && newLeader != "" {
			ev, err := state.newEvent(
				EventTerritorialInfluenceChanged,
				reg.RegionID,
				newLeader,
				prevLeader,
				fmt.Sprintf("leader=%s", newLeader),
				maxDelta,
			)
			if err != nil {
				return err
			}
			*events = append(*events, ev)
		}
	}
	return nil
}

func moveTowardBP(cur, target, step int64) int64 {
	if cur < target {
		diff := target - cur
		if diff > step {
			return cur + step
		}
		return target
	}
	if cur > target {
		diff := cur - target
		if diff > step {
			return cur - step
		}
		return target
	}
	return cur
}

func hasFactionInSlice(list []FactionInfluence, factionID string) bool {
	for _, item := range list {
		if item.FactionID == factionID {
			return true
		}
	}
	return false
}

func dominantFaction(list []FactionInfluence) string {
	var bestID string
	var bestBP int64 = -1
	for _, inf := range list {
		if inf.InfluenceBP > bestBP || (inf.InfluenceBP == bestBP && inf.FactionID < bestID) {
			bestID = inf.FactionID
			bestBP = inf.InfluenceBP
		}
	}
	return bestID
}
