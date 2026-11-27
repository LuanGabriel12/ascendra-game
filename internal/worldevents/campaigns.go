package worldevents

import (
	"errors"
	"fmt"
	"math"
	"slices"

	"ascendra-game/internal/ai"
	"ascendra-game/internal/ecosystem"
	"ascendra-game/internal/ports"
	"ascendra-game/internal/world"
)

// ValidateCampaignTransition enforces the explicit Campaign Finite State Machine (FSM).
// Arbitrary jumps and re-entry from terminal states are unconditionally rejected.
func ValidateCampaignTransition(from, to CampaignState) error {
	if !from.Valid() || !to.Valid() {
		return fmt.Errorf("%w: unknown campaign state %q -> %q", ErrInvalidCampaignTransition, from, to)
	}
	allowed := false
	switch from {
	case CampaignCandidate:
		allowed = to == CampaignScheduled || to == CampaignCancelled || to == CampaignExpired
	case CampaignScheduled:
		allowed = to == CampaignReconnaissance || to == CampaignCancelled || to == CampaignExpired
	case CampaignReconnaissance:
		allowed = to == CampaignPreparing || to == CampaignCancelled || to == CampaignExpired
	case CampaignPreparing:
		allowed = to == CampaignWarning || to == CampaignCancelled || to == CampaignExpired
	case CampaignWarning:
		allowed = to == CampaignMobilizing || to == CampaignCancelled || to == CampaignExpired
	case CampaignMobilizing:
		allowed = to == CampaignActive || to == CampaignCancelled || to == CampaignExpired
	case CampaignActive:
		allowed = to == CampaignResolving
	case CampaignResolving:
		allowed = to == CampaignDefended || to == CampaignCaptured
	case CampaignDefended, CampaignCaptured:
		allowed = to == CampaignRecovering
	case CampaignCancelled, CampaignExpired, CampaignRecovering:
		allowed = to == CampaignCompleted
	case CampaignCompleted:
		allowed = false
	}
	if !allowed {
		return fmt.Errorf("%w: %s -> %s is forbidden", ErrInvalidCampaignTransition, from, to)
	}
	return nil
}

func transitionCampaign(
	c *Campaign,
	to CampaignState,
	state *DirectorState,
	dirEvents *[]DirectorEvent,
) error {
	if err := ValidateCampaignTransition(c.State, to); err != nil {
		return err
	}
	from := c.State
	c.State = to
	c.PhaseStartedTick = state.Tick
	if to == CampaignCompleted && c.CompletedTick == 0 {
		c.CompletedTick = state.Tick
	}
	ev, err := state.newDirectorEvent(
		DirEventCampaignPhaseChanged,
		c.CampaignID,
		c.RegionID,
		c.SettlementID,
		c.FactionID,
		fmt.Sprintf("%s->%s", from, to),
		0,
		nil,
	)
	if err != nil {
		return err
	}
	*dirEvents = append(*dirEvents, ev)
	return nil
}

func launchFromScheduledEvent(
	dir *DirectorState,
	eco ecosystem.EcosystemState,
	w world.WorldState,
	ev ScheduledEvent,
	cfg Config,
	dirEvents *[]DirectorEvent,
) error {
	// Follow-up / non-invasion events execute deterministically as informational/ecological hooks
	// without spawning duplicate invasions or infinite chains.
	if ev.Kind != EventGoblinRaidCampaign && ev.Kind != EventOrcWarbandCampaign {
		de, err := dir.newDirectorEvent(
			DirEventCampaignPhaseChanged,
			ev.CampaignID,
			ev.RegionID,
			ev.SettlementID,
			ev.FactionID,
			fmt.Sprintf("dispatched:%s:depth=%d", ev.Kind, ev.ChainDepth),
			0,
			nil,
		)
		if err != nil {
			return err
		}
		*dirEvents = append(*dirEvents, de)
		return nil
	}

	// Re-validate settlement protection, camp, hostility, and population right before launch.
	if slices.Contains(cfg.ProtectedRegions, ev.RegionID) || w.SettlementDefenseHP < cfg.MinSimulatedDefenseHP {
		de, err := dir.newDirectorEvent(
			DirEventCampaignCancelled,
			"",
			ev.RegionID,
			ev.SettlementID,
			ev.FactionID,
			"dispatch skipped: protected region or collapsed settlement defense",
			0,
			nil,
		)
		if err != nil {
			return err
		}
		*dirEvents = append(*dirEvents, de)
		return nil
	}

	tpl, ok := LookupPolicy(cfg, ev.TemplateID)
	if !ok {
		return fmt.Errorf("%w: missing policy template %q for scheduled event %q", ErrInvalidState, ev.TemplateID, ev.EventID)
	}
	if !isCampOperational(eco, ev.SourceCampID, ev.SourcePopulationID) || !isFactionHostile(eco, ev.FactionID) {
		de, err := dir.newDirectorEvent(
			DirEventCampaignCancelled,
			"",
			ev.RegionID,
			ev.SettlementID,
			ev.FactionID,
			"dispatch skipped: source camp unavailable or faction non-hostile",
			0,
			nil,
		)
		if err != nil {
			return err
		}
		*dirEvents = append(*dirEvents, de)
		return nil
	}
	if hasInFlightCampaignForRegion(dir.Campaigns, ev.RegionID) ||
		(ev.SettlementID != "" && hasInFlightCampaignForSettlement(dir.Campaigns, ev.SettlementID)) {
		return nil
	}

	if dir.CampaignSeq == math.MaxUint64 {
		return ErrNumericOverflow
	}
	nextSeq := dir.CampaignSeq + 1
	campID := fmt.Sprintf("cmp:%s:%06d", dir.SimulationID, nextSeq)
	if len(campID) > cfg.MaxIdentifierLength {
		campID = fmt.Sprintf("cmp:%06d", nextSeq)
	}
	deadline, err := safeAddUint64(dir.Tick, tpl.DeadlineSlackTicks)
	if err != nil {
		return err
	}

	c := Campaign{
		CampaignID:         campID,
		TemplateID:         tpl.TemplateID,
		EventKind:          tpl.EventKind,
		RegionID:           ev.RegionID,
		SettlementID:       ev.SettlementID,
		FactionID:          ev.FactionID,
		FamilyID:           tpl.Family,
		SourcePopulationID: ev.SourcePopulationID,
		SourceCampID:       ev.SourceCampID,
		ParentEventID:      ev.ParentEventID,
		RulesVersion:       cfg.RulesVersion,
		Priority:           effectivePriority(ev, cfg),
		ThreatScore:        ev.ThreatScore,
		State:              CampaignCandidate,
		TerminalOutcome:    ports.InvasionOutcomeNone,
		CreatedTick:        dir.Tick,
		ScheduledTick:      ev.ScheduledTick,
		PhaseStartedTick:   dir.Tick,
		DeadlineTick:       deadline,
		ChainDepth:         ev.ChainDepth,
	}
	dir.CampaignSeq = nextSeq
	if err := transitionCampaign(&c, CampaignScheduled, dir, dirEvents); err != nil {
		return err
	}
	dir.Campaigns = insertCampaignSorted(dir.Campaigns, c)
	return nil
}

// advanceCampaigns progresses all live campaigns before world.StepWithDirector runs on nextTick,
// issuing validated world.DirectorCommands and reserving/materializing population strictly through
// the idempotent reservation ledger.
func advanceCampaigns(
	dir *DirectorState,
	eco *ecosystem.EcosystemState,
	w *world.WorldState,
	cfg OrchestratedConfig,
	worldCmds *[]world.DirectorCommand,
	dirEvents *[]DirectorEvent,
	ecoEvents *[]ecosystem.EcologicalEvent,
) error {
	nextTick := dir.Tick
	spawnedGroupsThisTick := 0

	// Track whether any campaign already holds the tactical arena slot (Warning/Mobilizing/Active/Resolving).
	tacticalSlotClaimed := w.Invasion.State != world.InvasionPeace
	for _, existing := range dir.Campaigns {
		if existing.State == CampaignWarning || existing.State == CampaignMobilizing ||
			existing.State == CampaignActive || existing.State == CampaignResolving {
			tacticalSlotClaimed = true
			break
		}
	}

	for i := range dir.Campaigns {
		c := &dir.Campaigns[i]
		if c.State == CampaignCompleted {
			continue
		}
		tpl, ok := LookupPolicy(cfg.Director, c.TemplateID)
		if !ok {
			return fmt.Errorf("%w: campaign %q references unknown template %q", ErrInvalidState, c.CampaignID, c.TemplateID)
		}

		// Handle recovering campaigns waiting to archive and reset the resolved arena.
		if c.State == CampaignRecovering {
			readyTick, err := safeAddUint64(c.PhaseStartedTick, tpl.RecoverTicks)
			if err != nil {
				return err
			}
			if nextTick >= readyTick {
				if w.Invasion.State == world.InvasionResolved && w.Invasion.CampaignID == c.CampaignID {
					*worldCmds = append(*worldCmds, world.DirectorCommand{
						Kind: world.CmdDirectorResetResolvedInvasion,
						Tick: nextTick,
					})
				}
				if err := transitionCampaign(c, CampaignCompleted, dir, dirEvents); err != nil {
					return err
				}
				de, err := dir.newDirectorEvent(
					DirEventCampaignCompleted,
					c.CampaignID,
					c.RegionID,
					c.SettlementID,
					c.FactionID,
					string(c.TerminalOutcome),
					0,
					nil,
				)
				if err != nil {
					return err
				}
				*dirEvents = append(*dirEvents, de)
			}
			continue
		}

		// Active and Resolving campaigns are finalized right after world.StepWithDirector.
		if c.State == CampaignActive || c.State == CampaignResolving {
			continue
		}

		// Pre-Active expiration check (deadline exceeded).
		if nextTick > c.DeadlineTick {
			if err := abortPreActiveCampaign(c, CampaignExpired, "deadline exceeded", dir, eco, w, cfg, worldCmds, dirEvents, ecoEvents); err != nil {
				return err
			}
			continue
		}

		// Pre-Active validity check: camp destroyed/abandoned or faction no longer hostile cancels campaign!
		if !isCampOperational(*eco, c.SourceCampID, c.SourcePopulationID) || !isFactionHostile(*eco, c.FactionID) {
			if err := abortPreActiveCampaign(c, CampaignCancelled, "source camp destroyed or faction no longer hostile", dir, eco, w, cfg, worldCmds, dirEvents, ecoEvents); err != nil {
				return err
			}
			continue
		}

		switch c.State {
		case CampaignScheduled:
			reqPop, err := TemplateRequiredContingent(tpl)
			if err != nil {
				return err
			}
			if eco.ReservationSeq == math.MaxUint64 {
				return ErrNumericOverflow
			}
			res, resEv, created, err := ecosystem.CreateSequencedReservation(eco, ecosystem.ReservationRequest{
				CampaignID:  c.CampaignID,
				CampID:      c.SourceCampID,
				Amount:      reqPop,
				CreatedTick: nextTick,
				ExpiryTick:  c.DeadlineTick,
			}, eco.ReservationSeq+1, cfg.Ecosystem)
			if err != nil {
				if errors.Is(err, ecosystem.ErrInsufficientPopulation) || errors.Is(err, ecosystem.ErrCampUnavailable) || errors.Is(err, ecosystem.ErrCapacityExceeded) {
					if abortErr := abortPreActiveCampaign(c, CampaignCancelled, err.Error(), dir, eco, w, cfg, worldCmds, dirEvents, ecoEvents); abortErr != nil {
						return abortErr
					}
					continue
				}
				return err
			}
			if created {
				*ecoEvents = append(*ecoEvents, resEv)
			}
			c.ReservationID = res.ReservationID
			c.ReservedPopulation = res.ReservedAmount

			// Materialize recon squad if tactical group capacity permits.
			if len(w.Groups)+spawnedGroupsThisTick < cfg.World.MaxActiveGroups {
				ticket, matEv, err := ecosystem.MaterializeFromReservation(
					eco,
					c.ReservationID,
					"recon:"+c.CampaignID,
					tpl.ReconArchetype,
					tpl.ReconCount,
					cfg.Ecosystem,
				)
				if err != nil {
					return err
				}
				*ecoEvents = append(*ecoEvents, matEv)

				grpID, err := world.NextDurableGroupID(w, c.CampaignID, "recon", cfg.World.MaxIdentifierLength)
				if err != nil {
					return err
				}
				spawnPos := cfg.World.HostileSpawnDistance
				*worldCmds = append(*worldCmds, world.DirectorCommand{
					Kind:               world.CmdDirectorSpawnCampaignGroup,
					Tick:               nextTick,
					CampaignID:         c.CampaignID,
					InvadingFactionID:  c.FactionID,
					GroupID:            grpID,
					Archetype:          ticket.Archetype,
					Count:              tpl.ReconCount,
					Position:           spawnPos,
					HomePosition:       spawnPos,
					ReservationID:      c.ReservationID,
					SourcePopulationID: ticket.PopulationID,
					SourceCampID:       ticket.CampID,
					SourceRegionID:     ticket.RegionID,
					PopulationWeight:   ticket.ContingentSize,
				})
				spawnedGroupsThisTick++
				c.ReconMobilized = true
			}

			if err := transitionCampaign(c, CampaignReconnaissance, dir, dirEvents); err != nil {
				return err
			}

		case CampaignReconnaissance:
			readyTick, err := safeAddUint64(c.PhaseStartedTick, tpl.ReconTicks)
			if err != nil {
				return err
			}
			if nextTick >= readyTick {
				if err := transitionCampaign(c, CampaignPreparing, dir, dirEvents); err != nil {
					return err
				}
			}

		case CampaignPreparing:
			readyTick, err := safeAddUint64(c.PhaseStartedTick, tpl.PrepTicks)
			if err != nil {
				return err
			}
			// Wait until preparation finishes AND the single active tactical settlement arena is free.
			if nextTick >= readyTick && !tacticalSlotClaimed && w.Invasion.State == world.InvasionPeace {
				if w.SettlementDefenseHP < cfg.Director.MinSimulatedDefenseHP {
					if err := abortPreActiveCampaign(c, CampaignCancelled, "settlement defense below minimum protection floor", dir, eco, w, cfg, worldCmds, dirEvents, ecoEvents); err != nil {
						return err
					}
					continue
				}
				tacticalSlotClaimed = true
				*worldCmds = append(*worldCmds, world.DirectorCommand{
					Kind:              world.CmdDirectorPrepareInvasion,
					Tick:              nextTick,
					CampaignID:        c.CampaignID,
					InvadingFactionID: c.FactionID,
				})
				if err := transitionCampaign(c, CampaignWarning, dir, dirEvents); err != nil {
					return err
				}
				de, err := dir.newDirectorEvent(
					DirEventSettlementWarning,
					c.CampaignID,
					c.RegionID,
					c.SettlementID,
					c.FactionID,
					fmt.Sprintf("warning issued for %s (%s)", c.SettlementID, tpl.TemplateID),
					c.ReservedPopulation,
					nil,
				)
				if err != nil {
					return err
				}
				*dirEvents = append(*dirEvents, de)
			}

		case CampaignWarning:
			readyTick, err := safeAddUint64(c.PhaseStartedTick, tpl.WarningTicks)
			if err != nil {
				return err
			}
			if nextTick >= readyTick {
				mobilized := 0
				for idx, fu := range tpl.MainForces {
					if len(w.Groups)+spawnedGroupsThisTick >= cfg.World.MaxActiveGroups {
						break
					}
					opKey := fmt.Sprintf("main:%s:%d", c.CampaignID, idx)
					ticket, matEv, err := ecosystem.MaterializeFromReservation(
						eco,
						c.ReservationID,
						opKey,
						fu.Archetype,
						fu.Count,
						cfg.Ecosystem,
					)
					if err != nil {
						return err
					}
					*ecoEvents = append(*ecoEvents, matEv)

					grpID, err := world.NextDurableGroupID(w, c.CampaignID, fmt.Sprintf("main%d", idx), cfg.World.MaxIdentifierLength)
					if err != nil {
						return err
					}
					pos := fu.Position
					if pos <= 0 || pos > cfg.World.MaxBattlefieldDistance {
						pos = cfg.World.HostileSpawnDistance
					}
					*worldCmds = append(*worldCmds, world.DirectorCommand{
						Kind:               world.CmdDirectorSpawnCampaignGroup,
						Tick:               nextTick,
						CampaignID:         c.CampaignID,
						InvadingFactionID:  c.FactionID,
						GroupID:            grpID,
						Archetype:          ticket.Archetype,
						Count:              fu.Count,
						Position:           pos,
						HomePosition:       pos,
						ReservationID:      c.ReservationID,
						SourcePopulationID: ticket.PopulationID,
						SourceCampID:       ticket.CampID,
						SourceRegionID:     ticket.RegionID,
						PopulationWeight:   ticket.ContingentSize,
					})
					spawnedGroupsThisTick++
					mobilized++
				}
				if mobilized == 0 && countActiveCampaignGroups(w.Groups, c.CampaignID) == 0 {
					if err := abortPreActiveCampaign(c, CampaignCancelled, "unable to mobilize forces within MaxActiveGroups", dir, eco, w, cfg, worldCmds, dirEvents, ecoEvents); err != nil {
						return err
					}
					continue
				}
				c.MainForcesMobilized = true
				if err := transitionCampaign(c, CampaignMobilizing, dir, dirEvents); err != nil {
					return err
				}
			}

		case CampaignMobilizing:
			if countActiveCampaignGroups(w.Groups, c.CampaignID) == 0 {
				if err := abortPreActiveCampaign(c, CampaignCancelled, "all mobilized forces neutralized before assault start", dir, eco, w, cfg, worldCmds, dirEvents, ecoEvents); err != nil {
					return err
				}
				continue
			}
			*worldCmds = append(*worldCmds, world.DirectorCommand{
				Kind:              world.CmdDirectorStartInvasion,
				Tick:              nextTick,
				CampaignID:        c.CampaignID,
				InvadingFactionID: c.FactionID,
			})
			c.InvasionID = w.Invasion.InvasionID
			if err := transitionCampaign(c, CampaignActive, dir, dirEvents); err != nil {
				return err
			}
			de, err := dir.newDirectorEvent(
				DirEventCampaignStarted,
				c.CampaignID,
				c.RegionID,
				c.SettlementID,
				c.FactionID,
				fmt.Sprintf("invasion=%s", c.InvasionID),
				c.ReservedPopulation,
				nil,
			)
			if err != nil {
				return err
			}
			*dirEvents = append(*dirEvents, de)
		}
	}

	archiveCompletedCampaigns(dir, eco, cfg)
	return nil
}

// abortPreActiveCampaign cleanly cancels or expires a pre-Active campaign, recalling and
// reconciling any already-mobilized groups, releasing unmaterialized reserved population,
// aborting any prepared Threatened invasion state, and transitioning to Completed.
func abortPreActiveCampaign(
	c *Campaign,
	reasonState CampaignState,
	reason string,
	dir *DirectorState,
	eco *ecosystem.EcosystemState,
	w *world.WorldState,
	cfg OrchestratedConfig,
	worldCmds *[]world.DirectorCommand,
	dirEvents *[]DirectorEvent,
	ecoEvents *[]ecosystem.EcologicalEvent,
) error {
	if reasonState != CampaignCancelled && reasonState != CampaignExpired {
		return fmt.Errorf("%w: abort requires Cancelled or Expired state", ErrInvalidCampaignTransition)
	}
	recalled, err := world.RecallCampaignGroups(w, c.CampaignID, cfg.World)
	if err != nil {
		return err
	}
	for _, g := range recalled {
		defeated := g.HP == 0 || g.State == ai.StateDead
		_, ev, err := ecosystem.ReconcileReservationContingent(
			eco,
			g.ReservationID,
			"recall:"+g.GroupID,
			g.PopulationWeight,
			g.HP,
			g.MaxHP,
			defeated,
			cfg.Ecosystem,
		)
		if err != nil {
			return err
		}
		*ecoEvents = append(*ecoEvents, ev)
	}
	if c.ReservationID != "" {
		released, relEv, err := ecosystem.CancelReservation(eco, c.ReservationID, reasonState == CampaignExpired)
		if err != nil {
			return err
		}
		if released > 0 {
			*ecoEvents = append(*ecoEvents, relEv)
		}
	}
	if w.Invasion.State == world.InvasionThreatened && w.Invasion.CampaignID == c.CampaignID {
		*worldCmds = append(*worldCmds, world.DirectorCommand{
			Kind:       world.CmdDirectorAbortPreparedInvasion,
			Tick:       dir.Tick,
			CampaignID: c.CampaignID,
		})
	}
	c.TerminalReason = reason
	if err := transitionCampaign(c, reasonState, dir, dirEvents); err != nil {
		return err
	}
	evType := DirEventCampaignCancelled
	if reasonState == CampaignExpired {
		evType = DirEventCampaignExpired
	}
	de, err := dir.newDirectorEvent(evType, c.CampaignID, c.RegionID, c.SettlementID, c.FactionID, reason, 0, nil)
	if err != nil {
		return err
	}
	*dirEvents = append(*dirEvents, de)

	return transitionCampaign(c, CampaignCompleted, dir, dirEvents)
}

// finalizeResolvedCampaigns detects when the Tactical World Engine resolves an active campaign's
// invasion, reconciles remaining tactical forces, closes reservations, emits the single
// authoritative TerminalSettlementOutcome (even with 0 players!), applies ecological consequences
// and cooldowns, and schedules bounded follow-up events.
func finalizeResolvedCampaigns(
	dir *DirectorState,
	eco *ecosystem.EcosystemState,
	w *world.WorldState,
	wEvents []world.DomainEvent,
	cfg OrchestratedConfig,
	dirEvents *[]DirectorEvent,
	ecoEvents *[]ecosystem.EcologicalEvent,
	outcomes *[]TerminalSettlementOutcome,
) error {
	if w.Invasion.State != world.InvasionResolved || w.Invasion.CampaignID == "" {
		return nil
	}
	idx := findCampaignIndex(dir.Campaigns, w.Invasion.CampaignID)
	if idx < 0 {
		return nil
	}
	c := &dir.Campaigns[idx]
	if c.State != CampaignActive {
		return nil
	}
	tpl, ok := LookupPolicy(cfg.Director, c.TemplateID)
	if !ok {
		return fmt.Errorf("%w: campaign %q unknown template %q", ErrInvalidState, c.CampaignID, c.TemplateID)
	}

	// 1. Recall and reconcile every remaining un-accounted tactical group belonging to this campaign.
	recalled, err := world.RecallCampaignGroups(w, c.CampaignID, cfg.World)
	if err != nil {
		return err
	}
	for _, g := range recalled {
		defeated := g.HP == 0 || g.State == ai.StateDead
		_, ev, err := ecosystem.ReconcileReservationContingent(
			eco,
			g.ReservationID,
			"resolve:"+g.GroupID,
			g.PopulationWeight,
			g.HP,
			g.MaxHP,
			defeated,
			cfg.Ecosystem,
		)
		if err != nil {
			return err
		}
		*ecoEvents = append(*ecoEvents, ev)
	}

	// 2. Finalize reservation, returning any unused reinforcement buffer back to FreePopulation.
	if c.ReservationID != "" {
		released, relEv, err := ecosystem.CompleteReservation(eco, c.ReservationID)
		if err != nil {
			return err
		}
		if released > 0 {
			*ecoEvents = append(*ecoEvents, relEv)
		}
	}

	// 3. Explicit FSM transition: Active -> Resolving -> Defended|Captured.
	if err := transitionCampaign(c, CampaignResolving, dir, dirEvents); err != nil {
		return err
	}
	outcome := w.Invasion.Outcome
	finalBranch := CampaignDefended
	if outcome == ports.InvasionOutcomeCaptured {
		finalBranch = CampaignCaptured
	}
	c.TerminalOutcome = outcome
	c.InvasionID = w.Invasion.InvasionID
	c.CompletedTick = dir.Tick
	if err := transitionCampaign(c, finalBranch, dir, dirEvents); err != nil {
		return err
	}

	// 4. Emit authoritative TerminalSettlementOutcome strictly once — EVEN WITH ZERO PLAYERS.
	if !c.TerminalFactEmitted {
		if len(dir.PendingOutcomes) >= cfg.Director.MaxPendingOutcomes {
			return ErrOutcomeBackpressure
		}
		if dir.OutcomeSeq == math.MaxUint64 {
			return ErrNumericOverflow
		}
		dir.OutcomeSeq++
		eligible := 0
		for _, wev := range wEvents {
			if wev.Type == world.EventContributionRecorded && wev.Contribution != nil && wev.Contribution.Eligible {
				eligible++
			}
		}
		outID := fmt.Sprintf("out:%s:%06d", dir.SimulationID, dir.OutcomeSeq)
		if len(outID) > cfg.Director.MaxIdentifierLength {
			outID = fmt.Sprintf("out:%06d", dir.OutcomeSeq)
		}
		fact := TerminalSettlementOutcome{
			Sequence:             dir.OutcomeSeq,
			EventID:              outID,
			SimulationID:         dir.SimulationID,
			CampaignID:           c.CampaignID,
			InvasionID:           c.InvasionID,
			SettlementID:         c.SettlementID,
			RegionID:             c.RegionID,
			InvadingFactionID:    c.FactionID,
			Outcome:              outcome,
			StartedTick:          w.Invasion.StartedTick,
			CompletedTick:        dir.Tick,
			RulesVersion:         c.RulesVersion,
			EligibleContributors: eligible,
		}
		c.TerminalFactEmitted = true
		dir.PendingOutcomes = append(dir.PendingOutcomes, fact)
		dir.TerminalOutcomes = append(dir.TerminalOutcomes, fact)
		if len(dir.TerminalOutcomes) > cfg.Director.MaxOutcomesHistory {
			dir.TerminalOutcomes = append([]TerminalSettlementOutcome(nil), dir.TerminalOutcomes[len(dir.TerminalOutcomes)-cfg.Director.MaxOutcomesHistory:]...)
		}
		*outcomes = append(*outcomes, fact)
		factCopy := fact
		de, err := dir.newDirectorEvent(
			DirEventSettlementOutcomeRecorded,
			c.CampaignID,
			c.RegionID,
			c.SettlementID,
			c.FactionID,
			fmt.Sprintf("outcome=%s eligible_contributors=%d", outcome, eligible),
			int64(eligible),
			&factCopy,
		)
		if err != nil {
			return err
		}
		*dirEvents = append(*dirEvents, de)

		// 5. Apply ecological consequences, cooldowns, and depth-capped chained follow-up events.
		regCooldownTicks := tpl.RegionCooldownTicks
		setCooldownTicks := tpl.SettlementCooldownTicks
		if cfg.Director.MinInvasionIntervalTicks > setCooldownTicks {
			setCooldownTicks = cfg.Director.MinInvasionIntervalTicks
		}
		regReady, err := safeAddUint64(dir.Tick, regCooldownTicks)
		if err != nil {
			return err
		}
		setReady, err := safeAddUint64(dir.Tick, setCooldownTicks)
		if err != nil {
			return err
		}
		if err := setCooldown(&dir.RegionCooldowns, c.RegionID, regReady, cfg.Director.MaxCooldownEntries); err != nil {
			return err
		}
		if err := setCooldown(&dir.SettlementCooldowns, c.SettlementID, setReady, cfg.Director.MaxCooldownEntries); err != nil {
			return err
		}

		// Ecological aftermath on source region.
		for rIdx := range eco.Regions {
			if eco.Regions[rIdx].RegionID == c.RegionID {
				if outcome == ports.InvasionOutcomeDefended {
					if eco.Regions[rIdx].RecentConflictScore > 250 {
						eco.Regions[rIdx].RecentConflictScore -= 250
					} else {
						eco.Regions[rIdx].RecentConflictScore = 0
					}
				} else {
					room := max(0, cfg.Ecosystem.MaxRegionalThreat-eco.Regions[rIdx].RecentConflictScore)
					eco.Regions[rIdx].RecentConflictScore += min(int64(150), room)
				}
				break
			}
		}

		// Bounded depth-capped chained follow-up (never triggers an immediate second invasion).
		if c.ChainDepth < cfg.Director.MaxChainDepth {
			followKind := EventRecoveryFollowup
			followDelay := tpl.RecoverTicks
			if outcome == ports.InvasionOutcomeCaptured {
				followKind = EventReconquestIntent
				followDelay = setCooldownTicks
			}
			schedTick, err := safeAddUint64(dir.Tick, followDelay)
			if err != nil {
				return err
			}
			deadTick, err := safeAddUint64(schedTick, 40)
			if err != nil {
				return err
			}
			followEv, err := EnqueueScheduledEvent(dir, ScheduledEvent{
				CampaignID:    c.CampaignID,
				Kind:          followKind,
				Category:      CategoryCreature,
				RegionID:      c.RegionID,
				SettlementID:  c.SettlementID,
				FactionID:     c.FactionID,
				Priority:      100,
				CreatedTick:   dir.Tick,
				ScheduledTick: schedTick,
				DeadlineTick:  deadTick,
				ParentEventID: fact.EventID,
				ChainDepth:    c.ChainDepth + 1,
			}, cfg.Director)
			if err != nil {
				return err
			}
			ce, err := dir.newDirectorEvent(
				DirEventChainedEventScheduled,
				c.CampaignID,
				c.RegionID,
				c.SettlementID,
				c.FactionID,
				fmt.Sprintf("chained=%s id=%s depth=%d", followKind, followEv.EventID, followEv.ChainDepth),
				0,
				nil,
			)
			if err != nil {
				return err
			}
			*dirEvents = append(*dirEvents, ce)
		}
	}

	// 6. Enter explicit Recovering phase.
	return transitionCampaign(c, CampaignRecovering, dir, dirEvents)
}

func archiveCompletedCampaigns(dir *DirectorState, eco *ecosystem.EcosystemState, cfg OrchestratedConfig) {
	if len(dir.Campaigns) == 0 {
		return
	}
	kept := make([]Campaign, 0, len(dir.Campaigns))
	archivedAny := false
	for _, c := range dir.Campaigns {
		if c.State == CampaignCompleted {
			summary := CampaignSummary{
				CampaignID:      c.CampaignID,
				TemplateID:      c.TemplateID,
				RegionID:        c.RegionID,
				SettlementID:    c.SettlementID,
				FactionID:       c.FactionID,
				FinalState:      CampaignCompleted,
				TerminalOutcome: c.TerminalOutcome,
				CompletedTick:   c.CompletedTick,
			}
			dir.CompletedHistory = append(dir.CompletedHistory, summary)
			if len(dir.CompletedHistory) > cfg.Director.MaxCompletedHistory {
				dir.CompletedHistory = append([]CampaignSummary(nil), dir.CompletedHistory[len(dir.CompletedHistory)-cfg.Director.MaxCompletedHistory:]...)
			}
			archivedAny = true
			continue
		}
		kept = append(kept, c)
	}
	dir.Campaigns = kept
	if archivedAny {
		// Diagnostic retention must not consume the slots needed by active
		// campaigns, especially under intentionally small capacities.
		retainClosed := min(8, max(0, cfg.Ecosystem.MaxReservations-cfg.Director.MaxActiveCampaignsGlobal))
		protected := make([]string, 0, len(dir.Campaigns))
		for _, campaign := range dir.Campaigns {
			if campaign.ReservationID != "" {
				protected = append(protected, campaign.ReservationID)
			}
		}
		ecosystem.PruneClosedReservationsExcept(eco, retainClosed, cfg.Ecosystem.MaxRetiredReservationKeys, protected)
	}
}

func isCampOperational(eco ecosystem.EcosystemState, campID, popID string) bool {
	for _, c := range eco.Camps {
		if c.CampID == campID && c.PopulationID == popID {
			return c.State.CanSupplyMaterialization()
		}
	}
	return false
}

func isFactionHostile(eco ecosystem.EcosystemState, factionID string) bool {
	for _, f := range eco.Factions {
		if f.FactionID == factionID {
			return f.HostileToSettlement
		}
	}
	return false
}

func countActiveCampaignGroups(groups []world.CreatureGroup, campaignID string) int {
	n := 0
	for _, g := range groups {
		if g.CampaignID == campaignID && g.HP > 0 && g.State != ai.StateDead && !g.Routed {
			n++
		}
	}
	return n
}
