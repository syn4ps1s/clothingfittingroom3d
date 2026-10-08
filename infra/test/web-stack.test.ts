/* eslint-disable @typescript-eslint/no-explicit-any --
   Las plantillas de CloudFormation son JSON sin esquema: las aserciones navegan por ellas de forma dinámica
   y tiparlas campo a campo no aportaría seguridad (cada aserción comprueba además el valor exacto). */
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { CACHE_IMMUTABLE, CACHE_NO_CACHE, CACHE_REVALIDATE } from '../lib/asset-policy';
import { buildSecurityHeaders, normalizeHeaderValue } from '../lib/security-headers';
import {
  FAKE_CERT_ARN,
  FAKE_ZONE_ID,
  FIXTURE_DIST,
  PROD,
  PROD_FULL,
  STAGING,
  makeApp,
  makeStack,
  resourcesOfType,
  synth,
  type TemplateJson,
} from './helpers';
import { FitroomWebStack } from '../lib/web-stack';

const staging = synth(STAGING);
const prod = synth(PROD);
const full = synth(PROD_FULL);

/** Convierte la ResponseHeadersPolicy sintetizada en {cabecera: valor} para compararla con la fuente única. */
function renderedHeaders(json: TemplateJson): Record<string, string> {
  const [, policy] = resourcesOfType(json, 'AWS::CloudFront::ResponseHeadersPolicy')[0]!;
  const config = (policy.Properties as { ResponseHeadersPolicyConfig: Record<string, any> })
    .ResponseHeadersPolicyConfig;
  const sec = config.SecurityHeadersConfig;
  const hsts = sec.StrictTransportSecurity;
  const out: Record<string, string> = {
    'Content-Security-Policy': sec.ContentSecurityPolicy.ContentSecurityPolicy,
    'Strict-Transport-Security':
      `max-age=${hsts.AccessControlMaxAgeSec}` +
      (hsts.IncludeSubdomains ? '; includeSubDomains' : '') +
      (hsts.Preload ? '; preload' : ''),
    'X-Content-Type-Options': sec.ContentTypeOptions ? 'nosniff' : '',
    'Referrer-Policy': sec.ReferrerPolicy.ReferrerPolicy,
    'X-Frame-Options': sec.FrameOptions.FrameOption,
  };
  for (const item of config.CustomHeadersConfig.Items) out[item.Header] = item.Value;
  return out;
}

describe('S3 privado', () => {
  for (const [name, { template }] of [
    ['staging', staging],
    ['prod', prod],
  ] as const) {
    it(`${name}: bloqueo de acceso público TOTAL, SSE-S3, versionado y sólo SSL`, () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
          ],
        },
        VersioningConfiguration: { Status: 'Enabled' },
        LoggingConfiguration: { LogFilePrefix: 's3-access/' },
      });
    });

    it(`${name}: TODOS los buckets bloquean el acceso público y fuerzan TLS`, () => {
      const json = template.toJSON() as TemplateJson;
      const buckets = resourcesOfType(json, 'AWS::S3::Bucket');
      expect(buckets).toHaveLength(2); // sitio + logs
      for (const [, bucket] of buckets) {
        expect(bucket.Properties?.PublicAccessBlockConfiguration).toEqual({
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        });
      }
      const policies = resourcesOfType(json, 'AWS::S3::BucketPolicy');
      expect(policies).toHaveLength(2);
      for (const [, policy] of policies) {
        const statements = (policy.Properties as any).PolicyDocument.Statement as any[];
        expect(statements).toContainEqual(
          expect.objectContaining({
            Effect: 'Deny',
            Action: 's3:*',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        );
      }
    });
  }

  it('ninguna política de bucket concede acceso a Principal «*» (salvo el Deny de SSL)', () => {
    for (const { json } of [staging, prod, full]) {
      for (const [, policy] of resourcesOfType(json, 'AWS::S3::BucketPolicy')) {
        const statements = (policy.Properties as any).PolicyDocument.Statement as any[];
        for (const statement of statements) {
          const principal = JSON.stringify(statement.Principal);
          if (statement.Effect === 'Allow') expect(principal).not.toMatch(/"\*"/);
        }
      }
    }
  });

  it('el bucket del sitio sólo lo lee CloudFront (OAC) acotado a ESTA distribución', () => {
    const [, policy] = resourcesOfType(prod.json, 'AWS::S3::BucketPolicy').find(([id]) =>
      id.startsWith('SiteBucketPolicy'),
    )!;
    const allow = ((policy.Properties as any).PolicyDocument.Statement as any[]).filter(
      (s) => s.Effect === 'Allow',
    );
    expect(allow).toHaveLength(1);
    expect(allow[0]).toMatchObject({
      Action: 's3:GetObject',
      Principal: { Service: 'cloudfront.amazonaws.com' },
    });
    expect(JSON.stringify(allow[0].Condition)).toContain(':distribution/');
  });

  it('versiones antiguas y subidas incompletas caducan (base del rollback acotado)', () => {
    prod.template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: [
          Match.objectLike({
            Id: 'ExpireNoncurrentVersions',
            NoncurrentVersionExpiration: { NoncurrentDays: 90 },
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
            Status: 'Enabled',
          }),
        ],
      },
    });
    staging.template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: [Match.objectLike({ NoncurrentVersionExpiration: { NoncurrentDays: 30 } })],
      },
    });
  });
});

describe('CloudFront con Origin Access Control', () => {
  it('usa OAC (SigV4) y NO el antiguo OAI', () => {
    prod.template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({
        OriginAccessControlOriginType: 's3',
        SigningBehavior: 'always',
        SigningProtocol: 'sigv4',
      }),
    });
    expect(
      resourcesOfType(prod.json, 'AWS::CloudFront::CloudFrontOriginAccessIdentity'),
    ).toHaveLength(0);
    prod.template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Origins: [
          Match.objectLike({
            OriginAccessControlId: Match.anyValue(),
            S3OriginConfig: { OriginAccessIdentity: '' },
          }),
        ],
      }),
    });
  });

  it('HTTP/2 + HTTP/3, IPv6, HTTPS obligatorio, sólo GET/HEAD y compresión en TODOS los comportamientos', () => {
    const [, dist] = resourcesOfType(prod.json, 'AWS::CloudFront::Distribution')[0]!;
    const config = (dist.Properties as any).DistributionConfig;
    expect(config.HttpVersion).toBe('http2and3');
    expect(config.IPV6Enabled).toBe(true);
    expect(config.DefaultRootObject).toBe('index.html');
    const behaviors = [config.DefaultCacheBehavior, ...config.CacheBehaviors];
    expect(behaviors).toHaveLength(4);
    for (const behavior of behaviors) {
      expect(behavior.ViewerProtocolPolicy).toBe('redirect-to-https');
      expect(behavior.AllowedMethods).toEqual(['GET', 'HEAD']);
      expect(behavior.Compress).toBe(true);
      expect(behavior.ResponseHeadersPolicyId).toBeDefined();
    }
  });

  it('TLS mínimo 1.2 (política TLSv1.2_2021) con SNI cuando hay dominio propio', () => {
    prod.template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['probador.example.com'],
        ViewerCertificate: Match.objectLike({
          MinimumProtocolVersion: 'TLSv1.2_2021',
          SslSupportMethod: 'sni-only',
        }),
      }),
    });
    expect(JSON.stringify(prod.json)).not.toMatch(/TLSv1(?!\.2)/);
  });

  it('SPA: 403 y 404 se resuelven como /index.html con 200', () => {
    for (const { template } of [staging, prod]) {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          CustomErrorResponses: [
            {
              ErrorCode: 403,
              ResponseCode: 200,
              ResponsePagePath: '/index.html',
              ErrorCachingMinTTL: 10,
            },
            {
              ErrorCode: 404,
              ResponseCode: 200,
              ResponsePagePath: '/index.html',
              ErrorCachingMinTTL: 10,
            },
          ],
        }),
      });
    }
  });

  it('PriceClass configurable', () => {
    staging.template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ PriceClass: 'PriceClass_100' }),
    });
    prod.template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ PriceClass: 'PriceClass_All' }),
    });
    const custom = synth({ ...STAGING, priceClass: 'PriceClass_200' });
    custom.template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ PriceClass: 'PriceClass_200' }),
    });
  });

  it('staging sin dominio: certificado por defecto y sin ajustes TLS engañosos', () => {
    const [, dist] = resourcesOfType(staging.json, 'AWS::CloudFront::Distribution')[0]!;
    const config = (dist.Properties as any).DistributionConfig;
    expect(config.Aliases).toBeUndefined();
    expect(config.ViewerCertificate).toBeUndefined();
    expect(
      Annotations.fromStack(staging.stack).findWarning(
        '*',
        Match.stringLikeRegexp('minimumProtocolVersion'),
      ),
    ).toHaveLength(0);
  });

  it('restricción geográfica opcional', () => {
    full.template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Restrictions: { GeoRestriction: { RestrictionType: 'whitelist', Locations: ['ES', 'MX'] } },
      }),
    });
  });
});

describe('políticas de caché', () => {
  const policyByComment = (json: TemplateJson, fragment: string) => {
    const found = resourcesOfType(json, 'AWS::CloudFront::CachePolicy').find(([, p]) =>
      JSON.stringify(p.Properties).includes(fragment),
    );
    expect(found, fragment).toBeDefined();
    return (found![1].Properties as any).CachePolicyConfig;
  };

  it('assets con hash: inmutables 1 año; index.html sin caché; .task/.wasm cacheables con revalidación', () => {
    const immutable = policyByComment(prod.json, 'Archivos con hash');
    expect(immutable).toMatchObject({ MinTTL: 31536000, DefaultTTL: 31536000, MaxTTL: 31536000 });
    const html = policyByComment(prod.json, 'index.html y archivos sin hash');
    expect(html).toMatchObject({ MinTTL: 0, DefaultTTL: 0 });
    expect(html.MaxTTL).toBeLessThanOrEqual(60);
    const binaries = policyByComment(prod.json, 'Modelos .task y WASM');
    expect(binaries).toMatchObject({ MinTTL: 0, DefaultTTL: 86400 });
    for (const config of [immutable, html, binaries]) {
      expect(config.ParametersInCacheKeyAndForwardedToOrigin).toMatchObject({
        EnableAcceptEncodingBrotli: true,
        EnableAcceptEncodingGzip: true,
        QueryStringsConfig: { QueryStringBehavior: 'none' },
        CookiesConfig: { CookieBehavior: 'none' },
        HeadersConfig: { HeaderBehavior: 'none' },
      });
    }
  });

  it('cada ruta usa la política que le corresponde', () => {
    const [, dist] = resourcesOfType(prod.json, 'AWS::CloudFront::Distribution')[0]!;
    const config = (dist.Properties as any).DistributionConfig;
    const idFor = (fragment: string) =>
      resourcesOfType(prod.json, 'AWS::CloudFront::CachePolicy').find(([, p]) =>
        JSON.stringify(p.Properties).includes(fragment),
      )![0];
    expect(config.DefaultCacheBehavior.CachePolicyId).toEqual({
      Ref: idFor('index.html y archivos sin hash'),
    });
    const byPath = Object.fromEntries(
      config.CacheBehaviors.map((b: any) => [b.PathPattern, b.CachePolicyId]),
    );
    expect(byPath).toEqual({
      'assets/*': { Ref: idFor('Archivos con hash') },
      'wasm/*': { Ref: idFor('Modelos .task y WASM') },
      'models/*': { Ref: idFor('Modelos .task y WASM') },
    });
  });
});

describe('cabeceras de seguridad (ResponseHeadersPolicy)', () => {
  it('coincide EXACTAMENTE con la fuente única que usa también el servidor local', () => {
    expect(renderedHeaders(prod.json)).toEqual(buildSecurityHeaders());
    expect(renderedHeaders(staging.json)).toEqual(buildSecurityHeaders());
    expect(renderedHeaders(full.json)).toEqual(buildSecurityHeaders({ hstsPreload: true }));
  });

  it('CSP y Permissions-Policy esperadas, con override de las del origen', () => {
    prod.template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          ContentSecurityPolicy: {
            ContentSecurityPolicy: Match.stringLikeRegexp(
              "^default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:",
            ),
            Override: true,
          },
          ContentTypeOptions: { Override: true },
          FrameOptions: { FrameOption: 'DENY', Override: true },
          ReferrerPolicy: { ReferrerPolicy: 'no-referrer', Override: true },
          StrictTransportSecurity: {
            AccessControlMaxAgeSec: 63072000,
            IncludeSubdomains: true,
            Preload: false,
            Override: true,
          },
        }),
        CustomHeadersConfig: {
          Items: Match.arrayWith([
            {
              Header: 'Permissions-Policy',
              Value: 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
              Override: true,
            },
            { Header: 'Cross-Origin-Opener-Policy', Value: 'same-origin', Override: true },
            { Header: 'Cross-Origin-Resource-Policy', Value: 'same-origin', Override: true },
          ]),
        },
      }),
    });
  });

  it('REGRESIÓN DE PRIVACIDAD: la CSP desplegada no contiene ningún host externo', () => {
    for (const { json } of [staging, prod, full]) {
      const csp = renderedHeaders(json)['Content-Security-Policy']!;
      const sources = csp.split(';').flatMap((directive) => directive.trim().split(/\s+/).slice(1));
      const allowed = new Set([
        "'none'",
        "'self'",
        "'wasm-unsafe-eval'",
        "'unsafe-inline'",
        'data:',
        'blob:',
        'mediastream:',
      ]);
      expect(sources.filter((s) => !allowed.has(s))).toEqual([]);
    }
  });

  it('strictStyleSrc=true despliega la CSP sin unsafe-inline en style-src (igual que el servidor local --strict-style)', () => {
    const strict = synth({ ...PROD, strictStyleSrc: true });
    expect(renderedHeaders(strict.json)).toEqual(buildSecurityHeaders({ strictStyles: true }));
    expect(renderedHeaders(strict.json)['Content-Security-Policy']).not.toContain('unsafe-inline');
  });

  it('el HSTS con preload sólo se emite si se pide', () => {
    expect(
      normalizeHeaderValue(renderedHeaders(prod.json)['Strict-Transport-Security']!),
    ).not.toContain('preload');
    expect(renderedHeaders(full.json)['Strict-Transport-Security']).toContain('preload');
  });
});

describe('publicación de archivos (BucketDeployment)', () => {
  const deployments = (json: TemplateJson) =>
    Object.fromEntries(
      resourcesOfType(json, 'Custom::CDKBucketDeployment').map(([id, r]) => [
        id.replace(/CustomResource.*$/, '').replace(/^Deploy/, ''),
        r,
      ]),
    );

  it('una publicación por clase con su Cache-Control y Content-Type exactos', () => {
    const d = deployments(prod.json);
    expect(Object.keys(d).sort()).toEqual([
      'ImmutableAssets',
      'PoseModels',
      'Shell',
      'WasmBinaries',
      'WasmLoaders',
    ]);
    const meta = (name: string) => (d[name]!.Properties as any).SystemMetadata;
    expect(meta('ImmutableAssets')).toEqual({ 'cache-control': CACHE_IMMUTABLE });
    expect(meta('WasmBinaries')).toEqual({
      'cache-control': CACHE_REVALIDATE,
      'content-type': 'application/wasm',
    });
    expect(meta('PoseModels')).toEqual({
      'cache-control': CACHE_REVALIDATE,
      'content-type': 'application/octet-stream',
    });
    expect(meta('WasmLoaders')['content-type']).toMatch(/^text\/javascript/);
    expect(meta('Shell')).toEqual({ 'cache-control': CACHE_NO_CACHE });
  });

  it('prune activo, contenido conservado al borrar el stack y filtros que particionan el árbol', () => {
    const d = deployments(prod.json);
    for (const resource of Object.values(d)) {
      expect((resource.Properties as any).Prune).toBe(true);
      expect(resource.DeletionPolicy).toBe('Delete'); // la CR; el contenido se conserva por RetainOnDelete (por defecto true)
    }
    expect((d.Shell!.Properties as any).Exclude).toEqual([
      'assets/*',
      'wasm/*.wasm',
      'wasm/*.js',
      'models/*.task',
    ]);
    expect(d.ImmutableAssets!.Properties as any).toMatchObject({
      Exclude: ['*'],
      Include: ['assets/*'],
    });
  });

  it('sólo la última publicación (index.html) invalida CloudFront y depende de todas las demás', () => {
    const d = deployments(prod.json);
    expect((d.Shell!.Properties as any).DistributionId).toBeDefined();
    expect((d.Shell!.Properties as any).DistributionPaths).toEqual(['/*']);
    for (const [name, resource] of Object.entries(d)) {
      if (name !== 'Shell') expect((resource.Properties as any).DistributionId).toBeUndefined();
    }
    const dependsOn = ([] as string[]).concat(d.Shell!.DependsOn ?? []);
    expect(dependsOn.length).toBeGreaterThanOrEqual(4);
  });

  it('los .map no se publican por defecto (sólo con publishSourceMaps)', () => {
    const stagedFiles = (input: typeof STAGING): string[] => {
      // Aquí SÍ se copian los activos (sin 'disable-asset-staging') para inspeccionar el contenido real que se subiría.
      const app = new App({ outdir: mkdtempSync(join(tmpdir(), 'fitroom-assets-')) });
      makeStack(input, app);
      const outdir = app.synth().directory;
      return readdirSync(outdir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
    };
    expect(stagedFiles(STAGING).filter((f) => f.endsWith('.js'))).toContain('index-4f2a1c9e.js');
    expect(stagedFiles(STAGING).filter((f) => f.endsWith('.map'))).toEqual([]);
    expect(
      stagedFiles({ ...STAGING, publishSourceMaps: true }).filter((f) => f.endsWith('.map')),
    ).toEqual(['index-4f2a1c9e.js.map']);
  });

  it('sin dist: sintetiza igualmente (sólo infraestructura) con un aviso; con requireDist falla', () => {
    const missing = '/nonexistent/fitroom-dist';
    const s = synth({ ...STAGING, webDistPath: missing });
    expect(resourcesOfType(s.json, 'Custom::CDKBucketDeployment')).toHaveLength(0);
    expect(s.stack.deploysAssets).toBe(false);
    expect(
      Annotations.fromStack(s.stack).findWarning(
        '*',
        Match.stringLikeRegexp('se omite la publicación'),
      ),
    ).toHaveLength(1);
    expect(() => makeStack({ ...STAGING, webDistPath: missing, requireDist: true })).toThrow(
      /se omite la publicación/,
    );
  });
});

describe('WAFv2', () => {
  it('prod: Web ACL de ámbito CLOUDFRONT con reglas gestionadas + límite de tasa, asociada a la distribución', () => {
    prod.template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'CLOUDFRONT',
      DefaultAction: { Allow: {} },
      Rules: [
        Match.objectLike({
          Name: 'AWSManagedRulesCommonRuleSet',
          Priority: 10,
          OverrideAction: { None: {} },
        }),
        Match.objectLike({ Name: 'AWSManagedRulesKnownBadInputsRuleSet', Priority: 20 }),
        Match.objectLike({ Name: 'AWSManagedRulesAmazonIpReputationList', Priority: 30 }),
        Match.objectLike({
          Name: 'RateLimitPerIp',
          Priority: 40,
          Action: { Block: {} },
          Statement: {
            RateBasedStatement: { Limit: 2000, AggregateKeyType: 'IP', EvaluationWindowSec: 300 },
          },
        }),
      ],
    });
    prod.template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ WebACLId: Match.anyValue() }),
    });
  });

  it('las reglas gestionadas son de AWS y todas tienen métricas', () => {
    const [, acl] = resourcesOfType(prod.json, 'AWS::WAFv2::WebACL')[0]!;
    const rules = (acl.Properties as any).Rules as any[];
    for (const rule of rules.filter((r) => r.Statement.ManagedRuleGroupStatement)) {
      expect(rule.Statement.ManagedRuleGroupStatement.VendorName).toBe('AWS');
    }
    for (const rule of rules) expect(rule.VisibilityConfig.CloudWatchMetricsEnabled).toBe(true);
  });

  it('staging: sin WAF por coste, pero se puede activar y el límite es configurable', () => {
    expect(resourcesOfType(staging.json, 'AWS::WAFv2::WebACL')).toHaveLength(0);
    const withWaf = synth({ ...STAGING, enableWaf: true, wafRateLimitPer5Min: 500 });
    withWaf.template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({ Statement: { RateBasedStatement: Match.objectLike({ Limit: 500 }) } }),
      ]),
    });
  });

  it('prod puede desactivar WAF explícitamente (queda registrado el motivo en cdk-nag)', () => {
    const noWaf = synth({ ...PROD, enableWaf: false });
    expect(resourcesOfType(noWaf.json, 'AWS::WAFv2::WebACL')).toHaveLength(0);
    expect(noWaf.stack.acknowledgements.map((a) => a.id)).toContain('AwsSolutions-CFR2');
  });
});

describe('protección frente a borrados accidentales', () => {
  it('prod: buckets RETAIN, sin autoDeleteObjects, con protección contra terminación', () => {
    for (const { json, stack } of [prod, full]) {
      expect(stack.terminationProtection).toBe(true);
      expect(resourcesOfType(json, 'Custom::S3AutoDeleteObjects')).toHaveLength(0);
      for (const [, bucket] of resourcesOfType(json, 'AWS::S3::Bucket')) {
        expect(bucket.DeletionPolicy).toBe('Retain');
        expect(bucket.UpdateReplacePolicy).toBe('Retain');
      }
    }
  });

  it('prod: ningún recurso con estado tiene DeletionPolicy=Delete (las únicas excepciones son las Custom Resources de publicación)', () => {
    for (const { json } of [prod, full]) {
      const deletable = Object.entries(json.Resources)
        .filter(([, r]) => r.DeletionPolicy === 'Delete' || r.UpdateReplacePolicy === 'Delete')
        .map(([, r]) => r.Type);
      expect(new Set(deletable)).toEqual(new Set(['Custom::CDKBucketDeployment']));
      const stateful = ['AWS::S3::Bucket', 'AWS::KMS::Key', 'AWS::Logs::LogGroup'];
      for (const [, resource] of Object.entries(json.Resources).filter(([, r]) =>
        stateful.includes(r.Type),
      )) {
        expect(resource.DeletionPolicy ?? 'Delete').not.toBe('Delete');
      }
    }
  });

  it('prod: la publicación NO borra el contenido si se elimina el stack (RetainOnDelete)', () => {
    for (const [, resource] of resourcesOfType(prod.json, 'Custom::CDKBucketDeployment')) {
      expect((resource.Properties as any).RetainOnDelete).not.toBe(false);
    }
  });

  it('staging: borrable y autolimpiable (coste cero al descartar el entorno), sin protección de terminación', () => {
    expect(staging.stack.terminationProtection).toBe(false);
    expect(resourcesOfType(staging.json, 'Custom::S3AutoDeleteObjects').length).toBeGreaterThan(0);
    for (const [, bucket] of resourcesOfType(staging.json, 'AWS::S3::Bucket'))
      expect(bucket.DeletionPolicy).toBe('Delete');
  });
});

describe('dominio personalizado', () => {
  it('con zona: certificado ACM validado por DNS + alias A y AAAA hacia CloudFront', () => {
    prod.template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'probador.example.com',
      ValidationMethod: 'DNS',
      DomainValidationOptions: [Match.objectLike({ HostedZoneId: FAKE_ZONE_ID })],
    });
    prod.template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'A',
      Name: 'probador.example.com.',
      AliasTarget: Match.anyValue(),
    });
    prod.template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'AAAA',
      Name: 'probador.example.com.',
      AliasTarget: Match.anyValue(),
    });
  });

  it('con certificateArn existente no crea certificado; con zona sí crea alias', () => {
    const imported = synth({ ...PROD, certificateArn: FAKE_CERT_ARN });
    expect(resourcesOfType(imported.json, 'AWS::CertificateManager::Certificate')).toHaveLength(0);
    imported.template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        ViewerCertificate: Match.objectLike({ AcmCertificateArn: FAKE_CERT_ARN }),
      }),
    });
    expect(resourcesOfType(imported.json, 'AWS::Route53::RecordSet')).toHaveLength(2);
  });

  it('sólo certificado (DNS gestionado fuera): sin registros Route53', () => {
    const external = synth({
      stage: 'prod',
      webDistPath: FIXTURE_DIST,
      domainName: 'probador.example.com',
      certificateArn: FAKE_CERT_ARN,
    });
    expect(resourcesOfType(external.json, 'AWS::Route53::RecordSet')).toHaveLength(0);
  });

  it('subdominio dentro de una zona apex', () => {
    const sub = synth({ ...PROD, hostedZoneName: 'example.com' });
    sub.template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'A',
      Name: 'probador.example.com.',
    });
  });

  it('la región de despliegue debe ser us-east-1', () => {
    expect(
      () =>
        new FitroomWebStack(makeApp(), 'X', {
          ...STAGING,
          env: { account: '111111111111', region: 'eu-west-1' },
        }),
    ).toThrow(/us-east-1/);
  });
});

describe('observabilidad y costes', () => {
  it('alarma de tasa de 5xx de CloudFront (siempre)', () => {
    for (const { template } of [staging, prod]) {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: 'AWS/CloudFront',
        MetricName: '5xxErrorRate',
        Threshold: 5,
        EvaluationPeriods: 3,
        DatapointsToAlarm: 2,
        Period: 300,
        TreatMissingData: 'notBreaching',
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
        Dimensions: [
          Match.objectLike({ Name: 'DistributionId' }),
          { Name: 'Region', Value: 'Global' },
        ],
      });
    }
  });

  it('sin email no hay SNS, KMS ni presupuesto (cero coste extra)', () => {
    for (const { json } of [staging, prod]) {
      expect(resourcesOfType(json, 'AWS::SNS::Topic')).toHaveLength(0);
      expect(resourcesOfType(json, 'AWS::KMS::Key')).toHaveLength(0);
      expect(resourcesOfType(json, 'AWS::Budgets::Budget')).toHaveLength(0);
    }
  });

  it('con email: tema SNS cifrado con CMK rotada, sólo TLS, y la alarma publica en él', () => {
    full.template.hasResourceProperties(
      'AWS::KMS::Key',
      Match.objectLike({ EnableKeyRotation: true }),
    );
    full.template.hasResourceProperties(
      'AWS::SNS::Topic',
      Match.objectLike({ KmsMasterKeyId: Match.anyValue() }),
    );
    full.template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'ops@example.com',
    });
    full.template.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      }),
    });
    full.template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmActions: [Match.anyValue()],
      OKActions: [Match.anyValue()],
    });
    full.template.hasResourceProperties('AWS::KMS::Key', {
      KeyPolicy: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AllowCloudWatchAlarmsToPublish',
            Principal: { Service: 'cloudwatch.amazonaws.com' },
          }),
        ]),
      }),
    });
  });

  it('presupuesto mensual opcional con avisos real 80 % y previsto 100 % (+ filtro por etiqueta)', () => {
    full.template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: 25, Unit: 'USD' },
        CostFilters: { TagKeyValue: ['user:Project$fitroom'] },
      }),
      NotificationsWithSubscribers: [
        Match.objectLike({
          Notification: Match.objectLike({ NotificationType: 'ACTUAL', Threshold: 80 }),
        }),
        Match.objectLike({
          Notification: Match.objectLike({ NotificationType: 'FORECASTED', Threshold: 100 }),
        }),
      ],
    });
  });

  it('etiquetas de coste en el stack y los recursos', () => {
    prod.template.hasResourceProperties('AWS::S3::Bucket', {
      Tags: Match.arrayWith([
        { Key: 'ManagedBy', Value: 'cdk' },
        { Key: 'Project', Value: 'fitroom' },
        { Key: 'Stage', Value: 'prod' },
      ]),
    });
    const extra = synth({ ...STAGING, extraTags: { CostCenter: 'probador' } });
    extra.template.hasResourceProperties('AWS::S3::Bucket', {
      Tags: Match.arrayWith([{ Key: 'CostCenter', Value: 'probador' }]),
    });
  });
});

describe('registros de acceso y privacidad', () => {
  it('CloudFront registra sin cookies, con prefijo propio, y los logs caducan (30 días en prod, 14 en staging)', () => {
    prod.template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Logging: Match.objectLike({ IncludeCookies: false, Prefix: 'cloudfront/' }),
      }),
    });
    const logsRule = (json: TemplateJson) => {
      const logs = resourcesOfType(json, 'AWS::S3::Bucket').find(([id]) =>
        id.startsWith('LogsBucket'),
      )!;
      return (logs[1].Properties as any).LifecycleConfiguration.Rules[0];
    };
    expect(logsRule(prod.json)).toMatchObject({ ExpirationInDays: 30, Status: 'Enabled' });
    expect(logsRule(staging.json)).toMatchObject({ ExpirationInDays: 14 });
  });

  it('el bucket de logs admite ACL (requisito de CloudFront) pero sigue siendo privado', () => {
    const logs = resourcesOfType(prod.json, 'AWS::S3::Bucket').find(([id]) =>
      id.startsWith('LogsBucket'),
    )!;
    expect((logs[1].Properties as any).OwnershipControls.Rules[0].ObjectOwnership).toBe(
      'BucketOwnerPreferred',
    );
    expect((logs[1].Properties as any).PublicAccessBlockConfiguration.BlockPublicAcls).toBe(true);
  });

  it('se puede desactivar el registro de CloudFront (sin IPs almacenadas)', () => {
    const off = synth({ ...STAGING, enableAccessLogs: false });
    const [, dist] = resourcesOfType(off.json, 'AWS::CloudFront::Distribution')[0]!;
    expect((dist.Properties as any).DistributionConfig.Logging).toBeUndefined();
  });
});

describe('salidas y plantilla', () => {
  it('exporta URL, id de distribución y bucket', () => {
    for (const { json } of [staging, prod]) {
      expect(Object.keys(json.Outputs ?? {})).toEqual(
        expect.arrayContaining([
          'SiteUrl',
          'DistributionDomainName',
          'DistributionId',
          'BucketName',
          'LogsBucketName',
        ]),
      );
    }
    expect((prod.json.Outputs as any).SiteUrl.Value).toBe('https://probador.example.com');
    expect(Object.keys(prod.json.Outputs ?? {})).toContain('WebAclArn');
    expect(Object.keys(staging.json.Outputs ?? {})).not.toContain('WebAclArn');
  });

  it('el stack se llama fitroom-web-<stage>', () => {
    expect(staging.stack.stackName).toBe('fitroom-web-staging');
    expect(prod.stack.stackName).toBe('fitroom-web-prod');
  });

  it('todas las cadenas enviadas a AWS son ASCII (CloudFormation valida patrones estrictos en descripciones)', () => {
    for (const { json } of [staging, prod, full]) {
      const offenders = JSON.stringify(json).match(/[^ -~]+/g);
      expect(offenders).toBeNull();
    }
  });
});
