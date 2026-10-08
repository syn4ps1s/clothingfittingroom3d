import { J } from '@fitroom/shared';
import { clampN } from './geom.js';
import { buildField, type BodyField } from './field.js';
import { UNIT_CALIBRATION, type BodyDims, type Calibration } from './dims.js';

/**
 * Calibración en bucle cerrado sobre el CAMPO (antes de mallar): se «lanzan rayos» desde el eje del cuerpo en
 * un plano horizontal, se localiza la superficie por trazado de esfera + bisección y se mide el perímetro del
 * contorno. Los multiplicadores de pecho/cintura/cadera/muslo/cuello se corrigen hasta clavar las medidas.
 * Es barato (unos pocos milisegundos por contorno) y evita depender de heurísticas analíticas.
 */

const RAYS = 120;

/** Distancia de salida (m) de un rayo que parte de un punto interior; NaN si no sale. */
function exitDistance(
  field: BodyField,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dz: number,
  rMax: number,
): number {
  let r = 0;
  let prev = 0;
  for (let it = 0; it < 80; it++) {
    const f = field.value(ox + dx * r, oy, oz + dz * r);
    if (f >= 0) {
      // bisección entre prev (dentro) y r (fuera)
      let lo = prev;
      let hi = r;
      for (let b = 0; b < 12; b++) {
        const mid = 0.5 * (lo + hi);
        if (field.value(ox + dx * mid, oy, oz + dz * mid) < 0) lo = mid;
        else hi = mid;
      }
      return 0.5 * (lo + hi);
    }
    prev = r;
    r += Math.max(0.55 * -f, 0.0006);
    if (r > rMax) return NaN;
  }
  return NaN;
}

export interface RingOptions {
  /** Si se da, los rayos que cruzan el plano x = 0 terminan allí (corte de cada pierna por su plano medio). */
  readonly clipSide?: 1 | -1;
}

/** Perímetro (m) del contorno de la sección horizontal a la altura y, visto desde (cx, cz). */
export function ringPerimeter(
  field: BodyField,
  y: number,
  cx: number,
  cz: number,
  opts: RingOptions = {},
): number {
  if (!(field.value(cx, y, cz) < 0)) return NaN;
  let sum = 0;
  let px = 0;
  let pz = 0;
  let fx = 0;
  let fz = 0;
  for (let i = 0; i < RAYS; i++) {
    const th = (i / RAYS) * Math.PI * 2;
    const dx = Math.cos(th);
    const dz = Math.sin(th);
    let r = exitDistance(field, cx, y, cz, dx, dz, 0.8);
    if (!(r === r)) return NaN;
    if (opts.clipSide !== undefined) {
      // plano x = 0: distancia hasta él a lo largo del rayo
      if (opts.clipSide === 1 && dx < 0 && cx + dx * r < 0) r = -cx / dx;
      if (opts.clipSide === -1 && dx > 0 && cx + dx * r > 0) r = -cx / dx;
    }
    const x = cx + dx * r;
    const z = cz + dz * r;
    if (i === 0) {
      fx = x;
      fz = z;
    } else sum += Math.hypot(x - px, z - pz);
    px = x;
    pz = z;
  }
  sum += Math.hypot(fx - px, fz - pz);
  return sum;
}

/** Altura (m) a la que los contornos de ambas piernas se unen cruzando el plano x = 0 (la «entrepierna»). */
export function crotchHeightOfField(field: BodyField, yLo: number, yHi: number): number {
  const merged = (y: number): boolean => {
    for (let z = -0.14; z <= 0.14; z += 0.01) if (field.value(0, y, z) < 0) return true;
    return false;
  };
  let lo = yLo;
  let hi = yHi;
  if (!merged(hi)) return NaN;
  if (merged(lo)) return lo;
  for (let i = 0; i < 14; i++) {
    const mid = 0.5 * (lo + hi);
    if (merged(mid)) hi = mid;
    else lo = mid;
  }
  return 0.5 * (lo + hi);
}

export interface FieldMeasures {
  readonly hip: number;
  readonly waist: number;
  readonly chest: number;
  readonly neck: number;
  readonly thigh: number;
  readonly crotch: number;
}

export function measureField(field: BodyField): FieldMeasures {
  const { dims } = field;
  const { lm, H } = dims;
  // centro de la pierna a la altura del anillo del muslo (eje del tubo)
  const knee = dims.P[J.l_calf]!;
  const hip = dims.P[J.l_thigh]!;
  const tt = (hip[1] - lm.thigh) / (hip[1] - knee[1]);
  const cxLeg = hip[0] + (knee[0] - hip[0]) * tt;
  return {
    hip: ringPerimeter(field, lm.hip, 0, 0),
    waist: ringPerimeter(field, lm.waist, 0, 0),
    chest: ringPerimeter(field, lm.chest, 0, 0),
    neck: ringPerimeter(field, lm.neck, 0, 0.006 * H),
    thigh: ringPerimeter(field, lm.thigh, cxLeg, 0, { clipSide: 1 }),
    crotch: crotchHeightOfField(field, 0.3 * H, lm.crotch + 0.09),
  };
}


export interface CalibrationResult {
  readonly cal: Calibration;
  /** Error relativo final (campo) por magnitud */
  readonly residual: FieldMeasures;
}

interface SecantState {
  cal: number;
  prevCal: number;
  prevP: number;
  beta: number;
}

/** Actualiza un multiplicador con un paso de Newton en logaritmos, estimando la sensibilidad β = dlnP/dlncal. */
function secantStep(st: SecantState, target: number, got: number): number {
  if (!(got === got) || got <= 0) return st.cal;
  if (st.prevP > 0 && Math.abs(Math.log(st.cal / st.prevCal)) > 1e-4) {
    const b = Math.log(got / st.prevP) / Math.log(st.cal / st.prevCal);
    if (b === b) st.beta = clampN(b, 0.2, 1.3);
  }
  st.prevCal = st.cal;
  st.prevP = got;
  const next = st.cal * Math.exp(Math.log(target / got) / st.beta);
  st.cal = clampN(next, 0.4, 2.4);
  return st.cal;
}

export function calibrateField(dims: BodyDims, passes = 4): CalibrationResult {
  const mk = (): SecantState => ({ cal: 1, prevCal: 1, prevP: 0, beta: 0.9 });
  const st = { hip: mk(), waist: mk(), chest: mk(), neck: mk(), thigh: mk() };
  let crotchDy = 0;
  let cal: Calibration = UNIT_CALIBRATION;
  let measured: FieldMeasures | undefined;
  for (let p = 0; p < passes; p++) {
    const field = buildField(dims, cal);
    measured = measureField(field);
    cal = {
      hip: secantStep(st.hip, dims.hipC, measured.hip),
      waist: secantStep(st.waist, dims.waistC, measured.waist),
      chest: secantStep(st.chest, dims.chestC, measured.chest),
      neck: secantStep(st.neck, dims.neckC, measured.neck),
      thigh: secantStep(st.thigh, dims.thighC, measured.thigh),
      crotchDy:
        measured.crotch === measured.crotch
          ? (crotchDy = clampN(crotchDy + (dims.lm.crotch - measured.crotch), -0.06, 0.06))
          : crotchDy,
    };
  }
  const field = buildField(dims, cal);
  measured = measureField(field);
  return { cal, residual: measured };
}
