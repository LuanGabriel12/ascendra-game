package world

import (
	"errors"
	"fmt"
)

// ErrUnauthorizedCommand is returned when a caller submits a command outside its authorized scope
// (e.g., an administrative or director command submitted through the player gameplay boundary).
var ErrUnauthorizedCommand = errors.New("command not permitted in caller scope")

// CommandScope explicitly partitions command authority between Player Gameplay,
// World Event Director orchestration, and Administrative test/fixture harness operations.
type CommandScope string

const (
	ScopeGameplay CommandScope = "Gameplay"
	ScopeDirector CommandScope = "Director"
	ScopeAdmin    CommandScope = "Admin"
)

// ScopeOf returns the authoritative scope required to execute a CommandKind.
func ScopeOf(kind CommandKind) CommandScope {
	switch kind {
	case CmdDeployDefender, CmdPlayerDefendStrike, CmdPlayerSupportDefense, CmdCompleteObjective:
		return ScopeGameplay
	case CmdDirectorPrepareInvasion, CmdDirectorStartInvasion, CmdDirectorSpawnCampaignGroup, CmdDirectorResetResolvedInvasion, CmdDirectorAbortPreparedInvasion:
		return ScopeDirector
	case CmdIncreaseThreat, CmdSpawnHostileGroup, CmdForceInvasionTransition:
		return ScopeAdmin
	default:
		return ""
	}
}

// GameplayCommand restricts external player/client input strictly to player gameplay intentions.
// It can NEVER be coerced into administrative or director authority.
type GameplayCommand struct {
	Kind          CommandKind `json:"kind"`
	Tick          uint64      `json:"tick"`
	PlayerID      string      `json:"player_id"`
	TargetGroupID string      `json:"target_group_id,omitempty"`
	Position      int64       `json:"position,omitempty"`
	ObjectiveID   string      `json:"objective_id,omitempty"`
}

// ToCommand validates that the GameplayCommand belongs exclusively to ScopeGameplay.
func (g GameplayCommand) ToCommand() (Command, error) {
	if ScopeOf(g.Kind) != ScopeGameplay {
		return Command{}, fmt.Errorf("%w: %q is not a gameplay command", ErrUnauthorizedCommand, g.Kind)
	}
	return Command{
		Kind:          g.Kind,
		Tick:          g.Tick,
		PlayerID:      g.PlayerID,
		TargetGroupID: g.TargetGroupID,
		Position:      g.Position,
		ObjectiveID:   g.ObjectiveID,
	}, nil
}

// DirectorCommand represents authoritative orchestration directives issued solely by
// the World Event Director (internal/worldevents) into the Tactical World Engine.
type DirectorCommand struct {
	Kind               CommandKind `json:"kind"`
	Tick               uint64      `json:"tick"`
	CampaignID         string      `json:"campaign_id,omitempty"`
	InvadingFactionID  string      `json:"invading_faction_id,omitempty"`
	GroupID            string      `json:"group_id,omitempty"`
	Archetype          string      `json:"archetype,omitempty"`
	Count              int64       `json:"count,omitempty"`
	Position           int64       `json:"position,omitempty"`
	HomePosition       int64       `json:"home_position,omitempty"`
	ReservationID      string      `json:"reservation_id,omitempty"`
	SourcePopulationID string      `json:"source_population_id,omitempty"`
	SourceCampID       string      `json:"source_camp_id,omitempty"`
	SourceRegionID     string      `json:"source_region_id,omitempty"`
	PopulationWeight   int64       `json:"population_weight,omitempty"`
}

// ToCommand validates that the DirectorCommand belongs exclusively to ScopeDirector.
func (d DirectorCommand) ToCommand() (Command, error) {
	if ScopeOf(d.Kind) != ScopeDirector {
		return Command{}, fmt.Errorf("%w: %q is not a director command", ErrUnauthorizedCommand, d.Kind)
	}
	return Command{
		Kind:               d.Kind,
		Tick:               d.Tick,
		CampaignID:         d.CampaignID,
		InvadingFactionID:  d.InvadingFactionID,
		GroupID:            d.GroupID,
		Archetype:          d.Archetype,
		Count:              d.Count,
		Position:           d.Position,
		HomePosition:       d.HomePosition,
		ReservationID:      d.ReservationID,
		SourcePopulationID: d.SourcePopulationID,
		SourceCampID:       d.SourceCampID,
		SourceRegionID:     d.SourceRegionID,
		PopulationWeight:   d.PopulationWeight,
	}, nil
}

// AdminCommand represents privileged harness/fixture commands for tests and dev tooling.
type AdminCommand struct {
	Kind         CommandKind   `json:"kind"`
	Tick         uint64        `json:"tick"`
	GroupID      string        `json:"group_id,omitempty"`
	Archetype    string        `json:"archetype,omitempty"`
	Count        int64         `json:"count,omitempty"`
	Position     int64         `json:"position,omitempty"`
	HomePosition int64         `json:"home_position,omitempty"`
	Delta        int64         `json:"delta,omitempty"`
	Source       string        `json:"source,omitempty"`
	TargetState  InvasionState `json:"target_state,omitempty"`
}

// ToCommand validates that the AdminCommand belongs exclusively to ScopeAdmin.
func (a AdminCommand) ToCommand() (Command, error) {
	if ScopeOf(a.Kind) != ScopeAdmin {
		return Command{}, fmt.Errorf("%w: %q is not an administrative command", ErrUnauthorizedCommand, a.Kind)
	}
	return Command{
		Kind:         a.Kind,
		Tick:         a.Tick,
		GroupID:      a.GroupID,
		Archetype:    a.Archetype,
		Count:        a.Count,
		Position:     a.Position,
		HomePosition: a.HomePosition,
		Delta:        a.Delta,
		Source:       a.Source,
		TargetState:  a.TargetState,
	}, nil
}

// StepGameplay advances one tactical tick accepting ONLY player GameplayCommands.
// Any administrative or director command is explicitly rejected with ErrUnauthorizedCommand.
func StepGameplay(state WorldState, gameplayCmds []GameplayCommand, cfg Config) (WorldState, []DomainEvent, error) {
	cmds := make([]Command, 0, len(gameplayCmds))
	for _, gc := range gameplayCmds {
		c, err := gc.ToCommand()
		if err != nil {
			return WorldState{}, nil, err
		}
		cmds = append(cmds, c)
	}
	return Step(state, cmds, cfg)
}

// StepWithDirector advances one tactical tick accepting validated GameplayCommands alongside
// explicit DirectorCommands from the World Event Director. Administrative commands are rejected.
func StepWithDirector(
	state WorldState,
	gameplayCmds []GameplayCommand,
	directorCmds []DirectorCommand,
	cfg Config,
) (WorldState, []DomainEvent, error) {
	cmds := make([]Command, 0, len(gameplayCmds)+len(directorCmds))
	for _, dc := range directorCmds {
		c, err := dc.ToCommand()
		if err != nil {
			return WorldState{}, nil, err
		}
		cmds = append(cmds, c)
	}
	for _, gc := range gameplayCmds {
		c, err := gc.ToCommand()
		if err != nil {
			return WorldState{}, nil, err
		}
		cmds = append(cmds, c)
	}
	return Step(state, cmds, cfg)
}
