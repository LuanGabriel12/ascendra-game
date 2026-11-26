package world

import (
	"fmt"
	"slices"

	"ascendra-game/internal/ai"
	"ascendra-game/internal/ecosystem"
	"ascendra-game/internal/simulation"
)

// IntegratedState unites the two simulation scales with a single source of truth:
//   - Scale A (World): tactical groups, HP, AI, combat, invasion ticks.
//   - Scale B (Ecosystem): regional populations (Free + Materialized), camps, resources, migration, threat.
//
// Invariant: for every population P, sum(g.PopulationWeight for un-accounted tactical groups g
// sourced from P) == P.MaterializedPopulation.
type IntegratedState struct {
	World     WorldState               `json:"world"`
	Ecosystem ecosystem.EcosystemState `json:"ecosystem"`
}

// Clone returns a deep copy of both simulation scales for atomic execution.
func (s IntegratedState) Clone() IntegratedState {
	return IntegratedState{
		World:     s.World.Clone(),
		Ecosystem: s.Ecosystem.Clone(),
	}
}

// Validate enforces invariants on both scales AND verifies cross-scale population conservation
// between active tactical groups and ecosystem MaterializedPopulation.
func (s IntegratedState) Validate(worldCfg Config, ecoCfg ecosystem.Config) error {
	if err := s.World.ValidateWithConfig(worldCfg); err != nil {
		return err
	}
	if err := s.Ecosystem.Validate(ecoCfg); err != nil {
		return err
	}

	// Verify exact conservation: sum(un-accounted tactical PopulationWeight per pop) == MaterializedPopulation.
	expectedMat := make(map[string]int64, len(s.Ecosystem.Populations))
	for _, g := range s.World.Groups {
		if g.PopulationWeight > 0 && !g.Accounted {
			expectedMat[g.SourcePopulationID] += g.PopulationWeight
		}
	}
	for _, pop := range s.Ecosystem.Populations {
		if expectedMat[pop.PopulationID] != pop.MaterializedPopulation {
			return fmt.Errorf("%w: cross-scale conservation mismatch for %q: tactical=%d ecosystem_materialized=%d",
				ErrInvalidState, pop.PopulationID, expectedMat[pop.PopulationID], pop.MaterializedPopulation)
		}
	}
	return nil
}

// Checksum computes a canonical SHA-256 digest spanning both simulation scales.
func (s IntegratedState) Checksum(worldCfg Config, ecoCfg ecosystem.Config) (string, error) {
	if err := s.Validate(worldCfg, ecoCfg); err != nil {
		return "", err
	}
	wSum, err := s.World.Checksum()
	if err != nil {
		return "", err
	}
	eSum, err := s.Ecosystem.Checksum(ecoCfg)
	if err != nil {
		return "", err
	}
	h := simulation.NewCanonicalHasher()
	h.WriteString(wSum)
	h.WriteString(eSum)
	return h.SumHex(), nil
}

// MarshalSnapshot encodes IntegratedState with canonical checksum and enforces MaxSnapshotBytes.
func (s IntegratedState) MarshalSnapshot(worldCfg Config, ecoCfg ecosystem.Config) ([]byte, error) {
	sum, err := s.Checksum(worldCfg, ecoCfg)
	if err != nil {
		return nil, err
	}
	raw, err := simulation.EncodeSnapshot(s, sum)
	if err != nil {
		return nil, err
	}
	maxBytes := worldCfg.MaxSnapshotBytes
	if ecoCfg.MaxSnapshotBytes < maxBytes {
		maxBytes = ecoCfg.MaxSnapshotBytes
	}
	if len(raw) > maxBytes {
		return nil, fmt.Errorf("%w: integrated snapshot size %d exceeds %d", simulation.ErrSnapshotTooLarge, len(raw), maxBytes)
	}
	return raw, nil
}

// UnmarshalIntegratedSnapshot enforces byte limits BEFORE JSON decode and verifies cross-scale invariants.
func UnmarshalIntegratedSnapshot(data []byte, worldCfg Config, ecoCfg ecosystem.Config) (IntegratedState, error) {
	if err := worldCfg.Validate(); err != nil {
		return IntegratedState{}, err
	}
	if err := ecoCfg.Validate(); err != nil {
		return IntegratedState{}, err
	}
	maxBytes := worldCfg.MaxSnapshotBytes
	if ecoCfg.MaxSnapshotBytes < maxBytes {
		maxBytes = ecoCfg.MaxSnapshotBytes
	}
	opts := simulation.DecodeOptions{MaxBytes: maxBytes}
	st, err := simulation.DecodeSnapshotWithOptions(data, opts, func(is IntegratedState) (string, error) {
		return is.Checksum(worldCfg, ecoCfg)
	})
	if err != nil {
		return IntegratedState{}, err
	}
	if err := st.Validate(worldCfg, ecoCfg); err != nil {
		return IntegratedState{}, err
	}
	return st, nil
}

// MaterializeGroup atomically reserves abstract population from an operational ecosystem camp
// and spawns a linked tactical CreatureGroup obeying MaxActiveGroups (default 32) and retired ID guards.
func MaterializeGroup(
	state IntegratedState,
	campID string,
	groupID string,
	archetype string,
	count int64,
	position int64,
	worldCfg Config,
	ecoCfg ecosystem.Config,
) (IntegratedState, []DomainEvent, []ecosystem.EcologicalEvent, error) {
	if err := state.Validate(worldCfg, ecoCfg); err != nil {
		return IntegratedState{}, nil, nil, err
	}
	if len(state.World.Groups) >= worldCfg.MaxActiveGroups {
		return IntegratedState{}, nil, nil, fmt.Errorf("%w: max active groups %d reached", ErrCapacityExceeded, worldCfg.MaxActiveGroups)
	}
	if slices.Contains(state.World.RetiredGroupIDs, groupID) {
		return IntegratedState{}, nil, nil, fmt.Errorf("%w: %q", ErrRetiredGroupID, groupID)
	}
	if findGroupIndex(state.World.Groups, groupID) >= 0 {
		return IntegratedState{}, nil, nil, fmt.Errorf("%w: duplicate group_id %q", ErrInvalidCommand, groupID)
	}

	next := state.Clone()
	ticket, ecoEv, err := ecosystem.ReserveForMaterialization(&next.Ecosystem, campID, archetype, count)
	if err != nil {
		return IntegratedState{}, nil, nil, err
	}

	spawnPos := worldCfg.HostileSpawnDistance
	if position > 0 {
		if position > worldCfg.MaxBattlefieldDistance {
			return IntegratedState{}, nil, nil, fmt.Errorf("%w: position %d exceeds battlefield limit", ErrInvalidCommand, position)
		}
		spawnPos = position
	}

	worldEvents := make([]DomainEvent, 0, 2)
	spawnCmd := Command{
		Kind:         CmdSpawnHostileGroup,
		Tick:         next.World.Tick,
		GroupID:      groupID,
		Archetype:    ticket.Archetype,
		Count:        count,
		HomePosition: spawnPos,
		Position:     spawnPos,
	}
	if err := applySpawnHostileGroup(&next.World, spawnCmd, worldCfg, &worldEvents); err != nil {
		return IntegratedState{}, nil, nil, err
	}

	// Attach ecosystem provenance strictly onto the newly materialized tactical group.
	gIdx := findGroupIndex(next.World.Groups, groupID)
	next.World.Groups[gIdx].SourcePopulationID = ticket.PopulationID
	next.World.Groups[gIdx].SourceCampID = ticket.CampID
	next.World.Groups[gIdx].SourceRegionID = ticket.RegionID
	next.World.Groups[gIdx].FactionID = ticket.FactionID
	next.World.Groups[gIdx].PopulationWeight = ticket.ContingentSize
	next.World.Groups[gIdx].Accounted = false

	if err := next.Validate(worldCfg, ecoCfg); err != nil {
		return IntegratedState{}, nil, nil, err
	}
	return next, worldEvents, []ecosystem.EcologicalEvent{ecoEv}, nil
}

// DematerializeGroup cleanly recalls an active tactical group, returns living survivors to
// FreePopulation (0 survivors if defeated), accounts losses strictly once, and retires the group.
func DematerializeGroup(
	state IntegratedState,
	groupID string,
	worldCfg Config,
	ecoCfg ecosystem.Config,
) (IntegratedState, ecosystem.DematerializationSummary, []ecosystem.EcologicalEvent, error) {
	if err := state.Validate(worldCfg, ecoCfg); err != nil {
		return IntegratedState{}, ecosystem.DematerializationSummary{}, nil, err
	}
	next := state.Clone()
	gIdx := findGroupIndex(next.World.Groups, groupID)
	if gIdx < 0 {
		return IntegratedState{}, ecosystem.DematerializationSummary{}, nil, fmt.Errorf("%w: group %q", ErrUnknownEntity, groupID)
	}
	g := next.World.Groups[gIdx]
	if g.PopulationWeight == 0 || g.Accounted {
		return IntegratedState{}, ecosystem.DematerializationSummary{}, nil, fmt.Errorf("%w: group %q is not an active materialized contingent", ErrInvalidCommand, groupID)
	}

	ticket := ecosystem.MaterializationTicket{
		PopulationID:   g.SourcePopulationID,
		CampID:         g.SourceCampID,
		RegionID:       g.SourceRegionID,
		FactionID:      g.FactionID,
		FamilyID:       g.Family,
		Archetype:      g.Archetype,
		ContingentSize: g.PopulationWeight,
	}
	defeated := g.HP == 0 || g.State == ai.StateDead
	summary, ecoEv, err := ecosystem.ReconcileDematerialization(&next.Ecosystem, ticket, g.HP, g.MaxHP, defeated)
	if err != nil {
		return IntegratedState{}, ecosystem.DematerializationSummary{}, nil, err
	}

	// Remove dematerialized group immediately and retire its ID safely.
	next.World.Groups = slices.Delete(next.World.Groups, gIdx, gIdx+1)
	recordRetiredGroupID(&next.World, groupID, worldCfg.MaxRetiredGroupIDs)

	if err := next.Validate(worldCfg, ecoCfg); err != nil {
		return IntegratedState{}, ecosystem.DematerializationSummary{}, nil, err
	}
	return next, summary, []ecosystem.EcologicalEvent{ecoEv}, nil
}

// StepIntegrated advances tactical simulation by one tick, reconciles any newly dead/routed
// materialized groups back into the ecosystem strictly once, and advances the regional ecosystem
// by one epoch whenever World.Tick is a multiple of ecoCfg.TicksPerEpoch.
func StepIntegrated(
	state IntegratedState,
	worldCmds []Command,
	ecoCmds []ecosystem.Command,
	worldCfg Config,
	ecoCfg ecosystem.Config,
) (IntegratedState, []DomainEvent, []ecosystem.EcologicalEvent, error) {
	if err := state.Validate(worldCfg, ecoCfg); err != nil {
		return IntegratedState{}, nil, nil, err
	}

	nextWorld, wEvents, err := Step(state.World, worldCmds, worldCfg)
	if err != nil {
		return IntegratedState{}, nil, nil, err
	}

	nextEco := state.Ecosystem.Clone()
	ecoEvents := make([]ecosystem.EcologicalEvent, 0, 8)

	// Reconcile terminal materialized tactical groups strictly once BEFORE cleanup evicts them.
	for i := range nextWorld.Groups {
		g := &nextWorld.Groups[i]
		terminal := g.HP == 0 || g.State == ai.StateDead || g.Routed
		if terminal && g.PopulationWeight > 0 && !g.Accounted {
			ticket := ecosystem.MaterializationTicket{
				PopulationID:   g.SourcePopulationID,
				CampID:         g.SourceCampID,
				RegionID:       g.SourceRegionID,
				FactionID:      g.FactionID,
				FamilyID:       g.Family,
				Archetype:      g.Archetype,
				ContingentSize: g.PopulationWeight,
			}
			defeated := g.HP == 0 || g.State == ai.StateDead
			_, ev, err := ecosystem.ReconcileDematerialization(&nextEco, ticket, g.HP, g.MaxHP, defeated)
			if err != nil {
				return IntegratedState{}, nil, nil, err
			}
			g.Accounted = true
			if g.TerminalTick == 0 {
				g.TerminalTick = nextWorld.Tick
			}
			ecoEvents = append(ecoEvents, ev)
		}
	}

	// Advance regional ecosystem on configured epoch interval (Scale B).
	if nextWorld.Tick%ecoCfg.TicksPerEpoch == 0 {
		updatedEco, epEvents, err := ecosystem.StepEpoch(nextEco, ecoCmds, ecoCfg)
		if err != nil {
			return IntegratedState{}, nil, nil, err
		}
		nextEco = updatedEco
		ecoEvents = append(ecoEvents, epEvents...)

		// Bridge critical regional threat pressure into tactical world threat (bounded, non-spam).
		for _, reg := range nextEco.Regions {
			if reg.ThreatLevel == ecosystem.ThreatCritical && reg.LastEventIntentEpoch == nextEco.Epoch {
				boost := int64(250)
				if nextWorld.RegionalThreat+boost > worldCfg.MaxThreat {
					nextWorld.RegionalThreat = worldCfg.MaxThreat
				} else {
					nextWorld.RegionalThreat += boost
				}
			}
		}
	}

	out := IntegratedState{
		World:     nextWorld,
		Ecosystem: nextEco,
	}
	if err := out.Validate(worldCfg, ecoCfg); err != nil {
		return IntegratedState{}, nil, nil, err
	}
	return out, wEvents, ecoEvents, nil
}
