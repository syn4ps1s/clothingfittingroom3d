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
 * Brazo del proyecto = hombro (acromion) → muñeca. Con landmarks glenohumerales, la distancia
 * hombro-landmark → codo → muñeca queda ≈ 1 cm corta (el acromion está por encima y fuera).
 */
export const ARM_LENGTH_BIAS_CM = 1.0;

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
 * Razón profundidad/ancho (b/a) a priori de la sección elíptica del tronco por nivel, para un IMC
 * medio (≈ 23). Crece/decrece con el IMC (ver `depthRatio`).
 */
export const TORSO_DEPTH_RATIO = {
  chest: 0.7,
  waist: 0.78,
  hip: 0.74,
  thigh: 1.0,
  neck: 1.0,
} as const;

/** Cuánto sube la razón profundidad/ancho por unidad de IMC sobre 23 (barriga/pecho más profundos). */
export const DEPTH_RATIO_PER_BMI = 0.012;

/** Muslo: circunferencia en la parte alta (5 cm bajo el pliegue glúteo); altura sobre el suelo / estatura. */
export const LEVELS = {
  /** altura (fracción de H) del nivel de pecho (línea axilar/pezón) */
  chest: 0.72,
  /** altura del nivel de cintura natural */
  waist: 0.62,
  /** nivel de cadera (máxima circunferencia glútea) */
  hip: 0.52,
  /** nivel de muslo alto (justo bajo el pliegue glúteo) */
  thigh: 0.455 - 0.03,
  /** nivel de cuello (mitad del cuello) */
  neck: 0.855,
} as const;
