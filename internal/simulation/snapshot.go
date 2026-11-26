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
// v3 incorporates Cycle 03 typed targets, entity lifecycle retention, ecosystem links,
// and explicit pre-decode byte-size enforcement.
const SnapshotVersion uint32 = 3

// DefaultMaxSnapshotBytes caps snapshot input size BEFORE allocating a JSON decoder.
const DefaultMaxSnapshotBytes int = 2 * 1024 * 1024 // 2 MiB

var (
	ErrInvalidSnapshot            = errors.New("invalid snapshot")
	ErrUnsupportedSnapshotVersion = errors.New("unsupported snapshot version")
	ErrSnapshotChecksumMismatch   = errors.New("snapshot checksum mismatch")
	ErrSnapshotTooLarge           = errors.New("snapshot exceeds maximum allowed byte size")
)

// DecodeOptions configures pre-decode safety bounds for snapshot restoration.
type DecodeOptions struct {
	MaxBytes int
}

// DefaultDecodeOptions returns safe default pre-decode limits.
func DefaultDecodeOptions() DecodeOptions {
	return DecodeOptions{MaxBytes: DefaultMaxSnapshotBytes}
}

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

// DecodeSnapshot decodes a versioned snapshot using DefaultDecodeOptions.
func DecodeSnapshot[T any](data []byte, computeChecksum func(T) (string, error)) (T, error) {
	return DecodeSnapshotWithOptions(data, DefaultDecodeOptions(), computeChecksum)
}

// DecodeSnapshotWithOptions enforces MaxBytes BEFORE allocating or decoding JSON,
// rejects unknown fields and trailing data, verifies SchemaVersion, and validates
// the canonical checksum. Note: checksum detects corruption/desync, not cryptographic origin.
func DecodeSnapshotWithOptions[T any](data []byte, opts DecodeOptions, computeChecksum func(T) (string, error)) (T, error) {
	var zero T
	if opts.MaxBytes <= 0 {
		return zero, fmt.Errorf("%w: max_bytes must be > 0", ErrInvalidSnapshot)
	}
	if len(data) == 0 {
		return zero, fmt.Errorf("%w: empty data", ErrInvalidSnapshot)
	}
	if len(data) > opts.MaxBytes {
		return zero, fmt.Errorf("%w: size %d exceeds max %d", ErrSnapshotTooLarge, len(data), opts.MaxBytes)
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
