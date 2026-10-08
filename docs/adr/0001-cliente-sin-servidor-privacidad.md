# ADR 0001 — App 100 % cliente: vídeo y medidas nunca salen del dispositivo

- Estado: aceptada
- Fecha: 2026-10-08

## Contexto

La app procesa vídeo de la persona y estima sus medidas corporales: datos personales sensibles (potencialmente biométricos
según RGPD art. 9). Un backend que reciba vídeo multiplica el riesgo legal, la superficie de ataque y el coste (GPU).

## Decisión

- Detección de pose, estimación de medidas, ajuste de prendas y render se ejecutan **en el navegador** (WASM/WebGL).
- Ningún fotograma, landmark ni medida se envía por red. `connect-src 'self'` en la CSP lo hace **técnicamente imposible** hacia terceros.
- Sin analítica ni CDNs externos; modelos y WASM se sirven del mismo origen con checksum SHA-256 verificado en la build.
- Persistencia de medidas sólo si la persona la activa (localStorage, por defecto desactivado) con botón «Borrar mis datos».
- El catálogo es un JSON estático validado con zod (MVP). Un backend de catálogo/cuentas queda fuera del MVP (YAGNI).

## Consecuencias

- Privacidad máxima, coste de hosting mínimo (S3 + CloudFront), latencia baja, funciona sin sesión.
  − Calidad de inferencia limitada al dispositivo del usuario (modelo `lite` por defecto; `full` opcional).
  − Sin cuentas/«guardar looks» entre dispositivos hasta que exista backend (ver backlog; requerirá DPIA y consentimiento).

## Alternativas descartadas

Inferencia en servidor (GPU): mejor precisión pero envía vídeo; descartada por privacidad y coste.
