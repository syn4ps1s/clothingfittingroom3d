import { MeasurementBook } from './BookScreen';

/** Una sola hoja para «manual» y «libro»; la `key` en App reinicia su estado local al cambiar de pantalla. */
export function BookScreenStage({ stage }: { stage: 'manual' | 'book' }) {
  return <MeasurementBook mode={stage} />;
}
