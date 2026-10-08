import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../lib/config';
import { buildApp } from '../lib/app';
import { FAKE_ACCOUNT, FAKE_ZONE_ID, FIXTURE_DIST } from './helpers';

const outdir = () => mkdtempSync(join(tmpdir(), 'fitroom-app-'));
const base = { 'aws:cdk:disable-asset-staging': true, webDistPath: FIXTURE_DIST };

describe('buildApp (lo que ejecuta `cdk synth`)', () => {
  it('staging por defecto, con cdk-nag activo y región us-east-1', () => {
    const app = buildApp({
      context: base,
      env: { CDK_DEFAULT_ACCOUNT: FAKE_ACCOUNT },
      outdir: outdir(),
    });
    const assembly = app.synth(); // cdk-nag lanzaría aquí si hubiese hallazgos sin justificar
    const stack = assembly.getStackByName('fitroom-web-staging');
    expect(stack.environment).toMatchObject({ account: FAKE_ACCOUNT, region: 'us-east-1' });
  });

  it('el contexto -c gana al entorno; el stage prod exige dominio', () => {
    expect(() =>
      buildApp({ context: { ...base, stage: 'prod' }, env: {}, outdir: outdir() }),
    ).toThrow(ConfigError);
    const app = buildApp({
      context: {
        ...base,
        stage: 'prod',
        domainName: 'probador.example.com',
        hostedZoneId: FAKE_ZONE_ID,
      },
      env: { FITROOM_STAGE: 'staging' },
      outdir: outdir(),
    });
    expect(app.synth().stacks.map((s) => s.stackName)).toEqual(['fitroom-web-prod']);
  });

  it('configura todo desde variables FITROOM_* (así lo hace deploy.yml, sin interpolar en shell)', () => {
    const app = buildApp({
      context: { 'aws:cdk:disable-asset-staging': true },
      env: {
        FITROOM_STAGE: 'prod',
        FITROOM_DOMAIN_NAME: 'probador.example.com',
        FITROOM_HOSTED_ZONE_ID: FAKE_ZONE_ID,
        FITROOM_WEB_DIST_PATH: FIXTURE_DIST,
        FITROOM_ALARM_EMAIL: 'ops@example.com',
        FITROOM_MONTHLY_BUDGET_USD: '30',
        FITROOM_STRICT_STYLE_SRC: 'true',
        FITROOM_REQUIRE_DIST: 'true',
        CDK_DEFAULT_ACCOUNT: FAKE_ACCOUNT,
      },
      outdir: outdir(),
    });
    const template = app.synth().getStackByName('fitroom-web-prod').template as {
      Resources: Record<string, { Type: string }>;
    };
    const types = Object.values(template.Resources).map((r) => r.Type);
    expect(types).toEqual(
      expect.arrayContaining(['AWS::WAFv2::WebACL', 'AWS::Budgets::Budget', 'AWS::SNS::Topic']),
    );
  });

  it('sin cuenta (síntesis sin credenciales) el stack sigue sintetizando', () => {
    const app = buildApp({ context: base, env: {}, outdir: outdir() });
    expect(() => app.synth()).not.toThrow();
  });
});
