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
	StateIdle    State = "Idle"
	StatePatrol  State = "Patrol"
	StateAdvance State = "Advance"
	StateAttack  State = "Attack"
	StateRetreat State = "Retreat"
	StateDead    State = "Dead"
)

// Valid reports whether the AI state is known.
func (s State) Valid() bool {
	switch s {
	case StateIdle, StatePatrol, StateAdvance, StateAttack, StateRetreat, StateDead:
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
	ActionRetreatStep      ActionKind = "RetreatStep"
)

// Perception contains all data required for a pure, deterministic AI evaluation.
// The AI never queries hidden global state or wall-clock time.
type Perception struct {
	Tick                 uint64
	GroupID              string
	CurrentState         State
	HP                   int64
	MaxHP                int64
	RetreatThresholdBP   int64 // BasisPoints in [0, 10000]
	DistanceToSettlement int64 // WorldUnit (1/1000 tile), >= 0
	AttackRange          int64 // WorldUnit, > 0
	MoveSpeedPerTick     int64 // WorldUnit, >= 0
	AttackCooldownTicks  int64 // Remaining ticks before strike is legal, >= 0
	InvasionActive       bool
	SettlementAlive      bool
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
	if p.RetreatThresholdBP < 0 || uint64(p.RetreatThresholdBP) > BasisPointsScale {
		return fmt.Errorf("%w: retreat_threshold_bp %d out of [0, %d]", ErrInvalidPerception, p.RetreatThresholdBP, BasisPointsScale)
	}
	if p.DistanceToSettlement < 0 {
		return fmt.Errorf("%w: negative distance %d", ErrInvalidPerception, p.DistanceToSettlement)
	}
	if p.AttackRange <= 0 {
		return fmt.Errorf("%w: attack_range must be > 0, got %d", ErrInvalidPerception, p.AttackRange)
	}
	if p.MoveSpeedPerTick < 0 {
		return fmt.Errorf("%w: negative move_speed %d", ErrInvalidPerception, p.MoveSpeedPerTick)
	}
	if p.AttackCooldownTicks < 0 {
		return fmt.Errorf("%w: negative attack_cooldown %d", ErrInvalidPerception, p.AttackCooldownTicks)
	}
	return nil
}

// Decision is the deterministic output produced by Evaluate for one logical tick.
type Decision struct {
	NextState State
	Action    ActionKind
	MoveDelta int64 // Signed change to DistanceToSettlement (- closer, + retreating)
}

// Evaluate computes the next AI state and action deterministically from Perception and RNG.
func Evaluate(p Perception, rng *simulation.DeterministicRNG) (Decision, error) {
	if err := p.Validate(); err != nil {
		return Decision{}, err
	}
	if rng == nil {
		return Decision{}, fmt.Errorf("%w: nil rng", ErrInvalidPerception)
	}

	// Invariant: a dead entity can never move, retreat, or attack.
	if p.HP == 0 || p.CurrentState == StateDead {
		return Decision{
			NextState: StateDead,
			Action:    ActionNone,
			MoveDelta: 0,
		}, nil
	}

	// Once retreating, or when HP ratio <= RetreatThresholdBP, disengage safely.
	if p.CurrentState == StateRetreat || shouldRetreat(p.HP, p.MaxHP, p.RetreatThresholdBP) {
		return Decision{
			NextState: StateRetreat,
			Action:    ActionRetreatStep,
			MoveDelta: p.MoveSpeedPerTick,
		}, nil
	}

	// Outside an active invasion or once the settlement has fallen, patrol/hold peacefully.
	if !p.InvasionActive || !p.SettlementAlive {
		if p.CurrentState == StateIdle {
			if rng.Int64N(4) == 0 {
				return Decision{
					NextState: StatePatrol,
					Action:    ActionPatrolStep,
					MoveDelta: 0,
				}, nil
			}
			return Decision{
				NextState: StateIdle,
				Action:    ActionHold,
				MoveDelta: 0,
			}, nil
		}
		return Decision{
			NextState: StatePatrol,
			Action:    ActionPatrolStep,
			MoveDelta: 0,
		}, nil
	}

	// Active invasion against a live settlement: engage in attack range or advance.
	if p.DistanceToSettlement <= p.AttackRange {
		if p.AttackCooldownTicks == 0 {
			return Decision{
				NextState: StateAttack,
				Action:    ActionStrikeSettlement,
				MoveDelta: 0,
			}, nil
		}
		return Decision{
			NextState: StateAttack,
			Action:    ActionHold,
			MoveDelta: 0,
		}, nil
	}

	// Advance without overshooting past AttackRange.
	gap := p.DistanceToSettlement - p.AttackRange
	step := p.MoveSpeedPerTick
	if step > gap {
		step = gap
	}
	return Decision{
		NextState: StateAdvance,
		Action:    ActionMoveTowardTarget,
		MoveDelta: -step,
	}, nil
}

// shouldRetreat evaluates (hp / maxHP) <= (thresholdBP / 10000) using exact 128-bit integer
// cross-multiplication (no floats, no int64 overflow).
func shouldRetreat(hp, maxHP, thresholdBP int64) bool {
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
