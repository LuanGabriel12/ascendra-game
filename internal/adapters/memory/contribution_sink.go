package memory

import (
	"fmt"
	"sync"

	"ascendra-game/internal/ports"
)

// ContributionSink is an in-memory fake implementing ports.ContributionSink.
// It enforces contract validation and strict EventID idempotency to verify
// that NEON never causes duplicate reward applications downstream.
type ContributionSink struct {
	mu      sync.Mutex
	seen    map[string]struct{}
	records []ports.ContributionResult
}

// NewContributionSink creates an empty in-memory contribution sink.
func NewContributionSink() *ContributionSink {
	return &ContributionSink{
		seen:    make(map[string]struct{}),
		records: make([]ports.ContributionResult, 0),
	}
}

// RecordContribution validates and stores a unique ContributionResult by EventID.
func (s *ContributionSink) RecordContribution(result ports.ContributionResult) error {
	if err := result.Validate(); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if _, exists := s.seen[result.EventID]; exists {
		return fmt.Errorf("%w: %q", ports.ErrDuplicateContribution, result.EventID)
	}
	s.seen[result.EventID] = struct{}{}
	s.records = append(s.records, result)
	return nil
}

// Records returns a shallow copy of all accepted contribution records in arrival order.
func (s *ContributionSink) Records() []ports.ContributionResult {
	s.mu.Lock()
	defer s.mu.Unlock()

	out := make([]ports.ContributionResult, len(s.records))
	copy(out, s.records)
	return out
}

// HasEvent reports whether an EventID has already been recorded.
func (s *ContributionSink) HasEvent(eventID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, ok := s.seen[eventID]
	return ok
}
