package ecosystem

import (
	"fmt"
	"math"
	"math/bits"
	"strings"

	"ascendra-game/internal/ai"
)

// MaterializationTicket links a materialized tactical CreatureGroup back to its exact
// source population and camp so losses and surviving returns are conserved strictly once.
type MaterializationTicket struct {
	PopulationID   string    `json:"population_id"`
	CampID         string    `json:"camp_id"`
	RegionID       string    `json:"region_id"`
	FactionID      string    `json:"faction_id"`
	FamilyID       ai.Family `json:"family_id"`
	Archetype      string    `json:"archetype"`
	ContingentSize int64     `json:"contingent_size"`
}

// DematerializationSummary reports exact population accounting upon tactical group exit.
type DematerializationSummary struct {
	PopulationID string
	Survivors    int64
	Losses       int64
}

// UnitPopulationWeight defines how many abstract population individuals correspond to
// a tactical CreatureGroup of the given archetype and count.
func UnitPopulationWeight(archetype string, count int64) (int64, error) {
	if count <= 0 {
		return 0, fmt.Errorf("%w: count must be > 0, got %d", ErrInvalidCommand, count)
	}
	prof, err := ai.LookupProfile(archetype)
	if err != nil {
		return 0, fmt.Errorf("%w: %v", ErrInvalidCommand, err)
	}
	var perUnit int64
	switch prof.Archetype {
	case "goblin-skirmisher":
		perUnit = 5
	case "goblin-raider-pack":
		perUnit = 6
	case "goblin-taskmaster":
		perUnit = 4
	case "orc-vanguard":
		perUnit = 4
	case "orc-berserker":
		perUnit = 3
	case "orc-warchief":
		perUnit = 2
	default:
		perUnit = 5
	}
	if count > math.MaxInt64/perUnit {
		return 0, ErrNumericOverflow
	}
	return perUnit * count, nil
}

// ReserveForMaterialization atomically moves ContingentSize from FreePopulation to
// MaterializedPopulation for a valid, operational camp. Destroyed or abandoned camps
// are explicitly rejected, and the same individuals can never be reserved twice.
func ReserveForMaterialization(
	state *EcosystemState,
	campID string,
	archetype string,
	count int64,
) (MaterializationTicket, EcologicalEvent, error) {
	if state == nil {
		return MaterializationTicket{}, EcologicalEvent{}, fmt.Errorf("%w: nil ecosystem state", ErrInvalidState)
	}
	cIdx := findCampIndex(state.Camps, campID)
	if cIdx < 0 {
		return MaterializationTicket{}, EcologicalEvent{}, fmt.Errorf("%w: camp %q", ErrUnknownEntity, campID)
	}
	camp := &state.Camps[cIdx]
	if !camp.State.CanSupplyMaterialization() {
		return MaterializationTicket{}, EcologicalEvent{}, fmt.Errorf("%w: camp %q is in state %s", ErrCampUnavailable, campID, camp.State)
	}

	prof, err := ai.LookupProfile(archetype)
	if err != nil {
		return MaterializationTicket{}, EcologicalEvent{}, fmt.Errorf("%w: %v", ErrInvalidCommand, err)
	}
	if prof.Family != camp.FamilyID {
		return MaterializationTicket{}, EcologicalEvent{}, fmt.Errorf("%w: archetype family %s does not match camp family %s", ErrInvalidCommand, prof.Family, camp.FamilyID)
	}

	weight, err := UnitPopulationWeight(prof.Archetype, count)
	if err != nil {
		return MaterializationTicket{}, EcologicalEvent{}, err
	}

	pIdx := findPopulationIndex(state.Populations, camp.PopulationID)
	if pIdx < 0 {
		return MaterializationTicket{}, EcologicalEvent{}, fmt.Errorf("%w: population %q", ErrInvalidReference, camp.PopulationID)
	}
	pop := &state.Populations[pIdx]
	if pop.FreePopulation < weight {
		return MaterializationTicket{}, EcologicalEvent{}, fmt.Errorf("%w: need %d free individuals, have %d", ErrInsufficientPopulation, weight, pop.FreePopulation)
	}

	nextMat, err := safeAddInt64(pop.MaterializedPopulation, weight)
	if err != nil {
		return MaterializationTicket{}, EcologicalEvent{}, err
	}

	ticket := MaterializationTicket{
		PopulationID:   pop.PopulationID,
		CampID:         camp.CampID,
		RegionID:       camp.RegionID,
		FactionID:      camp.FactionID,
		FamilyID:       camp.FamilyID,
		Archetype:      prof.Archetype,
		ContingentSize: weight,
	}
	ev, err := state.newEvent(
		EventCreatureGroupMaterialized,
		camp.RegionID,
		camp.CampID,
		pop.PopulationID,
		fmt.Sprintf("archetype=%s", prof.Archetype),
		weight,
	)
	if err != nil {
		return MaterializationTicket{}, EcologicalEvent{}, err
	}
	pop.FreePopulation -= weight
	pop.MaterializedPopulation = nextMat
	camp.AssignedPopulation = min(camp.AssignedPopulation, pop.FreePopulation)
	return ticket, ev, nil
}

// ReconcileDematerialization accounts for tactical group losses and returns only living
// survivors back into FreePopulation. Defeated groups (defeated == true or hpRemaining == 0)
// return 0 survivors and can never resurrect lost units.
func ReconcileDematerialization(
	state *EcosystemState,
	ticket MaterializationTicket,
	hpRemaining int64,
	maxHP int64,
	defeated bool,
) (DematerializationSummary, EcologicalEvent, error) {
	if state == nil {
		return DematerializationSummary{}, EcologicalEvent{}, fmt.Errorf("%w: nil ecosystem state", ErrInvalidState)
	}
	if strings.TrimSpace(ticket.PopulationID) == "" || ticket.ContingentSize <= 0 {
		return DematerializationSummary{}, EcologicalEvent{}, fmt.Errorf("%w: invalid materialization ticket", ErrInvalidCommand)
	}
	if maxHP <= 0 || hpRemaining < 0 || hpRemaining > maxHP {
		return DematerializationSummary{}, EcologicalEvent{}, fmt.Errorf("%w: invalid hp %d/%d", ErrInvalidCommand, hpRemaining, maxHP)
	}

	pIdx := findPopulationIndex(state.Populations, ticket.PopulationID)
	if pIdx < 0 {
		return DematerializationSummary{}, EcologicalEvent{}, fmt.Errorf("%w: population %q", ErrInvalidReference, ticket.PopulationID)
	}
	pop := &state.Populations[pIdx]
	if pop.MaterializedPopulation < ticket.ContingentSize {
		return DematerializationSummary{}, EcologicalEvent{}, fmt.Errorf("%w: materialized population %d < contingent %d (possible double reconciliation)", ErrInvalidState, pop.MaterializedPopulation, ticket.ContingentSize)
	}

	var survivors int64
	if !defeated && hpRemaining > 0 {
		// Proportional survivor count: ceil(ContingentSize * hpRemaining / maxHP), clamped to [1, ContingentSize].
		hi, lo := bits.Mul64(uint64(ticket.ContingentSize), uint64(hpRemaining))
		lo2, carry := bits.Add64(lo, uint64(maxHP-1), 0)
		hi2 := hi + carry
		q, _ := bits.Div64(hi2, lo2, uint64(maxHP))
		survivors = int64(q)
		if survivors < 1 {
			survivors = 1
		}
		if survivors > ticket.ContingentSize {
			survivors = ticket.ContingentSize
		}
	}
	losses := ticket.ContingentSize - survivors

	nextFree, err := safeAddInt64(pop.FreePopulation, survivors)
	if err != nil {
		return DematerializationSummary{}, EcologicalEvent{}, err
	}

	summary := DematerializationSummary{
		PopulationID: pop.PopulationID,
		Survivors:    survivors,
		Losses:       losses,
	}
	ev, err := state.newEvent(
		EventCreatureGroupDematerialized,
		ticket.RegionID,
		ticket.CampID,
		pop.PopulationID,
		fmt.Sprintf("survivors=%d losses=%d", survivors, losses),
		survivors,
	)
	if err != nil {
		return DematerializationSummary{}, EcologicalEvent{}, err
	}
	pop.MaterializedPopulation -= ticket.ContingentSize
	pop.FreePopulation = nextFree
	return summary, ev, nil
}
