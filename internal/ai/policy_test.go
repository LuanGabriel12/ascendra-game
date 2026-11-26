package ai_test

import (
	"errors"
	"math"
	"testing"

	"ascendra-game/internal/ai"
	"ascendra-game/internal/simulation"
)

func basePerception() ai.Perception {
	return ai.Perception{
		Tick:                 10,
		GroupID:              "group-vanguard-1",
		CurrentState:         ai.StateIdle,
		HP:                   400,
		MaxHP:                400,
		RetreatThresholdBP:   1500, // 15.00%
		DistanceToSettlement: 5000,
		AttackRange:          1500,
		MoveSpeedPerTick:     500,
		AttackCooldownTicks:  0,
		InvasionActive:       true,
		SettlementAlive:      true,
	}
}

func TestAIEvaluateDeterminism(t *testing.T) {
	p := basePerception()
	p.InvasionActive = false

	rngA := simulation.NewDeterministicRNG(999)
	rngB := simulation.NewDeterministicRNG(999)

	for tick := uint64(1); tick <= 200; tick++ {
		p.Tick = tick
		dA, errA := ai.Evaluate(p, &rngA)
		dB, errB := ai.Evaluate(p, &rngB)
		if errA != nil || errB != nil {
			t.Fatalf("unexpected error at tick %d: %v / %v", tick, errA, errB)
		}
		if dA != dB {
			t.Fatalf("non-deterministic AI decision at tick %d: %+v != %+v", tick, dA, dB)
		}
	}
}

func TestAIDeadEntityCannotAct(t *testing.T) {
	p := basePerception()
	p.HP = 0
	p.DistanceToSettlement = 500 // Inside attack range
	rng := simulation.NewDeterministicRNG(1)

	d, err := ai.Evaluate(p, &rng)
	if err != nil {
		t.Fatalf("Evaluate failed: %v", err)
	}
	if d.NextState != ai.StateDead || d.Action != ai.ActionNone || d.MoveDelta != 0 {
		t.Fatalf("dead entity must not act; got %+v", d)
	}
}

func TestAIAdvanceAttackCooldownAndRetreat(t *testing.T) {
	rng := simulation.NewDeterministicRNG(7)

	// 1. Out of range -> Advance without overshooting attack range.
	p := basePerception()
	p.DistanceToSettlement = 1800
	p.MoveSpeedPerTick = 500
	d, err := ai.Evaluate(p, &rng)
	if err != nil {
		t.Fatalf("advance eval failed: %v", err)
	}
	if d.NextState != ai.StateAdvance || d.Action != ai.ActionMoveTowardTarget || d.MoveDelta != -300 {
		t.Fatalf("expected clamped advance -300, got %+v", d)
	}

	// 2. In range with cooldown > 0 -> Attack state but ActionHold.
	p.DistanceToSettlement = 1500
	p.AttackCooldownTicks = 5
	d, err = ai.Evaluate(p, &rng)
	if err != nil {
		t.Fatalf("cooldown eval failed: %v", err)
	}
	if d.NextState != ai.StateAttack || d.Action != ai.ActionHold {
		t.Fatalf("expected ActionHold while on cooldown, got %+v", d)
	}

	// 3. In range with cooldown == 0 -> Strike settlement.
	p.AttackCooldownTicks = 0
	d, err = ai.Evaluate(p, &rng)
	if err != nil {
		t.Fatalf("strike eval failed: %v", err)
	}
	if d.NextState != ai.StateAttack || d.Action != ai.ActionStrikeSettlement {
		t.Fatalf("expected ActionStrikeSettlement, got %+v", d)
	}

	// 4. Low HP (<= 15%) -> Retreat.
	p.HP = 60 // exactly 15.00% of 400
	d, err = ai.Evaluate(p, &rng)
	if err != nil {
		t.Fatalf("retreat eval failed: %v", err)
	}
	if d.NextState != ai.StateRetreat || d.Action != ai.ActionRetreatStep || d.MoveDelta != 500 {
		t.Fatalf("expected Retreat +500, got %+v", d)
	}
}

func TestAIRetreatLargeInt64NoOverflow(t *testing.T) {
	rng := simulation.NewDeterministicRNG(1)
	p := basePerception()
	p.MaxHP = math.MaxInt64
	p.HP = math.MaxInt64 / 2 // 50% > 15%, must NOT retreat due to overflow
	d, err := ai.Evaluate(p, &rng)
	if err != nil {
		t.Fatalf("Evaluate failed: %v", err)
	}
	if d.NextState == ai.StateRetreat {
		t.Fatalf("50%% HP should not trigger 15%% retreat threshold (overflow check)")
	}
}

func TestAIInvalidPerceptionRejected(t *testing.T) {
	rng := simulation.NewDeterministicRNG(1)
	p := basePerception()
	p.HP = -1
	_, err := ai.Evaluate(p, &rng)
	if !errors.Is(err, ai.ErrInvalidPerception) {
		t.Fatalf("expected ErrInvalidPerception for negative HP, got %v", err)
	}

	p = basePerception()
	_, err = ai.Evaluate(p, nil)
	if !errors.Is(err, ai.ErrInvalidPerception) {
		t.Fatalf("expected ErrInvalidPerception for nil RNG, got %v", err)
	}
}
