import { NotImplementedError, type Measurements, type PartialMeasurements } from '@fitroom/shared';
import { completeMeasurements } from '@fitroom/body';
import { READY } from 'virtual:fitroom-status';
import { appParams } from '../../app/params';
import { completeMeasurementsFallback } from '../dev/devBody';

const useReal = READY.body && !appParams().mock;
let warned = false;

/** `completeMeasurements` real (@fitroom/body) cuando está READY; respaldo de desarrollo si no. */
export function completeMeasurementsApi(partial: PartialMeasurements): Measurements {
  if (useReal) {
    try {
      return completeMeasurements(partial);
    } catch (err) {
      if (!(err instanceof NotImplementedError) && !warned) {
        warned = true;
        console.warn('completeMeasurements falló; uso el respaldo de desarrollo.', err);
      }
    }
  }
  return completeMeasurementsFallback(partial);
}

export const BODY_SOURCE: 'real' | 'dev' = useReal ? 'real' : 'dev';
