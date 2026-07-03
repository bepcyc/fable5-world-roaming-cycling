/**
 * RideRecorder — DRAFT session export to Garmin .FIT (owner ask 2026-07-03,
 * "черновая, без особого тестирования"; Zwift/MyWhoosh-style activity file).
 *
 * Records 1 Hz samples of the rig's logical pose (position, altitude, ground
 * speed, distance) plus whatever the sensor seam provides (HR/cadence; power
 * arrives with M1.3 physics / M1.4 BLE). Export writes a minimal-but-valid
 * FIT activity: file_id + record stream + session + activity, correct CRC.
 * World coordinates are mapped onto a fictional Alpine anchor (46.5°N
 * 10.5°E) so imports show a sane map location.
 *
 * Keyboard: Ctrl+E downloads the current session (browser Blob). Recording
 * starts at boot and simply accumulates; a future ride-UI owns start/stop.
 * DRAFT status: byte layout follows the FIT SDK docs; only smoke-checked.
 */

import type { RideSample } from './Sensors';

const FIT_EPOCH_OFFSET_S = 631065600; // 1989-12-31T00:00:00Z in unix seconds
const ANCHOR_LAT = 46.5;
const ANCHOR_LON = 10.5;
const SEMI = 2 ** 31 / 180; // degrees → semicircles

interface Rec {
  t: number; // unix seconds
  lat: number;
  lon: number;
  altM: number;
  speedMs: number;
  distM: number;
  hr: number | null;
  cad: number | null;
  powerW: number | null;
}

/** FIT CRC-16 (per FIT SDK reference implementation) */
function fitCrc(bytes: Uint8Array, crc = 0): number {
  const table = [
    0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
    0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
  ];
  for (const b of bytes) {
    let tmp = table[crc & 0xf] as number;
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ (table[b & 0xf] as number);
    tmp = table[crc & 0xf] as number;
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ (table[(b >> 4) & 0xf] as number);
  }
  return crc;
}

class ByteWriter {
  private buf: number[] = [];
  u8(v: number): void {
    this.buf.push(v & 0xff);
  }
  u16(v: number): void {
    this.u8(v);
    this.u8(v >> 8);
  }
  u32(v: number): void {
    this.u16(v);
    this.u16(Math.floor(v / 65536));
  }
  s32(v: number): void {
    this.u32(v < 0 ? v + 0x100000000 : v);
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}

/** field def triple: (field number, size, base type) */
type FieldDef = [number, number, number];
const U8 = 0x02;
const U16 = 0x84;
const U32 = 0x86;
const S32 = 0x85;
const ENUM = 0x00;

function defMsg(local: number, global: number, fields: FieldDef[]): Uint8Array {
  const w = new ByteWriter();
  w.u8(0x40 | local);
  w.u8(0); // reserved
  w.u8(0); // little-endian
  w.u16(global);
  w.u8(fields.length);
  for (const [num, size, base] of fields) {
    w.u8(num);
    w.u8(size);
    w.u8(base);
  }
  return w.bytes();
}

export class RideRecorder {
  private recs: Rec[] = [];
  private dist = 0;
  private lastT: number | null = null;

  /** 1 Hz-ish sampling; callers may tick every frame — we decimate here */
  addSample(
    nowMs: number,
    x: number,
    z: number,
    altM: number,
    speedMs: number,
    sample: RideSample | null,
    powerW: number | null,
  ): void {
    const t = Math.floor(nowMs / 1000);
    if (this.lastT === t) return;
    if (this.lastT !== null) this.dist += speedMs * (t - this.lastT);
    this.lastT = t;
    // world meters → fictional geographic degrees around the anchor
    const lat = ANCHOR_LAT - z / 111_320;
    const lon = ANCHOR_LON + x / (111_320 * Math.cos((ANCHOR_LAT * Math.PI) / 180));
    this.recs.push({
      t,
      lat,
      lon,
      altM,
      speedMs,
      distM: this.dist,
      hr: sample?.heartRateBpm ?? null,
      cad: sample?.cadenceRpm ?? null,
      powerW,
    });
  }

  /** serialize the whole session as a FIT activity file */
  exportFit(): Uint8Array {
    const body = new ByteWriter();
    const push = (u: Uint8Array): void => {
      for (const b of u) body.u8(b);
    };
    const ts = (unix: number): number => unix - FIT_EPOCH_OFFSET_S;

    // ---- file_id (global 0, local 0) --------------------------------------
    push(
      defMsg(0, 0, [
        [0, 1, ENUM], // type = 4 (activity)
        [1, 2, U16], // manufacturer = 255 (development)
        [2, 2, U16], // product
        [4, 4, U32], // time_created
      ]),
    );
    const t0 = this.recs.length > 0 ? (this.recs[0] as Rec).t : Math.floor(Date.now() / 1000);
    const t1 = this.recs.length > 0 ? (this.recs[this.recs.length - 1] as Rec).t : t0;
    body.u8(0);
    body.u8(4);
    body.u16(255);
    body.u16(1);
    body.u32(ts(t0));

    // ---- record stream (global 20, local 1) --------------------------------
    push(
      defMsg(1, 20, [
        [253, 4, U32], // timestamp
        [0, 4, S32], // position_lat (semicircles)
        [1, 4, S32], // position_long
        [2, 2, U16], // altitude ((m+500)*5)
        [3, 1, U8], // heart_rate
        [4, 1, U8], // cadence
        [5, 4, U32], // distance (m*100)
        [6, 2, U16], // speed (m/s*1000)
        [7, 2, U16], // power (W)
      ]),
    );
    for (const r of this.recs) {
      body.u8(1);
      body.u32(ts(r.t));
      body.s32(Math.round(r.lat * SEMI));
      body.s32(Math.round(r.lon * SEMI));
      body.u16(Math.round((r.altM + 500) * 5));
      body.u8(r.hr === null ? 0xff : Math.round(r.hr));
      body.u8(r.cad === null ? 0xff : Math.round(r.cad));
      body.u32(Math.round(r.distM * 100));
      body.u16(Math.round(r.speedMs * 1000));
      body.u16(r.powerW === null ? 0xffff : Math.round(r.powerW));
    }

    // ---- session (global 18, local 2) --------------------------------------
    push(
      defMsg(2, 18, [
        [253, 4, U32], // timestamp
        [2, 4, U32], // start_time
        [7, 4, U32], // total_elapsed_time (s*1000)
        [9, 4, U32], // total_distance (m*100)
        [5, 1, ENUM], // sport = 2 (cycling)
      ]),
    );
    body.u8(2);
    body.u32(ts(t1));
    body.u32(ts(t0));
    body.u32((t1 - t0) * 1000);
    body.u32(Math.round(this.dist * 100));
    body.u8(2);

    // ---- activity (global 34, local 3) --------------------------------------
    push(
      defMsg(3, 34, [
        [253, 4, U32], // timestamp
        [1, 2, U16], // num_sessions
        [2, 1, ENUM], // type = 0 (manual)
      ]),
    );
    body.u8(3);
    body.u32(ts(t1));
    body.u16(1);
    body.u8(0);

    // ---- header + CRC --------------------------------------------------------
    const data = body.bytes();
    const header = new ByteWriter();
    header.u8(14);
    header.u8(0x20); // protocol 2.0
    header.u16(2194); // profile version
    header.u32(data.length);
    header.u8('.'.charCodeAt(0));
    header.u8('F'.charCodeAt(0));
    header.u8('I'.charCodeAt(0));
    header.u8('T'.charCodeAt(0));
    const head12 = header.bytes();
    const headCrc = fitCrc(head12);
    const out = new Uint8Array(14 + data.length + 2);
    out.set(head12, 0);
    out[12] = headCrc & 0xff;
    out[13] = headCrc >> 8;
    out.set(data, 14);
    const crc = fitCrc(out.subarray(0, 14 + data.length));
    out[14 + data.length] = crc & 0xff;
    out[15 + data.length] = crc >> 8;
    return out;
  }

  /** browser download (Ctrl+E) */
  download(): void {
    if (this.recs.length < 2) return;
    const blob = new Blob([this.exportFit().buffer as ArrayBuffer], {
      type: 'application/octet-stream',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `rando-ride-${new Date().toISOString().replace(/[:.]/g, '-')}.fit`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  get sampleCount(): number {
    return this.recs.length;
  }
}
