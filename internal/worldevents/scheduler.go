package worldevents

import (
	"fmt"
	"math"
	"slices"
	"strings"
)

// Each in-flight campaign that can create a chained event owns one scheduler
// slot until it terminates or produces that event.
func reservedFollowupSlots(state DirectorState, cfg Config) int {
	if cfg.MaxChainDepth == 0 {
		return 0
	}
	count := 0
	for _, campaign := range state.Campaigns {
		if campaign.State.IsInFlight() && !campaign.TerminalFactEmitted && campaign.ChainDepth < cfg.MaxChainDepth {
			count++
		}
	}
	return count
}

// ReleaseCancelledEvents removes only events already marked cancelled. It is a
// trusted recovery operation that can free scheduler capacity without a tick.
func ReleaseCancelledEvents(state DirectorState, cfg Config) (DirectorState, int, error) {
	if err := state.Validate(cfg); err != nil {
		return DirectorState{}, 0, err
	}
	next := state.Clone()
	kept := make([]ScheduledEvent, 0, len(next.PendingEvents))
	for _, event := range next.PendingEvents {
		if !event.Cancelled {
			kept = append(kept, event)
		}
	}
	removed := len(next.PendingEvents) - len(kept)
	next.PendingEvents = kept
	return next, removed, nil
}

// EnqueueScheduledEvent validates bounds, deadlines, and monotonic EventID generation before
// inserting a future ScheduledEvent into DirectorState.PendingEvents in canonical order.
func EnqueueScheduledEvent(
	state *DirectorState,
	ev ScheduledEvent,
	cfg Config,
) (ScheduledEvent, error) {
	if state == nil {
		return ScheduledEvent{}, fmt.Errorf("%w: nil director state", ErrInvalidState)
	}
	if len(state.PendingEvents)+reservedFollowupSlots(*state, cfg) >= cfg.MaxPendingEvents {
		return ScheduledEvent{}, fmt.Errorf("%w: max pending events %d reached", ErrCapacityExceeded, cfg.MaxPendingEvents)
	}
	if !ev.Kind.Valid() || !ev.Category.Valid() {
		return ScheduledEvent{}, fmt.Errorf("%w: invalid event kind or category", ErrInvalidCommand)
	}
	if ev.DeadlineTick < ev.ScheduledTick {
		return ScheduledEvent{}, fmt.Errorf("%w: deadline %d < scheduled %d", ErrInvalidCommand, ev.DeadlineTick, ev.ScheduledTick)
	}
	if ev.ChainDepth < 0 || ev.ChainDepth > cfg.MaxChainDepth {
		return ScheduledEvent{}, fmt.Errorf("%w: chain_depth %d exceeds max %d", ErrCapacityExceeded, ev.ChainDepth, cfg.MaxChainDepth)
	}
	if state.ScheduledEventSeq == math.MaxUint64 {
		return ScheduledEvent{}, ErrNumericOverflow
	}
	nextSeq := state.ScheduledEventSeq + 1
	eventID := fmt.Sprintf("wev:%s:%06d", state.SimulationID, nextSeq)
	if len(eventID) > cfg.MaxIdentifierLength {
		eventID = fmt.Sprintf("wev:%06d", nextSeq)
	}
	ev.EventID = eventID
	state.ScheduledEventSeq = nextSeq
	state.PendingEvents = insertPendingEventSorted(state.PendingEvents, ev)
	return ev, nil
}

// effectivePriority adds deterministic anti-starvation aging (AgeTicks * PriorityAgingPerTick)
// safely clamped against int64 overflow.
func effectivePriority(ev ScheduledEvent, cfg Config) int64 {
	if ev.AgeTicks == 0 || cfg.PriorityAgingPerTick <= 0 {
		return ev.Priority
	}
	var bonus int64
	if ev.AgeTicks > uint64(math.MaxInt64/cfg.PriorityAgingPerTick) {
		bonus = math.MaxInt64
	} else {
		bonus = int64(ev.AgeTicks) * cfg.PriorityAgingPerTick
	}
	sum, err := safeAddInt64(ev.Priority, bonus)
	if err != nil {
		return math.MaxInt64
	}
	return sum
}

// processScheduler expires overdue events, ages waiting events to prevent starvation,
// and dispatches eligible due events in strict deterministic priority order:
//
//	highest EffectivePriority -> earliest ScheduledTick -> lexicographically smallest EventID.
//
// maxOptionalEvents bounds optional expiry/dispatch director events emitted on a single tick
// so mandatory tick events can never be crowded out into ErrTickEventCapacity.
func processScheduler(
	state *DirectorState,
	cfg Config,
	allowCampaignLaunch bool,
	maxOptionalEvents int,
	dirEvents *[]DirectorEvent,
) ([]ScheduledEvent, error) {
	if len(state.PendingEvents) == 0 {
		return nil, nil
	}

	dueIndices := make([]int, 0, len(state.PendingEvents))
	expiredOrCancelled := make(map[int]struct{})
	optionalUsed := 0

	for i := range state.PendingEvents {
		ev := &state.PendingEvents[i]
		if ev.Cancelled {
			expiredOrCancelled[i] = struct{}{}
			continue
		}
		if state.Tick > ev.DeadlineTick {
			if optionalUsed >= maxOptionalEvents {
				// Defer remaining overdue expirations deterministically to the next tick.
				continue
			}
			expiredOrCancelled[i] = struct{}{}
			de, err := state.newDirectorEvent(
				DirEventCampaignExpired,
				ev.CampaignID,
				ev.RegionID,
				ev.SettlementID,
				ev.FactionID,
				fmt.Sprintf("scheduled event %s expired at tick %d (deadline %d)", ev.EventID, state.Tick, ev.DeadlineTick),
				0,
				nil,
			)
			if err != nil {
				return nil, err
			}
			*dirEvents = append(*dirEvents, de)
			optionalUsed++
			continue
		}
		if state.Tick >= ev.ScheduledTick {
			dueIndices = append(dueIndices, i)
		}
	}

	// Sort due event indices by EffectivePriority desc -> ScheduledTick asc -> EventID asc.
	slices.SortFunc(dueIndices, func(ia, ib int) int {
		a, b := state.PendingEvents[ia], state.PendingEvents[ib]
		pa, pb := effectivePriority(a, cfg), effectivePriority(b, cfg)
		if pa != pb {
			if pa > pb {
				return -1
			}
			return 1
		}
		if a.ScheduledTick != b.ScheduledTick {
			if a.ScheduledTick < b.ScheduledTick {
				return -1
			}
			return 1
		}
		return strings.Compare(a.EventID, b.EventID)
	})

	// Count current concurrency usage.
	activeGlobal := 0
	activeByRegion := make(map[string]int)
	activeBySettlement := make(map[string]int)
	for _, c := range state.Campaigns {
		if c.State.IsInFlight() {
			activeGlobal++
			activeByRegion[c.RegionID]++
			if c.SettlementID != "" {
				activeBySettlement[c.SettlementID]++
			}
		}
	}

	dispatched := make([]ScheduledEvent, 0, len(dueIndices))
	dispatchedSet := make(map[int]struct{})

	for _, idx := range dueIndices {
		ev := &state.PendingEvents[idx]
		isCampaignLaunch := ev.Kind == EventGoblinRaidCampaign || ev.Kind == EventOrcWarbandCampaign

		if optionalUsed >= maxOptionalEvents {
			if ev.AgeTicks < math.MaxUint64 {
				ev.AgeTicks++
			}
			continue
		}
		if isCampaignLaunch {
			blocked := !allowCampaignLaunch || activeGlobal >= cfg.MaxActiveCampaignsGlobal ||
				activeByRegion[ev.RegionID] >= cfg.MaxActiveCampaignsPerRegion ||
				(ev.SettlementID != "" && activeBySettlement[ev.SettlementID] >= cfg.MaxActiveCampaignsPerSettlement) ||
				!cooldownReady(state.RegionCooldowns, ev.RegionID, state.Tick) ||
				(ev.SettlementID != "" && !cooldownReady(state.SettlementCooldowns, ev.SettlementID, state.Tick))
			if blocked {
				// Increment anti-starvation age safely while waiting for a slot.
				if ev.AgeTicks < math.MaxUint64 {
					ev.AgeTicks++
				}
				continue
			}
			activeGlobal++
			activeByRegion[ev.RegionID]++
			if ev.SettlementID != "" {
				activeBySettlement[ev.SettlementID]++
			}
		}

		dispatched = append(dispatched, *ev)
		dispatchedSet[idx] = struct{}{}
		optionalUsed++
	}

	// Retain only non-expired, non-cancelled, non-dispatched pending events.
	kept := make([]ScheduledEvent, 0, len(state.PendingEvents))
	for i, ev := range state.PendingEvents {
		if _, drop := expiredOrCancelled[i]; drop {
			continue
		}
		if _, sent := dispatchedSet[i]; sent {
			continue
		}
		kept = append(kept, ev)
	}
	state.PendingEvents = kept
	return dispatched, nil
}
