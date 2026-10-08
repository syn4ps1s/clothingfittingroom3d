import type {
  GarmentCategory,
  GarmentDimension,
  GarmentSlot,
  MeasurementKey,
  MeasurementSource,
  ScanHint,
  ScanPhase,
  BodyBase,
  FitVerdict,
  SizeNote,
} from '@fitroom/shared';
import type { CameraStatus, TrackingState } from '../contracts';
import type { Stage } from '../state/flow';
import type { MessageKey } from './es';

/**
 * Tablas exhaustivas valor-de-dominio → clave i18n. Al ser `Record<Unión, MessageKey>`,
 * añadir un valor nuevo al contrato sin traducirlo rompe la compilación.
 */
export const SCAN_HINT_KEYS: Record<ScanHint, MessageKey> = {
  ok: 'scan.hint.ok',
  'no-person': 'scan.hint.no-person',
  'multiple-people': 'scan.hint.multiple-people',
  'step-back': 'scan.hint.step-back',
  'step-closer': 'scan.hint.step-closer',
  'show-full-body': 'scan.hint.show-full-body',
  'face-camera': 'scan.hint.face-camera',
  'raise-arms-a-pose': 'scan.hint.raise-arms-a-pose',
  'hold-still': 'scan.hint.hold-still',
  'too-dark': 'scan.hint.too-dark',
  'move-to-center': 'scan.hint.move-to-center',
};

export const SCAN_PHASE_KEYS: Record<ScanPhase, MessageKey> = {
  idle: 'scan.phase.idle',
  searching: 'scan.phase.searching',
  adjusting: 'scan.phase.adjusting',
  hold: 'scan.phase.hold',
  capturing: 'scan.phase.capturing',
  complete: 'scan.phase.complete',
  failed: 'scan.phase.failed',
};

export const CAMERA_TITLE_KEYS: Record<CameraStatus, MessageKey> = {
  idle: 'camera.title.idle',
  requesting: 'camera.title.requesting',
  ready: 'camera.title.ready',
  denied: 'camera.title.denied',
  unavailable: 'camera.title.unavailable',
  'insecure-context': 'camera.title.insecure-context',
  error: 'camera.title.error',
};

export const CAMERA_TEXT_KEYS: Record<CameraStatus, MessageKey> = {
  idle: 'camera.text.idle',
  requesting: 'camera.text.requesting',
  ready: 'camera.text.ready',
  denied: 'camera.text.denied',
  unavailable: 'camera.text.unavailable',
  'insecure-context': 'camera.text.insecure-context',
  error: 'camera.text.error',
};

export const TRACKING_KEYS: Record<TrackingState, MessageKey> = {
  initializing: 'fitting.tracking.initializing',
  searching: 'fitting.tracking.searching',
  tracking: 'fitting.tracking.tracking',
  lost: 'fitting.tracking.lost',
};

export const STAGE_KEYS: Record<Stage, MessageKey> = {
  welcome: 'stage.welcome',
  camera: 'stage.camera',
  height: 'stage.height',
  scan: 'stage.scan',
  manual: 'stage.manual',
  book: 'stage.book',
  catalog: 'stage.catalog',
  fitting: 'stage.fitting',
};

export const MEASURE_KEYS: Record<MeasurementKey, MessageKey> = {
  heightCm: 'measure.height',
  weightKg: 'measure.weight',
  chestCm: 'measure.chest',
  waistCm: 'measure.waist',
  hipCm: 'measure.hip',
  shoulderWidthCm: 'measure.shoulder',
  armLengthCm: 'measure.arm',
  inseamCm: 'measure.inseam',
  neckCm: 'measure.neck',
  thighCm: 'measure.thigh',
};

export const SOURCE_KEYS: Record<MeasurementSource, MessageKey> = {
  user: 'measure.source.user',
  'scan-video': 'measure.source.scan-video',
  'scan-photo': 'measure.source.scan-photo',
  regression: 'measure.source.regression',
  default: 'measure.source.default',
};

export const BODY_BASE_KEYS: Record<BodyBase, MessageKey> = {
  neutral: 'measure.bodyBase.neutral',
  feminine: 'measure.bodyBase.feminine',
  masculine: 'measure.bodyBase.masculine',
};

export const CATEGORY_KEYS: Record<GarmentCategory | 'all', MessageKey> = {
  all: 'catalog.category.all',
  tops: 'catalog.category.tops',
  bottoms: 'catalog.category.bottoms',
  dresses: 'catalog.category.dresses',
  outerwear: 'catalog.category.outerwear',
};

export const SLOT_KEYS: Record<GarmentSlot, MessageKey> = {
  upper: 'fitting.slot.upper',
  lower: 'fitting.slot.lower',
  full: 'fitting.slot.full',
  outer: 'fitting.slot.outer',
};

export const VERDICT_KEYS: Record<FitVerdict, MessageKey> = {
  'too-tight': 'fit.verdict.too-tight',
  snug: 'fit.verdict.snug',
  good: 'fit.verdict.good',
  roomy: 'fit.verdict.roomy',
  'too-loose': 'fit.verdict.too-loose',
};

export const ZONE_KEYS: Record<GarmentDimension, MessageKey> = {
  chestCm: 'fit.zone.chestCm',
  waistCm: 'fit.zone.waistCm',
  hemCm: 'fit.zone.hemCm',
  hipCm: 'fit.zone.hipCm',
  thighCm: 'fit.zone.thighCm',
  legOpeningCm: 'fit.zone.legOpeningCm',
  shoulderWidthCm: 'fit.zone.shoulderWidthCm',
  lengthCm: 'fit.zone.lengthCm',
  sleeveLengthCm: 'fit.zone.sleeveLengthCm',
  inseamCm: 'fit.zone.inseamCm',
  riseCm: 'fit.zone.riseCm',
};

export const NOTE_KEYS: Record<SizeNote, MessageKey> = {
  'between-sizes': 'fit.note.between-sizes',
  'below-smallest-size': 'fit.note.below-smallest-size',
  'above-largest-size': 'fit.note.above-largest-size',
  'low-measurement-confidence': 'fit.note.low-measurement-confidence',
  'height-out-of-range': 'fit.note.height-out-of-range',
};
