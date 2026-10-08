# ADR 0004 — Pose con MediaPipe on-device y estimación de talla con incertidumbre

- Estado: aceptada

## Decisión

- **MediaPipe PoseLandmarker** (`@mediapipe/tasks-vision`), modelo `lite` en tiempo real (GPU→CPU fallback) y `full` para fotos/escaneo.
  Detrás de un puerto `PoseProvider`: hay también un proveedor **sintético determinista** (tests/e2e/demo sin cámara).
- Landmarks → esqueleto canónico por **retargeting swing** + One-Euro + predicción; raíz en espacio cámara por pinhole con escala métrica
  de la estatura declarada.
- **Medidas**: la estatura declarada fija la escala. Longitudes (hombros, brazos, piernas) se miden de los landmarks 3D; las **circunferencias NO se pueden
  medir con exactitud con una cámara RGB** y se estiman por regresión antropométrica + ancho de silueta (máscara de segmentación). Cada valor lleva `sigma`
  (incertidumbre), se muestra al usuario y es **siempre editable**. No se promete precisión de sastre.

## Consecuencias

- Experiencia «enciende la cámara y listo» honesta; el tallaje usa la incertidumbre para bajar la confianza de la recomendación.
  − Precisión de circunferencias limitada (±4–6 cm típico); mitigación: confirmación manual y, a futuro, escaneo de perfil/multi-ángulo.
