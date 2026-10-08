import type { MirrorHandle } from '../contracts';

/**
 * Asa imperativa del espejo (`capture()`), compartida entre el Canvas (que monta <MirrorStage ref>) y los
 * botones del DOM. Es una referencia mutable de módulo porque los dos viven en árboles de React distintos.
 */
export const mirrorHandle: { current: MirrorHandle | null } = { current: null };
