package ecosystem

import (
	"errors"
	"fmt"
	"math"
	"math/bits"
	"slices"
	"strings"

	"ascendra-game/internal/ai"
)

// Sentinel errors for idempotent population reservations.
var (
	ErrUnknownReservation     = errors.New("unknown population reservation")
	ErrReservationClosed      = errors.New("population reservation is closed or inactive")
	ErrReservationConflict    = errors.New("conflicting population reservation parameters for idempotency key")
	ErrDuplicateReservation   = errors.New("duplicate population reservation")
	ErrDuplicateReservationOp = errors.New("duplicate operation key on population reservation")
)

// ReservationState models the explicit lifecycle of an identified population reservation.
type ReservationState string

const (
	ReservationActive    ReservationState = "Active"
	ReservationCompleted ReservationState = "Completed"
	ReservationCancelled ReservationState = "Cancelled"
	ReservationExpired   ReservationState = "Expired"
)

func (s ReservationState) Valid() bool {
	switch s {
	case ReservationActive, ReservationCompleted, ReservationCancelled, ReservationExpired:
		return true
	default:
		return false
	}
}

func (s ReservationState) Code() uint8 {
	switch s {
	case ReservationActive:
		return 1
	case ReservationCompleted:
		return 2
	case ReservationCancelled:
		return 3
	case ReservationExpired:
		return 4
	default:
		return 0
	}
}

// PopulationReservation provides durable, idempotent, non-transferable accounting for a
// specific campaign's reserved and materialized contingent.
//
// Invariants:
//   - MaterializedAmount + ReleasedAmount <= ReservedAmount
//   - ReturnedSurvivors + Casualties <= MaterializedAmount
//   - RemainingReserved() = ReservedAmount - MaterializedAmount - ReleasedAmount >= 0
//   - RemainingMaterialized() = MaterializedAmount - ReturnedSurvivors - Casualties >= 0
type PopulationReservation struct {
	ReservationID      string           `json:"reservation_id"`
	Seq                uint64           `json:"seq"`
	IdempotencyKey     string           `json:"idempotency_key,omitempty"`
	CampaignID         string           `json:"campaign_id"`
	PopulationID       string           `json:"population_id"`
	CampID             string           `json:"camp_id"`
	RegionID           string           `json:"region_id"`
	FactionID          string           `json:"faction_id"`
	FamilyID           ai.Family        `json:"family_id"`
	ReservedAmount     int64            `json:"reserved_amount"`
	MaterializedAmount int64            `json:"materialized_amount"`
	ReleasedAmount     int64            `json:"released_amount"`
	ReturnedSurvivors  int64            `json:"returned_survivors"`
	Casualties         int64            `json:"casualties"`
	State              ReservationState `json:"state"`
	CreatedTick        uint64           `json:"created_tick"`
	ExpiryTick         uint64           `json:"expiry_tick"`
	AppliedOps         []string         `json:"applied_ops,omitempty"`
}

// RemainingReserved returns unmaterialized individuals still held in ReservedPopulation.
func (r PopulationReservation) RemainingReserved() int64 {
	return r.ReservedAmount - r.MaterializedAmount - r.ReleasedAmount
}

// RemainingMaterialized returns active tactical individuals not yet reconciled.
func (r PopulationReservation) RemainingMaterialized() int64 {
	return r.MaterializedAmount - r.ReturnedSurvivors - r.Casualties
}

// IsClosed reports whether the reservation is terminal and holds zero outstanding individuals.
func (r PopulationReservation) IsClosed() bool {
	return r.State != ReservationActive && r.RemainingReserved() == 0 && r.RemainingMaterialized() == 0
}

// Validate enforces strict per-reservation accounting bounds.
func (r PopulationReservation) Validate(maxIDLen int) error {
	if err := validateID(r.ReservationID, maxIDLen); err != nil {
		return fmt.Errorf("%w: reservation_id: %v", ErrInvalidState, err)
	}
	if r.Seq == 0 {
		return fmt.Errorf("%w: reservation %q seq must be > 0", ErrInvalidState, r.ReservationID)
	}
	if err := validateID(r.CampaignID, maxIDLen); err != nil {
		return fmt.Errorf("%w: reservation %q campaign_id: %v", ErrInvalidState, r.ReservationID, err)
	}
	if err := validateID(r.PopulationID, maxIDLen); err != nil {
		return fmt.Errorf("%w: reservation %q population_id: %v", ErrInvalidState, r.ReservationID, err)
	}
	if err := validateID(r.CampID, maxIDLen); err != nil {
		return fmt.Errorf("%w: reservation %q camp_id: %v", ErrInvalidState, r.ReservationID, err)
	}
	if !r.FamilyID.Valid() || !r.State.Valid() {
		return fmt.Errorf("%w: reservation %q invalid family or state", ErrInvalidState, r.ReservationID)
	}
	if r.IdempotencyKey != "" && len(r.IdempotencyKey) > maxIDLen {
		return fmt.Errorf("%w: reservation %q idempotency_key too long", ErrInvalidState, r.ReservationID)
	}
	if strings.HasPrefix(r.IdempotencyKey, "ordered-reservation:") && r.IdempotencyKey != fmt.Sprintf("ordered-reservation:%d", r.Seq) {
		return fmt.Errorf("%w: ordered reservation key does not match sequence", ErrInvalidState)
	}
	if r.ExpiryTick < r.CreatedTick {
		return fmt.Errorf("%w: reservation %q expiry_tick < created_tick", ErrInvalidState, r.ReservationID)
	}
	if r.ReservedAmount <= 0 || r.MaterializedAmount < 0 || r.ReleasedAmount < 0 || r.ReturnedSurvivors < 0 || r.Casualties < 0 {
		return fmt.Errorf("%w: reservation %q negative or zero amount", ErrInvalidState, r.ReservationID)
	}
	matPlusRel, err := safeAddInt64(r.MaterializedAmount, r.ReleasedAmount)
	if err != nil || matPlusRel > r.ReservedAmount {
		return fmt.Errorf("%w: reservation %q materialized+released exceeds reserved", ErrInvalidState, r.ReservationID)
	}
	retPlusCas, err := safeAddInt64(r.ReturnedSurvivors, r.Casualties)
	if err != nil || retPlusCas > r.MaterializedAmount {
		return fmt.Errorf("%w: reservation %q survivors+casualties exceeds materialized", ErrInvalidState, r.ReservationID)
	}
	for i, op := range r.AppliedOps {
		if strings.TrimSpace(op) == "" || len(op) > maxIDLen {
			return fmt.Errorf("%w: reservation %q invalid op key", ErrInvalidState, r.ReservationID)
		}
		if i > 0 && r.AppliedOps[i-1] >= op {
			return fmt.Errorf("%w: reservation %q applied_ops not strictly sorted", ErrInvalidState, r.ReservationID)
		}
	}
	return nil
}

// ReservationRequest specifies parameters for creating an idempotent population reservation.
type ReservationRequest struct {
	IdempotencyKey string
	CampaignID     string
	CampID         string
	Amount         int64
	CreatedTick    uint64
	ExpiryTick     uint64
}

// CreateReservation atomically reserves Amount from FreePopulation into ReservedPopulation
// under a durable monotonic ReservationID. Repeating an identical IdempotencyKey is a no-op;
// reusing an IdempotencyKey with conflicting parameters returns ErrReservationConflict.
func CreateReservation(
	state *EcosystemState,
	req ReservationRequest,
	cfg Config,
) (PopulationReservation, EcologicalEvent, bool, error) {
	if strings.HasPrefix(req.IdempotencyKey, "ordered-reservation:") {
		return PopulationReservation{}, EcologicalEvent{}, false, fmt.Errorf("%w: reserved idempotency key namespace", ErrInvalidCommand)
	}
	return createReservation(state, req, cfg, 0)
}

// CreateSequencedReservation accepts the next contiguous, engine-assigned operation
// sequence. A retry must use its original sequence. Older pruned sequences fail closed.
func CreateSequencedReservation(state *EcosystemState, req ReservationRequest, sequence uint64, cfg Config) (PopulationReservation, EcologicalEvent, bool, error) {
	if sequence == 0 || req.IdempotencyKey != "" {
		return PopulationReservation{}, EcologicalEvent{}, false, fmt.Errorf("%w: sequence and empty external key required", ErrInvalidCommand)
	}
	req.IdempotencyKey = fmt.Sprintf("ordered-reservation:%d", sequence)
	return createReservation(state, req, cfg, sequence)
}

func createReservation(state *EcosystemState, req ReservationRequest, cfg Config, sequence uint64) (PopulationReservation, EcologicalEvent, bool, error) {
	if state == nil {
		return PopulationReservation{}, EcologicalEvent{}, false, fmt.Errorf("%w: nil ecosystem state", ErrInvalidState)
	}
	if err := cfg.Validate(); err != nil {
		return PopulationReservation{}, EcologicalEvent{}, false, err
	}
	if err := validateID(req.CampaignID, cfg.MaxIdentifierLength); err != nil {
		return PopulationReservation{}, EcologicalEvent{}, false, fmt.Errorf("%w: campaign_id: %v", ErrInvalidCommand, err)
	}
	if err := validateID(req.CampID, cfg.MaxIdentifierLength); err != nil {
		return PopulationReservation{}, EcologicalEvent{}, false, fmt.Errorf("%w: camp_id: %v", ErrInvalidCommand, err)
	}
	if req.IdempotencyKey != "" && len(req.IdempotencyKey) > cfg.MaxIdentifierLength {
		return PopulationReservation{}, EcologicalEvent{}, false, fmt.Errorf("%w: idempotency_key too long", ErrInvalidCommand)
	}
	if req.Amount <= 0 || req.ExpiryTick < req.CreatedTick {
		return PopulationReservation{}, EcologicalEvent{}, false, fmt.Errorf("%w: invalid reservation amount or expiry", ErrInvalidCommand)
	}

	// Idempotency check against active/retained reservations.
	if req.IdempotencyKey != "" {
		for _, existing := range state.Reservations {
			if existing.IdempotencyKey == req.IdempotencyKey {
				if existing.CampaignID == req.CampaignID && existing.CampID == req.CampID && existing.ReservedAmount == req.Amount && existing.CreatedTick == req.CreatedTick && existing.ExpiryTick == req.ExpiryTick {
					return existing, EcologicalEvent{}, false, nil
				}
				return PopulationReservation{}, EcologicalEvent{}, false, fmt.Errorf("%w: key %q", ErrReservationConflict, req.IdempotencyKey)
			}
		}
		if slices.Contains(state.RetiredReservationKeys, req.IdempotencyKey) {
			return PopulationReservation{}, EcologicalEvent{}, false, fmt.Errorf("%w: retired key %q", ErrDuplicateReservation, req.IdempotencyKey)
		}
	}
	if sequence != 0 {
		if sequence <= state.ReservationSeq {
			return PopulationReservation{}, EcologicalEvent{}, false, ErrDuplicateReservation
		}
		if state.ReservationSeq == math.MaxUint64 || sequence != state.ReservationSeq+1 {
			return PopulationReservation{}, EcologicalEvent{}, false, fmt.Errorf("%w: reservation sequence must be contiguous", ErrInvalidCommand)
		}
	}

	if len(state.Reservations) >= cfg.MaxReservations {
		return PopulationReservation{}, EcologicalEvent{}, false, fmt.Errorf("%w: max reservations %d reached", ErrCapacityExceeded, cfg.MaxReservations)
	}
	if state.ReservationSeq == math.MaxUint64 {
		return PopulationReservation{}, EcologicalEvent{}, false, ErrNumericOverflow
	}

	cIdx := findCampIndex(state.Camps, req.CampID)
	if cIdx < 0 {
		return PopulationReservation{}, EcologicalEvent{}, false, fmt.Errorf("%w: camp %q", ErrUnknownEntity, req.CampID)
	}
	camp := &state.Camps[cIdx]
	if !camp.State.CanSupplyMaterialization() {
		return PopulationReservation{}, EcologicalEvent{}, false, fmt.Errorf("%w: camp %q is in state %s", ErrCampUnavailable, req.CampID, camp.State)
	}
	pIdx := findPopulationIndex(state.Populations, camp.PopulationID)
	if pIdx < 0 {
		return PopulationReservation{}, EcologicalEvent{}, false, fmt.Errorf("%w: population %q", ErrInvalidReference, camp.PopulationID)
	}
	pop := &state.Populations[pIdx]
	if pop.FreePopulation < req.Amount {
		return PopulationReservation{}, EcologicalEvent{}, false, fmt.Errorf("%w: need %d free individuals, have %d", ErrInsufficientPopulation, req.Amount, pop.FreePopulation)
	}
	nextResPop, err := safeAddInt64(pop.ReservedPopulation, req.Amount)
	if err != nil {
		return PopulationReservation{}, EcologicalEvent{}, false, err
	}

	nextSeq := state.ReservationSeq + 1
	resID := fmt.Sprintf("res:%s:%06d", state.SimulationID, nextSeq)
	if len(resID) > cfg.MaxIdentifierLength {
		return PopulationReservation{}, EcologicalEvent{}, false, fmt.Errorf("%w: generated reservation_id exceeds max length", ErrInvalidState)
	}

	// Emit event BEFORE mutating state so EventSeq overflow preserves atomicity.
	ev, err := state.newEvent(
		EventPopulationReserved,
		camp.RegionID,
		resID,
		pop.PopulationID,
		fmt.Sprintf("campaign=%s camp=%s", req.CampaignID, camp.CampID),
		req.Amount,
	)
	if err != nil {
		return PopulationReservation{}, EcologicalEvent{}, false, err
	}

	state.ReservationSeq = nextSeq
	pop.FreePopulation -= req.Amount
	pop.ReservedPopulation = nextResPop
	camp.AssignedPopulation = min(camp.AssignedPopulation, pop.FreePopulation)

	res := PopulationReservation{
		ReservationID:  resID,
		Seq:            nextSeq,
		IdempotencyKey: req.IdempotencyKey,
		CampaignID:     req.CampaignID,
		PopulationID:   pop.PopulationID,
		CampID:         camp.CampID,
		RegionID:       camp.RegionID,
		FactionID:      camp.FactionID,
		FamilyID:       camp.FamilyID,
		ReservedAmount: req.Amount,
		State:          ReservationActive,
		CreatedTick:    req.CreatedTick,
		ExpiryTick:     req.ExpiryTick,
		AppliedOps:     []string{},
	}
	insertIdx, _ := slices.BinarySearchFunc(state.Reservations, res.ReservationID, func(existing PopulationReservation, id string) int {
		return strings.Compare(existing.ReservationID, id)
	})
	state.Reservations = slices.Insert(state.Reservations, insertIdx, res)
	return res, ev, true, nil
}

// MaterializeFromReservation transfers a tactical contingent strictly from an active
// reservation's ReservedPopulation into MaterializedPopulation, deduplicated by opKey.
func MaterializeFromReservation(
	state *EcosystemState,
	reservationID string,
	opKey string,
	archetype string,
	count int64,
	cfg Config,
) (MaterializationTicket, EcologicalEvent, error) {
	if state == nil {
		return MaterializationTicket{}, EcologicalEvent{}, fmt.Errorf("%w: nil ecosystem state", ErrInvalidState)
	}
	if err := validateID(opKey, cfg.MaxIdentifierLength); err != nil {
		return MaterializationTicket{}, EcologicalEvent{}, fmt.Errorf("%w: op_key: %v", ErrInvalidCommand, err)
	}
	rIdx := findReservationIndex(state.Reservations, reservationID)
	if rIdx < 0 {
		return MaterializationTicket{}, EcologicalEvent{}, fmt.Errorf("%w: %q", ErrUnknownReservation, reservationID)
	}
	res := &state.Reservations[rIdx]
	if res.State != ReservationActive {
		return MaterializationTicket{}, EcologicalEvent{}, fmt.Errorf("%w: reservation %q state is %s", ErrReservationClosed, reservationID, res.State)
	}
	opInsertIdx, dup := slices.BinarySearch(res.AppliedOps, opKey)
	if dup {
		return MaterializationTicket{}, EcologicalEvent{}, fmt.Errorf("%w: %q on %q", ErrDuplicateReservationOp, opKey, reservationID)
	}
	if len(res.AppliedOps) >= cfg.MaxOpsPerReservation {
		return MaterializationTicket{}, EcologicalEvent{}, fmt.Errorf("%w: reservation %q op limit reached", ErrCapacityExceeded, reservationID)
	}

	cIdx := findCampIndex(state.Camps, res.CampID)
	if cIdx < 0 || !state.Camps[cIdx].State.CanSupplyMaterialization() {
		return MaterializationTicket{}, EcologicalEvent{}, fmt.Errorf("%w: camp %q unavailable", ErrCampUnavailable, res.CampID)
	}
	prof, err := ai.LookupProfile(archetype)
	if err != nil {
		return MaterializationTicket{}, EcologicalEvent{}, fmt.Errorf("%w: %v", ErrInvalidCommand, err)
	}
	if prof.Family != res.FamilyID {
		return MaterializationTicket{}, EcologicalEvent{}, fmt.Errorf("%w: archetype family %s != reservation family %s", ErrInvalidCommand, prof.Family, res.FamilyID)
	}
	weight, err := UnitPopulationWeight(prof.Archetype, count)
	if err != nil {
		return MaterializationTicket{}, EcologicalEvent{}, err
	}
	if res.RemainingReserved() < weight {
		return MaterializationTicket{}, EcologicalEvent{}, fmt.Errorf("%w: reservation %q has %d remaining, need %d", ErrInsufficientPopulation, reservationID, res.RemainingReserved(), weight)
	}
	pIdx := findPopulationIndex(state.Populations, res.PopulationID)
	if pIdx < 0 {
		return MaterializationTicket{}, EcologicalEvent{}, fmt.Errorf("%w: population %q", ErrInvalidReference, res.PopulationID)
	}
	pop := &state.Populations[pIdx]
	if pop.ReservedPopulation < weight {
		return MaterializationTicket{}, EcologicalEvent{}, fmt.Errorf("%w: population %q reserved %d < weight %d", ErrInvalidState, pop.PopulationID, pop.ReservedPopulation, weight)
	}
	nextMat, err := safeAddInt64(pop.MaterializedPopulation, weight)
	if err != nil {
		return MaterializationTicket{}, EcologicalEvent{}, err
	}
	nextResMat, err := safeAddInt64(res.MaterializedAmount, weight)
	if err != nil {
		return MaterializationTicket{}, EcologicalEvent{}, err
	}

	ev, err := state.newEvent(
		EventCreatureGroupMaterialized,
		res.RegionID,
		res.CampID,
		res.PopulationID,
		fmt.Sprintf("res=%s archetype=%s", res.ReservationID, prof.Archetype),
		weight,
	)
	if err != nil {
		return MaterializationTicket{}, EcologicalEvent{}, err
	}

	pop.ReservedPopulation -= weight
	pop.MaterializedPopulation = nextMat
	res.MaterializedAmount = nextResMat
	res.AppliedOps = slices.Insert(res.AppliedOps, opInsertIdx, opKey)

	ticket := MaterializationTicket{
		ReservationID:  res.ReservationID,
		PopulationID:   res.PopulationID,
		CampID:         res.CampID,
		RegionID:       res.RegionID,
		FactionID:      res.FactionID,
		FamilyID:       res.FamilyID,
		Archetype:      prof.Archetype,
		ContingentSize: weight,
	}
	return ticket, ev, nil
}

// ReconcileReservationContingent accounts for tactical group losses and returns only living
// survivors back into FreePopulation under the owning ReservationID, deduplicated by opKey.
// Dead creatures (defeated == true or hpRemaining == 0) never return.
func ReconcileReservationContingent(
	state *EcosystemState,
	reservationID string,
	opKey string,
	contingentSize int64,
	hpRemaining int64,
	maxHP int64,
	defeated bool,
	cfg Config,
) (DematerializationSummary, EcologicalEvent, error) {
	if state == nil {
		return DematerializationSummary{}, EcologicalEvent{}, fmt.Errorf("%w: nil ecosystem state", ErrInvalidState)
	}
	if err := validateID(opKey, cfg.MaxIdentifierLength); err != nil {
		return DematerializationSummary{}, EcologicalEvent{}, fmt.Errorf("%w: op_key: %v", ErrInvalidCommand, err)
	}
	if contingentSize <= 0 || maxHP <= 0 || hpRemaining < 0 || hpRemaining > maxHP {
		return DematerializationSummary{}, EcologicalEvent{}, fmt.Errorf("%w: invalid contingent or hp %d/%d", ErrInvalidCommand, hpRemaining, maxHP)
	}
	rIdx := findReservationIndex(state.Reservations, reservationID)
	if rIdx < 0 {
		return DematerializationSummary{}, EcologicalEvent{}, fmt.Errorf("%w: %q", ErrUnknownReservation, reservationID)
	}
	res := &state.Reservations[rIdx]
	opInsertIdx, dup := slices.BinarySearch(res.AppliedOps, opKey)
	if dup {
		return DematerializationSummary{}, EcologicalEvent{}, fmt.Errorf("%w: %q on %q", ErrDuplicateReservationOp, opKey, reservationID)
	}
	if len(res.AppliedOps) >= cfg.MaxOpsPerReservation {
		return DematerializationSummary{}, EcologicalEvent{}, fmt.Errorf("%w: reservation %q op limit reached", ErrCapacityExceeded, reservationID)
	}
	if res.RemainingMaterialized() < contingentSize {
		return DematerializationSummary{}, EcologicalEvent{}, fmt.Errorf("%w: reservation %q remaining materialized %d < %d", ErrInvalidState, reservationID, res.RemainingMaterialized(), contingentSize)
	}
	pIdx := findPopulationIndex(state.Populations, res.PopulationID)
	if pIdx < 0 {
		return DematerializationSummary{}, EcologicalEvent{}, fmt.Errorf("%w: population %q", ErrInvalidReference, res.PopulationID)
	}
	pop := &state.Populations[pIdx]
	if pop.MaterializedPopulation < contingentSize {
		return DematerializationSummary{}, EcologicalEvent{}, fmt.Errorf("%w: population %q materialized %d < %d", ErrInvalidState, pop.PopulationID, pop.MaterializedPopulation, contingentSize)
	}

	var survivors int64
	if !defeated && hpRemaining > 0 {
		hi, lo := bits.Mul64(uint64(contingentSize), uint64(hpRemaining))
		lo2, carry := bits.Add64(lo, uint64(maxHP-1), 0)
		hi2 := hi + carry
		q, _ := bits.Div64(hi2, lo2, uint64(maxHP))
		survivors = int64(q)
		if survivors < 1 {
			survivors = 1
		}
		if survivors > contingentSize {
			survivors = contingentSize
		}
	}
	losses := contingentSize - survivors

	nextFree, err := safeAddInt64(pop.FreePopulation, survivors)
	if err != nil {
		return DematerializationSummary{}, EcologicalEvent{}, err
	}
	nextRet, err := safeAddInt64(res.ReturnedSurvivors, survivors)
	if err != nil {
		return DematerializationSummary{}, EcologicalEvent{}, err
	}
	nextCas, err := safeAddInt64(res.Casualties, losses)
	if err != nil {
		return DematerializationSummary{}, EcologicalEvent{}, err
	}

	ev, err := state.newEvent(
		EventCreatureGroupDematerialized,
		res.RegionID,
		res.CampID,
		res.PopulationID,
		fmt.Sprintf("res=%s survivors=%d losses=%d", res.ReservationID, survivors, losses),
		survivors,
	)
	if err != nil {
		return DematerializationSummary{}, EcologicalEvent{}, err
	}

	pop.MaterializedPopulation -= contingentSize
	pop.FreePopulation = nextFree
	res.ReturnedSurvivors = nextRet
	res.Casualties = nextCas
	res.AppliedOps = slices.Insert(res.AppliedOps, opInsertIdx, opKey)

	if res.State == ReservationActive && res.RemainingReserved() == 0 && res.RemainingMaterialized() == 0 {
		res.State = ReservationCompleted
	}

	return DematerializationSummary{
		PopulationID: pop.PopulationID,
		Survivors:    survivors,
		Losses:       losses,
	}, ev, nil
}

// CancelReservation releases ONLY unmaterialized contingents back into FreePopulation.
// Already-materialized tactical groups must still be reconciled individually so casualties
// can never resurrect. Calling CancelReservation again on an already-cancelled/expired
// reservation is a safe idempotent no-op returning 0 released.
func CancelReservation(state *EcosystemState, reservationID string, expired bool) (int64, EcologicalEvent, error) {
	if state == nil {
		return 0, EcologicalEvent{}, fmt.Errorf("%w: nil ecosystem state", ErrInvalidState)
	}
	rIdx := findReservationIndex(state.Reservations, reservationID)
	if rIdx < 0 {
		return 0, EcologicalEvent{}, fmt.Errorf("%w: %q", ErrUnknownReservation, reservationID)
	}
	res := &state.Reservations[rIdx]
	if res.State == ReservationCompleted {
		return 0, EcologicalEvent{}, fmt.Errorf("%w: reservation %q already completed", ErrReservationClosed, reservationID)
	}

	targetState := ReservationCancelled
	reason := "cancelled"
	if expired {
		targetState = ReservationExpired
		reason = "expired"
	}

	unmat := res.RemainingReserved()
	if (res.State == ReservationCancelled || res.State == ReservationExpired) && unmat == 0 {
		// Safe idempotent no-op: never release twice.
		return 0, EcologicalEvent{}, nil
	}

	pIdx := findPopulationIndex(state.Populations, res.PopulationID)
	if pIdx < 0 {
		return 0, EcologicalEvent{}, fmt.Errorf("%w: population %q", ErrInvalidReference, res.PopulationID)
	}
	pop := &state.Populations[pIdx]
	if pop.ReservedPopulation < unmat {
		return 0, EcologicalEvent{}, fmt.Errorf("%w: population %q reserved %d < release %d", ErrInvalidState, pop.PopulationID, pop.ReservedPopulation, unmat)
	}
	nextFree, err := safeAddInt64(pop.FreePopulation, unmat)
	if err != nil {
		return 0, EcologicalEvent{}, err
	}
	nextReleased, err := safeAddInt64(res.ReleasedAmount, unmat)
	if err != nil {
		return 0, EcologicalEvent{}, err
	}

	ev, err := state.newEvent(
		EventReservationReleased,
		res.RegionID,
		res.ReservationID,
		res.PopulationID,
		fmt.Sprintf("reason=%s campaign=%s", reason, res.CampaignID),
		unmat,
	)
	if err != nil {
		return 0, EcologicalEvent{}, err
	}

	pop.ReservedPopulation -= unmat
	pop.FreePopulation = nextFree
	res.ReleasedAmount = nextReleased
	res.State = targetState
	return unmat, ev, nil
}

// CompleteReservation finalizes a reservation once all materialized contingents have been
// reconciled (RemainingMaterialized == 0), releasing any unused reinforcement buffer back
// into FreePopulation and transitioning the reservation to ReservationCompleted.
// Calling CompleteReservation again on an already-completed reservation is a safe idempotent no-op.
func CompleteReservation(state *EcosystemState, reservationID string) (int64, EcologicalEvent, error) {
	if state == nil {
		return 0, EcologicalEvent{}, fmt.Errorf("%w: nil ecosystem state", ErrInvalidState)
	}
	rIdx := findReservationIndex(state.Reservations, reservationID)
	if rIdx < 0 {
		return 0, EcologicalEvent{}, fmt.Errorf("%w: %q", ErrUnknownReservation, reservationID)
	}
	res := &state.Reservations[rIdx]
	if res.RemainingMaterialized() != 0 {
		return 0, EcologicalEvent{}, fmt.Errorf("%w: reservation %q still has %d materialized individuals", ErrInvalidState, reservationID, res.RemainingMaterialized())
	}
	unmat := res.RemainingReserved()
	if res.State == ReservationCompleted && unmat == 0 {
		return 0, EcologicalEvent{}, nil
	}
	if res.State == ReservationCancelled || res.State == ReservationExpired {
		return 0, EcologicalEvent{}, fmt.Errorf("%w: reservation %q already %s", ErrReservationClosed, reservationID, res.State)
	}

	pIdx := findPopulationIndex(state.Populations, res.PopulationID)
	if pIdx < 0 {
		return 0, EcologicalEvent{}, fmt.Errorf("%w: population %q", ErrInvalidReference, res.PopulationID)
	}
	pop := &state.Populations[pIdx]
	if pop.ReservedPopulation < unmat {
		return 0, EcologicalEvent{}, fmt.Errorf("%w: population %q reserved %d < release %d", ErrInvalidState, pop.PopulationID, pop.ReservedPopulation, unmat)
	}
	nextFree, err := safeAddInt64(pop.FreePopulation, unmat)
	if err != nil {
		return 0, EcologicalEvent{}, err
	}
	nextReleased, err := safeAddInt64(res.ReleasedAmount, unmat)
	if err != nil {
		return 0, EcologicalEvent{}, err
	}

	var ev EcologicalEvent
	if unmat > 0 {
		ev, err = state.newEvent(
			EventReservationReleased,
			res.RegionID,
			res.ReservationID,
			res.PopulationID,
			fmt.Sprintf("reason=completed campaign=%s", res.CampaignID),
			unmat,
		)
		if err != nil {
			return 0, EcologicalEvent{}, err
		}
	}

	pop.ReservedPopulation -= unmat
	pop.FreePopulation = nextFree
	res.ReleasedAmount = nextReleased
	res.State = ReservationCompleted
	return unmat, ev, nil
}

// PruneClosedReservations removes closed terminal reservations above maxRetainedClosed
// while retaining bounded retired idempotency keys and keeping ReservationSeq strictly monotonic.
// Any stale ReservationID pruned from state.Reservations can never be reapplied.
func PruneClosedReservations(state *EcosystemState, maxRetainedClosed int, maxRetiredKeys int) {
	PruneClosedReservationsExcept(state, maxRetainedClosed, maxRetiredKeys, nil)
}

// PruneClosedReservationsExcept preserves reservations still referenced by
// live campaigns, even when they are already closed.
func PruneClosedReservationsExcept(state *EcosystemState, maxRetainedClosed int, maxRetiredKeys int, protectedIDs []string) {
	if state == nil || len(state.Reservations) == 0 {
		return
	}
	maxRetainedClosed = max(0, maxRetainedClosed)
	closedIndices := make([]int, 0)
	for i, r := range state.Reservations {
		if r.IsClosed() {
			closedIndices = append(closedIndices, i)
		}
	}
	if len(closedIndices) <= maxRetainedClosed {
		return
	}
	toRemove := len(closedIndices) - maxRetainedClosed
	removeSet := make(map[int]struct{}, toRemove)
	for _, idx := range closedIndices {
		if len(removeSet) >= toRemove {
			break
		}
		if slices.Contains(protectedIDs, state.Reservations[idx].ReservationID) {
			continue
		}
		if key := state.Reservations[idx].IdempotencyKey; strings.HasPrefix(key, "ordered-reservation:") && key == fmt.Sprintf("ordered-reservation:%d", state.Reservations[idx].Seq) {
			// ReservationSeq prevents an older sequence being accepted again.
		} else if key != "" && maxRetiredKeys > 0 {
			if !slices.Contains(state.RetiredReservationKeys, key) {
				if len(state.RetiredReservationKeys) >= maxRetiredKeys {
					continue
				}
				state.RetiredReservationKeys = append(state.RetiredReservationKeys, key)
			}
		} else if key != "" {
			continue
		}
		removeSet[idx] = struct{}{}
	}
	kept := make([]PopulationReservation, 0, len(state.Reservations)-toRemove)
	for i, r := range state.Reservations {
		if _, drop := removeSet[i]; !drop {
			kept = append(kept, r)
		}
	}
	state.Reservations = kept
}

func findReservationIndex(list []PopulationReservation, id string) int {
	idx, ok := slices.BinarySearchFunc(list, id, func(r PopulationReservation, k string) int {
		return strings.Compare(r.ReservationID, k)
	})
	if !ok {
		return -1
	}
	return idx
}

// TotalPopulationLedger returns exact (Free, Reserved, Materialized) sums across all populations.
func TotalPopulationLedger(state EcosystemState) (freeTotal, reservedTotal, matTotal int64) {
	for _, p := range state.Populations {
		freeTotal += p.FreePopulation
		reservedTotal += p.ReservedPopulation
		matTotal += p.MaterializedPopulation
	}
	return freeTotal, reservedTotal, matTotal
}
