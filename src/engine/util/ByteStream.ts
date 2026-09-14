/**
 * A cursor over a byte buffer.
 *
 * SCUMM data files mix endianness: chunk tags and sizes are big-endian while
 * almost everything inside a chunk is little-endian (the games were written for
 * x86). Both are exposed here so call sites read the way the format reads.
 */
export class ByteStream {
  readonly data: Uint8Array;
  private readonly view: DataView;
  private offset: number;

  constructor(data: Uint8Array, offset = 0) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.offset = offset;
  }

  get position(): number {
    return this.offset;
  }

  get length(): number {
    return this.data.length;
  }

  get remaining(): number {
    return this.data.length - this.offset;
  }

  get eos(): boolean {
    return this.offset >= this.data.length;
  }

  seek(offset: number): this {
    this.offset = offset;
    return this;
  }

  skip(count: number): this {
    this.offset += count;
    return this;
  }

  readU8(): number {
    return this.view.getUint8(this.offset++);
  }

  readS8(): number {
    return this.view.getInt8(this.offset++);
  }

  readU16LE(): number {
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  readS16LE(): number {
    const value = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return value;
  }

  readU16BE(): number {
    const value = this.view.getUint16(this.offset, false);
    this.offset += 2;
    return value;
  }

  readU32LE(): number {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readS32LE(): number {
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readU32BE(): number {
    const value = this.view.getUint32(this.offset, false);
    this.offset += 4;
    return value;
  }

  /** Reads a 4 character chunk tag such as `LFLF` without allocating a view. */
  readTag(): string {
    const { data, offset } = this;
    this.offset += 4;
    return String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
  }

  /** A NUL terminated string, as used by object names and room names. */
  readCString(maxLength = Number.MAX_SAFE_INTEGER): string {
    let out = '';
    let count = 0;
    while (!this.eos && count < maxLength) {
      const byte = this.readU8();
      if (byte === 0) break;
      out += String.fromCharCode(byte);
      count++;
    }
    return out;
  }

  readBytes(count: number): Uint8Array {
    const slice = this.data.subarray(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }

  /** A view (not a copy) of `count` bytes; mutating it mutates the source. */
  view$(count: number): Uint8Array {
    return this.readBytes(count);
  }
}

export function readU16LE(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8);
}

export function readS16LE(data: Uint8Array, offset: number): number {
  const value = readU16LE(data, offset);
  return value >= 0x8000 ? value - 0x10000 : value;
}

export function readU16BE(data: Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1];
}

export function readU24LE(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
}

export function readU32LE(data: Uint8Array, offset: number): number {
  return (
    (data[offset] |
      (data[offset + 1] << 8) |
      (data[offset + 2] << 16) |
      (data[offset + 3] << 24)) >>>
    0
  );
}

/**
 * A 32-bit little-endian value that may be negative.
 *
 * `readU32LE` and a sign are not the same read: v8 stores an object's position
 * as a signed 32-bit value and an object left of the room's origin comes back
 * as four billion when the sign is dropped.
 */
export function readS32LE(data: Uint8Array, offset: number): number {
  return (
    data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)
  );
}

export function readU32BE(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] << 24) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3]) >>>
    0
  );
}

export function readTag(data: Uint8Array, offset: number): string {
  return String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
}

/**
 * Hex of the bytes around `centre`, marking it with a caret.
 *
 * For reports about bytecode that went wrong. A misparse is only diagnosable
 * from the bytes either side of where it was noticed: the instruction that
 * consumed the wrong number of operands is always the one before.
 */
export function hexWindow(data: Uint8Array, centre: number, before = 16, after = 16): string {
  const start = Math.max(0, centre - before);
  const end = Math.min(data.length, centre + after);
  const parts: string[] = [];
  for (let i = start; i < end; i++) {
    parts.push(`${i === centre ? '^' : ''}${data[i].toString(16).padStart(2, '0')}`);
  }
  return `@${start} ${parts.join(' ')}`;
}
