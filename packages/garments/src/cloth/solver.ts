import type { ClothSolver, GarmentGeometry, WorldCapsule } from '@fitroom/shared';
import { CAP_STRIDE, CapsuleBank } from './capsules.js';
import { K_NEIGHBORS, buildProxy, type ProxyData } from './proxy.js';
import {
  ClothSolverError,
  type ClothSolverEx,
  type ClothSolverOptions,
  type ClothSolverStats,
} from './types.js';

/**
 * Solver de tela PBD sobre una malla proxy (≤ ~2.5 k partículas) con interpolación al mallado de render.
 *
 * MODELO. La prenda skinneada ya tiene la forma deseada; el solver sólo añade el movimiento secundario
 * (inercia, gravedad parcial, colisión). Por eso todo se formula RELATIVO al objetivo skinneado `tgt`:
 *   · cada partícula está atada a su objetivo por un muelle suave (frecuencia ∝ rigidez) y por una
 *     correa dura de longitud `maxDistance` (restricción "max distance" de los motores de juego);
 *   · las restricciones de distancia (estructurales y de flexión) usan como longitud de reposo la
 *     distancia ENTRE OBJETIVOS skinneados del paso actual: no pelean contra la animación, sólo frenan
 *     deformaciones relativas (estiramiento, pliegue) de la tela respecto a la piel;
 *   · la velocidad se amortigua RELATIVA a la velocidad del objetivo (no respecto al mundo).
 * SALIDA. `out_v = skinned_v + Σ_k w_vk · (x_k − tgt_k)`, con el desplazamiento acotado por la correa de
 * cada vértice y empujado fuera de las cápsulas (exacto por vértice). Coste independiente de la
 * resolución de render salvo el barrido final (lineal, ~20 ns/vértice).
 * ARRUGAS. Compresión de las aristas skinneadas respecto al reposo (smoothstep 0,92→0,70) + pliegue de los
 * pares de flexión, con suavizado temporal asimétrico (sube rápido, baja despacio).
 * ROBUSTEZ. Nunca produce NaN/Inf: entradas no finitas se sustituyen, `dt` se acota, los saltos
 * (teleports) reinician el estado y un guardia por partícula restaura el objetivo si algo diverge.
 */

const MAX_DT = 1 / 30;
/** un `dt` mayor se trata como discontinuidad (pestaña dormida): reinicio duro */
const RESET_DT = 0.5;
const COORD_LIMIT = 1e5;
/** hasta 6 cápsulas candidatas por cluster; 255 = "probar todas" */
const CM = 6;
const ALL = 255;
/** RMS del desplazamiento de objetivos en un paso (m) que se considera teleport global */
const TELEPORT_RMS = 0.45;
/** desplazamiento de UNA partícula (m) que se considera teleport individual */
const TELEPORT_PARTICLE = 1.2;
/** velocidad relativa máxima admitida (m/s) */
const VREL_MAX = 4;
/** |δ| de partícula por encima del cual se considera divergencia */
const DELTA_MAX = 2.5;
/** amortiguamiento crítico mínimo del muelle (ζ) */
const ZETA = 0.4;
const GRAVITY = 9.81;
const MAX_WARNINGS = 3;

const smooth01 = (e0: number, e1: number, x: number): number => {
  const t = (x - e0) / (e1 - e0);
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
};

class ClothSolverImpl implements ClothSolverEx {
  readonly vertexCount: number;
  readonly wrinkle: Float32Array;
  readonly stats: ClothSolverStats = {
    steps: 0,
    nonFiniteInputVertices: 0,
    particleRepairs: 0,
    teleports: 0,
    badDt: 0,
    skippedCapsules: 0,
    lastIterations: 0,
    lastSubsteps: 0,
  };
  readonly particleCount: number;
  readonly collisionMargin: number;

  private readonly proxy: ProxyData;
  private readonly P: number;
  private readonly warn: (m: string) => void;
  private warnings = 0;
  // parámetros físicos derivados de ClothSetup
  private readonly omega: number;
  private readonly damping: number;
  private readonly stiffness: number;
  private readonly kStruct: number;
  private readonly kBend: number;
  private readonly gravityY: number;
  private readonly maxIter: number;
  // estado de partículas
  private tg: Float32Array;
  private tgPrev: Float32Array;
  private readonly x: Float32Array;
  private readonly xp: Float32Array;
  private readonly vel: Float32Array;
  private readonly partOut: Float32Array;
  private readonly wrP: Float32Array;
  private readonly rmin: Float32Array;
  private readonly bmin: Float32Array;
  private readonly eLen: Float32Array;
  private readonly bLen: Float32Array;
  private readonly attScale: Float32Array;
  private readonly cbox: Float32Array;
  private readonly cand: Uint8Array;
  private readonly cnt: Uint8Array;
  private readonly contact: Uint8Array;
  private readonly bank = new CapsuleBank();
  private capsActive = false;
  private scratch: Float32Array | null = null;
  private needInit = true;
  // resultado de resolveVertex (evita asignar)
  private rx = 0;
  private ry = 0;
  private rz = 0;

  constructor(geometry: GarmentGeometry, options: ClothSolverOptions = {}) {
    const budget = options.particleBudget ?? 2500;
    this.proxy = buildProxy(geometry, Number.isFinite(budget) ? budget : 2500);
    const px = this.proxy;
    const P = px.particleCount;
    const n = px.vertexCount;
    this.P = P;
    this.vertexCount = n;
    this.particleCount = P;
    this.wrinkle = new Float32Array(n);
    const thick = options.thicknessMm;
    const thicknessM = (Number.isFinite(thick) && thick! > 0 ? Math.min(thick!, 50) : 1) / 1000;
    this.collisionMargin = thicknessM + 0.003;
    this.warn =
      options.warn ??
      ((m: string) => {
        console.warn(m);
      });

    const rawStiff = geometry.cloth.stiffness;
    const rawDamp = geometry.cloth.damping;
    this.stiffness = Number.isFinite(rawStiff) ? Math.min(1, Math.max(0, rawStiff)) : 0.5;
    this.damping = Number.isFinite(rawDamp) ? Math.min(0.95, Math.max(0, rawDamp)) : 0.05;
    // muelle de atadura: 2 Hz (tela fluida) … 7,5 Hz (rígida)
    this.omega = 2 * Math.PI * (2 + 5.5 * this.stiffness);
    this.kStruct = 0.7 + 0.3 * this.stiffness;
    this.kBend = 0.03 + 0.5 * this.stiffness;
    const gs = options.gravityScale;
    this.gravityY = -GRAVITY * (Number.isFinite(gs) ? Math.min(2, Math.max(0, gs!)) : 0.3);
    const mi = options.maxIterations;
    this.maxIter = Number.isFinite(mi) ? Math.min(12, Math.max(1, Math.floor(mi!))) : 5;

    this.tg = Float32Array.from(px.restPos);
    this.tgPrev = Float32Array.from(px.restPos);
    this.x = Float32Array.from(px.restPos);
    this.xp = Float32Array.from(px.restPos);
    this.vel = new Float32Array(P * 3);
    this.partOut = new Float32Array(P * 4);
    this.wrP = new Float32Array(P);
    this.rmin = new Float32Array(P);
    this.bmin = new Float32Array(P);
    this.eLen = new Float32Array(px.edgeA.length);
    this.bLen = new Float32Array(px.bendA.length);
    this.cbox = new Float32Array(P * 6);
    this.cand = new Uint8Array(P * CM);
    this.cnt = new Uint8Array(P);
    this.contact = new Uint8Array(P);
    this.attScale = new Float32Array(P);
    for (let p = 0; p < P; p++) {
      // las zonas pegadas al cuerpo (correa corta) siguen más fielmente que las colgantes
      const free = smooth01(0.0, 0.12, px.maxDist[p]!);
      const m = 1 + 2 * (1 - free);
      this.attScale[p] = m * m;
    }
  }

  reset(): void {
    this.needInit = true;
    this.wrinkle.fill(0);
    this.wrP.fill(0);
    this.vel.fill(0);
    this.partOut.fill(0);
  }

  private warnOnce(message: string): void {
    if (this.warnings < MAX_WARNINGS) {
      this.warnings++;
      this.warn(
        this.warnings === MAX_WARNINGS ? `${message} (avisos posteriores silenciados)` : message,
      );
    }
  }

  step(
    dtSeconds: number,
    skinned: Float32Array,
    capsules: readonly WorldCapsule[],
    out: Float32Array,
  ): void {
    const n = this.vertexCount;
    if (skinned.length !== n * 3 || out.length !== n * 3) {
      throw new ClothSolverError(
        `longitudes inválidas: skinned=${skinned.length}, out=${out.length}, esperado ${n * 3}`,
      );
    }
    const st = this.stats;
    st.steps++;
    if (n === 0) return;

    // ---- dt ----
    let dt = dtSeconds;
    let hardReset = false;
    if (!(dt > 0)) {
      if (dt !== 0) st.badDt++; // NaN o negativo
      dt = 0;
    } else if (dt > RESET_DT) {
      st.badDt++;
      dt = 0;
      hardReset = true;
    } else if (dt > MAX_DT) {
      dt = MAX_DT;
    }

    const src = this.sanitize(skinned);
    this.bank.prepare(capsules, this.collisionMargin);
    st.skippedCapsules += this.bank.skipped;
    this.capsActive = this.bank.count > 0;

    const rms = this.gather(src, hardReset);
    this.buildCandidates();
    this.computeLengthsAndWrinkle(dt);
    if (dt > 0) this.simulate(dt, rms);
    else this.project();
    this.finalizeParticles();
    this.renderPass(src, out);
  }

  // ---------------------------------------------------------------------------------------------
  // Entrada
  // ---------------------------------------------------------------------------------------------

  /** Devuelve `skinned` si es válido, o una copia reparada (no finitos / fuera de rango → estimación segura). */
  private sanitize(skinned: Float32Array): Float32Array {
    const len = skinned.length;
    let bad = false;
    for (let i = 0; i < len; i++) {
      if (!(Math.abs(skinned[i]!) < COORD_LIMIT)) {
        bad = true;
        break;
      }
    }
    if (!bad) return skinned;
    const sc = (this.scratch ??= new Float32Array(len));
    const px = this.proxy;
    const n = this.vertexCount;
    let nbad = 0;
    for (let v = 0; v < n; v++) {
      const o = v * 3;
      const x = skinned[o]!,
        y = skinned[o + 1]!,
        z = skinned[o + 2]!;
      if (
        Math.abs(x) < COORD_LIMIT &&
        Math.abs(y) < COORD_LIMIT &&
        Math.abs(z) < COORD_LIMIT
      ) {
        sc[o] = x;
        sc[o + 1] = y;
        sc[o + 2] = z;
      } else {
        nbad++;
        // último objetivo válido del cluster + desfase de reposo del vértice
        const p = px.clusterOf[v]! * 3;
        sc[o] = this.tg[p]! + (px.restPositions[o]! - px.restPos[p]!);
        sc[o + 1] = this.tg[p + 1]! + (px.restPositions[o + 1]! - px.restPos[p + 1]!);
        sc[o + 2] = this.tg[p + 2]! + (px.restPositions[o + 2]! - px.restPos[p + 2]!);
      }
    }
    this.stats.nonFiniteInputVertices += nbad;
    this.warnOnce(`ClothSolver: ${nbad} vértices skinneados no finitos o fuera de rango; sustituidos`);
    return sc;
  }

  /** Objetivos de partícula (media de sus vértices), cajas por cluster y detección de teleport. */
  private gather(src: Float32Array, hardReset: boolean): number {
    const px = this.proxy;
    const P = this.P;
    // intercambia buffers: tgPrev = objetivos del paso anterior
    const swap = this.tgPrev;
    this.tgPrev = this.tg;
    this.tg = swap;
    const tg = this.tg;
    const tgp = this.tgPrev;
    const ms = px.memberStart;
    const midx = px.memberIdx;
    const useBox = this.bank.count > 0;
    const cbox = this.cbox;
    const init = this.needInit || hardReset;
    let sumD2 = 0;
    let snapped = 0;
    const x = this.x;
    for (let p = 0; p < P; p++) {
      const s = ms[p]!;
      const e = ms[p + 1]!;
      let sx = 0,
        sy = 0,
        sz = 0;
      if (useBox) {
        let mnx = Infinity,
          mny = Infinity,
          mnz = Infinity,
          mxx = -Infinity,
          mxy = -Infinity,
          mxz = -Infinity;
        for (let k = s; k < e; k++) {
          const o = midx[k]! * 3;
          const a = src[o]!,
            b = src[o + 1]!,
            c = src[o + 2]!;
          sx += a;
          sy += b;
          sz += c;
          if (a < mnx) mnx = a;
          if (a > mxx) mxx = a;
          if (b < mny) mny = b;
          if (b > mxy) mxy = b;
          if (c < mnz) mnz = c;
          if (c > mxz) mxz = c;
        }
        const q = p * 6;
        cbox[q] = mnx;
        cbox[q + 1] = mny;
        cbox[q + 2] = mnz;
        cbox[q + 3] = mxx;
        cbox[q + 4] = mxy;
        cbox[q + 5] = mxz;
      } else {
        for (let k = s; k < e; k++) {
          const o = midx[k]! * 3;
          sx += src[o]!;
          sy += src[o + 1]!;
          sz += src[o + 2]!;
        }
      }
      const inv = e > s ? 1 / (e - s) : 0;
      const i = p * 3;
      const tx = sx * inv,
        ty = sy * inv,
        tz = sz * inv;
      tg[i] = tx;
      tg[i + 1] = ty;
      tg[i + 2] = tz;
      if (!init) {
        const dx = tx - tgp[i]!,
          dy = ty - tgp[i + 1]!,
          dz = tz - tgp[i + 2]!;
        const d2 = dx * dx + dy * dy + dz * dz;
        sumD2 += d2;
        if (d2 > TELEPORT_PARTICLE * TELEPORT_PARTICLE) {
          // salto individual: la partícula reaparece sobre su objetivo
          x[i] = tx;
          x[i + 1] = ty;
          x[i + 2] = tz;
          this.xp[i] = tx;
          this.xp[i + 1] = ty;
          this.xp[i + 2] = tz;
          this.vel[i] = 0;
          this.vel[i + 1] = 0;
          this.vel[i + 2] = 0;
          this.wrP[p] = 0;
          snapped++;
        }
      }
    }
    let rms = P > 0 ? Math.sqrt(sumD2 / P) : 0;
    if (init || rms > TELEPORT_RMS) {
      // inicialización o teleport global: todo el estado dinámico se reinicia sobre los objetivos
      if (!init) {
        this.stats.teleports++;
        this.warnOnce(`ClothSolver: teleport detectado (RMS ${rms.toFixed(2)} m); estado reiniciado`);
      }
      if (hardReset && !this.needInit) this.stats.teleports++;
      x.set(tg);
      this.xp.set(tg);
      this.vel.fill(0);
      this.wrP.fill(0);
      this.needInit = false;
      this.initWrinkleNext = true;
      rms = 0;
    } else if (snapped > 0) {
      this.stats.teleports += snapped;
    }
    return rms;
  }

  private initWrinkleNext = false;

  /** Cajas de colisión por cluster: cápsulas cuyo AABB inflado corta la caja del cluster ± su correa. */
  private buildCandidates(): void {
    if (!this.capsActive) return;
    const P = this.P;
    const bank = this.bank;
    const nc = bank.count;
    const cnt = this.cnt;
    if (nc <= 3) {
      cnt.fill(ALL, 0, P);
      return;
    }
    const cd = bank.data;
    const cand = this.cand;
    const cbox = this.cbox;
    const maxLeash = this.proxy.maxLeash;
    for (let p = 0; p < P; p++) {
      const q = p * 6;
      const L = maxLeash[p]! + 1e-4;
      const x0 = cbox[q]! - L,
        y0 = cbox[q + 1]! - L,
        z0 = cbox[q + 2]! - L,
        x1 = cbox[q + 3]! + L,
        y1 = cbox[q + 4]! + L,
        z1 = cbox[q + 5]! + L;
      let k = 0;
      for (let c = 0; c < nc; c++) {
        const o = c * CAP_STRIDE;
        if (
          cd[o + 10]! > x1 ||
          cd[o + 13]! < x0 ||
          cd[o + 11]! > y1 ||
          cd[o + 14]! < y0 ||
          cd[o + 12]! > z1 ||
          cd[o + 15]! < z0
        )
          continue;
        if (k === CM) {
          k = ALL;
          break;
        }
        cand[p * CM + k] = c;
        k++;
      }
      cnt[p] = k;
    }
  }

  /** Longitudes skinneadas de las restricciones y objetivo de arrugas por partícula. */
  private computeLengthsAndWrinkle(dt: number): void {
    const px = this.proxy;
    const P = this.P;
    const tg = this.tg;
    const rmin = this.rmin;
    const bmin = this.bmin;
    rmin.fill(1, 0, P);
    bmin.fill(1, 0, P);
    const eA = px.edgeA,
      eB = px.edgeB,
      eInv = px.edgeInvRest,
      eLen = this.eLen;
    for (let e = 0; e < eA.length; e++) {
      const a = eA[e]! * 3,
        b = eB[e]! * 3;
      const dx = tg[a]! - tg[b]!,
        dy = tg[a + 1]! - tg[b + 1]!,
        dz = tg[a + 2]! - tg[b + 2]!;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      eLen[e] = len;
      const r = len * eInv[e]!;
      const pa = eA[e]!,
        pb = eB[e]!;
      if (r < rmin[pa]!) rmin[pa] = r;
      if (r < rmin[pb]!) rmin[pb] = r;
    }
    const bA = px.bendA,
      bB = px.bendB,
      bInv = px.bendInvRest,
      bLen = this.bLen;
    for (let e = 0; e < bA.length; e++) {
      const a = bA[e]! * 3,
        b = bB[e]! * 3;
      const dx = tg[a]! - tg[b]!,
        dy = tg[a + 1]! - tg[b + 1]!,
        dz = tg[a + 2]! - tg[b + 2]!;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      bLen[e] = len;
      const r = len * bInv[e]!;
      const pa = bA[e]!,
        pb = bB[e]!;
      if (r < bmin[pa]!) bmin[pa] = r;
      if (r < bmin[pb]!) bmin[pb] = r;
    }
    const wr = this.wrP;
    const direct = this.initWrinkleNext;
    const aUp = dt > 0 ? 1 - Math.exp(-dt / 0.05) : 0;
    const aDown = dt > 0 ? 1 - Math.exp(-dt / 0.3) : 0;
    for (let p = 0; p < P; p++) {
      const ws = 1 - smooth01(0.7, 0.92, rmin[p]!);
      const wb = 1 - smooth01(0.84, 0.98, bmin[p]!);
      let target = ws + 0.5 * wb;
      if (target > 1) target = 1;
      const cur = wr[p]!;
      wr[p] = direct ? target : cur + (target - cur) * (target > cur ? aUp : aDown);
    }
    this.initWrinkleNext = false;
  }

  // ---------------------------------------------------------------------------------------------
  // Simulación
  // ---------------------------------------------------------------------------------------------

  private simulate(dt: number, rms: number): void {
    const px = this.proxy;
    const P = this.P;
    const x = this.x,
      xp = this.xp,
      v = this.vel,
      tg = this.tg,
      tgp = this.tgPrev;
    const iw = px.invMass;
    const nSub = dt > 0.0222 ? 2 : 1;
    const h = dt / nSub;
    const iters = Math.min(
      this.maxIter,
      2 + (rms > 0.015 ? 1 : 0) + (rms > 0.05 ? 1 : 0) + (this.stiffness > 0.75 ? 1 : 0),
    );
    this.stats.lastIterations = iters;
    this.stats.lastSubsteps = nSub;
    const invDt = 1 / dt;
    const wh = this.omega * h;
    const wh2 = wh * wh;
    const damp = Math.pow(1 - this.damping, h * 60) * Math.exp(-2 * ZETA * this.omega * h);
    const gyh = this.gravityY * h;
    const att = this.attScale;
    const contact = this.contact;

    for (let s = 0; s < nSub; s++) {
      // ---- integración ----
      for (let p = 0; p < P; p++) {
        const i = p * 3;
        if (iw[p] === 0) {
          x[i] = tg[i]!;
          x[i + 1] = tg[i + 1]!;
          x[i + 2] = tg[i + 2]!;
          xp[i] = x[i]!;
          xp[i + 1] = x[i + 1]!;
          xp[i + 2] = x[i + 2]!;
          v[i] = 0;
          v[i + 1] = 0;
          v[i + 2] = 0;
          continue;
        }
        const vtx = (tg[i]! - tgp[i]!) * invDt;
        const vty = (tg[i + 1]! - tgp[i + 1]!) * invDt;
        const vtz = (tg[i + 2]! - tgp[i + 2]!) * invDt;
        let rx = (v[i]! - vtx) * damp;
        let ry = (v[i + 1]! - vty) * damp + gyh;
        let rz = (v[i + 2]! - vtz) * damp;
        // velocidad relativa acotada (estabilidad ante entradas extremas)
        const r2 = rx * rx + ry * ry + rz * rz;
        if (r2 > VREL_MAX * VREL_MAX) {
          const f = VREL_MAX / Math.sqrt(r2);
          rx *= f;
          ry *= f;
          rz *= f;
        }
        const ox = x[i]!,
          oy = x[i + 1]!,
          oz = x[i + 2]!;
        xp[i] = ox;
        xp[i + 1] = oy;
        xp[i + 2] = oz;
        let nx = ox + (vtx + rx) * h;
        let ny = oy + (vty + ry) * h;
        let nz = oz + (vtz + rz) * h;
        // atadura suave al objetivo (muelle implícito: estable para cualquier h)
        const k = wh2 * att[p]!;
        const a = k / (1 + k);
        nx += (tg[i]! - nx) * a;
        ny += (tg[i + 1]! - ny) * a;
        nz += (tg[i + 2]! - nz) * a;
        x[i] = nx;
        x[i + 1] = ny;
        x[i + 2] = nz;
      }
      // ---- restricciones ----
      for (let it = 0; it < iters; it++) {
        this.solveConstraints();
        this.applyLeash();
      }
      // ---- colisiones, correa y velocidades ----
      if (this.capsActive) this.collideParticles();
      this.applyLeash();
      const invH = 1 / h;
      for (let p = 0; p < P; p++) {
        if (iw[p] === 0) continue;
        const i = p * 3;
        const vtx = (tg[i]! - tgp[i]!) * invDt;
        const vty = (tg[i + 1]! - tgp[i + 1]!) * invDt;
        const vtz = (tg[i + 2]! - tgp[i + 2]!) * invDt;
        let vx = (x[i]! - xp[i]!) * invH;
        let vy = (x[i + 1]! - xp[i + 1]!) * invH;
        let vz = (x[i + 2]! - xp[i + 2]!) * invH;
        let rx = vx - vtx,
          ry = vy - vty,
          rz = vz - vtz;
        // el contacto con el cuerpo frena la velocidad relativa (fricción)
        const fr = contact[p] === 1 ? 0.6 : 1;
        rx *= fr;
        ry *= fr;
        rz *= fr;
        const r2 = rx * rx + ry * ry + rz * rz;
        if (r2 > VREL_MAX * VREL_MAX) {
          const f = VREL_MAX / Math.sqrt(r2);
          rx *= f;
          ry *= f;
          rz *= f;
        }
        vx = vtx + rx;
        vy = vty + ry;
        vz = vtz + rz;
        v[i] = vx;
        v[i + 1] = vy;
        v[i + 2] = vz;
      }
    }
  }

  /** Sin integración (dt = 0): sólo proyecta correa y colisiones sobre el nuevo objetivo. */
  private project(): void {
    this.stats.lastIterations = 0;
    this.stats.lastSubsteps = 0;
    this.applyLeash();
    if (this.capsActive) this.collideParticles();
    this.applyLeash();
  }

  /** Restricciones de distancia (estructurales + flexión), Gauss-Seidel. */
  private solveConstraints(): void {
    const px = this.proxy;
    const x = this.x;
    const iw = px.invMass;
    const eA = px.edgeA,
      eB = px.edgeB,
      eLen = this.eLen;
    const kS = this.kStruct;
    for (let e = 0; e < eA.length; e++) {
      const pa = eA[e]!,
        pb = eB[e]!;
      const wa = iw[pa]!,
        wb = iw[pb]!;
      const ws = wa + wb;
      if (ws === 0) continue;
      const a = pa * 3,
        b = pb * 3;
      const dx = x[a]! - x[b]!,
        dy = x[a + 1]! - x[b + 1]!,
        dz = x[a + 2]! - x[b + 2]!;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 1e-18) continue;
      const d = Math.sqrt(d2);
      const f = (kS * (d - eLen[e]!)) / (d * ws);
      const fa = wa * f,
        fb = wb * f;
      x[a] = x[a]! - dx * fa;
      x[a + 1] = x[a + 1]! - dy * fa;
      x[a + 2] = x[a + 2]! - dz * fa;
      x[b] = x[b]! + dx * fb;
      x[b + 1] = x[b + 1]! + dy * fb;
      x[b + 2] = x[b + 2]! + dz * fb;
    }
    const bA = px.bendA,
      bB = px.bendB,
      bLen = this.bLen;
    const kB = this.kBend;
    for (let e = 0; e < bA.length; e++) {
      const pa = bA[e]!,
        pb = bB[e]!;
      const wa = iw[pa]!,
        wb = iw[pb]!;
      const ws = wa + wb;
      if (ws === 0) continue;
      const a = pa * 3,
        b = pb * 3;
      const dx = x[a]! - x[b]!,
        dy = x[a + 1]! - x[b + 1]!,
        dz = x[a + 2]! - x[b + 2]!;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 1e-18) continue;
      const d = Math.sqrt(d2);
      const f = (kB * (d - bLen[e]!)) / (d * ws);
      const fa = wa * f,
        fb = wb * f;
      x[a] = x[a]! - dx * fa;
      x[a + 1] = x[a + 1]! - dy * fa;
      x[a + 2] = x[a + 2]! - dz * fa;
      x[b] = x[b]! + dx * fb;
      x[b + 1] = x[b + 1]! + dy * fb;
      x[b + 2] = x[b + 2]! + dz * fb;
    }
  }

  /** Restricción de distancia máxima al objetivo skinneado (y anclaje de las partículas con masa inversa 0). */
  private applyLeash(): void {
    const P = this.P;
    const x = this.x,
      tg = this.tg;
    const maxD = this.proxy.maxDist;
    for (let p = 0; p < P; p++) {
      const i = p * 3;
      const L = maxD[p]!;
      const dx = x[i]! - tg[i]!,
        dy = x[i + 1]! - tg[i + 1]!,
        dz = x[i + 2]! - tg[i + 2]!;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > L * L) {
        const f = L > 0 ? L / Math.sqrt(d2) : 0;
        x[i] = tg[i]! + dx * f;
        x[i + 1] = tg[i + 1]! + dy * f;
        x[i + 2] = tg[i + 2]! + dz * f;
      }
    }
  }

  /** Colisión partícula–cápsula (empuja a la superficie inflada por el margen). */
  private collideParticles(): void {
    const P = this.P;
    const x = this.x,
      tg = this.tg;
    const iw = this.proxy.invMass;
    const bank = this.bank;
    const cd = bank.data;
    const nAll = bank.count;
    const cand = this.cand,
      cnt = this.cnt,
      contact = this.contact;
    for (let p = 0; p < P; p++) {
      contact[p] = 0;
      if (iw[p] === 0) continue;
      const nc = cnt[p]!;
      if (nc === 0) continue;
      const lim = nc === ALL ? nAll : nc;
      const i = p * 3;
      let px = x[i]!,
        py = x[i + 1]!,
        pz = x[i + 2]!;
      for (let j = 0; j < lim; j++) {
        const c = nc === ALL ? j : cand[p * CM + j]!;
        const o = c * CAP_STRIDE;
        const ax = cd[o]!,
          ay = cd[o + 1]!,
          az = cd[o + 2]!;
        const abx = cd[o + 3]!,
          aby = cd[o + 4]!,
          abz = cd[o + 5]!;
        let t = ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) * cd[o + 6]!;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + abx * t,
          qy = ay + aby * t,
          qz = az + abz * t;
        const dx = px - qx,
          dy = py - qy,
          dz = pz - qz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < cd[o + 9]!) {
          const R = cd[o + 7]!;
          const d = Math.sqrt(d2);
          if (d > 1e-9) {
            const f = R / d;
            px = qx + dx * f;
            py = qy + dy * f;
            pz = qz + dz * f;
          } else {
            // sobre el eje: empuja hacia fuera desde el objetivo (o hacia +Y si coinciden)
            let ux = px - tg[i]!,
              uy = py - tg[i + 1]!,
              uz = pz - tg[i + 2]!;
            let ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
            if (ul < 1e-9) {
              ux = 0;
              uy = 1;
              uz = 0;
              ul = 1;
            }
            px = qx + (ux / ul) * R;
            py = qy + (uy / ul) * R;
            pz = qz + (uz / ul) * R;
          }
          contact[p] = 1;
        }
      }
      x[i] = px;
      x[i + 1] = py;
      x[i + 2] = pz;
    }
  }

  /** δ = x − tgt por partícula, con guardia anti-NaN/divergencia. */
  private finalizeParticles(): void {
    const P = this.P;
    const x = this.x,
      tg = this.tg,
      po = this.partOut,
      wr = this.wrP;
    let repairs = 0;
    for (let p = 0; p < P; p++) {
      const i = p * 3;
      let dx = x[i]! - tg[i]!,
        dy = x[i + 1]! - tg[i + 1]!,
        dz = x[i + 2]! - tg[i + 2]!;
      // `!(… < DELTA_MAX)` también captura NaN
      if (!(Math.abs(dx) < DELTA_MAX && Math.abs(dy) < DELTA_MAX && Math.abs(dz) < DELTA_MAX)) {
        x[i] = tg[i]!;
        x[i + 1] = tg[i + 1]!;
        x[i + 2] = tg[i + 2]!;
        this.xp[i] = x[i]!;
        this.xp[i + 1] = x[i + 1]!;
        this.xp[i + 2] = x[i + 2]!;
        this.vel[i] = 0;
        this.vel[i + 1] = 0;
        this.vel[i + 2] = 0;
        dx = 0;
        dy = 0;
        dz = 0;
        repairs++;
      }
      const q = p * 4;
      po[q] = dx;
      po[q + 1] = dy;
      po[q + 2] = dz;
      const w = wr[p]!;
      po[q + 3] = w >= 0 && w <= 1 ? w : 0;
    }
    if (repairs > 0) {
      this.stats.particleRepairs += repairs;
      this.warnOnce(`ClothSolver: ${repairs} partículas divergentes restauradas al objetivo skinneado`);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Salida
  // ---------------------------------------------------------------------------------------------

  /** `out = skinned + Σ w·δ` con correa por vértice y empuje exacto fuera de las cápsulas. */
  private renderPass(src: Float32Array, out: Float32Array): void {
    const px = this.proxy;
    const P = this.P;
    const K = K_NEIGHBORS;
    const ms = px.memberStart,
      midx = px.memberIdx,
      nIdx = px.nbrIdx,
      nW = px.nbrW,
      leash = px.leashSorted;
    const po = this.partOut;
    const wrinkle = this.wrinkle;
    const caps = this.capsActive;
    const bank = this.bank;
    const cd = bank.data;
    const nAll = bank.count;
    const cand = this.cand,
      cnt = this.cnt;
    for (let p = 0; p < P; p++) {
      const s = ms[p]!,
        e = ms[p + 1]!;
      const nc = caps ? cnt[p]! : 0;
      const lim = nc === ALL ? nAll : nc;
      const cbase = p * CM;
      for (let k = s; k < e; k++) {
        const v = midx[k]!;
        const o = v * 3;
        const kk = k * K;
        const i0 = nIdx[kk]! * 4,
          i1 = nIdx[kk + 1]! * 4,
          i2 = nIdx[kk + 2]! * 4,
          i3 = nIdx[kk + 3]! * 4;
        const w0 = nW[kk]!,
          w1 = nW[kk + 1]!,
          w2 = nW[kk + 2]!,
          w3 = nW[kk + 3]!;
        let dx = w0 * po[i0]! + w1 * po[i1]! + w2 * po[i2]! + w3 * po[i3]!;
        let dy = w0 * po[i0 + 1]! + w1 * po[i1 + 1]! + w2 * po[i2 + 1]! + w3 * po[i3 + 1]!;
        let dz = w0 * po[i0 + 2]! + w1 * po[i1 + 2]! + w2 * po[i2 + 2]! + w3 * po[i3 + 2]!;
        wrinkle[v] = w0 * po[i0 + 3]! + w1 * po[i1 + 3]! + w2 * po[i2 + 3]! + w3 * po[i3 + 3]!;
        const L = leash[k]!;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > L * L) {
          const f = L > 0 ? L / Math.sqrt(d2) : 0;
          dx *= f;
          dy *= f;
          dz *= f;
        }
        const sx = src[o]!,
          sy = src[o + 1]!,
          sz = src[o + 2]!;
        let ox = sx + dx,
          oy = sy + dy,
          oz = sz + dz;
        if (lim !== 0) {
          // ¿dentro de alguna cápsula candidata?
          let hit = false;
          for (let j = 0; j < lim; j++) {
            const c = nc === ALL ? j : cand[cbase + j]!;
            const q = c * CAP_STRIDE;
            const ax = cd[q]!,
              ay = cd[q + 1]!,
              az = cd[q + 2]!;
            const abx = cd[q + 3]!,
              aby = cd[q + 4]!,
              abz = cd[q + 5]!;
            let t = ((ox - ax) * abx + (oy - ay) * aby + (oz - az) * abz) * cd[q + 6]!;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ex = ox - (ax + abx * t),
              ey = oy - (ay + aby * t),
              ez = oz - (az + abz * t);
            if (ex * ex + ey * ey + ez * ez < cd[q + 9]!) {
              hit = true;
              break;
            }
          }
          if (hit) {
            this.resolveVertex(sx, sy, sz, ox, oy, oz, L, cbase, nc, lim);
            ox = this.rx;
            oy = this.ry;
            oz = this.rz;
          }
        }
        out[o] = ox;
        out[o + 1] = oy;
        out[o + 2] = oz;
      }
    }
  }

  /**
   * Resuelve un vértice dentro de cápsulas: empuja a la superficie, reaplica la correa y verifica.
   * Si no queda fuera y el objetivo skinneado SÍ es factible, vuelve al objetivo (siempre válido).
   */
  private resolveVertex(
    sx: number,
    sy: number,
    sz: number,
    ox: number,
    oy: number,
    oz: number,
    L: number,
    cbase: number,
    nc: number,
    lim: number,
  ): void {
    const cd = this.bank.data;
    const cand = this.cand;
    let px = ox,
      py = oy,
      pz = oz;
    for (let round = 0; round < 3; round++) {
      let moved = false;
      for (let j = 0; j < lim; j++) {
        const c = nc === ALL ? j : cand[cbase + j]!;
        const q = c * CAP_STRIDE;
        const ax = cd[q]!,
          ay = cd[q + 1]!,
          az = cd[q + 2]!;
        const abx = cd[q + 3]!,
          aby = cd[q + 4]!,
          abz = cd[q + 5]!;
        let t = ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) * cd[q + 6]!;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = ax + abx * t,
          cy = ay + aby * t,
          cz = az + abz * t;
        const ex = px - cx,
          ey = py - cy,
          ez = pz - cz;
        const d2 = ex * ex + ey * ey + ez * ez;
        if (d2 < cd[q + 9]!) {
          const R = cd[q + 7]!;
          const d = Math.sqrt(d2);
          if (d > 1e-9) {
            const f = R / d;
            px = cx + ex * f;
            py = cy + ey * f;
            pz = cz + ez * f;
          } else {
            // sobre el eje: hacia fuera desde el objetivo skinneado (o +Y)
            let ux = sx - cx,
              uy = sy - cy,
              uz = sz - cz;
            let ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
            if (ul < 1e-9) {
              ux = 0;
              uy = 1;
              uz = 0;
              ul = 1;
            }
            px = cx + (ux / ul) * R;
            py = cy + (uy / ul) * R;
            pz = cz + (uz / ul) * R;
          }
          moved = true;
        }
      }
      if (!moved) break;
      // correa: el vértice nunca se aleja de su objetivo más de `L`
      let dx = px - sx,
        dy = py - sy,
        dz = pz - sz;
      const dd = dx * dx + dy * dy + dz * dz;
      if (dd > L * L) {
        const f = L > 0 ? L / Math.sqrt(dd) : 0;
        dx *= f;
        dy *= f;
        dz *= f;
        px = sx + dx;
        py = sy + dy;
        pz = sz + dz;
      }
    }
    // verificación final; si falla y el objetivo es factible, el objetivo es la respuesta válida
    let inside = false;
    let sFeasible = true;
    for (let j = 0; j < lim; j++) {
      const c = nc === ALL ? j : cand[cbase + j]!;
      const q = c * CAP_STRIDE;
      const ax = cd[q]!,
        ay = cd[q + 1]!,
        az = cd[q + 2]!;
      const abx = cd[q + 3]!,
        aby = cd[q + 4]!,
        abz = cd[q + 5]!;
      const inv = cd[q + 6]!;
      let t = ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) * inv;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      let ex = px - (ax + abx * t),
        ey = py - (ay + aby * t),
        ez = pz - (az + abz * t);
      if (ex * ex + ey * ey + ez * ez < cd[q + 9]!) inside = true;
      t = ((sx - ax) * abx + (sy - ay) * aby + (sz - az) * abz) * inv;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      ex = sx - (ax + abx * t);
      ey = sy - (ay + aby * t);
      ez = sz - (az + abz * t);
      if (ex * ex + ey * ey + ez * ez < cd[q + 9]!) sFeasible = false;
    }
    if (inside && sFeasible) {
      px = sx;
      py = sy;
      pz = sz;
    }
    this.rx = px;
    this.ry = py;
    this.rz = pz;
  }
}

/**
 * Crea el solver de tela de una prenda. Contrato de `shared/garment.ts`; el segundo parámetro es opcional
 * y aditivo (ver {@link ClothSolverOptions}). El catálogo ajusta la tela a través de `geometry.cloth`
 * (`stiffness` ← `FabricDef.stiffness`, `damping`, `maxDistance` e `invMass` por vértice).
 */
export function createClothSolver(
  geometry: GarmentGeometry,
  options?: ClothSolverOptions,
): ClothSolverEx & ClothSolver {
  return new ClothSolverImpl(geometry, options);
}
