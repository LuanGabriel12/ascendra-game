import { createHash } from "node:crypto";

const UUID_CANONICAL_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Dedicated fixed namespace UUID for deterministic mapping of NEON opaque external EventIDs
 * (e.g. `sim:s1:inv:inv1:contrib:p1`) into internal PostgreSQL UUID primary keys (RFC 9562 UUIDv5).
 * The verbatim external_event_id is ALWAYS persisted alongside the UUID and enforced via UNIQUE.
 */
const ASCENDRA_EVENT_ID_NAMESPACE_BYTES = Buffer.from(
  "6ba7b8109dad11d180b400c04fd430c8",
  "hex",
);

export function isCanonicalUuid(candidate: string): boolean {
  return UUID_CANONICAL_RE.test(candidate.trim());
}

/**
 * Derives a stable, deterministic UUIDv5 for non-UUID external event identifiers,
 * or returns the normalized lowercase UUID when the external identifier is already a UUID.
 * Never generates random UUIDs on retries.
 */
export function deriveDeterministicEventUuid(externalEventId: string): string {
  const trimmed = externalEventId.trim();
  if (!trimmed) {
    throw new Error("Cannot derive deterministic UUID from blank externalEventId.");
  }
  if (isCanonicalUuid(trimmed)) {
    return trimmed.toLowerCase();
  }

  const sha1 = createHash("sha1");
  sha1.update(ASCENDRA_EVENT_ID_NAMESPACE_BYTES);
  sha1.update(Buffer.from(`ascendra:event:v1:${trimmed}`, "utf8"));
  const digest = Buffer.from(sha1.digest().subarray(0, 16));

  // Set RFC 9562 version 5 (0101xxxx) and variant 10xxxxxx bits
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;

  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export type CanonicalizableValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Date
  | ReadonlyArray<CanonicalizableValue>
  | { readonly [key: string]: CanonicalizableValue | undefined };

function canonicalizeNode(value: CanonicalizableValue): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "bigint") {
    return JSON.stringify(value.toString());
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new Error(`Unsafe or non-finite number '${String(value)}' in canonical fingerprint.`);
    }
    return JSON.stringify(value.toString());
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error("Invalid Date in canonical fingerprint.");
    }
    return JSON.stringify(value.toISOString());
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalizeNode(item));
    return `[${items.join(",")}]`;
  }

  const obj = value as { readonly [key: string]: CanonicalizableValue | undefined };
  const sortedKeys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const pairs = sortedKeys.map((key) => {
    const child = obj[key]!;
    return `${JSON.stringify(key)}:${canonicalizeNode(child)}`;
  });
  return `{${pairs.join(",")}}`;
}

export function toCanonicalJsonObject(
  record: { readonly [key: string]: CanonicalizableValue | undefined },
): Record<string, unknown> {
  return JSON.parse(canonicalizeNode(record)) as Record<string, unknown>;
}

/**
 * Computes a deterministic, property-order-independent SHA-256 fingerprint (`fp:v1:<hex>`)
 * over canonicalized domain fields.
 */
export function computeCanonicalFingerprintV1(
  record: { readonly [key: string]: CanonicalizableValue | undefined },
): { readonly fingerprint: string; readonly canonicalJson: Record<string, unknown> } {
  const serialized = canonicalizeNode(record);
  const digest = createHash("sha256").update(serialized, "utf8").digest("hex");
  return {
    fingerprint: `fp:v1:${digest}`,
    canonicalJson: JSON.parse(serialized) as Record<string, unknown>,
  };
}
