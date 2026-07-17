/**
 * Fixed-offset metric-descriptor primitives for byte-table devices. A
 * descriptor is `{lsb, msb, divider}` and returns `raw / divider`, or `null`
 * when the raw value equals the FTMS "not available" sentinel (`maxUintN - 1`)
 * BEFORE dividing — so a `null` metric means "not available", never zero.
 *
 * All multi-byte values are LITTLE-ENDIAN. `dir = lsb < msb ? +1 : -1` lets
 * the three/long/six readers walk either endian order; in practice lsb<msb.
 * The dir formula intentionally also handles the 2-byte three-byte case
 * (numBytes:2 → msb=lsb+1) used by stair/step-climber elevation gain, which
 * double-reads data[lsb+1] — matched here so those fields decode identically.
 *
 * DEFENSIVE PARSING CONTRACT (LAAS-wide): an out-of-bounds index yields
 * `null` rather than throwing, so a truncated/malformed notification never
 * crashes — every read is bounds-checked.
 */

// maxUint8 = 256 (NOT 255); the "not available" sentinels are maxUintN - 1.
const MAX_U8 = 256;
export const SENTINEL_U8 = MAX_U8 - 1; // 255
export const SENTINEL_U16 = MAX_U8 * MAX_U8 - 1; // 65535
export const SENTINEL_U24 = MAX_U8 * MAX_U8 * MAX_U8 - 1; // 16777215
export const SENTINEL_U32 = MAX_U8 * MAX_U8 * MAX_U8 * MAX_U8 - 1; // 4294967295
// 2^48 - 1 = 281474976710655; exact in a double.
export const SENTINEL_U48 = MAX_U8 ** 6 - 1;

// ---- raw little-endian readers (null on any out-of-bounds index) --------------

export function rawByte(d: Uint8Array, i: number): number | null {
  return i >= 0 && i < d.length ? d[i]! : null;
}

export function rawShort(d: Uint8Array, lsb: number, msb: number): number | null {
  if (lsb < 0 || msb < 0 || lsb >= d.length || msb >= d.length) return null;
  return d[lsb]! + MAX_U8 * d[msb]!;
}

export function rawThreeByte(d: Uint8Array, lsb: number, msb: number): number | null {
  const dir = lsb < msb ? 1 : -1;
  const i1 = lsb + dir;
  if (lsb < 0 || msb < 0 || i1 < 0 || lsb >= d.length || msb >= d.length || i1 >= d.length) return null;
  return d[lsb]! + MAX_U8 * (d[i1]! + MAX_U8 * d[msb]!);
}

export function rawLong(d: Uint8Array, lsb: number, msb: number): number | null {
  const dir = lsb < msb ? 1 : -1;
  const i1 = lsb + dir;
  const i2 = msb - dir;
  for (const i of [lsb, i1, i2, msb]) if (i < 0 || i >= d.length) return null;
  return d[lsb]! + MAX_U8 * (d[i1]! + MAX_U8 * (d[i2]! + MAX_U8 * d[msb]!));
}

export function rawSixByte(d: Uint8Array, lsb: number, msb: number): number | null {
  const dir = lsb < msb ? 1 : -1;
  const idx = [lsb, lsb + dir, lsb + 2 * dir, msb - 2 * dir, msb - dir, msb];
  for (const i of idx) if (i < 0 || i >= d.length) return null;
  return (
    d[idx[0]!]! +
    MAX_U8 *
      (d[idx[1]!]! +
        MAX_U8 * (d[idx[2]!]! + MAX_U8 * (d[idx[3]!]! + MAX_U8 * (d[idx[4]!]! + MAX_U8 * d[idx[5]!]!))))
  );
}

// ---- sentinel-aware value helpers (raw / divider, null on sentinel/OOB) --------

export function byteValue(d: Uint8Array, lsb: number, divider = 1): number | null {
  const raw = rawByte(d, lsb);
  if (raw === null || raw === SENTINEL_U8) return null;
  return raw / divider;
}

export function shortValue(d: Uint8Array, lsb: number, msb: number, divider = 1): number | null {
  const raw = rawShort(d, lsb, msb);
  if (raw === null || raw === SENTINEL_U16) return null;
  return raw / divider;
}

export function threeByteValue(d: Uint8Array, lsb: number, msb: number, divider = 1): number | null {
  const raw = rawThreeByte(d, lsb, msb);
  if (raw === null || raw === SENTINEL_U24) return null;
  return raw / divider;
}

export function longValue(d: Uint8Array, lsb: number, msb: number, divider = 1): number | null {
  const raw = rawLong(d, lsb, msb);
  if (raw === null || raw === SENTINEL_U32) return null;
  return raw / divider;
}

export function sixByteValue(d: Uint8Array, lsb: number, msb: number, divider = 1): number | null {
  const raw = rawSixByte(d, lsb, msb);
  if (raw === null || raw === SENTINEL_U48) return null;
  return raw / divider;
}

/**
 * Signed 16-bit read (sint16, LE), no sentinel. FTMS marks power / resistance
 * / force-on-belt as sint16, so these fields are read signed — a genuine -5 W
 * must read as -5, not 65531. (The unsigned helpers above are used for the
 * uint fields; this signed reader is used only where the field type is sint16.)
 */
export function shortSignedValue(d: Uint8Array, lsb: number, msb: number, divider = 1): number | null {
  const raw = rawShort(d, lsb, msb);
  if (raw === null) return null;
  const signed = raw >= 0x8000 ? raw - 0x10000 : raw;
  return signed / divider;
}

// ---- the five descriptor classes (byte-table device use) ---------------------

/** 8-bit read: msb forced 0, sentinel 255. */
export class ByteMetricDescriptor {
  readonly lsb: number;
  readonly msb = 0;
  readonly divider: number;
  constructor(lsb: number, divider = 1) {
    this.lsb = lsb;
    this.divider = divider;
  }
  getValue(d: Uint8Array): number | null {
    return byteValue(d, this.lsb, this.divider);
  }
}

/** 16-bit LE read, sentinel 65535. */
export class ShortMetricDescriptor {
  constructor(
    readonly lsb: number,
    readonly msb: number,
    readonly divider = 1,
  ) {}
  getValue(d: Uint8Array): number | null {
    return shortValue(d, this.lsb, this.msb, this.divider);
  }
}

/** 24-bit dir-based read, sentinel 16777215. */
export class ThreeByteMetricDescriptor {
  constructor(
    readonly lsb: number,
    readonly msb: number,
    readonly divider = 1,
  ) {}
  getValue(d: Uint8Array): number | null {
    return threeByteValue(d, this.lsb, this.msb, this.divider);
  }
}

/** 32-bit dir-based read, sentinel 4294967295. */
export class LongMetricDescriptor {
  constructor(
    readonly lsb: number,
    readonly msb: number,
    readonly divider = 1,
  ) {}
  getValue(d: Uint8Array): number | null {
    return longValue(d, this.lsb, this.msb, this.divider);
  }
}

/** 48-bit dir-based read, sentinel 2^48-1. */
export class SixByteMetricDescriptor {
  constructor(
    readonly lsb: number,
    readonly msb: number,
    readonly divider = 1,
  ) {}
  getValue(d: Uint8Array): number | null {
    return sixByteValue(d, this.lsb, this.msb, this.divider);
  }
}

/** view a notification DataView as a byte array without copying */
export function bytesOf(dv: DataView): Uint8Array {
  return new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
}
