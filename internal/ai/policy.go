package ai

import (
	"errors"
	"fmt"
	"math/bits"

	"ascendra-game/internal/simulation"
)

// BasisPointsScale represents 100.00% in integer fixed-point math (no floats).
const BasisPointsScale uint64 = 10000

var ErrInvalidPerception = errors.New("invalid ai perception")

// State represents the explicit finite state machine state of a hostile creature group.
type State string

const (
	StateIdle       State = "Idle"
	StatePatrol     State = "Patrol"
	StateAdvance    State = "Advance"
	StateAttack     State = "Attack"
	StateRetreat    State = "Retreat"
	StateDead       State = "Dead"
	StateReturnHome State = "ReturnHome"
	StateRally      State = "Rally"
)

// Valid reports whether the AI state is known.
func (s State) Valid() bool {
	switch s {
	case StateIdle, StatePatrol, StateAdvance, StateAttack, StateRetreat, StateDead, StateReturnHome, StateRally:
		return true
	default:
		return false
	}
}

// Code returns a stable canonical integer code for checksum encoding.
func (s State) Code() uint8 {
	switch s {
	case StateIdle:
		return 1
	case StatePatrol:
		return 2
	case StateAdvance:
		return 3
	case StateAttack:
		return 4
	case StateRetreat:
		return 5
	case StateDead:
		return 6
	case StateReturnHome:
		return 7
	case StateRally:
		return 8
	default:
		return 0
	}
}

// ActionKind defines the explicit intent emitted by the AI policy for the simulation tick.
type ActionKind string

const (
	ActionNone             ActionKind = "None"
	ActionHold             ActionKind = "Hold"
	ActionPatrolStep       ActionKind = "PatrolStep"
	ActionMoveTowardTarget ActionKind = "MoveTowardTarget"
	ActionStrikeSettlement ActionKind = "StrikeSettlement"
	ActionStrikeTarget     ActionKind = "StrikeTarget"
	ActionRetreatStep      ActionKind = "RetreatStep"
	ActionReturnHome       ActionKind = "ReturnHome"
	ActionRallyStep        ActionKind = "RallyStep"
)

// Perception contains all data required for a pure, deterministic AI evaluation.
// The AI never queries hidden global state or wall-clock time.
type Perception struct {
	Tick                 uint64
	GroupID              string
	CurrentState         State
	HP                   int64
	MaxHP                int64
	RetreatThresholdBP   int64 // Legacy fallback when Profile.Archetype == ""
	DistanceToSettlement int64 // Current position in WorldUnits (0 = settlement gate), >= 0
	AttackRange          int64 // Legacy fallback when Profile.Archetype == ""
	MoveSpeedPerTick     int64 // Legacy fallback when Profile.Archetype == ""
	AttackCooldownTicks  int64 // Remaining ticks before strike is legal, >= 0
	InvasionActive       bool
	SettlementAlive      bool

	// Cycle 02 & 03 Creature AI Engine inputs (active when Profile.Archetype != "").
	Profile                     Profile
	HomePosition                int64 // Territorial anchor in WorldUnits, >= 0
	MoraleBP                    int64 // Current morale in [0, 10000]
	RecentDamageTaken           int64 // Authoritative damage taken since last tick, >= 0
	CommanderFallenShock        bool  // Explicit morale shock when a nearby same-family commander falls
	RetainedTarget              TargetRef
	TargetMemoryTicks           int64 // Remaining ticks of target retention memory, >= 0
	ReinforceCooldownTicks      int64 // Remaining ticks before calling reinforcements, >= 0
	RemainingReinforcementCalls int   // Remaining calls allowed for this group, >= 0
	Targets                     []PerceivedTarget
	Order                       CoordinationOrder
}

// Validate checks numeric and enum invariants on AI perception input.
func (p Perception) Validate() error {
	if p.GroupID == "" {
		return fmt.Errorf("%w: empty group_id", ErrInvalidPerception)
	}
	if !p.CurrentState.Valid() {
		return fmt.Errorf("%w: unknown state %q", ErrInvalidPerception, p.CurrentState)
	}
	if p.MaxHP <= 0 {
		return fmt.Errorf("%w: max_hp must be > 0, got %d", ErrInvalidPerception, p.MaxHP)
	}
	if p.HP < 0 || p.HP > p.MaxHP {
		return fmt.Errorf("%w: hp %d out of range [0, %d]", ErrInvalidPerception, p.HP, p.MaxHP)
	}
	if p.DistanceToSettlement < 0 {
		return fmt.Errorf("%w: negative distance %d", ErrInvalidPerception, p.DistanceToSettlement)
	}
	if p.AttackCooldownTicks < 0 {
		return fmt.Errorf("%w: negative attack_cooldown %d", ErrInvalidPerception, p.AttackCooldownTicks)
	}

	if p.Profile.Archetype != "" {
		if err := p.Profile.Validate(); err != nil {
			return err
		}
		if p.HomePosition < 0 {
			return fmt.Errorf("%w: negative home_position %d", ErrInvalidPerception, p.HomePosition)
		}
		if p.MoraleBP < 0 || uint64(p.MoraleBP) > BasisPointsScale {
			return fmt.Errorf("%w: morale_bp %d out of [0, %d]", ErrInvalidPerception, p.MoraleBP, BasisPointsScale)
		}
		if p.RecentDamageTaken < 0 {
			return fmt.Errorf("%w: negative recent_damage_taken %d", ErrInvalidPerception, p.RecentDamageTaken)
		}
		if p.TargetMemoryTicks < 0 || !p.RetainedTarget.Valid() {
			return fmt.Errorf("%w: invalid target retention state", ErrInvalidPerception)
		}
		if p.ReinforceCooldownTicks < 0 || p.RemainingReinforcementCalls < 0 {
			return fmt.Errorf("%w: negative reinforcement cooldown or calls", ErrInvalidPerception)
		}
		for _, t := range p.Targets {
			if err := t.Validate(); err != nil {
				return err
			}
		}
		return nil
	}

	// Legacy minimal perception path (Cycle 01 compatibility).
	if p.RetreatThresholdBP < 0 || uint64(p.RetreatThresholdBP) > BasisPointsScale {
		return fmt.Errorf("%w: retreat_threshold_bp %d out of [0, %d]", ErrInvalidPerception, p.RetreatThresholdBP, BasisPointsScale)
	}
	if p.AttackRange <= 0 {
		return fmt.Errorf("%w: attack_range must be > 0, got %d", ErrInvalidPerception, p.AttackRange)
	}
	if p.MoveSpeedPerTick < 0 {
		return fmt.Errorf("%w: negative move_speed %d", ErrInvalidPerception, p.MoveSpeedPerTick)
	}
	return nil
}

// Decision is the deterministic output produced by Evaluate for one logical tick.
type Decision struct {
	NextState              State
	Action                 ActionKind
	MoveDelta              int64 // Signed change to DistanceToSettlement (- closer to 0, + farther from 0)
	TargetID               string
	TargetKind             TargetKind
	Target                 TargetRef
	NextTargetMemoryTicks  int64
	NewMoraleBP            int64
	RequestReinforcements  bool
	ReinforcementArchetype string
	ReinforcementCount     int64
	TerritoryTriggered     bool
}

// Evaluate computes the next AI state, morale, target, movement, and reinforcement request
// deterministically from Perception and seeded RNG.
func Evaluate(p Perception, rng *simulation.DeterministicRNG) (Decision, error) {
	if err := p.Validate(); err != nil {
		return Decision{}, err
	}
	if rng == nil {
		return Decision{}, fmt.Errorf("%w: nil rng", ErrInvalidPerception)
	}

	// Invariant: a dead entity can never move, rally, call reinforcements, or attack.
	if p.HP == 0 || p.CurrentState == StateDead {
		return Decision{
			NextState:   StateDead,
			Action:      ActionNone,
			MoveDelta:   0,
			NewMoraleBP: 0,
		}, nil
	}

	// If no Cycle 02 Profile is attached, execute the minimal Cycle 01 policy cleanly.
	if p.Profile.Archetype == "" {
		return evaluateLegacy(p, rng), nil
	}

	return evaluateWithProfile(p, rng), nil
}

func evaluateLegacy(p Perception, rng *simulation.DeterministicRNG) Decision {
	if p.CurrentState == StateRetreat || hpAtOrBelowBP(p.HP, p.MaxHP, p.RetreatThresholdBP) {
		return Decision{
			NextState: StateRetreat,
			Action:    ActionRetreatStep,
			MoveDelta: p.MoveSpeedPerTick,
		}
	}

	if !p.InvasionActive || !p.SettlementAlive {
		if p.CurrentState == StateIdle {
			if rng.Int64N(4) == 0 {
				return Decision{NextState: StatePatrol, Action: ActionPatrolStep}
			}
			return Decision{NextState: StateIdle, Action: ActionHold}
		}
		return Decision{NextState: StatePatrol, Action: ActionPatrolStep}
	}

	if p.DistanceToSettlement <= p.AttackRange {
		if p.AttackCooldownTicks == 0 {
			return Decision{NextState: StateAttack, Action: ActionStrikeSettlement}
		}
		return Decision{NextState: StateAttack, Action: ActionHold}
	}

	gap := p.DistanceToSettlement - p.AttackRange
	step := p.MoveSpeedPerTick
	if step > gap {
		step = gap
	}
	return Decision{
		NextState: StateAdvance,
		Action:    ActionMoveTowardTarget,
		MoveDelta: -step,
	}
}

func evaluateWithProfile(p Perception, rng *simulation.DeterministicRNG) Decision {
	prof := p.Profile
	pos := p.DistanceToSettlement
	moveSpeed := prof.MoveSpeedPerTick
	if p.MoveSpeedPerTick > 0 {
		moveSpeed = p.MoveSpeedPerTick
	}
	attackRange := prof.AttackRange
	if p.AttackRange > 0 {
		attackRange = p.AttackRange
	}

	// 1. Deterministic morale update (pure integer BasisPoints in [0, 10000]).
	inHomeTerritory := absDiffInt64(pos, p.HomePosition) <= prof.TerritoryRadius
	lowHP := hpAtOrBelowBP(p.HP, p.MaxHP, prof.RetreatHPThresholdBP)
	newMorale := computeMorale(p, inHomeTerritory, lowHP)

	// 2. Reinforcement decision (checked before movement; bounded by cooldown & remaining calls).
	reqReinf := false
	reinfArchetype := ""
	reinfCount := int64(0)
	if p.ReinforceCooldownTicks == 0 &&
		p.RemainingReinforcementCalls > 0 &&
		prof.MaxReinforcementCalls > 0 &&
		prof.ReinforcementCount > 0 &&
		newMorale > prof.BreakMoraleBP &&
		hpAtOrBelowBP(p.HP, p.MaxHP, prof.ReinforceTriggerHPBP) &&
		(p.InvasionActive || len(p.Targets) > 0) {
		reqReinf = true
		reinfArchetype = prof.ReinforcementArchetype
		reinfCount = prof.ReinforcementCount
	}

	// 3. Morale break and rally hysteresis.
	// Break into Retreat when morale falls to BreakMoraleBP or HP hits critical retreat threshold
	// without overwhelming commander support.
	broken := newMorale <= prof.BreakMoraleBP || (lowHP && p.Order.MoraleAuraBP == 0)
	if broken {
		return Decision{
			NextState:              StateRetreat,
			Action:                 ActionRetreatStep,
			MoveDelta:              moveSpeed, // Retreat away from settlement toward frontier/exit
			NewMoraleBP:            newMorale,
			RequestReinforcements:  reqReinf,
			ReinforcementArchetype: reinfArchetype,
			ReinforcementCount:     reinfCount,
		}
	}

	// Hysteresis while already retreating: stay in Retreat until morale recovers to RallyMoraleBP
	// and HP is above critical threshold, or step into Rally when ordered by a nearby commander.
	if p.CurrentState == StateRetreat {
		canRally := !lowHP && newMorale >= prof.RallyMoraleBP &&
			(p.Order.Kind == OrderRally || p.Order.NearbySameFamily >= 1)
		if canRally {
			rallyDelta := moveToward(pos, p.Order.RallyPoint, moveSpeed)
			if p.Order.Kind != OrderRally {
				rallyDelta = moveToward(pos, p.HomePosition, moveSpeed)
			}
			return Decision{
				NextState:              StateRally,
				Action:                 ActionRallyStep,
				MoveDelta:              rallyDelta,
				NewMoraleBP:            newMorale,
				RequestReinforcements:  reqReinf,
				ReinforcementArchetype: reinfArchetype,
				ReinforcementCount:     reinfCount,
			}
		}
		return Decision{
			NextState:   StateRetreat,
			Action:      ActionRetreatStep,
			MoveDelta:   moveSpeed,
			NewMoraleBP: newMorale,
		}
	}

	// 4. Territorial leash check outside active settlement invasion.
	distFromHome := absDiffInt64(pos, p.HomePosition)
	if !p.InvasionActive && distFromHome > prof.LeashRadius {
		return Decision{
			NextState:          StateReturnHome,
			Action:             ActionReturnHome,
			MoveDelta:          moveToward(pos, p.HomePosition, moveSpeed),
			NewMoraleBP:        newMorale,
			TerritoryTriggered: true,
		}
	}

	// If returning home and not yet back inside core territory, continue returning unless
	// an active invasion takes over.
	if !p.InvasionActive && p.CurrentState == StateReturnHome && distFromHome > prof.TerritoryRadius {
		return Decision{
			NextState:          StateReturnHome,
			Action:             ActionReturnHome,
			MoveDelta:          moveToward(pos, p.HomePosition, moveSpeed),
			NewMoraleBP:        newMorale,
			TerritoryTriggered: true,
		}
	}

	// 5. Perception & deterministic target selection.
	targetList := p.Targets
	if len(targetList) == 0 && p.InvasionActive && p.SettlementAlive {
		// Backward-compatible implicit settlement target when caller didn't populate Targets.
		targetList = []PerceivedTarget{
			{
				TargetID: "settlement",
				Kind:     TargetSettlement,
				Position: 0,
				HP:       1,
				MaxHP:    1,
			},
		}
	}

	memOpts := TargetMemoryOptions{}
	if !p.RetainedTarget.IsZero() && p.TargetMemoryTicks > 0 {
		memOpts = TargetMemoryOptions{
			RetainedTarget: p.RetainedTarget,
			RetentionBonus: 750,
		}
	}
	sel, hasTarget := SelectTargetWithMemory(pos, p.HomePosition, prof, targetList, p.Order, p.InvasionActive, memOpts)
	if hasTarget {
		nextMemTicks := int64(8)
		if sel.Ref() == p.RetainedTarget && p.TargetMemoryTicks > 1 {
			nextMemTicks = p.TargetMemoryTicks - 1
		}
		territoryAlert := !p.InvasionActive && absDiffInt64(sel.Position, p.HomePosition) <= prof.TerritoryRadius
		if sel.Distance <= attackRange {
			action := ActionHold
			if p.AttackCooldownTicks == 0 {
				if sel.Kind == TargetSettlement {
					action = ActionStrikeSettlement
				} else {
					action = ActionStrikeTarget
				}
			}
			return Decision{
				NextState:              StateAttack,
				Action:                 action,
				MoveDelta:              0,
				TargetID:               sel.TargetID,
				TargetKind:             sel.Kind,
				Target:                 sel.Ref(),
				NextTargetMemoryTicks:  nextMemTicks,
				NewMoraleBP:            newMorale,
				RequestReinforcements:  reqReinf,
				ReinforcementArchetype: reinfArchetype,
				ReinforcementCount:     reinfCount,
				TerritoryTriggered:     territoryAlert,
			}
		}

		// Move toward selected target without overshooting AttackRange.
		delta := moveTowardStoppingAtRange(pos, sel.Position, attackRange, moveSpeed)
		// Outside an active invasion, never step outside territorial leash.
		if !p.InvasionActive && absDiffInt64(pos+delta, p.HomePosition) > prof.LeashRadius {
			return Decision{
				NextState:          StateReturnHome,
				Action:             ActionReturnHome,
				MoveDelta:          moveToward(pos, p.HomePosition, moveSpeed),
				NewMoraleBP:        newMorale,
				TerritoryTriggered: true,
			}
		}
		return Decision{
			NextState:              StateAdvance,
			Action:                 ActionMoveTowardTarget,
			MoveDelta:              delta,
			TargetID:               sel.TargetID,
			TargetKind:             sel.Kind,
			Target:                 sel.Ref(),
			NextTargetMemoryTicks:  nextMemTicks,
			NewMoraleBP:            newMorale,
			RequestReinforcements:  reqReinf,
			ReinforcementArchetype: reinfArchetype,
			ReinforcementCount:     reinfCount,
			TerritoryTriggered:     territoryAlert,
		}
	}

	// 6. Peaceful / Territorial patrol behavior when no hostile target is perceived.
	if distFromHome > prof.TerritoryRadius {
		return Decision{
			NextState:          StateReturnHome,
			Action:             ActionReturnHome,
			MoveDelta:          moveToward(pos, p.HomePosition, moveSpeed),
			NewMoraleBP:        newMorale,
			TerritoryTriggered: true,
		}
	}

	if p.CurrentState == StateIdle {
		if rng.Int64N(4) == 0 {
			return Decision{
				NextState:   StatePatrol,
				Action:      ActionPatrolStep,
				MoveDelta:   patrolStep(pos, p.HomePosition, prof.TerritoryRadius, moveSpeed/2, rng),
				NewMoraleBP: newMorale,
			}
		}
		return Decision{
			NextState:   StateIdle,
			Action:      ActionHold,
			MoveDelta:   0,
			NewMoraleBP: newMorale,
		}
	}

	return Decision{
		NextState:   StatePatrol,
		Action:      ActionPatrolStep,
		MoveDelta:   patrolStep(pos, p.HomePosition, prof.TerritoryRadius, moveSpeed/2, rng),
		NewMoraleBP: newMorale,
	}
}

func computeMorale(p Perception, inHomeTerritory, lowHP bool) int64 {
	prof := p.Profile
	morale := p.MoraleBP

	// Shock from authoritative damage taken this tick.
	if p.RecentDamageTaken > 0 {
		// Scale shock by damage fraction + base hit shock.
		dmgFracBP := ratioBasisPoints(p.RecentDamageTaken, p.MaxHP)
		shock := prof.MoraleLossPerHitBP + (dmgFracBP / 2)
		morale -= shock
	}

	// Explicit morale shock when a nearby same-family commander falls in battle.
	if p.CommanderFallenShock {
		if prof.Family == FamilyGoblin {
			morale -= 1400
		} else {
			morale -= 900
		}
	}

	// Sustained low-HP pressure.
	if lowHP {
		morale -= 350
	}

	// Collective pack numbers & commander aura vs isolation & rout contagion.
	if p.Order.NearbySameFamily > 0 {
		packSupport := p.Order.NearbySameFamily * (prof.PackMoraleBonusBP / 4)
		if packSupport > 400 {
			packSupport = 400
		}
		morale += packSupport
	} else if prof.Family == FamilyGoblin && (p.InvasionActive || len(p.Targets) > 0) {
		// Isolated goblins lose nerve under combat pressure without pack numbers.
		morale -= 260
	}

	if p.Order.MoraleAuraBP > 0 {
		morale += p.Order.MoraleAuraBP / 4
	}
	if p.Order.Kind == OrderRally {
		morale += 350
	}
	if p.Order.NearbyRetreating > 0 {
		contagion := p.Order.NearbyRetreating * 220
		if prof.Family == FamilyOrc {
			// Orcs resist rout contagion better than goblins.
			contagion = p.Order.NearbyRetreating * 100
		}
		morale -= contagion
	}

	// Territorial home-turf resolve and natural calm recovery.
	if inHomeTerritory && !lowHP {
		morale += 120
	}
	if p.RecentDamageTaken == 0 && !lowHP && p.Order.NearbyRetreating == 0 {
		morale += prof.MoraleRecoveryPerTickBP
	}

	if morale < 0 {
		return 0
	}
	if uint64(morale) > BasisPointsScale {
		return int64(BasisPointsScale)
	}
	return morale
}

func moveToward(pos, dest, speed int64) int64 {
	if speed <= 0 || pos == dest {
		return 0
	}
	if dest > pos {
		diff := dest - pos
		if speed > diff {
			return diff
		}
		return speed
	}
	diff := pos - dest
	if speed > diff {
		return -diff
	}
	return -speed
}

func moveTowardStoppingAtRange(pos, targetPos, stopRange, speed int64) int64 {
	dist := absDiffInt64(pos, targetPos)
	if dist <= stopRange || speed <= 0 {
		return 0
	}
	gap := dist - stopRange
	step := speed
	if step > gap {
		step = gap
	}
	if targetPos < pos {
		return -step
	}
	return step
}

func patrolStep(pos, home, radius, step int64, rng *simulation.DeterministicRNG) int64 {
	if step <= 0 || radius <= 0 {
		return 0
	}
	dir := int64(1)
	if rng.Int64N(2) == 0 {
		dir = -1
	}
	nextPos := pos + dir*step
	if nextPos < 0 || absDiffInt64(nextPos, home) > radius {
		dir = -dir
		nextPos = pos + dir*step
		if nextPos < 0 || absDiffInt64(nextPos, home) > radius {
			return moveToward(pos, home, step)
		}
	}
	return dir * step
}

// hpAtOrBelowBP evaluates (hp / maxHP) <= (thresholdBP / 10000) using exact 128-bit integer
// cross-multiplication (no floats, no int64 overflow).
func hpAtOrBelowBP(hp, maxHP, thresholdBP int64) bool {
	if thresholdBP <= 0 {
		return false
	}
	lhsHi, lhsLo := bits.Mul64(uint64(hp), BasisPointsScale)
	rhsHi, rhsLo := bits.Mul64(uint64(maxHP), uint64(thresholdBP))
	if lhsHi != rhsHi {
		return lhsHi < rhsHi
	}
	return lhsLo <= rhsLo
}

func ratioBasisPoints(num, den int64) int64 {
	if num <= 0 || den <= 0 {
		return 0
	}
	if num >= den {
		return int64(BasisPointsScale)
	}
	hi, lo := bits.Mul64(uint64(num), BasisPointsScale)
	q, _ := bits.Div64(hi, lo, uint64(den))
	if q > BasisPointsScale {
		return int64(BasisPointsScale)
	}
	return int64(q)
}
