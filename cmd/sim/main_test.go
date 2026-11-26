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
		`"snapshot_verified":true`,
		`"event":"ReinforcementsCalled"`,
		`"event":"TerritoryAlert"`,
	} {
		if !strings.Contains(output, expected) {
			t.Fatalf("expected structured log output to contain %s", expected)
		}
	}
}
