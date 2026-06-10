/**
 * Terrain rendering: CDLOD quadtree of instanced grid patches + far vista shell.
 *
 * - One InstancedMesh draws every active tile; per-tile data (origin, size,
 *   lod) lives in a CPU-writable instanced storage buffer, updated only when
 *   the quadtree changes (camera moved) — never per-frame per-instance.
 * - CDLOD vertex morphing: odd vertices slide toward their even-grid
 *   positions across the outer 35% of each LOD ring → no cracks, no pops.
 * - Far shell: radial ring 1.95–14 km, analytic macro height (far branch),
 *   blended to the baked field across the world edge.
 */

import { InstancedMesh, PlaneGeometry, RingGeometry, Mesh, type PerspectiveCamera } from 'three';
import { MeshStandardNodeMaterial, type StorageBufferNode } from 'three/webgpu';
import {
  cameraPosition,
  clamp,
  float,
  fract,
  instanceIndex,
  instancedArray,
  mix,
  positionLocal,
  positionWorld,
  screenUV,
  texture,
  transformNormalToView,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { buildTerrainShading } from '../render/TerrainMaterial';
import type { Heightfield } from './Heightfield';
import { macroTerrain } from './MacroMap';
import { FAR_RADIUS, WORLD_HALF, WORLD_SIZE } from './WorldConst';

const MAX_TILES = 1100;
const PATCH_SEGS = 64;
/** split while camDist < size·SPLIT_K */
const SPLIT_K = 2.1;
const MIN_TILE = 64;

export class TerrainTiles {
  readonly mesh: InstancedMesh;
  readonly farShell: Mesh;
  private tileData: Float32Array;
  private tileBuf: StorageBufferNode<'vec4'>;
  private lastCamX = Infinity;
  private lastCamZ = Infinity;
  activeTiles = 0;

  constructor(
    hf: Heightfield,
    debugView: string | null = null,
    opts: { heightBuf?: typeof hf.height; neutral?: boolean; screenHalf?: 'left' | 'right' } = {},
  ) {
    // --- per-tile buffer -------------------------------------------------------
    this.tileData = new Float32Array(MAX_TILES * 4);
    this.tileBuf = instancedArray(this.tileData, 'vec4');
    const heightBuf = opts.heightBuf ?? hf.height;

    // --- patch geometry ----------------------------------------------------------
    const patch = new PlaneGeometry(1, 1, PATCH_SEGS, PATCH_SEGS);
    patch.rotateX(-Math.PI / 2); // local xz in [-0.5, 0.5], +y up

    // --- material ---------------------------------------------------------------
    const mat = new MeshStandardNodeMaterial();
    const tile = this.tileBuf.element(instanceIndex);
    const tileOrigin = tile.xy; // world xz of tile center
    const tileSize = tile.z;

    // CDLOD morph: world-space vertex, odd-vertex snap toward even grid
    const local = positionLocal.xz.mul(tileSize);
    const wpos0 = local.add(tileOrigin).toVar();
    const quad = tileSize.div(PATCH_SEGS); // quad size in meters
    const gridUV = positionLocal.xz.add(0.5).mul(PATCH_SEGS); // 0..SEGS
    const odd = fract(gridUV.mul(0.5)).mul(2); // 1 where odd, 0 where even
    const snapped = wpos0.sub(odd.mul(quad)); // snap odd verts down-grid
    const camD = wpos0.sub(cameraPosition.xz).length();
    // morph across the outer band of this LOD's range
    const rangeEnd = tileSize.mul(SPLIT_K).mul(2); // parent split distance
    const morphK = clamp(camD.sub(rangeEnd.mul(0.7)).div(rangeEnd.mul(0.24)), 0, 1);
    const wpos = mix(wpos0, snapped, morphK);

    // instance + object matrices are identity → positionNode is world space
    const hSample = hf.sampleHeightFrom(heightBuf, wpos);
    mat.positionNode = vec3(wpos.x, hSample, wpos.y);

    const shading = buildTerrainShading({
      normalTex: hf.normalTex,
      biomeTex: hf.biomeTex as NonNullable<typeof hf.biomeTex>,
      fieldsTex: hf.fieldsTex as NonNullable<typeof hf.fieldsTex>,
      mp: hf.mp,
      far: false,
    });
    mat.colorNode = shading.colorNode;
    mat.normalNode = shading.normalNode;
    mat.roughnessNode = shading.roughnessNode;
    mat.metalnessNode = float(0);
    if ((debugView === 'snow' || debugView === 'bioR' || debugView === 'bioB') && hf.biomeTex) {
      // single-channel classification view: white = channel value
      const b = texture(hf.biomeTex, positionWorld.xz.div(WORLD_SIZE).add(0.5));
      mat.colorNode = vec3(0.02);
      const ch = debugView === 'bioR' ? b.r : debugView === 'bioB' ? b.b : b.g;
      mat.emissiveNode = vec3(ch);
    }
    if (opts.neutral) {
      // neutral clay shading for the erosion split view: fragment-space
      // finite-difference normals from the bound height buffer
      const eH = 1.6;
      const pxz = positionWorld.xz;
      const hC = hf.sampleHeightFrom(heightBuf, pxz);
      const hX = hf.sampleHeightFrom(heightBuf, pxz.add(vec2(eH, 0)));
      const hZ = hf.sampleHeightFrom(heightBuf, pxz.add(vec2(0, eH)));
      const nFD = vec3(hC.sub(hX), float(eH), hC.sub(hZ)).normalize();
      mat.colorNode = vec3(0.55, 0.53, 0.5);
      mat.normalNode = transformNormalToView(nFD);
      mat.roughnessNode = float(0.92);
    }
    if (opts.screenHalf) {
      // split-screen via alpha test: keep only one half of the screen
      const keepLeft = opts.screenHalf === 'left';
      const keep = keepLeft
        ? screenUV.x.lessThanEqual(0.5)
        : screenUV.x.greaterThan(0.5);
      mat.opacityNode = keep.select(float(1), float(0));
      mat.alphaTest = 0.5;
    }

    this.mesh = new InstancedMesh(patch, mat, MAX_TILES);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;

    // --- far shell -----------------------------------------------------------------
    const ring = new RingGeometry(WORLD_HALF * 0.952, FAR_RADIUS, 160, 42);
    ring.rotateX(-Math.PI / 2);
    const farMat = new MeshStandardNodeMaterial();
    const fxz = positionLocal.xz;
    const farMacro = macroTerrain(fxz, hf.mp, 'far');
    const baked = hf.sampleHeight(fxz);
    const edgeBlend = clamp(
      fxz.abs().x.max(fxz.abs().y).sub(WORLD_HALF * 0.95).div(WORLD_HALF * 0.05),
      0,
      1,
    );
    const farH = mix(baked, farMacro.height, edgeBlend).sub(2.5);
    farMat.positionNode = vec3(fxz.x, farH, fxz.y);
    // analytic per-vertex normal (no baked maps beyond the world edge):
    // finite-difference the far macro height, interpolated via varying
    const eN = 60;
    const hX = macroTerrain(fxz.add(vec2(eN, 0)), hf.mp, 'far').height;
    const hZ = macroTerrain(fxz.add(vec2(0, eN)), hf.mp, 'far').height;
    const farNormal = vec3(farMacro.height.sub(hX), float(eN), farMacro.height.sub(hZ))
      .normalize();
    const farSlope = vec2(farMacro.height.sub(hX), farMacro.height.sub(hZ))
      .length()
      .div(eN);
    const farNS = varying(vec4(farNormal, farSlope));
    const farShading = buildTerrainShading({
      normalTex: hf.normalTex,
      biomeTex: hf.biomeTex as NonNullable<typeof hf.biomeTex>,
      fieldsTex: hf.fieldsTex as NonNullable<typeof hf.fieldsTex>,
      mp: hf.mp,
      far: true,
      baseNormalSlope: farNS,
    });
    farMat.colorNode = farShading.colorNode;
    farMat.normalNode = farShading.normalNode;
    farMat.roughnessNode = farShading.roughnessNode;
    farMat.metalnessNode = float(0);
    this.farShell = new Mesh(ring, farMat);
    this.farShell.frustumCulled = false;
    this.farShell.receiveShadow = true;
  }

  /** rebuild the quadtree when the camera has moved enough */
  update(camera: PerspectiveCamera): void {
    const cx = camera.position.x;
    const cz = camera.position.z;
    if (Math.hypot(cx - this.lastCamX, cz - this.lastCamZ) < 20 && this.activeTiles > 0) return;
    this.lastCamX = cx;
    this.lastCamZ = cz;

    let n = 0;
    const data = this.tileData;
    const emit = (ox: number, oz: number, size: number, lod: number): void => {
      if (n >= MAX_TILES) return;
      data[n * 4] = ox;
      data[n * 4 + 1] = oz;
      data[n * 4 + 2] = size;
      data[n * 4 + 3] = lod;
      n++;
    };
    const recurse = (ox: number, oz: number, size: number, lod: number): void => {
      const dx = Math.max(Math.abs(cx - ox) - size / 2, 0);
      const dz = Math.max(Math.abs(cz - oz) - size / 2, 0);
      const dist = Math.hypot(dx, dz);
      if (size > MIN_TILE && dist < size * SPLIT_K) {
        const q = size / 4;
        const h = size / 2;
        recurse(ox - q, oz - q, h, lod + 1);
        recurse(ox + q, oz - q, h, lod + 1);
        recurse(ox - q, oz + q, h, lod + 1);
        recurse(ox + q, oz + q, h, lod + 1);
      } else {
        emit(ox, oz, size, lod);
      }
    };
    recurse(0, 0, WORLD_SIZE, 0);

    this.activeTiles = n;
    this.mesh.count = n;
    const attr = this.tileBuf.value;
    attr.needsUpdate = true;
  }
}
