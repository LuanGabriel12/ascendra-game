package simulation

import "math"

// defaultNonZeroSeed prevents degenerate zero-state initialization while staying 100% deterministic.
const defaultNonZeroSeed uint64 = 0x9e3779b97f4a7c15

// DeterministicRNG implements a pure integer SplitMix64 PRNG whose complete state
// lives inside the simulation state and is preserved across snapshots.
// Global math/rand is forbidden inside deterministic simulation packages.
type DeterministicRNG struct {
	State uint64 `json:"state"`
}

// NewDeterministicRNG constructs a deterministic PRNG from an explicit seed.
func NewDeterministicRNG(seed uint64) DeterministicRNG {
	if seed == 0 {
		seed = defaultNonZeroSeed
	}
	return DeterministicRNG{State: seed}
}

// NextUint64 advances the SplitMix64 state and returns the next deterministic uint64.
func (r *DeterministicRNG) NextUint64() uint64 {
	r.State += 0x9e3779b97f4a7c15
	z := r.State
	z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
	z = (z ^ (z >> 27)) * 0x94d049bb133111eb
	return z ^ (z >> 31)
}

// Int64N returns a uniform deterministic integer in [0, n) using unbiased rejection sampling.
// Returns 0 if n <= 0.
func (r *DeterministicRNG) Int64N(n int64) int64 {
	if n <= 0 {
		return 0
	}
	un := uint64(n)
	limit := math.MaxUint64 - (math.MaxUint64 % un)
	for {
		v := r.NextUint64()
		if v < limit {
			return int64(v % un)
		}
	}
}

// Int64Range returns a deterministic integer in [minVal, maxInclusive].
// If maxInclusive <= minVal, returns minVal.
func (r *DeterministicRNG) Int64Range(minVal, maxInclusive int64) int64 {
	if maxInclusive <= minVal {
		return minVal
	}
	span := uint64(maxInclusive) - uint64(minVal)
	if span == math.MaxUint64 {
		return int64(r.NextUint64())
	}
	un := span + 1
	limit := math.MaxUint64 - (math.MaxUint64 % un)
	for {
		v := r.NextUint64()
		if v < limit {
			return int64(uint64(minVal) + (v % un))
		}
	}
}
