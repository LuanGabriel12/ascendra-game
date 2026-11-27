package world_test

import (
	"errors"
	"math"
	"testing"

	"ascendra-game/internal/adapters/memory"
	"ascendra-game/internal/world"
)

func mustNewDirectorWorldState(t *testing.T, simID string) (world.WorldState, world.Config) {
	t.Helper()
	reader, err := memory.NewSettlementReader(memory.DefaultSettlementFixtures()...)
	if err != nil {
		t.Fatalf("NewSettlementReader: %v", err)
	}
	st, err := world.NewWorldState(simID, "settlement-valewatch", 77, reader)
	if err != nil {
		t.Fatalf("NewWorldState: %v", err)
	}
	cfg := world.DefaultConfig()
	cfg.OrchestrationMode = world.OrchestrationCampaignDirector
	return st, cfg
}

func TestCommandScopeSeparation(t *testing.T) {
	st, cfg := mustNewDirectorWorldState(t, "cmd-sep")

	// Player gameplay boundary MUST reject every Admin and Director command.
	forbiddenForGameplay := []world.CommandKind{
		world.CmdIncreaseThreat,
		world.CmdSpawnHostileGroup,
		world.CmdForceInvasionTransition,
		world.CmdDirectorPrepareInvasion,
		world.CmdDirectorStartInvasion,
		world.CmdDirectorSpawnCampaignGroup,
		world.CmdDirectorResetResolvedInvasion,
		world.CmdDirectorAbortPreparedInvasion,
		world.CommandKind("BogusCommand"),
	}
	beforeSum, err := st.Checksum()
	if err != nil {
		t.Fatalf("Checksum: %v", err)
	}
	for _, kind := range forbiddenForGameplay {
		_, _, err := world.StepGameplay(st, []world.GameplayCommand{
			{Kind: kind, Tick: 1, PlayerID: "player-1"},
		}, cfg)
		if !errors.Is(err, world.ErrUnauthorizedCommand) {
			t.Fatalf("expected ErrUnauthorizedCommand for gameplay command %q, got %v", kind, err)
		}
	}
	afterSum, _ := st.Checksum()
	if beforeSum != afterSum {
		t.Fatalf("failed StepGameplay mutated caller state")
	}

	// Director boundary MUST reject Admin and Gameplay commands.
	_, _, err = world.StepWithDirector(st, nil, []world.DirectorCommand{
		{Kind: world.CmdIncreaseThreat, Tick: 1},
	}, cfg)
	if !errors.Is(err, world.ErrUnauthorizedCommand) {
		t.Fatalf("expected ErrUnauthorizedCommand for admin kind in DirectorCommand, got %v", err)
	}

	// AdminCommand wrapper rejects gameplay and director kinds.
	if _, err := (world.AdminCommand{Kind: world.CmdDeployDefender, Tick: 1}).ToCommand(); !errors.Is(err, world.ErrUnauthorizedCommand) {
		t.Fatalf("expected ErrUnauthorizedCommand for gameplay kind in AdminCommand, got %v", err)
	}
	if _, err := (world.AdminCommand{Kind: world.CmdIncreaseThreat, Tick: 1, Delta: 100}).ToCommand(); err != nil {
		t.Fatalf("expected valid AdminCommand, got %v", err)
	}

	// Valid GameplayCommand executes cleanly.
	next, _, err := world.StepGameplay(st, []world.GameplayCommand{
		{Kind: world.CmdDeployDefender, Tick: 1, PlayerID: "player-1", Position: 2500},
	}, cfg)
	if err != nil {
		t.Fatalf("valid StepGameplay failed: %v", err)
	}
	if len(next.Defenders) != 1 || next.Defenders[0].PlayerID != "player-1" {
		t.Fatalf("expected defender deployed, got %+v", next.Defenders)
	}
}

func TestSingleInvasionAuthorityInCampaignDirectorMode(t *testing.T) {
	st, cfg := mustNewDirectorWorldState(t, "single-auth")
	// Even with maximum regional threat, CampaignDirector mode MUST NEVER auto-start invasions.
	st.RegionalThreat = cfg.MaxThreat

	cur := st
	for tick := uint64(1); tick <= 10; tick++ {
		var err error
		cur, _, err = world.StepGameplay(cur, nil, cfg)
		if err != nil {
			t.Fatalf("tick %d failed: %v", tick, err)
		}
		if cur.Invasion.State != world.InvasionPeace {
			t.Fatalf("tick %d: CampaignDirector mode autonomously transitioned invasion to %s", tick, cur.Invasion.State)
		}
	}

	// Director explicitly prepares invasion (Peace -> Threatened).
	cur, _, err := world.StepWithDirector(cur, nil, []world.DirectorCommand{
		{
			Kind:              world.CmdDirectorPrepareInvasion,
			Tick:              cur.Tick + 1,
			CampaignID:        "cmp:test:000001",
			InvadingFactionID: "faction-goblins",
		},
	}, cfg)
	if err != nil {
		t.Fatalf("DirectorPrepareInvasion failed: %v", err)
	}
	if cur.Invasion.State != world.InvasionThreatened || cur.Invasion.CampaignID != "cmp:test:000001" {
		t.Fatalf("unexpected invasion record after prepare: %+v", cur.Invasion)
	}

	// Decaying threat to 0 in CampaignDirector mode MUST NOT auto-revert Threatened -> Peace.
	cur.RegionalThreat = 1
	cur, _, err = world.StepGameplay(cur, nil, cfg)
	if err != nil {
		t.Fatalf("StepGameplay decay tick failed: %v", err)
	}
	if cur.Invasion.State != world.InvasionThreatened {
		t.Fatalf("Threatened auto-reverted in CampaignDirector mode: got %s", cur.Invasion.State)
	}

	// Explicit abort returns Threatened -> Peace and clears CampaignID.
	cur, _, err = world.StepWithDirector(cur, nil, []world.DirectorCommand{
		{
			Kind:       world.CmdDirectorAbortPreparedInvasion,
			Tick:       cur.Tick + 1,
			CampaignID: "cmp:test:000001",
		},
	}, cfg)
	if err != nil {
		t.Fatalf("DirectorAbortPreparedInvasion failed: %v", err)
	}
	if cur.Invasion.State != world.InvasionPeace || cur.Invasion.CampaignID != "" {
		t.Fatalf("expected clean Peace state after abort, got %+v", cur.Invasion)
	}
}

func TestDurableMonotonicIDsAndOverflowProtection(t *testing.T) {
	st, cfg := mustNewDirectorWorldState(t, "durable-ids")

	id1, err := world.NextDurableGroupID(&st, "cmp:1", "recon", cfg.MaxIdentifierLength)
	if err != nil {
		t.Fatalf("NextDurableGroupID 1: %v", err)
	}
	id2, err := world.NextDurableGroupID(&st, "cmp:1", "recon", cfg.MaxIdentifierLength)
	if err != nil {
		t.Fatalf("NextDurableGroupID 2: %v", err)
	}
	if id1 == id2 || st.GroupSeq != 2 {
		t.Fatalf("expected strictly monotonic group IDs, got %q and %q (seq=%d)", id1, id2, st.GroupSeq)
	}

	// GroupSeq overflow protection.
	st.GroupSeq = math.MaxUint64
	if _, err := world.NextDurableGroupID(&st, "cmp:1", "recon", cfg.MaxIdentifierLength); !errors.Is(err, world.ErrNumericOverflow) {
		t.Fatalf("expected ErrNumericOverflow on GroupSeq max, got %v", err)
	}

	// InvasionSeq monotonicity across reset (never reopens old InvasionID).
	st2, cfg2 := mustNewDirectorWorldState(t, "inv-reset")
	oldInvID := st2.Invasion.InvasionID
	st2.Invasion.State = world.InvasionResolved
	st2.Invasion.Outcome = "Defended"

	next, _, err := world.StepWithDirector(st2, nil, []world.DirectorCommand{
		{Kind: world.CmdDirectorResetResolvedInvasion, Tick: 1},
	}, cfg2)
	if err != nil {
		t.Fatalf("ResetResolvedInvasion failed: %v", err)
	}
	if next.Invasion.InvasionID == oldInvID || next.InvasionSeq != 2 || next.Invasion.Sequence != 2 {
		t.Fatalf("expected fresh monotonic InvasionID, old=%q new=%+v", oldInvID, next.Invasion)
	}

	// InvasionSeq overflow protection.
	next.Invasion.State = world.InvasionResolved
	next.Invasion.Outcome = "Defended"
	next.InvasionSeq = math.MaxUint64
	if _, _, err := world.StepWithDirector(next, nil, []world.DirectorCommand{
		{Kind: world.CmdDirectorResetResolvedInvasion, Tick: 2},
	}, cfg2); !errors.Is(err, world.ErrNumericOverflow) {
		t.Fatalf("expected ErrNumericOverflow on InvasionSeq max, got %v", err)
	}
}

func TestDirectorRejectsForeignCampaignAndMissingCaller(t *testing.T) {
	st, cfg := mustNewDirectorWorldState(t, "owner-guards")
	st, _, err := world.StepWithDirector(st, nil, []world.DirectorCommand{{Kind: world.CmdDirectorPrepareInvasion, Tick: 1, CampaignID: "owner", InvadingFactionID: "faction"}}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	for _, cmd := range []world.DirectorCommand{
		{Kind: world.CmdDirectorAbortPreparedInvasion, Tick: 2},
		{Kind: world.CmdDirectorAbortPreparedInvasion, Tick: 2, CampaignID: "other"},
		{Kind: world.CmdDirectorStartInvasion, Tick: 2, CampaignID: "owner", InvadingFactionID: "other"},
	} {
		before, _ := st.Checksum()
		if _, _, err := world.StepWithDirector(st, nil, []world.DirectorCommand{cmd}, cfg); err == nil {
			t.Fatalf("accepted command %+v", cmd)
		}
		after, _ := st.Checksum()
		if before != after {
			t.Fatal("failed command mutated state")
		}
	}
	st.Invasion.State = world.InvasionUnderAttack
	before, _ := st.Checksum()
	_, err = world.SpawnCampaignReinforcement(&st, "missing", world.DirectorCommand{Kind: world.CmdDirectorSpawnCampaignGroup, CampaignID: "other", InvadingFactionID: "faction", GroupID: "g", ReservationID: "r", SourcePopulationID: "p", SourceCampID: "c", PopulationWeight: 1, Archetype: "orc-vanguard", Count: 1}, cfg)
	if err == nil {
		t.Fatal("missing caller accepted")
	}
	after, _ := st.Checksum()
	if before != after {
		t.Fatal("failed reinforcement mutated state")
	}
}

func TestDirectorCannotStartWithForeignCampaignGroup(t *testing.T) {
	st, cfg := mustNewDirectorWorldState(t, "foreign-start")
	spawn := world.DirectorCommand{Kind: world.CmdDirectorSpawnCampaignGroup, Tick: 1, CampaignID: "foreign", InvadingFactionID: "faction", GroupID: "foreign-group", Archetype: "goblin-raider-pack", Count: 1, ReservationID: "r", SourcePopulationID: "p", SourceCampID: "c", PopulationWeight: 6}
	st, _, err := world.StepWithDirector(st, nil, []world.DirectorCommand{spawn}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	st, _, err = world.StepWithDirector(st, nil, []world.DirectorCommand{{Kind: world.CmdDirectorPrepareInvasion, Tick: 2, CampaignID: "owner", InvadingFactionID: "faction"}}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = world.StepWithDirector(st, nil, []world.DirectorCommand{{Kind: world.CmdDirectorStartInvasion, Tick: 3, CampaignID: "owner", InvadingFactionID: "faction"}}, cfg)
	if err == nil {
		t.Fatal("foreign group authorized invasion")
	}
}
