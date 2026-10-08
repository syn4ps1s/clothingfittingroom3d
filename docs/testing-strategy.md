# Estrategia de pruebas

Todo se ejecuta **en local** (Node 22 + Chromium headless con SwiftShader + cámara falsa de Chromium + pose sintética).

## Niveles

| Nivel                  | Herramienta           | Qué cubre                                                                                              |
| ---------------------- | --------------------- | ------------------------------------------------------------------------------------------------------ |
| Unitario / propiedades | Vitest + fast-check   | matemática, esqueleto, mallas, cuerpo, prendas, tallaje, solver, filtros, i18n, estado                 |
| Integración            | Vitest (Node)         | pose sintética → retargeting → FK → skinning → prenda; estimación de medidas contra cuerpos sintéticos |
| E2E                    | Playwright (Chromium) | recorrido completo, errores de cámara, teclado, `reduced-motion`, CSP «prod-like»                      |
| Accesibilidad          | axe-core              | 0 violaciones serias/críticas por pantalla                                                             |
| Visual                 | capturas revisadas    | realismo de prendas, composición del espejo, UI                                                        |
| Rendimiento            | microbenchmarks Node  | presupuestos por frame (pose, skinning, tela)                                                          |

## Programa adversarial (agentes independientes)

Cada agente recibe el producto **sin el diseño** y tiene como objetivo romperlo. Entrega hallazgos con severidad, pasos de reproducción y, cuando es posible, un **test que falla**.

| Rol                    | Mandato                              | Ejemplos                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seguridad y privacidad | encontrar fugas y vectores de ataque | red durante la sesión (nada de vídeo/landmarks), CSP bypass, XSS por catálogo/medidas, prototype pollution, `localStorage` por defecto, dependencias (`audit`), cámara que sigue encendida tras `stop`, clickjacking |
| Fuzz y caos numérico   | NaN/Inf/extremos/orden               | landmarks inválidos, pérdidas de tracking, 2+ personas, timestamps hacia atrás, `dt` extremo, cuerpos de 120 y 230 cm, poses imposibles, 10⁴ pasos de tela caóticos                                                  |
| Crítico de realismo    | demostrar que «parece de juguete»    | triángulos por prenda, penetración del cuerpo, UV/estiramiento, costuras, borde sin grosor, material plano, z-fighting, coherencia de talla/ease                                                                     |
| Accesibilidad y UX     | usuarios reales difíciles            | teclado puro, lector de pantalla, contraste, `prefers-reduced-motion`, permiso denegado, sin WebGL2, poca luz, móvil 390×844, textos largos en es/en                                                                 |
| Rendimiento            | presupuestos y fugas                 | coste CPU/frame, memoria tras 100 cambios de prenda, dispose de GPU, tamaño del bundle                                                                                                                               |

### Ciclo

1. Hallazgo → severidad (S1 crítico/privacidad/seguridad · S2 funcionalidad principal rota · S3 degradación · S4 cosmético).
2. Reproducir con un test que **falla** (regresión).
3. Corregir en el paquete dueño; el test queda en CI.
4. Re-ejecutar la ronda hasta 0 S1/S2 abiertos; S3 con decisión explícita documentada.
