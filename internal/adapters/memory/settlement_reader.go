package memory

import (
	"fmt"
	"sync"

	"ascendra-game/internal/ports"
)

// SettlementReader is a deterministic in-memory fake implementing ports.SettlementReader
// for headless tests and harnesses without coupling to CARBON's database.
type SettlementReader struct {
	mu          sync.RWMutex
	settlements map[string]ports.SettlementSnapshot
}

// DefaultSettlementFixtures returns deterministic, original ASCENDRA fixtures
// for headless world simulation tests.
func DefaultSettlementFixtures() []ports.SettlementSnapshot {
	return []ports.SettlementSnapshot{
		{
			SettlementID: "settlement-valewatch",
			RegionID:     "region-ashvale",
			DefenseState: ports.SettlementDefenseSecure,
			MaxDefenseHP: 1000,
		},
		{
			SettlementID: "settlement-ironford",
			RegionID:     "region-thornreach",
			DefenseState: ports.SettlementDefenseFortified,
			MaxDefenseHP: 1500,
		},
	}
}

// NewSettlementReader builds a validated in-memory settlement reader from fixtures.
func NewSettlementReader(fixtures ...ports.SettlementSnapshot) (*SettlementReader, error) {
	store := make(map[string]ports.SettlementSnapshot, len(fixtures))
	for _, snap := range fixtures {
		if err := snap.Validate(); err != nil {
			return nil, err
		}
		if _, exists := store[snap.SettlementID]; exists {
			return nil, fmt.Errorf("%w: duplicate fixture settlement_id %q", ports.ErrInvalidSettlementSnapshot, snap.SettlementID)
		}
		store[snap.SettlementID] = snap
	}
	return &SettlementReader{settlements: store}, nil
}

// GetSettlementSnapshot returns a read-only copy of the settlement snapshot.
func (r *SettlementReader) GetSettlementSnapshot(settlementID string) (ports.SettlementSnapshot, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	snap, ok := r.settlements[settlementID]
	if !ok {
		return ports.SettlementSnapshot{}, fmt.Errorf("%w: %q", ports.ErrSettlementNotFound, settlementID)
	}
	return snap, nil
}
