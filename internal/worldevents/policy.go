package worldevents

import (
	"fmt"
	"slices"
	"strings"

	"ascendra-game/internal/ai"
	"ascendra-game/internal/ecosystem"
	"ascendra-game/internal/siege"
	"ascendra-game/internal/world"
)

const (
	TemplateGoblinRaid = "goblin-raid-campaign"
	TemplateOrcWarband = "orc-warband-campaign"
)

// DefaultCampaignPolicies defines the provisional data-driven Goblin and Orc campaign policies.
// Both families share identical campaign machinery while diverging on population demand,
// force composition, preparation cadence, threat threshold, leadership weight, and cooldowns.
func DefaultCampaignPolicies() []CampaignPolicyTemplate {
	return []CampaignPolicyTemplate{
		{
			TemplateID:              TemplateGoblinRaid,
			EventKind:               EventGoblinRaidCampaign,
			Family:                  ai.FamilyGoblin,
			MinFreePopulation:       45,
			MinThreatScore:          350,
			ReconTicks:              6,
			PrepTicks:               8,
			WarningTicks:            6,
			DeadlineSlackTicks:      80,
			RecoverTicks:            18,
			RegionCooldownTicks:     55,
			SettlementCooldownTicks: 45,
			ReconArchetype:          "goblin-skirmisher",
			ReconCount:              1,
			MainForces: []ForceUnit{
				{Archetype: "goblin-raider-pack", Count: 1, Position: 11500},
				{Archetype: "goblin-taskmaster", Count: 1, Position: 12000},
			},
			AllowEcologicalReinforcements: true,
			ReinforcementArchetype:        "goblin-skirmisher",
			ReinforcementCount:            1,
			MaxCampaignReinforcements:     2,
			PriorityWeightLeadership:      80,
			PriorityWeightTerritory:       100,
		},
		{
			TemplateID:              TemplateOrcWarband,
			EventKind:               EventOrcWarbandCampaign,
			Family:                  ai.FamilyOrc,
			MinFreePopulation:       65,
			MinThreatScore:          500,
			ReconTicks:              8,
			PrepTicks:               12,
			WarningTicks:            8,
			DeadlineSlackTicks:      100,
			RecoverTicks:            25,
			RegionCooldownTicks:     80,
			SettlementCooldownTicks: 65,
			ReconArchetype:          "orc-vanguard",
			ReconCount:              1,
			MainForces: []ForceUnit{
				{Archetype: "orc-vanguard", Count: 1, Position: 11200},
				{Archetype: "orc-berserker", Count: 1, Position: 11600},
				{Archetype: "orc-warchief", Count: 1, Position: 12000},
			},
			AllowEcologicalReinforcements: true,
			ReinforcementArchetype:        "orc-vanguard",
			ReinforcementCount:            1,
			MaxCampaignReinforcements:     2,
			PriorityWeightLeadership:      220,
			PriorityWeightTerritory:       180,
		},
	}
}

// DefaultSiegeCampaignPolicies returns data-driven Goblin and Orc siege campaign templates
// that extend DefaultCampaignPolicies with population-backed scheduled SiegeWaves.
func DefaultSiegeCampaignPolicies() []CampaignPolicyTemplate {
	base := DefaultCampaignPolicies()
	for i := range base {
		switch base[i].TemplateID {
		case TemplateGoblinRaid:
			base[i].SiegeWaves = []SiegeWaveSpec{
				{WaveTag: "goblin-wave-2", DelayTicks: 18, Archetype: "goblin-skirmisher", Count: 1, EntryZoneID: siege.ZoneIDExteriorField},
			}
		case TemplateOrcWarband:
			base[i].SiegeWaves = []SiegeWaveSpec{
				{WaveTag: "orc-wave-2", DelayTicks: 22, Archetype: "orc-vanguard", Count: 1, EntryZoneID: siege.ZoneIDExteriorField},
			}
		}
	}
	return base
}

// DefaultConfig returns balanced, bounded Cycle 04/05 World Event Director defaults.
func DefaultConfig() Config {
	return Config{
		RulesVersion:                    RulesVersion,
		CandidateEvalIntervalTicks:      5,
		MaxActiveCampaignsGlobal:        3,
		MaxActiveCampaignsPerRegion:     1,
		MaxActiveCampaignsPerSettlement: 1,
		MaxPendingEvents:                32,
		MaxCandidatesPerUpdate:          16,
		MaxChainDepth:                   2,
		MaxEventsPerUpdate:              64,
		MaxEventsPerBatch:               128,
		MaxPendingDirectorEvents:        1024,
		MaxCompletedHistory:             64,
		MaxOutcomesHistory:              64,
		MaxPendingOutcomes:              64,
		MaxPendingContributions:         256,
		MaxPendingDirectorBatches:       256,
		MaxCooldownEntries:              64,
		MaxIdentifierLength:             128,
		MaxSnapshotBytes:                DefaultMaxSnapshotBytes,
		PriorityAgingPerTick:            5,
		MinInvasionIntervalTicks:        40,
		MinSimulatedDefenseHP:           200,
		RequireAvailableDefenders:       false,
		ProtectedRegions:                []string{},
		Policies:                        DefaultCampaignPolicies(),
	}
}

// LookupPolicy finds a configured campaign policy template by TemplateID.
func LookupPolicy(cfg Config, templateID string) (CampaignPolicyTemplate, bool) {
	for _, p := range cfg.Policies {
		if p.TemplateID == templateID {
			return p, true
		}
	}
	return CampaignPolicyTemplate{}, false
}

// LookupPolicyByFamily finds the first configured policy template matching a creature family.
func LookupPolicyByFamily(cfg Config, family ai.Family) (CampaignPolicyTemplate, bool) {
	for _, p := range cfg.Policies {
		if p.Family == family {
			return p, true
		}
	}
	return CampaignPolicyTemplate{}, false
}

// TemplateRequiredContingent calculates the exact abstract population required to reserve
// recon + main forces (+ reinforcement reserve buffer if enabled) for a policy template.
func TemplateRequiredContingent(tpl CampaignPolicyTemplate) (int64, error) {
	total, err := ecosystem.UnitPopulationWeight(tpl.ReconArchetype, tpl.ReconCount)
	if err != nil {
		return 0, err
	}
	for _, fu := range tpl.MainForces {
		w, err := ecosystem.UnitPopulationWeight(fu.Archetype, fu.Count)
		if err != nil {
			return 0, err
		}
		total, err = safeAddInt64(total, w)
		if err != nil {
			return 0, err
		}
	}
	for _, sw := range tpl.SiegeWaves {
		w, err := ecosystem.UnitPopulationWeight(sw.Archetype, sw.Count)
		if err != nil {
			return 0, err
		}
		total, err = safeAddInt64(total, w)
		if err != nil {
			return 0, err
		}
	}
	if tpl.AllowEcologicalReinforcements && tpl.MaxCampaignReinforcements > 0 {
		rw, err := ecosystem.UnitPopulationWeight(tpl.ReinforcementArchetype, tpl.ReinforcementCount)
		if err != nil {
			return 0, err
		}
		for i := 0; i < tpl.MaxCampaignReinforcements; i++ {
			total, err = safeAddInt64(total, rw)
			if err != nil {
				return 0, err
			}
		}
	}
	return total, nil
}

// EvaluateCandidates inspects regional ecological state and generates deterministic,
// prioritized campaign candidates obeying faction hostility, settlement protection,
// cooldowns, camp health, and population availability.
// Neutral or Allied factions NEVER generate hostile invasion candidates regardless of family.
func EvaluateCandidates(
	director DirectorState,
	eco ecosystem.EcosystemState,
	worldState world.WorldState,
	cfg Config,
	availableDefenders int,
) ([]CandidateProposal, error) {
	// Settlement protection rules (Section 22): do not schedule against collapsed or defender-gated settlement.
	if worldState.SettlementDefenseHP < cfg.MinSimulatedDefenseHP {
		return nil, nil
	}
	if cfg.RequireAvailableDefenders && availableDefenders <= 0 {
		return nil, nil
	}
	if !cooldownReady(director.SettlementCooldowns, worldState.SettlementID, director.Tick) {
		return nil, nil
	}
	if hasInFlightCampaignForSettlement(director.Campaigns, worldState.SettlementID) {
		return nil, nil
	}

	// Build region lookup for settlement adjacency bonus.
	settlementRegionID := ""
	regionByID := make(map[string]ecosystem.Region, len(eco.Regions))
	for _, r := range eco.Regions {
		regionByID[r.RegionID] = r
		if r.HasSettlement && r.SettlementID == worldState.SettlementID {
			settlementRegionID = r.RegionID
		}
	}

	factionByID := make(map[string]ecosystem.FactionProfile, len(eco.Factions))
	for _, f := range eco.Factions {
		factionByID[f.FactionID] = f
	}

	candidates := make([]CandidateProposal, 0, len(eco.Populations))
	for _, pop := range eco.Populations {
		if len(candidates) >= cfg.MaxCandidatesPerUpdate {
			break
		}
		if slices.Contains(cfg.ProtectedRegions, pop.RegionID) {
			continue
		}
		if !cooldownReady(director.RegionCooldowns, pop.RegionID, director.Tick) {
			continue
		}
		if hasInFlightCampaignForRegion(director.Campaigns, pop.RegionID) {
			continue
		}
		if hasPendingCampaignForSource(director.PendingEvents, pop.PopulationID) {
			continue
		}

		// Crucial Section 14 rule: ONLY explicitly hostile factions may initiate invasions!
		faction, ok := factionByID[pop.FactionID]
		if !ok || !faction.HostileToSettlement {
			continue
		}

		tpl, ok := LookupPolicyByFamily(cfg, pop.FamilyID)
		if !ok {
			continue
		}
		reg, ok := regionByID[pop.RegionID]
		if !ok {
			continue
		}
		if reg.ThreatScore < tpl.MinThreatScore {
			continue
		}
		if pop.FreePopulation < tpl.MinFreePopulation {
			continue
		}

		reqPop, err := TemplateRequiredContingent(tpl)
		if err != nil {
			return nil, err
		}
		if pop.FreePopulation < reqPop {
			continue
		}

		// Locate strongest operational camp belonging to this population (canonical tie-break by CampID).
		bestCamp, hasCamp := selectBestOperationalCamp(eco.Camps, pop.PopulationID)
		if !hasCamp {
			continue
		}

		// Compute integer scheduling Priority distinct from ecological ThreatScore (Section 10).
		priority, err := computeCandidatePriority(reg, pop, bestCamp, tpl, settlementRegionID, director.Tick)
		if err != nil {
			return nil, err
		}

		candidates = append(candidates, CandidateProposal{
			TemplateID:         tpl.TemplateID,
			EventKind:          tpl.EventKind,
			RegionID:           pop.RegionID,
			SettlementID:       worldState.SettlementID,
			FactionID:          pop.FactionID,
			FamilyID:           pop.FamilyID,
			SourcePopulationID: pop.PopulationID,
			SourceCampID:       bestCamp.CampID,
			Priority:           priority,
			ThreatScore:        reg.ThreatScore,
			RequiredPopulation: reqPop,
		})
	}

	// Deterministic canonical ordering: highest Priority -> highest ThreatScore -> RegionID -> FactionID -> SourcePopulationID.
	slices.SortFunc(candidates, func(a, b CandidateProposal) int {
		if a.Priority != b.Priority {
			if a.Priority > b.Priority {
				return -1
			}
			return 1
		}
		if a.ThreatScore != b.ThreatScore {
			if a.ThreatScore > b.ThreatScore {
				return -1
			}
			return 1
		}
		if c := strings.Compare(a.RegionID, b.RegionID); c != 0 {
			return c
		}
		if c := strings.Compare(a.FactionID, b.FactionID); c != 0 {
			return c
		}
		return strings.Compare(a.SourcePopulationID, b.SourcePopulationID)
	})
	return candidates, nil
}

func computeCandidatePriority(
	reg ecosystem.Region,
	pop ecosystem.Population,
	camp ecosystem.Camp,
	tpl CampaignPolicyTemplate,
	settlementRegionID string,
	tick uint64,
) (int64, error) {
	// Ecological threat base + population headroom + camp readiness + territorial dominance + adjacency.
	prio := reg.ThreatScore
	popBonus := pop.FreePopulation * 2
	if popBonus > 800 {
		popBonus = 800
	}
	campBonus := camp.Capacity + camp.Reserves
	if campBonus > 400 {
		campBonus = 400
	}
	var infBP int64
	for _, inf := range reg.FactionInfluences {
		if inf.FactionID == pop.FactionID {
			infBP = inf.InfluenceBP
			break
		}
	}
	terrBonus := (infBP * tpl.PriorityWeightTerritory) / 10000

	adjBonus := int64(0)
	if reg.RegionID == settlementRegionID {
		adjBonus = 250
	} else if settlementRegionID != "" && slices.Contains(reg.AdjacentRegions, settlementRegionID) {
		adjBonus = 150
	}

	var err error
	for _, add := range []int64{popBonus, campBonus, terrBonus, adjBonus, tpl.PriorityWeightLeadership} {
		prio, err = safeAddInt64(prio, add)
		if err != nil {
			return 0, err
		}
	}
	// Deterministic slight bonus if region is at Critical threat level.
	if reg.ThreatLevel == ecosystem.ThreatCritical {
		prio, err = safeAddInt64(prio, 200)
		if err != nil {
			return 0, err
		}
	}
	_ = tick
	return prio, nil
}

func selectBestOperationalCamp(camps []ecosystem.Camp, popID string) (ecosystem.Camp, bool) {
	var best ecosystem.Camp
	found := false
	for _, c := range camps {
		if c.PopulationID != popID || !c.State.CanSupplyMaterialization() {
			continue
		}
		if !found || c.Capacity > best.Capacity || (c.Capacity == best.Capacity && c.CampID < best.CampID) {
			best = c
			found = true
		}
	}
	return best, found
}

func hasInFlightCampaignForRegion(campaigns []Campaign, regionID string) bool {
	for _, c := range campaigns {
		if c.RegionID == regionID && c.State.IsInFlight() {
			return true
		}
	}
	return false
}

func hasInFlightCampaignForSettlement(campaigns []Campaign, settlementID string) bool {
	for _, c := range campaigns {
		if c.SettlementID == settlementID && c.State.IsInFlight() {
			return true
		}
	}
	return false
}

func hasPendingCampaignForSource(events []ScheduledEvent, popID string) bool {
	for _, ev := range events {
		if !ev.Cancelled && ev.SourcePopulationID == popID {
			return true
		}
	}
	return false
}

func validateDirectCandidate(
	director DirectorState,
	eco ecosystem.EcosystemState,
	cmd DirectorCommand,
	cfg Config,
) (CandidateProposal, error) {
	tpl, ok := LookupPolicy(cfg, cmd.TemplateID)
	if !ok {
		return CandidateProposal{}, fmt.Errorf("%w: unknown campaign template %q", ErrInvalidCommand, cmd.TemplateID)
	}
	if slices.Contains(cfg.ProtectedRegions, cmd.RegionID) {
		return CandidateProposal{}, fmt.Errorf("%w: region %q is protected", ErrProtectedTarget, cmd.RegionID)
	}
	var pop ecosystem.Population
	foundPop := false
	for _, p := range eco.Populations {
		if p.PopulationID == cmd.SourcePopulationID {
			pop = p
			foundPop = true
			break
		}
	}
	if !foundPop || pop.RegionID != cmd.RegionID {
		return CandidateProposal{}, fmt.Errorf("%w: source population %q not found in region %q", ErrInvalidCommand, cmd.SourcePopulationID, cmd.RegionID)
	}
	if pop.FamilyID != tpl.Family {
		return CandidateProposal{}, fmt.Errorf("%w: population family %s != template family %s", ErrInvalidCommand, pop.FamilyID, tpl.Family)
	}
	var faction ecosystem.FactionProfile
	foundFac := false
	for _, f := range eco.Factions {
		if f.FactionID == pop.FactionID {
			faction = f
			foundFac = true
			break
		}
	}
	if !foundFac || !faction.HostileToSettlement {
		return CandidateProposal{}, fmt.Errorf("%w: faction %q is not hostile to settlement", ErrInvalidCommand, pop.FactionID)
	}
	var camp ecosystem.Camp
	foundCamp := false
	for _, c := range eco.Camps {
		if c.CampID == cmd.SourceCampID && c.PopulationID == pop.PopulationID {
			camp = c
			foundCamp = true
			break
		}
	}
	if !foundCamp || !camp.State.CanSupplyMaterialization() {
		return CandidateProposal{}, fmt.Errorf("%w: camp %q is unavailable", ErrInvalidCommand, cmd.SourceCampID)
	}
	reqPop, err := TemplateRequiredContingent(tpl)
	if err != nil {
		return CandidateProposal{}, err
	}
	if pop.FreePopulation < reqPop {
		return CandidateProposal{}, fmt.Errorf("%w: population %q free=%d < required=%d", ecosystem.ErrInsufficientPopulation, pop.PopulationID, pop.FreePopulation, reqPop)
	}
	var threat int64
	for _, r := range eco.Regions {
		if r.RegionID == cmd.RegionID {
			threat = r.ThreatScore
			break
		}
	}
	prio := cmd.Priority
	if prio <= 0 {
		prio = threat + 100
	}
	return CandidateProposal{
		TemplateID:         tpl.TemplateID,
		EventKind:          tpl.EventKind,
		RegionID:           cmd.RegionID,
		SettlementID:       cmd.SettlementID,
		FactionID:          pop.FactionID,
		FamilyID:           pop.FamilyID,
		SourcePopulationID: pop.PopulationID,
		SourceCampID:       camp.CampID,
		Priority:           prio,
		ThreatScore:        threat,
		RequiredPopulation: reqPop,
	}, nil
}
