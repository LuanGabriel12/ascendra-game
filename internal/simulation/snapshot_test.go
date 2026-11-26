package simulation_test

import (
	"errors"
	"testing"

	"ascendra-game/internal/simulation"
)

type sampleState struct {
	Tick uint64 `json:"tick"`
	HP   int64  `json:"hp"`
	Name string `json:"name"`
}

func checksumSample(s sampleState) (string, error) {
	if s.HP < 0 {
		return "", errors.New("negative hp")
	}
	h := simulation.NewCanonicalHasher()
	h.WriteUint64(s.Tick)
	h.WriteInt64(s.HP)
	h.WriteString(s.Name)
	return h.SumHex(), nil
}

func TestDeterministicRNGRepeatability(t *testing.T) {
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
	}
}

func TestSnapshotRoundTripAndTamperRejection(t *testing.T) {
	orig := sampleState{Tick: 50, HP: 900, Name: "valewatch"}
	sum, err := checksumSample(orig)
	if err != nil {
		t.Fatalf("checksumSample failed: %v", err)
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

	// Tampered payload with original checksum must fail checksum verification.
	tampered := []byte(`{"schema_version":2,"checksum":"` + sum + `","payload":{"tick":50,"hp":999,"name":"valewatch"}}`)
	_, err = simulation.DecodeSnapshot(tampered, checksumSample)
	if !errors.Is(err, simulation.ErrSnapshotChecksumMismatch) {
		t.Fatalf("expected ErrSnapshotChecksumMismatch, got %v", err)
	}

	// Older v1 and future v99 schema versions must fail explicitly.
	oldVer := []byte(`{"schema_version":1,"checksum":"` + sum + `","payload":{"tick":50,"hp":900,"name":"valewatch"}}`)
	_, err = simulation.DecodeSnapshot(oldVer, checksumSample)
	if !errors.Is(err, simulation.ErrUnsupportedSnapshotVersion) {
		t.Fatalf("expected ErrUnsupportedSnapshotVersion for v1, got %v", err)
	}

	badVer := []byte(`{"schema_version":99,"checksum":"` + sum + `","payload":{"tick":50,"hp":900,"name":"valewatch"}}`)
	_, err = simulation.DecodeSnapshot(badVer, checksumSample)
	if !errors.Is(err, simulation.ErrUnsupportedSnapshotVersion) {
		t.Fatalf("expected ErrUnsupportedSnapshotVersion for v99, got %v", err)
	}

	// Trailing tokens must fail explicitly.
	trailing := append(append([]byte{}, raw...), []byte(`{"extra":1}`)...)
	_, err = simulation.DecodeSnapshot(trailing, checksumSample)
	if !errors.Is(err, simulation.ErrInvalidSnapshot) {
		t.Fatalf("expected ErrInvalidSnapshot for trailing JSON, got %v", err)
	}
}

func FuzzSnapshotDecode(f *testing.F) {
	orig := sampleState{Tick: 10, HP: 100, Name: "seed"}
	sum, _ := checksumSample(orig)
	validRaw, _ := simulation.EncodeSnapshot(orig, sum)

	f.Add(validRaw)
	f.Add([]byte(`{}`))
	f.Add([]byte(`{"schema_version":1,"checksum":"abc","payload":{"tick":1,"hp":-1,"name":"x"}}`))
	f.Add([]byte(`not-json`))

	f.Fuzz(func(t *testing.T, data []byte) {
		decoded, err := simulation.DecodeSnapshot(data, checksumSample)
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
