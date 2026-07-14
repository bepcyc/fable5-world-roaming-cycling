/**
 * RouteGraph — runtime junction topology over the M1.2 RoadNetwork.
 *
 * RoadNetwork ships routes as independent polylines; they meet at shared
 * anchors and true crossings (the M1.2 carve blends "junction aprons"
 * there) but carry no explicit topology. This module recovers it once at
 * boot on the CPU: cluster near-coincident points across routes into
 * junction NODES, split every route at its member points, and keep the
 * spans as EDGES. The M1.3 route-following mover walks edges; junction
 * picks (Zwift-style "turn ahead" choice — owner directive: не по рельсам,
 * рельсы только между развилками) enumerate a node's arms.
 *
 * Deterministic: pure function of the (seeded) network — no RNG, no time.
 */

import type { RoadClassSpec, RoadNetwork, RoadPoint } from './RoadNetwork';

/** two routes closer than this join at a node (≥ widest apron overlap).
 *  Raised 9→15 (2026-07-14 dead-end pass): the RoadNetwork stitcher builds
 *  connectors onto the 8 m router lattice, so a real junction touch can land
 *  up to ~1 cell (≈8 m) off the target vertex; 15 m reliably clusters those
 *  and the genuine sub-15 m near-misses the old 9 m left as false dead-ends,
 *  without joining roads that only pass in the distance. */
const JOIN_R = 15; // m
/** splits closer than this along one route collapse into one node */
const MIN_SPAN_PTS = 2;

export interface GraphArm {
  edge: number;
  /** 0 — the edge LEAVES this node at pts[0]; 1 — it ARRIVES at its end */
  end: 0 | 1;
}

export interface GraphNode {
  id: number;
  x: number;
  z: number;
  y: number;
  arms: GraphArm[];
}

export interface GraphEdge {
  id: number;
  /** source route name + class (HUD, probes) */
  route: string;
  cls: RoadClassSpec;
  /** polyline with arclength rebased to 0..length */
  pts: RoadPoint[];
  length: number;
  /** node ids at pts[0] / pts[last] */
  a: number;
  b: number;
}

export interface EdgeSample {
  x: number;
  z: number;
  y: number;
  /** signed grade along +s (rise/run) */
  grade: number;
  bank: number;
  ford: boolean;
  /** unit tangent along +s (XZ plane) */
  tx: number;
  tz: number;
}

interface Projection {
  edge: number;
  s: number;
  dist: number;
}

/** disjoint-set over flattened point keys */
class DSU {
  private parent = new Map<number, number>();
  find(k: number): number {
    let r = this.parent.get(k) ?? k;
    if (r !== k) {
      r = this.find(r);
      this.parent.set(k, r);
    }
    return r;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export class RouteGraph {
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];

  private constructor(nodes: GraphNode[], edges: GraphEdge[]) {
    this.nodes = nodes;
    this.edges = edges;
  }

  static build(net: RoadNetwork): RouteGraph {
    const routes = net.routes;
    const key = (r: number, i: number): number => r * 1_000_000 + i;

    // ---- 1. cluster near points across DIFFERENT routes ------------------
    // (points on the same route only join through a mutual other-route
    // contact — a hairpin passing near itself is NOT a junction)
    const dsu = new DSU();
    const touched = new Set<number>();
    for (let ra = 0; ra < routes.length; ra++) {
      const A = routes[ra] as (typeof routes)[number];
      for (let rb = ra + 1; rb < routes.length; rb++) {
        const B = routes[rb] as (typeof routes)[number];
        for (let i = 0; i < A.pts.length; i++) {
          const pa = A.pts[i] as RoadPoint;
          for (let j = 0; j < B.pts.length; j++) {
            const pb = B.pts[j] as RoadPoint;
            const dx = pa.x - pb.x;
            const dz = pa.z - pb.z;
            if (dx * dx + dz * dz < JOIN_R * JOIN_R) {
              dsu.union(key(ra, i), key(rb, j));
              touched.add(key(ra, i));
              touched.add(key(rb, j));
            }
          }
        }
      }
    }

    // consecutive touched points on one route belong to the same crossing
    for (let r = 0; r < routes.length; r++) {
      const R = routes[r] as (typeof routes)[number];
      for (let i = 0; i + 1 < R.pts.length; i++) {
        if (touched.has(key(r, i)) && touched.has(key(r, i + 1))) {
          dsu.union(key(r, i), key(r, i + 1));
        }
      }
    }

    // ---- 2. cluster → node; per route pick ONE split index per cluster ---
    const clusters = new Map<number, { keys: number[] }>();
    for (const k of touched) {
      const root = dsu.find(k);
      const c = clusters.get(root) ?? { keys: [] };
      c.keys.push(k);
      clusters.set(root, c);
    }

    const nodes: GraphNode[] = [];
    /** route → sorted [ptIndex, nodeId] split list */
    const splits = new Map<number, { i: number; node: number }[]>();
    const addSplit = (r: number, i: number, node: number): void => {
      const list = splits.get(r) ?? [];
      list.push({ i, node });
      splits.set(r, list);
    };

    for (const c of clusters.values()) {
      // node position = centroid of member points
      let sx = 0;
      let sz = 0;
      let sy = 0;
      const perRoute = new Map<number, number[]>();
      for (const k of c.keys) {
        const r = Math.floor(k / 1_000_000);
        const i = k % 1_000_000;
        const p = (routes[r] as (typeof routes)[number]).pts[i] as RoadPoint;
        sx += p.x;
        sz += p.z;
        sy += p.y;
        const list = perRoute.get(r) ?? [];
        list.push(i);
        perRoute.set(r, list);
      }
      const n = c.keys.length;
      const node: GraphNode = {
        id: nodes.length,
        x: sx / n,
        z: sz / n,
        y: sy / n,
        arms: [],
      };
      nodes.push(node);
      for (const [r, idxs] of perRoute) {
        idxs.sort((a, b) => a - b);
        // Usually the median contact represents a route grazing this cluster.
        // But when the contact reaches an ENDPOINT of the route (a road that
        // TERMINATES on another, or a stitcher connector meeting its target
        // near its own tip), split AT that endpoint — the median would land
        // mid-route and orphan the true endpoint as a phantom degree-1 node
        // (2026-07-14 dead-end pass). And a SHORT connector whose whole body
        // falls inside one junction cluster touches it at BOTH ends: split at
        // each so neither orphans (the connector becomes a self-edge on the
        // junction instead of leaving a dead-end). Endpoint-touch wins over
        // the median.
        const len = (routes[r] as (typeof routes)[number]).pts.length;
        const lo = idxs[0] as number;
        const hi = idxs[idxs.length - 1] as number;
        const nearStart = lo < MIN_SPAN_PTS;
        const nearEnd = hi > len - 1 - MIN_SPAN_PTS;
        let added = false;
        if (nearStart) {
          addSplit(r, lo, node.id);
          added = true;
        }
        if (nearEnd && hi !== lo) {
          addSplit(r, hi, node.id);
          added = true;
        }
        // no endpoint touch (or a single index that IS an endpoint) → one
        // split at the median representative of the graze
        if (!added) addSplit(r, idxs[Math.floor(idxs.length / 2)] as number, node.id);
      }
    }

    // route endpoints are nodes too (dead ends / trailheads)
    const endNode = (p: RoadPoint): GraphNode => {
      const node: GraphNode = { id: nodes.length, x: p.x, z: p.z, y: p.y, arms: [] };
      nodes.push(node);
      return node;
    };

    // ---- 3. split routes into edges --------------------------------------
    const edges: GraphEdge[] = [];
    for (let r = 0; r < routes.length; r++) {
      const R = routes[r] as (typeof routes)[number];
      const list = (splits.get(r) ?? []).sort((a, b) => a.i - b.i);
      // clamp splits: too close to an endpoint → merge with the endpoint node
      const inner = list.filter(
        (s) => s.i >= MIN_SPAN_PTS && s.i <= R.pts.length - 1 - MIN_SPAN_PTS,
      );
      // dedupe near-identical split indices (keep first)
      const cuts: { i: number; node: number }[] = [];
      for (const s of inner) {
        const prev = cuts[cuts.length - 1];
        if (prev && s.i - prev.i < MIN_SPAN_PTS) continue;
        cuts.push(s);
      }
      const startNode =
        list.length > 0 && (list[0] as { i: number; node: number }).i < MIN_SPAN_PTS
          ? (nodes[(list[0] as { i: number; node: number }).node] as GraphNode)
          : endNode(R.pts[0] as RoadPoint);
      const last = list[list.length - 1];
      const endN =
        last && last.i > R.pts.length - 1 - MIN_SPAN_PTS
          ? (nodes[last.node] as GraphNode)
          : endNode(R.pts[R.pts.length - 1] as RoadPoint);

      let fromIdx = 0;
      let fromNode = startNode;
      const bounds = [...cuts, { i: R.pts.length - 1, node: endN.id }];
      for (const cut of bounds) {
        if (cut.i - fromIdx < MIN_SPAN_PTS - 1) {
          fromIdx = cut.i;
          fromNode = nodes[cut.node] as GraphNode;
          continue;
        }
        const toNode = nodes[cut.node] as GraphNode;
        // self-edge (a === b): a short stitcher connector whose whole body sat
        // inside ONE junction cluster. Its two ends are already merged into
        // this node, so the two routes it "connected" already share the node —
        // the loop edge is redundant AND harmful (it inflates node degree, so
        // a real dead-end could read as connected, and it offers the mover two
        // turn-menu options that just loop back here). Drop it; the shared
        // node keeps the routes connected. (advisor review 2026-07-14)
        if (fromNode.id === toNode.id) {
          fromIdx = cut.i;
          fromNode = toNode;
          continue;
        }
        const span = R.pts.slice(fromIdx, cut.i + 1);
        const s0 = (span[0] as RoadPoint).s;
        const pts = span.map((p) => ({ ...p, s: p.s - s0 }));
        const edge: GraphEdge = {
          id: edges.length,
          route: R.name,
          cls: R.cls,
          pts,
          length: (pts[pts.length - 1] as RoadPoint).s,
          a: fromNode.id,
          b: toNode.id,
        };
        edges.push(edge);
        fromNode.arms.push({ edge: edge.id, end: 0 });
        toNode.arms.push({ edge: edge.id, end: 1 });
        fromIdx = cut.i;
        fromNode = toNode;
      }
    }

    return new RouteGraph(nodes, edges);
  }

  /** interpolated state at arclength s along an edge (s clamped) */
  sample(edgeId: number, s: number): EdgeSample {
    const e = this.edges[edgeId] as GraphEdge;
    const pts = e.pts;
    const sc = Math.min(Math.max(s, 0), e.length);
    // binary search the span containing sc
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((pts[mid] as RoadPoint).s <= sc) lo = mid;
      else hi = mid;
    }
    const a = pts[lo] as RoadPoint;
    const b = pts[hi] as RoadPoint;
    const ds = Math.max(b.s - a.s, 1e-6);
    const f = (sc - a.s) / ds;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const run = Math.max(Math.hypot(dx, dz), 1e-6);
    return {
      x: a.x + dx * f,
      z: a.z + dz * f,
      y: a.y + (b.y - a.y) * f,
      grade: (b.y - a.y) / run,
      bank: a.bank + (b.bank - a.bank) * f,
      ford: a.ford || b.ford,
      tx: dx / run,
      tz: dz / run,
    };
  }

  /** nearest edge point to (x,z) — brute force, called on mode entry only */
  project(x: number, z: number): Projection {
    let best: Projection = { edge: -1, s: 0, dist: Infinity };
    for (const e of this.edges) {
      for (let i = 0; i + 1 < e.pts.length; i++) {
        const a = e.pts[i] as RoadPoint;
        const b = e.pts[i + 1] as RoadPoint;
        const abx = b.x - a.x;
        const abz = b.z - a.z;
        const len2 = abx * abx + abz * abz;
        const t = len2 > 0 ? Math.min(Math.max(((x - a.x) * abx + (z - a.z) * abz) / len2, 0), 1) : 0;
        const px = a.x + abx * t;
        const pz = a.z + abz * t;
        const d = Math.hypot(x - px, z - pz);
        if (d < best.dist) {
          best = { edge: e.id, s: a.s + (b.s - a.s) * t, dist: d };
        }
      }
    }
    return best;
  }

  /** arms leaving a node, excluding the one we arrived by (if given) */
  exits(nodeId: number, arrivedEdge: number | null): GraphArm[] {
    const node = this.nodes[nodeId] as GraphNode;
    return node.arms.filter((a) => a.edge !== arrivedEdge);
  }
}
