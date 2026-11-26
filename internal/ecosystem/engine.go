package ecosystem

import (
	"context"
	"fmt"
	"math"
)

// EpochResult summarizes a multi-epoch headless ecological run.
type EpochResult struct {
	FinalState    EcosystemState
	FinalChecksum string
	Events        []EcologicalEvent
}

// StepEpoch advances the deterministic regional ecosystem simulation by exactly one logical epoch.
// It is pure, I/O-free, wall-clock-free, float-free, and atomic: any error leaves the caller's
// EcosystemState completely untouched.
func StepEpoch(state EcosystemState, commands []Command, cfg Config) (EcosystemState, []EcologicalEvent, error) {
	if err := cfg.Validate(); err != nil {
		return EcosystemState{}, nil, err
	}
	if err := state.Validate(cfg); err != nil {
		return EcosystemState{}, nil, err
	}
	if state.Epoch == math.MaxUint64 {
		return EcosystemState{}, nil, ErrNumericOverflow
	}
	if len(commands) > cfg.MaxCommandsPerEpoch {
		return EcosystemState{}, nil, fmt.Errorf("%w: %d commands exceed limit %d", ErrCapacityExceeded, len(commands), cfg.MaxCommandsPerEpoch)
	}

	next := state.Clone()
	next.Epoch++
	events := make([]EcologicalEvent, 0, len(commands)+8)

	// 1. Validate and apply explicit commands in deterministic canonical order.
	orderedCmds := CanonicalizeCommands(commands)
	for _, cmd := range orderedCmds {
		if cmd.Epoch != next.Epoch {
			return EcosystemState{}, nil, fmt.Errorf("%w: command epoch=%d, expected=%d", ErrEpochMismatch, cmd.Epoch, next.Epoch)
		}
		if err := applyCommand(&next, cmd, cfg, &events); err != nil {
			return EcosystemState{}, nil, err
		}
	}

	// 2. Natural resource consumption (conserved) & regeneration.
	if err := processResources(&next, &events); err != nil {
		return EcosystemState{}, nil, err
	}

	// 3. Discrete integer logistic population growth & mortality.
	if err := processPopulations(&next, cfg, &events); err != nil {
		return EcosystemState{}, nil, err
	}

	// 4. Two-phase deterministic inter-region migration (conserved).
	if err := processMigration(&next, cfg, &events); err != nil {
		return EcosystemState{}, nil, err
	}

	// 5. Dynamic camp lifecycle (establishing, active, expanding, starved, abandoned).
	if err := processCamps(&next, cfg, &events); err != nil {
		return EcosystemState{}, nil, err
	}

	// 6. Territorial influence and hostile faction competition.
	if err := processTerritory(&next, cfg, &events); err != nil {
		return EcosystemState{}, nil, err
	}

	// 7. Bounded regional threat with hysteresis and event intent cooldown.
	if err := processRegionalThreat(&next, cfg, &events); err != nil {
		return EcosystemState{}, nil, err
	}

	if next.EventSeq < state.EventSeq {
		return EcosystemState{}, nil, ErrNumericOverflow
	}
	if err := next.Validate(cfg); err != nil {
		return EcosystemState{}, nil, err
	}
	return next, events, nil
}

func applyCommand(next *EcosystemState, cmd Command, cfg Config, events *[]EcologicalEvent) error {
	switch cmd.Kind {
	case CmdDestroyCamp:
		return destroyCamp(next, cmd.CampID, cfg, events)

	case CmdEstablishCamp:
		return tryEstablishCamp(next, cmd.PopulationID, cfg, events, true)

	case CmdAdjustResource:
		rIdx := findRegionIndex(next.Regions, cmd.RegionID)
		if rIdx < 0 {
			return fmt.Errorf("%w: region %q", ErrUnknownEntity, cmd.RegionID)
		}
		slot, err := selectResourceSlot(&next.Regions[rIdx].Resources, cmd.ResourceName)
		if err != nil {
			return err
		}
		updated, err := safeAddInt64(slot.Amount, cmd.Delta)
		if err != nil {
			return err
		}
		if updated < 0 {
			updated = 0
		}
		if updated > slot.MaxCapacity {
			updated = slot.MaxCapacity
		}
		wasPositive := slot.Amount > 0
		slot.Amount = updated
		if wasPositive && slot.Amount == 0 {
			ev, err := next.newEvent(EventResourceDepleted, cmd.RegionID, cmd.RegionID, cmd.ResourceName, "Adjusted to depletion", 0)
			if err != nil {
				return err
			}
			*events = append(*events, ev)
		}
		return nil

	case CmdApplyConflictLoss:
		if cmd.Delta <= 0 {
			return fmt.Errorf("%w: conflict loss delta must be > 0, got %d", ErrInvalidCommand, cmd.Delta)
		}
		pIdx := findPopulationIndex(next.Populations, cmd.PopulationID)
		if pIdx < 0 {
			return fmt.Errorf("%w: population %q", ErrUnknownEntity, cmd.PopulationID)
		}
		pop := &next.Populations[pIdx]
		losses := cmd.Delta
		if losses > pop.FreePopulation {
			losses = pop.FreePopulation
		}
		pop.FreePopulation -= losses
		if rIdx := findRegionIndex(next.Regions, pop.RegionID); rIdx >= 0 {
			nextConflict, err := safeAddInt64(next.Regions[rIdx].RecentConflictScore, losses*4)
			if err != nil {
				return err
			}
			if nextConflict > cfg.MaxRegionalThreat {
				nextConflict = cfg.MaxRegionalThreat
			}
			next.Regions[rIdx].RecentConflictScore = nextConflict
		}
		if losses > 0 {
			ev, err := next.newEvent(EventPopulationDeclined, pop.RegionID, pop.PopulationID, "", "External conflict losses", losses)
			if err != nil {
				return err
			}
			*events = append(*events, ev)
		}
		return nil

	default:
		return fmt.Errorf("%w: unknown command kind %q", ErrInvalidCommand, cmd.Kind)
	}
}

func selectResourceSlot(pool *ResourcePool, name string) (*ResourceSlot, error) {
	switch name {
	case "food":
		return &pool.Food, nil
	case "wood":
		return &pool.Wood, nil
	case "stone":
		return &pool.Stone, nil
	case "ore":
		return &pool.Ore, nil
	case "water":
		return &pool.Water, nil
	default:
		return nil, fmt.Errorf("%w: unknown resource %q", ErrInvalidCommand, name)
	}
}

// RunEpochs advances the ecosystem through targetEpoch headlessly without wall-clock dependence.
// Optional maxRetainedEvents bounds in-memory event history when > 0.
func RunEpochs(
	ctx context.Context,
	initial EcosystemState,
	script map[uint64][]Command,
	targetEpoch uint64,
	cfg Config,
	maxRetainedEvents int,
) (EpochResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	cur := initial.Clone()
	capHint := 64
	if maxRetainedEvents > 0 && maxRetainedEvents < capHint {
		capHint = maxRetainedEvents
	}
	retained := make([]EcologicalEvent, 0, capHint)

	for cur.Epoch < targetEpoch {
		select {
		case <-ctx.Done():
			return EpochResult{}, ctx.Err()
		default:
		}
		nextEpoch := cur.Epoch + 1
		var cmds []Command
		if script != nil {
			cmds = script[nextEpoch]
		}
		next, evs, err := StepEpoch(cur, cmds, cfg)
		if err != nil {
			return EpochResult{}, err
		}
		if len(evs) > 0 {
			retained = append(retained, evs...)
			if maxRetainedEvents > 0 && len(retained) > maxRetainedEvents {
				retained = append([]EcologicalEvent(nil), retained[len(retained)-maxRetainedEvents:]...)
			}
		}
		cur = next
	}

	sum, err := cur.Checksum(cfg)
	if err != nil {
		return EpochResult{}, err
	}
	return EpochResult{
		FinalState:    cur,
		FinalChecksum: sum,
		Events:        retained,
	}, nil
}

// TotalEcosystemPopulation sums FreePopulation + MaterializedPopulation across all populations.
func TotalEcosystemPopulation(state EcosystemState) (freeTotal, matTotal int64) {
	for _, p := range state.Populations {
		freeTotal += p.FreePopulation
		matTotal += p.MaterializedPopulation
	}
	return freeTotal, matTotal
}
