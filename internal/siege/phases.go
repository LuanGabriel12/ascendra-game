package siege

import (
	"fmt"
	"slices"

	"ascendra-game/internal/ai"
	"ascendra-game/internal/ports"
)

// CombatantSnapshot is a read-only view of a battlefield combatant (invader group or defender)
// passed by internal/world into pure siege evaluation functions.
type CombatantSnapshot struct {
	ID          string
	ZoneID      string
	HP          int64
	MaxHP       int64
	MoraleBP    int64
	Family      ai.Family
	Role        DefenderRole
	IsInvader   bool
	IsCommander bool
	IsNPC       bool
}

// ObjectiveChange reports an authoritative objective status transition.
type ObjectiveChange struct {
	ObjectiveID string
	Side        ObjectiveSide
	Kind        ObjectiveKind
	From        ObjectiveState
	To          ObjectiveState
	ActorID     string
}

// DistrictChange reports a zone territorial control state transition.
type DistrictChange struct {
	ZoneID string
	From   DistrictState
	To     DistrictState
}

// ValidatePhaseTransition enforces the explicit finite state machine of siege phases.
func ValidatePhaseTransition(from, to SiegePhase) error {
	if !from.Valid() || !to.Valid() {
		return fmt.Errorf("%w: unknown phase %q -> %q", ErrInvalidPhaseTransition, from, to)
	}
	if from == to {
		return fmt.Errorf("%w: self-transition %s -> %s", ErrInvalidPhaseTransition, from, to)
	}
	allowed := false
	switch from {
	case PhaseApproach:
		allowed = to == PhaseAssault || to == PhaseBreach || to == PhaseResolving
	case PhaseAssault:
		allowed = to == PhaseBreach || to == PhaseResolving
	case PhaseBreach:
		allowed = to == PhaseDistrictCombat || to == PhaseCitadelAssault || to == PhaseResolving
	case PhaseDistrictCombat:
		allowed = to == PhaseCitadelAssault || to == PhaseResolving
	case PhaseCitadelAssault:
		allowed = to == PhaseResolving
	case PhaseResolving:
		allowed = to == PhaseDefended || to == PhaseCaptured || to == PhaseWithdrawn
	case PhaseDefended, PhaseCaptured, PhaseWithdrawn:
		allowed = false
	}
	if !allowed {
		return fmt.Errorf("%w: %s -> %s is forbidden", ErrInvalidPhaseTransition, from, to)
	}
	return nil
}

// TransitionPhase moves the siege FSM forward if legal and updates PhaseStartedTick.
func TransitionPhase(state *SiegeState, to SiegePhase, tick uint64) error {
	if state == nil {
		return fmt.Errorf("%w: nil siege state", ErrInvalidState)
	}
	if err := ValidatePhaseTransition(state.Phase, to); err != nil {
		return err
	}
	state.Phase = to
	state.PhaseStartedTick = tick
	if to.IsTerminal() {
		state.CompletedTick = tick
	}
	return nil
}

// EvaluateDistricts updates territorial control progress on all capturable zones with
// explicit hysteresis (DistrictHysteresisTicks) preventing rapid oscillation.
// Because each combatant occupies at most one ZoneID, a single group can NEVER capture
// multiple districts simultaneously.
func EvaluateDistricts(state *SiegeState, combatants []CombatantSnapshot, tick uint64, cfg Config) ([]DistrictChange, bool) {
	changes := make([]DistrictChange, 0)
	progressed := false

	invByZone := make(map[string]int, len(state.Zones))
	defByZone := make(map[string]int, len(state.Zones))
	for _, c := range combatants {
		if c.HP <= 0 {
			continue
		}
		if c.IsInvader {
			invByZone[c.ZoneID]++
		} else {
			defByZone[c.ZoneID]++
		}
	}

	outerBreached := state.HasOuterBreach()

	for i := range state.Zones {
		z := &state.Zones[i]
		if !z.Capturable {
			continue
		}
		// Inner districts cannot be captured while outer fortifications remain intact.
		if !outerBreached && z.Depth >= 3 {
			continue
		}
		inv := invByZone[z.ZoneID]
		def := defByZone[z.ZoneID]
		threshold := cfg.DistrictCaptureThreshold
		if z.Kind == ZoneCitadel {
			threshold = cfg.CitadelCaptureThreshold
		}

		prevState := z.ControlState
		prevProg := z.ControlProgress

		if inv > 0 && def == 0 {
			// Uncontested invader capture progress.
			step := cfg.DistrictControlStep * int64(min(inv, 3))
			z.ControlProgress += step
			if z.ControlProgress > threshold {
				z.ControlProgress = threshold
			}
		} else if inv > 0 && def > 0 {
			// Contested fight: net advantage moves control slowly.
			if inv > def {
				z.ControlProgress += max(int64(1), cfg.DistrictControlStep/2)
				if z.ControlProgress > threshold {
					z.ControlProgress = threshold
				}
			} else if def > inv && z.ControlProgress > 0 {
				z.ControlProgress -= max(int64(1), cfg.DistrictControlStep/2)
				if z.ControlProgress < 0 {
					z.ControlProgress = 0
				}
			}
		} else if inv == 0 && def > 0 && z.ControlProgress > 0 {
			// Defenders reclaim uncontested zone.
			z.ControlProgress -= cfg.DistrictControlStep
			if z.ControlProgress < 0 {
				z.ControlProgress = 0
			}
		}

		if z.ControlProgress != prevProg {
			progressed = true
		}

		// Determine desired ownership state with hysteresis against rapid flip-flopping.
		desired := prevState
		switch {
		case z.ControlProgress >= threshold:
			desired = DistrictInvaderControlled
		case z.ControlProgress == 0:
			if def > 0 || prevState != DistrictNeutralized {
				desired = DistrictDefenderControlled
			}
		case inv > 0 || z.ControlProgress > 0:
			desired = DistrictContested
		}

		if desired != prevState {
			// Apply hysteresis when switching full ownership (DefenderControlled <-> InvaderControlled)
			// unless transitioning immediately into Contested or hitting exact 0/threshold after cooldown.
			canFlip := desired == DistrictContested ||
				z.LastControlTick == 0 ||
				tick >= z.LastControlTick+cfg.DistrictHysteresisTicks ||
				z.ControlProgress == threshold ||
				z.ControlProgress == 0
			if canFlip {
				z.ControlState = desired
				z.LastControlTick = tick
				if desired == DistrictInvaderControlled {
					z.ControllingFactionID = state.InvadingFactionID
				} else if desired == DistrictDefenderControlled {
					z.ControllingFactionID = ""
				}
				changes = append(changes, DistrictChange{
					ZoneID: z.ZoneID,
					From:   prevState,
					To:     desired,
				})
				progressed = true
			}
		}
	}
	return changes, progressed
}

// EvaluateObjectives unlocks prerequisites and updates authoritative progress/completion
// of siege objectives from actual battlefield state (structures, districts, commanders).
func EvaluateObjectives(state *SiegeState, combatants []CombatantSnapshot, tick uint64) ([]ObjectiveChange, bool) {
	changes := make([]ObjectiveChange, 0)
	progressed := false

	completedSet := make(map[string]bool, len(state.Objectives))
	for _, o := range state.Objectives {
		if o.State == ObjCompleted {
			completedSet[o.ObjectiveID] = true
		}
	}

	// 1. Unlock Locked objectives once all prerequisites are Completed.
	for i := range state.Objectives {
		o := &state.Objectives[i]
		if o.State != ObjLocked {
			continue
		}
		ready := true
		for _, pre := range o.PrerequisiteIDs {
			if !completedSet[pre] {
				ready = false
				break
			}
		}
		if ready {
			o.State = ObjActive
			changes = append(changes, ObjectiveChange{
				ObjectiveID: o.ObjectiveID,
				Side:        o.Side,
				Kind:        o.Kind,
				From:        ObjLocked,
				To:          ObjActive,
			})
			progressed = true
		}
	}

	// 2. Evaluate active objectives against authoritative world state.
	for i := range state.Objectives {
		o := &state.Objectives[i]
		if o.State != ObjActive {
			continue
		}
		prevProg := o.Progress
		switch o.Kind {
		case ObjDestroyGate:
			if idx := state.FindStructureIndex(o.TargetStructureID); idx >= 0 {
				st := state.Structures[idx]
				dmg := st.MaxHP - st.HP
				if dmg > o.TargetProgress {
					dmg = o.TargetProgress
				}
				o.Progress = dmg
				if st.HP == 0 || st.State == StructureDestroyed {
					completeObjective(o, tick, state.InvadingFactionID, &changes)
					completedSet[o.ObjectiveID] = true
				}
			}

		case ObjOpenBreach:
			if state.HasOuterBreach() {
				o.Progress = o.TargetProgress
				completeObjective(o, tick, state.InvadingFactionID, &changes)
				completedSet[o.ObjectiveID] = true
			}

		case ObjCaptureDistrict:
			if zIdx := state.FindZoneIndex(o.ZoneID); zIdx >= 0 {
				z := state.Zones[zIdx]
				prog := z.ControlProgress
				if prog > o.TargetProgress {
					prog = o.TargetProgress
				}
				o.Progress = prog
				if z.ControlState == DistrictInvaderControlled {
					o.Progress = o.TargetProgress
					completeObjective(o, tick, state.InvadingFactionID, &changes)
					completedSet[o.ObjectiveID] = true
				}
			}

		case ObjDisruptSupplies:
			if idx := state.FindStructureIndex(o.TargetStructureID); idx >= 0 {
				st := state.Structures[idx]
				dmg := st.MaxHP - st.HP
				if dmg > o.TargetProgress {
					dmg = o.TargetProgress
				}
				o.Progress = dmg
				if st.HP == 0 || st.State == StructureDestroyed {
					completeObjective(o, tick, state.InvadingFactionID, &changes)
					completedSet[o.ObjectiveID] = true
				}
			}

		case ObjAssaultCitadel:
			if idx := state.FindStructureIndex(o.TargetStructureID); idx >= 0 {
				st := state.Structures[idx]
				dmg := st.MaxHP - st.HP
				if dmg > o.TargetProgress {
					dmg = o.TargetProgress
				}
				o.Progress = dmg
				zIdx := state.FindZoneIndex(o.ZoneID)
				citCaptured := zIdx >= 0 && state.Zones[zIdx].ControlState == DistrictInvaderControlled
				if st.HP == 0 || st.State == StructureDestroyed || citCaptured {
					o.Progress = o.TargetProgress
					completeObjective(o, tick, state.InvadingFactionID, &changes)
					completedSet[o.ObjectiveID] = true
				}
			}

		case ObjDefendGate:
			if idx := state.FindStructureIndex(o.TargetStructureID); idx >= 0 && state.Structures[idx].State == StructureDestroyed {
				failObjective(o, &changes)
			}

		case ObjProtectSupplies:
			if idx := state.FindStructureIndex(o.TargetStructureID); idx >= 0 && state.Structures[idx].State == StructureDestroyed {
				failObjective(o, &changes)
			}

		case ObjHoldDistrict:
			if zIdx := state.FindZoneIndex(o.ZoneID); zIdx >= 0 && state.Zones[zIdx].ControlState == DistrictInvaderControlled {
				failObjective(o, &changes)
			}

		case ObjDefeatCommander:
			// Complete automatically when at least one siege commander was deployed and all deployed commanders are defeated.
			deployed := 0
			defeated := 0
			killer := ""
			for _, cmdr := range state.Commanders {
				if cmdr.Deployed {
					deployed++
					if !cmdr.Alive {
						defeated++
						if killer == "" {
							killer = cmdr.DefeatedByPlayerID
						}
					}
				}
			}
			if deployed > 0 && defeated == deployed {
				o.Progress = o.TargetProgress
				completeObjective(o, tick, killer, &changes)
				completedSet[o.ObjectiveID] = true
			}
		}
		if o.Progress != prevProg {
			progressed = true
		}
	}

	if len(changes) > 0 {
		progressed = true
	}
	return changes, progressed
}

// ValidateAndCompletePlayerObjective enforces authoritative world conditions when a player
// submits CmdCompleteObjective during an active siege. Blind completion by ID is unconditionally rejected.
func ValidateAndCompletePlayerObjective(
	state *SiegeState,
	objectiveID string,
	playerID string,
	playerZoneID string,
	playerRepairs int,
	combatants []CombatantSnapshot,
	tick uint64,
) error {
	if state == nil {
		return fmt.Errorf("%w: nil siege state", ErrInvalidState)
	}
	if state.Phase.IsTerminal() || state.Phase == PhaseResolving {
		return fmt.Errorf("%w: cannot complete objective during phase %s", ErrInvalidPhaseTransition, state.Phase)
	}
	idx := state.FindObjectiveIndex(objectiveID)
	if idx < 0 {
		return fmt.Errorf("%w: objective %q does not exist", ErrUnknownEntity, objectiveID)
	}
	o := &state.Objectives[idx]
	if o.Side != SideDefense {
		return fmt.Errorf("%w: defenders cannot complete invasion objective %q", ErrObjectiveConditionNotMet, objectiveID)
	}
	if o.State == ObjCompleted {
		return fmt.Errorf("%w: %q", ErrDuplicateObjective, objectiveID)
	}
	if o.State != ObjActive {
		return fmt.Errorf("%w: objective %q is in state %s", ErrObjectiveConditionNotMet, objectiveID, o.State)
	}
	// Player must be physically present in the objective's zone (or adjacent connected zone).
	if !AreAdjacent(*state, playerZoneID, o.ZoneID) {
		return fmt.Errorf("%w: player in %q is too far from objective zone %q", ErrZoneBlocked, playerZoneID, o.ZoneID)
	}

	// Verify authoritative condition specific to ObjectiveKind.
	switch o.Kind {
	case ObjDefendGate:
		// Gate must still be standing and have endured or repelled assault pressure (phase >= Assault or gate damaged) with no live invader currently at the gate zone.
		sIdx := state.FindStructureIndex(o.TargetStructureID)
		if sIdx < 0 || state.Structures[sIdx].HP == 0 {
			return fmt.Errorf("%w: gate is already destroyed", ErrObjectiveConditionNotMet)
		}
		if state.Phase == PhaseApproach && state.Structures[sIdx].HP == state.Structures[sIdx].MaxHP {
			return fmt.Errorf("%w: gate has not faced assault pressure yet", ErrObjectiveConditionNotMet)
		}
		if hasLiveInvadersInZone(combatants, o.ZoneID) {
			return fmt.Errorf("%w: invaders still contesting %q", ErrObjectiveConditionNotMet, o.ZoneID)
		}

	case ObjRepairFortification:
		// Player must have actually executed a valid supply-backed repair during this siege.
		if playerRepairs <= 0 {
			return fmt.Errorf("%w: player %q has not performed a valid fortification repair", ErrObjectiveConditionNotMet, playerID)
		}
		sIdx := state.FindStructureIndex(o.TargetStructureID)
		if sIdx < 0 || state.Structures[sIdx].RepairsApplied <= 0 {
			return fmt.Errorf("%w: target fortification %q has not been repaired", ErrObjectiveConditionNotMet, o.TargetStructureID)
		}

	case ObjProtectSupplies:
		sIdx := state.FindStructureIndex(o.TargetStructureID)
		if sIdx < 0 || state.Structures[sIdx].HP == 0 {
			return fmt.Errorf("%w: supply depot destroyed", ErrObjectiveConditionNotMet)
		}
		if !state.HasOuterBreach() {
			return fmt.Errorf("%w: supplies are not yet threatened by a breach", ErrObjectiveConditionNotMet)
		}
		if hasLiveInvadersInZone(combatants, o.ZoneID) {
			return fmt.Errorf("%w: invaders still present in supply district", ErrObjectiveConditionNotMet)
		}

	case ObjHoldDistrict:
		zIdx := state.FindZoneIndex(o.ZoneID)
		if zIdx < 0 || state.Zones[zIdx].ControlState != DistrictDefenderControlled {
			return fmt.Errorf("%w: district %q is not controlled by defenders", ErrObjectiveConditionNotMet, o.ZoneID)
		}
		if !state.HasOuterBreach() {
			return fmt.Errorf("%w: district %q has not been threatened by a breach", ErrObjectiveConditionNotMet, o.ZoneID)
		}
		if hasLiveInvadersInZone(combatants, o.ZoneID) {
			return fmt.Errorf("%w: invaders still present in %q", ErrObjectiveConditionNotMet, o.ZoneID)
		}

	case ObjDefeatCommander:
		deployed := 0
		alive := 0
		for _, cmdr := range state.Commanders {
			if cmdr.Deployed {
				deployed++
				if cmdr.Alive {
					alive++
				}
			}
		}
		if deployed == 0 || alive > 0 {
			return fmt.Errorf("%w: siege commander is still active or not deployed", ErrObjectiveConditionNotMet)
		}

	default:
		return fmt.Errorf("%w: unsupported objective kind %q", ErrObjectiveConditionNotMet, o.Kind)
	}

	o.Progress = o.TargetProgress
	o.State = ObjCompleted
	o.CompletedTick = tick
	o.CompletedByID = playerID
	return nil
}

// EvaluatePhaseAndResolution advances siege phases deterministically and evaluates authoritative
// victory, defeat, withdrawal, and anti-stall conditions. Returns terminal == true ONLY when
// the siege transitions through PhaseResolving into Defended, Captured, or Withdrawn.
func EvaluatePhaseAndResolution(
	state *SiegeState,
	combatants []CombatantSnapshot,
	tick uint64,
	madeProgress bool,
	cfg Config,
) (phaseTransitions []SiegePhase, terminal bool, outcome ports.InvasionOutcome, reason string, err error) {
	if state == nil {
		return nil, false, ports.InvasionOutcomeNone, "", fmt.Errorf("%w: nil siege state", ErrInvalidState)
	}
	if state.Phase.IsTerminal() {
		return nil, true, state.Phase.ToInvasionOutcome(), state.TerminalReason, nil
	}
	if madeProgress {
		state.LastProgressTick = tick
	}

	// Count live invaders, pending waves, average invader morale, and spatial penetration.
	liveInvaders := 0
	var totalMorale int64
	reachedApproachOrGate := false
	reachedInnerDistrict := false
	reachedCitadel := false

	for _, c := range combatants {
		if !c.IsInvader || c.HP <= 0 {
			continue
		}
		liveInvaders++
		totalMorale += c.MoraleBP
		zIdx := state.FindZoneIndex(c.ZoneID)
		if zIdx < 0 {
			continue
		}
		z := state.Zones[zIdx]
		if z.Depth >= 1 {
			reachedApproachOrGate = true
		}
		if z.Depth >= 3 {
			reachedInnerDistrict = true
		}
		if z.Kind == ZoneCitadel {
			reachedCitadel = true
		}
	}

	pendingWaves := 0
	for _, w := range state.Waves {
		if w.State == WaveScheduled {
			pendingWaves++
		}
	}

	// 1. Check authoritative CAPTURED condition first:
	//    Required outer fortification compromised AND Citadel structure destroyed OR Citadel zone captured.
	citStructDestroyed := false
	for _, st := range state.Structures {
		if st.Kind == StructureCitadel && (st.HP == 0 || st.State == StructureDestroyed) {
			citStructDestroyed = true
			break
		}
	}
	citZoneCaptured := false
	for _, z := range state.Zones {
		if z.Kind == ZoneCitadel && z.ControlState == DistrictInvaderControlled {
			citZoneCaptured = true
			break
		}
	}
	if state.HasOuterBreach() && (citStructDestroyed || citZoneCaptured) {
		if err := finalizeSiegePhase(state, PhaseCaptured, "citadel compromised", tick, &phaseTransitions); err != nil {
			return nil, false, ports.InvasionOutcomeNone, "", err
		}
		return phaseTransitions, true, ports.InvasionOutcomeCaptured, state.TerminalReason, nil
	}

	// 2. Check authoritative DEFENDED condition: all invaders eliminated and no waves remain.
	if liveInvaders == 0 && pendingWaves == 0 {
		if err := finalizeSiegePhase(state, PhaseDefended, "all invading forces neutralized", tick, &phaseTransitions); err != nil {
			return nil, false, ports.InvasionOutcomeNone, "", err
		}
		return phaseTransitions, true, ports.InvasionOutcomeDefended, state.TerminalReason, nil
	}

	// 3. Check collective morale withdrawal (Goblin vs Orc thresholds) when no wave is imminent
	//    and invaders suffered casualties or lost their commander.
	if liveInvaders > 0 && pendingWaves == 0 {
		avgMorale := totalMorale / int64(liveInvaders)
		withdrawThreshold := cfg.GoblinWithdrawMoraleBP
		if state.InvadingFamily == ai.FamilyOrc {
			withdrawThreshold = cfg.OrcWithdrawMoraleBP
		}
		cmdrFallen := false
		for _, cmdr := range state.Commanders {
			if cmdr.Deployed && !cmdr.Alive {
				cmdrFallen = true
				break
			}
		}
		if avgMorale <= withdrawThreshold && (state.InvaderCasualties > 0 || cmdrFallen) {
			reason := "invader morale collapse"
			if cmdrFallen {
				reason = "commander fallen and invader morale collapsed"
			}
			if err := finalizeSiegePhase(state, PhaseWithdrawn, reason, tick, &phaseTransitions); err != nil {
				return nil, false, ports.InvasionOutcomeNone, "", err
			}
			return phaseTransitions, true, ports.InvasionOutcomeDefended, state.TerminalReason, nil
		}
	}

	// 4. Deterministic anti-stall and hard siege duration policy: prevents permanent deadlock.
	noProgressElapsed := uint64(0)
	if tick >= state.LastProgressTick {
		noProgressElapsed = tick - state.LastProgressTick
	}
	totalElapsed := uint64(0)
	if tick >= state.StartedTick {
		totalElapsed = tick - state.StartedTick
	}
	if noProgressElapsed >= cfg.NoProgressTimeoutTicks && pendingWaves == 0 {
		if err := finalizeSiegePhase(state, PhaseWithdrawn, "offensive stalled without progress", tick, &phaseTransitions); err != nil {
			return nil, false, ports.InvasionOutcomeNone, "", err
		}
		return phaseTransitions, true, ports.InvasionOutcomeDefended, state.TerminalReason, nil
	}
	if totalElapsed >= cfg.SiegeMaxDurationTicks {
		if err := finalizeSiegePhase(state, PhaseWithdrawn, "siege duration limit reached", tick, &phaseTransitions); err != nil {
			return nil, false, ports.InvasionOutcomeNone, "", err
		}
		return phaseTransitions, true, ports.InvasionOutcomeDefended, state.TerminalReason, nil
	}

	// 5. Normal progressive phase transitions along the Siege FSM.
	for {
		var nextPhase SiegePhase
		switch state.Phase {
		case PhaseApproach:
			if state.HasOuterBreach() {
				nextPhase = PhaseBreach
			} else if reachedApproachOrGate {
				nextPhase = PhaseAssault
			}
		case PhaseAssault:
			if state.HasOuterBreach() {
				nextPhase = PhaseBreach
			}
		case PhaseBreach:
			if reachedCitadel {
				nextPhase = PhaseCitadelAssault
			} else if reachedInnerDistrict {
				nextPhase = PhaseDistrictCombat
			}
		case PhaseDistrictCombat:
			if reachedCitadel {
				nextPhase = PhaseCitadelAssault
			}
		}
		if nextPhase == "" || nextPhase == state.Phase {
			break
		}
		if err := TransitionPhase(state, nextPhase, tick); err != nil {
			return nil, false, ports.InvasionOutcomeNone, "", err
		}
		state.LastProgressTick = tick
		phaseTransitions = append(phaseTransitions, nextPhase)
	}

	return phaseTransitions, false, ports.InvasionOutcomeNone, "", nil
}

func finalizeSiegePhase(state *SiegeState, finalPhase SiegePhase, reason string, tick uint64, transitions *[]SiegePhase) error {
	if state.Phase != PhaseResolving {
		if err := TransitionPhase(state, PhaseResolving, tick); err != nil {
			return err
		}
		*transitions = append(*transitions, PhaseResolving)
	}
	state.TerminalReason = reason
	if err := TransitionPhase(state, finalPhase, tick); err != nil {
		return err
	}
	*transitions = append(*transitions, finalPhase)
	// Finalize remaining Active defense objectives deterministically upon settlement victory/withdrawal.
	if finalPhase == PhaseDefended || finalPhase == PhaseWithdrawn {
		for i := range state.Objectives {
			o := &state.Objectives[i]
			if o.Side == SideDefense && o.State == ObjActive {
				if o.Kind == ObjDefendGate {
					if sIdx := state.FindStructureIndex(o.TargetStructureID); sIdx >= 0 && state.Structures[sIdx].HP > 0 {
						o.Progress = o.TargetProgress
						o.State = ObjCompleted
						o.CompletedTick = tick
					}
				} else if o.Kind == ObjProtectSupplies {
					if sIdx := state.FindStructureIndex(o.TargetStructureID); sIdx >= 0 && state.Structures[sIdx].HP > 0 {
						o.Progress = o.TargetProgress
						o.State = ObjCompleted
						o.CompletedTick = tick
					}
				}
			}
		}
	}
	return nil
}

func completeObjective(o *Objective, tick uint64, actorID string, changes *[]ObjectiveChange) {
	prev := o.State
	o.State = ObjCompleted
	o.CompletedTick = tick
	o.CompletedByID = actorID
	*changes = append(*changes, ObjectiveChange{
		ObjectiveID: o.ObjectiveID,
		Side:        o.Side,
		Kind:        o.Kind,
		From:        prev,
		To:          ObjCompleted,
		ActorID:     actorID,
	})
}

func failObjective(o *Objective, changes *[]ObjectiveChange) {
	prev := o.State
	o.State = ObjFailed
	*changes = append(*changes, ObjectiveChange{
		ObjectiveID: o.ObjectiveID,
		Side:        o.Side,
		Kind:        o.Kind,
		From:        prev,
		To:          ObjFailed,
	})
}

func hasLiveInvadersInZone(combatants []CombatantSnapshot, zoneID string) bool {
	for _, c := range combatants {
		if c.IsInvader && c.HP > 0 && c.ZoneID == zoneID {
			return true
		}
	}
	return false
}

// UpsertWave inserts or updates a SiegeWave in canonical sorted order by WaveID.
// Rejects duplicate WaveIDs to ensure idempotent wave scheduling.
func UpsertWave(state *SiegeState, wave SiegeWave, cfg Config) error {
	if state == nil {
		return fmt.Errorf("%w: nil siege state", ErrInvalidState)
	}
	if err := validateID(wave.WaveID, cfg.MaxIdentifierLength); err != nil {
		return fmt.Errorf("%w: wave_id: %v", ErrInvalidCommand, err)
	}
	if idx := state.FindWaveIndex(wave.WaveID); idx >= 0 {
		return fmt.Errorf("%w: duplicate wave_id %q", ErrInvalidCommand, wave.WaveID)
	}
	if len(state.Waves) >= cfg.MaxWaves {
		return fmt.Errorf("%w: max waves %d reached", ErrCapacityExceeded, cfg.MaxWaves)
	}
	if _, err := ai.LookupProfile(wave.Archetype); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidCommand, err)
	}
	if wave.Count <= 0 || state.FindZoneIndex(wave.EntryZoneID) < 0 || !wave.State.Valid() {
		return fmt.Errorf("%w: invalid wave parameters", ErrInvalidCommand)
	}
	insertIdx, _ := slices.BinarySearchFunc(state.Waves, wave.WaveID, func(existing SiegeWave, id string) int {
		if existing.WaveID < id {
			return -1
		}
		if existing.WaveID > id {
			return 1
		}
		return 0
	})
	state.Waves = slices.Insert(state.Waves, insertIdx, wave)
	return nil
}
