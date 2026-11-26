package ecosystem

import (
	"fmt"
	"math"
)

// processRegionalThreat computes bounded integer regional threat and applies hysteresis
// transitions between Stable, Growing, Hostile, and Critical threat bands.
// Critical regions emit an event intent subject to EventIntentCooldownEpochs so
// invasions are never spammed every epoch while conditions remain true.
func processRegionalThreat(state *EcosystemState, cfg Config, events *[]EcologicalEvent) error {
	// Precompute settlement-adjacent regions for proximity pressure.
	settlementRegions := make(map[string]struct{}, len(state.Regions))
	for _, r := range state.Regions {
		if r.HasSettlement {
			settlementRegions[r.RegionID] = struct{}{}
		}
	}

	for rIdx := range state.Regions {
		reg := &state.Regions[rIdx]

		var hostileStrength int64
		var hostileCampThreat int64
		var hostileInfluenceBP int64

		for _, pop := range state.Populations {
			if pop.RegionID != reg.RegionID {
				continue
			}
			fIdx := findFactionIndex(state.Factions, pop.FactionID)
			if fIdx < 0 || !state.Factions[fIdx].HostileToSettlement {
				continue
			}
			tot := pop.FreePopulation + pop.MaterializedPopulation
			if tot > (math.MaxInt64-hostileStrength)/pop.StrengthPerIndividual {
				hostileStrength = math.MaxInt64
			} else {
				hostileStrength += tot * pop.StrengthPerIndividual
			}
		}

		for _, c := range state.Camps {
			if c.RegionID != reg.RegionID || !c.State.CanSupplyMaterialization() {
				continue
			}
			fIdx := findFactionIndex(state.Factions, c.FactionID)
			if fIdx < 0 || !state.Factions[fIdx].HostileToSettlement {
				continue
			}
			hostileCampThreat += min(c.ThreatContribution, math.MaxInt64-hostileCampThreat)
		}

		for _, inf := range reg.FactionInfluences {
			fIdx := findFactionIndex(state.Factions, inf.FactionID)
			if fIdx >= 0 && state.Factions[fIdx].HostileToSettlement {
				hostileInfluenceBP += inf.InfluenceBP
			}
		}

		// Settlement proximity factor: 120% inside settlement region, 110% if adjacent, 100% otherwise.
		proximityMult := int64(100)
		if reg.HasSettlement {
			proximityMult = 120
		} else {
			for _, adj := range reg.AdjacentRegions {
				if _, ok := settlementRegions[adj]; ok {
					proximityMult = 110
					break
				}
			}
		}

		// Combine factors into bounded integer score [0, MaxRegionalThreat].
		rawThreat := hostileStrength/6 + hostileCampThreat/2 + hostileInfluenceBP/40
		rawThreat += min(reg.RecentConflictScore/2, math.MaxInt64-rawThreat)
		scaledThreat := mulDivBP(rawThreat, proximityMult*100)
		if scaledThreat < 0 {
			scaledThreat = 0
		}
		if scaledThreat > cfg.MaxRegionalThreat {
			scaledThreat = cfg.MaxRegionalThreat
		}

		prevLevel := reg.ThreatLevel
		reg.ThreatScore = scaledThreat
		nextLevel := evaluateThreatHysteresis(prevLevel, scaledThreat, cfg)
		reg.ThreatLevel = nextLevel

		if nextLevel != prevLevel {
			detail := fmt.Sprintf("%s->%s", prevLevel, nextLevel)
			if nextLevel == ThreatCritical {
				if reg.LastEventIntentEpoch == 0 || state.Epoch >= reg.LastEventIntentEpoch && state.Epoch-reg.LastEventIntentEpoch >= cfg.EventIntentCooldownEpochs {
					reg.LastEventIntentEpoch = state.Epoch
					detail = fmt.Sprintf("%s->%s;intent=InvasionPressure", prevLevel, nextLevel)
				}
			}
			ev, err := state.newEvent(
				EventRegionalThreatChanged,
				reg.RegionID,
				reg.RegionID,
				string(nextLevel),
				detail,
				reg.ThreatScore,
			)
			if err != nil {
				return err
			}
			*events = append(*events, ev)
		} else if nextLevel == ThreatCritical &&
			(reg.LastEventIntentEpoch == 0 || state.Epoch >= reg.LastEventIntentEpoch && state.Epoch-reg.LastEventIntentEpoch >= cfg.EventIntentCooldownEpochs) {
			// Emit throttled intent reminder only after explicit cooldown expires.
			reg.LastEventIntentEpoch = state.Epoch
			ev, err := state.newEvent(
				EventRegionalThreatChanged,
				reg.RegionID,
				reg.RegionID,
				string(nextLevel),
				"Critical;intent=InvasionPressure",
				reg.ThreatScore,
			)
			if err != nil {
				return err
			}
			*events = append(*events, ev)
		}
	}
	return nil
}

// evaluateThreatHysteresis prevents oscillating across threat levels near band edges.
func evaluateThreatHysteresis(current ThreatLevel, score int64, cfg Config) ThreatLevel {
	switch current {
	case ThreatStable:
		if score >= cfg.ThreatCriticalEnter {
			return ThreatCritical
		}
		if score >= cfg.ThreatHostileEnter {
			return ThreatHostile
		}
		if score >= cfg.ThreatGrowingEnter {
			return ThreatGrowing
		}
		return ThreatStable

	case ThreatGrowing:
		if score >= cfg.ThreatCriticalEnter {
			return ThreatCritical
		}
		if score >= cfg.ThreatHostileEnter {
			return ThreatHostile
		}
		if score <= cfg.ThreatGrowingExit {
			return ThreatStable
		}
		return ThreatGrowing

	case ThreatHostile:
		if score >= cfg.ThreatCriticalEnter {
			return ThreatCritical
		}
		if score <= cfg.ThreatGrowingExit {
			return ThreatStable
		}
		if score <= cfg.ThreatHostileExit {
			return ThreatGrowing
		}
		return ThreatHostile

	case ThreatCritical:
		if score <= cfg.ThreatGrowingExit {
			return ThreatStable
		}
		if score <= cfg.ThreatHostileExit {
			return ThreatGrowing
		}
		if score <= cfg.ThreatCriticalExit {
			return ThreatHostile
		}
		return ThreatCritical

	default:
		return ThreatStable
	}
}
