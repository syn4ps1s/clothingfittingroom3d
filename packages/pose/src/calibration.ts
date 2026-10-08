/**
 * Factores de calibración y a priori antropométricos del estimador de medidas.
 *
 * Son SUPUESTOS DOCUMENTADOS, no verdades medidas: provienen de proporciones antropométricas
 * publicadas (Drillis & Contini; ANSUR II; NASA-STD-3000) y de la geometría de los landmarks de
 * MediaPipe Pose, y NO se han validado contra personas reales con cinta métrica (ver ACCURACY.md).
 * Por eso cada medida lleva un `sigma` que incluye la incertidumbre de estos factores.
 */

/**
 * Los landmarks de hombro de MediaPipe son (≈) el centro de la articulación glenohumeral, no el
 * acromion. La medida del proyecto («ancho de hombros») es entre puntos acromiales: cada hombro se
 * corrige hacia fuera esta distancia (m por lado). Valor típico 2–3 cm (acromion lateral al centro
 * glenohumeral); se toma 2.5 cm con σ ≈ 1 cm por lado.
 */
export const SHOULDER_INSET_M = 0.025;

/**
 * Corrección aditiva (cm) de la longitud del brazo hombro→codo→muñeca. Es 0 a propósito: desplazar el
 * landmark del hombro `SHOULDER_INSET_M` hacia dentro ya alarga ≈ 1.5 cm la distancia al codo con el
 * brazo caído (efecto geométrico), que compensa el acortamiento por estar el centro glenohumeral
 * algo por debajo del acromion. Se deja como constante para recalibrar con datos reales.
 */
export const ARM_LENGTH_BIAS_CM = 0;

/**
 * Altura de la articulación de cadera sobre el entrepierna: 0.075·H (misma constante que
 * `buildRestSkeleton`). Altura del tobillo sobre el suelo: 0.039·H.
 */
export const HIP_ABOVE_CROTCH = 0.075;
export const ANKLE_HEIGHT = 0.039;

/** Fracciones de la estatura (adulto medio) usadas para fijar la escala con la estatura declarada. */
export const STATURE_FRACTIONS = {
  /** altura de los ojos / estatura */
  eye: 0.936,
  /** altura del tobillo (maléolo) / estatura */
  ankle: ANKLE_HEIGHT,
  /** altura del hombro (acromion) / estatura */
  shoulder: 0.818,
  /** altura de la cadera (articulación) / estatura */
  hipJoint: 0.53,
  /** punta de la cabeza sobre la nariz / estatura */
  noseToTop: 0.085,
  /** nariz sobre el suelo / estatura */
  nose: 0.915,
} as const;

/**
 * Circunferencia = (c0 + c1·(IMC − 22)) · ancho frontal de la silueta, ajustado por mínimos cuadrados a las
 * mallas de @fitroom/body v1 (`tools/calibrate-girth.ts`, 36 cuerpos: estatura 150–195 cm, IMC 17.5–36.5,
 * 3 constituciones, residuos individuales aleatorios). La razón profundidad/ancho está implícita en los
 * factores (medias: pecho 0.81, cintura 0.78, cadera 0.74, cuello 0.96). `rel` = error relativo (1σ) de
 * este modelo al aplicarlo a PERSONAS reales: el ajuste a las mallas da 0.1–3 %, pero una persona real se
 * desvía más de un modelo paramétrico; se toma ≥ 3.5 %.
 */
export const GIRTH_FROM_WIDTH = {
  chest: { c0: 3.051, c1: 0.0086, rel: 0.035 },
  waist: { c0: 2.723, c1: 0.0192, rel: 0.035 },
  hip: { c0: 2.808, c1: 0.0064, rel: 0.035 },
  neck: { c0: 3.076, c1: 0, rel: 0.05 },
  thigh: { c0: 3.179, c1: -0.0123, rel: 0.04 },
} as const;
export type GirthLevel = keyof typeof GIRTH_FROM_WIDTH;

/** Alturas (fracción de la estatura) de los niveles de medida; las mismas que usa `measureBody` de body. */
export const LEVELS = {
  chest: 0.725,
  waist: 0.625,
  hip: 0.51,
  thigh: 0.425,
  neck: 0.862,
} as const;

/**
 * Longitudes: distancia hombro→cadera→… como fracción de la estatura H en la persona media (misma
 * antropometría que `buildRestSkeleton`/`predictInseam`): tramo de pierna articulación de cadera→tobillo,
 * torso hombros→caderas y hombros→cabeza. Fijan la escala métrica con la estatura declarada.
 */
export const CHAIN_FRACTIONS = {
  legSpan: 0.4545 + HIP_ABOVE_CROTCH - ANKLE_HEIGHT,
  torso: 0.818 - (0.4545 + HIP_ABOVE_CROTCH),
  head: 0.108,
} as const;
