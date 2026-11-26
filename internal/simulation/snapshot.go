package simulation

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

// SnapshotVersion identifies the current logical snapshot wire format.
const SnapshotVersion uint32 = 1

var (
	ErrInvalidSnapshot            = errors.New("invalid snapshot")
	ErrUnsupportedSnapshotVersion = errors.New("unsupported snapshot version")
	ErrSnapshotChecksumMismatch   = errors.New("snapshot checksum mismatch")
)

// SnapshotEnvelope wraps a versioned logical state payload alongside its canonical checksum.
type SnapshotEnvelope[T any] struct {
	SchemaVersion uint32 `json:"schema_version"`
	Checksum      string `json:"checksum"`
	Payload       T      `json:"payload"`
}

// EncodeSnapshot serializes a versioned snapshot envelope with its canonical checksum.
func EncodeSnapshot[T any](payload T, checksum string) ([]byte, error) {
	if strings.TrimSpace(checksum) == "" {
		return nil, fmt.Errorf("%w: empty checksum", ErrInvalidSnapshot)
	}
	env := SnapshotEnvelope[T]{
		SchemaVersion: SnapshotVersion,
		Checksum:      checksum,
		Payload:       payload,
	}
	return json.Marshal(env)
}

// DecodeSnapshot decodes a versioned snapshot, rejects unknown fields and trailing data,
// and verifies the payload against its canonical checksum.
func DecodeSnapshot[T any](data []byte, computeChecksum func(T) (string, error)) (T, error) {
	var zero T
	if len(data) == 0 {
		return zero, fmt.Errorf("%w: empty data", ErrInvalidSnapshot)
	}
	if computeChecksum == nil {
		return zero, fmt.Errorf("%w: nil checksum verifier", ErrInvalidSnapshot)
	}

	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()

	var env SnapshotEnvelope[T]
	if err := dec.Decode(&env); err != nil {
		return zero, fmt.Errorf("%w: %v", ErrInvalidSnapshot, err)
	}

	// Reject trailing non-whitespace tokens.
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		return zero, fmt.Errorf("%w: unexpected trailing data", ErrInvalidSnapshot)
	}

	if env.SchemaVersion != SnapshotVersion {
		return zero, fmt.Errorf("%w: got %d, want %d", ErrUnsupportedSnapshotVersion, env.SchemaVersion, SnapshotVersion)
	}
	if strings.TrimSpace(env.Checksum) == "" {
		return zero, fmt.Errorf("%w: missing checksum", ErrInvalidSnapshot)
	}

	actual, err := computeChecksum(env.Payload)
	if err != nil {
		return zero, fmt.Errorf("%w: %v", ErrInvalidSnapshot, err)
	}
	if actual != env.Checksum {
		return zero, fmt.Errorf("%w: embedded=%s computed=%s", ErrSnapshotChecksumMismatch, env.Checksum, actual)
	}

	return env.Payload, nil
}
