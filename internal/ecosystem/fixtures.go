package ecosystem

import (
	"ascendra-game/internal/ai"
	"ascendra-game/internal/simulation"
)

const (
	RegionValewatchVale    = "region-valewatch-vale"
	RegionThornveilForest  = "region-thornveil-forest"
	RegionIronfangFrontier = "region-ironfang-frontier"

	FactionValewatchFreefolk = "faction-valewatch-freefolk"
	FactionThornGoblins      = "faction-thorn-goblins"
	FactionCinderGoblins     = "faction-cinder-goblins"
	FactionIronfangOrcs      = "faction-ironfang-orcs"
)

// NewDefaultEcosystemState constructs the Cycle 03 vertical-slice world with three connected
// original ASCENDRA fixture regions (Vale de Valewatch, Floresta de Thornveil, Fronteira de Ironfang)
// and representative goblin and orc populations.
func NewDefaultEcosystemState(simulationID string, seed uint64) EcosystemState {
	return EcosystemState{
		SimulationID: simulationID,
		Epoch:        0,
		RNG:          simulation.NewDeterministicRNG(seed),
		Factions: []FactionProfile{
			{
				FactionID:           FactionCinderGoblins,
				Name:                "Cinderfang Goblins",
				HostileToSettlement: true,
				DefaultStance:       StanceNeutral,
				Relations: []FactionRelation{
					{TargetFactionID: FactionIronfangOrcs, Stance: StanceNeutral},
					{TargetFactionID: FactionThornGoblins, Stance: StanceHostile},
					{TargetFactionID: FactionValewatchFreefolk, Stance: StanceHostile},
				},
			},
			{
				FactionID:           FactionIronfangOrcs,
				Name:                "Ironfang Warclans",
				HostileToSettlement: true,
				DefaultStance:       StanceHostile,
				Relations: []FactionRelation{
					{TargetFactionID: FactionCinderGoblins, Stance: StanceNeutral},
					{TargetFactionID: FactionThornGoblins, Stance: StanceHostile},
					{TargetFactionID: FactionValewatchFreefolk, Stance: StanceHostile},
				},
			},
			{
				FactionID:           FactionThornGoblins,
				Name:                "Thornveil Goblins",
				HostileToSettlement: true,
				DefaultStance:       StanceNeutral,
				Relations: []FactionRelation{
					{TargetFactionID: FactionCinderGoblins, Stance: StanceHostile},
					{TargetFactionID: FactionIronfangOrcs, Stance: StanceHostile},
					{TargetFactionID: FactionValewatchFreefolk, Stance: StanceHostile},
				},
			},
			{
				FactionID:           FactionValewatchFreefolk,
				Name:                "Valewatch Defenders",
				HostileToSettlement: false,
				DefaultStance:       StanceNeutral,
				Relations: []FactionRelation{
					{TargetFactionID: FactionCinderGoblins, Stance: StanceHostile},
					{TargetFactionID: FactionIronfangOrcs, Stance: StanceHostile},
					{TargetFactionID: FactionThornGoblins, Stance: StanceHostile},
				},
			},
		},
		Regions: []Region{
			{
				RegionID:         RegionIronfangFrontier,
				Name:             "Fronteira de Ironfang",
				Biome:            BiomeFrontier,
				HasSettlement:    false,
				CarryingCapacity: 500,
				AdjacentRegions:  []string{RegionThornveilForest, RegionValewatchVale},
				Resources: ResourcePool{
					Food:  ResourceSlot{Amount: 1100, MaxCapacity: 1500, RegenPerEpoch: 140, RegenRateBP: 900, ExtractionLimit: 500},
					Wood:  ResourceSlot{Amount: 700, MaxCapacity: 1000, RegenPerEpoch: 70, RegenRateBP: 600, ExtractionLimit: 350},
					Stone: ResourceSlot{Amount: 1800, MaxCapacity: 2200, RegenPerEpoch: 40, RegenRateBP: 300, ExtractionLimit: 400},
					Ore:   ResourceSlot{Amount: 2000, MaxCapacity: 2500, RegenPerEpoch: 50, RegenRateBP: 300, ExtractionLimit: 450},
					Water: ResourceSlot{Amount: 950, MaxCapacity: 1300, RegenPerEpoch: 130, RegenRateBP: 1000, ExtractionLimit: 500},
				},
				FactionInfluences: []FactionInfluence{
					{FactionID: FactionIronfangOrcs, InfluenceBP: 8000},
				},
				ThreatScore: 300,
				ThreatLevel: ThreatStable,
				Status:      EcoStatusBalanced,
			},
			{
				RegionID:         RegionThornveilForest,
				Name:             "Floresta de Thornveil",
				Biome:            BiomeForest,
				HasSettlement:    false,
				CarryingCapacity: 600,
				AdjacentRegions:  []string{RegionIronfangFrontier, RegionValewatchVale},
				Resources: ResourcePool{
					Food:  ResourceSlot{Amount: 2200, MaxCapacity: 2600, RegenPerEpoch: 260, RegenRateBP: 1200, ExtractionLimit: 700},
					Wood:  ResourceSlot{Amount: 2000, MaxCapacity: 2500, RegenPerEpoch: 200, RegenRateBP: 1000, ExtractionLimit: 600},
					Stone: ResourceSlot{Amount: 450, MaxCapacity: 700, RegenPerEpoch: 25, RegenRateBP: 300, ExtractionLimit: 200},
					Ore:   ResourceSlot{Amount: 250, MaxCapacity: 400, RegenPerEpoch: 15, RegenRateBP: 200, ExtractionLimit: 150},
					Water: ResourceSlot{Amount: 1600, MaxCapacity: 2000, RegenPerEpoch: 220, RegenRateBP: 1200, ExtractionLimit: 650},
				},
				FactionInfluences: []FactionInfluence{
					{FactionID: FactionThornGoblins, InfluenceBP: 7500},
				},
				ThreatScore: 220,
				ThreatLevel: ThreatStable,
				Status:      EcoStatusThriving,
			},
			{
				RegionID:         RegionValewatchVale,
				Name:             "Vale de Valewatch",
				Biome:            BiomeValley,
				HasSettlement:    true,
				SettlementID:     "settlement-valewatch",
				CarryingCapacity: 380,
				AdjacentRegions:  []string{RegionIronfangFrontier, RegionThornveilForest},
				Resources: ResourcePool{
					Food:  ResourceSlot{Amount: 1300, MaxCapacity: 1700, RegenPerEpoch: 170, RegenRateBP: 1000, ExtractionLimit: 500},
					Wood:  ResourceSlot{Amount: 900, MaxCapacity: 1200, RegenPerEpoch: 110, RegenRateBP: 800, ExtractionLimit: 400},
					Stone: ResourceSlot{Amount: 650, MaxCapacity: 900, RegenPerEpoch: 30, RegenRateBP: 300, ExtractionLimit: 250},
					Ore:   ResourceSlot{Amount: 420, MaxCapacity: 600, RegenPerEpoch: 20, RegenRateBP: 250, ExtractionLimit: 200},
					Water: ResourceSlot{Amount: 1100, MaxCapacity: 1500, RegenPerEpoch: 160, RegenRateBP: 1100, ExtractionLimit: 500},
				},
				FactionInfluences: []FactionInfluence{
					{FactionID: FactionValewatchFreefolk, InfluenceBP: 9000},
				},
				ThreatScore: 80,
				ThreatLevel: ThreatStable,
				Status:      EcoStatusThriving,
			},
		},
		Populations: []Population{
			{
				PopulationID:          "pop-ironfang-orcs",
				RegionID:              RegionIronfangFrontier,
				SpeciesID:             "orc-ironblood",
				FamilyID:              ai.FamilyOrc,
				FactionID:             FactionIronfangOrcs,
				FreePopulation:        85,
				MaterializedPopulation: 0,
				CarryingCapacity:      420,
				GrowthRateBP:          750,  // 7.5%/epoch (provisional)
				MortalityRateBP:       220,  // 2.2%/epoch
				FoodPerCapitaMilli:    2600, // Orcs consume more food & ore per individual
				WoodPerCapitaMilli:    900,
				OrePerCapitaMilli:     1200,
				WaterPerCapitaMilli:   2000,
				StrengthPerIndividual: 24,
				ActiveCampCount:       1,
			},
			{
				PopulationID:          "pop-thornveil-goblins",
				RegionID:              RegionThornveilForest,
				SpeciesID:             "goblin-common",
				FamilyID:              ai.FamilyGoblin,
				FactionID:             FactionThornGoblins,
				FreePopulation:        90,
				MaterializedPopulation: 0,
				CarryingCapacity:      520,
				GrowthRateBP:          1400, // 14%/epoch (higher reproduction)
				MortalityRateBP:       320,  // 3.2%/epoch
				FoodPerCapitaMilli:    1400, // Lower food consumption per individual
				WoodPerCapitaMilli:    800,
				OrePerCapitaMilli:     200,
				WaterPerCapitaMilli:   1100,
				StrengthPerIndividual: 10,
				ActiveCampCount:       1,
			},
		},
		Camps: []Camp{
			{
				CampID:                  "camp-ironfang-bastion",
				RegionID:                RegionIronfangFrontier,
				FactionID:               FactionIronfangOrcs,
				FamilyID:                ai.FamilyOrc,
				PopulationID:            "pop-ironfang-orcs",
				AssignedPopulation:      85,
				Capacity:                110,
				Reserves:                60,
				State:                   CampActive,
				ThreatContribution:      285,
				CreatedEpoch:            0,
				ExpansionCooldownEpochs: 1,
			},
			{
				CampID:                  "camp-thornveil-warren",
				RegionID:                RegionThornveilForest,
				FactionID:               FactionThornGoblins,
				FamilyID:                ai.FamilyGoblin,
				PopulationID:            "pop-thornveil-goblins",
				AssignedPopulation:      70,
				Capacity:                70,
				Reserves:                35,
				State:                   CampActive,
				ThreatContribution:      220,
				CreatedEpoch:            0,
				ExpansionCooldownEpochs: 0,
			},
		},
		CampCooldowns: []CampCooldownRecord{},
		CampSeq:       2,
		PopSeq:        2,
	}
}

// NewScarcityMigrationState prepares Scenario B: Thornveil Forest suffers severe food depletion
// under high goblin density, triggering pressure and conserved migration into an adjacent region.
func NewScarcityMigrationState(simulationID string, seed uint64) EcosystemState {
	st := NewDefaultEcosystemState(simulationID, seed)
	// Put high goblin population into Thornveil with severely reduced food capacity/stock.
	for i := range st.Regions {
		if st.Regions[i].RegionID == RegionThornveilForest {
			st.Regions[i].Resources.Food = ResourceSlot{Amount: 80, MaxCapacity: 300, RegenPerEpoch: 15, RegenRateBP: 200, ExtractionLimit: 80}
			st.Regions[i].CarryingCapacity = 160
		}
	}
	for i := range st.Populations {
		if st.Populations[i].PopulationID == "pop-thornveil-goblins" {
			st.Populations[i].FreePopulation = 180
			st.Populations[i].CarryingCapacity = 160
		}
	}
	return st
}

// NewTerritorialDisputeState prepares Scenario C: Thornveil Goblins and Ironfang Orcs both
// hold active populations and camps inside Vale de Valewatch / Thornveil border, competing for influence.
func NewTerritorialDisputeState(simulationID string, seed uint64) EcosystemState {
	st := NewDefaultEcosystemState(simulationID, seed)
	// Add an Ironfang Orc raiding clan contesting Floresta de Thornveil against Thornveil Goblins.
	st.Populations = append(st.Populations, Population{
		PopulationID:          "pop-thornveil-orcs",
		RegionID:              RegionThornveilForest,
		SpeciesID:             "orc-ironblood",
		FamilyID:              ai.FamilyOrc,
		FactionID:             FactionIronfangOrcs,
		FreePopulation:        65,
		MaterializedPopulation: 0,
		CarryingCapacity:      350,
		GrowthRateBP:          750,
		MortalityRateBP:       220,
		FoodPerCapitaMilli:    2400,
		WoodPerCapitaMilli:    800,
		OrePerCapitaMilli:     1000,
		WaterPerCapitaMilli:   1800,
		StrengthPerIndividual: 24,
		ActiveCampCount:       1,
	})
	// Maintain canonical sorted order by PopulationID.
	// pop-ironfang-orcs < pop-thornveil-goblins < pop-thornveil-orcs (already sorted!).
	st.Camps = append(st.Camps, Camp{
		CampID:                  "camp-thornveil-orc-outpost",
		RegionID:                RegionThornveilForest,
		FactionID:               FactionIronfangOrcs,
		FamilyID:                ai.FamilyOrc,
		PopulationID:            "pop-thornveil-orcs",
		AssignedPopulation:      65,
		Capacity:                90,
		Reserves:                50,
		State:                   CampActive,
		ThreatContribution:      220,
		CreatedEpoch:            0,
		ExpansionCooldownEpochs: 2,
	})
	// Keep Camps strictly sorted: camp-ironfang-bastion < camp-thornveil-orc-outpost < camp-thornveil-warren.
	st.Camps[1], st.Camps[2] = st.Camps[2], st.Camps[1]
	st.CampSeq = 3
	st.PopSeq = 3
	return st
}

// NewRisingThreatState prepares Scenario D: Ironfang Orcs surge inside Ironfang Frontier and
// accumulate camps/reserves until regional threat crosses Critical with event intent emission.
func NewRisingThreatState(simulationID string, seed uint64) EcosystemState {
	st := NewDefaultEcosystemState(simulationID, seed)
	for i := range st.Populations {
		if st.Populations[i].PopulationID == "pop-ironfang-orcs" {
			st.Populations[i].FreePopulation = 240
		}
	}
	for i := range st.Camps {
		if st.Camps[i].CampID == "camp-ironfang-bastion" {
			st.Camps[i].Capacity = 160
			st.Camps[i].Reserves = 220
		}
	}
	return st
}
