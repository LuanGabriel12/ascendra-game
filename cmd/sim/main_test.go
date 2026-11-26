package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestRunAllScenariosStructuredOutputAndSnapshotVerification(t *testing.T) {
	var buf bytes.Buffer
	if err := runAllScenarios(&buf); err != nil {
		t.Fatalf("runAllScenarios failed: %v", err)
	}
	output := buf.String()
	for _, expected := range []string{
		`"simulation_id":"sim-defended-01"`,
		`"simulation_id":"sim-captured-01"`,
		`"simulation_id":"sim-warband-02"`,
		`"simulation_id":"sim-territory-02"`,
		`"simulation_id":"eco-scenario-a-growth"`,
		`"simulation_id":"eco-scenario-b-migration"`,
		`"simulation_id":"eco-scenario-c-dispute"`,
		`"simulation_id":"eco-scenario-d-threat"`,
		`"simulation_id":"eco-scenario-e-materialize"`,
		`"simulation_id":"eco-scenario-f-snapshot"`,
		`"snapshot_verified":true`,
		`"event":"ReinforcementsCalled"`,
		`"event":"TerritoryAlert"`,
		`"event":"PopulationMigrated"`,
		`"event":"RegionalThreatChanged"`,
	} {
		if !strings.Contains(output, expected) {
			t.Fatalf("expected structured log output to contain %s", expected)
		}
	}
}
