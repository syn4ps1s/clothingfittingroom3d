# ADR 0008 — Hosting estático en AWS y despliegue condicionado a la aprobación del MVP

- Estado: aceptada

## Decisión

S3 privado + CloudFront (OAC) + cabeceras de seguridad (CSP estricta con `'wasm-unsafe-eval'`, `Permissions-Policy: camera=(self)`) + WAF opcional, definido con **CDK**.
CI en GitHub Actions; **el despliegue es manual con environment `production` que exige aprobación** y OIDC (sin claves de larga vida).
**No se despliega nada hasta que la persona dueña apruebe el MVP** tras probarlo en local.

## Consecuencias

- Coste mínimo, latencia global baja, superficie de ataque pequeña. − Sin lógica de servidor: ver ADR 0001.
