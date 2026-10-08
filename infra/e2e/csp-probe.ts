#!/usr/bin/env node
/**
 * Sonda de compatibilidad con la CSP de producción, con Chromium real (Playwright).
 *
 *   pnpm --filter @fitroom/infra csp:probe                          # matriz de compatibilidad (fixture + MediaPipe real)
 *   pnpm --filter @fitroom/infra csp:probe -- --site ../apps/web/dist   # carga la app REAL construida
 *   ... --strict-style          # usa la CSP sin 'unsafe-inline' en style-src (candidata a ser la definitiva)
 *   ... --site <dir> --strict   # además falla ante eval()/new Function() (zod v4 sin jitless)
 *
 * Sirve el sitio con `scripts/serve-prod-like.mjs` (las MISMAS cabeceras que CloudFront) y comprueba:
 *   · fixture: lo que la app necesita funciona (WASM, workers, blob:, cámara, MediaPipe) y lo que un atacante
 *     intentaría (XSS en línea, eval, exfiltración, marcos, formularios, <base>) queda BLOQUEADO;
 *     además, una página de otro origen no puede incrustar la app (clickjacking).
 *   · site: cero violaciones de CSP, cero errores de consola/página, cero peticiones a otros hosts.
 * Sale con código 1 ante cualquier fallo. No necesita red: sólo Chromium.
 *
 * Chromium: PW_CHROMIUM_PATH, o /opt/pw-browsers/chromium si existe (entorno local), o el que instala
 * `playwright install chromium` (CI).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { buildSecurityHeaders } from '../lib/security-headers';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const FIXTURE = resolve(here, 'fixture');
const LOCAL_CHROMIUM = '/opt/pw-browsers/chromium';

interface ProbeResult {
  name: string;
  kind: 'allowed' | 'blocked' | 'skipped' | 'warning';
  ok: boolean;
  detail: string;
}

interface ProdLikeModule {
  createProdLikeServer(options: { dir: string; quiet?: boolean; strictStyles?: boolean }): Server;
}

export interface ProbeReport {
  readonly mode: 'fixture' | 'site';
  readonly strictStyles: boolean;
  readonly ok: boolean;
  readonly results: readonly ProbeResult[];
  readonly findings: readonly string[];
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise((done) => server.close(done));
}

async function startProdLike(
  dir: string,
  strictStyles: boolean,
): Promise<{ server: Server; url: string }> {
  const module = (await import(
    pathToFileURL(resolve(repoRoot, 'scripts/serve-prod-like.mjs')).href
  )) as ProdLikeModule;
  const server = module.createProdLikeServer({ dir, quiet: true, strictStyles });
  return { server, url: await listen(server) };
}

async function launch(): Promise<Browser> {
  const executablePath =
    process.env.PW_CHROMIUM_PATH ?? (existsSync(LOCAL_CHROMIUM) ? LOCAL_CHROMIUM : undefined);
  return chromium.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      // WebGL por software (sin GPU) y cámara falsa: ver docs/ENGINEERING.md §6.
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });
}

/** Instrumenta una página: violaciones de CSP, errores de consola/página y peticiones fuera del origen. */
function instrument(page: Page, origin: string) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const external: string[] = [];
  const externalResponses: string[] = [];
  const failed: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith('data:') && !url.startsWith('blob:') && !url.startsWith(origin))
      external.push(url);
  });
  page.on('response', (response) => {
    const url = response.url();
    if (!url.startsWith('data:') && !url.startsWith('blob:') && !url.startsWith(origin))
      externalResponses.push(url);
  });
  page.on('requestfailed', (request) =>
    failed.push(`${request.url()} (${request.failure()?.errorText ?? '?'})`),
  );
  return { consoleErrors, pageErrors, external, externalResponses, failed };
}

async function runFixture(strictStyles: boolean): Promise<ProbeReport> {
  const findings: string[] = [];
  const site = mkdtempSync(join(tmpdir(), 'fitroom-csp-probe-'));
  const servers: Server[] = [];
  let browser: Browser | undefined;
  try {
    // Sitio de prueba: fixture + (si existen) los WASM/modelos/bundle REALES de MediaPipe.
    cpSync(FIXTURE, site, { recursive: true });
    mkdirSync(join(site, 'assets'));
    writeFileSync(
      join(site, 'assets/min-4f2a1c9e.wasm'),
      Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    );
    const publicDir = join(repoRoot, 'apps/web/public');
    const bundle = join(
      repoRoot,
      'packages/pose/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs',
    );
    const hasMediaPipe =
      existsSync(join(publicDir, 'wasm/vision_wasm_internal.wasm')) &&
      existsSync(join(publicDir, 'models/pose_landmarker_lite.task')) &&
      existsSync(bundle);
    if (hasMediaPipe) {
      symlinkSync(join(publicDir, 'wasm'), join(site, 'wasm'));
      symlinkSync(join(publicDir, 'models'), join(site, 'models'));
      mkdirSync(join(site, 'vendor'));
      cpSync(bundle, join(site, 'vendor/vision_bundle.mjs'));
    }

    const prodLike = await startProdLike(site, strictStyles);
    servers.push(prodLike.server);
    browser = await launch();
    const context = await browser.newContext({ permissions: ['camera'] });
    const page = await context.newPage();
    const watch = instrument(page, prodLike.url);
    const response = await page.goto(
      `${prodLike.url}/?mediapipe=${hasMediaPipe ? 1 : 0}&strictStyle=${strictStyles ? 1 : 0}`,
    );
    // Las cabeceras que ve el navegador son las de la fuente única.
    const expected = buildSecurityHeaders({ strictStyles });
    for (const [name, value] of Object.entries(expected)) {
      if (response?.headers()[name.toLowerCase()] !== value)
        findings.push(`Cabecera ${name} distinta o ausente en la navegación`);
    }
    // OJO: `page.waitForFunction()` NO sirve aquí: Playwright lo evalúa con eval() en la página y la CSP
    // (correctamente) lo bloquea. `page.evaluate()` va por CDP y no está sujeto a la CSP: se sondea desde Node.
    const deadline = Date.now() + 240_000;
    while (!(await page.evaluate('Boolean(window.__probe && window.__probe.done)'))) {
      if (Date.now() > deadline) throw new Error('La página de sondeo no terminó en 240 s');
      await page.waitForTimeout(250);
    }
    const results = (await page.evaluate('window.__probe.results')) as ProbeResult[];

    // Clickjacking: una página de OTRO origen no puede incrustar la app (frame-ancestors 'none' + X-Frame-Options).
    const embedderHtml = readFileSync(join(FIXTURE, 'embedder.html'), 'utf8');
    const embedder = createServer((_request, reply) => {
      reply.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      reply.end(embedderHtml.replace('__TARGET__', `${prodLike.url}/`));
    });
    servers.push(embedder);
    const embedderUrl = await listen(embedder);
    const framing = await context.newPage();
    await framing.goto(embedderUrl);
    await framing.waitForTimeout(1500);
    const child = framing.frames().find((frame) => frame !== framing.mainFrame());
    const childUrl = child?.url() ?? '(sin iframe)';
    const blockedFrame =
      !child || childUrl.startsWith('chrome-error:') || childUrl === 'about:blank';
    results.push({
      name: 'clickjacking: otra página no puede incrustar la app en un <iframe>',
      kind: 'blocked',
      ok: blockedFrame,
      detail: blockedFrame ? `iframe bloqueado (${childUrl})` : `¡SE INCRUSTÓ! ${childUrl}`,
    });

    for (const error of watch.pageErrors) findings.push(`Error de página: ${error}`);
    // Los ataques simulados SÍ intentan salir; lo que jamás puede ocurrir es que alguno reciba respuesta.
    for (const url of watch.externalResponses) {
      findings.push(`¡Respuesta de otro origen (CSP rota)!: ${url}`);
    }
    const failures = results.filter((r) => !r.ok);
    return {
      mode: 'fixture',
      strictStyles,
      ok: failures.length === 0 && findings.length === 0,
      results,
      findings,
    };
  } finally {
    await browser?.close();
    for (const server of servers) await closeServer(server);
    rmSync(site, { recursive: true, force: true });
  }
}

/** Carga la app construida y falla ante cualquier violación de CSP, error o petición externa. */
async function runSite(dir: string, strict: boolean, strictStyles: boolean): Promise<ProbeReport> {
  if (!existsSync(join(dir, 'index.html')))
    throw new Error(`No existe ${dir}/index.html: ejecuta \`pnpm --filter @fitroom/web build\``);
  const prodLike = await startProdLike(dir, strictStyles);
  const browser = await launch();
  const findings: string[] = [];
  const results: ProbeResult[] = [];
  try {
    const context = await browser.newContext({ permissions: ['camera'] });
    const page = await context.newPage();
    // Código del navegador como cadena: este paquete no incluye los tipos DOM.
    await page.addInitScript(`
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        window.__csp.push(event.effectiveDirective + ' bloqueó ' + event.blockedURI + ' (' + (event.sample || 'sin muestra') + ')');
      });
    `);
    const watch = instrument(page, prodLike.url);
    const response = await page.goto(`${prodLike.url}/`, { waitUntil: 'load' });
    results.push({
      name: 'GET / responde 200',
      kind: 'allowed',
      ok: response?.status() === 200,
      detail: `HTTP ${response?.status()}`,
    });
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => undefined);
    await page.waitForTimeout(3000);
    const rootChildren = await page.evaluate(
      "document.getElementById('root') ? document.getElementById('root').childElementCount : -1",
    );
    results.push({
      name: 'la app pinta algo en #root',
      kind: 'allowed',
      ok: Number(rootChildren) > 0,
      detail: `${rootChildren} hijos`,
    });

    // Mejor esfuerzo: pulsar «Encender cámara» (si existe) para ejercitar getUserMedia + MediaPipe bajo la CSP.
    const camera = page
      .getByRole('button', { name: /encender c[aá]mara|turn on (the )?camera|start camera/i })
      .first();
    if (await camera.count()) {
      await camera.click().catch(() => undefined);
      await page.waitForTimeout(8000);
      results.push({
        name: 'botón de cámara pulsado',
        kind: 'allowed',
        ok: true,
        detail: 'getUserMedia con cámara falsa',
      });
    } else {
      results.push({
        name: 'botón de cámara',
        kind: 'skipped',
        ok: true,
        detail: 'no se encontró (¿cambió el texto?)',
      });
    }
    const cspViolations = (await page.evaluate('window.__csp')) as string[];
    // zod v4 comprueba con `new Function('')` si puede compilar validadores (JIT) y, si la CSP lo impide, cae al modo
    // interpretado: es INOCUO pero deja una violación en el registro. Se evita con `z.config({ jitless: true })`.
    // Por defecto sólo avisa; con --strict (cuando la app ya use jitless) falla.
    const evalViolations = cspViolations.filter((text) => /bloqueó eval\b/.test(text));
    const otherViolations = cspViolations.filter((text) => !evalViolations.includes(text));
    results.push({
      name: 'cero violaciones de CSP (salvo eval)',
      kind: 'allowed',
      ok: otherViolations.length === 0,
      detail: otherViolations.join(' | ') || 'ninguna',
    });
    results.push({
      name: 'sin eval()/new Function() (zod v4 lo sondea: usar z.config({ jitless: true }))',
      kind: strict || evalViolations.length === 0 ? 'allowed' : 'warning',
      ok: strict ? evalViolations.length === 0 : true,
      detail:
        evalViolations.length === 0
          ? 'ninguno'
          : `${evalViolations.length} intento(s) bloqueado(s) por la CSP`,
    });
    results.push({
      name: 'cero peticiones a otros orígenes',
      kind: 'allowed',
      ok: watch.external.length === 0,
      detail: watch.external.join(' | ') || 'ninguna',
    });
    const cspConsole = watch.consoleErrors.filter((text) =>
      /Content Security Policy|Refused to|violates the following/i.test(text),
    );
    results.push({
      name: 'sin errores de CSP en la consola',
      kind: 'allowed',
      ok: cspConsole.length === 0,
      detail: cspConsole.join(' | ') || 'ninguno',
    });
    for (const error of watch.pageErrors) findings.push(`Error de página: ${error}`);
    for (const text of watch.consoleErrors.filter((t) => !cspConsole.includes(t)))
      findings.push(`Error de consola: ${text}`);
    for (const text of watch.failed) findings.push(`Petición fallida: ${text}`);
    const failures = results.filter((r) => !r.ok);
    return {
      mode: 'site',
      strictStyles,
      ok: failures.length === 0 && findings.length === 0,
      results,
      findings,
    };
  } finally {
    await browser.close();
    await closeServer(prodLike.server);
  }
}

export function formatReport(report: ProbeReport): string {
  const lines = report.results.map(
    (r) =>
      `${r.ok ? (r.kind === 'skipped' ? 'OMIT ' : r.kind === 'warning' ? 'AVISO' : 'OK   ') : 'FALLO'} [${r.kind}] ${r.name}\n        ${r.detail}`,
  );
  for (const finding of report.findings) lines.push(`HALLAZGO ${finding}`);
  const variant = `${report.mode}${report.strictStyles ? ', style-src estricto' : ''}`;
  lines.push(
    report.ok ? `\nSonda CSP (${variant}): TODO CORRECTO` : `\nSonda CSP (${variant}): HAY FALLOS`,
  );
  return lines.join('\n');
}

async function main(): Promise<void> {
  const site = arg('site');
  const strictStyles = process.argv.includes('--strict-style');
  const report = site
    ? await runSite(resolve(site), process.argv.includes('--strict'), strictStyles)
    : await runFixture(strictStyles);
  console.log(formatReport(report));
  const out = arg('out');
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), JSON.stringify(report, null, 2));
  }
  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}
