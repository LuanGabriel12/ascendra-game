import { z } from "zod";

export const MIN_INT64 = -9223372036854775808n;
export const MAX_INT64 = 9223372036854775807n;
export const MIN_UINT64 = 0n;
export const MAX_UINT64 = 18446744073709551615n;

const CANONICAL_UNSIGNED_DECIMAL_RE = /^(0|[1-9][0-9]{0,19})$/;
const CANONICAL_SIGNED_DECIMAL_RE = /^(0|-?[1-9][0-9]{0,19})$/;

export const MAX_WIRE_PAYLOAD_BYTES = 64 * 1024; // 64 KiB defensive boundary ceiling

/**
 * Parses an unsigned or non-negative integer value into BigInt without silent IEEE-754 rounding:
 * - Canonical decimal strings ("0", "9223372036854775807", "18446744073709551615") are parsed directly.
 * - BigInt instances are validated directly.
 * - JS `number` values are accepted ONLY when `Number.isSafeInteger(val)` holds; unsafe floats/integers
 *   (> Number.MAX_SAFE_INTEGER) are explicitly rejected to forbid silent precision loss.
 */
function parseBigIntToken(
  val: unknown,
  allowNegative: boolean,
  ctx: z.RefinementCtx,
  typeLabel: string,
): bigint | typeof z.NEVER {
  if (typeof val === "bigint") {
    return val;
  }
  if (typeof val === "number") {
    if (!Number.isInteger(val)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Expected exact integer for ${typeLabel}, received non-integer number.`,
      });
      return z.NEVER;
    }
    if (!Number.isSafeInteger(val)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unsafe JavaScript number for ${typeLabel}; 64-bit integers exceeding MAX_SAFE_INTEGER must be serialized as canonical decimal strings or decoded via decodeWireJsonLossless.`,
      });
      return z.NEVER;
    }
    return BigInt(val);
  }
  if (typeof val === "string") {
    const pattern = allowNegative ? CANONICAL_SIGNED_DECIMAL_RE : CANONICAL_UNSIGNED_DECIMAL_RE;
    if (!pattern.test(val)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid canonical decimal string '${val}' for ${typeLabel}.`,
      });
      return z.NEVER;
    }
    return BigInt(val);
  }

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: `Expected canonical decimal string, safe integer, or bigint for ${typeLabel}.`,
  });
  return z.NEVER;
}

export const SignedInt64Schema = z.unknown().transform((val, ctx): bigint => {
  const parsed = parseBigIntToken(val, true, ctx, "signed int64");
  if (parsed === z.NEVER) {
    return z.NEVER;
  }
  if (parsed < MIN_INT64 || parsed > MAX_INT64) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Value ${parsed.toString()} is outside signed int64 bounds [${MIN_INT64.toString()}, ${MAX_INT64.toString()}].`,
    });
    return z.NEVER;
  }
  return parsed;
});

export const NonNegativeInt64Schema = z.unknown().transform((val, ctx): bigint => {
  const parsed = parseBigIntToken(val, true, ctx, "non-negative int64");
  if (parsed === z.NEVER) {
    return z.NEVER;
  }
  if (parsed < 0n) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Value ${parsed.toString()} must be >= 0 (non-negative int64).`,
    });
    return z.NEVER;
  }
  if (parsed > MAX_INT64) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Value ${parsed.toString()} exceeds int64 max (${MAX_INT64.toString()}).`,
    });
    return z.NEVER;
  }
  return parsed;
});

export const PositiveInt64Schema = z.unknown().transform((val, ctx): bigint => {
  const parsed = parseBigIntToken(val, true, ctx, "positive int64");
  if (parsed === z.NEVER) {
    return z.NEVER;
  }
  if (parsed <= 0n) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Value ${parsed.toString()} must be > 0 (positive int64).`,
    });
    return z.NEVER;
  }
  if (parsed > MAX_INT64) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Value ${parsed.toString()} exceeds int64 max (${MAX_INT64.toString()}).`,
    });
    return z.NEVER;
  }
  return parsed;
});

export const Uint64Schema = z.unknown().transform((val, ctx): bigint => {
  const parsed = parseBigIntToken(val, false, ctx, "uint64");
  if (parsed === z.NEVER) {
    return z.NEVER;
  }
  if (parsed < MIN_UINT64 || parsed > MAX_UINT64) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Value ${parsed.toString()} is outside uint64 bounds [0, ${MAX_UINT64.toString()}].`,
    });
    return z.NEVER;
  }
  return parsed;
});

/**
 * Decodes raw JSON text produced by Go (`encoding/json`) without losing 64-bit integer precision.
 * Any JSON integer literal outside JavaScript safe integer bounds (`|n| > 9007199254740991`)
 * is preserved verbatim as its exact decimal string before `JSON.parse` executes, while
 * fractional/exponent numbers remain untouched.
 */
export function decodeWireJsonLossless(rawJson: string): unknown {
  const byteLength = Buffer.byteLength(rawJson, "utf8");
  if (byteLength > MAX_WIRE_PAYLOAD_BYTES) {
    throw new Error(
      `Wire JSON payload size (${byteLength} bytes) exceeds maximum allowed (${MAX_WIRE_PAYLOAD_BYTES} bytes).`,
    );
  }

  let out = "";
  let i = 0;
  const len = rawJson.length;
  let inString = false;

  while (i < len) {
    const ch = rawJson[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < len) {
        out += rawJson[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }

    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let end = i + 1;
      let isFloat = false;
      while (end < len) {
        const c = rawJson[end]!;
        if (c >= "0" && c <= "9") {
          end++;
        } else if (c === "." || c === "e" || c === "E" || c === "+") {
          isFloat = true;
          end++;
        } else if (c === "-" && end > i) {
          isFloat = true;
          end++;
        } else {
          break;
        }
      }

      const token = rawJson.slice(i, end);
      if (!isFloat && CANONICAL_SIGNED_DECIMAL_RE.test(token)) {
        const asBig = BigInt(token);
        if (
          asBig > BigInt(Number.MAX_SAFE_INTEGER) ||
          asBig < BigInt(Number.MIN_SAFE_INTEGER)
        ) {
          out += `"${token}"`;
          i = end;
          continue;
        }
      }

      out += token;
      i = end;
      continue;
    }

    out += ch;
    i++;
  }

  return JSON.parse(out);
}
