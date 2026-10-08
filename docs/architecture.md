# Arquitectura

## Flujo de usuario

```mermaid
flowchart LR
  A[Bienvenida<br/>atelier 3D] -->|Encender cámara| B[Escaneo guiado<br/>de talla]
  A -->|Sin cámara| M[Entrada manual<br/>de medidas]
  B --> C[Libro de medidas<br/>valores ± incertidumbre, editables]
  M --> C
  C --> D[Catálogo en perchero 3D<br/>recomendadas + talla sugerida]
  D --> E[Probador / espejo<br/>tiempo real]
  E -->|muestras, talla, capas| E
  E --> F[Foto local]
```

## Flujo de datos en tiempo real (todo en el navegador)

```mermaid
flowchart TB
  CAM[getUserMedia<br/>vídeo] --> POSE[PoseProvider<br/>MediaPipe lite / sintético]
  POSE --> SM[One-Euro + predicción]
  SM --> RT[poseToSkeleton<br/>retargeting swing]
  RT --> SK[SkeletonPose<br/>21 joints]
  SK --> SKIN[Skinning LBS en CPU<br/>cuerpo oclusor + prendas]
  SKIN --> CLOTH[Solver de tela PBD<br/>malla proxy + deltas]
  CLOTH --> RENDER[Render del espejo<br/>MeshPhysicalMaterial + arrugas]
  CAM --> RENDER
  RENDER --> RT2[RenderTarget] --> WORLD[Plano del espejo<br/>en el atelier 3D]
  POSE -. escaneo .-> SCAN[ScanSession<br/>medidas ± sigma]
  SCAN --> BODY[buildBody]
  BODY --> GEN[generateGarment<br/>+ texturas PBR]
  GEN --> SKIN
```

## Paquetes

| Paquete             | Responsabilidad                                                                                     | Puro (sin DOM/three) |
| ------------------- | --------------------------------------------------------------------------------------------------- | -------------------- |
| `@fitroom/shared`   | contratos: medidas (zod), esqueleto 21 joints, FK/skinning CPU, mallas, catálogo, tallaje, pose     | sí                   |
| `@fitroom/body`     | cuerpo paramétrico skinneado desde medidas, completado antropométrico, colisionadores               | sí                   |
| `@fitroom/pose`     | MediaPipe (adaptador), suavizado, retargeting, proveedor sintético, escaneo y estimación de medidas | lógica sí            |
| `@fitroom/garments` | `geometry/` prendas densas ajustadas · `fabric/` texturas PBR · `cloth/` solver PBD                 | sí                   |
| `@fitroom/catalog`  | telas, prendas, muestras, tablas de tallas, recomendación y outfits                                 | sí                   |
| `@fitroom/web`      | app Vite/React/R3F: mundo 3D, UI accesible, cámara, espejo, runtime                                 | no                   |
| `@fitroom/infra`    | AWS CDK: S3 + CloudFront + WAF, cabeceras de seguridad                                              | —                    |

Decisiones: ver [`docs/adr/`](adr). Convenciones y calidad: [`ENGINEERING.md`](ENGINEERING.md). Pruebas: [`testing-strategy.md`](testing-strategy.md).
