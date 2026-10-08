# Probador 3D (clothingfittingroom3d)

Probador virtual en el navegador: **enciende tu cámara → el sistema detecta tu talla → pruébate ropa en tiempo real, como en un espejo**,
dentro de un mundo 3D inmersivo.

> Estado: MVP en construcción. Consulta [`docs/ENGINEERING.md`](docs/ENGINEERING.md) para arquitectura, convenciones y calidad.

## Arranque local (un comando tras instalar)

```bash
pnpm install
NODE_USE_ENV_PROXY=1 node scripts/fetch-models.mjs   # modelos de pose (SHA-256 verificado) + WASM
pnpm dev                                              # http://localhost:5173  (localhost permite usar la cámara)
```

Requisitos: Node ≥ 22, pnpm ≥ 10. La cámara sólo funciona en `https://` o `http://localhost`.
Todo el procesamiento de vídeo ocurre **en tu dispositivo**; nada se sube a ningún servidor.
