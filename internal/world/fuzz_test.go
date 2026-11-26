package world_test

import (
	"testing"

	"ascendra-game/internal/adapters/memory"
	"ascendra-game/internal/world"
)

// FuzzCommandValidation feeds arbitrary untrusted command parameters into Step
// and verifies it never panics, never corrupts input state on error, and always
// preserves WorldState invariants on success.
func FuzzCommandValidation(f *testing.F) {
	f.Add(uint8(0), uint64(1), "p1", "group-vanguard-1", "goblin-raider-pack", int64(1), int64(500), int64(2500), "obj-1", "Threatened")
	f.Add(uint8(1), uint64(1), "", "g-new", "orc-warchief", int64(-5), int64(-10), int64(-50), "", "UnderAttack")
	f.Add(uint8(2), uint64(99), "p1", "unknown", "goblin-skirmisher", int64(999999999999), int64(999999999999), int64(50000), "obj-1", "Resolved")
	f.Add(uint8(3), uint64(1), "p1", "group-vanguard-1", "goblin-taskmaster", int64(1), int64(0), int64(3000), "obj-1", "Peace")
	f.Add(uint8(4), uint64(2), "def-1", "g-orc", "orc-vanguard", int64(2), int64(100), int64(4000), "obj-2", "Peace")

	kinds := []world.CommandKind{
		world.CmdIncreaseThreat,
		world.CmdSpawnHostileGroup,
		world.CmdForceInvasionTransition,
		world.CmdDeployDefender,
		world.CmdPlayerDefendStrike,
		world.CmdPlayerSupportDefense,
		world.CmdCompleteObjective,
		world.CommandKind("InvalidKind"),
	}

	cfg := world.DefaultConfig()
	reader, err := memory.NewSettlementReader(memory.DefaultSettlementFixtures()...)
	if err != nil {
		f.Fatalf("setup reader failed: %v", err)
	}
	basePeace, err := world.NewWorldState("sim-fuzz", "settlement-valewatch", 7, reader)
	if err != nil {
		f.Fatalf("setup state failed: %v", err)
	}
	baseActive, _, err := world.Step(basePeace, []world.Command{
		{Kind: world.CmdIncreaseThreat, Tick: 1, Delta: 1000},
	}, cfg)
	if err != nil {
		f.Fatalf("setup active state failed: %v", err)
	}

	f.Fuzz(func(t *testing.T, kindIdx uint8, tick uint64, playerID, groupID, archetype string, count, delta, position int64, objectiveID, targetState string) {
		kind := kinds[int(kindIdx)%len(kinds)]
		cmd := world.Command{
			Kind:          kind,
			Tick:          tick,
			PlayerID:      playerID,
			TargetGroupID: groupID,
			GroupID:       groupID,
			Archetype:     archetype,
			Count:         count,
			Delta:         delta,
			Position:      position,
			HomePosition:  position,
			ObjectiveID:   objectiveID,
			TargetState:   world.InvasionState(targetState),
		}

		for _, initial := range []world.WorldState{basePeace, baseActive} {
			sumBefore, err := initial.Checksum()
			if err != nil {
				t.Fatalf("initial checksum failed: %v", err)
			}
			next, _, stepErr := world.Step(initial, []world.Command{cmd}, cfg)
			sumAfter, err := initial.Checksum()
			if err != nil || sumBefore != sumAfter {
				t.Fatalf("Step mutated caller state (err=%v)", err)
			}
			if stepErr == nil {
				if err := next.Validate(); err != nil {
					t.Fatalf("Step produced invalid state: %v", err)
				}
			}
		}
	})
}
