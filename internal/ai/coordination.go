package ai

import (
	"fmt"
	"strings"
)

// MaxCommanderAuraBP caps stacked morale auras to prevent runaway numeric inflation.
const MaxCommanderAuraBP int64 = 2400

// OrderKind identifies a collective tactical directive computed across nearby allies.
type OrderKind string

const (
	OrderNone        OrderKind = "None"
	OrderFocusTarget OrderKind = "FocusTarget"
	OrderFlankWeak   OrderKind = "FlankWeak"
	OrderRally       OrderKind = "Rally"
)

// GroupSnapshot is the minimal canonical peer projection used by Coordinate.
type GroupSnapshot struct {
	GroupID      string
	Profile      Profile
	State        State
	Position     int64
	HomePosition int64
	HP           int64
	MaxHP        int64
	MoraleBP     int64
	Routed       bool
}

// CoordinationOrder summarizes collective pack/warband context for one actor on one tick.
type CoordinationOrder struct {
	GroupID          string
	Kind             OrderKind
	CommanderID      string
	TargetID         string
	RallyPoint       int64
	MoraleAuraBP     int64
	NearbyAllies     int64
	NearbySameFamily int64
	NearbyRetreating int64
}

// Coordinate deterministically computes collective directives (commander focus-fire,
// rally orders, goblin pack flanking, and nearby ally/retreat awareness).
// Input groups MUST be sorted strictly by GroupID so results never depend on caller order.
func Coordinate(
	groups []GroupSnapshot,
	targets []PerceivedTarget,
	invasionActive bool,
) ([]CoordinationOrder, error) {
	for i, g := range groups {
		if strings.TrimSpace(g.GroupID) == "" {
			return nil, fmt.Errorf("%w: empty group_id in coordination", ErrInvalidPerception)
		}
		if i > 0 && groups[i-1].GroupID >= g.GroupID {
			return nil, fmt.Errorf("%w: coordination groups must be strictly sorted by group_id", ErrInvalidPerception)
		}
		if err := g.Profile.Validate(); err != nil {
			return nil, err
		}
	}
	for _, t := range targets {
		if err := t.Validate(); err != nil {
			return nil, err
		}
	}

	orders := make([]CoordinationOrder, len(groups))

	// Precompute each active commander's preferred focus target deterministically.
	commanderTarget := make([]string, len(groups))
	for i, g := range groups {
		if !isGroupActiveForCoord(g) || g.Profile.Role != RoleCommander {
			continue
		}
		sel, ok := SelectTarget(g.Position, g.HomePosition, g.Profile, targets, CoordinationOrder{}, invasionActive)
		if ok {
			commanderTarget[i] = sel.TargetID
		}
	}

	for i, self := range groups {
		ord := CoordinationOrder{
			GroupID: self.GroupID,
			Kind:    OrderNone,
		}
		if !isGroupActiveForCoord(self) {
			orders[i] = ord
			continue
		}

		var bestCommanderIdx = -1
		var bestCommanderDist int64

		for j, peer := range groups {
			if i == j || !isGroupActiveForCoord(peer) {
				continue
			}
			dist := absDiffInt64(self.Position, peer.Position)
			if dist > self.Profile.AlertRange {
				continue
			}
			ord.NearbyAllies++
			if peer.FamilyOrProfile() == self.FamilyOrProfile() {
				ord.NearbySameFamily++
				if peer.State == StateRetreat {
					ord.NearbyRetreating++
				}
				if peer.Profile.Role == RoleCommander && peer.State != StateRetreat {
					ord.MoraleAuraBP += peer.Profile.CommanderAuraBP
					if ord.MoraleAuraBP > MaxCommanderAuraBP {
						ord.MoraleAuraBP = MaxCommanderAuraBP
					}
					if bestCommanderIdx < 0 || dist < bestCommanderDist || (dist == bestCommanderDist && peer.GroupID < groups[bestCommanderIdx].GroupID) {
						bestCommanderIdx = j
						bestCommanderDist = dist
					}
				}
			}
		}

		// 1. If a same-family commander is nearby, inherit tactical rally or focus-fire order.
		if bestCommanderIdx >= 0 {
			cmdr := groups[bestCommanderIdx]
			ord.CommanderID = cmdr.GroupID
			if self.State == StateRetreat || self.MoraleBP <= self.Profile.RallyMoraleBP {
				ord.Kind = OrderRally
				ord.RallyPoint = cmdr.Position
			} else if commanderTarget[bestCommanderIdx] != "" {
				ord.Kind = OrderFocusTarget
				ord.TargetID = commanderTarget[bestCommanderIdx]
			}
			orders[i] = ord
			continue
		}

		// 2. If this actor IS a commander, set its own focus target or rally nearby shaken allies.
		if self.Profile.Role == RoleCommander && self.State != StateRetreat {
			ord.CommanderID = self.GroupID
			if ord.NearbyRetreating > 0 {
				ord.Kind = OrderRally
				ord.RallyPoint = self.Position
			} else if commanderTarget[i] != "" {
				ord.Kind = OrderFocusTarget
				ord.TargetID = commanderTarget[i]
			}
			orders[i] = ord
			continue
		}

		// 3. Family-specific decentralized pack coordination without a commander.
		if self.Profile.Family == FamilyGoblin && ord.NearbySameFamily >= 1 {
			// Goblin packs opportunistically flank the most wounded perceivable defender.
			if weakTargetID, ok := selectWeakestDefender(self.Position, self.Profile.AlertRange, targets); ok {
				ord.Kind = OrderFlankWeak
				ord.TargetID = weakTargetID
			}
		} else if self.Profile.Family == FamilyOrc && ord.NearbySameFamily >= 1 {
			// Orc warbands focus the highest-threat perceivable defender.
			if threatTargetID, ok := selectHighestThreatDefender(self.Position, self.Profile.AlertRange, targets); ok {
				ord.Kind = OrderFocusTarget
				ord.TargetID = threatTargetID
			}
		}

		orders[i] = ord
	}

	return orders, nil
}

func (g GroupSnapshot) FamilyOrProfile() Family {
	return g.Profile.Family
}

func isGroupActiveForCoord(g GroupSnapshot) bool {
	return g.HP > 0 && g.State != StateDead && !g.Routed
}

func selectWeakestDefender(selfPos, alertRange int64, targets []PerceivedTarget) (string, bool) {
	var bestID string
	var bestRatio int64 = -1
	var bestDist int64
	found := false

	for _, t := range targets {
		if t.Kind != TargetDefender || t.HP <= 0 {
			continue
		}
		dist := absDiffInt64(selfPos, t.Position)
		if dist > alertRange {
			continue
		}
		missingRatio := ratioPermille(t.MaxHP-t.HP, t.MaxHP)
		if !found || missingRatio > bestRatio ||
			(missingRatio == bestRatio && dist < bestDist) ||
			(missingRatio == bestRatio && dist == bestDist && t.TargetID < bestID) {
			bestID = t.TargetID
			bestRatio = missingRatio
			bestDist = dist
			found = true
		}
	}
	return bestID, found
}

func selectHighestThreatDefender(selfPos, alertRange int64, targets []PerceivedTarget) (string, bool) {
	var bestID string
	var bestThreat int64 = -1
	var bestDist int64
	found := false

	for _, t := range targets {
		if t.Kind != TargetDefender || t.HP <= 0 {
			continue
		}
		dist := absDiffInt64(selfPos, t.Position)
		if dist > alertRange {
			continue
		}
		if !found || t.ThreatScore > bestThreat ||
			(t.ThreatScore == bestThreat && dist < bestDist) ||
			(t.ThreatScore == bestThreat && dist == bestDist && t.TargetID < bestID) {
			bestID = t.TargetID
			bestThreat = t.ThreatScore
			bestDist = dist
			found = true
		}
	}
	return bestID, found
}
