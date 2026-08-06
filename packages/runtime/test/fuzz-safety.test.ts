/**
 * Untrusted-buffer safety: random bytes into Message.fromFlat and unpack
 * must not hang and may throw CapnpError only (no raw RangeError/TypeError).
 */
import { describe, expect, test } from "bun:test";
import { CapnpError, Message, unpack } from "../src/index.ts";

/** Deterministic PRNG (mulberry32) for reproducible fuzz inputs. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBytes(rng: () => number, length: number): Uint8Array {
  const buf = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    buf[i] = (rng() * 256) | 0;
  }
  return buf;
}

/** Call fn; success is fine; any throw must be CapnpError. */
function allowOnlyCapnpError(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CapnpError);
  }
}

/** Mix of empty, tiny, word-boundary, and multi-KB sizes. */
const SIZE_POOL = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 24, 31, 32, 33, 48, 63, 64, 65, 127, 128, 129, 255,
  256, 257, 511, 512, 513, 1023, 1024, 2048, 4095, 4096, 8192,
];

describe("untrusted buffer safety fuzz", () => {
  test("100 random buffers: fromFlat and unpack throw only CapnpError", () => {
    const rng = mulberry32(0xc0_ff_ee);
    const n = 100;

    for (let i = 0; i < n; i++) {
      const base = SIZE_POOL[i % SIZE_POOL.length]!;
      // Small jitter so sizes are not only the fixed pool.
      const jitter = (rng() * 32) | 0;
      const length = Math.max(0, base + jitter - 16);
      const buf = randomBytes(rng, length);

      allowOnlyCapnpError(() => {
        Message.fromFlat(buf);
      });
      allowOnlyCapnpError(() => {
        unpack(buf);
      });
    }
  });
});
