/// <reference types="vite/client" />

declare module 'virtual:fitroom-status' {
  /** Qué partes de otros agentes están listas (ver vite.config.ts). */
  export const READY: {
    readonly mirror: boolean;
    readonly catalog: boolean;
    readonly body: boolean;
    readonly garmentsGeometry: boolean;
    readonly garmentsFabric: boolean;
  };
}
