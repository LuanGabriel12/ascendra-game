package ecosystem

import (
	"fmt"
	"math"
	"slices"
	"strings"
)

// processCamps updates dynamic creature camp lifecycles, handles organic camp establishment
// and expansion when resources and population permit, and transitions starved/emptied camps
// to Abandoned. Destroyed camps never generate groups or recover automatically.
func processCamps(state *EcosystemState, cfg Config, events *[]EcologicalEvent) error {
	// 1. Update existing camps in canonical CampID order.
	for i := range state.Camps {
		c := &state.Camps[i]
		if c.State == CampDestroyed || c.State == CampAbandoned {
			c.AssignedPopulation = 0
			c.ThreatContribution = 0
			continue
		}

		pIdx := findPopulationIndex(state.Populations, c.PopulationID)
		rIdx := findRegionIndex(state.Regions, c.RegionID)
		if pIdx < 0 || rIdx < 0 {
			return fmt.Errorf("%w: camp %q broken reference", ErrInvalidReference, c.CampID)
		}
		pop := &state.Populations[pIdx]
		reg := &state.Regions[rIdx]

		if c.ExpansionCooldownEpochs > 0 {
			c.ExpansionCooldownEpochs--
		}

		// Sync assigned population projection (bounded by camp capacity and available free population).
		c.AssignedPopulation = pop.FreePopulation
		if c.AssignedPopulation > c.Capacity {
			c.AssignedPopulation = c.Capacity
		}

		// Check abandonment due to collapsed population.
		if pop.FreePopulation == 0 && pop.ReservedPopulation == 0 && pop.MaterializedPopulation == 0 {
			c.State = CampAbandoned
			c.AssignedPopulation = 0
			c.Reserves = 0
			c.ThreatContribution = 0
			ev, err := state.newEvent(EventCampAbandoned, c.RegionID, c.CampID, c.PopulationID, "Population collapsed", 0)
			if err != nil {
				return err
			}
			*events = append(*events, ev)
			continue
		}

		// Evaluate starvation vs reserve accumulation.
		if pop.ScarcityBP >= 5000 {
			if c.Reserves >= 10 {
				c.Reserves -= 10
			} else {
				c.Reserves = 0
				if c.StarvationEpochs < cfg.CampAbandonStarveEpochs {
					c.StarvationEpochs++
				}
				if c.State != CampResourceStarved {
					c.State = CampResourceStarved
				}
			}
			if c.StarvationEpochs >= cfg.CampAbandonStarveEpochs {
				c.State = CampAbandoned
				c.AssignedPopulation = 0
				c.ThreatContribution = 0
				ev, err := state.newEvent(EventCampAbandoned, c.RegionID, c.CampID, c.PopulationID, "Sustained resource starvation", 0)
				if err != nil {
					return err
				}
				*events = append(*events, ev)
				continue
			}
		} else {
			c.StarvationEpochs = 0
			// Build modest reserves from local surplus food (conserved from region food pool).
			reserveGain := int64(5)
			if reg.Resources.Food.Amount >= reserveGain && c.Reserves <= min(c.Capacity, math.MaxInt64/2)*2-reserveGain {
				reg.Resources.Food.Amount -= reserveGain
				c.Reserves += reserveGain
			}
		}

		// Transition Establishing -> Active once establishment duration completes.
		if c.State == CampEstablishing {
			if state.Epoch >= c.CreatedEpoch && (state.Epoch-c.CreatedEpoch) >= cfg.CampEstablishEpochs {
				c.State = CampActive
			}
		} else if c.State == CampResourceStarved && pop.ScarcityBP < 3000 {
			c.State = CampActive
		} else if c.State == CampExpanding {
			c.State = CampActive
		}

		// Check territorial threat pressure on camp from hostile factions in the region.
		if c.State == CampActive && hasHostileRivalInRegion(state, reg.RegionID, c.FactionID) {
			c.State = CampThreatened
		} else if c.State == CampThreatened && !hasHostileRivalInRegion(state, reg.RegionID, c.FactionID) {
			c.State = CampActive
		}

		// Attempt controlled camp expansion when Active, healthy, and wood is available.
		if c.State == CampActive &&
			c.ExpansionCooldownEpochs == 0 &&
			c.Capacity < cfg.CampMaxCapacity &&
			pop.ScarcityBP < 2000 &&
			ratioBP(pop.FreePopulation, c.Capacity) >= cfg.CampExpandPopRatioBP &&
			reg.Resources.Wood.Amount >= cfg.CampExpandWoodCost {

			reg.Resources.Wood.Amount -= cfg.CampExpandWoodCost
			newCap := c.Capacity + min(cfg.CampExpandCapacityGain, cfg.CampMaxCapacity-c.Capacity)
			gain := newCap - c.Capacity
			c.Capacity = newCap
			c.State = CampExpanding
			c.ExpansionCooldownEpochs = cfg.CampExpansionCooldown

			ev, err := state.newEvent(EventCampExpanded, c.RegionID, c.CampID, c.PopulationID, "Camp expanded", gain)
			if err != nil {
				return err
			}
			*events = append(*events, ev)
		}

		// Update camp threat contribution cleanly from assigned population and reserves.
		c.ThreatContribution = min(c.AssignedPopulation, (math.MaxInt64-c.Reserves/2)/3)*3 + c.Reserves/2
		if c.State == CampExpanding {
			c.ThreatContribution += min(40, math.MaxInt64-c.ThreatContribution)
		}
	}

	// 2. Organic camp establishment for thriving populations without an active camp (bounded by limits & cooldown).
	for i := range state.Populations {
		pop := &state.Populations[i]
		if pop.FreePopulation < cfg.CampEstablishMinPop || pop.ScarcityBP >= 2500 {
			continue
		}
		if countActiveCampsForPopulation(state.Camps, pop.PopulationID) > 0 {
			continue
		}
		if err := tryEstablishCamp(state, pop.PopulationID, cfg, events, false); err != nil {
			// Organic establishment respects caps/cooldowns/wood silently; only hard errors fail.
			if err != ErrCapacityExceeded && err != ErrCampUnavailable && err != ErrInvalidCommand {
				return err
			}
		}
	}

	// 3. Synchronize ActiveCampCount on every Population.
	syncActiveCampCounts(state)
	return nil
}

func tryEstablishCamp(state *EcosystemState, popID string, cfg Config, events *[]EcologicalEvent, strict bool) error {
	pIdx := findPopulationIndex(state.Populations, popID)
	if pIdx < 0 {
		return fmt.Errorf("%w: population %q", ErrUnknownEntity, popID)
	}
	pop := &state.Populations[pIdx]
	rIdx := findRegionIndex(state.Regions, pop.RegionID)
	if rIdx < 0 {
		return fmt.Errorf("%w: region %q", ErrUnknownEntity, pop.RegionID)
	}
	reg := &state.Regions[rIdx]

	if pop.FreePopulation < cfg.CampEstablishMinPop {
		if strict {
			return fmt.Errorf("%w: free population %d below camp threshold %d", ErrInsufficientPopulation, pop.FreePopulation, cfg.CampEstablishMinPop)
		}
		return ErrInvalidCommand
	}
	if reg.Resources.Wood.Amount < cfg.CampEstablishWoodCost {
		if strict {
			return fmt.Errorf("%w: insufficient wood (%d < %d)", ErrCampUnavailable, reg.Resources.Wood.Amount, cfg.CampEstablishWoodCost)
		}
		return ErrCampUnavailable
	}
	if !campCooldownReady(state.CampCooldowns, reg.RegionID, pop.FactionID, state.Epoch) {
		if strict {
			return fmt.Errorf("%w: camp recreation cooldown active", ErrCampUnavailable)
		}
		return ErrCampUnavailable
	}
	if len(state.Camps) >= cfg.MaxCampsTotal ||
		countActiveCampsInRegion(state.Camps, reg.RegionID) >= cfg.MaxCampsPerRegion ||
		countActiveCampsForFaction(state.Camps, pop.FactionID) >= cfg.MaxCampsPerFaction {
		return ErrCapacityExceeded
	}

	reg.Resources.Wood.Amount -= cfg.CampEstablishWoodCost
	if state.CampSeq == math.MaxUint64 {
		return ErrNumericOverflow
	}
	state.CampSeq++
	campID := fmt.Sprintf("camp-%s-%04d", pop.FactionID, state.CampSeq)
	initCap := int64(60)
	if initCap > cfg.CampMaxCapacity {
		initCap = cfg.CampMaxCapacity
	}
	assigned := pop.FreePopulation
	if assigned > initCap {
		assigned = initCap
	}

	camp := Camp{
		CampID:                  campID,
		RegionID:                reg.RegionID,
		FactionID:               pop.FactionID,
		FamilyID:                pop.FamilyID,
		PopulationID:            pop.PopulationID,
		AssignedPopulation:      assigned,
		Capacity:                initCap,
		Reserves:                0,
		State:                   CampEstablishing,
		ThreatContribution:      assigned * 2,
		CreatedEpoch:            state.Epoch,
		ExpansionCooldownEpochs: cfg.CampExpansionCooldown,
		StarvationEpochs:        0,
	}
	insertIdx, _ := slices.BinarySearchFunc(state.Camps, camp.CampID, func(existing Camp, id string) int {
		return strings.Compare(existing.CampID, id)
	})
	state.Camps = slices.Insert(state.Camps, insertIdx, camp)
	syncActiveCampCounts(state)

	ev, err := state.newEvent(EventCampEstablished, reg.RegionID, camp.CampID, pop.PopulationID, "Camp established", camp.Capacity)
	if err != nil {
		return err
	}
	*events = append(*events, ev)
	return nil
}

func destroyCamp(state *EcosystemState, campID string, cfg Config, events *[]EcologicalEvent) error {
	idx := findCampIndex(state.Camps, campID)
	if idx < 0 {
		return fmt.Errorf("%w: camp %q", ErrUnknownEntity, campID)
	}
	c := &state.Camps[idx]
	if c.State == CampDestroyed {
		return fmt.Errorf("%w: camp %q already destroyed", ErrCampUnavailable, campID)
	}
	c.State = CampDestroyed
	c.AssignedPopulation = 0
	c.Reserves = 0
	c.ThreatContribution = 0

	setCampCooldown(state, c.RegionID, c.FactionID, state.Epoch+cfg.CampRecreateCooldownEpochs)
	syncActiveCampCounts(state)

	ev, err := state.newEvent(EventCampDestroyed, c.RegionID, c.CampID, c.PopulationID, "Camp destroyed", 0)
	if err != nil {
		return err
	}
	*events = append(*events, ev)
	return nil
}

func campCooldownKey(regionID, factionID string) string {
	return regionID + "|" + factionID
}

func campCooldownReady(cooldowns []CampCooldownRecord, regionID, factionID string, epoch uint64) bool {
	key := campCooldownKey(regionID, factionID)
	idx, ok := slices.BinarySearchFunc(cooldowns, key, func(r CampCooldownRecord, k string) int {
		return strings.Compare(r.Key, k)
	})
	if !ok {
		return true
	}
	return epoch >= cooldowns[idx].ReadyAtEpoch
}

func setCampCooldown(state *EcosystemState, regionID, factionID string, readyAt uint64) {
	key := campCooldownKey(regionID, factionID)
	idx, ok := slices.BinarySearchFunc(state.CampCooldowns, key, func(r CampCooldownRecord, k string) int {
		return strings.Compare(r.Key, k)
	})
	if ok {
		state.CampCooldowns[idx].ReadyAtEpoch = readyAt
		return
	}
	state.CampCooldowns = slices.Insert(state.CampCooldowns, idx, CampCooldownRecord{
		Key:          key,
		ReadyAtEpoch: readyAt,
	})
}

func syncActiveCampCounts(state *EcosystemState) {
	for i := range state.Populations {
		state.Populations[i].ActiveCampCount = 0
	}
	for _, c := range state.Camps {
		if c.State == CampAbandoned || c.State == CampDestroyed {
			continue
		}
		if pIdx := findPopulationIndex(state.Populations, c.PopulationID); pIdx >= 0 {
			state.Populations[pIdx].ActiveCampCount++
		}
	}
}

func countActiveCampsForPopulation(camps []Camp, popID string) int {
	n := 0
	for _, c := range camps {
		if c.PopulationID == popID && c.State != CampAbandoned && c.State != CampDestroyed {
			n++
		}
	}
	return n
}

func countActiveCampsInRegion(camps []Camp, regionID string) int {
	n := 0
	for _, c := range camps {
		if c.RegionID == regionID && c.State != CampAbandoned && c.State != CampDestroyed {
			n++
		}
	}
	return n
}

func countActiveCampsForFaction(camps []Camp, factionID string) int {
	n := 0
	for _, c := range camps {
		if c.FactionID == factionID && c.State != CampAbandoned && c.State != CampDestroyed {
			n++
		}
	}
	return n
}

func hasHostileRivalInRegion(state *EcosystemState, regionID, factionID string) bool {
	for _, p := range state.Populations {
		if p.RegionID != regionID || p.FactionID == factionID {
			continue
		}
		if p.FreePopulation+p.ReservedPopulation+p.MaterializedPopulation == 0 {
			continue
		}
		if GetStance(state.Factions, factionID, p.FactionID) == StanceHostile {
			return true
		}
	}
	return false
}
