/** Marca explícita de API aún no implementada (los stubs de la fundación lanzan esto). */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`NOT_IMPLEMENTED: ${what}`);
    this.name = 'NotImplementedError';
  }
}
