package world

import "fmt"

// ValidateTransition enforces the explicit finite state machine of an invasion.
// Legal transitions:
//   - Peace -> Threatened
//   - Threatened -> UnderAttack
//   - Threatened -> Peace
//   - UnderAttack -> Resolved (terminal)
//
// Any other transition is explicitly rejected.
func ValidateTransition(from, to InvasionState) error {
	if !from.Valid() || !to.Valid() {
		return fmt.Errorf("%w: unknown state (%q -> %q)", ErrInvalidInvasionTransition, from, to)
	}
	switch from {
	case InvasionPeace:
		if to == InvasionThreatened {
			return nil
		}
	case InvasionThreatened:
		if to == InvasionUnderAttack || to == InvasionPeace {
			return nil
		}
	case InvasionUnderAttack:
		if to == InvasionResolved {
			return nil
		}
	case InvasionResolved:
		// Terminal for a single invasion instance: cannot be reopened or double-rewarded.
	}
	return fmt.Errorf("%w: %s -> %s", ErrInvalidInvasionTransition, from, to)
}
