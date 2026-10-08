import { App, RemovalPolicy, Validations } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { AwsSolutionsChecks } from 'cdk-nag';
import { Stack } from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import type { FitroomWebConfigInput } from '../lib/config';
import {
  FAKE_CERT_ARN,
  FIXTURE_DIST,
  PROD,
  PROD_FULL,
  STAGING,
  makeApp,
  makeStack,
  synth,
} from './helpers';

/** Escenarios que cubren cada rama condicional del stack (y de sus reconocimientos de cdk-nag). */
const SCENARIOS: Record<string, FitroomWebConfigInput> = {
  staging: STAGING,
  'staging con WAF': { ...STAGING, enableWaf: true },
  'staging sin registros de acceso': { ...STAGING, enableAccessLogs: false },
  'staging con alarmas y presupuesto': {
    ...STAGING,
    alarmEmail: 'ops@example.com',
    monthlyBudgetUsd: 10,
  },
  prod: PROD,
  'prod con todas las opciones': PROD_FULL,
  'prod sin WAF': { ...PROD, enableWaf: false },
  'prod con certificado importado': { ...PROD, certificateArn: FAKE_CERT_ARN },
  'prod sólo certificado (DNS externo)': {
    stage: 'prod',
    webDistPath: FIXTURE_DIST,
    domainName: 'probador.example.com',
    certificateArn: FAKE_CERT_ARN,
  },
  'prod con restricción geográfica': { ...PROD, geoAllowCountries: ['ES'] },
  'staging sin dist (sólo infraestructura)': {
    ...STAGING,
    webDistPath: '/nonexistent/fitroom-dist',
  },
};

describe('cdk-nag (AwsSolutionsChecks): sin hallazgos sin justificar', () => {
  it.each(Object.entries(SCENARIOS))('%s', (_name, input) => {
    const app = makeApp();
    makeStack(input, app);
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
    expect(() => app.synth()).not.toThrow();
  });

  it('CONTROL NEGATIVO: el comprobador está activo (un bucket inseguro hace fallar la síntesis)', () => {
    const app = new App({ context: { 'aws:cdk:disable-asset-staging': true } });
    const stack = new Stack(app, 'Malo', { env: { account: '111111111111', region: 'us-east-1' } });
    new s3.Bucket(stack, 'Inseguro', { removalPolicy: RemovalPolicy.DESTROY });
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
    expect(() => app.synth()).toThrow();
  });

  it('CONTROL NEGATIVO: quitar un reconocimiento justificado vuelve a hacer fallar a cdk-nag', () => {
    // Sin dominio propio en prod (permitido sólo con el interruptor) CFR4 aparece y está reconocido; el mismo
    // stack en producción «normal» no lo reconoce porque no lo necesita.
    const withDefaultCert = synth({
      stage: 'prod',
      webDistPath: FIXTURE_DIST,
      allowDefaultDomainInProd: true,
    });
    expect(withDefaultCert.stack.acknowledgements.map((a) => a.id)).toContain('AwsSolutions-CFR4');
    expect(synth(PROD).stack.acknowledgements.map((a) => a.id)).not.toContain('AwsSolutions-CFR4');
  });
});

describe('reconocimientos (supresiones) de cdk-nag', () => {
  const ids = (input: FitroomWebConfigInput) =>
    synth(input).stack.acknowledgements.map((a) => a.id);

  it('cada uno lleva un motivo real (no vacío ni genérico)', () => {
    for (const input of Object.values(SCENARIOS)) {
      for (const ack of synth(input).stack.acknowledgements) {
        expect(ack.reason.length, `${ack.id} → ${ack.reason}`).toBeGreaterThan(60);
        expect(ack.reason).not.toMatch(/^(n\/a|todo|ninguno|test)/i);
      }
    }
  });

  it('prod bien configurado sólo reconoce lo que es propio de la Lambda interna de CDK (BucketDeployment)', () => {
    const list = ids(PROD);
    // Nada de CloudFront: WAF activo, TLS 1.2+ con dominio propio, registros activos y sin restricción geográfica = sólo CFR1.
    expect(list.filter((id) => id.startsWith('AwsSolutions-CFR'))).toEqual(['AwsSolutions-CFR1']);
    expect(
      list.filter(
        (id) =>
          !id.startsWith('AwsSolutions-CFR') &&
          !id.startsWith('AwsSolutions-IAM') &&
          id !== 'AwsSolutions-L1',
      ),
    ).toEqual([]);
  });

  it('con restricción geográfica CFR1 deja de reconocerse', () => {
    expect(ids({ ...PROD, geoAllowCountries: ['ES'] })).not.toContain('AwsSolutions-CFR1');
  });

  it('CFR2 (WAF) y CFR3 (logs) sólo se reconocen cuando se desactivan explícitamente', () => {
    expect(ids(PROD)).not.toContain('AwsSolutions-CFR2');
    expect(ids(STAGING)).toContain('AwsSolutions-CFR2');
    expect(ids({ ...STAGING, enableWaf: true })).not.toContain('AwsSolutions-CFR2');
    expect(ids(STAGING)).not.toContain('AwsSolutions-CFR3');
    expect(ids({ ...STAGING, enableAccessLogs: false })).toContain('AwsSolutions-CFR3');
  });

  it('el número de reconocimientos es pequeño y está acotado', () => {
    // 1 L1 + 1 IAM4 + 5 acciones IAM5 + 1 «Resource::*» + 1 bucket del sitio + variantes del bucket de bootstrap + CFR*.
    for (const input of Object.values(SCENARIOS)) {
      expect(synth(input).stack.acknowledgements.length).toBeLessThanOrEqual(24);
    }
  });
});
