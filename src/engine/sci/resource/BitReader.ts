/**
 * The two bit orders SCI's compressors read in.
 *
 * Every SCI decompressor pulls variable-width codes out of a byte stream, and
 * which end of the byte they come from is not a detail: SCI0's LZW is
 * LSB-first and SCI01's is MSB-first, over otherwise identical code streams.
 * Reading one with the other's order produces a full-length output of plausible
 * bytes, which is the exact fault class
 * `docs/processes/verifying-version-support.md` says a fixture cannot find.
 *
 * Modelled on ScummVM's `Decompressor` (`engines/sci/resource/decompressor.cpp`)
 * rather than invented, including the refill rule — top the accumulator up to
 * 25-32 bits — because the accumulator width is what decides whether a 12-bit
 * code straddling three bytes comes out right.
 */

/** Bits taken from the top of the accumulator: big-endian bit order. */
export class MsbBitReader {
  private bits = 0;
  private count = 0;
  private at = 0;
  private readonly src: Uint8Array;

  constructor(src: Uint8Array) {
    this.src = src;
  }

  /** Bytes consumed so far, which a caller may need to bound a stream. */
  get read(): number {
    return this.at;
  }

  private fetch(): void {
    while (this.count <= 24) {
      const byte = this.at < this.src.length ? this.src[this.at] : 0;
      this.at++;
      this.bits |= byte << (24 - this.count);
      // `>>> 0` because JS bitwise operators work on signed 32-bit values and
      // a byte landing at bit 31 makes the accumulator negative, after which
      // every extraction below is wrong by a sign extension.
      this.bits = this.bits >>> 0;
      this.count += 8;
    }
  }

  take(n: number): number {
    if (n === 0) return 0;
    if (this.count < n) this.fetch();
    const value = this.bits >>> (32 - n);
    this.bits = (this.bits << n) >>> 0;
    this.count -= n;
    return value;
  }

  byte(): number {
    return this.take(8);
  }

  /** True once the source is exhausted and nothing is buffered. */
  get exhausted(): boolean {
    return this.at >= this.src.length && this.count === 0;
  }
}

/** Bits taken from the bottom of the accumulator: little-endian bit order. */
export class LsbBitReader {
  private bits = 0;
  private count = 0;
  private at = 0;
  private readonly src: Uint8Array;

  constructor(src: Uint8Array) {
    this.src = src;
  }

  get read(): number {
    return this.at;
  }

  private fetch(): void {
    while (this.count <= 24) {
      const byte = this.at < this.src.length ? this.src[this.at] : 0;
      this.at++;
      this.bits = (this.bits | (byte << this.count)) >>> 0;
      this.count += 8;
    }
  }

  take(n: number): number {
    if (n === 0) return 0;
    if (this.count < n) this.fetch();
    // `2 ** n - 1` rather than `~(-1 << n)`: at n = 32 the shift wraps to 0 in
    // JS and the mask becomes zero, which silently returns nothing.
    const value = this.bits & (2 ** n - 1);
    this.bits = this.bits >>> n;
    this.count -= n;
    return value;
  }

  byte(): number {
    return this.take(8);
  }

  get exhausted(): boolean {
    return this.at >= this.src.length && this.count === 0;
  }
}
