import { createHash } from "node:crypto";

const MASK_64 = 0xffffffffffffffffn;
const GOLDEN_GAMMA = 0x9e3779b97f4a7c15n;
const MIX_C1 = 0xbf58476d1ce4e5b9n;
const MIX_C2 = 0x94d049bb133111ebn;

/**
 * Pure 64-bit integer SplitMix64 deterministic PRNG.
 * Zero usage of `Math.random` or floating-point arithmetic.
 */
export class SplitMix64Rng {
  private state: bigint;
  public readonly seedHashHex: string;

  constructor(canonicalSeedMaterial: string) {
    const digest = createHash("sha256").update(canonicalSeedMaterial, "utf8").digest();
    this.seedHashHex = digest.toString("hex");
    this.state = digest.readBigUInt64BE(0) & MASK_64;
    if (this.state === 0n) {
      this.state = 0xdeadbeefcafebaben;
    }
  }

  public nextUint64(): bigint {
    this.state = (this.state + GOLDEN_GAMMA) & MASK_64;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * MIX_C1) & MASK_64;
    z = ((z ^ (z >> 27n)) * MIX_C2) & MASK_64;
    return (z ^ (z >> 31n)) & MASK_64;
  }

  /**
   * Unbiased uniform integer in `[min, max]` inclusive via rejection sampling over 64-bit space.
   */
  public nextIntInclusive(min: number, max: number): number {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
      throw new Error(`Invalid integer range [${min}, ${max}] for SplitMix64Rng.`);
    }
    if (min === max) {
      return min;
    }

    const span = BigInt(max - min) + 1n;
    const maxUnbiased = ((MASK_64 + 1n) / span) * span - 1n;

    while (true) {
      const sample = this.nextUint64();
      if (sample <= maxUnbiased) {
        return min + Number(sample % span);
      }
    }
  }
}
