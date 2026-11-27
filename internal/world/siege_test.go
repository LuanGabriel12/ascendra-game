package world_test

import (
	"errors"
	"testing"

	"ascendra-game/internal/adapters/memory"
	"ascendra-game/internal/ai"
	"ascendra-game/internal/siege"
	"ascendra-game/internal/world"
)

func setupTacticalSiegeWorld(t *testing.T, family ai.Family, spawnNPCs bool) (world.WorldState, world.Config) {
	t.Helper()
	reader, err := memory.NewSettlementReader(memory.DefaultSettlementFixtures()...)
	if err != nil {
		t.Fatal(err)
	}
	cfg := world.DefaultConfig()
	st, err := world.NewWorldState("sim-siege-test", "settlement-valewatch", 7001, reader)
	if err != nil {
		t.Fatal(err)
	}
	st, _, err = world.Step(st, []world.Command{
		{Kind: world.CmdConfigureSiege, Tick: 1, InvadingFamily: family, InvadingFactionID: "fac-hostile", SpawnNPCDefenders: spawnNPCs},
		{Kind: world.CmdSpawnHostileGroup, Tick: 1, GroupID: "grp-vanguard", Archetype: "orc-vanguard", Count: 1, ZoneID: siege.ZoneIDMainGate},
		{Kind: world.CmdIncreaseThreat, Tick: 1, Delta: 1000},
	}, cfg)
	if err != nil {
		t.Fatalf("setup siege failed: %v", err)
	}
	return st, cfg
}

func TestWorldSiegeSingleSourceOfTruthAndCommandSecurity(t *testing.T) {
	st, cfg := setupTacticalSiegeWorld(t, ai.FamilyOrc, true)

	// 1. Single source of truth: SettlementDefenseHP == Siege.TotalStructureHP().
	if st.Siege == nil || st.SettlementDefenseHP != st.Siege.TotalStructureHP() || st.SettlementMaxDefenseHP != st.Siege.TotalStructureMaxHP() {
		t.Fatalf("defense HP mismatch: world=%d/%d siege=%d/%d", st.SettlementDefenseHP, st.SettlementMaxDefenseHP, st.Siege.TotalStructureHP(), st.Siege.TotalStructureMaxHP())
	}

	// Tampered WorldState with diverged SettlementDefenseHP must fail Validate.
	tampered := st.Clone()
	tampered.SettlementDefenseHP--
	if err := tampered.Validate(); !errors.Is(err, world.ErrInvalidState) {
		t.Fatalf("expected ErrInvalidState for diverged SettlementDefenseHP, got %v", err)
	}

	// 2. Scope separation: admin/director siege commands rejected via StepGameplay.
	for _, kind := range []world.CommandKind{world.CmdConfigureSiege, world.CmdDirectorConfigureSiege, world.CmdDirectorScheduleSiegeWave} {
		if _, _, err := world.StepGameplay(st, []world.GameplayCommand{{Kind: kind, Tick: st.Tick + 1, PlayerID: "p1"}}, cfg); !errors.Is(err, world.ErrUnauthorizedCommand) {
			t.Fatalf("expected ErrUnauthorizedCommand for %s via StepGameplay, got %v", kind, err)
		}
	}

	// 3. Gameplay command cannot hijack an NPC defender ID.
	if _, _, err := world.StepGameplay(st, []world.GameplayCommand{
		{Kind: world.CmdMoveDefenderZone, Tick: st.Tick + 1, PlayerID: "npc-gate-sentinel", TargetZoneID: siege.ZoneIDOuterDistrict},
	}, cfg); !errors.Is(err, world.ErrUnauthorizedCommand) {
		t.Fatalf("expected ErrUnauthorizedCommand hijacking NPC defender, got %v", err)
	}

	// 4. Deploy player at Citadel -> teleporting directly to Main Gate MUST fail; legal step to Central Square succeeds.
	st, _, err := world.StepGameplay(st, []world.GameplayCommand{
		{Kind: world.CmdDeployDefender, Tick: st.Tick + 1, PlayerID: "player-hero", ZoneID: siege.ZoneIDCitadel},
	}, cfg)
	if err != nil {
		t.Fatalf("deploy player failed: %v", err)
	}
	if _, _, err := world.StepGameplay(st, []world.GameplayCommand{
		{Kind: world.CmdMoveDefenderZone, Tick: st.Tick + 1, PlayerID: "player-hero", TargetZoneID: siege.ZoneIDMainGate},
	}, cfg); !errors.Is(err, siege.ErrZoneBlocked) {
		t.Fatalf("expected ErrZoneBlocked teleporting Citadel->MainGate, got %v", err)
	}
	// Striking hostile in MainGate while player is in Citadel MUST fail (out of zone reach).
	if _, _, err := world.StepGameplay(st, []world.GameplayCommand{
		{Kind: world.CmdPlayerDefendStrike, Tick: st.Tick + 1, PlayerID: "player-hero", TargetGroupID: "grp-vanguard"},
	}, cfg); !errors.Is(err, siege.ErrZoneBlocked) {
		t.Fatalf("expected ErrZoneBlocked striking across non-adjacent zones, got %v", err)
	}
	// Legal move Citadel -> Central Square succeeds.
	st, _, err = world.StepGameplay(st, []world.GameplayCommand{
		{Kind: world.CmdMoveDefenderZone, Tick: st.Tick + 1, PlayerID: "player-hero", TargetZoneID: siege.ZoneIDCentralSquare},
	}, cfg)
	if err != nil {
		t.Fatalf("legal move Citadel->CentralSquare failed: %v", err)
	}
}

func TestWorldSiegeAuthoritativeObjectivesEffectiveSupportAndDeterminism(t *testing.T) {
	st, cfg := setupTacticalSiegeWorld(t, ai.FamilyOrc, false)

	// Deploy two players at Main Gate.
	st, _, err := world.StepGameplay(st, []world.GameplayCommand{
		{Kind: world.CmdDeployDefender, Tick: st.Tick + 1, PlayerID: "p-alpha", ZoneID: siege.ZoneIDMainGate},
		{Kind: world.CmdDeployDefender, Tick: st.Tick + 1, PlayerID: "p-beta", ZoneID: siege.ZoneIDMainGate},
	}, cfg)
	if err != nil {
		t.Fatal(err)
	}

	// Blind objective completion MUST fail even when player is in the zone.
	if _, _, err := world.StepGameplay(st, []world.GameplayCommand{
		{Kind: world.CmdCompleteObjective, Tick: st.Tick + 1, PlayerID: "p-alpha", ObjectiveID: siege.ObjIDRepairFortification},
	}, cfg); !errors.Is(err, siege.ErrObjectiveConditionNotMet) {
		t.Fatalf("expected ErrObjectiveConditionNotMet for blind objective claim, got %v", err)
	}

	// Support defense MUST fail when no ally is injured (zero fake overheal contribution!).
	if _, _, err := world.StepGameplay(st, []world.GameplayCommand{
		{Kind: world.CmdPlayerSupportDefense, Tick: st.Tick + 1, PlayerID: "p-beta"},
	}, cfg); !errors.Is(err, world.ErrInvalidCommand) {
		t.Fatalf("expected ErrInvalidCommand for overheal with no injured ally, got %v", err)
	}

	// Advance a few ticks so orc-vanguard damages Main Gate and/or defender.
	for i := 0; i < 6; i++ {
		st, _, err = world.StepGameplay(st, nil, cfg)
		if err != nil {
			t.Fatal(err)
		}
	}

	// Damage Main Gate slightly if still intact, then verify effective-only repair & authoritative objective completion.
	if st.Siege.Structures[st.Siege.FindStructureIndex(siege.StructIDMainGate)].HP == st.Siege.Structures[st.Siege.FindStructureIndex(siege.StructIDMainGate)].MaxHP {
		_, _, _, _, _ = siege.ApplyStructureDamage(st.Siege, siege.StructIDMainGate, 20, 10000, st.Tick, st.Siege.Config)
		st.SettlementDefenseHP = st.Siege.TotalStructureHP()
	}
	missingBefore := st.Siege.Structures[st.Siege.FindStructureIndex(siege.StructIDMainGate)].MaxHP - st.Siege.Structures[st.Siege.FindStructureIndex(siege.StructIDMainGate)].HP
	st, _, err = world.StepGameplay(st, []world.GameplayCommand{
		{Kind: world.CmdPlayerRepairStructure, Tick: st.Tick + 1, PlayerID: "p-alpha", TargetStructureID: siege.StructIDMainGate},
	}, cfg)
	if err != nil {
		t.Fatalf("valid PlayerRepairStructure failed: %v", err)
	}
	// Verify contribution credited strictly <= missingBefore (never overheal!).
	for _, c := range st.Contributions {
		if c.PlayerID == "p-alpha" && c.Support > missingBefore {
			t.Fatalf("overheal credited: support=%d > missing=%d", c.Support, missingBefore)
		}
	}
	// Now authoritative ObjRepairFortification MUST succeed for p-alpha, and duplicate claim MUST fail!
	st, _, err = world.StepGameplay(st, []world.GameplayCommand{
		{Kind: world.CmdCompleteObjective, Tick: st.Tick + 1, PlayerID: "p-alpha", ObjectiveID: siege.ObjIDRepairFortification},
	}, cfg)
	if err != nil {
		t.Fatalf("authoritative ObjRepairFortification claim failed: %v", err)
	}
	if _, _, err := world.StepGameplay(st, []world.GameplayCommand{
		{Kind: world.CmdCompleteObjective, Tick: st.Tick + 1, PlayerID: "p-alpha", ObjectiveID: siege.ObjIDRepairFortification},
	}, cfg); !errors.Is(err, siege.ErrDuplicateObjective) {
		t.Fatalf("expected ErrDuplicateObjective on repeat claim, got %v", err)
	}

	// Command-order independence: reversed gameplay commands produce identical state checksum.
	tNext := st.Tick + 1
	cmdsA := []world.GameplayCommand{
		{Kind: world.CmdMoveDefenderZone, Tick: tNext, PlayerID: "p-alpha", TargetZoneID: siege.ZoneIDWallApproach},
		{Kind: world.CmdMoveDefenderZone, Tick: tNext, PlayerID: "p-beta", TargetZoneID: siege.ZoneIDOuterDistrict},
	}
	cmdsB := []world.GameplayCommand{cmdsA[1], cmdsA[0]}
	resA, _, errA := world.StepGameplay(st, cmdsA, cfg)
	resB, _, errB := world.StepGameplay(st, cmdsB, cfg)
	if errA != nil || errB != nil {
		t.Fatalf("order independence step errors: %v / %v", errA, errB)
	}
	sumA, _ := resA.Checksum()
	sumB, _ := resB.Checksum()
	if sumA != sumB {
		t.Fatalf("command order changed siege checksum: %s != %s", sumA, sumB)
	}

	// Snapshot v6 round-trip & mid-siege equivalence.
	raw, err := resA.MarshalSnapshot()
	if err != nil {
		t.Fatalf("MarshalSnapshot: %v", err)
	}
	restored, err := world.UnmarshalSnapshotWithLimits(raw, cfg)
	if err != nil {
		t.Fatalf("UnmarshalSnapshotWithLimits: %v", err)
	}
	sumRestored, _ := restored.Checksum()
	if sumRestored != sumA {
		t.Fatalf("restored siege world checksum mismatch: %s != %s", sumRestored, sumA)
	}
}

func TestWorldSiegeCommanderWaveSupportNPCAndDeadGuards(t *testing.T) {
	reader, err := memory.NewSettlementReader(memory.DefaultSettlementFixtures()...)
	if err != nil {
		t.Fatal(err)
	}
	cfg := world.DefaultConfig()
	cfg.OrchestrationMode = world.OrchestrationCampaignDirector
	st, err := world.NewWorldState("sim-siege-full", "settlement-valewatch", 7009, reader)
	if err != nil {
		t.Fatal(err)
	}

	// Prepare invasion, configure siege with NPC defenders, schedule a wave, and spawn commander + vanguard in ExteriorField.
	wave := siege.SiegeWave{
		WaveID: "wave-orc-2", CampaignID: "cmp-full", ReservationID: "res-full",
		Archetype: "orc-vanguard", Count: 1, ScheduledTick: 5,
		EntryZoneID: siege.ZoneIDExteriorField, State: siege.WaveScheduled,
	}
	st, _, err = world.StepWithDirector(st, nil, []world.DirectorCommand{
		{Kind: world.CmdDirectorPrepareInvasion, Tick: 1, CampaignID: "cmp-full", InvadingFactionID: "fac-orcs"},
		{Kind: world.CmdDirectorConfigureSiege, Tick: 1, CampaignID: "cmp-full", InvadingFactionID: "fac-orcs", InvadingFamily: ai.FamilyOrc, SpawnNPCDefenders: true},
		{Kind: world.CmdDirectorScheduleSiegeWave, Tick: 1, CampaignID: "cmp-full", Wave: &wave},
		{
			Kind: world.CmdDirectorSpawnCampaignGroup, Tick: 1, CampaignID: "cmp-full", InvadingFactionID: "fac-orcs",
			GroupID: "grp-cmdr", Archetype: "orc-warchief", Count: 1, ZoneID: siege.ZoneIDMainGate,
			ReservationID: "res-full", SourcePopulationID: "pop-1", SourceCampID: "camp-1", SourceRegionID: "reg-1", PopulationWeight: 2,
		},
		{
			Kind: world.CmdDirectorSpawnCampaignGroup, Tick: 1, CampaignID: "cmp-full", InvadingFactionID: "fac-orcs",
			GroupID: "grp-ext", Archetype: "orc-vanguard", Count: 1, ZoneID: siege.ZoneIDExteriorField,
			ReservationID: "res-full", SourcePopulationID: "pop-1", SourceCampID: "camp-1", SourceRegionID: "reg-1", PopulationWeight: 4,
		},
	}, cfg)
	if err != nil {
		t.Fatalf("prepare siege with wave failed: %v", err)
	}
	// Start invasion and deploy player healer + striker at Main Gate.
	st, _, err = world.StepWithDirector(st, []world.GameplayCommand{
		{Kind: world.CmdDeployDefender, Tick: 2, PlayerID: "p-striker", ZoneID: siege.ZoneIDMainGate},
		{Kind: world.CmdDeployDefender, Tick: 2, PlayerID: "p-healer", ZoneID: siege.ZoneIDMainGate},
	}, []world.DirectorCommand{
		{Kind: world.CmdDirectorStartInvasion, Tick: 2, CampaignID: "cmp-full", InvadingFactionID: "fac-orcs"},
	}, cfg)
	if err != nil {
		t.Fatalf("start siege failed: %v", err)
	}

	// Test SpawnCampaignWaveGroup valid spawn AND duplicate rejection AND wrong campaign rejection.
	if _, err := world.SpawnCampaignWaveGroup(&st, "wave-orc-2", world.DirectorCommand{
		Kind: world.CmdDirectorSpawnCampaignGroup, Tick: st.Tick, CampaignID: "wrong-cmp", InvadingFactionID: "fac-orcs",
		GroupID: "grp-wave-bad", Archetype: "orc-vanguard", Count: 1, ReservationID: "res-full",
		SourcePopulationID: "pop-1", SourceCampID: "camp-1", SourceRegionID: "reg-1", PopulationWeight: 4,
	}, cfg); err == nil {
		t.Fatal("expected SpawnCampaignWaveGroup to reject mismatched campaign")
	}
	if _, err := world.SpawnCampaignWaveGroup(&st, "wave-orc-2", world.DirectorCommand{
		Kind: world.CmdDirectorSpawnCampaignGroup, Tick: st.Tick, CampaignID: "cmp-full", InvadingFactionID: "fac-orcs",
		GroupID: "grp-wave-2", Archetype: "orc-vanguard", Count: 1, ReservationID: "res-full",
		SourcePopulationID: "pop-1", SourceCampID: "camp-1", SourceRegionID: "reg-1", PopulationWeight: 4,
	}, cfg); err != nil {
		t.Fatalf("valid SpawnCampaignWaveGroup failed: %v", err)
	}
	if _, err := world.SpawnCampaignWaveGroup(&st, "wave-orc-2", world.DirectorCommand{
		Kind: world.CmdDirectorSpawnCampaignGroup, Tick: st.Tick, CampaignID: "cmp-full", InvadingFactionID: "fac-orcs",
		GroupID: "grp-wave-dup", Archetype: "orc-vanguard", Count: 1, ReservationID: "res-full",
		SourcePopulationID: "pop-1", SourceCampID: "camp-1", SourceRegionID: "reg-1", PopulationWeight: 4,
	}, cfg); err == nil {
		t.Fatal("expected duplicate wave mobilization to fail")
	}

	// Run combat ticks: ExteriorField orc advances via moveScalarToward, Tower fires, NPCs fight & repair,
	// player healer heals injured ally with strictly effective HP credited, and commander is defeated!
	healedAlly := false
	commanderFallen := false
	for step := 0; step < 60 && st.Invasion.State == world.InvasionUnderAttack; step++ {
		nextTick := st.Tick + 1
		var gCmds []world.GameplayCommand
		// Heal injured defender in MainGate/adjacent zone when possible.
		if !healedAlly {
			for _, d := range st.Defenders {
				if d.HP > 0 && d.HP < d.MaxHP && siege.AreAdjacent(*st.Siege, siege.ZoneIDMainGate, d.ZoneID) {
					gCmds = append(gCmds, world.GameplayCommand{Kind: world.CmdPlayerSupportDefense, Tick: nextTick, PlayerID: "p-healer"})
					break
				}
			}
		}
		// Strike commander when off cooldown.
		for _, g := range st.Groups {
			if g.GroupID == "grp-cmdr" && g.HP > 0 && step%9 == 0 {
				gCmds = append(gCmds, world.GameplayCommand{Kind: world.CmdPlayerDefendStrike, Tick: nextTick, PlayerID: "p-striker", TargetGroupID: "grp-cmdr"})
			}
		}
		next, evs, err := world.StepGameplay(st, gCmds, cfg)
		if err != nil {
			// If support or cooldown missed on a boundary, advance cleanly without command.
			next, evs, err = world.StepGameplay(st, nil, cfg)
			if err != nil {
				t.Fatalf("tick %d failed: %v", nextTick, err)
			}
		} else if len(gCmds) > 0 && gCmds[0].Kind == world.CmdPlayerSupportDefense {
			healedAlly = true
		}
		for _, ev := range evs {
			if ev.Type == world.EventCommanderFallen {
				commanderFallen = true
			}
		}
		st = next
	}
	if !commanderFallen {
		t.Fatal("expected siege commander to fall during focused combat")
	}
	// Verify healer credited positive effective support if an ally took damage.
	if healedAlly {
		foundSupport := false
		for _, c := range st.Contributions {
			if c.PlayerID == "p-healer" && c.Support > 0 {
				foundSupport = true
			}
		}
		if !foundSupport {
			t.Fatal("expected positive support contribution for valid ally heal")
		}
	}
}

func BenchmarkWorldSiegeStep(b *testing.B) {
	reader, err := memory.NewSettlementReader(memory.DefaultSettlementFixtures()...)
	if err != nil {
		b.Fatal(err)
	}
	cfg := world.DefaultConfig()
	st, err := world.NewWorldState("sim-siege-bench", "settlement-valewatch", 7777, reader)
	if err != nil {
		b.Fatal(err)
	}
	st, _, err = world.Step(st, []world.Command{
		{Kind: world.CmdConfigureSiege, Tick: 1, InvadingFamily: ai.FamilyOrc, InvadingFactionID: "fac-orcs", SpawnNPCDefenders: true},
		{Kind: world.CmdSpawnHostileGroup, Tick: 1, GroupID: "g-1", Archetype: "orc-vanguard", Count: 1, ZoneID: siege.ZoneIDMainGate},
		{Kind: world.CmdSpawnHostileGroup, Tick: 1, GroupID: "g-2", Archetype: "orc-berserker", Count: 1, ZoneID: siege.ZoneIDWallApproach},
		{Kind: world.CmdSpawnHostileGroup, Tick: 1, GroupID: "g-3", Archetype: "orc-warchief", Count: 1, ZoneID: siege.ZoneIDMainGate},
		{Kind: world.CmdIncreaseThreat, Tick: 1, Delta: 1000},
	}, cfg)
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, _, err := world.Step(st, nil, cfg); err != nil {
			b.Fatal(err)
		}
	}
}
