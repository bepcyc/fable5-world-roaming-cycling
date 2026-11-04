/**
 * Unit tests for src/ride/RouteGraph.ts — junction topology recovery over the
 * road network plus polyline sampling. The builder only reads `net.routes`,
 * so tests feed it synthetic routes without constructing a real RoadNetwork
 * (whose module graph pulls in worker machinery). `RoadNetwork`/`RoadPoint`/
 * `RoadRoute` are imported type-only — no runtime dependency.
 */

import { describe, expect, it } from 'vitest';

import type { RoadClassSpec, RoadNetwork, RoadPoint, RoadRoute } from '../src/ride/RoadNetwork';
import { RouteGraph, samplePolyline } from '../src/ride/RouteGraph';

const CLS = {} as RoadClassSpec; // spec fields are pass-through only

function pt(x: number, z: number, s: number, y = 0): RoadPoint {
  return { x, z, y, bank: 0, ford: false, s };
}

/** polyline -> RoadRoute with cumulative arclength `s` filled in */
function route(name: string, coords: [number, number][]): RoadRoute {
  const pts: RoadPoint[] = [];
  let s = 0;
  for (let i = 0; i < coords.length; i++) {
    const [x, z] = coords[i] as [number, number];
    if (i > 0) {
      const [px, pz] = coords[i - 1] as [number, number];
      s += Math.hypot(x - px, z - pz);
    }
    pts.push(pt(x, z, s));
  }
  return { name, cls: CLS, pts, length: s };
}

function net(routes: RoadRoute[]): RoadNetwork {
  return { routes } as unknown as RoadNetwork;
}

describe('RouteGraph.build', () => {
  it('recovers a crossroad: one junction node of degree 4, four edges', () => {
    // A runs west->east through (40,0); B runs south->north through the same
    // point. Points 10 m spacing; the whole intersection neighbourhood must
    // cluster into ONE node (JOIN_R = 15 m).
    const a = route('east-west', [
      [0, 0],
      [10, 0],
      [20, 0],
      [30, 0],
      [40, 0],
      [50, 0],
      [60, 0],
      [70, 0],
      [80, 0],
    ]);
    const b = route('south-north', [
      [40, -40],
      [40, -30],
      [40, -20],
      [40, -10],
      [40, 0],
      [40, 10],
      [40, 20],
      [40, 30],
      [40, 40],
    ]);
    const g = RouteGraph.build(net([a, b]));

    expect(g.edges).toHaveLength(4); // each route split once, at the junction
    expect(g.nodes).toHaveLength(5); // junction + 4 route endpoints

    const junction = g.nodes.find((n) => n.arms.length === 4);
    expect(junction).toBeDefined();
    expect(junction?.x).toBeCloseTo(40, 5);
    expect(junction?.z).toBeCloseTo(0, 5);

    // every edge touches the junction at exactly one end
    for (const e of g.edges) {
      expect([e.a, e.b]).toContain(junction?.id);
      expect(e.length).toBeCloseTo(40, 5);
    }
  });

  it('gives a junction-free route two endpoint nodes and one edge', () => {
    const only = route('solo', [
      [0, 0],
      [10, 0],
      [20, 0],
    ]);
    const g = RouteGraph.build(net([only]));
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toHaveLength(1);
    for (const n of g.nodes) expect(n.arms).toHaveLength(1);
  });

  it('does NOT junction a hairpin with itself (same-route near misses)', () => {
    // a U-shape folding back 10 m away: opposite legs sit inside JOIN_R of
    // each other but on ONE route, so no junction may form.
    const hairpin = route('hairpin', [
      [0, 0],
      [20, 0],
      [40, 0],
      [60, 0],
      [60, 10],
      [40, 10],
      [20, 10],
      [0, 10],
    ]);
    const g = RouteGraph.build(net([hairpin]));
    expect(g.nodes).toHaveLength(2); // just the two endpoints
    expect(g.edges).toHaveLength(1);
  });

  it('exits() enumerates node arms minus the arrival edge', () => {
    const cross = [
      route('east-west', [
        [0, 0],
        [10, 0],
        [20, 0],
        [30, 0],
        [40, 0],
        [50, 0],
        [60, 0],
        [70, 0],
        [80, 0],
      ]),
      route('south-north', [
        [40, -40],
        [40, -30],
        [40, -20],
        [40, -10],
        [40, 0],
        [40, 10],
        [40, 20],
        [40, 30],
        [40, 40],
      ]),
    ];
    const g = RouteGraph.build(net(cross));
    const junction = g.nodes.find((n) => n.arms.length === 4);
    expect(junction).toBeDefined();
    const id = junction?.id ?? -1;
    expect(g.exits(id, null)).toHaveLength(4);
    const arrived = junction?.arms[0]?.edge ?? -1;
    expect(g.exits(id, arrived)).toHaveLength(3);
  });
});

describe('RouteGraph.project', () => {
  it('finds the nearest edge and arclength for an on-road point', () => {
    const r = route('east-west', [
      [0, 0],
      [40, 0],
      [80, 0],
    ]);
    const g = RouteGraph.build(net([r]));
    const p = g.project(45, 0);
    expect(p.dist).toBeCloseTo(0, 5);
    expect(p.s).toBeCloseTo(45, 5);
    expect(p.edge).toBe(0);
  });

  it('measures distance to the projected point for an off-road query', () => {
    const r = route('east-west', [
      [0, 0],
      [40, 0],
    ]);
    const g = RouteGraph.build(net([r]));
    const p = g.project(20, 30);
    expect(p.dist).toBeCloseTo(30, 5);
    expect(p.s).toBeCloseTo(20, 5);
  });
});

describe('samplePolyline', () => {
  // corner polyline: (0,0) -> (10,0) -> (10,10), s = 0,10,20
  const corner = [pt(0, 0, 0), pt(10, 0, 10), pt(10, 10, 20)];

  it('interpolates position and unit tangent along a span', () => {
    const mid = samplePolyline(corner, 20, 5);
    expect(mid.x).toBeCloseTo(5, 5);
    expect(mid.z).toBeCloseTo(0, 5);
    expect(mid.tx).toBeCloseTo(1, 5);
    expect(mid.tz).toBeCloseTo(0, 5);
    const bend = samplePolyline(corner, 20, 15);
    expect(bend.x).toBeCloseTo(10, 5);
    expect(bend.z).toBeCloseTo(5, 5);
    expect(bend.tx).toBeCloseTo(0, 5);
    expect(bend.tz).toBeCloseTo(1, 5);
  });

  it('clamps s to both ends of the polyline', () => {
    const start = samplePolyline(corner, 20, -5);
    expect(start.x).toBeCloseTo(0, 5);
    const end = samplePolyline(corner, 20, 99);
    expect(end.x).toBeCloseTo(10, 5);
    expect(end.z).toBeCloseTo(10, 5);
  });

  it('reports grade as dy/run and lerps y and bank', () => {
    const hill = [pt(0, 0, 0, 0), pt(10, 0, 10, 20)];
    const mid = samplePolyline(hill, 10, 5);
    expect(mid.y).toBeCloseTo(10, 5);
    expect(mid.grade).toBeCloseTo(2, 5); // +20 m over a 10 m run

    const banked = [
      { ...pt(0, 0, 0), bank: 0 },
      { ...pt(10, 0, 10), bank: 0.4 },
    ];
    expect(samplePolyline(banked, 10, 5).bank).toBeCloseTo(0.2, 5);
  });

  it('flags the sample ford if either span endpoint is ford', () => {
    const wet = [
      { ...pt(0, 0, 0), ford: false },
      { ...pt(10, 0, 10), ford: true },
    ];
    expect(samplePolyline(wet, 10, 5).ford).toBe(true);
    expect(samplePolyline(corner, 20, 5).ford).toBe(false);
  });
});
