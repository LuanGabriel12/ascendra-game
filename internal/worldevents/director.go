package worldevents

import (
	"context"
	"fmt"
	"math"
	"slices"
	"strings"

	"ascendra-game/internal/ai"
	"ascendra-game/internal/ecosystem"
	"ascendra-game/internal/ports"
	"ascendra-game/internal/simulation"
	"ascendra-game/internal/world"
)

// OrchestratedConfig combines validated configurations for all three deterministic simulation layers.
type OrchestratedConfig struct {
	World     world.Config     `json:"world"`
	Ecosystem ecosystem.Config `json:"ecosystem"`
	Director  Config           `json:"director"`
}

// DefaultOrchestratedConfig returns balanced Cycle 04 defaults with World.OrchestrationMode
// set explicitly to OrchestrationCampaignDirector (single invasion authority).
func DefaultOrchestratedConfig() OrchestratedConfig {
	wCfg := world.DefaultConfig()
	wCfg.OrchestrationMode = world.OrchestrationCampaignDirector
	return OrchestratedConfig{
		World:     wCfg,
		Ecosystem: ecosystem.DefaultConfig(),
		Director:  DefaultConfig(),
	}
}

// Validate enforces validity across all three configuration layers and requires CampaignDirector mode.
func (c OrchestratedConfig) Validate() error {
	if err := c.World.Validate(); err != nil {
		return err
	}
	if c.World.OrchestrationMode != world.OrchestrationCampaignDirector {
		return fmt.Errorf("%w: orchestrated mode requires world.OrchestrationCampaignDirector, got %q", ErrInvalidConfig, c.World.OrchestrationMode)
	}
	if err := c.Ecosystem.Validate(); err != nil {
		return err
	}
	return c.Director.Validate()
}

// OrchestratedState unifies the three authoritative simulation layers with a single source of truth:
//   - Director: World Event Director, dynamic campaigns, deterministic scheduler, cooldowns, terminal facts.
//   - World: Tactical settlement arena, Creature AI, combat resolution, player contributions.
//   - Ecosystem: Regional populations (Free + Reserved + Materialized), reservations, camps, resources, threat.
type OrchestratedState struct {
	Director  DirectorState            `json:"director"`
	World     world.WorldState         `json:"world"`
	Ecosystem ecosystem.EcosystemState `json:"ecosystem"`
}

// NewOrchestratedState initializes a validated three-layer deterministic simulation state.
func NewOrchestratedState(
	simulationID string,
	settlementID string,
	seed uint64,
	reader ports.SettlementReader,
	eco ecosystem.EcosystemState,
) (OrchestratedState, error) {
	w, err := world.NewWorldState(simulationID, settlementID, seed, reader)
	if err != nil {
		return OrchestratedState{}, err
	}
	eco.SimulationID = simulationID
	st := OrchestratedState{
		Director:  NewDirectorState(simulationID, seed^0xA5C3D4A04),
		World:     w,
		Ecosystem: eco,
	}
	return st, nil
}

// Clone returns a deep copy of all three layers for strictly atomic Step execution.
func (s OrchestratedState) Clone() OrchestratedState {
	return OrchestratedState{
		Director:  s.Director.Clone(),
		World:     s.World.Clone(),
		Ecosystem: s.Ecosystem.Clone(),
	}
}

// Validate verifies all intra-layer invariants AND strict cross-layer referential and
// 3-bucket population conservation invariants (Free + Reserved + Materialized).
func (s OrchestratedState) Validate(cfg OrchestratedConfig) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	if err := s.Director.Validate(cfg.Director); err != nil {
		return err
	}
	if err := s.World.ValidateWithConfig(cfg.World); err != nil {
		return err
	}
	if err := s.Ecosystem.Validate(cfg.Ecosystem); err != nil {
		return err
	}
	if s.Director.Tick != s.World.Tick {
		return fmt.Errorf("%w: director tick %d != world tick %d", ErrInvalidState, s.Director.Tick, s.World.Tick)
	}

	popByID := make(map[string]ecosystem.Population, len(s.Ecosystem.Populations))
	for _, p := range s.Ecosystem.Populations {
		popByID[p.PopulationID] = p
	}
	campToPop := make(map[string]string, len(s.Ecosystem.Camps))
	for _, c := range s.Ecosystem.Camps {
		campToPop[c.CampID] = c.PopulationID
	}
	resByID := make(map[string]ecosystem.PopulationReservation, len(s.Ecosystem.Reservations))
	for _, r := range s.Ecosystem.Reservations {
		resByID[r.ReservationID] = r
	}

	// Verify campaign -> reservation referential integrity and uniqueness.
	seenCampaignRes := make(map[string]struct{}, len(s.Director.Campaigns))
	for _, c := range s.Director.Campaigns {
		if c.ReservationID != "" {
			if _, dup := seenCampaignRes[c.ReservationID]; dup {
				return fmt.Errorf("%w: duplicate reservation %q referenced by campaigns", ErrInvalidState, c.ReservationID)
			}
			seenCampaignRes[c.ReservationID] = struct{}{}
			res, ok := resByID[c.ReservationID]
			if !ok {
				return fmt.Errorf("%w: campaign %q references missing reservation %q", ErrInvalidState, c.CampaignID, c.ReservationID)
			}
			if res.CampaignID != c.CampaignID || res.PopulationID != c.SourcePopulationID || res.CampID != c.SourceCampID {
				return fmt.Errorf("%w: campaign %q reservation %q provenance mismatch", ErrInvalidState, c.CampaignID, c.ReservationID)
			}
		}
	}

	// Verify exact cross-layer conservation between tactical groups, reservations, and populations.
	expectedPopMat := make(map[string]int64, len(s.Ecosystem.Populations))
	expectedResMat := make(map[string]int64, len(s.Ecosystem.Reservations))
	for _, g := range s.World.Groups {
		if g.PopulationWeight > 0 && g.Accounted && g.HP > 0 && !g.Routed && g.State != ai.StateDead {
			return fmt.Errorf("%w: active tactical group %q is marked accounted", ErrInvalidState, g.GroupID)
		}
		if g.PopulationWeight > 0 && !g.Accounted {
			pop, ok := popByID[g.SourcePopulationID]
			if !ok || campToPop[g.SourceCampID] != g.SourcePopulationID || pop.RegionID != g.SourceRegionID || pop.FactionID != g.FactionID || pop.FamilyID != g.Family {
				return fmt.Errorf("%w: tactical group %q has invalid ecosystem provenance", ErrInvalidState, g.GroupID)
			}
			var err error
			if expectedPopMat[g.SourcePopulationID], err = safeAddInt64(expectedPopMat[g.SourcePopulationID], g.PopulationWeight); err != nil {
				return err
			}
			if g.ReservationID != "" {
				res, ok := resByID[g.ReservationID]
				if !ok || res.PopulationID != g.SourcePopulationID || res.CampID != g.SourceCampID || res.CampaignID != g.CampaignID {
					return fmt.Errorf("%w: tactical group %q reservation %q mismatch", ErrInvalidState, g.GroupID, g.ReservationID)
				}
				if expectedResMat[g.ReservationID], err = safeAddInt64(expectedResMat[g.ReservationID], g.PopulationWeight); err != nil {
					return err
				}
			}
		}
	}
	for _, p := range s.Ecosystem.Populations {
		if expectedPopMat[p.PopulationID] != p.MaterializedPopulation {
			return fmt.Errorf("%w: population %q tactical weight %d != materialized %d",
				ErrInvalidState, p.PopulationID, expectedPopMat[p.PopulationID], p.MaterializedPopulation)
		}
	}
	for _, r := range s.Ecosystem.Reservations {
		if expectedResMat[r.ReservationID] != r.RemainingMaterialized() {
			return fmt.Errorf("%w: reservation %q tactical weight %d != remaining materialized %d",
				ErrInvalidState, r.ReservationID, expectedResMat[r.ReservationID], r.RemainingMaterialized())
		}
	}
	return nil
}

// Checksum computes a canonical architecture-independent SHA-256 hash spanning all three layers.
func (s OrchestratedState) Checksum(cfg OrchestratedConfig) (string, error) {
	if err := s.Validate(cfg); err != nil {
		return "", err
	}
	dSum, err := s.Director.Checksum(cfg.Director)
	if err != nil {
		return "", err
	}
	wSum, err := s.World.Checksum()
	if err != nil {
		return "", err
	}
	eSum, err := s.Ecosystem.Checksum(cfg.Ecosystem)
	if err != nil {
		return "", err
	}
	h := simulation.NewCanonicalHasher()
	h.WriteString(dSum)
	h.WriteString(wSum)
	h.WriteString(eSum)
	return h.SumHex(), nil
}

// MarshalSnapshot encodes OrchestratedState into Snapshot v4 with canonical checksum and size limit.
func (s OrchestratedState) MarshalSnapshot(cfg OrchestratedConfig) ([]byte, error) {
	sum, err := s.Checksum(cfg)
	if err != nil {
		return nil, err
	}
	raw, err := simulation.EncodeSnapshot(s, sum)
	if err != nil {
		return nil, err
	}
	maxBytes := minSnapshotLimit(cfg)
	if len(raw) > maxBytes {
		return nil, fmt.Errorf("%w: orchestrated snapshot size %d exceeds limit %d", simulation.ErrSnapshotTooLarge, len(raw), maxBytes)
	}
	return raw, nil
}

// UnmarshalOrchestratedSnapshot enforces MaxSnapshotBytes BEFORE JSON decoding, rejects legacy
// schema versions (v1/v2/v3), verifies the canonical checksum, and validates all cross-layer invariants.
func UnmarshalOrchestratedSnapshot(data []byte, cfg OrchestratedConfig) (OrchestratedState, error) {
	if err := cfg.Validate(); err != nil {
		return OrchestratedState{}, err
	}
	opts := simulation.DecodeOptions{MaxBytes: minSnapshotLimit(cfg)}
	st, err := simulation.DecodeSnapshotWithOptions(data, opts, func(os OrchestratedState) (string, error) {
		return os.Checksum(cfg)
	})
	if err != nil {
		return OrchestratedState{}, err
	}
	if err := st.Validate(cfg); err != nil {
		return OrchestratedState{}, err
	}
	return st, nil
}

func minSnapshotLimit(cfg OrchestratedConfig) int {
	limit := cfg.Director.MaxSnapshotBytes
	if cfg.World.MaxSnapshotBytes < limit {
		limit = cfg.World.MaxSnapshotBytes
	}
	if cfg.Ecosystem.MaxSnapshotBytes < limit {
		limit = cfg.Ecosystem.MaxSnapshotBytes
	}
	return limit
}

// StepInput cleanly separates player gameplay intentions, director commands, and epoch ecosystem commands.
type StepInput struct {
	GameplayCommands  []world.GameplayCommand `json:"gameplay_commands,omitempty"`
	DirectorCommands  []DirectorCommand       `json:"director_commands,omitempty"`
	EcosystemCommands []ecosystem.Command     `json:"ecosystem_commands,omitempty"`
}

// StepOutput aggregates deterministic immutable events produced across all three layers on a tick.
type StepOutput struct {
	DirectorEvents   []DirectorEvent             `json:"director_events"`
	WorldEvents      []world.DomainEvent         `json:"world_events"`
	EcosystemEvents  []ecosystem.EcologicalEvent `json:"ecosystem_events"`
	TerminalOutcomes []TerminalSettlementOutcome `json:"terminal_outcomes"`
}

// Step advances the entire three-layer deterministic simulation (Director + World + Ecosystem)
// by exactly one logical tick. Pure, I/O-free, wall-clock-free, float-free, and strictly atomic:
// if any command or invariant fails, the caller's input state remains untouched.
func Step(state OrchestratedState, input StepInput, cfg OrchestratedConfig) (OrchestratedState, StepOutput, error) {
	if err := state.Validate(cfg); err != nil {
		return OrchestratedState{}, StepOutput{}, err
	}
	if state.Director.Tick == math.MaxUint64 || state.World.Tick == math.MaxUint64 {
		return OrchestratedState{}, StepOutput{}, ErrNumericOverflow
	}
	if len(input.DirectorCommands) > cfg.World.MaxCommandsPerTick {
		return OrchestratedState{}, StepOutput{}, fmt.Errorf("%w: too many director commands (%d)", ErrCapacityExceeded, len(input.DirectorCommands))
	}

	next := state.Clone()
	nextTick := next.Director.Tick + 1
	next.Director.Tick = nextTick

	// Ecosystem commands are only valid on exact epoch ticks.
	isEpochTick := nextTick%cfg.Ecosystem.TicksPerEpoch == 0
	if !isEpochTick && len(input.EcosystemCommands) > 0 {
		return OrchestratedState{}, StepOutput{}, fmt.Errorf("%w: ecosystem commands supplied on non-epoch tick %d (ticks_per_epoch=%d)", ErrInvalidCommand, nextTick, cfg.Ecosystem.TicksPerEpoch)
	}

	dirEvents := make([]DirectorEvent, 0, 8)
	ecoEvents := make([]ecosystem.EcologicalEvent, 0, 8)
	worldDirectorCmds := make([]world.DirectorCommand, 0, 4)
	outcomes := make([]TerminalSettlementOutcome, 0, 1)

	// 1. Prune expired cooldown entries to guarantee O(1) bounded memory over thousands of epochs.
	pruneExpiredCooldowns(&next.Director.RegionCooldowns, nextTick)
	pruneExpiredCooldowns(&next.Director.SettlementCooldowns, nextTick)

	// 2. Advance regional ecosystem on exact epoch cadence BEFORE campaign evaluation so
	// freshly destroyed camps or population collapses immediately influence director decisions.
	if isEpochTick {
		updatedEco, epEvs, err := ecosystem.StepEpoch(next.Ecosystem, input.EcosystemCommands, cfg.Ecosystem)
		if err != nil {
			return OrchestratedState{}, StepOutput{}, err
		}
		next.Ecosystem = updatedEco
		ecoEvents = append(ecoEvents, epEvs...)
	}

	// 3. Apply explicit deterministic DirectorCommands in canonical order.
	if err := applyDirectorCommands(&next, input.DirectorCommands, cfg, &worldDirectorCmds, &dirEvents, &ecoEvents); err != nil {
		return OrchestratedState{}, StepOutput{}, err
	}

	// 4. Evaluate ecological campaign candidates periodically and enqueue top eligible candidates.
	if nextTick%cfg.Director.CandidateEvalIntervalTicks == 0 {
		availDefenders := countAliveDefenders(next.World.Defenders)
		candidates, err := EvaluateCandidates(next.Director, next.Ecosystem, next.World, cfg.Director, availDefenders)
		if err != nil {
			return OrchestratedState{}, StepOutput{}, err
		}
		for _, cand := range candidates {
			if len(next.Director.PendingEvents) >= cfg.Director.MaxPendingEvents {
				break
			}
			tpl, ok := LookupPolicy(cfg.Director, cand.TemplateID)
			if !ok {
				continue
			}
			deadline, err := safeAddUint64(nextTick, tpl.DeadlineSlackTicks)
			if err != nil {
				return OrchestratedState{}, StepOutput{}, err
			}
			ev, err := EnqueueScheduledEvent(&next.Director, ScheduledEvent{
				TemplateID:         cand.TemplateID,
				Kind:               cand.EventKind,
				Category:           CategoryCreature,
				RegionID:           cand.RegionID,
				SettlementID:       cand.SettlementID,
				FactionID:          cand.FactionID,
				SourcePopulationID: cand.SourcePopulationID,
				SourceCampID:       cand.SourceCampID,
				Priority:           cand.Priority,
				ThreatScore:        cand.ThreatScore,
				CreatedTick:        nextTick,
				ScheduledTick:      nextTick,
				DeadlineTick:       deadline,
				ChainDepth:         0,
			}, cfg.Director)
			if err != nil {
				return OrchestratedState{}, StepOutput{}, err
			}
			de, err := next.Director.newDirectorEvent(
				DirEventCandidateScheduled,
				"",
				ev.RegionID,
				ev.SettlementID,
				ev.FactionID,
				fmt.Sprintf("event=%s template=%s prio=%d", ev.EventID, ev.TemplateID, ev.Priority),
				ev.Priority,
				nil,
			)
			if err != nil {
				return OrchestratedState{}, StepOutput{}, err
			}
			dirEvents = append(dirEvents, de)
		}
	}

	// 5. Run deterministic tick scheduler (expiry, anti-starvation aging, priority & canonical tie-break, concurrency caps).
	dispatched, err := processScheduler(&next.Director, cfg.Director, &dirEvents)
	if err != nil {
		return OrchestratedState{}, StepOutput{}, err
	}
	for _, ev := range dispatched {
		if err := launchFromScheduledEvent(&next.Director, next.Ecosystem, next.World, ev, cfg.Director, &dirEvents); err != nil {
			return OrchestratedState{}, StepOutput{}, err
		}
	}

	// 6. Advance all campaigns (reservations, recon, prep, warning, mobilization, launch, recovery/archive).
	if err := advanceCampaigns(&next.Director, &next.Ecosystem, &next.World, cfg, &worldDirectorCmds, &dirEvents, &ecoEvents); err != nil {
		return OrchestratedState{}, StepOutput{}, err
	}

	// 7. Execute Tactical World Engine step with strict command separation:
	//    ONLY GameplayCommands + DirectorCommands are permitted; AdminCommands are rejected.
	nextWorld, wEvents, err := world.StepWithDirector(next.World, input.GameplayCommands, worldDirectorCmds, cfg.World)
	if err != nil {
		return OrchestratedState{}, StepOutput{}, err
	}
	next.World = nextWorld

	// 8. Reconcile newly dead or routed materialized groups strictly once via their owning ReservationID.
	for i := range next.World.Groups {
		g := &next.World.Groups[i]
		terminal := g.HP == 0 || g.State == ai.StateDead || g.Routed
		if terminal && g.PopulationWeight > 0 && !g.Accounted {
			defeated := g.HP == 0 || g.State == ai.StateDead
			if g.ReservationID != "" {
				_, ev, err := ecosystem.ReconcileReservationContingent(
					&next.Ecosystem,
					g.ReservationID,
					"term:"+g.GroupID,
					g.PopulationWeight,
					g.HP,
					g.MaxHP,
					defeated,
					cfg.Ecosystem,
				)
				if err != nil {
					return OrchestratedState{}, StepOutput{}, err
				}
				ecoEvents = append(ecoEvents, ev)
			} else {
				ticket := ecosystem.MaterializationTicket{
					PopulationID:   g.SourcePopulationID,
					CampID:         g.SourceCampID,
					RegionID:       g.SourceRegionID,
					FactionID:      g.FactionID,
					FamilyID:       g.Family,
					Archetype:      g.Archetype,
					ContingentSize: g.PopulationWeight,
				}
				_, ev, err := ecosystem.ReconcileDematerialization(&next.Ecosystem, ticket, g.HP, g.MaxHP, defeated)
				if err != nil {
					return OrchestratedState{}, StepOutput{}, err
				}
				ecoEvents = append(ecoEvents, ev)
			}
			g.Accounted = true
			if g.TerminalTick == 0 {
				g.TerminalTick = nextTick
			}
		}
	}

	// 9. Fulfill tactical EventReinforcementRequested strictly via ecological population reservation debit!
	if next.World.Invasion.State == world.InvasionUnderAttack {
		if err := processEcologicalReinforcements(&next, wEvents, cfg, &wEvents, &dirEvents, &ecoEvents); err != nil {
			return OrchestratedState{}, StepOutput{}, err
		}
	}

	// 10. Finalize resolved campaign invasions, emit authoritative TerminalSettlementOutcome (even with 0 players!),
	//     apply ecological consequences, cooldowns, and depth-capped follow-up events.
	if err := finalizeResolvedCampaigns(&next.Director, &next.Ecosystem, &next.World, wEvents, cfg, &dirEvents, &ecoEvents, &outcomes); err != nil {
		return OrchestratedState{}, StepOutput{}, err
	}

	// 11. Cap per-tick director event stream strictly to MaxEventsPerUpdate.
	if len(dirEvents) > cfg.Director.MaxEventsPerUpdate {
		dirEvents = dirEvents[:cfg.Director.MaxEventsPerUpdate]
	}

	// 12. Re-validate all cross-layer invariants before committing return state.
	if err := next.Validate(cfg); err != nil {
		return OrchestratedState{}, StepOutput{}, err
	}
	return next, StepOutput{
		DirectorEvents:   dirEvents,
		WorldEvents:      wEvents,
		EcosystemEvents:  ecoEvents,
		TerminalOutcomes: outcomes,
	}, nil
}

func applyDirectorCommands(
	next *OrchestratedState,
	cmds []DirectorCommand,
	cfg OrchestratedConfig,
	worldCmds *[]world.DirectorCommand,
	dirEvents *[]DirectorEvent,
	ecoEvents *[]ecosystem.EcologicalEvent,
) error {
	if len(cmds) == 0 {
		return nil
	}
	ordered := slices.Clone(cmds)
	slices.SortStableFunc(ordered, func(a, b DirectorCommand) int {
		if c := strings.Compare(string(a.Kind), string(b.Kind)); c != 0 {
			return c
		}
		if c := strings.Compare(a.CampaignID, b.CampaignID); c != 0 {
			return c
		}
		if c := strings.Compare(a.TemplateID, b.TemplateID); c != 0 {
			return c
		}
		if c := strings.Compare(a.RegionID, b.RegionID); c != 0 {
			return c
		}
		return strings.Compare(a.SourcePopulationID, b.SourcePopulationID)
	})

	for _, cmd := range ordered {
		if cmd.Tick != next.Director.Tick {
			return fmt.Errorf("%w: director command tick %d != step tick %d", ErrInvalidCommand, cmd.Tick, next.Director.Tick)
		}
		switch cmd.Kind {
		case DirCmdScheduleCampaign:
			if cmd.SettlementID == "" {
				cmd.SettlementID = next.World.SettlementID
			}
			cand, err := validateDirectCandidate(next.Director, next.Ecosystem, cmd, cfg.Director)
			if err != nil {
				return err
			}
			tpl, _ := LookupPolicy(cfg.Director, cand.TemplateID)
			schedTick := cmd.ScheduledTick
			if schedTick < next.Director.Tick {
				schedTick = next.Director.Tick
			}
			deadline, err := safeAddUint64(schedTick, tpl.DeadlineSlackTicks)
			if err != nil {
				return err
			}
			ev, err := EnqueueScheduledEvent(&next.Director, ScheduledEvent{
				TemplateID:         cand.TemplateID,
				Kind:               cand.EventKind,
				Category:           CategoryCreature,
				RegionID:           cand.RegionID,
				SettlementID:       cand.SettlementID,
				FactionID:          cand.FactionID,
				SourcePopulationID: cand.SourcePopulationID,
				SourceCampID:       cand.SourceCampID,
				Priority:           cand.Priority,
				ThreatScore:        cand.ThreatScore,
				CreatedTick:        next.Director.Tick,
				ScheduledTick:      schedTick,
				DeadlineTick:       deadline,
				ChainDepth:         0,
			}, cfg.Director)
			if err != nil {
				return err
			}
			de, err := next.Director.newDirectorEvent(
				DirEventCandidateScheduled,
				"",
				ev.RegionID,
				ev.SettlementID,
				ev.FactionID,
				fmt.Sprintf("explicit event=%s template=%s", ev.EventID, ev.TemplateID),
				ev.Priority,
				nil,
			)
			if err != nil {
				return err
			}
			*dirEvents = append(*dirEvents, de)

		case DirCmdCancelCampaign:
			idx := findCampaignIndex(next.Director.Campaigns, cmd.CampaignID)
			if idx < 0 {
				return fmt.Errorf("%w: %q", ErrCampaignNotFound, cmd.CampaignID)
			}
			c := &next.Director.Campaigns[idx]
			if err := ValidateCampaignTransition(c.State, CampaignCancelled); err != nil {
				return err
			}
			reason := cmd.Reason
			if strings.TrimSpace(reason) == "" {
				reason = "cancelled by director command"
			}
			if err := abortPreActiveCampaign(c, CampaignCancelled, reason, &next.Director, &next.Ecosystem, &next.World, cfg, worldCmds, dirEvents, ecoEvents); err != nil {
				return err
			}
			archiveCompletedCampaigns(&next.Director, &next.Ecosystem, cfg)

		default:
			return fmt.Errorf("%w: unknown director command kind %q", ErrInvalidCommand, cmd.Kind)
		}
	}
	return nil
}

// processEcologicalReinforcements converts EventReinforcementRequested emitted by linked tactical
// groups into validated, ecologically debited reinforcement spawns strictly from the campaign's
// pre-reserved population buffer. If the camp is destroyed, reservation exhausted, or caps hit,
// the request is cleanly denied without error or phantom population creation.
func processEcologicalReinforcements(
	next *OrchestratedState,
	emitted []world.DomainEvent,
	cfg OrchestratedConfig,
	worldEvents *[]world.DomainEvent,
	dirEvents *[]DirectorEvent,
	ecoEvents *[]ecosystem.EcologicalEvent,
) error {
	reqCount := 0
	for _, ev := range emitted {
		if ev.Type == world.EventReinforcementRequested {
			reqCount++
		}
	}
	if reqCount == 0 {
		return nil
	}

	// Copy requests before appending new events into *worldEvents.
	requests := make([]world.DomainEvent, 0, reqCount)
	for _, ev := range emitted {
		if ev.Type == world.EventReinforcementRequested {
			requests = append(requests, ev)
		}
	}

	for _, req := range requests {
		if next.World.Invasion.ReinforcementWaves >= cfg.World.MaxReinforcementWaves ||
			len(next.World.Groups) >= cfg.World.MaxActiveGroups {
			break
		}
		var caller world.CreatureGroup
		foundCaller := false
		for _, g := range next.World.Groups {
			if g.GroupID == req.SourceEntityID {
				caller = g
				foundCaller = true
				break
			}
		}
		if !foundCaller || caller.HP == 0 || caller.Routed || caller.State == ai.StateDead || caller.CampaignID == "" || caller.ReservationID == "" {
			continue
		}
		cIdx := findCampaignIndex(next.Director.Campaigns, caller.CampaignID)
		if cIdx < 0 || next.Director.Campaigns[cIdx].State != CampaignActive {
			continue
		}
		c := &next.Director.Campaigns[cIdx]
		tpl, ok := LookupPolicy(cfg.Director, c.TemplateID)
		if !ok || !tpl.AllowEcologicalReinforcements || c.ReinforcementsDeployed >= tpl.MaxCampaignReinforcements {
			continue
		}
		if !isCampOperational(next.Ecosystem, c.SourceCampID, c.SourcePopulationID) {
			continue
		}

		opKey := fmt.Sprintf("reinf:%s:%d", c.CampaignID, c.ReinforcementsDeployed+1)
		ticket, matEv, err := ecosystem.MaterializeFromReservation(
			&next.Ecosystem,
			c.ReservationID,
			opKey,
			tpl.ReinforcementArchetype,
			tpl.ReinforcementCount,
			cfg.Ecosystem,
		)
		if err != nil {
			// Insufficient reserved buffer or camp closed: cleanly deny without phantom spawn.
			continue
		}
		grpID, err := world.NextDurableGroupID(&next.World, c.CampaignID, "reinf", cfg.World.MaxIdentifierLength)
		if err != nil {
			return err
		}
		spawnCmd := world.DirectorCommand{
			Kind:               world.CmdDirectorSpawnCampaignGroup,
			Tick:               next.Director.Tick,
			CampaignID:         c.CampaignID,
			InvadingFactionID:  c.FactionID,
			GroupID:            grpID,
			Archetype:          ticket.Archetype,
			Count:              tpl.ReinforcementCount,
			Position:           caller.HomePosition,
			HomePosition:       caller.HomePosition,
			ReservationID:      c.ReservationID,
			SourcePopulationID: ticket.PopulationID,
			SourceCampID:       ticket.CampID,
			SourceRegionID:     ticket.RegionID,
			PopulationWeight:   ticket.ContingentSize,
		}
		spawnEvs, err := world.SpawnCampaignReinforcement(&next.World, caller.GroupID, spawnCmd, cfg.World)
		if err != nil {
			return err
		}
		c.ReinforcementsDeployed++
		*ecoEvents = append(*ecoEvents, matEv)
		*worldEvents = append(*worldEvents, spawnEvs...)
		de, err := next.Director.newDirectorEvent(
			DirEventReinforcementDeployed,
			c.CampaignID,
			c.RegionID,
			c.SettlementID,
			c.FactionID,
			fmt.Sprintf("caller=%s group=%s archetype=%s", caller.GroupID, grpID, ticket.Archetype),
			ticket.ContingentSize,
			nil,
		)
		if err != nil {
			return err
		}
		*dirEvents = append(*dirEvents, de)
	}
	return nil
}

func pruneExpiredCooldowns(list *[]CooldownEntry, tick uint64) {
	if len(*list) == 0 {
		return
	}
	kept := (*list)[:0]
	for _, cd := range *list {
		if cd.ReadyAtTick > tick {
			kept = append(kept, cd)
		}
	}
	*list = kept
}

func countAliveDefenders(defenders []world.DefenderEntity) int {
	n := 0
	for _, d := range defenders {
		if d.HP > 0 {
			n++
		}
	}
	return n
}

// RunResult summarizes a multi-tick orchestrated headless simulation run.
type RunResult struct {
	FinalState       OrchestratedState
	FinalChecksum    string
	DirectorEvents   []DirectorEvent
	WorldEvents      []world.DomainEvent
	EcosystemEvents  []ecosystem.EcologicalEvent
	TerminalOutcomes []TerminalSettlementOutcome
}

// RunOrchestrated advances an OrchestratedState headlessly up to targetTick using an optional
// deterministic input generator function. Bounded event retention prevents unbounded RAM growth.
func RunOrchestrated(
	ctx context.Context,
	initial OrchestratedState,
	inputFn func(tick uint64, cur OrchestratedState) StepInput,
	targetTick uint64,
	cfg OrchestratedConfig,
	maxRetainedEvents int,
) (RunResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	cur := initial.Clone()
	var dirEvs []DirectorEvent
	var wEvs []world.DomainEvent
	var ecoEvs []ecosystem.EcologicalEvent
	var outcomes []TerminalSettlementOutcome

	for cur.Director.Tick < targetTick {
		select {
		case <-ctx.Done():
			return RunResult{}, ctx.Err()
		default:
		}
		nextTick := cur.Director.Tick + 1
		var in StepInput
		if inputFn != nil {
			in = inputFn(nextTick, cur)
		}
		next, out, err := Step(cur, in, cfg)
		if err != nil {
			return RunResult{}, err
		}
		dirEvs = appendBounded(dirEvs, out.DirectorEvents, maxRetainedEvents)
		wEvs = appendBounded(wEvs, out.WorldEvents, maxRetainedEvents)
		ecoEvs = appendBounded(ecoEvs, out.EcosystemEvents, maxRetainedEvents)
		outcomes = appendBounded(outcomes, out.TerminalOutcomes, maxRetainedEvents)
		cur = next
	}

	sum, err := cur.Checksum(cfg)
	if err != nil {
		return RunResult{}, err
	}
	return RunResult{
		FinalState:       cur,
		FinalChecksum:    sum,
		DirectorEvents:   dirEvs,
		WorldEvents:      wEvs,
		EcosystemEvents:  ecoEvs,
		TerminalOutcomes: outcomes,
	}, nil
}

func appendBounded[T any](dst []T, src []T, limit int) []T {
	if len(src) == 0 {
		return dst
	}
	dst = append(dst, src...)
	if limit > 0 && len(dst) > limit {
		dst = append([]T(nil), dst[len(dst)-limit:]...)
	}
	return dst
}
