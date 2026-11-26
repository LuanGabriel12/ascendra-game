package ai

import (
	"fmt"
	"math"
	"slices"
	"sort"
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
	FocusTarget      TargetRef
	RallyPoint       int64
	MoraleAuraBP     int64
	NearbyAllies     int64
	NearbySameFamily int64
	NearbyRetreating int64
}

type spatialPeer struct {
	pos      int64
	groupIdx int
}

type familySpatialIndex struct {
	pos           []int64
	retreatPrefix []int64
	cmdrPos       []int64
	cmdrIdx       []int
	cmdrAuraPref  []int64
}

type defenderEntry struct {
	pos       int64
	targetIdx int
}

// Coordinate deterministically computes collective directives (commander focus-fire,
// rally orders, goblin pack flanking, and nearby ally/retreat awareness).
//
// Cycle 03 optimization: replaces the Cycle 02 O(G^2) pairwise loop with a 1D sorted
// spatial index + prefix sums + binary search, achieving O(G log G) for all peer-count,
// retreat-count, commander aura, and nearest-commander queries even in the densely
// stacked worst case where all G groups share the exact same 1D coordinate.
//
// Remaining complexity notes:
// - Commander target selection runs SelectTarget once per active commander: O(C * T).
// - Decentralized flank/threat selection scans defenders inside [pos-AlertRange, pos+AlertRange]
//   via binary search over spatially sorted defenders: O(log D + D_in_range) per uncommanded group.
// - Input groups MUST be sorted strictly by GroupID so results never depend on caller order.
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
	if len(groups) == 0 {
		return orders, nil
	}

	// Collect active groups once and build 1D spatial indices.
	activePeers := make([]spatialPeer, 0, len(groups))
	var famPeers [3][]spatialPeer
	var famCmdrs [3][]spatialPeer

	commanderTarget := make([]TargetRef, len(groups))
	for i, g := range groups {
		if !isGroupActiveForCoord(g) {
			continue
		}
		sp := spatialPeer{pos: g.Position, groupIdx: i}
		activePeers = append(activePeers, sp)

		fc := g.FamilyOrProfile().Code()
		if int(fc) < len(famPeers) {
			famPeers[fc] = append(famPeers[fc], sp)
			if g.Profile.Role == RoleCommander && g.State != StateRetreat {
				famCmdrs[fc] = append(famCmdrs[fc], sp)
			}
		}

		if g.Profile.Role == RoleCommander {
			sel, ok := SelectTarget(g.Position, g.HomePosition, g.Profile, targets, CoordinationOrder{}, invasionActive)
			if ok {
				commanderTarget[i] = sel.Ref()
			}
		}
	}

	// Sort all active peers by Position ascending (groupIdx is already canonical GroupID order).
	sortSpatialPeers(activePeers)
	allPos := make([]int64, len(activePeers))
	for i, p := range activePeers {
		allPos[i] = p.pos
	}

	// Build per-family prefix-sum indices for O(log G) range queries.
	var famIndex [3]familySpatialIndex
	for fc := 1; fc < len(famPeers); fc++ {
		if len(famPeers[fc]) > 0 {
			sortSpatialPeers(famPeers[fc])
			n := len(famPeers[fc])
			posArr := make([]int64, n)
			retPref := make([]int64, n+1)
			for i, p := range famPeers[fc] {
				posArr[i] = p.pos
				retPref[i+1] = retPref[i]
				if groups[p.groupIdx].State == StateRetreat {
					retPref[i+1]++
				}
			}
			famIndex[fc].pos = posArr
			famIndex[fc].retreatPrefix = retPref
		}

		if len(famCmdrs[fc]) > 0 {
			sortSpatialPeers(famCmdrs[fc])
			m := len(famCmdrs[fc])
			cPos := make([]int64, m)
			cIdx := make([]int, m)
			cAura := make([]int64, m+1)
			for i, p := range famCmdrs[fc] {
				cPos[i] = p.pos
				cIdx[i] = p.groupIdx
				cAura[i+1] = cAura[i] + groups[p.groupIdx].Profile.CommanderAuraBP
			}
			famIndex[fc].cmdrPos = cPos
			famIndex[fc].cmdrIdx = cIdx
			famIndex[fc].cmdrAuraPref = cAura
		}
	}

	// Spatially sort alive defenders once so decentralized pack selection only visits in-range defenders.
	sortedDefenders := make([]defenderEntry, 0, len(targets))
	for idx, t := range targets {
		if t.Kind == TargetDefender && t.HP > 0 {
			sortedDefenders = append(sortedDefenders, defenderEntry{pos: t.Position, targetIdx: idx})
		}
	}
	slices.SortFunc(sortedDefenders, func(a, b defenderEntry) int {
		if a.pos != b.pos {
			if a.pos < b.pos {
				return -1
			}
			return 1
		}
		return strings.Compare(targets[a.targetIdx].TargetID, targets[b.targetIdx].TargetID)
	})

	for i, self := range groups {
		ord := CoordinationOrder{
			GroupID: self.GroupID,
			Kind:    OrderNone,
		}
		if !isGroupActiveForCoord(self) {
			orders[i] = ord
			continue
		}

		loPos, hiPos := clampRange(self.Position, self.Profile.AlertRange)

		// 1. NearbyAllies across all active groups via O(log G) binary search.
		alo := lowerBoundInt64(allPos, loPos)
		ahi := upperBoundInt64(allPos, hiPos)
		if ahi > alo {
			ord.NearbyAllies = int64(ahi - alo - 1)
		}

		// 2. Same-family allies, retreating allies, commander aura, and nearest commander in O(log G).
		fc := self.FamilyOrProfile().Code()
		bestCommanderIdx := -1
		if int(fc) < len(famIndex) {
			fi := &famIndex[fc]
			if len(fi.pos) > 0 {
				flo := lowerBoundInt64(fi.pos, loPos)
				fhi := upperBoundInt64(fi.pos, hiPos)
				if fhi > flo {
					ord.NearbySameFamily = int64(fhi - flo - 1)
					retreats := fi.retreatPrefix[fhi] - fi.retreatPrefix[flo]
					if self.State == StateRetreat {
						retreats--
					}
					ord.NearbyRetreating = retreats
				}
			}

			if len(fi.cmdrPos) > 0 {
				clo := lowerBoundInt64(fi.cmdrPos, loPos)
				chi := upperBoundInt64(fi.cmdrPos, hiPos)
				if chi > clo {
					aura := fi.cmdrAuraPref[chi] - fi.cmdrAuraPref[clo]
					if self.Profile.Role == RoleCommander && self.State != StateRetreat {
						aura -= self.Profile.CommanderAuraBP
					}
					if aura > MaxCommanderAuraBP {
						aura = MaxCommanderAuraBP
					}
					if aura < 0 {
						aura = 0
					}
					ord.MoraleAuraBP = aura
					bestCommanderIdx = findNearestCommander(fi.cmdrPos, fi.cmdrIdx, clo, chi, self.Position, i, groups)
				}
			}
		}

		// 3. Inherit commander tactical rally or focus-fire order.
		if bestCommanderIdx >= 0 {
			cmdr := groups[bestCommanderIdx]
			ord.CommanderID = cmdr.GroupID
			if self.State == StateRetreat || self.MoraleBP <= self.Profile.RallyMoraleBP {
				ord.Kind = OrderRally
				ord.RallyPoint = cmdr.Position
			} else if !commanderTarget[bestCommanderIdx].IsZero() {
				ord.Kind = OrderFocusTarget
				ord.FocusTarget = commanderTarget[bestCommanderIdx]
				ord.TargetID = ord.FocusTarget.ID
			}
			orders[i] = ord
			continue
		}

		// 4. Commander self-directive when no other commander leads it.
		if self.Profile.Role == RoleCommander && self.State != StateRetreat {
			ord.CommanderID = self.GroupID
			if ord.NearbyRetreating > 0 {
				ord.Kind = OrderRally
				ord.RallyPoint = self.Position
			} else if !commanderTarget[i].IsZero() {
				ord.Kind = OrderFocusTarget
				ord.FocusTarget = commanderTarget[i]
				ord.TargetID = ord.FocusTarget.ID
			}
			orders[i] = ord
			continue
		}

		// 5. Family-specific decentralized pack coordination without a commander.
		if self.Profile.Family == FamilyGoblin && ord.NearbySameFamily >= 1 && len(sortedDefenders) > 0 {
			if weakTarget, ok := selectWeakestDefenderSpatial(self.Position, loPos, hiPos, sortedDefenders, targets); ok {
				ord.Kind = OrderFlankWeak
				ord.FocusTarget = weakTarget
				ord.TargetID = weakTarget.ID
			}
		} else if self.Profile.Family == FamilyOrc && ord.NearbySameFamily >= 1 && len(sortedDefenders) > 0 {
			if threatTarget, ok := selectHighestThreatDefenderSpatial(self.Position, loPos, hiPos, sortedDefenders, targets); ok {
				ord.Kind = OrderFocusTarget
				ord.FocusTarget = threatTarget
				ord.TargetID = threatTarget.ID
			}
		}

		orders[i] = ord
	}

	return orders, nil
}

// findNearestCommander locates the active non-retreating commander != selfIdx inside [clo, chi)
// minimizing (|pos - selfPos|, GroupID) in O(log C).
// Precondition: cmdrPos[clo:chi] is sorted by (Position asc, groupIdx asc), where groupIdx is sorted by GroupID.
func findNearestCommander(
	cmdrPos []int64,
	cmdrIdx []int,
	clo, chi int,
	selfPos int64,
	selfIdx int,
	groups []GroupSnapshot,
) int {
	mid := clo + lowerBoundInt64(cmdrPos[clo:chi], selfPos)

	// Best right candidate (>= selfPos): first entry at or after mid that is not selfIdx.
	rightCand := -1
	for k := mid; k < chi; k++ {
		if cmdrIdx[k] != selfIdx {
			rightCand = cmdrIdx[k]
			break
		}
	}

	// Best left candidate (< selfPos): earliest GroupID sharing the closest position < selfPos.
	leftCand := -1
	if mid > clo {
		leftPos := cmdrPos[mid-1]
		leftFirst := clo + lowerBoundInt64(cmdrPos[clo:mid], leftPos)
		// leftPos < selfPos so cmdrIdx[leftFirst] can never be selfIdx.
		leftCand = cmdrIdx[leftFirst]
	}

	if leftCand < 0 {
		return rightCand
	}
	if rightCand < 0 {
		return leftCand
	}

	leftDist := absDiffInt64(selfPos, groups[leftCand].Position)
	rightDist := absDiffInt64(selfPos, groups[rightCand].Position)
	if leftDist < rightDist {
		return leftCand
	}
	if rightDist < leftDist {
		return rightCand
	}
	if groups[leftCand].GroupID < groups[rightCand].GroupID {
		return leftCand
	}
	return rightCand
}

func sortSpatialPeers(peers []spatialPeer) {
	slices.SortFunc(peers, func(a, b spatialPeer) int {
		if a.pos != b.pos {
			if a.pos < b.pos {
				return -1
			}
			return 1
		}
		if a.groupIdx < b.groupIdx {
			return -1
		}
		if a.groupIdx > b.groupIdx {
			return 1
		}
		return 0
	})
}

func clampRange(pos, radius int64) (int64, int64) {
	if radius < 0 {
		radius = 0
	}
	var lo, hi int64
	if pos < math.MinInt64+radius {
		lo = math.MinInt64
	} else {
		lo = pos - radius
	}
	if pos > math.MaxInt64-radius {
		hi = math.MaxInt64
	} else {
		hi = pos + radius
	}
	return lo, hi
}

func lowerBoundInt64(arr []int64, target int64) int {
	return sort.Search(len(arr), func(i int) bool { return arr[i] >= target })
}

func upperBoundInt64(arr []int64, target int64) int {
	return sort.Search(len(arr), func(i int) bool { return arr[i] > target })
}

func (g GroupSnapshot) FamilyOrProfile() Family {
	return g.Profile.Family
}

func isGroupActiveForCoord(g GroupSnapshot) bool {
	return g.HP > 0 && g.State != StateDead && !g.Routed
}

func selectWeakestDefenderSpatial(selfPos, loPos, hiPos int64, sorted []defenderEntry, targets []PerceivedTarget) (TargetRef, bool) {
	lo := sort.Search(len(sorted), func(i int) bool { return sorted[i].pos >= loPos })
	hi := sort.Search(len(sorted), func(i int) bool { return sorted[i].pos > hiPos })
	if lo >= hi {
		return TargetRef{}, false
	}
	var best TargetRef
	var bestRatio int64 = -1
	var bestDist int64
	found := false

	for k := lo; k < hi; k++ {
		t := targets[sorted[k].targetIdx]
		dist := absDiffInt64(selfPos, t.Position)
		missingRatio := ratioPermille(t.MaxHP-t.HP, t.MaxHP)
		if !found || missingRatio > bestRatio ||
			(missingRatio == bestRatio && dist < bestDist) ||
			(missingRatio == bestRatio && dist == bestDist && t.TargetID < best.ID) {
			best = t.Ref()
			bestRatio = missingRatio
			bestDist = dist
			found = true
		}
	}
	return best, found
}

func selectHighestThreatDefenderSpatial(selfPos, loPos, hiPos int64, sorted []defenderEntry, targets []PerceivedTarget) (TargetRef, bool) {
	lo := sort.Search(len(sorted), func(i int) bool { return sorted[i].pos >= loPos })
	hi := sort.Search(len(sorted), func(i int) bool { return sorted[i].pos > hiPos })
	if lo >= hi {
		return TargetRef{}, false
	}
	var best TargetRef
	var bestThreat int64 = -1
	var bestDist int64
	found := false

	for k := lo; k < hi; k++ {
		t := targets[sorted[k].targetIdx]
		dist := absDiffInt64(selfPos, t.Position)
		if !found || t.ThreatScore > bestThreat ||
			(t.ThreatScore == bestThreat && dist < bestDist) ||
			(t.ThreatScore == bestThreat && dist == bestDist && t.TargetID < best.ID) {
			best = t.Ref()
			bestThreat = t.ThreatScore
			bestDist = dist
			found = true
		}
	}
	return best, found
}
