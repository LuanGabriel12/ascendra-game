package ecosystem_test

import (
	"errors"
	"fmt"
	"math"
	"testing"

	"ascendra-game/internal/ecosystem"
)

func TestIdempotentReservationsConservationAndNoCrossContamination(t *testing.T) {
	cfg := ecosystem.DefaultConfig()
	st := ecosystem.NewDefaultEcosystemState("test-res-idemp", 401)
	initFree, initRes, initMat := ecosystem.TotalPopulationLedger(st)
	if initRes != 0 || initMat != 0 {
		t.Fatalf("unexpected initial ledger: (%d,%d,%d)", initFree, initRes, initMat)
	}

	// 1. Create Reservation A (18 goblins) and Reservation B (12 goblins) on the same population.
	reqA := ecosystem.ReservationRequest{
		IdempotencyKey: "idem-camp-A",
		CampaignID:     "cmp-A",
		CampID:         "camp-thornveil-warren",
		Amount:         18,
		CreatedTick:    10,
		ExpiryTick:     60,
	}
	resA, evA, createdA, err := ecosystem.CreateReservation(&st, reqA, cfg)
	if err != nil || !createdA || evA.Type != ecosystem.EventPopulationReserved {
		t.Fatalf("CreateReservation A failed: created=%v err=%v", createdA, err)
	}

	// Repeating identical IdempotencyKey is a pure no-op (zero double reservation!).
	resADup, _, createdDup, err := ecosystem.CreateReservation(&st, reqA, cfg)
	if err != nil || createdDup || resADup.ReservationID != resA.ReservationID {
		t.Fatalf("expected idempotent no-op for duplicate key, got created=%v id=%s err=%v", createdDup, resADup.ReservationID, err)
	}

	// Reusing IdempotencyKey with conflicting parameters MUST fail with ErrReservationConflict.
	conflictReq := reqA
	conflictReq.Amount = 24
	if _, _, _, err := ecosystem.CreateReservation(&st, conflictReq, cfg); !errors.Is(err, ecosystem.ErrReservationConflict) {
		t.Fatalf("expected ErrReservationConflict, got %v", err)
	}

	reqB := ecosystem.ReservationRequest{
		IdempotencyKey: "idem-camp-B",
		CampaignID:     "cmp-B",
		CampID:         "camp-thornveil-warren",
		Amount:         12,
		CreatedTick:    12,
		ExpiryTick:     70,
	}
	resB, _, createdB, err := ecosystem.CreateReservation(&st, reqB, cfg)
	if err != nil || !createdB || resB.ReservationID == resA.ReservationID {
		t.Fatalf("CreateReservation B failed: %v", err)
	}

	f, r, m := ecosystem.TotalPopulationLedger(st)
	if f != initFree-30 || r != 30 || m != 0 || f+r+m != initFree {
		t.Fatalf("ledger mismatch after two reservations: (%d,%d,%d)", f, r, m)
	}
	if err := st.Validate(cfg); err != nil {
		t.Fatalf("state invalid after reservations: %v", err)
	}

	// 2. Materialize 1 goblin-raider-pack (6) from Reservation A.
	ticketA1, _, err := ecosystem.MaterializeFromReservation(&st, resA.ReservationID, "mat-op-1", "goblin-raider-pack", 1, cfg)
	if err != nil || ticketA1.ContingentSize != 6 || ticketA1.ReservationID != resA.ReservationID {
		t.Fatalf("MaterializeFromReservation A failed: %+v err=%v", ticketA1, err)
	}
	// Duplicate materialization opKey MUST fail with ErrDuplicateReservationOp!
	if _, _, err := ecosystem.MaterializeFromReservation(&st, resA.ReservationID, "mat-op-1", "goblin-raider-pack", 1, cfg); !errors.Is(err, ecosystem.ErrDuplicateReservationOp) {
		t.Fatalf("expected ErrDuplicateReservationOp, got %v", err)
	}
	// Attempting to materialize more than Reservation A's remaining (12) MUST fail without touching Reservation B!
	if _, _, err := ecosystem.MaterializeFromReservation(&st, resA.ReservationID, "mat-op-over", "goblin-raider-pack", 3, cfg); !errors.Is(err, ecosystem.ErrInsufficientPopulation) {
		t.Fatalf("expected ErrInsufficientPopulation on reservation A overshoot, got %v", err)
	}

	// 3. Reconcile defeated contingent from A -> 0 survivors (no resurrection!), duplicate opKey rejected.
	sumDead, _, err := ecosystem.ReconcileReservationContingent(&st, resA.ReservationID, "rec-op-1", 6, 0, 400, true, cfg)
	if err != nil || sumDead.Survivors != 0 || sumDead.Losses != 6 {
		t.Fatalf("ReconcileReservationContingent dead failed: %+v err=%v", sumDead, err)
	}
	if _, _, err := ecosystem.ReconcileReservationContingent(&st, resA.ReservationID, "rec-op-1", 6, 0, 400, true, cfg); !errors.Is(err, ecosystem.ErrDuplicateReservationOp) {
		t.Fatalf("expected ErrDuplicateReservationOp on duplicate reconcile, got %v", err)
	}

	// 4. Cancel Reservation A -> releases ONLY remaining 12 unmaterialized individuals (NOT the 6 casualties, NOT B's 12!).
	released, evRel, err := ecosystem.CancelReservation(&st, resA.ReservationID, false)
	if err != nil || released != 12 || evRel.Type != ecosystem.EventReservationReleased {
		t.Fatalf("CancelReservation A failed: released=%d err=%v", released, err)
	}
	// Duplicate cancel on A is an idempotent no-op returning 0 released!
	releasedDup, _, err := ecosystem.CancelReservation(&st, resA.ReservationID, false)
	if err != nil || releasedDup != 0 {
		t.Fatalf("expected idempotent 0 release on repeat cancel, got released=%d err=%v", releasedDup, err)
	}

	// Verify exact global ledger: initFree - 6 casualties = f + r + m, and B still holds its exact 12 reserved!
	f2, r2, m2 := ecosystem.TotalPopulationLedger(st)
	if f2+r2+m2 != initFree-6 || r2 != 12 || m2 != 0 {
		t.Fatalf("post-cancel conservation failed: (%d,%d,%d) expected total=%d reserved=12", f2, r2, m2, initFree-6)
	}

	// 5. Prune closed Reservation A -> stale ReservationID and retired IdempotencyKey can NEVER be reapplied!
	ecosystem.PruneClosedReservations(&st, 0, cfg.MaxRetiredReservationKeys)
	if _, _, err := ecosystem.MaterializeFromReservation(&st, resA.ReservationID, "mat-stale", "goblin-skirmisher", 1, cfg); !errors.Is(err, ecosystem.ErrUnknownReservation) {
		t.Fatalf("expected ErrUnknownReservation for pruned reservation, got %v", err)
	}
	if _, _, _, err := ecosystem.CreateReservation(&st, reqA, cfg); !errors.Is(err, ecosystem.ErrDuplicateReservation) {
		t.Fatalf("expected ErrDuplicateReservation for pruned idempotency key, got %v", err)
	}

	// 6. Verify snapshot/restore preserves ReservationSeq and Reservation B intact.
	raw, err := st.MarshalSnapshot(cfg)
	if err != nil {
		t.Fatalf("MarshalSnapshot failed: %v", err)
	}
	restored, err := ecosystem.UnmarshalSnapshot(raw, cfg)
	if err != nil {
		t.Fatalf("UnmarshalSnapshot failed: %v", err)
	}
	if restored.ReservationSeq != st.ReservationSeq || len(restored.Reservations) != 1 || restored.Reservations[0].ReservationID != resB.ReservationID {
		t.Fatalf("snapshot did not preserve reservations/seq properly: %+v", restored.Reservations)
	}

	// 7. Sequence overflow guard preserves atomicity.
	stOv := restored.Clone()
	stOv.ReservationSeq = math.MaxUint64
	if _, _, _, err := ecosystem.CreateReservation(&stOv, ecosystem.ReservationRequest{
		CampaignID: "cmp-ov", CampID: "camp-thornveil-warren", Amount: 6, CreatedTick: 20, ExpiryTick: 30,
	}, cfg); !errors.Is(err, ecosystem.ErrNumericOverflow) {
		t.Fatalf("expected ErrNumericOverflow, got %v", err)
	}
}

func TestCompleteReservationAndValidationEdgeCases(t *testing.T) {
	cfg := ecosystem.DefaultConfig()
	st := ecosystem.NewDefaultEcosystemState("res-complete", 505)

	// Enum coverage for all ReservationState values.
	for _, s := range []ecosystem.ReservationState{
		ecosystem.ReservationActive,
		ecosystem.ReservationCompleted,
		ecosystem.ReservationCancelled,
		ecosystem.ReservationExpired,
	} {
		if !s.Valid() || s.Code() == 0 {
			t.Fatalf("expected valid ReservationState %q", s)
		}
	}
	if ecosystem.ReservationState("Invalid").Valid() || ecosystem.ReservationState("Invalid").Code() != 0 {
		t.Fatalf("expected invalid ReservationState")
	}

	// Create reservation of 20, materialize 1x goblin-skirmisher (weight 4), reconcile, then CompleteReservation.
	initFree, _, _ := ecosystem.TotalPopulationLedger(st)
	res, _, created, err := ecosystem.CreateReservation(&st, ecosystem.ReservationRequest{
		IdempotencyKey: "comp-key-1",
		CampaignID:     "cmp-complete-1",
		CampID:         "camp-thornveil-warren",
		Amount:         20,
		CreatedTick:    1,
		ExpiryTick:     100,
	}, cfg)
	if err != nil || !created {
		t.Fatalf("CreateReservation: %v", err)
	}
	ticket, _, err := ecosystem.MaterializeFromReservation(&st, res.ReservationID, "op-m1", "goblin-skirmisher", 1, cfg)
	if err != nil {
		t.Fatalf("MaterializeFromReservation: %v", err)
	}

	// CompleteReservation MUST reject while materialized contingents remain unreconciled.
	if _, _, err := ecosystem.CompleteReservation(&st, res.ReservationID); !errors.Is(err, ecosystem.ErrInvalidState) {
		t.Fatalf("expected ErrInvalidState completing reservation with outstanding materialized troops, got %v", err)
	}

	// Reconcile full survivors (hp=maxHP -> 0 casualties) -> RemainingReserved is still 16!
	if _, _, err := ecosystem.ReconcileReservationContingent(&st, res.ReservationID, "op-r1", ticket.ContingentSize, 100, 100, false, cfg); err != nil {
		t.Fatalf("ReconcileReservationContingent: %v", err)
	}
	released, ev, err := ecosystem.CompleteReservation(&st, res.ReservationID)
	if err != nil || released != 20-ticket.ContingentSize || ev.Type != ecosystem.EventReservationReleased {
		t.Fatalf("CompleteReservation unexpected result: rel=%d ev=%+v err=%v", released, ev, err)
	}
	// Idempotent repeat of CompleteReservation returns 0 with nil error.
	released2, _, err := ecosystem.CompleteReservation(&st, res.ReservationID)
	if err != nil || released2 != 0 {
		t.Fatalf("idempotent CompleteReservation failed: rel=%d err=%v", released2, err)
	}
	// Cancelling an already-completed reservation MUST fail cleanly.
	if _, _, err := ecosystem.CancelReservation(&st, res.ReservationID, false); !errors.Is(err, ecosystem.ErrReservationClosed) {
		t.Fatalf("expected ErrReservationClosed cancelling completed reservation, got %v", err)
	}
	freeAfter, resAfter, matAfter := ecosystem.TotalPopulationLedger(st)
	if freeAfter != initFree || resAfter != 0 || matAfter != 0 {
		t.Fatalf("ledger mismatch: init=%d after=(%d,%d,%d)", initFree, freeAfter, resAfter, matAfter)
	}

	// Error edge cases: nil state, unknown reservation, invalid requests, validation errors.
	if _, _, _, err := ecosystem.CreateReservation(nil, ecosystem.ReservationRequest{}, cfg); err == nil {
		t.Fatalf("expected nil state error on CreateReservation")
	}
	if _, _, _, err := ecosystem.CreateReservation(&st, ecosystem.ReservationRequest{CampaignID: "", CampID: "camp-thornveil-warren", Amount: 5, CreatedTick: 1, ExpiryTick: 10}, cfg); err == nil {
		t.Fatalf("expected empty campaign_id error")
	}
	if _, _, _, err := ecosystem.CreateReservation(&st, ecosystem.ReservationRequest{CampaignID: "c", CampID: "camp-missing", Amount: 5, CreatedTick: 1, ExpiryTick: 10}, cfg); err == nil {
		t.Fatalf("expected unknown camp error")
	}
	if _, _, _, err := ecosystem.CreateReservation(&st, ecosystem.ReservationRequest{CampaignID: "c", CampID: "camp-thornveil-warren", Amount: 0, CreatedTick: 1, ExpiryTick: 10}, cfg); err == nil {
		t.Fatalf("expected zero amount error")
	}
	if _, _, err := ecosystem.MaterializeFromReservation(nil, "x", "op", "goblin-skirmisher", 1, cfg); err == nil {
		t.Fatalf("expected nil state error on MaterializeFromReservation")
	}
	if _, _, err := ecosystem.MaterializeFromReservation(&st, "res-missing", "op", "goblin-skirmisher", 1, cfg); !errors.Is(err, ecosystem.ErrUnknownReservation) {
		t.Fatalf("expected ErrUnknownReservation on MaterializeFromReservation, got %v", err)
	}
	if _, _, err := ecosystem.MaterializeFromReservation(&st, res.ReservationID, "op-closed", "goblin-skirmisher", 1, cfg); !errors.Is(err, ecosystem.ErrReservationClosed) {
		t.Fatalf("expected ErrReservationClosed on closed reservation, got %v", err)
	}
	if _, _, err := ecosystem.ReconcileReservationContingent(nil, "x", "op", 1, 1, 1, false, cfg); err == nil {
		t.Fatalf("expected nil state error on ReconcileReservationContingent")
	}
	if _, _, err := ecosystem.ReconcileReservationContingent(&st, "res-missing", "op", 1, 1, 1, false, cfg); !errors.Is(err, ecosystem.ErrUnknownReservation) {
		t.Fatalf("expected ErrUnknownReservation on Reconcile, got %v", err)
	}
	if _, _, err := ecosystem.ReconcileReservationContingent(&st, res.ReservationID, "op-bad-hp", 1, 200, 100, false, cfg); !errors.Is(err, ecosystem.ErrInvalidCommand) {
		t.Fatalf("expected ErrInvalidCommand on hp > maxHP, got %v", err)
	}
	if _, _, err := ecosystem.CancelReservation(nil, "x", false); err == nil {
		t.Fatalf("expected nil state error on CancelReservation")
	}
	if _, _, err := ecosystem.CompleteReservation(nil, "x"); err == nil {
		t.Fatalf("expected nil state error on CompleteReservation")
	}
	if _, _, err := ecosystem.CompleteReservation(&st, "res-missing"); !errors.Is(err, ecosystem.ErrUnknownReservation) {
		t.Fatalf("expected ErrUnknownReservation, got %v", err)
	}
	if _, _, err := ecosystem.CancelReservation(&st, "res-missing", true); !errors.Is(err, ecosystem.ErrUnknownReservation) {
		t.Fatalf("expected ErrUnknownReservation on cancel, got %v", err)
	}

	// Cancel a second reservation, then verify CompleteReservation rejects expired reservation.
	r2, _, _, err := ecosystem.CreateReservation(&st, ecosystem.ReservationRequest{
		IdempotencyKey: "comp-key-2",
		CampaignID:     "cmp-complete-2",
		CampID:         "camp-thornveil-warren",
		Amount:         10,
		CreatedTick:    2,
		ExpiryTick:     50,
	}, cfg)
	if err != nil {
		t.Fatalf("CreateReservation r2: %v", err)
	}
	if _, _, err := ecosystem.MaterializeFromReservation(&st, r2.ReservationID, "op-fam-mismatch", "orc-vanguard", 1, cfg); !errors.Is(err, ecosystem.ErrInvalidCommand) {
		t.Fatalf("expected family mismatch error, got %v", err)
	}
	if _, _, err := ecosystem.MaterializeFromReservation(&st, r2.ReservationID, "op-too-big", "goblin-raider-pack", 5, cfg); !errors.Is(err, ecosystem.ErrInsufficientPopulation) {
		t.Fatalf("expected ErrInsufficientPopulation exceeding remaining reserved, got %v", err)
	}
	if _, _, err := ecosystem.CancelReservation(&st, r2.ReservationID, true); err != nil {
		t.Fatalf("CancelReservation r2: %v", err)
	}
	if _, _, err := ecosystem.CompleteReservation(&st, r2.ReservationID); !errors.Is(err, ecosystem.ErrReservationClosed) {
		t.Fatalf("expected ErrReservationClosed completing expired reservation, got %v", err)
	}

	// PopulationReservation.Validate error paths.
	badRes := ecosystem.PopulationReservation{ReservationID: ""}
	if err := badRes.Validate(64); err == nil {
		t.Fatalf("expected empty reservation_id validation error")
	}
	badRes = r2
	badRes.Seq = 0
	if err := badRes.Validate(64); err == nil {
		t.Fatalf("expected seq=0 validation error")
	}
	badRes = r2
	badRes.CampaignID = ""
	if err := badRes.Validate(64); err == nil {
		t.Fatalf("expected empty campaign_id validation error")
	}
	badRes = r2
	badRes.PopulationID = ""
	if err := badRes.Validate(64); err == nil {
		t.Fatalf("expected empty population_id validation error")
	}
	badRes = r2
	badRes.CampID = ""
	if err := badRes.Validate(64); err == nil {
		t.Fatalf("expected empty camp_id validation error")
	}
	badRes = r2
	badRes.State = ecosystem.ReservationState("Bogus")
	if err := badRes.Validate(64); err == nil {
		t.Fatalf("expected invalid state validation error")
	}
	badRes = r2
	badRes.ExpiryTick = 0
	if err := badRes.Validate(64); err == nil {
		t.Fatalf("expected expiry < created validation error")
	}
	badRes = r2
	badRes.ReservedAmount = 0
	if err := badRes.Validate(64); err == nil {
		t.Fatalf("expected zero reserved_amount validation error")
	}
	badRes = r2
	badRes.MaterializedAmount = badRes.ReservedAmount + 1
	if err := badRes.Validate(64); err == nil {
		t.Fatalf("expected materialized > reserved validation error")
	}
	badRes = r2
	badRes.ReturnedSurvivors = 1
	if err := badRes.Validate(64); err == nil {
		t.Fatalf("expected survivors > materialized validation error")
	}
	badRes = r2
	badRes.AppliedOps = []string{"b", "a"}
	if err := badRes.Validate(64); err == nil {
		t.Fatalf("expected unsorted applied_ops validation error")
	}

	// EcosystemState.Validate cross-reservation invariants & operational limits.
	stBad := st.Clone()
	stBad.Reservations[0].Seq = stBad.ReservationSeq + 10
	if err := stBad.Validate(cfg); err == nil {
		t.Fatalf("expected reservation seq > ReservationSeq error")
	}
	stBad = st.Clone()
	stBad.Reservations[0].CampID = "camp-nonexistent"
	if err := stBad.Validate(cfg); !errors.Is(err, ecosystem.ErrInvalidReference) {
		t.Fatalf("expected missing camp reference error, got %v", err)
	}
	stBad = st.Clone()
	stBad.Reservations[0].RegionID = "region-wrong"
	if err := stBad.Validate(cfg); !errors.Is(err, ecosystem.ErrInvalidReference) {
		t.Fatalf("expected reservation provenance mismatch error, got %v", err)
	}
	stBad = st.Clone()
	stBad.Populations[0].ReservedPopulation = 99
	if err := stBad.Validate(cfg); !errors.Is(err, ecosystem.ErrInvalidState) {
		t.Fatalf("expected reserved_population sum mismatch error, got %v", err)
	}

	// MaxReservations & MaxOpsPerReservation & destroyed camp enforcement.
	smallCfg := cfg
	smallCfg.MaxReservations = len(st.Reservations)
	if _, _, _, err := ecosystem.CreateReservation(&st, ecosystem.ReservationRequest{
		CampaignID: "cmp-cap", CampID: "camp-thornveil-warren", Amount: 5, CreatedTick: 5, ExpiryTick: 20,
	}, smallCfg); !errors.Is(err, ecosystem.ErrCapacityExceeded) {
		t.Fatalf("expected ErrCapacityExceeded on MaxReservations, got %v", err)
	}
	stDestroyed := ecosystem.NewDefaultEcosystemState("res-destroyed", 9)
	stDestroyed.Camps[0].State = ecosystem.CampDestroyed
	if _, _, _, err := ecosystem.CreateReservation(&stDestroyed, ecosystem.ReservationRequest{
		CampaignID: "cmp-d", CampID: stDestroyed.Camps[0].CampID, Amount: 5, CreatedTick: 1, ExpiryTick: 20,
	}, cfg); !errors.Is(err, ecosystem.ErrCampUnavailable) {
		t.Fatalf("expected ErrCampUnavailable for destroyed camp, got %v", err)
	}
}

func TestReservationReplayAfterRetirementLimit(t *testing.T) {
	cfg := ecosystem.DefaultConfig()
	st := ecosystem.NewDefaultEcosystemState("bounded-idempotency", 77)
	req := ecosystem.ReservationRequest{CampaignID: "campaign", CampID: "camp-thornveil-warren", Amount: 1, CreatedTick: 1, ExpiryTick: 9}
	for i := 0; i < cfg.MaxRetiredReservationKeys+1; i++ {
		req.IdempotencyKey = fmt.Sprintf("key-%03d", i)
		res, _, created, err := ecosystem.CreateReservation(&st, req, cfg)
		if err != nil || !created {
			t.Fatalf("create %d: %v", i, err)
		}
		if _, _, err = ecosystem.CancelReservation(&st, res.ReservationID, false); err != nil {
			t.Fatal(err)
		}
		ecosystem.PruneClosedReservations(&st, 0, cfg.MaxRetiredReservationKeys)
	}
	beforeFree, beforeReserved, beforeMat := ecosystem.TotalPopulationLedger(st)
	req.IdempotencyKey = "key-000"
	if _, _, created, err := ecosystem.CreateReservation(&st, req, cfg); created || !errors.Is(err, ecosystem.ErrDuplicateReservation) {
		t.Fatalf("old key replay accepted: created=%v err=%v", created, err)
	}
	afterFree, afterReserved, afterMat := ecosystem.TotalPopulationLedger(st)
	if beforeFree != afterFree || beforeReserved != afterReserved || beforeMat != afterMat {
		t.Fatal("replay mutated ledger")
	}
	req.IdempotencyKey = fmt.Sprintf("key-%03d", cfg.MaxRetiredReservationKeys)
	req.ExpiryTick++
	if _, _, _, err := ecosystem.CreateReservation(&st, req, cfg); !errors.Is(err, ecosystem.ErrReservationConflict) {
		t.Fatalf("conflicting tick accepted: %v", err)
	}
	if len(st.RetiredReservationKeys) != cfg.MaxRetiredReservationKeys || len(st.Reservations) != 1 {
		t.Fatal("closed key lost when ring filled")
	}
}

func TestReservationStateRejectsForgedIdentities(t *testing.T) {
	cfg := ecosystem.DefaultConfig()
	st := ecosystem.NewDefaultEcosystemState("identity-check", 1)
	req := ecosystem.ReservationRequest{IdempotencyKey: "unique", CampaignID: "campaign", CampID: "camp-thornveil-warren", Amount: 1, CreatedTick: 1, ExpiryTick: 10}
	_, _, _, err := ecosystem.CreateReservation(&st, req, cfg)
	if err != nil {
		t.Fatal(err)
	}
	forged := st.Clone()
	forged.Reservations[0].ReservationID = "res:identity-check:999999"
	if err := forged.Validate(cfg); err == nil {
		t.Fatal("forged sequence accepted")
	}
	forged = st.Clone()
	forged.RetiredReservationKeys = []string{"unique"}
	if err := forged.Validate(cfg); err == nil {
		t.Fatal("active and retired key collision accepted")
	}
}

func TestRecoveryReproducesClosedReservationCapacityExhaustion(t *testing.T) {
	cfg := ecosystem.DefaultConfig()
	cfg.MaxRetiredReservationKeys = 2
	cfg.MaxReservations = 2
	st := ecosystem.NewDefaultEcosystemState("recovery-repro", 1)
	initialFree, initialReserved, initialMaterialized := ecosystem.TotalPopulationLedger(st)
	for i := 0; i < 4; i++ {
		req := ecosystem.ReservationRequest{IdempotencyKey: fmt.Sprintf("recovery-%d", i), CampaignID: fmt.Sprintf("campaign-%d", i), CampID: "camp-thornveil-warren", Amount: 1, CreatedTick: uint64(i + 1), ExpiryTick: uint64(i + 10)}
		res, _, created, err := ecosystem.CreateReservation(&st, req, cfg)
		if err != nil || !created {
			t.Fatalf("reserve %d: %v", i, err)
		}
		if _, _, err = ecosystem.CancelReservation(&st, res.ReservationID, false); err != nil {
			t.Fatal(err)
		}
		ecosystem.PruneClosedReservations(&st, 0, cfg.MaxRetiredReservationKeys)
	}
	next := ecosystem.ReservationRequest{IdempotencyKey: "new-valid", CampaignID: "new-campaign", CampID: "camp-thornveil-warren", Amount: 1, CreatedTick: 9, ExpiryTick: 19}
	for i := 0; i < 2; i++ {
		_, _, _, err := ecosystem.CreateReservation(&st, next, cfg)
		if !errors.Is(err, ecosystem.ErrCapacityExceeded) {
			t.Fatalf("expected capacity exhaustion, got %v", err)
		}
		ecosystem.PruneClosedReservations(&st, 0, cfg.MaxRetiredReservationKeys)
	}
	free, reserved, materialized := ecosystem.TotalPopulationLedger(st)
	if free != initialFree || reserved != initialReserved || materialized != initialMaterialized {
		t.Fatal("reproduction changed population")
	}
}

func TestSequencedReservationsRemainBoundedAfterTwoThousandCycles(t *testing.T) {
	cfg := ecosystem.DefaultConfig()
	cfg.MaxReservations = 2
	cfg.MaxRetiredReservationKeys = 2
	st := ecosystem.NewDefaultEcosystemState("sequenced-recovery", 1)
	initialFree, initialReserved, initialMaterialized := ecosystem.TotalPopulationLedger(st)
	var first ecosystem.ReservationRequest
	for i := uint64(1); i <= 2000; i++ {
		req := ecosystem.ReservationRequest{CampaignID: fmt.Sprintf("c-%d", i), CampID: "camp-thornveil-warren", Amount: 6, CreatedTick: i, ExpiryTick: i + 1}
		if i == 1 {
			first = req
		}
		res, _, created, err := ecosystem.CreateSequencedReservation(&st, req, i, cfg)
		if err != nil || !created {
			t.Fatalf("create %d: %v", i, err)
		}
		_, _, err = ecosystem.MaterializeFromReservation(&st, res.ReservationID, "materialize", "goblin-raider-pack", 1, cfg)
		if err != nil {
			t.Fatal(err)
		}
		_, _, err = ecosystem.ReconcileReservationContingent(&st, res.ReservationID, "return", 6, 400, 400, false, cfg)
		if err != nil {
			t.Fatal(err)
		}
		_, _, err = ecosystem.CompleteReservation(&st, res.ReservationID)
		if err != nil {
			t.Fatal(err)
		}
		ecosystem.PruneClosedReservations(&st, 0, cfg.MaxRetiredReservationKeys)
		free, reserved, materialized := ecosystem.TotalPopulationLedger(st)
		if free != initialFree || reserved != initialReserved || materialized != initialMaterialized || len(st.Reservations) != 0 {
			t.Fatalf("ledger or retention failed at %d", i)
		}
	}
	if _, _, created, err := ecosystem.CreateSequencedReservation(&st, first, 1, cfg); created || !errors.Is(err, ecosystem.ErrDuplicateReservation) {
		t.Fatalf("old sequence replay: %v", err)
	}
	raw, err := st.MarshalSnapshot(cfg)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := ecosystem.UnmarshalSnapshot(raw, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, created, err := ecosystem.CreateSequencedReservation(&restored, first, 1, cfg); created || !errors.Is(err, ecosystem.ErrDuplicateReservation) {
		t.Fatalf("replay after restore: %v", err)
	}
	req := ecosystem.ReservationRequest{CampaignID: "c-next", CampID: "camp-thornveil-warren", Amount: 1, CreatedTick: 2001, ExpiryTick: 2002}
	if _, _, created, err := ecosystem.CreateSequencedReservation(&restored, req, 2001, cfg); !created || err != nil {
		t.Fatalf("next valid operation: %v", err)
	}
}

func TestSequencedReservationEnforcesContiguousOrderAndRetry(t *testing.T) {
	cfg := ecosystem.DefaultConfig()
	st := ecosystem.NewDefaultEcosystemState("sequenced-order", 1)
	req := ecosystem.ReservationRequest{CampaignID: "campaign", CampID: "camp-thornveil-warren", Amount: 1, CreatedTick: 1, ExpiryTick: 10}
	if _, _, _, err := ecosystem.CreateSequencedReservation(&st, req, 2, cfg); !errors.Is(err, ecosystem.ErrInvalidCommand) {
		t.Fatalf("sequence gap: %v", err)
	}
	res, _, created, err := ecosystem.CreateSequencedReservation(&st, req, 1, cfg)
	if err != nil || !created {
		t.Fatal(err)
	}
	duplicate, _, created, err := ecosystem.CreateSequencedReservation(&st, req, 1, cfg)
	if err != nil || created || duplicate.ReservationID != res.ReservationID {
		t.Fatalf("retry: %v", err)
	}
	altered := req
	altered.Amount = 2
	if _, _, _, err = ecosystem.CreateSequencedReservation(&st, altered, 1, cfg); !errors.Is(err, ecosystem.ErrReservationConflict) {
		t.Fatalf("conflicting retry: %v", err)
	}
	forged := req
	forged.IdempotencyKey = "ordered-reservation:2"
	if _, _, _, err = ecosystem.CreateReservation(&st, forged, cfg); !errors.Is(err, ecosystem.ErrInvalidCommand) {
		t.Fatalf("reserved namespace accepted: %v", err)
	}
}

func TestSequencedReservationAtCounterLimit(t *testing.T) {
	cfg := ecosystem.DefaultConfig()
	st := ecosystem.NewDefaultEcosystemState("seq-limit", 1)
	st.ReservationSeq = math.MaxUint64
	beforeFree, beforeReserved, beforeMat := ecosystem.TotalPopulationLedger(st)
	req := ecosystem.ReservationRequest{CampaignID: "c", CampID: "camp-thornveil-warren", Amount: 1, CreatedTick: 1, ExpiryTick: 2}
	_, _, created, err := ecosystem.CreateSequencedReservation(&st, req, math.MaxUint64, cfg)
	if created || !errors.Is(err, ecosystem.ErrDuplicateReservation) {
		t.Fatalf("counter wrap: %v", err)
	}
	free, reserved, mat := ecosystem.TotalPopulationLedger(st)
	if free != beforeFree || reserved != beforeReserved || mat != beforeMat {
		t.Fatal("overflow mutated ledger")
	}
}

func BenchmarkSequencedReservationRecovery(b *testing.B) {
	cfg := ecosystem.DefaultConfig()
	st := ecosystem.NewDefaultEcosystemState("bench-sequenced", 1)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		seq := st.ReservationSeq + 1
		req := ecosystem.ReservationRequest{CampaignID: "campaign", CampID: "camp-thornveil-warren", Amount: 6, CreatedTick: seq, ExpiryTick: seq + 1}
		reservation, _, _, err := ecosystem.CreateSequencedReservation(&st, req, seq, cfg)
		if err != nil {
			b.Fatal(err)
		}
		if _, _, err = ecosystem.MaterializeFromReservation(&st, reservation.ReservationID, "materialize", "goblin-raider-pack", 1, cfg); err != nil {
			b.Fatal(err)
		}
		if _, _, err = ecosystem.ReconcileReservationContingent(&st, reservation.ReservationID, "return", 6, 400, 400, false, cfg); err != nil {
			b.Fatal(err)
		}
		if _, _, err = ecosystem.CompleteReservation(&st, reservation.ReservationID); err != nil {
			b.Fatal(err)
		}
		ecosystem.PruneClosedReservations(&st, 0, cfg.MaxRetiredReservationKeys)
	}
}

func TestSequencedPruningProgressWithUnprunableLegacyReservation(t *testing.T) {
	cfg := ecosystem.DefaultConfig()
	cfg.MaxReservations = 2
	cfg.MaxRetiredReservationKeys = 1
	st := ecosystem.NewDefaultEcosystemState("mixed-sequence", 1)
	for i := 0; i < 2; i++ {
		req := ecosystem.ReservationRequest{IdempotencyKey: fmt.Sprintf("legacy-%d", i), CampaignID: fmt.Sprintf("legacy-c-%d", i), CampID: "camp-thornveil-warren", Amount: 1, CreatedTick: uint64(i + 1), ExpiryTick: 10}
		res, _, _, err := ecosystem.CreateReservation(&st, req, cfg)
		if err != nil {
			t.Fatal(err)
		}
		if _, _, err := ecosystem.CancelReservation(&st, res.ReservationID, false); err != nil {
			t.Fatal(err)
		}
		ecosystem.PruneClosedReservations(&st, 0, cfg.MaxRetiredReservationKeys)
	}
	for i := 0; i < 10; i++ {
		seq := st.ReservationSeq + 1
		req := ecosystem.ReservationRequest{CampaignID: fmt.Sprintf("new-%d", i), CampID: "camp-thornveil-warren", Amount: 1, CreatedTick: seq, ExpiryTick: seq + 1}
		res, _, created, err := ecosystem.CreateSequencedReservation(&st, req, seq, cfg)
		if err != nil || !created {
			t.Fatalf("create %d: %v", i, err)
		}
		if _, _, err := ecosystem.CancelReservation(&st, res.ReservationID, false); err != nil {
			t.Fatal(err)
		}
		ecosystem.PruneClosedReservations(&st, 0, cfg.MaxRetiredReservationKeys)
		if len(st.Reservations) != 1 {
			t.Fatalf("prune retained %d reservations", len(st.Reservations))
		}
	}
}
