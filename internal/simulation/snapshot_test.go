package simulation_test

import (
	"errors"
	"math"
	"testing"

	"ascendra-game/internal/simulation"
)

type sampleState struct {
	Tick   uint64 `json:"tick"`
	HP     int64  `json:"hp"`
	Active bool   `json:"active"`
	Flags  uint32 `json:"flags"`
	Name   string `json:"name"`
}

func checksumSample(s sampleState) (string, error) {
	if s.HP < 0 {
		return "", errors.New("negative hp")
	}
	h := simulation.NewCanonicalHasher()
	h.WriteUint64(s.Tick)
	h.WriteInt64(s.HP)
	h.WriteBool(s.Active)
	h.WriteUint32(s.Flags)
	h.WriteString(s.Name)
	return h.SumHex(), nil
}

func TestDeterministicRNGRepeatabilityAndEdgeCases(t *testing.T) {
	a := simulation.NewDeterministicRNG(42)
	b := simulation.NewDeterministicRNG(42)
	for i := 0; i < 1000; i++ {
		va := a.NextUint64()
		vb := b.NextUint64()
		if va != vb {
			t.Fatalf("divergence at draw %d: %d != %d", i, va, vb)
		}
		ra := a.Int64N(17)
		rb := b.Int64N(17)
		if ra != rb || ra < 0 || ra >= 17 {
			t.Fatalf("Int64N divergence/range error at %d: %d vs %d", i, ra, rb)
		}
		rgA := a.Int64Range(-10, 10)
		rgB := b.Int64Range(-10, 10)
		if rgA != rgB || rgA < -10 || rgA > 10 {
			t.Fatalf("Int64Range divergence/range error at %d: %d vs %d", i, rgA, rgB)
		}
	}

	// Zero seed must still initialize deterministically to non-zero internal state.
	z := simulation.NewDeterministicRNG(0)
	if z.State == 0 {
		t.Fatal("zero seed produced zero internal state")
	}
	if z.Int64N(0) != 0 || z.Int64N(-5) != 0 {
		t.Fatal("Int64N non-positive must return 0")
	}
	if z.Int64Range(10, 5) != 10 || z.Int64Range(7, 7) != 7 {
		t.Fatal("Int64Range degenerate bounds must return minVal")
	}
	// Full int64 span branch.
	_ = z.Int64Range(math.MinInt64, math.MaxInt64)
}

func TestCanonicalHasherDistinguishesFields(t *testing.T) {
	s1 := sampleState{Tick: 1, HP: 10, Active: true, Flags: 1, Name: "ab"}
	s2 := sampleState{Tick: 1, HP: 10, Active: false, Flags: 1, Name: "ab"}
	s3 := sampleState{Tick: 1, HP: 10, Active: true, Flags: 2, Name: "ab"}
	c1, _ := checksumSample(s1)
	c2, _ := checksumSample(s2)
	c3, _ := checksumSample(s3)
	if c1 == c2 || c1 == c3 || c2 == c3 {
		t.Fatalf("expected distinct checksums: %s / %s / %s", c1, c2, c3)
	}
}

func TestSnapshotRoundTripBoundsAndTamperRejection(t *testing.T) {
	orig := sampleState{Tick: 50, HP: 900, Active: true, Flags: 7, Name: "valewatch"}
	sum, err := checksumSample(orig)
	if err != nil {
		t.Fatalf("checksumSample failed: %v", err)
	}

	if _, err := simulation.EncodeSnapshot(orig, ""); !errors.Is(err, simulation.ErrInvalidSnapshot) {
		t.Fatalf("expected ErrInvalidSnapshot for empty checksum, got %v", err)
	}

	raw, err := simulation.EncodeSnapshot(orig, sum)
	if err != nil {
		t.Fatalf("EncodeSnapshot failed: %v", err)
	}

	restored, err := simulation.DecodeSnapshot(raw, checksumSample)
	if err != nil {
		t.Fatalf("DecodeSnapshot failed: %v", err)
	}
	if restored != orig {
		t.Fatalf("restored mismatch: got %+v, want %+v", restored, orig)
	}

	// Pre-decode byte-size enforcement rejects oversized payloads before JSON parsing.
	_, err = simulation.DecodeSnapshotWithOptions(raw, simulation.DecodeOptions{MaxBytes: len(raw) - 1}, checksumSample)
	if !errors.Is(err, simulation.ErrSnapshotTooLarge) {
		t.Fatalf("expected ErrSnapshotTooLarge, got %v", err)
	}
	_, err = simulation.DecodeSnapshotWithOptions(raw, simulation.DecodeOptions{MaxBytes: 0}, checksumSample)
	if !errors.Is(err, simulation.ErrInvalidSnapshot) {
		t.Fatalf("expected ErrInvalidSnapshot for zero MaxBytes, got %v", err)
	}
	_, err = simulation.DecodeSnapshot(nil, checksumSample)
	if !errors.Is(err, simulation.ErrInvalidSnapshot) {
		t.Fatalf("expected ErrInvalidSnapshot for empty bytes, got %v", err)
	}
	_, err = simulation.DecodeSnapshot[sampleState](raw, nil)
	if !errors.Is(err, simulation.ErrInvalidSnapshot) {
		t.Fatalf("expected ErrInvalidSnapshot for nil verifier, got %v", err)
	}

	// Tampered payload with original checksum must fail checksum verification.
	tampered := []byte(`{"schema_version":6,"checksum":"` + sum + `","payload":{"tick":50,"hp":999,"active":true,"flags":7,"name":"valewatch"}}`)
	_, err = simulation.DecodeSnapshot(tampered, checksumSample)
	if !errors.Is(err, simulation.ErrSnapshotChecksumMismatch) {
		t.Fatalf("expected ErrSnapshotChecksumMismatch, got %v", err)
	}

	// Missing checksum rejected.
	noSum := []byte(`{"schema_version":6,"checksum":"","payload":{"tick":50,"hp":900,"active":true,"flags":7,"name":"valewatch"}}`)
	_, err = simulation.DecodeSnapshot(noSum, checksumSample)
	if !errors.Is(err, simulation.ErrInvalidSnapshot) {
		t.Fatalf("expected ErrInvalidSnapshot for missing checksum, got %v", err)
	}

	// Older v1/v2/v3/v4/v5 and future v99 schema versions must fail explicitly.
	for _, ver := range []string{"1", "2", "3", "4", "5", "99"} {
		badVer := []byte(`{"schema_version":` + ver + `,"checksum":"` + sum + `","payload":{"tick":50,"hp":900,"active":true,"flags":7,"name":"valewatch"}}`)
		_, err = simulation.DecodeSnapshot(badVer, checksumSample)
		if !errors.Is(err, simulation.ErrUnsupportedSnapshotVersion) {
			t.Fatalf("expected ErrUnsupportedSnapshotVersion for v%s, got %v", ver, err)
		}
	}

	// Unknown JSON fields rejected.
	unknown := []byte(`{"schema_version":6,"checksum":"` + sum + `","extra":1,"payload":{"tick":50,"hp":900,"active":true,"flags":7,"name":"valewatch"}}`)
	_, err = simulation.DecodeSnapshot(unknown, checksumSample)
	if !errors.Is(err, simulation.ErrInvalidSnapshot) {
		t.Fatalf("expected ErrInvalidSnapshot for unknown field, got %v", err)
	}

	// Trailing tokens must fail explicitly.
	trailing := append(append([]byte{}, raw...), []byte(`{"extra":1}`)...)
	_, err = simulation.DecodeSnapshot(trailing, checksumSample)
	if !errors.Is(err, simulation.ErrInvalidSnapshot) {
		t.Fatalf("expected ErrInvalidSnapshot for trailing JSON, got %v", err)
	}
}

func FuzzSnapshotDecode(f *testing.F) {
	orig := sampleState{Tick: 10, HP: 100, Active: true, Flags: 2, Name: "seed"}
	sum, _ := checksumSample(orig)
	validRaw, _ := simulation.EncodeSnapshot(orig, sum)

	f.Add(validRaw)
	f.Add([]byte(`{}`))
	f.Add([]byte(`{"schema_version":6,"checksum":"abc","payload":{"tick":1,"hp":-1,"name":"x"}}`))
	f.Add([]byte(`not-json`))

	f.Fuzz(func(t *testing.T, data []byte) {
		decoded, err := simulation.DecodeSnapshotWithOptions(data, simulation.DecodeOptions{MaxBytes: 4096}, checksumSample)
		if err != nil {
			return
		}
		if decoded.HP < 0 {
			t.Fatalf("invariant broken: negative HP accepted by snapshot decode: %+v", decoded)
		}
		recomputed, err := checksumSample(decoded)
		if err != nil {
			t.Fatalf("decoded snapshot failed checksum recomputation: %v", err)
		}
		reencoded, err := simulation.EncodeSnapshot(decoded, recomputed)
		if err != nil {
			t.Fatalf("re-encoding decoded snapshot failed: %v", err)
		}
		roundTrip, err := simulation.DecodeSnapshot(reencoded, checksumSample)
		if err != nil || roundTrip != decoded {
			t.Fatalf("round-trip mismatch after fuzz decode: %v (%+v != %+v)", err, roundTrip, decoded)
		}
	})
}
