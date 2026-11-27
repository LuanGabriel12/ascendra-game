package world

import (
	"fmt"
	"slices"
	"strings"

	"ascendra-game/internal/ai"
	"ascendra-game/internal/siege"
)

// syncSettlementDefenseHP maintains a single source of truth between WorldState defense HP
// and the authoritative SiegeState structural integrity.
func syncSettlementDefenseHP(next *WorldState) {
	if next == nil || next.Siege == nil {
		return
	}
	next.SettlementMaxDefenseHP = next.Siege.TotalStructureMaxHP()
	next.SettlementDefenseHP = next.Siege.TotalStructureHP()
}

func applyConfigureSiege(next *WorldState, cmd Command, cfg Config, events *[]DomainEvent) error {
	if next.Invasion.State == InvasionResolved {
		return fmt.Errorf("%w: cannot configure siege on a Resolved invasion", ErrInvalidInvasionTransition)
	}
	if next.Siege != nil {
		return fmt.Errorf("%w: siege is already configured for this invasion", ErrInvalidCommand)
	}

	siegeCfg := siege.DefaultConfig()
	if cmd.SiegeConfig != nil {
		siegeCfg = *cmd.SiegeConfig
	}
	if err := siegeCfg.Validate(); err != nil {
		return err
	}

	var layout siege.SettlementLayout
	if cmd.SiegeLayout != nil {
		layout = *cmd.SiegeLayout
	} else {
		layout = siege.LookupProvisionalLayout(next.SettlementID, next.RegionID, next.SettlementMaxDefenseHP)
	}
	if layout.SettlementID != next.SettlementID || layout.RegionID != next.RegionID {
		return fmt.Errorf("%w: siege layout settlement/region (%s/%s) does not match world (%s/%s)",
			ErrInvalidCommand, layout.SettlementID, layout.RegionID, next.SettlementID, next.RegionID)
	}
	if err := siege.ValidateLayout(layout, siegeCfg); err != nil {
		return err
	}

	campaignID := cmd.CampaignID
	if campaignID == "" {
		campaignID = next.Invasion.CampaignID
	}
	invFaction := cmd.InvadingFactionID
	if invFaction == "" {
		invFaction = next.Invasion.InvadingFactionID
	}
	family := cmd.InvadingFamily
	if family == "" {
		for _, g := range next.Groups {
			if g.HP > 0 && !g.Routed && g.State != ai.StateDead {
				family = g.Family
				break
			}
		}
	}

	st, err := siege.NewSiegeStateFromLayout(layout, siegeCfg, campaignID, invFaction, family, cmd.IsReconquest, next.Tick)
	if err != nil {
		return err
	}
	next.Siege = &st
	syncSettlementDefenseHP(next)

	// Map any pre-existing groups and defenders cleanly into valid siege zones.
	for i := range next.Groups {
		if next.Groups[i].ZoneID == "" || next.Siege.FindZoneIndex(next.Groups[i].ZoneID) < 0 {
			next.Groups[i].ZoneID = siege.ZoneForPosition(*next.Siege, next.Groups[i].DistanceToSettlement)
			if pos, ok := siege.PositionForZone(*next.Siege, next.Groups[i].ZoneID); ok {
				next.Groups[i].DistanceToSettlement = pos
			}
		}
	}
	for i := range next.Defenders {
		if next.Defenders[i].ZoneID == "" || next.Siege.FindZoneIndex(next.Defenders[i].ZoneID) < 0 {
			next.Defenders[i].ZoneID = siege.ZoneForPosition(*next.Siege, next.Defenders[i].Position)
			if pos, ok := siege.PositionForZone(*next.Siege, next.Defenders[i].ZoneID); ok {
				next.Defenders[i].Position = pos
			}
		}
	}

	// Deploy representative NPC garrison defenders from layout roster when requested.
	if cmd.SpawnNPCDefenders {
		for _, spec := range layout.DefenderRoster {
			if len(next.Defenders) >= cfg.MaxDefenders {
				break
			}
			if findDefenderIndex(next.Defenders, spec.DefenderID) >= 0 {
				continue
			}
			pos, _ := siege.PositionForZone(*next.Siege, spec.ZoneID)
			insertIdx, _ := slices.BinarySearchFunc(next.Defenders, spec.DefenderID, func(d DefenderEntity, id string) int {
				return strings.Compare(d.PlayerID, id)
			})
			next.Defenders = slices.Insert(next.Defenders, insertIdx, DefenderEntity{
				PlayerID:    spec.DefenderID,
				HP:          spec.MaxHP,
				MaxHP:       spec.MaxHP,
				Position:    pos,
				ThreatScore: 0,
				Role:        spec.Role,
				ZoneID:      spec.ZoneID,
				IsNPC:       true,
			})
		}
	}

	*events = append(*events, next.newEvent(EventSiegePhaseChanged, next.Siege.LayoutID, string(next.Siege.Phase), next.SettlementDefenseHP, nil))
	return nil
}

func applyScheduleSiegeWave(next *WorldState, cmd Command, cfg Config, events *[]DomainEvent) error {
	if next.Siege == nil {
		return fmt.Errorf("%w: siege is not configured", ErrInvalidCommand)
	}
	if cmd.Wave == nil {
		return fmt.Errorf("%w: wave payload is required", ErrInvalidCommand)
	}
	if err := siege.UpsertWave(next.Siege, *cmd.Wave, next.Siege.Config); err != nil {
		return err
	}
	*events = append(*events, next.newEvent(EventSiegeWaveScheduled, cmd.Wave.WaveID, cmd.Wave.Archetype, cmd.Wave.Count, nil))
	return nil
}

func applyMoveDefenderZone(next *WorldState, cmd Command, cfg Config) error {
	if next.Siege == nil {
		return fmt.Errorf("%w: MoveDefenderZone requires an active siege layout", ErrInvalidCommand)
	}
	if strings.TrimSpace(cmd.PlayerID) == "" || strings.TrimSpace(cmd.TargetZoneID) == "" {
		return fmt.Errorf("%w: player_id and target_zone_id are required", ErrInvalidCommand)
	}
	idx := findDefenderIndex(next.Defenders, cmd.PlayerID)
	if idx < 0 {
		return fmt.Errorf("%w: defender %q must be deployed before moving between zones", ErrUnknownEntity, cmd.PlayerID)
	}
	d := &next.Defenders[idx]
	if d.HP == 0 {
		return fmt.Errorf("%w: defender %q is defeated", ErrDeadEntity, cmd.PlayerID)
	}
	if d.IsNPC {
		return fmt.Errorf("%w: gameplay command cannot move NPC defender %q", ErrUnauthorizedCommand, cmd.PlayerID)
	}
	if next.Siege.FindZoneIndex(cmd.TargetZoneID) < 0 {
		return fmt.Errorf("%w: unknown target zone %q", ErrUnknownEntity, cmd.TargetZoneID)
	}
	if !siege.CanTraverse(*next.Siege, d.ZoneID, cmd.TargetZoneID, false) {
		return fmt.Errorf("%w: cannot move directly from %q to %q", siege.ErrZoneBlocked, d.ZoneID, cmd.TargetZoneID)
	}
	d.ZoneID = cmd.TargetZoneID
	if pos, ok := siege.PositionForZone(*next.Siege, cmd.TargetZoneID); ok {
		d.Position = pos
	}
	return nil
}

func applyPlayerRepairStructure(next *WorldState, cmd Command, cfg Config, events *[]DomainEvent) error {
	if next.Invasion.State != InvasionUnderAttack {
		return fmt.Errorf("%w: cannot repair structure during state %s", ErrInvasionNotActive, next.Invasion.State)
	}
	if next.Siege == nil {
		return fmt.Errorf("%w: structure repair requires an active siege", ErrInvalidCommand)
	}
	if strings.TrimSpace(cmd.PlayerID) == "" || strings.TrimSpace(cmd.TargetStructureID) == "" {
		return fmt.Errorf("%w: player_id and target_structure_id are required", ErrInvalidCommand)
	}
	defIdx := findDefenderIndex(next.Defenders, cmd.PlayerID)
	if defIdx < 0 {
		return fmt.Errorf("%w: defender %q must be deployed to repair fortifications", ErrUnknownEntity, cmd.PlayerID)
	}
	def := &next.Defenders[defIdx]
	if def.HP == 0 {
		return fmt.Errorf("%w: defender %q is defeated", ErrDeadEntity, cmd.PlayerID)
	}
	if def.IsNPC {
		return fmt.Errorf("%w: gameplay command cannot control NPC defender %q", ErrUnauthorizedCommand, cmd.PlayerID)
	}
	if err := checkAndSetPlayerCooldown(next, cmd.PlayerID, cfg.PlayerAttackCooldown, cfg.MaxPlayerCooldowns); err != nil {
		return err
	}

	healed, cost, err := siege.ApplyStructureRepair(next.Siege, cmd.TargetStructureID, cmd.PlayerID, def.ZoneID, next.Tick, next.Siege.Config)
	if err != nil {
		return err
	}
	def.RepairsPerformed++
	syncSettlementDefenseHP(next)

	nextThreat, err := safeAddInt64(def.ThreatScore, cfg.DefenderSupportThreatGain)
	if err != nil {
		return err
	}
	if nextThreat > 10000 {
		nextThreat = 10000
	}
	def.ThreatScore = nextThreat

	*events = append(*events, next.newEvent(EventStructureRepaired, cmd.TargetStructureID, cmd.PlayerID, healed, nil))
	*events = append(*events, next.newEvent(EventSupplyChanged, cmd.PlayerID, "RepairSpent", -cost, nil))
	// Authoritative contribution: credit ONLY effective HP actually restored.
	return addContribution(next, cmd.PlayerID, 0, healed, 0, cfg)
}

func applySiegeSupportDefense(next *WorldState, cmd Command, cfg Config, events *[]DomainEvent) error {
	if next.Invasion.State != InvasionUnderAttack {
		return fmt.Errorf("%w: cannot support defense during state %s", ErrInvasionNotActive, next.Invasion.State)
	}
	if strings.TrimSpace(cmd.PlayerID) == "" {
		return fmt.Errorf("%w: player_id is required", ErrInvalidCommand)
	}
	defIdx := findDefenderIndex(next.Defenders, cmd.PlayerID)
	if defIdx < 0 {
		return fmt.Errorf("%w: defender %q must be deployed to support during siege", ErrUnknownEntity, cmd.PlayerID)
	}
	actor := &next.Defenders[defIdx]
	if actor.HP == 0 {
		return fmt.Errorf("%w: defender %q is defeated", ErrDeadEntity, cmd.PlayerID)
	}
	if actor.IsNPC {
		return fmt.Errorf("%w: gameplay command cannot control NPC defender %q", ErrUnauthorizedCommand, cmd.PlayerID)
	}
	if err := checkAndSetPlayerCooldown(next, cmd.PlayerID, cfg.PlayerAttackCooldown, cfg.MaxPlayerCooldowns); err != nil {
		return err
	}

	// Find most injured living ally defender in same or adjacent zone.
	targetIdx := -1
	var bestMissing int64
	for i := range next.Defenders {
		ally := next.Defenders[i]
		if ally.HP == 0 || ally.HP >= ally.MaxHP {
			continue
		}
		if !siege.AreAdjacent(*next.Siege, actor.ZoneID, ally.ZoneID) {
			continue
		}
		missing := ally.MaxHP - ally.HP
		if targetIdx < 0 || missing > bestMissing || (missing == bestMissing && ally.PlayerID < next.Defenders[targetIdx].PlayerID) {
			targetIdx = i
			bestMissing = missing
		}
	}
	if targetIdx < 0 {
		return fmt.Errorf("%w: no injured ally defender within reach to heal (use PlayerRepairStructure for fortifications)", ErrInvalidCommand)
	}

	healed := cfg.PlayerSupportHeal
	if healed > bestMissing {
		healed = bestMissing
	}
	next.Defenders[targetIdx].HP += healed

	nextThreat, err := safeAddInt64(actor.ThreatScore, cfg.DefenderSupportThreatGain)
	if err != nil {
		return err
	}
	if nextThreat > 10000 {
		nextThreat = 10000
	}
	actor.ThreatScore = nextThreat

	_ = events
	// Authoritative contribution: credit ONLY effective HP restored (never overheal).
	return addContribution(next, cmd.PlayerID, 0, healed, 0, cfg)
}

func buildSiegeCombatants(state *WorldState) []siege.CombatantSnapshot {
	out := make([]siege.CombatantSnapshot, 0, len(state.Groups)+len(state.Defenders))
	for _, g := range state.Groups {
		if g.HP == 0 || g.State == ai.StateDead || g.Routed {
			continue
		}
		out = append(out, siege.CombatantSnapshot{
			ID:          g.GroupID,
			ZoneID:      g.ZoneID,
			HP:          g.HP,
			MaxHP:       g.MaxHP,
			MoraleBP:    g.MoraleBP,
			Family:      g.Family,
			IsInvader:   true,
			IsCommander: g.Role == ai.RoleCommander,
		})
	}
	for _, d := range state.Defenders {
		if d.HP == 0 {
			continue
		}
		out = append(out, siege.CombatantSnapshot{
			ID:        d.PlayerID,
			ZoneID:    d.ZoneID,
			HP:        d.HP,
			MaxHP:     d.MaxHP,
			Role:      d.Role,
			IsInvader: false,
			IsNPC:     d.IsNPC,
		})
	}
	return out
}

// stepSiegeTactics executes one deterministic tick of integrated siege warfare inside world.Step.
// It reuses Creature AI (ai.Coordinate + ai.Evaluate), updates structures/breaches/towers/NPCs/
// districts/objectives/phases, and triggers the single authoritative resolveInvasion when concluded.
func stepSiegeTactics(
	next *WorldState,
	cfg Config,
	events *[]DomainEvent,
	fallenCommanders *[]fallenCommander,
) (resolved bool, err error) {
	s := next.Siege
	sCfg := s.Config
	madeProgress := false

	// 1. Bounded finite tactical supply regeneration (ONLY while Supply Depot is operational).
	if gained := siege.TickSupplyRegen(s, next.Tick, sCfg); gained > 0 {
		*events = append(*events, next.newEvent(EventSupplyChanged, siege.StructIDSupplyDepot, "DepotRegen", gained, nil))
	}

	// 2. Bind and monitor Siege Commanders (1-to-1 with real population-conserved CreatureGroups).
	syncSiegeCommanders(next, fallenCommanders, events, &madeProgress)

	// 3. Invader AI evaluation, legal zone-graph movement, fortification assault, and defender combat.
	if len(next.Groups) > 0 {
		perceivedTargets := buildPerceivedTargets(next)
		snapshots := make([]ai.GroupSnapshot, len(next.Groups))
		profiles := make([]ai.Profile, len(next.Groups))

		for i, g := range next.Groups {
			prof, err := ai.LookupProfile(g.Archetype)
			if err != nil {
				return false, err
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

		orders, err := ai.Coordinate(snapshots, perceivedTargets, true)
		if err != nil {
			return false, err
		}

		for i := range next.Groups {
			g := &next.Groups[i]
			if g.HP == 0 || g.State == ai.StateDead || g.Routed {
				g.RecentDamageTaken = 0
				g.CurrentTargetID = ""
				g.CurrentTarget = ai.TargetRef{}
				g.TargetMemoryTicks = 0
				if g.TerminalTick == 0 {
					g.TerminalTick = next.Tick
				}
				if g.PopulationWeight == 0 {
					g.Accounted = true
				}
				continue
			}
			if g.ZoneID == "" || s.FindZoneIndex(g.ZoneID) < 0 {
				g.ZoneID = siege.ZoneForPosition(*s, g.DistanceToSettlement)
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

			// Commander morale aura & fallen shock integration.
			cmdrLive, cmdrAuraBonus, cmdrSiegeDmgBonus := activeCommanderBonuses(*s, g.Family)
			order := orders[i]
			if cmdrLive && cmdrAuraBonus > 0 {
				order.MoraleAuraBP += cmdrAuraBonus
				if order.MoraleAuraBP > BasisPointsScale {
					order.MoraleAuraBP = BasisPointsScale
				}
			}

			cmdrShock := false
			for _, fc := range *fallenCommanders {
				if fc.family == g.Family {
					cmdrShock = true
					break
				}
			}

			perception := ai.Perception{
				Tick:                        next.Tick,
				GroupID:                     g.GroupID,
				CurrentState:                g.State,
				HP:                          g.HP,
				MaxHP:                       g.MaxHP,
				DistanceToSettlement:        g.DistanceToSettlement,
				AttackCooldownTicks:         g.AttackCooldownTicks,
				InvasionActive:              true,
				SettlementAlive:             next.SettlementDefenseHP > 0,
				Profile:                     prof,
				HomePosition:                g.HomePosition,
				MoraleBP:                    g.MoraleBP,
				RecentDamageTaken:           g.RecentDamageTaken,
				CommanderFallenShock:        cmdrShock,
				RetainedTarget:              g.CurrentTarget,
				TargetMemoryTicks:           g.TargetMemoryTicks,
				ReinforceCooldownTicks:      g.ReinforceCooldownTicks,
				RemainingReinforcementCalls: remainingCalls,
				Targets:                     perceivedTargets,
				Order:                       order,
			}
			decision, err := ai.Evaluate(perception, &next.RNG)
			if err != nil {
				return false, err
			}

			g.RecentDamageTaken = 0
			g.State = decision.NextState
			g.MoraleBP = decision.NewMoraleBP

			if prevState != decision.NextState && (decision.NextState == ai.StateRetreat || decision.NextState == ai.StateRally) {
				*events = append(*events, next.newEvent(EventMoraleChanged, g.GroupID, fmt.Sprintf("%s->%s", prevState, decision.NextState), g.MoraleBP, nil))
			}

			// Ecological reinforcement request (debited strictly from campaign reservation in worldevents).
			if decision.RequestReinforcements && g.PopulationWeight > 0 && cfg.OrchestrationMode == OrchestrationCampaignDirector && g.CampaignID != "" && g.State != ai.StateRetreat {
				g.ReinforcementsCalled++
				g.ReinforceCooldownTicks = prof.ReinforceCooldownTicks
				*events = append(*events, next.newEvent(EventReinforcementRequested, g.GroupID, decision.ReinforcementArchetype, decision.ReinforcementCount, nil))
			}

			// Retreating invader moves back toward exterior exit along legal zone edges.
			if g.State == ai.StateRetreat {
				extZone := s.FindZoneByKind(siege.ZoneExteriorField)
				if extZone != nil && g.ZoneID != extZone.ZoneID {
					if stepZone, ok := siege.NextStepToward(*s, g.ZoneID, extZone.ZoneID, true); ok {
						stepPos, _ := siege.PositionForZone(*s, stepZone)
						g.DistanceToSettlement = moveScalarToward(g.DistanceToSettlement, stepPos, prof.MoveSpeedPerTick, cfg.MaxBattlefieldDistance)
						if g.DistanceToSettlement == stepPos {
							g.ZoneID = stepZone
						}
					} else {
						g.DistanceToSettlement = moveScalarToward(g.DistanceToSettlement, cfg.HostileRetreatExitDistance, prof.MoveSpeedPerTick, cfg.MaxBattlefieldDistance)
					}
				} else {
					g.DistanceToSettlement = moveScalarToward(g.DistanceToSettlement, cfg.HostileRetreatExitDistance, prof.MoveSpeedPerTick, cfg.MaxBattlefieldDistance)
				}
				if g.DistanceToSettlement >= cfg.HostileRetreatExitDistance {
					g.Routed = true
					g.TerminalTick = next.Tick
					g.CurrentTarget = ai.TargetRef{}
					g.CurrentTargetID = ""
					g.TargetMemoryTicks = 0
					if g.PopulationWeight == 0 {
						g.Accounted = true
					}
					*events = append(*events, next.newEvent(EventCreaturePopulationChanged, g.GroupID, "Retreat->Routed", -1, nil))
					madeProgress = true
				}
				continue
			}

			// Decide between attacking a defender in the same zone, attacking a structure in the same zone,
			// or advancing along legal graph edges toward the next strategic target zone.
			defTargetIdx := selectDefenderInZone(next.Defenders, g.ZoneID, g.Family)
			structTarget, hasStruct := siege.SelectStructureTarget(*s, g.ZoneID, g.Family, g.Archetype)

			preferStruct := hasStruct && (defTargetIdx < 0 || shouldPreferStructure(g.Family, g.Archetype, structTarget))

			if preferStruct {
				g.State = ai.StateAttack
				if g.AttackCooldownTicks == 0 {
					rawDmg, err := rollHostileDamage(prof.BaseDamage, cfg.HostileDamageVariance, &next.RNG)
					if err != nil {
						return false, err
					}
					modBP := siege.StructureAttackModifierBP(g.Archetype, g.Family, structTarget.Kind, cmdrLive, cmdrSiegeDmgBonus)
					eff, breached, destroyed, disrupted, err := siege.ApplyStructureDamage(s, structTarget.StructureID, rawDmg, modBP, next.Tick, sCfg)
					if err != nil {
						return false, err
					}
					syncSettlementDefenseHP(next)
					g.AttackCooldownTicks = prof.AttackCooldownTicks
					madeProgress = true
					*events = append(*events, next.newEvent(EventStructureDamaged, structTarget.StructureID, g.GroupID, eff, nil))
					if breached {
						*events = append(*events, next.newEvent(EventStructureBreached, structTarget.StructureID, string(structTarget.Kind), 0, nil))
					}
					if destroyed {
						*events = append(*events, next.newEvent(EventStructureDestroyed, structTarget.StructureID, string(structTarget.Kind), 0, nil))
					}
					if disrupted > 0 {
						*events = append(*events, next.newEvent(EventSupplyChanged, structTarget.StructureID, "DepotDestroyed", -disrupted, nil))
					}
				}
			} else if defTargetIdx >= 0 {
				g.State = ai.StateAttack
				g.CurrentTarget = ai.TargetRef{Kind: ai.TargetDefender, ID: next.Defenders[defTargetIdx].PlayerID}
				g.CurrentTargetID = next.Defenders[defTargetIdx].PlayerID
				if g.AttackCooldownTicks == 0 {
					dmg, err := rollHostileDamage(prof.BaseDamage, cfg.HostileDamageVariance, &next.RNG)
					if err != nil {
						return false, err
					}
					if dmg > next.Defenders[defTargetIdx].HP {
						dmg = next.Defenders[defTargetIdx].HP
					}
					next.Defenders[defTargetIdx].HP -= dmg
					g.AttackCooldownTicks = prof.AttackCooldownTicks
					madeProgress = true
					if next.Defenders[defTargetIdx].HP == 0 {
						s.DefenderCasualties++
					}
				}
			} else {
				// Advance along legal open zone edges (closed Gate/Wall blocks traversal!).
				destZone := siege.SelectInvaderDestinationZone(*s, g.ZoneID, g.Family)
				if destZone != "" && destZone != g.ZoneID {
					if stepZone, ok := siege.NextStepToward(*s, g.ZoneID, destZone, true); ok {
						stepPos, _ := siege.PositionForZone(*s, stepZone)
						prevPos := g.DistanceToSettlement
						g.DistanceToSettlement = moveScalarToward(g.DistanceToSettlement, stepPos, prof.MoveSpeedPerTick, cfg.MaxBattlefieldDistance)
						g.State = ai.StateAdvance
						if g.DistanceToSettlement != prevPos {
							madeProgress = true
						}
						if g.DistanceToSettlement == stepPos {
							g.ZoneID = stepZone
							madeProgress = true
						}
					}
				}
			}
		}
	}

	// 4. Operational Defensive Towers fire at hostile groups within AttackRangeZones.
	combatants := buildSiegeCombatants(next)
	for i := range s.Structures {
		st := &s.Structures[i]
		if st.Kind != siege.StructureTower || st.HP == 0 || st.State == siege.StructureDestroyed {
			continue
		}
		if st.FireCooldownTicks > 0 {
			st.FireCooldownTicks--
			continue
		}
		if sCfg.TowerFireDamage <= 0 {
			continue
		}
		targetID, ok := siege.SelectTowerTarget(*s, *st, combatants)
		if !ok {
			continue
		}
		gIdx := findGroupIndex(next.Groups, targetID)
		if gIdx < 0 || next.Groups[gIdx].HP == 0 {
			continue
		}
		dmg := sCfg.TowerFireDamage
		if dmg > next.Groups[gIdx].HP {
			dmg = next.Groups[gIdx].HP
		}
		next.Groups[gIdx].HP -= dmg
		next.Groups[gIdx].RecentDamageTaken, _ = safeAddInt64(next.Groups[gIdx].RecentDamageTaken, dmg)
		st.FireCooldownTicks = sCfg.TowerFireCooldownTicks
		madeProgress = true
		*events = append(*events, next.newEvent(EventTowerFired, st.StructureID, targetID, dmg, nil))
		if next.Groups[gIdx].HP == 0 {
			markGroupDefeatedInSiege(next, gIdx, st.StructureID, fallenCommanders, events)
		}
	}

	// 5. NPC Garrison Defenders act deterministically (dead NPCs NEVER act; NPCs NEVER emit player contributions).
	stepNPCDefenders(next, cfg, fallenCommanders, events, &madeProgress)

	// Re-sync commanders in case towers or NPCs defeated a siege commander this tick.
	syncSiegeCommanders(next, fallenCommanders, events, &madeProgress)

	// 6. District capture progression with hysteresis.
	combatants = buildSiegeCombatants(next)
	distChanges, distProg := siege.EvaluateDistricts(s, combatants, next.Tick, sCfg)
	if distProg {
		madeProgress = true
	}
	for _, dc := range distChanges {
		*events = append(*events, next.newEvent(EventDistrictStateChanged, dc.ZoneID, fmt.Sprintf("%s->%s", dc.From, dc.To), 0, nil))
	}

	// 7. Authoritative strategic objective unlock/progression/completion.
	objChanges, objProg := siege.EvaluateObjectives(s, combatants, next.Tick)
	if objProg {
		madeProgress = true
	}
	for _, oc := range objChanges {
		*events = append(*events, next.newEvent(EventObjectiveUpdated, oc.ObjectiveID, fmt.Sprintf("%s->%s", oc.From, oc.To), 0, nil))
	}

	// 8. Siege Phase progression & SINGLE authoritative tactical resolution.
	phaseTransitions, terminal, outcome, _, err := siege.EvaluatePhaseAndResolution(s, combatants, next.Tick, madeProgress, sCfg)
	if err != nil {
		return false, err
	}
	for _, ph := range phaseTransitions {
		*events = append(*events, next.newEvent(EventSiegePhaseChanged, s.LayoutID, string(ph), next.SettlementDefenseHP, nil))
	}

	if terminal {
		// Cancel any unspawned scheduled waves so their reserved population cleanly returns to FreePopulation.
		for i := range s.Waves {
			if s.Waves[i].State == siege.WaveScheduled {
				s.Waves[i].State = siege.WaveCancelled
			}
		}
		if err := resolveInvasion(next, outcome, cfg, events); err != nil {
			return false, err
		}
		return true, nil
	}

	return false, nil
}

func syncSiegeCommanders(next *WorldState, fallen *[]fallenCommander, events *[]DomainEvent, madeProgress *bool) {
	s := next.Siege
	if s == nil {
		return
	}
	for i := range s.Commanders {
		cmdr := &s.Commanders[i]
		// Bind to matching commander CreatureGroup if not yet bound.
		if cmdr.GroupID == "" {
			for _, g := range next.Groups {
				if g.Family == cmdr.Family && g.Role == ai.RoleCommander && g.HP > 0 && !g.Routed && g.State != ai.StateDead {
					cmdr.GroupID = g.GroupID
					cmdr.Alive = true
					cmdr.Deployed = true
					break
				}
			}
			continue
		}
		if !cmdr.Deployed {
			continue
		}
		gIdx := findGroupIndex(next.Groups, cmdr.GroupID)
		if gIdx < 0 || next.Groups[gIdx].Routed {
			cmdr.Alive = false
			continue
		}
		if next.Groups[gIdx].HP == 0 || next.Groups[gIdx].State == ai.StateDead {
			if cmdr.Alive {
				cmdr.Alive = false
				cmdr.DefeatedTick = next.Tick
				*madeProgress = true
			}
			if !cmdr.FallenShockApplied {
				cmdr.FallenShockApplied = true
				shockBP := s.Config.CommanderFallenMoraleShockGoblinBP
				if cmdr.Family == ai.FamilyOrc {
					shockBP = s.Config.CommanderFallenMoraleShockOrcBP
				}
				for j := range next.Groups {
					if next.Groups[j].Family == cmdr.Family && next.Groups[j].HP > 0 && !next.Groups[j].Routed {
						if next.Groups[j].MoraleBP > shockBP {
							next.Groups[j].MoraleBP -= shockBP
						} else {
							next.Groups[j].MoraleBP = 0
						}
					}
				}
				*fallen = append(*fallen, fallenCommander{family: cmdr.Family, pos: 0})
				*events = append(*events, next.newEvent(EventCommanderFallen, cmdr.CommanderID, cmdr.DisplayName, shockBP, nil))
			}
		}
	}
}

func activeCommanderBonuses(s siege.SiegeState, family ai.Family) (live bool, moraleAuraBP int64, siegeDmgBP int64) {
	for _, cmdr := range s.Commanders {
		if cmdr.Deployed && cmdr.Alive && cmdr.Family == family {
			return true, cmdr.MoraleAuraBonusBP, cmdr.SiegeDamageBonusBP
		}
	}
	return false, 0, 0
}

func markGroupDefeatedInSiege(next *WorldState, gIdx int, killerID string, fallen *[]fallenCommander, events *[]DomainEvent) {
	target := &next.Groups[gIdx]
	target.HP = 0
	target.State = ai.StateDead
	target.MoraleBP = 0
	target.TerminalTick = next.Tick
	target.CurrentTarget = ai.TargetRef{}
	target.CurrentTargetID = ""
	target.TargetMemoryTicks = 0
	if target.PopulationWeight == 0 {
		target.Accounted = true
	}
	if next.Siege != nil {
		next.Siege.InvaderCasualties++
		for i := range next.Siege.Commanders {
			if next.Siege.Commanders[i].GroupID == target.GroupID && next.Siege.Commanders[i].Alive {
				next.Siege.Commanders[i].Alive = false
				next.Siege.Commanders[i].DefeatedTick = next.Tick
				next.Siege.Commanders[i].DefeatedByPlayerID = killerID
			}
		}
	}
	*events = append(*events, next.newEvent(EventCreaturePopulationChanged, target.GroupID, "Defeated", -1, nil))
	if target.Role == ai.RoleCommander {
		*fallen = append(*fallen, fallenCommander{family: target.Family, pos: target.DistanceToSettlement})
		*events = append(*events, next.newEvent(EventCommanderFallen, target.GroupID, string(target.Family), 0, nil))
	}
}

func selectDefenderInZone(defenders []DefenderEntity, zoneID string, family ai.Family) int {
	bestIdx := -1
	for i, d := range defenders {
		if d.HP == 0 || d.ZoneID != zoneID {
			continue
		}
		if bestIdx < 0 {
			bestIdx = i
			continue
		}
		cur := defenders[bestIdx]
		if family == ai.FamilyGoblin {
			// Goblins opportunistically target lowest-HP defender in zone.
			if d.HP < cur.HP || (d.HP == cur.HP && d.PlayerID < cur.PlayerID) {
				bestIdx = i
			}
		} else {
			// Orcs engage highest-threat / strongest frontline defender in zone.
			if d.ThreatScore > cur.ThreatScore || (d.ThreatScore == cur.ThreatScore && d.HP > cur.HP) ||
				(d.ThreatScore == cur.ThreatScore && d.HP == cur.HP && d.PlayerID < cur.PlayerID) {
				bestIdx = i
			}
		}
	}
	return bestIdx
}

func shouldPreferStructure(family ai.Family, archetype string, st siege.Structure) bool {
	if st.Kind == siege.StructureCitadel {
		return true
	}
	if family == ai.FamilyOrc {
		return st.Kind == siege.StructureGate || st.Kind == siege.StructureWall
	}
	if archetype == "goblin-skirmisher" && st.Kind == siege.StructureSupplyDepot {
		return true
	}
	return st.Kind == siege.StructureGate && st.HP < st.MaxHP
}

func stepNPCDefenders(next *WorldState, cfg Config, fallen *[]fallenCommander, events *[]DomainEvent, madeProgress *bool) {
	s := next.Siege
	sCfg := s.Config

	// Identify zones with a live GuardCaptain for local morale/attack boost.
	captainZones := make(map[string]bool)
	for _, d := range next.Defenders {
		if d.IsNPC && d.HP > 0 && d.Role == siege.RoleGuardCaptain {
			captainZones[d.ZoneID] = true
		}
	}

	for i := range next.Defenders {
		d := &next.Defenders[i]
		if !d.IsNPC || d.HP == 0 {
			continue
		}
		if d.ActionCooldownTicks > 0 {
			d.ActionCooldownTicks--
			continue
		}

		// RepairUnit prioritizes repairing damaged (non-destroyed) fortifications within supply & repair caps.
		if d.Role == siege.RoleRepairUnit {
			if stID, stZone, ok := pickStructureToRepair(*s, d.PlayerID, sCfg); ok {
				if siege.AreAdjacent(*s, d.ZoneID, stZone) {
					healed, cost, err := siege.ApplyStructureRepair(s, stID, d.PlayerID, d.ZoneID, next.Tick, sCfg)
					if err == nil {
						d.RepairsPerformed++
						d.ActionCooldownTicks = sCfg.RepairCooldownTicks
						syncSettlementDefenseHP(next)
						*madeProgress = true
						*events = append(*events, next.newEvent(EventStructureRepaired, stID, d.PlayerID, healed, nil))
						*events = append(*events, next.newEvent(EventSupplyChanged, d.PlayerID, "NPCRepairSpent", -cost, nil))
						continue
					}
				} else if stepZone, ok := siege.NextStepToward(*s, d.ZoneID, stZone, false); ok {
					d.ZoneID = stepZone
					if pos, ok := siege.PositionForZone(*s, stepZone); ok {
						d.Position = pos
					}
					d.ActionCooldownTicks = 3
					continue
				}
			}
		}

		// Determine abstract attack reach in hops (Archer: 1 hop; melee guards/captain: 0 hops).
		maxHops := 0
		baseDmg := int64(42)
		cooldown := uint64(9)
		switch d.Role {
		case siege.RoleGateDefender:
			baseDmg = 50
			cooldown = 9
		case siege.RoleArcher:
			maxHops = 1
			baseDmg = 36
			cooldown = 8
		case siege.RoleGuardCaptain:
			baseDmg = 58
			cooldown = 8
		case siege.RoleRepairUnit:
			baseDmg = 24
			cooldown = 11
		}
		if captainZones[d.ZoneID] && d.Role != siege.RoleGuardCaptain {
			baseDmg += (baseDmg * 1500) / BasisPointsScale // +15% Guard Captain coordination bonus
		}

		// Engage closest legal hostile within reach.
		targetIdx := selectHostileForNPC(*s, d.ZoneID, maxHops, next.Groups)
		if targetIdx >= 0 {
			dmg := baseDmg
			if dmg > next.Groups[targetIdx].HP {
				dmg = next.Groups[targetIdx].HP
			}
			next.Groups[targetIdx].HP -= dmg
			next.Groups[targetIdx].RecentDamageTaken, _ = safeAddInt64(next.Groups[targetIdx].RecentDamageTaken, dmg)
			d.ActionCooldownTicks = cooldown
			*madeProgress = true
			if next.Groups[targetIdx].HP == 0 {
				markGroupDefeatedInSiege(next, targetIdx, d.PlayerID, fallen, events)
			}
			continue
		}

		// Reorganize deterministically along legal edges to respond to breaches or threats.
		desiredZone := desiredNPCZone(*s, d.Role, d.ZoneID, next.Groups)
		if desiredZone != "" && desiredZone != d.ZoneID {
			if stepZone, ok := siege.NextStepToward(*s, d.ZoneID, desiredZone, false); ok {
				d.ZoneID = stepZone
				if pos, ok := siege.PositionForZone(*s, stepZone); ok {
					d.Position = pos
				}
				d.ActionCooldownTicks = 3
			}
		}
	}
}

func pickStructureToRepair(s siege.SiegeState, entityID string, cfg siege.Config) (structureID, zoneID string, ok bool) {
	if s.Supplies.Current < cfg.RepairSupplyCost {
		return "", "", false
	}
	if siege.EntityRepairTotal(s, entityID) >= cfg.MaxRepairsPerEntity {
		return "", "", false
	}
	bestScore := int64(-1)
	for _, st := range s.Structures {
		if st.HP == 0 || st.HP >= st.MaxHP || st.RepairsApplied >= cfg.MaxRepairsPerStructure {
			continue
		}
		var score int64
		switch st.Kind {
		case siege.StructureGate:
			score = 1000
		case siege.StructureCitadel:
			score = 950
		case siege.StructureWall:
			score = 800
		case siege.StructureSupplyDepot:
			score = 750
		case siege.StructureTower:
			score = 650
		}
		if score > bestScore || (score == bestScore && st.StructureID < structureID) {
			bestScore = score
			structureID = st.StructureID
			zoneID = st.ZoneID
			ok = true
		}
	}
	return structureID, zoneID, ok
}

func selectHostileForNPC(s siege.SiegeState, defZoneID string, maxHops int, groups []CreatureGroup) int {
	bestIdx := -1
	bestHops := int(1 << 20)
	for i, g := range groups {
		if g.HP == 0 || g.State == ai.StateDead || g.Routed {
			continue
		}
		hops := siege.ZoneHopDistance(s, defZoneID, g.ZoneID)
		if hops < 0 || hops > maxHops {
			continue
		}
		if bestIdx < 0 || hops < bestHops ||
			(hops == bestHops && g.HP < groups[bestIdx].HP) ||
			(hops == bestHops && g.HP == groups[bestIdx].HP && g.GroupID < groups[bestIdx].GroupID) {
			bestIdx = i
			bestHops = hops
		}
	}
	return bestIdx
}

func desiredNPCZone(s siege.SiegeState, role siege.DefenderRole, currentZone string, groups []CreatureGroup) string {
	// If Citadel is under assault, defenders rally to Citadel (archers hold Central Square if safe).
	if s.Phase == siege.PhaseCitadelAssault {
		if cit := s.FindZoneByKind(siege.ZoneCitadel); cit != nil {
			return cit.ZoneID
		}
	}
	// If outer breach happened, GateDefender reorganizes to Outer District or Central Square.
	if role == siege.RoleGateDefender && s.HasOuterBreach() {
		if s.FindZoneIndex(siege.ZoneIDOuterDistrict) >= 0 {
			return siege.ZoneIDOuterDistrict
		}
	}
	// Intercept deepest invader inside inner zones (Depth >= 2).
	deepestDepth := -1
	deepestZone := ""
	for _, g := range groups {
		if g.HP == 0 || g.State == ai.StateDead || g.Routed {
			continue
		}
		zIdx := s.FindZoneIndex(g.ZoneID)
		if zIdx < 0 {
			continue
		}
		z := s.Zones[zIdx]
		if z.Depth >= 2 && (z.Depth > deepestDepth || (z.Depth == deepestDepth && z.ZoneID < deepestZone)) {
			deepestDepth = z.Depth
			deepestZone = z.ZoneID
		}
	}
	if deepestZone != "" {
		return deepestZone
	}
	return currentZone
}

func moveScalarToward(pos, target, speed, maxDist int64) int64 {
	if speed <= 0 || pos == target {
		return pos
	}
	if target > pos {
		step := min(speed, target-pos)
		next := pos + step
		if next > maxDist {
			return maxDist
		}
		return next
	}
	step := min(speed, pos-target)
	next := pos - step
	if next < 0 {
		return 0
	}
	return next
}

// SpawnCampaignWaveGroup materializes a scheduled population-backed SiegeWave into its EntryZoneID
// during an active campaign siege, enforcing campaign/reservation ownership, MaxActiveGroups, and
// strict single-mobilization idempotency.
func SpawnCampaignWaveGroup(
	state *WorldState,
	waveID string,
	cmd DirectorCommand,
	cfg Config,
) ([]DomainEvent, error) {
	if state == nil || state.Siege == nil {
		return nil, fmt.Errorf("%w: active siege state required for wave spawn", ErrInvalidState)
	}
	if state.Invasion.State != InvasionUnderAttack {
		return nil, fmt.Errorf("%w: wave spawn requires UnderAttack state", ErrInvasionNotActive)
	}
	if len(state.Groups) >= cfg.MaxActiveGroups {
		return nil, fmt.Errorf("%w: max active groups %d reached", ErrCapacityExceeded, cfg.MaxActiveGroups)
	}
	c, err := cmd.ToCommand()
	if err != nil {
		return nil, err
	}
	if c.Kind != CmdDirectorSpawnCampaignGroup {
		return nil, fmt.Errorf("%w: expected CmdDirectorSpawnCampaignGroup, got %q", ErrInvalidCommand, c.Kind)
	}
	wIdx := state.Siege.FindWaveIndex(waveID)
	if wIdx < 0 {
		return nil, fmt.Errorf("%w: unknown siege wave %q", ErrUnknownEntity, waveID)
	}
	wave := &state.Siege.Waves[wIdx]
	if wave.State != siege.WaveScheduled {
		return nil, fmt.Errorf("%w: siege wave %q is already in state %s", ErrInvalidCommand, waveID, wave.State)
	}
	if wave.CampaignID != state.Invasion.CampaignID || c.CampaignID != state.Invasion.CampaignID ||
		c.InvadingFactionID != state.Invasion.InvadingFactionID || wave.ReservationID != c.ReservationID {
		return nil, fmt.Errorf("%w: siege wave %q campaign/reservation ownership mismatch", ErrInvalidCommand, waveID)
	}
	c.ZoneID = wave.EntryZoneID
	events := make([]DomainEvent, 0, 2)
	if err := applyDirectorSpawnCampaignGroup(state, c, cfg, &events); err != nil {
		return nil, err
	}
	wave.State = siege.WaveMobilized
	wave.SpawnedGroupID = c.GroupID
	events = append(events, state.newEvent(EventReinforcementsCalled, wave.WaveID, c.GroupID, c.Count, nil))
	return events, nil
}
