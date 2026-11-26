package simulation

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"hash"
)

// CanonicalHasher builds an unambiguous, architecture-independent binary encoding
// of logical simulation state for diagnostic SHA-256 checksums.
// It never depends on map iteration order, memory addresses, pointers, floats, or wall-clock time.
type CanonicalHasher struct {
	h   hash.Hash
	buf [8]byte
}

// NewCanonicalHasher initializes a fresh SHA-256 canonical state hasher.
func NewCanonicalHasher() *CanonicalHasher {
	return &CanonicalHasher{h: sha256.New()}
}

// WriteUint8 writes a single byte.
func (c *CanonicalHasher) WriteUint8(v uint8) {
	c.buf[0] = v
	_, _ = c.h.Write(c.buf[:1])
}

// WriteBool writes 1 for true and 0 for false.
func (c *CanonicalHasher) WriteBool(v bool) {
	if v {
		c.WriteUint8(1)
		return
	}
	c.WriteUint8(0)
}

// WriteUint32 writes a big-endian uint32.
func (c *CanonicalHasher) WriteUint32(v uint32) {
	binary.BigEndian.PutUint32(c.buf[:4], v)
	_, _ = c.h.Write(c.buf[:4])
}

// WriteUint64 writes a big-endian uint64.
func (c *CanonicalHasher) WriteUint64(v uint64) {
	binary.BigEndian.PutUint64(c.buf[:8], v)
	_, _ = c.h.Write(c.buf[:8])
}

// WriteInt64 writes a big-endian two's complement int64.
func (c *CanonicalHasher) WriteInt64(v int64) {
	c.WriteUint64(uint64(v))
}

// WriteString writes a length-prefixed UTF-8 string to eliminate delimiter ambiguity.
func (c *CanonicalHasher) WriteString(s string) {
	c.WriteUint64(uint64(len(s)))
	_, _ = c.h.Write([]byte(s))
}

// Sum returns the raw 32-byte SHA-256 digest.
func (c *CanonicalHasher) Sum() [32]byte {
	var out [32]byte
	c.h.Sum(out[:0])
	return out
}

// SumHex returns the lowercase hexadecimal SHA-256 digest.
func (c *CanonicalHasher) SumHex() string {
	sum := c.Sum()
	return hex.EncodeToString(sum[:])
}
