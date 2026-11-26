package world

import (
	"fmt"
	"math"
	"slices"
	"strings"

	"ascendra-game/internal/ai"
	"ascendra-game/internal/ports"
	"ascendra-game/internal/simulation"
)

type reinforcementRequest struct {
	callerIndex int
	callerID    string
	archetype   string
	count       int64
	homePos     int64
	cooldown    int64
}

// NewWorldState initializes a deterministic WorldState by querying the minimal
// SettlementSnapshot from CARBON via ports.SettlementReader.
func NewWorldState(simulationID, settlementID string, seed uint64, reader ports.SettlementReader) (WorldState, error) {
	if strings.TrimSpace(simulationID) == "" {
		return WorldState{}, fmt.Errorf("%w: empty simulation_id", ErrInvalidState)
	}
	if reader == nil {
		return WorldState{}, fmt.Errorf("%w: nil settlement reader", ErrInvalidState)
	}
	snap, err := reader.GetSettlementSnapshot(settlementID)
	if err != nil {
		return WorldState{}, err
	}
	if err := snap.Validate(); err != nil {
		return WorldState{}, err
	}

	state := WorldState{
		SimulationID:           simulationID,
		Tick:                   0,
		RNG:                    simulation.NewDeterministicRNG(seed),
		SettlementID:           snap.SettlementID,
		RegionID:               snap.RegionID,
		SettlementDefenseHP:    snap.MaxDefenseHP,
		SettlementMaxDefenseHP: snap.MaxDefenseHP,
		InitialDefenseState:    snap.DefenseState,
		RegionalThreat:         0,
		Invasion: InvasionRecord{
			InvasionID:          fmt.Sprintf("%s-inv-1", simulationID),
			Sequence:            1,
			State:               InvasionPeace,
			Outcome:             ports.InvasionOutcomeNone,
			ObjectivesCompleted: []string{},
		},
		Groups:          []CreatureGroup{},
		Defenders:       []DefenderEntity{},
		PlayerCooldowns: []PlayerCooldown{},
		Contributions:   []PlayerContribution{},
		EventSeq:        0,
	}
	if err := state.Validate(); err != nil {
		return WorldState{}, err
	}
	return state, nil
}

// Step advances the authoritative headless world simulation by exactly one logical tick.
// It is pure, deterministic, I/O-free, wall-clock-free, and atomic: if any command or
// invariant fails, the caller's input state remains untouched.
func Step(state WorldState, commands []Command, cfg Config) (WorldState, []DomainEvent, error) {
	if err := cfg.Validate(); err != nil {
		return WorldState{}, nil, err
	}
	if err := state.Validate(); err != nil {
		return WorldState{}, nil, err
	}
	if len(state.Groups) > cfg.MaxActiveGroups || len(state.Defenders) > cfg.MaxDefenders ||
		len(state.Invasion.ObjectivesCompleted) > cfg.MaxObjectives || len(state.Contributions) > cfg.MaxContributions ||
		state.Invasion.ReinforcementWaves > cfg.MaxReinforcementWaves {
		return WorldState{}, nil, ErrCapacityExceeded
	}
	if state.Tick == math.MaxUint64 {
		return WorldState{}, nil, ErrNumericOverflow
	}

	next := state.Clone()
	next.Tick++
	events := make([]DomainEvent, 0, len(commands)+8)
	threatIncreasedThisTick := false

	// 1. Validate command ticks and apply commands in canonical deterministic order.
	orderedCommands := CanonicalizeCommands(commands)
	for _, cmd := range orderedCommands {
		if cmd.Tick != next.Tick {
			return WorldState{}, nil, fmt.Errorf("%w: command tick=%d, expected=%d", ErrCommandTickMismatch, cmd.Tick, next.Tick)
		}
		switch cmd.Kind {
		case CmdDeployDefender:
			if err := applyDeployDefender(&next, cmd, cfg); err != nil {
				return WorldState{}, nil, err
			}

		case CmdIncreaseThreat:
			if cmd.Delta <= 0 {
				return WorldState{}, nil, fmt.Errorf("%w: threat delta must be > 0, got %d", ErrInvalidCommand, cmd.Delta)
			}
			sum, err := safeAddInt64(next.RegionalThreat, cmd.Delta)
			if err != nil {
				return WorldState{}, nil, err
			}
			if sum > cfg.MaxThreat {
				sum = cfg.MaxThreat
			}
			if sum != next.RegionalThreat {
				deltaApplied := sum - next.RegionalThreat
				next.RegionalThreat = sum
				threatIncreasedThisTick = true
				source := cmd.Source
				if strings.TrimSpace(source) == "" {
					source = next.RegionID
				}
				events = append(events, next.newEvent(EventThreatChanged, source, "", deltaApplied, nil))
			}

		case CmdSpawnHostileGroup:
			if err := applySpawnHostileGroup(&next, cmd, cfg, &events); err != nil {
				return WorldState{}, nil, err
			}

		case CmdForceInvasionTransition:
			if err := transitionInvasion(&next, cmd.TargetState, cfg, &events); err != nil {
				return WorldState{}, nil, err
			}

		case CmdPlayerDefendStrike:
			if err := applyPlayerDefendStrike(&next, cmd, cfg, &events); err != nil {
				return WorldState{}, nil, err
			}

		case CmdPlayerSupportDefense:
			if err := applyPlayerSupportDefense(&next, cmd, cfg); err != nil {
				return WorldState{}, nil, err
			}

		case CmdCompleteObjective:
			if err := applyCompleteObjective(&next, cmd, cfg); err != nil {
				return WorldState{}, nil, err
			}

		default:
			return WorldState{}, nil, fmt.Errorf("%w: unknown command kind %q", ErrInvalidCommand, cmd.Kind)
		}
	}

	// 2. World Director threshold-driven invasion progression.
	if next.Invasion.State == InvasionPeace && next.RegionalThreat >= cfg.ThreatThreshold {
		if err := transitionInvasion(&next, InvasionThreatened, cfg, &events); err != nil {
			return WorldState{}, nil, err
		}
	}
	if next.Invasion.State == InvasionThreatened && next.RegionalThreat >= cfg.InvasionThreshold {
		if err := transitionInvasion(&next, InvasionUnderAttack, cfg, &events); err != nil {
			return WorldState{}, nil, err
		}
	}

	// 3. Cycle 02 Creature AI Engine: perception, collective coordination, morale,
	// territoriality, target selection, and bounded reinforcement requests.
	invasionActive := next.Invasion.State == InvasionUnderAttack
	if len(next.Groups) > 0 {
		perceivedTargets := buildPerceivedTargets(&next)
		snapshots := make([]ai.GroupSnapshot, len(next.Groups))
		profiles := make([]ai.Profile, len(next.Groups))

		for i, g := range next.Groups {
			prof, err := ai.LookupProfile(g.Archetype)
			if err != nil {
				return WorldState{}, nil, err
			}
			profiles[i] = prof
			snapshots[i] = ai.GroupSnapshot{
				GroupID:      g.GroupID,
				Profile:      prof,
				State:        g.State,
				Position:     g.DistanceToSettlement,
				HomePosition: g.HomePosition,
				HP:           g.HP,
				MaxHP:        g.MaxHP,
				MoraleBP:     g.MoraleBP,
				Routed:       g.Routed,
			}
		}

		orders, err := ai.Coordinate(snapshots, perceivedTargets, invasionActive)
		if err != nil {
			return WorldState{}, nil, err
		}

		pendingReinforcements := make([]reinforcementRequest, 0, 2)

		for i := range next.Groups {
			g := &next.Groups[i]
			if g.HP == 0 || g.State == ai.StateDead || g.Routed {
				g.RecentDamageTaken = 0
				continue
			}
			if g.AttackCooldownTicks > 0 {
				g.AttackCooldownTicks--
			}
			if g.ReinforceCooldownTicks > 0 {
				g.ReinforceCooldownTicks--
			}

			prof := profiles[i]
			prevState := g.State
			remainingCalls := g.MaxReinforcementCalls - g.ReinforcementsCalled
			if remainingCalls < 0 {
				remainingCalls = 0
			}

			perception := ai.Perception{
				Tick:                        next.Tick,
				GroupID:                     g.GroupID,
				CurrentState:                g.State,
				HP:                          g.HP,
				MaxHP:                       g.MaxHP,
				DistanceToSettlement:        g.DistanceToSettlement,
				AttackCooldownTicks:         g.AttackCooldownTicks,
				InvasionActive:              invasionActive,
				SettlementAlive:             next.SettlementDefenseHP > 0,
				Profile:                     prof,
				HomePosition:                g.HomePosition,
				MoraleBP:                    g.MoraleBP,
				RecentDamageTaken:           g.RecentDamageTaken,
				ReinforceCooldownTicks:      g.ReinforceCooldownTicks,
				RemainingReinforcementCalls: remainingCalls,
				Targets:                     perceivedTargets,
				Order:                       orders[i],
			}
			decision, err := ai.Evaluate(perception, &next.RNG)
			if err != nil {
				return WorldState{}, nil, err
			}

			// Reset per-tick damage shock after AI consumes it.
			g.RecentDamageTaken = 0
			g.State = decision.NextState
			g.MoraleBP = decision.NewMoraleBP

			if prevState != decision.NextState && (decision.NextState == ai.StateRetreat || decision.NextState == ai.StateRally) {
				events = append(events, next.newEvent(
					EventMoraleChanged,
					g.GroupID,
					fmt.Sprintf("%s->%s", prevState, decision.NextState),
					g.MoraleBP,
					nil,
				))
			}

			if decision.TerritoryTriggered && prevState != decision.NextState {
				events = append(events, next.newEvent(
					EventTerritoryAlert,
					g.GroupID,
					fmt.Sprintf("%s->%s", prevState, decision.NextState),
					g.DistanceToSettlement,
					nil,
				))
			}

			if decision.TargetID != "" && decision.TargetID != g.CurrentTargetID {
				g.CurrentTargetID = decision.TargetID
				events = append(events, next.newEvent(
					EventTargetAcquired,
					g.GroupID,
					decision.TargetID,
					0,
					nil,
				))
			}
			if decision.TargetID == "" {
				g.CurrentTargetID = ""
			}

			if decision.MoveDelta != 0 {
				moved, err := safeAddInt64(g.DistanceToSettlement, decision.MoveDelta)
				if err != nil {
					return WorldState{}, nil, err
				}
				if moved < 0 {
					moved = 0
				}
				if moved > cfg.MaxBattlefieldDistance {
					moved = cfg.MaxBattlefieldDistance
				}
				g.DistanceToSettlement = moved
			}

			if decision.RequestReinforcements {
				pendingReinforcements = append(pendingReinforcements, reinforcementRequest{
					callerIndex: i,
					callerID:    g.GroupID,
					archetype:   decision.ReinforcementArchetype,
					count:       decision.ReinforcementCount,
					homePos:     g.HomePosition,
					cooldown:    prof.ReinforceCooldownTicks,
				})
			}

			if g.State == ai.StateRetreat && g.DistanceToSettlement >= cfg.HostileRetreatExitDistance {
				g.Routed = true
				events = append(events, next.newEvent(EventCreaturePopulationChanged, g.GroupID, "Retreat->Routed", -1, nil))
				continue
			}

			if decision.Action == ai.ActionStrikeSettlement && invasionActive && next.SettlementDefenseHP > 0 {
				dmg, err := rollHostileDamage(prof.BaseDamage, cfg.HostileDamageVariance, &next.RNG)
				if err != nil {
					return WorldState{}, nil, err
				}
				if dmg > next.SettlementDefenseHP {
					next.SettlementDefenseHP = 0
				} else {
					next.SettlementDefenseHP -= dmg
				}
				g.AttackCooldownTicks = prof.AttackCooldownTicks
			} else if decision.Action == ai.ActionStrikeTarget && decision.TargetKind == ai.TargetDefender {
				if defIdx := findDefenderIndex(next.Defenders, decision.TargetID); defIdx >= 0 && next.Defenders[defIdx].HP > 0 {
					dmg, err := rollHostileDamage(prof.BaseDamage, cfg.HostileDamageVariance, &next.RNG)
					if err != nil {
						return WorldState{}, nil, err
					}
					if dmg > next.Defenders[defIdx].HP {
						next.Defenders[defIdx].HP = 0
					} else {
						next.Defenders[defIdx].HP -= dmg
					}
					g.AttackCooldownTicks = prof.AttackCooldownTicks
				}
			}
		}

		// Spawn bounded reinforcement waves deterministically after all groups are evaluated.
		for _, req := range pendingReinforcements {
			if next.Invasion.ReinforcementWaves >= cfg.MaxReinforcementWaves || len(next.Groups) >= cfg.MaxActiveGroups {
				break
			}
			callerIdx := findGroupIndex(next.Groups, req.callerID)
			if callerIdx < 0 || next.Groups[callerIdx].Routed || next.Groups[callerIdx].HP == 0 {
				continue
			}
			next.Invasion.ReinforcementWaves++
			next.Groups[callerIdx].ReinforcementsCalled++
			next.Groups[callerIdx].ReinforceCooldownTicks = req.cooldown

			reinfID := fmt.Sprintf("group-reinf-%d-%s", next.Invasion.ReinforcementWaves, req.callerID)
			spawnCmd := Command{
				Kind:         CmdSpawnHostileGroup,
				Tick:         next.Tick,
				GroupID:      reinfID,
				Archetype:    req.archetype,
				Count:        req.count,
				HomePosition: req.homePos,
				Position:     req.homePos,
			}
			if err := applySpawnHostileGroup(&next, spawnCmd, cfg, &events); err != nil {
				return WorldState{}, nil, err
			}
			events = append(events, next.newEvent(EventReinforcementsCalled, req.callerID, reinfID, req.count, nil))
		}
	}

	// 4. Passive threat decay on deployed defenders.
	if cfg.DefenderThreatDecayPerTick > 0 {
		for i := range next.Defenders {
			if next.Defenders[i].ThreatScore > 0 {
				if cfg.DefenderThreatDecayPerTick >= next.Defenders[i].ThreatScore {
					next.Defenders[i].ThreatScore = 0
				} else {
					next.Defenders[i].ThreatScore -= cfg.DefenderThreatDecayPerTick
				}
			}
		}
	}

	// 5. Authoritative invasion resolution check (Defended or Captured).
	if next.Invasion.State == InvasionUnderAttack {
		if next.SettlementDefenseHP == 0 {
			if err := resolveInvasion(&next, ports.InvasionOutcomeCaptured, cfg, &events); err != nil {
				return WorldState{}, nil, err
			}
		} else {
			timedOut := next.Tick >= next.Invasion.StartedTick &&
				(next.Tick-next.Invasion.StartedTick) >= cfg.InvasionMaxDurationTicks
			allNeutralized := len(next.Groups) > 0 && countActiveHostiles(next.Groups) == 0
			if allNeutralized || timedOut {
				if err := resolveInvasion(&next, ports.InvasionOutcomeDefended, cfg, &events); err != nil {
					return WorldState{}, nil, err
				}
			}
		}
	}

	// 6. Passive regional threat decay outside active battle when threat was not actively escalated.
	if !threatIncreasedThisTick && cfg.ThreatDecayPerTick > 0 &&
		(next.Invasion.State == InvasionPeace || next.Invasion.State == InvasionThreatened) &&
		next.RegionalThreat > 0 {
		decay := cfg.ThreatDecayPerTick
		if decay > next.RegionalThreat {
			decay = next.RegionalThreat
		}
		next.RegionalThreat -= decay
		events = append(events, next.newEvent(EventThreatChanged, next.RegionID, "", -decay, nil))
		if next.Invasion.State == InvasionThreatened && next.RegionalThreat == 0 && countActiveHostiles(next.Groups) == 0 {
			if err := transitionInvasion(&next, InvasionPeace, cfg, &events); err != nil {
				return WorldState{}, nil, err
			}
		}
	}

	if next.EventSeq < state.EventSeq {
		return WorldState{}, nil, ErrNumericOverflow
	}
	if err := next.Validate(); err != nil {
		return WorldState{}, nil, err
	}
	return next, events, nil
}

// DispatchContributions forwards ContributionRecorded domain events to CARBON's
// ContributionSink boundary port without embedding I/O inside Step().
func DispatchContributions(events []DomainEvent, sink ports.ContributionSink) (int, error) {
	if sink == nil {
		return 0, nil
	}
	dispatched := 0
	for _, ev := range events {
		if ev.Type != EventContributionRecorded || ev.Contribution == nil {
			continue
		}
		if err := sink.RecordContribution(*ev.Contribution); err != nil {
			return dispatched, err
		}
		dispatched++
	}
	return dispatched, nil
}

func rollHostileDamage(baseDamage, variance int64, rng *simulation.DeterministicRNG) (int64, error) {
	dmg := baseDamage
	if variance > 0 {
		bonus := rng.Int64N(variance + 1)
		var err error
		dmg, err = safeAddInt64(dmg, bonus)
		if err != nil {
			return 0, err
		}
	}
	return dmg, nil
}

func buildPerceivedTargets(state *WorldState) []ai.PerceivedTarget {
	targets := make([]ai.PerceivedTarget, 0, len(state.Defenders)+1)
	for _, d := range state.Defenders {
		if d.HP <= 0 {
			continue
		}
		targets = append(targets, ai.PerceivedTarget{
			TargetID:    d.PlayerID,
			Kind:        ai.TargetDefender,
			Position:    d.Position,
			HP:          d.HP,
			MaxHP:       d.MaxHP,
			ThreatScore: d.ThreatScore,
		})
	}
	if state.SettlementDefenseHP > 0 {
		targets = append(targets, ai.PerceivedTarget{
			TargetID:    state.SettlementID,
			Kind:        ai.TargetSettlement,
			Position:    0,
			HP:          state.SettlementDefenseHP,
			MaxHP:       state.SettlementMaxDefenseHP,
			ThreatScore: 0,
		})
	}
	return targets
}

func (s *WorldState) newEvent(evType EventType, sourceEntityID, transition string, amount int64, contrib *ports.ContributionResult) DomainEvent {
	s.EventSeq++
	eventID := fmt.Sprintf("sim:%s:tick:%d:seq:%d:%s", s.SimulationID, s.Tick, s.EventSeq, evType)
	if contrib != nil && contrib.EventID != "" {
		eventID = contrib.EventID
	}
	return DomainEvent{
		EventID:         eventID,
		SimulationID:    s.SimulationID,
		Tick:            s.Tick,
		Type:            evType,
		SourceEntityID:  sourceEntityID,
		StateTransition: transition,
		Amount:          amount,
		Contribution:    contrib,
	}
}

func transitionInvasion(next *WorldState, target InvasionState, cfg Config, events *[]DomainEvent) error {
	from := next.Invasion.State
	if err := ValidateTransition(from, target); err != nil {
		return err
	}
	if target == InvasionResolved {
		outcome := ports.InvasionOutcomeDefended
		if next.SettlementDefenseHP == 0 {
			outcome = ports.InvasionOutcomeCaptured
		}
		return resolveInvasion(next, outcome, cfg, events)
	}

	next.Invasion.State = target
	transitionLabel := fmt.Sprintf("%s->%s", from, target)
	*events = append(*events, next.newEvent(EventInvasionPhaseChanged, next.Invasion.InvasionID, transitionLabel, 0, nil))

	switch target {
	case InvasionThreatened:
		*events = append(*events, next.newEvent(EventInvasionPrepared, next.SettlementID, transitionLabel, next.RegionalThreat, nil))
	case InvasionUnderAttack:
		next.Invasion.StartedTick = next.Tick
		// Ensure at least one hostile vanguard group exists when an invasion starts.
		if countActiveHostiles(next.Groups) == 0 {
			spawnCmd := Command{
				Kind:      CmdSpawnHostileGroup,
				Tick:      next.Tick,
				GroupID:   fmt.Sprintf("group-vanguard-%d", next.Invasion.Sequence),
				Archetype: "goblin-raider-pack",
				Count:     1,
			}
			if err := applySpawnHostileGroup(next, spawnCmd, cfg, events); err != nil {
				return err
			}
		}
		*events = append(*events, next.newEvent(EventInvasionStarted, next.SettlementID, transitionLabel, next.RegionalThreat, nil))
	}
	return nil
}

func resolveInvasion(next *WorldState, outcome ports.InvasionOutcome, cfg Config, events *[]DomainEvent) error {
	from := next.Invasion.State
	if err := ValidateTransition(from, InvasionResolved); err != nil {
		return err
	}
	if !outcome.ValidTerminal() {
		return fmt.Errorf("%w: non-terminal outcome %q", ErrInvalidState, outcome)
	}

	next.Invasion.State = InvasionResolved
	next.Invasion.Outcome = outcome
	next.Invasion.ResolvedTick = next.Tick
	transitionLabel := fmt.Sprintf("%s->%s", from, InvasionResolved)
	*events = append(*events, next.newEvent(EventInvasionPhaseChanged, next.Invasion.InvasionID, transitionLabel, 0, nil))

	if outcome == ports.InvasionOutcomeDefended {
		*events = append(*events, next.newEvent(EventSettlementDefended, next.SettlementID, transitionLabel, next.SettlementDefenseHP, nil))
	} else {
		*events = append(*events, next.newEvent(EventSettlementCaptured, next.SettlementID, transitionLabel, 0, nil))
	}

	// Emit validated ContributionResult records strictly once per invasion instance.
	if !next.Invasion.ContributionsEmitted {
		for _, c := range next.Contributions {
			var scoreObj int64
			if c.Objectives > 0 {
				var err error
				scoreObj, err = safeMulPositiveInt64(c.Objectives, 100)
				if err != nil {
					return err
				}
			}
			score, err := safeAddInt64(c.Damage, c.Support)
			if err != nil {
				return err
			}
			score, err = safeAddInt64(score, scoreObj)
			if err != nil {
				return err
			}
			result := ports.ContributionResult{
				EventID:      fmt.Sprintf("sim:%s:inv:%s:contrib:%s", next.SimulationID, next.Invasion.InvasionID, c.PlayerID),
				SimulationID: next.SimulationID,
				InvasionID:   next.Invasion.InvasionID,
				SettlementID: next.SettlementID,
				Tick:         next.Tick,
				PlayerID:     c.PlayerID,
				Damage:       c.Damage,
				Support:      c.Support,
				Objectives:   c.Objectives,
				Eligible:     score >= cfg.EligibilityMinScore,
				Outcome:      outcome,
			}
			if err := result.Validate(); err != nil {
				return err
			}
			resultCopy := result
			*events = append(*events, next.newEvent(EventContributionRecorded, c.PlayerID, "", score, &resultCopy))
		}
		next.Invasion.ContributionsEmitted = true
	}

	return nil
}

func applyDeployDefender(next *WorldState, cmd Command, cfg Config) error {
	if strings.TrimSpace(cmd.PlayerID) == "" {
		return fmt.Errorf("%w: player_id is required to deploy defender", ErrInvalidCommand)
	}
	if cmd.Position < 0 || cmd.Position > cfg.MaxBattlefieldDistance {
		return fmt.Errorf("%w: defender position %d out of [0, %d]", ErrInvalidCommand, cmd.Position, cfg.MaxBattlefieldDistance)
	}
	idx := findDefenderIndex(next.Defenders, cmd.PlayerID)
	if idx >= 0 {
		if next.Defenders[idx].HP == 0 {
			return fmt.Errorf("%w: defender %q is defeated and cannot reposition", ErrDeadEntity, cmd.PlayerID)
		}
		next.Defenders[idx].Position = cmd.Position
		return nil
	}
	if len(next.Defenders) >= cfg.MaxDefenders {
		return fmt.Errorf("%w: max defenders %d reached", ErrCapacityExceeded, cfg.MaxDefenders)
	}
	insertIdx, _ := slices.BinarySearchFunc(next.Defenders, cmd.PlayerID, func(d DefenderEntity, id string) int {
		return strings.Compare(d.PlayerID, id)
	})
	next.Defenders = slices.Insert(next.Defenders, insertIdx, DefenderEntity{
		PlayerID:    cmd.PlayerID,
		HP:          cfg.DefenderBaseHP,
		MaxHP:       cfg.DefenderBaseHP,
		Position:    cmd.Position,
		ThreatScore: 0,
	})
	return nil
}

func applySpawnHostileGroup(next *WorldState, cmd Command, cfg Config, events *[]DomainEvent) error {
	if strings.TrimSpace(cmd.GroupID) == "" || strings.TrimSpace(cmd.Archetype) == "" {
		return fmt.Errorf("%w: group_id and archetype are required", ErrInvalidCommand)
	}
	if cmd.Count <= 0 {
		return fmt.Errorf("%w: hostile count must be > 0, got %d", ErrInvalidCommand, cmd.Count)
	}
	if len(next.Groups) >= cfg.MaxActiveGroups {
		return fmt.Errorf("%w: max active groups %d reached", ErrCapacityExceeded, cfg.MaxActiveGroups)
	}
	if findGroupIndex(next.Groups, cmd.GroupID) >= 0 {
		return fmt.Errorf("%w: duplicate group_id %q", ErrInvalidCommand, cmd.GroupID)
	}
	prof, err := ai.LookupProfile(cmd.Archetype)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidCommand, err)
	}
	maxHP, err := safeMulPositiveInt64(prof.BaseHP, cmd.Count)
	if err != nil {
		return err
	}

	homePos := cfg.HostileSpawnDistance
	if cmd.HomePosition != 0 {
		if cmd.HomePosition < 0 || cmd.HomePosition > cfg.MaxBattlefieldDistance {
			return fmt.Errorf("%w: home_position %d out of [0, %d]", ErrInvalidCommand, cmd.HomePosition, cfg.MaxBattlefieldDistance)
		}
		homePos = cmd.HomePosition
	}
	spawnPos := homePos
	if cmd.Position != 0 {
		if cmd.Position < 0 || cmd.Position > cfg.MaxBattlefieldDistance {
			return fmt.Errorf("%w: position %d out of [0, %d]", ErrInvalidCommand, cmd.Position, cfg.MaxBattlefieldDistance)
		}
		spawnPos = cmd.Position
	}

	group := CreatureGroup{
		GroupID:                cmd.GroupID,
		Archetype:              prof.Archetype,
		Family:                 prof.Family,
		Role:                   prof.Role,
		State:                  ai.StateIdle,
		HP:                     maxHP,
		MaxHP:                  maxHP,
		MoraleBP:               prof.InitialMoraleBP,
		HomePosition:           homePos,
		DistanceToSettlement:   spawnPos,
		AttackCooldownTicks:    0,
		ReinforceCooldownTicks: 0,
		ReinforcementsCalled:   0,
		MaxReinforcementCalls:  prof.MaxReinforcementCalls,
		RecentDamageTaken:      0,
		Routed:                 false,
	}
	next.Groups = insertGroupSorted(next.Groups, group)
	*events = append(*events, next.newEvent(EventCreaturePopulationChanged, group.GroupID, "Spawned", cmd.Count, nil))
	return nil
}

func applyPlayerDefendStrike(next *WorldState, cmd Command, cfg Config, events *[]DomainEvent) error {
	if next.Invasion.State != InvasionUnderAttack {
		return fmt.Errorf("%w: cannot defend strike during state %s", ErrInvasionNotActive, next.Invasion.State)
	}
	if strings.TrimSpace(cmd.PlayerID) == "" || strings.TrimSpace(cmd.TargetGroupID) == "" {
		return fmt.Errorf("%w: player_id and target_group_id are required", ErrInvalidCommand)
	}
	if defIdx := findDefenderIndex(next.Defenders, cmd.PlayerID); defIdx >= 0 && next.Defenders[defIdx].HP == 0 {
		return fmt.Errorf("%w: defender %q is defeated", ErrDeadEntity, cmd.PlayerID)
	}
	if err := checkAndSetPlayerCooldown(next, cmd.PlayerID, cfg.PlayerAttackCooldown); err != nil {
		return err
	}

	idx := findGroupIndex(next.Groups, cmd.TargetGroupID)
	if idx < 0 {
		return fmt.Errorf("%w: group %q", ErrUnknownEntity, cmd.TargetGroupID)
	}
	target := &next.Groups[idx]
	if target.HP == 0 || target.State == ai.StateDead || target.Routed {
		return fmt.Errorf("%w: group %q cannot be targeted", ErrDeadEntity, target.GroupID)
	}

	// Authoritative damage calculation (never trusted from client input).
	dmg := cfg.PlayerStrikeBaseDamage
	if cfg.PlayerDamageVariance > 0 {
		bonus := next.RNG.Int64N(cfg.PlayerDamageVariance + 1)
		var err error
		dmg, err = safeAddInt64(dmg, bonus)
		if err != nil {
			return err
		}
	}
	if dmg > target.HP {
		dmg = target.HP
	}
	target.HP -= dmg
	var err error
	target.RecentDamageTaken, err = safeAddInt64(target.RecentDamageTaken, dmg)
	if err != nil {
		return err
	}
	if target.HP == 0 {
		target.State = ai.StateDead
		target.MoraleBP = 0
		*events = append(*events, next.newEvent(EventCreaturePopulationChanged, target.GroupID, "Defeated", -1, nil))
	}

	// Raise authoritative threat on deployed defender so orc/goblin AI perceives aggro.
	if defIdx := findDefenderIndex(next.Defenders, cmd.PlayerID); defIdx >= 0 && next.Defenders[defIdx].HP > 0 {
		nextThreat, err := safeAddInt64(next.Defenders[defIdx].ThreatScore, cfg.DefenderStrikeThreatGain)
		if err != nil {
			return err
		}
		if nextThreat > 10000 {
			nextThreat = 10000
		}
		next.Defenders[defIdx].ThreatScore = nextThreat
	}

	return addContribution(next, cmd.PlayerID, dmg, 0, 0, cfg)
}

func applyPlayerSupportDefense(next *WorldState, cmd Command, cfg Config) error {
	if next.Invasion.State != InvasionUnderAttack {
		return fmt.Errorf("%w: cannot support defense during state %s", ErrInvasionNotActive, next.Invasion.State)
	}
	if strings.TrimSpace(cmd.PlayerID) == "" {
		return fmt.Errorf("%w: player_id is required", ErrInvalidCommand)
	}
	if next.SettlementDefenseHP == 0 {
		return fmt.Errorf("%w: settlement defense already destroyed", ErrDeadEntity)
	}
	if defIdx := findDefenderIndex(next.Defenders, cmd.PlayerID); defIdx >= 0 && next.Defenders[defIdx].HP == 0 {
		return fmt.Errorf("%w: defender %q is defeated", ErrDeadEntity, cmd.PlayerID)
	}
	if err := checkAndSetPlayerCooldown(next, cmd.PlayerID, cfg.PlayerAttackCooldown); err != nil {
		return err
	}

	missing := next.SettlementMaxDefenseHP - next.SettlementDefenseHP
	healed := cfg.PlayerSupportHeal
	if healed > missing {
		healed = missing
	}
	next.SettlementDefenseHP += healed

	if defIdx := findDefenderIndex(next.Defenders, cmd.PlayerID); defIdx >= 0 && next.Defenders[defIdx].HP > 0 {
		nextThreat, err := safeAddInt64(next.Defenders[defIdx].ThreatScore, cfg.DefenderSupportThreatGain)
		if err != nil {
			return err
		}
		if nextThreat > 10000 {
			nextThreat = 10000
		}
		next.Defenders[defIdx].ThreatScore = nextThreat
	}

	return addContribution(next, cmd.PlayerID, 0, cfg.PlayerSupportHeal, 0, cfg)
}

func applyCompleteObjective(next *WorldState, cmd Command, cfg Config) error {
	if next.Invasion.State != InvasionUnderAttack {
		return fmt.Errorf("%w: cannot complete objective during state %s", ErrInvasionNotActive, next.Invasion.State)
	}
	if strings.TrimSpace(cmd.PlayerID) == "" || strings.TrimSpace(cmd.ObjectiveID) == "" {
		return fmt.Errorf("%w: player_id and objective_id are required", ErrInvalidCommand)
	}
	if idx := findDefenderIndex(next.Defenders, cmd.PlayerID); idx >= 0 && next.Defenders[idx].HP == 0 {
		return fmt.Errorf("%w: defender %q is defeated", ErrDeadEntity, cmd.PlayerID)
	}
	idx, found := slices.BinarySearch(next.Invasion.ObjectivesCompleted, cmd.ObjectiveID)
	if found {
		return fmt.Errorf("%w: %q", ErrDuplicateObjective, cmd.ObjectiveID)
	}
	if len(next.Invasion.ObjectivesCompleted) >= cfg.MaxObjectives {
		return fmt.Errorf("%w: max objectives %d reached", ErrCapacityExceeded, cfg.MaxObjectives)
	}
	next.Invasion.ObjectivesCompleted = slices.Insert(next.Invasion.ObjectivesCompleted, idx, cmd.ObjectiveID)
	return addContribution(next, cmd.PlayerID, 0, 0, 1, cfg)
}

func checkAndSetPlayerCooldown(next *WorldState, playerID string, cooldownTicks int64) error {
	if uint64(cooldownTicks) > math.MaxUint64-next.Tick {
		return ErrNumericOverflow
	}
	idx, found := slices.BinarySearchFunc(next.PlayerCooldowns, playerID, func(pc PlayerCooldown, id string) int {
		return strings.Compare(pc.PlayerID, id)
	})
	if found {
		if next.Tick < next.PlayerCooldowns[idx].NextActionTick {
			return fmt.Errorf("%w: player %q ready at tick %d (current %d)", ErrCooldownActive, playerID, next.PlayerCooldowns[idx].NextActionTick, next.Tick)
		}
		next.PlayerCooldowns[idx].NextActionTick = next.Tick + uint64(cooldownTicks)
		return nil
	}
	next.PlayerCooldowns = slices.Insert(next.PlayerCooldowns, idx, PlayerCooldown{
		PlayerID:       playerID,
		NextActionTick: next.Tick + uint64(cooldownTicks),
	})
	return nil
}

func addContribution(next *WorldState, playerID string, damage, support, objectives int64, cfg Config) error {
	if damage < 0 || support < 0 || objectives < 0 {
		return fmt.Errorf("%w: negative contribution delta", ErrInvalidCommand)
	}
	idx, found := slices.BinarySearchFunc(next.Contributions, playerID, func(c PlayerContribution, id string) int {
		return strings.Compare(c.PlayerID, id)
	})
	if found {
		c := &next.Contributions[idx]
		var err error
		if c.Damage, err = safeAddInt64(c.Damage, damage); err != nil {
			return err
		}
		if c.Support, err = safeAddInt64(c.Support, support); err != nil {
			return err
		}
		if c.Objectives, err = safeAddInt64(c.Objectives, objectives); err != nil {
			return err
		}
		return nil
	}
	if len(next.Contributions) >= cfg.MaxContributions {
		return fmt.Errorf("%w: max contributions %d reached", ErrCapacityExceeded, cfg.MaxContributions)
	}
	next.Contributions = slices.Insert(next.Contributions, idx, PlayerContribution{
		PlayerID:   playerID,
		Damage:     damage,
		Support:    support,
		Objectives: objectives,
	})
	return nil
}

func findGroupIndex(groups []CreatureGroup, groupID string) int {
	idx, found := slices.BinarySearchFunc(groups, groupID, func(g CreatureGroup, id string) int {
		return strings.Compare(g.GroupID, id)
	})
	if !found {
		return -1
	}
	return idx
}

func findDefenderIndex(defenders []DefenderEntity, playerID string) int {
	idx, found := slices.BinarySearchFunc(defenders, playerID, func(d DefenderEntity, id string) int {
		return strings.Compare(d.PlayerID, id)
	})
	if !found {
		return -1
	}
	return idx
}

func insertGroupSorted(groups []CreatureGroup, g CreatureGroup) []CreatureGroup {
	idx, _ := slices.BinarySearchFunc(groups, g.GroupID, func(existing CreatureGroup, id string) int {
		return strings.Compare(existing.GroupID, id)
	})
	return slices.Insert(groups, idx, g)
}

func countActiveHostiles(groups []CreatureGroup) int {
	active := 0
	for _, g := range groups {
		if g.HP > 0 && g.State != ai.StateDead && !g.Routed {
			active++
		}
	}
	return active
}
