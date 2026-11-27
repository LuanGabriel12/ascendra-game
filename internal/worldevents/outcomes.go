package worldevents

import (
	"fmt"
	"slices"
	"strings"
)

// QueueStats summarizes current pending depth and acknowledgement cursors across all
// durable outboxes without exposing mutable internal state.
type QueueStats struct {
	PendingDirectorBatches int
	PendingDirectorEvents  int
	DirectorBatchAckSeq    uint64
	PendingOutcomes        int
	OutcomeAckSeq          uint64
	PendingContributions   int
	ContributionAckSeq     uint64
}

// PendingQueueStats returns read-only queue occupancy and cursor metrics.
func PendingQueueStats(state OrchestratedState, cfg OrchestratedConfig) (QueueStats, error) {
	if err := state.Validate(cfg); err != nil {
		return QueueStats{}, err
	}
	return QueueStats{
		PendingDirectorBatches: len(state.Director.PendingDirectorBatches),
		PendingDirectorEvents:  totalPendingDirectorEvents(state.Director),
		DirectorBatchAckSeq:    state.Director.DirectorBatchAckSeq,
		PendingOutcomes:        len(state.Director.PendingOutcomes),
		OutcomeAckSeq:          state.Director.OutcomeAckSeq,
		PendingContributions:   len(state.Director.PendingContributions),
		ContributionAckSeq:     state.Director.ContributionAckSeq,
	}, nil
}

func totalPendingDirectorEvents(state DirectorState) int {
	total := 0
	for _, b := range state.PendingDirectorBatches {
		total += len(b.Events)
	}
	return total
}

func cloneDirectorEvents(events []DirectorEvent) []DirectorEvent {
	cloned := slices.Clone(events)
	for i := range cloned {
		if cloned[i].TerminalOutcome != nil {
			value := *cloned[i].TerminalOutcome
			cloned[i].TerminalOutcome = &value
		}
	}
	return cloned
}

func cloneDirectorBatches(batches []DirectorEventBatch) []DirectorEventBatch {
	cloned := slices.Clone(batches)
	for i := range cloned {
		cloned[i].Events = cloneDirectorEvents(cloned[i].Events)
	}
	return cloned
}

// PendingDirectorEventPage reads the oldest tick's facts in deterministic pages.
// Querying NEVER removes events; the complete batch must be durably processed before it is acknowledged.
func PendingDirectorEventPage(state OrchestratedState, offset int, cfg OrchestratedConfig) (sequence uint64, events []DirectorEvent, more bool, err error) {
	if err = state.Validate(cfg); err != nil {
		return
	}
	if len(state.Director.PendingDirectorBatches) == 0 {
		if offset != 0 {
			err = fmt.Errorf("%w: offset without a pending batch", ErrInvalidCommand)
		}
		return
	}
	batch := state.Director.PendingDirectorBatches[0]
	if offset < 0 || offset >= len(batch.Events) {
		err = fmt.Errorf("%w: invalid director event offset", ErrInvalidCommand)
		return
	}
	end := offset + min(cfg.Director.MaxEventsPerUpdate, len(batch.Events)-offset)
	return batch.Sequence, cloneDirectorEvents(batch.Events[offset:end]), end < len(batch.Events), nil
}

// AcknowledgeDirectorBatch confirms only the oldest fully processed tick batch.
func AcknowledgeDirectorBatch(state OrchestratedState, sequence uint64, cfg OrchestratedConfig) (OrchestratedState, error) {
	if err := state.Validate(cfg); err != nil {
		return OrchestratedState{}, err
	}
	if sequence != 0 && sequence == state.Director.DirectorBatchAckSeq {
		return state.Clone(), nil
	}
	if len(state.Director.PendingDirectorBatches) == 0 || sequence != state.Director.PendingDirectorBatches[0].Sequence {
		return OrchestratedState{}, fmt.Errorf("%w: expected the oldest director batch", ErrInvalidCommand)
	}
	next := state.Clone()
	next.Director.PendingDirectorBatches = slices.Delete(next.Director.PendingDirectorBatches, 0, 1)
	next.Director.DirectorBatchAckSeq = sequence
	return next, next.Validate(cfg)
}

// AcknowledgeDirectorBatchVerified confirms the oldest batch only if the consumer processed
// every event in that batch (expectedEventCount == len(batch.Events)), preventing accidental
// partial-page acknowledgement. A retry of the last acknowledged sequence with expectedEventCount > 0
// is an idempotent no-op.
func AcknowledgeDirectorBatchVerified(state OrchestratedState, sequence uint64, expectedEventCount int, cfg OrchestratedConfig) (OrchestratedState, error) {
	if err := state.Validate(cfg); err != nil {
		return OrchestratedState{}, err
	}
	if expectedEventCount <= 0 {
		return OrchestratedState{}, fmt.Errorf("%w: expected_event_count must be > 0", ErrInvalidCommand)
	}
	if sequence != 0 && sequence == state.Director.DirectorBatchAckSeq {
		return state.Clone(), nil
	}
	if len(state.Director.PendingDirectorBatches) == 0 || sequence != state.Director.PendingDirectorBatches[0].Sequence {
		return OrchestratedState{}, fmt.Errorf("%w: expected the oldest director batch", ErrInvalidCommand)
	}
	if len(state.Director.PendingDirectorBatches[0].Events) != expectedEventCount {
		return OrchestratedState{}, fmt.Errorf("%w: conflicting batch event count %d != %d", ErrInvalidCommand, expectedEventCount, len(state.Director.PendingDirectorBatches[0].Events))
	}
	return AcknowledgeDirectorBatch(state, sequence, cfg)
}

// PendingTerminalOutcomes returns a copy of the ordered, unconfirmed terminal facts.
func PendingTerminalOutcomes(state OrchestratedState, cfg OrchestratedConfig) ([]TerminalSettlementOutcome, error) {
	if err := state.Validate(cfg); err != nil {
		return nil, err
	}
	return slices.Clone(state.Director.PendingOutcomes), nil
}

// AcknowledgeTerminalOutcome confirms exactly the oldest outstanding fact. A retry
// of the most recently acknowledged sequence is an idempotent no-op. The caller
// is responsible for confirming only after its consumer has processed the fact.
func AcknowledgeTerminalOutcome(state OrchestratedState, sequence uint64, cfg OrchestratedConfig) (OrchestratedState, error) {
	if err := state.Validate(cfg); err != nil {
		return OrchestratedState{}, err
	}
	if sequence != 0 && sequence == state.Director.OutcomeAckSeq {
		return state.Clone(), nil
	}
	if len(state.Director.PendingOutcomes) == 0 || sequence != state.Director.PendingOutcomes[0].Sequence {
		return OrchestratedState{}, fmt.Errorf("%w: expected the oldest pending outcome", ErrInvalidCommand)
	}
	next := state.Clone()
	next.Director.PendingOutcomes = slices.Delete(next.Director.PendingOutcomes, 0, 1)
	next.Director.OutcomeAckSeq = sequence
	if err := next.Validate(cfg); err != nil {
		return OrchestratedState{}, err
	}
	return next, nil
}

// AcknowledgeTerminalOutcomeVerified confirms the oldest pending terminal outcome only when
// both sequence and EventID match, rejecting conflicting acknowledgements atomically.
func AcknowledgeTerminalOutcomeVerified(state OrchestratedState, sequence uint64, eventID string, cfg OrchestratedConfig) (OrchestratedState, error) {
	if err := state.Validate(cfg); err != nil {
		return OrchestratedState{}, err
	}
	if strings.TrimSpace(eventID) == "" {
		return OrchestratedState{}, fmt.Errorf("%w: event_id required", ErrInvalidCommand)
	}
	if sequence != 0 && sequence == state.Director.OutcomeAckSeq {
		// Verify against diagnostic history if retained so conflicting retries are caught.
		for _, h := range state.Director.TerminalOutcomes {
			if h.Sequence == sequence && h.EventID != eventID {
				return OrchestratedState{}, fmt.Errorf("%w: conflicting event_id %q for outcome sequence %d", ErrInvalidCommand, eventID, sequence)
			}
		}
		return state.Clone(), nil
	}
	if len(state.Director.PendingOutcomes) == 0 || sequence != state.Director.PendingOutcomes[0].Sequence {
		return OrchestratedState{}, fmt.Errorf("%w: expected the oldest pending outcome", ErrInvalidCommand)
	}
	if state.Director.PendingOutcomes[0].EventID != eventID {
		return OrchestratedState{}, fmt.Errorf("%w: conflicting event_id %q != %q", ErrInvalidCommand, eventID, state.Director.PendingOutcomes[0].EventID)
	}
	return AcknowledgeTerminalOutcome(state, sequence, cfg)
}

// PendingContributionResults returns a copy of unconfirmed CARBON-bound facts.
func PendingContributionResults(state OrchestratedState, cfg OrchestratedConfig) ([]PendingContribution, error) {
	if err := state.Validate(cfg); err != nil {
		return nil, err
	}
	return slices.Clone(state.Director.PendingContributions), nil
}

// AcknowledgeContribution confirms exactly the oldest outstanding contribution.
func AcknowledgeContribution(state OrchestratedState, sequence uint64, cfg OrchestratedConfig) (OrchestratedState, error) {
	if err := state.Validate(cfg); err != nil {
		return OrchestratedState{}, err
	}
	if sequence != 0 && sequence == state.Director.ContributionAckSeq {
		return state.Clone(), nil
	}
	if len(state.Director.PendingContributions) == 0 || sequence != state.Director.PendingContributions[0].Sequence {
		return OrchestratedState{}, fmt.Errorf("%w: expected the oldest pending contribution", ErrInvalidCommand)
	}
	next := state.Clone()
	next.Director.PendingContributions = slices.Delete(next.Director.PendingContributions, 0, 1)
	next.Director.ContributionAckSeq = sequence
	if err := next.Validate(cfg); err != nil {
		return OrchestratedState{}, err
	}
	return next, nil
}

// AcknowledgeContributionVerified confirms the oldest pending contribution only when both
// sequence and EventID match, rejecting conflicting acknowledgements atomically.
func AcknowledgeContributionVerified(state OrchestratedState, sequence uint64, eventID string, cfg OrchestratedConfig) (OrchestratedState, error) {
	if err := state.Validate(cfg); err != nil {
		return OrchestratedState{}, err
	}
	if strings.TrimSpace(eventID) == "" {
		return OrchestratedState{}, fmt.Errorf("%w: event_id required", ErrInvalidCommand)
	}
	if sequence != 0 && sequence == state.Director.ContributionAckSeq {
		return state.Clone(), nil
	}
	if len(state.Director.PendingContributions) == 0 || sequence != state.Director.PendingContributions[0].Sequence {
		return OrchestratedState{}, fmt.Errorf("%w: expected the oldest pending contribution", ErrInvalidCommand)
	}
	if state.Director.PendingContributions[0].Result.EventID != eventID {
		return OrchestratedState{}, fmt.Errorf("%w: conflicting contribution event_id %q != %q", ErrInvalidCommand, eventID, state.Director.PendingContributions[0].Result.EventID)
	}
	return AcknowledgeContribution(state, sequence, cfg)
}

