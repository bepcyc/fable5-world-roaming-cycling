/**
 * Unit tests for src/core/Seed.ts — deterministic seeding. The whole world
 * derives from one uint32 seed; these tests pin the derivation contract:
 * same seed+stream -> same sequence, different stream -> decorrelated.
 */

import { describe, expect, it } from 'vitest';

import { hashCombine, hashString, mix32, Rng, WorldSeed } from '../src/core/Seed';

describe('hashString / mix32 / hashCombine', () => {
  it('is deterministic for a fixed input', () => {
    expect(hashString('grass')).toBe(hashString('grass'));
    expect(mix32(12345)).toBe(mix32(12345));
    expect(hashCombine(1, 2)).toBe(hashCombine(1, 2));
  });

  it('returns uint32 values', () => {
    for (const v of [hashString('a long stream label'), mix32(0xffffffff), hashCombine(-5, 7)]) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('decorrelates different labels', () => {
    expect(hashString('grass')).not.toBe(hashString('trees'));
    expect(hashCombine(1, hashString('a'))).not.toBe(hashCombine(1, hashString('b')));
  });
});

describe('Rng', () => {
  it('reproduces an identical sequence from the same seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const seqA = Array.from({ length: 8 }, () => a.u32());
    const seqB = Array.from({ length: 8 }, () => b.u32());
    expect(seqA).toEqual(seqB);
    // and it is not a constant stream
    expect(new Set(seqA).size).toBeGreaterThan(1);
  });

  it('diverges for different seeds', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    expect(Array.from({ length: 4 }, () => a.u32())).not.toEqual(
      Array.from({ length: 4 }, () => b.u32()),
    );
  });

  it('float() stays inside [0, 1)', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 100; i++) {
      const v = rng.float();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('range() and int() respect their bounds', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 50; i++) {
      const r = rng.range(-2, 3);
      expect(r).toBeGreaterThanOrEqual(-2);
      expect(r).toBeLessThan(3);
      const n = rng.int(6);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(6);
    }
  });

  it('chance() honors the boundary probabilities', () => {
    const rng = new Rng(7);
    expect(rng.chance(0)).toBe(false);
    expect(rng.chance(1)).toBe(true);
  });

  it('gauss() yields finite values', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 10; i++) expect(Number.isFinite(rng.gauss())).toBe(true);
  });

  it('pick() returns array members and throws on an empty array', () => {
    const rng = new Rng(7);
    const items = ['a', 'b', 'c'] as const;
    for (let i = 0; i < 10; i++) expect(items).toContain(rng.pick(items));
    expect(() => rng.pick([])).toThrow('Rng.pick on empty array');
  });

  it('fork() produces a deterministic, decorrelated child stream', () => {
    const parentA = new Rng(9);
    const parentB = new Rng(9);
    const childA = parentA.fork('roads');
    const childB = parentB.fork('roads');
    expect(Array.from({ length: 4 }, () => childA.u32())).toEqual(
      Array.from({ length: 4 }, () => childB.u32()),
    );
    const childC = new Rng(9).fork('rivers');
    expect(Array.from({ length: 4 }, () => childC.u32())).not.toEqual(
      Array.from({ length: 4 }, () => childA.u32()),
    );
  });
});

describe('WorldSeed', () => {
  it('gives the same stream sequence for the same seed+label', () => {
    const w = new WorldSeed(123);
    const seqA = Array.from({ length: 4 }, () => w.rng('roads').u32());
    const seqB = Array.from({ length: 4 }, () => w.rng('roads').u32());
    expect(seqA).toEqual(seqB); // order-independent: a fresh Rng each call
  });

  it('decorrelates different stream labels', () => {
    const w = new WorldSeed(123);
    const roads = Array.from({ length: 4 }, () => w.rng('roads').u32());
    const rivers = Array.from({ length: 4 }, () => w.rng('rivers').u32());
    expect(roads).not.toEqual(rivers);
  });

  it('wraps the seed to uint32', () => {
    expect(new WorldSeed(-1).seed).toBe(0xffffffff);
    expect(new WorldSeed(2 ** 32 + 5).seed).toBe(5);
  });

  it('sub() is a stable uint32 sub-seed per stream label', () => {
    const w = new WorldSeed(55);
    expect(w.sub('gpu.grass')).toBe(w.sub('gpu.grass'));
    expect(w.sub('gpu.grass')).not.toBe(w.sub('gpu.trees'));
    expect(Number.isInteger(w.sub('gpu.grass'))).toBe(true);
  });
});
