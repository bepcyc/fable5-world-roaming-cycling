/**
 * Unit tests for src/ride/ble/Parsers.ts — pure GATT characteristic parsers.
 * Every packet is a hand-built little-endian DataView; expectations follow the
 * documented field layout in the parsers' own comments (HR 0x2A37, CPS 0x2A63,
 * CSC 0x2A5B, RSC 0x2A53, FTMS 0x2AD2/0x2ACC/0x2AD9/0x2ADA).
 */

import { describe, expect, it } from 'vitest';

import {
  encodeRequestControl,
  encodeReset,
  encodeSimParams,
  encodeSpinDownStart,
  encodeStart,
  encodeStop,
  encodeTargetPower,
  FTMS_CONTROL_INFO,
  FTMS_OP,
  FTMS_SPIN_DOWN,
  parseCpFeature,
  parseCsc,
  parseCscFeature,
  parseCyclingPower,
  parseFtmsCpResponse,
  parseFtmsFeatures,
  parseHeartRate,
  parseIndoorBikeData,
  parseRsc,
  parseSpinDownResponse,
  parseSpinDownStatus,
  RevolutionRate,
} from '../src/ride/ble/Parsers';

function dv(bytes: number[]): DataView {
  return new DataView(new Uint8Array(bytes).buffer);
}

function bytes(buf: ArrayBuffer): number[] {
  return [...new Uint8Array(buf)];
}

describe('parseHeartRate (0x2A37)', () => {
  it('reads u8 heart rate with no optional fields', () => {
    const r = parseHeartRate(dv([0x00, 72]));
    expect(r.bpm).toBe(72);
    expect(r.sensorContact).toBeNull();
    expect(r.energyKj).toBeNull();
    expect(r.rrS).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it('reads u16 heart rate when flags bit0 set', () => {
    expect(parseHeartRate(dv([0x01, 0x48, 0x00])).bpm).toBe(72);
  });

  it('decodes sensor-contact bits: supported+contact vs supported+no-contact', () => {
    expect(parseHeartRate(dv([0x06, 60])).sensorContact).toBe(true);
    expect(parseHeartRate(dv([0x04, 60])).sensorContact).toBe(false);
    expect(parseHeartRate(dv([0x02, 60])).sensorContact).toBeNull();
  });

  it('reads energy expended (u16 kJ) on bit3', () => {
    expect(parseHeartRate(dv([0x08, 70, 0x10, 0x00])).energyKj).toBe(16);
  });

  it('converts RR intervals from 1/1024 s to seconds, oldest first', () => {
    const r = parseHeartRate(dv([0x10, 72, 0x00, 0x04, 0x00, 0x02]));
    expect(r.rrS).toEqual([1, 0.5]);
    expect(r.truncated).toBe(false);
  });

  it('flags an empty packet truncated instead of throwing', () => {
    const r = parseHeartRate(dv([]));
    expect(r.bpm).toBeNull();
    expect(r.truncated).toBe(true);
  });
});

describe('parseCyclingPower (0x2A63)', () => {
  it('reads mandatory sint16 power and reports all optional fields absent', () => {
    const r = parseCyclingPower(dv([0x00, 0x00, 0xfa, 0x00]));
    expect(r.powerW).toBe(250);
    expect(r.pedalBalancePct).toBeNull();
    expect(r.wheel).toBeNull();
    expect(r.crank).toBeNull();
    expect(r.truncated).toBe(false);
  });

  it('keeps signed power negative (sint16, not uint)', () => {
    expect(parseCyclingPower(dv([0x00, 0x00, 0x9c, 0xff])).powerW).toBe(-100);
  });

  it('decodes pedal balance at 1/2 % with left-reference bit', () => {
    const r = parseCyclingPower(dv([0x03, 0x00, 0xfa, 0x00, 0x64]));
    expect(r.pedalBalancePct).toBe(50);
    expect(r.balanceRefLeft).toBe(true);
  });

  it('reads wheel revolutions u32 + event time u16 (1/2048 s units kept raw)', () => {
    const r = parseCyclingPower(
      dv([0x10, 0x00, 0xfa, 0x00, 0x04, 0x03, 0x02, 0x01, 0x00, 0x08]),
    );
    expect(r.wheel).toEqual({ revs: 0x01020304, eventT: 0x0800 });
  });

  it('reads crank revolutions u16 + event time u16', () => {
    const r = parseCyclingPower(dv([0x20, 0x00, 0xfa, 0x00, 0xf4, 0x01, 0x00, 0x04]));
    expect(r.crank).toEqual({ revs: 500, eventT: 1024 });
  });

  it('converts accumulated energy kJ to kcal via jToCal', () => {
    const r = parseCyclingPower(dv([0x00, 0x08, 0xfa, 0x00, 0xe8, 0x03]));
    expect(r.accEnergyKcal).toBeCloseTo(239.006, 3);
  });

  it('never throws on a flags word that lies about payload length', () => {
    const run = (): ReturnType<typeof parseCyclingPower> =>
      parseCyclingPower(dv([0xff, 0xff, 0xfa, 0x00]));
    expect(run).not.toThrow();
    expect(run().truncated).toBe(true);
  });
});

describe('parseCsc (0x2A5B)', () => {
  it('reads wheel (u32+u16) and crank (u16+u16) revolution data', () => {
    const r = parseCsc(
      dv([0x03, 0x40, 0xe2, 0x01, 0x00, 0x00, 0x08, 0x4d, 0x00, 0x00, 0x02]),
    );
    expect(r.wheel).toEqual({ revs: 123456, eventT: 2048 });
    expect(r.crank).toEqual({ revs: 77, eventT: 512 });
    expect(r.truncated).toBe(false);
  });

  it('reports wheel absent when only the crank bit is set', () => {
    const r = parseCsc(dv([0x02, 0x4d, 0x00, 0x00, 0x02]));
    expect(r.wheel).toBeNull();
    expect(r.crank).toEqual({ revs: 77, eventT: 512 });
  });

  it('flags an empty packet truncated', () => {
    expect(parseCsc(dv([])).truncated).toBe(true);
  });
});

describe('feature characteristics (0x2A65 / 0x2A5C)', () => {
  it('parseCpFeature reads u32 bits 2 (wheel) and 3 (crank)', () => {
    expect(parseCpFeature(dv([0x0c, 0x00, 0x00, 0x00]))).toEqual({
      wheelRevolutionSupported: true,
      crankRevolutionSupported: true,
    });
  });

  it('parseCscFeature reads u16 bits 0 (wheel) and 1 (crank)', () => {
    expect(parseCscFeature(dv([0x03, 0x00]))).toEqual({
      wheelRevolutionSupported: true,
      crankRevolutionSupported: true,
    });
  });
});

describe('parseRsc (0x2A53)', () => {
  it('converts speed from 1/256 m/s to km/h and reads step cadence', () => {
    const r = parseRsc(dv([0x00, 0x00, 0x0a, 0x5a]));
    expect(r.speedKmh).toBeCloseTo(36, 5);
    expect(r.cadenceSpm).toBe(90);
    expect(r.distanceM).toBeNull();
  });

  it('reads total distance at 1/10 m when flag bit1 set', () => {
    const r = parseRsc(dv([0x02, 0x00, 0x0a, 0x5a, 0x39, 0x30, 0x00, 0x00]));
    expect(r.distanceM).toBeCloseTo(1234.5, 5);
  });
});

describe('RevolutionRate', () => {
  it('returns null on the first packet (baseline only), then a rate', () => {
    const rr = new RevolutionRate(1024, 16);
    expect(rr.push(10, 1000, 0)).toBeNull();
    expect(rr.push(13, 2024, 0.1)).toBe(3); // 3 revs / 1024 ticks = 3 rev/s
  });

  it('treats a small u16 wrap (65534 -> 3) as genuine rollover', () => {
    const rr = new RevolutionRate(1024, 16);
    rr.push(65534, 1000, 0);
    expect(rr.push(3, 2024, 0.1)).toBe(5); // wrapped delta 5 revs / 1 s
  });

  it('rejects implausible forward jumps as spikes, then re-baselines on reset', () => {
    const rr = new RevolutionRate(1024, 16);
    rr.push(10, 1000, 0);
    expect(rr.push(13, 2024, 0.1)).toBe(3);
    // forward jump of 49987 revs in 1 s — spike, rate rejected
    expect(rr.push(50000, 3048, 0.1)).toBeNull();
    // 50000 -> 10 is a physical reset (negative delta too large to be a wrap)
    expect(rr.push(10, 4072, 0.1)).toBeNull();
    // new baseline produces a rate again
    expect(rr.push(12, 5096, 0.1)).toBe(2);
  });

  it('holds the last rate while the counter stalls, decays to 0 after staleS', () => {
    const rr = new RevolutionRate(1024, 16, 1.0);
    rr.push(10, 1000, 0);
    rr.push(13, 2024, 0.1); // rate 3
    // identical counter readings: real sample ("sensor alive, no new rev")
    expect(rr.push(13, 2024, 0.6)).toBe(3); // idle 0.6 s < staleS 1.0
    expect(rr.push(13, 2024, 0.6)).toBe(0); // idle 1.2 s >= staleS
  });

  it('tick() decays the held rate without a notification', () => {
    const rr = new RevolutionRate(1024, 16, 1.0);
    rr.push(10, 1000, 0);
    rr.push(13, 2024, 0.1);
    rr.tick(0.5);
    expect(rr.revPerS()).toBe(3);
    rr.tick(0.6);
    expect(rr.revPerS()).toBe(0);
  });
});

describe('parseIndoorBikeData (FTMS 0x2AD2)', () => {
  // flags bit2|bit4|bit6|bit9|bit11 = 0x0A54; bit0 clear -> speed IS present
  const fullPacket = [
    0x54, 0x0a, // flags u16
    0xac, 0x0d, // instant speed u16 /100 = 35.00 km/h
    0xb4, 0x00, // instant cadence u16 /2 = 90 rpm
    0x40, 0xe2, 0x01, // total distance u24 = 123456 m
    0xfa, 0x00, // instant power s16 = 250 W
    0x8e, // heart rate u8 = 142
    0x58, 0x02, // elapsed u16 = 600 s
  ];

  it('walks flag-bit fields in spec order', () => {
    const r = parseIndoorBikeData(dv(fullPacket));
    expect(r.speedKmh).toBe(35);
    expect(r.cadenceRpm).toBe(90);
    expect(r.totalDistanceM).toBe(123456);
    expect(r.powerW).toBe(250);
    expect(r.heartRateBpm).toBe(142);
    expect(r.elapsedS).toBe(600);
    expect(r.truncated).toBe(false);
  });

  it('reports absent fields as null, including unset resistance', () => {
    const r = parseIndoorBikeData(dv(fullPacket));
    expect(r.resistance).toBeNull();
  });

  it('treats flag bit0 as NEGATED: speed present only when the bit is 0', () => {
    // bit0 = 1 ("More Data") -> no instantaneous speed field at all
    const r = parseIndoorBikeData(dv([0x01, 0x00]));
    expect(r.speedKmh).toBeNull();
    expect(r.truncated).toBe(false);
  });

  it('keeps sint16 power signed', () => {
    // flags bit6 only; speed still present (bit0=0) -> 2 speed bytes, then s16
    const r = parseIndoorBikeData(dv([0x40, 0x00, 0xac, 0x0d, 0xce, 0xff]));
    expect(r.powerW).toBe(-50);
  });

  it('flags a truncated packet and yields nulls instead of throwing', () => {
    const r = parseIndoorBikeData(dv([0x54, 0x0a])); // flags only, no payload
    expect(r.truncated).toBe(true);
    expect(r.speedKmh).toBeNull();
    expect(r.cadenceRpm).toBeNull();
    expect(r.powerW).toBeNull();
  });
});

describe('parseFtmsFeatures (0x2ACC)', () => {
  it('splits the machine and target-setting u32 bitfields', () => {
    const r = parseFtmsFeatures(
      dv([
        0x02, 0x40, 0x00, 0x00, // machine: cadence (bit1) + power (bit14)
        0x08, 0xe0, 0x00, 0x00, // targets: power (bit3) + sim (13) + wheel (14) + spindown (15)
      ]),
    );
    expect(r.cadence).toBe(true);
    expect(r.powerMeasurement).toBe(true);
    expect(r.resistanceLevel).toBe(false);
    expect(r.heartRate).toBe(false);
    expect(r.powerTarget).toBe(true);
    expect(r.resistanceTarget).toBe(false);
    expect(r.indoorBikeSimulation).toBe(true);
    expect(r.wheelCircumference).toBe(true);
    expect(r.spinDown).toBe(true);
  });
});

describe('FTMS control-point encoders (0x2AD9)', () => {
  it('encodes target power as op 0x05 + sint16 W LE', () => {
    expect(bytes(encodeTargetPower(250))).toEqual([FTMS_OP.setTargetPower, 0xfa, 0x00]);
  });

  it('clamps target power into the sint16 range', () => {
    expect(bytes(encodeTargetPower(40000))).toEqual([FTMS_OP.setTargetPower, 0xff, 0x7f]);
  });

  it('encodes sim params: wind s16 (0.001 m/s), grade s16 (0.01 %), crr u8, cw u8', () => {
    // grade is a FRACTION on the wire contract: 0.05 -> 500 x 0.01% = 5%
    expect(bytes(encodeSimParams(0, 0.05, 0.005, 0.5))).toEqual([
      FTMS_OP.setIndoorBikeSimulation,
      0x00, 0x00, // wind 0 m/s
      0xf4, 0x01, // grade 500
      0x32, // crr 50 x 0.0001
      0x32, // cw 50 x 0.01 kg/m
    ]);
  });

  it('encodes the one-byte workout opcodes', () => {
    expect(bytes(encodeRequestControl())).toEqual([FTMS_OP.requestControl]);
    expect(bytes(encodeReset())).toEqual([FTMS_OP.reset]);
    expect(bytes(encodeStart())).toEqual([FTMS_OP.start]);
  });

  it('encodes stop/pause with the control-info byte', () => {
    expect(bytes(encodeStop())).toEqual([FTMS_OP.stop, FTMS_CONTROL_INFO.stop]);
    expect(bytes(encodeStop(FTMS_CONTROL_INFO.pause))).toEqual([
      FTMS_OP.stop,
      FTMS_CONTROL_INFO.pause,
    ]);
  });

  it('encodes the spin-down start command', () => {
    expect(bytes(encodeSpinDownStart())).toEqual([
      FTMS_OP.spinDownControl,
      FTMS_SPIN_DOWN.startCommand,
    ]);
  });
});

describe('FTMS control-point responses', () => {
  it('parses a success indication into requestOp/result/ok', () => {
    expect(parseFtmsCpResponse(dv([0x80, 0x05, 0x01]))).toEqual({
      requestOp: FTMS_OP.setTargetPower,
      result: 0x01,
      ok: true,
    });
  });

  it('reports a non-success result code as not ok', () => {
    const r = parseFtmsCpResponse(dv([0x80, 0x05, 0x02]));
    expect(r?.ok).toBe(false);
  });

  it('returns null on a non-0x80 or short payload', () => {
    expect(parseFtmsCpResponse(dv([0x05, 0x01]))).toBeNull();
    expect(parseFtmsCpResponse(dv([0x80]))).toBeNull();
  });

  it('parses spin-down target speeds from the 7-byte response', () => {
    const r = parseSpinDownResponse(dv([0x80, 0x13, 0x01, 0x0f, 0xa0, 0x07, 0xd0]));
    expect(r?.targetSpeedHighKmh).toBe(40);
    expect(r?.targetSpeedLowKmh).toBe(20);
  });

  it('reads the spin-down status frame on 0x2ADA', () => {
    expect(parseSpinDownStatus(dv([0x14, FTMS_SPIN_DOWN.stopPedaling]))).toBe(4);
    expect(parseSpinDownStatus(dv([0x15, 0x02]))).toBeNull();
    expect(parseSpinDownStatus(dv([0x14]))).toBeNull();
  });
});
