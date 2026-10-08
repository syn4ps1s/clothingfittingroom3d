import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CSP_DIRECTIVES,
  HSTS_MAX_AGE_SECONDS,
  PERMISSIONS_POLICY,
  buildCsp,
  buildHsts,
  buildSecurityHeaders,
  cspDirectivesFor,
  findNonLocalCspSources,
  normalizeHeaderValue,
} from '../lib/security-headers';

/** CSP «de referencia» escrita a mano: si alguien relaja la fuente única, este test lo delata. */
const EXPECTED_CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  'upgrade-insecure-requests',
].join('; ');

describe('Content-Security-Policy', () => {
  it('es exactamente la política acordada', () => {
    expect(buildCsp()).toBe(EXPECTED_CSP);
  });

  it('REGRESIÓN DE PRIVACIDAD: ninguna directiva permite hosts externos', () => {
    expect(findNonLocalCspSources()).toEqual([]);
    const csp = buildCsp();
    expect(csp).not.toMatch(/https?:/i);
    expect(csp).not.toMatch(/wss?:/i);
    expect(csp).not.toMatch(/\*/);
    expect(csp).not.toMatch(/\b[a-z0-9-]+\.[a-z]{2,}\b/i); // ningún nombre de dominio
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it('los scripts sólo pueden venir del mismo origen (y WASM); nada en línea, ni data:/blob:', () => {
    expect(CSP_DIRECTIVES['script-src']).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    for (const dangerous of [
      "'unsafe-inline'",
      "'unsafe-eval'",
      'data:',
      'blob:',
      "'strict-dynamic'",
    ]) {
      expect(CSP_DIRECTIVES['script-src']).not.toContain(dangerous);
    }
  });

  it('la cámara es posible (media-src/mediastream) pero los marcos, formularios, <base> y plugins están prohibidos', () => {
    expect(CSP_DIRECTIVES['media-src']).toContain('mediastream:');
    expect(CSP_DIRECTIVES['frame-ancestors']).toEqual(["'none'"]);
    expect(CSP_DIRECTIVES['form-action']).toEqual(["'none'"]);
    expect(CSP_DIRECTIVES['base-uri']).toEqual(["'none'"]);
    expect(CSP_DIRECTIVES['object-src']).toEqual(["'none'"]);
    expect(CSP_DIRECTIVES['default-src']).toEqual(["'none'"]);
  });

  it('el único debilitamiento aceptado es style-src unsafe-inline (documentado en el módulo)', () => {
    const weak = Object.entries(CSP_DIRECTIVES).flatMap(([name, sources]) =>
      (sources as readonly string[]).filter((s) => s === "'unsafe-inline'").map(() => name),
    );
    expect(weak).toEqual(['style-src']);
  });

  it('buildCsp rechaza hosts externos (defensa en profundidad)', () => {
    const hostile = [
      'https://cdn.example.com',
      'http://evil.test',
      'https:',
      'http:',
      'wss://relay.example.com',
      '*',
      '*.example.com',
      'example.com',
      'cdn.jsdelivr.net',
      "'unsafe-eval'",
      "'strict-dynamic'",
      "'nonce-abc'",
    ];
    for (const source of hostile) {
      expect(
        () => buildCsp({ ...CSP_DIRECTIVES, 'connect-src': ["'self'", source] }),
        source,
      ).toThrow(/no locales/);
    }
  });

  it('propiedad: cualquier fuente que no sea una palabra clave local se rechaza', () => {
    const allowed = new Set([
      "'none'",
      "'self'",
      "'wasm-unsafe-eval'",
      "'unsafe-inline'",
      'data:',
      'blob:',
      'mediastream:',
    ]);
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 40 })
          .filter((s) => !allowed.has(s) && !/[\s;,]/.test(s)),
        (source) => {
          expect(() => buildCsp({ 'default-src': ["'none'"], 'img-src': [source] })).toThrow();
        },
      ),
      { seed: 20251008, numRuns: 200 },
    );
  });
});

describe('variante estricta de estilos (candidata a ser la definitiva)', () => {
  it('quita unsafe-inline de style-src y sólo eso', () => {
    const strict = buildSecurityHeaders({ strictStyles: true })['Content-Security-Policy']!;
    expect(strict).toContain("style-src 'self';");
    expect(strict).not.toContain("'unsafe-inline'");
    expect(strict.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")).toBe(buildCsp());
    expect(findNonLocalCspSources(cspDirectivesFor({ strictStyles: true }))).toEqual([]);
  });
  it('por defecto NO es estricta (no rompe la UI mientras no se valide)', () => {
    expect(cspDirectivesFor()).toBe(CSP_DIRECTIVES);
    expect(buildSecurityHeaders()['Content-Security-Policy']).toContain(
      "style-src 'self' 'unsafe-inline'",
    );
  });
});

describe('resto de cabeceras', () => {
  it('Permissions-Policy: cámara sólo del propio origen, el resto denegado', () => {
    expect(PERMISSIONS_POLICY).toBe(
      'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
    );
  });

  it('HSTS: 2 años, includeSubDomains y preload sólo si se pide', () => {
    expect(HSTS_MAX_AGE_SECONDS).toBe(63_072_000);
    expect(buildHsts()).toBe('max-age=63072000; includeSubDomains');
    expect(buildHsts({ hstsPreload: true })).toBe('max-age=63072000; includeSubDomains; preload');
  });

  it('conjunto completo de cabeceras', () => {
    expect(buildSecurityHeaders()).toEqual({
      'Content-Security-Policy': EXPECTED_CSP,
      'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
      'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
    });
  });

  it('normalizeHeaderValue ignora espacios y puntos y coma finales', () => {
    expect(normalizeHeaderValue('a  b ;  c ; ')).toBe('a b; c');
  });
});
