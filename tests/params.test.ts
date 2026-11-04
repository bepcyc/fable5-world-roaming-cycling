/**
 * Unit tests for src/core/Params.ts — URL parameter parsing. The parsers take
 * the query string explicitly (the `window.location.search` default is never
 * evaluated under Node), so the whole surface is testable headless.
 */

import { describe, expect, it } from 'vitest';

import { parseCamString, parseParams, prepassMode, shadowMapSize } from '../src/core/Params';

describe('parseParams', () => {
  it('returns documented defaults on an empty query', () => {
    const p = parseParams('');
    expect(p.seed).toBe(1);
    expect(p.scene).toBe('world');
    expect(p.timeOfDay).toBe(14);
    expect(p.preset).toBe('high');
    expect(p.hud).toBe(false);
    expect(p.cam).toBeNull();
    expect(p.shot).toBeNull();
    expect(p.freeze).toBe(false);
    expect(p.dpr).toBeNull();
    expect(p.threads).toBe(0);
    expect(p.fixedDt).toBeCloseTo(1 / 120, 6);
    expect(p.rideDev).toBe(false);
    expect(p.debug).toBe(false);
    expect(p.noTimestamp).toBe(false);
    expect(p.segments).toBe(false);
  });

  it('floors and wraps the seed into a uint32', () => {
    expect(parseParams('?seed=42').seed).toBe(42);
    expect(parseParams('?seed=1.9').seed).toBe(1);
    expect(parseParams('?seed=-1').seed).toBe(0xffffffff);
    expect(parseParams('?seed=garbage').seed).toBe(1);
  });

  it('clamps time of day into [0, 24]', () => {
    expect(parseParams('?T=8.5').timeOfDay).toBe(8.5);
    expect(parseParams('?T=-3').timeOfDay).toBe(0);
    expect(parseParams('?T=99').timeOfDay).toBe(24);
  });

  it('accepts the four non-default presets, falls back to high otherwise', () => {
    for (const preset of ['min', 'low', 'mid', 'ultra'] as const) {
      expect(parseParams(`?preset=${preset}`).preset).toBe(preset);
    }
    expect(parseParams('?preset=HIGH').preset).toBe('high');
    expect(parseParams('?preset=extreme').preset).toBe('high');
  });

  it('keeps ?shot only inside the 1..9 bookmark range', () => {
    expect(parseParams('?shot=5').shot).toBe(5);
    expect(parseParams('?shot=0').shot).toBeNull();
    expect(parseParams('?shot=10').shot).toBeNull();
  });

  it('parses boolean flags strictly on "=1"', () => {
    const p = parseParams('?hud=1&freeze=1&ridedev=1&debug=1&notimestamp=1&segments=1');
    expect(p.hud).toBe(true);
    expect(p.freeze).toBe(true);
    expect(p.rideDev).toBe(true);
    expect(p.debug).toBe(true);
    expect(p.noTimestamp).toBe(true);
    expect(p.segments).toBe(true);
    expect(parseParams('?hud=true&freeze=yes').hud).toBe(false);
    expect(parseParams('?hud=true&freeze=yes').freeze).toBe(false);
  });

  it('reads dpr only when the parameter is present', () => {
    expect(parseParams('?dpr=2').dpr).toBe(2);
    expect(parseParams('?dpr=abc').dpr).toBe(1); // present but non-numeric -> 1
    expect(parseParams('').dpr).toBeNull();
  });

  it('clamps ?dt (ms) into [2, 50] and converts to seconds', () => {
    expect(parseParams('?dt=16').fixedDt).toBeCloseTo(0.016, 6);
    expect(parseParams('?dt=1').fixedDt).toBeCloseTo(0.002, 6);
    expect(parseParams('?dt=999').fixedDt).toBeCloseTo(0.05, 6);
  });

  it('passes ?cam through as a raw string', () => {
    expect(parseParams('?cam=1,2,3,0.5,-0.1').cam).toBe('1,2,3,0.5,-0.1');
  });
});

describe('prepassMode', () => {
  it('honors explicit ?prepass overrides on any preset', () => {
    expect(prepassMode('?prepass=0')).toBe('off');
    expect(prepassMode('?prepass=grass')).toBe('grass');
    expect(prepassMode('?prepass=1')).toBe('on');
    expect(prepassMode('?prepass=0&preset=ultra')).toBe('off');
  });

  it('defaults to off on preset=min (measured TBDR loss), on elsewhere', () => {
    expect(prepassMode('?preset=min')).toBe('off');
    expect(prepassMode('')).toBe('on');
    expect(prepassMode('?preset=low')).toBe('on');
  });
});

describe('shadowMapSize', () => {
  it('accepts powers of two inside [256, 4096]', () => {
    expect(shadowMapSize('?shadowmap=256')).toBe(256);
    expect(shadowMapSize('?shadowmap=1024')).toBe(1024);
    expect(shadowMapSize('?shadowmap=4096')).toBe(4096);
  });

  it('falls back to 2048 on non-pow2, out-of-range, or garbage values', () => {
    expect(shadowMapSize('?shadowmap=1000')).toBe(2048);
    expect(shadowMapSize('?shadowmap=8192')).toBe(2048);
    expect(shadowMapSize('?shadowmap=128')).toBe(2048);
    expect(shadowMapSize('?shadowmap=abc')).toBe(2048);
    expect(shadowMapSize('')).toBe(2048);
  });
});

describe('parseCamString', () => {
  it('parses "px,py,pz,yaw,pitch" without fov', () => {
    expect(parseCamString('1,2.5,-3,0.5,-0.25')).toEqual({
      p: [1, 2.5, -3],
      yaw: 0.5,
      pitch: -0.25,
    });
  });

  it('parses the optional fov component', () => {
    expect(parseCamString('1,2,3,0,0,60')).toEqual({ p: [1, 2, 3], yaw: 0, pitch: 0, fov: 60 });
  });

  it('returns null on fewer than five components or non-finite values', () => {
    expect(parseCamString('1,2,3,4')).toBeNull();
    expect(parseCamString('1,2,3,4,nan')).toBeNull();
    expect(parseCamString('a,b,c,d,e')).toBeNull();
    expect(parseCamString('')).toBeNull();
  });
});
