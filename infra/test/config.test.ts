import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_WEB_DIST_PATH,
  envNameFor,
  inputFromEnvironment,
  resolveConfig,
} from '../lib/config';
import { FAKE_CERT_ARN, FAKE_ZONE_ID } from './helpers';

describe('resolveConfig: valores por defecto por stage', () => {
  it('staging: barato (sin WAF, PriceClass_100, borrable, logs 14 días)', () => {
    const c = resolveConfig({ stage: 'staging' });
    expect(c).toMatchObject({
      stage: 'staging',
      enableWaf: false,
      priceClass: 'PriceClass_100',
      removalPolicy: 'destroy',
      logRetentionDays: 14,
      noncurrentVersionRetentionDays: 30,
      hstsPreload: false,
      strictStyleSrc: false,
      enableAccessLogs: true,
      publishSourceMaps: false,
      requireDist: false,
    });
    expect(c.webDistPath).toBe(DEFAULT_WEB_DIST_PATH);
  });

  it('prod: WAF, PriceClass_All, RETAIN, logs 30 días, versiones 90 días', () => {
    const c = resolveConfig({
      stage: 'prod',
      domainName: 'App.Example.com',
      hostedZoneId: FAKE_ZONE_ID,
    });
    expect(c).toMatchObject({
      enableWaf: true,
      priceClass: 'PriceClass_All',
      removalPolicy: 'retain',
      logRetentionDays: 30,
      noncurrentVersionRetentionDays: 90,
      domainName: 'app.example.com',
      hostedZoneName: 'app.example.com',
    });
  });

  it('el stage por defecto es staging y se puede forzar WAF en staging', () => {
    expect(resolveConfig().stage).toBe('staging');
    expect(resolveConfig({ enableWaf: true }).enableWaf).toBe(true);
  });
});

describe('resolveConfig: validaciones', () => {
  const bad: [string, Parameters<typeof resolveConfig>[0], RegExp][] = [
    ['prod sin dominio', { stage: 'prod' }, /prod exige domainName/],
    [
      'prod destruible',
      {
        stage: 'prod',
        domainName: 'a.example.com',
        certificateArn: FAKE_CERT_ARN,
        removalPolicy: 'destroy',
      },
      /prod no admite/,
    ],
    ['stage desconocido', { stage: 'dev' as never }, /stage debe ser/],
    [
      'dominio inválido',
      { domainName: 'no es un dominio', certificateArn: FAKE_CERT_ARN },
      /host válido/,
    ],
    ['dominio sin zona ni certificado', { domainName: 'a.example.com' }, /requiere hostedZoneId/],
    ['zona sin dominio', { hostedZoneId: FAKE_ZONE_ID }, /requieren domainName/],
    ['id de zona inválido', { domainName: 'a.example.com', hostedZoneId: 'abc' }, /id de zona/],
    [
      'certificado de otra región',
      {
        domainName: 'a.example.com',
        certificateArn: FAKE_CERT_ARN.replace('us-east-1', 'eu-west-1'),
      },
      /us-east-1/,
    ],
    [
      'dominio fuera de la zona',
      { domainName: 'a.example.com', hostedZoneId: FAKE_ZONE_ID, hostedZoneName: 'otra.org' },
      /debe pertenecer/,
    ],
    ['límite de tasa bajo', { wafRateLimitPer5Min: 5 }, /wafRateLimitPer5Min/],
    ['retención de logs 0', { logRetentionDays: 0 }, /logRetentionDays/],
    ['umbral 5xx fuera de rango', { error5xxThresholdPercent: 0 }, /error5xxThresholdPercent/],
    ['email inválido', { alarmEmail: 'no-es-email' }, /alarmEmail/],
    ['presupuesto sin email', { monthlyBudgetUsd: 10 }, /requiere alarmEmail/],
    ['presupuesto negativo', { monthlyBudgetUsd: -1, alarmEmail: 'a@b.co' }, /monthlyBudgetUsd/],
    ['país inválido', { geoAllowCountries: ['ESP'] }, /país inválido/],
    ['etiqueta reservada', { extraTags: { 'aws:foo': 'x' } }, /etiqueta inválida/],
  ];
  it.each(bad)('rechaza: %s', (_name, input, message) => {
    expect(() => resolveConfig(input)).toThrow(ConfigError);
    expect(() => resolveConfig(input)).toThrow(message);
  });

  it('permite prod sin dominio sólo con el interruptor explícito', () => {
    expect(
      resolveConfig({ stage: 'prod', allowDefaultDomainInProd: true }).domainName,
    ).toBeUndefined();
  });

  it('subdominio dentro de una zona apex', () => {
    const c = resolveConfig({
      domainName: 'probador.example.com',
      hostedZoneId: FAKE_ZONE_ID,
      hostedZoneName: 'example.com',
    });
    expect(c.hostedZoneName).toBe('example.com');
  });

  it('los emails de presupuesto heredan alarmEmail', () => {
    expect(
      resolveConfig({ alarmEmail: 'ops@example.com', monthlyBudgetUsd: 20 }).budgetEmails,
    ).toEqual(['ops@example.com']);
  });
});

describe('inputFromEnvironment', () => {
  it('traduce nombres a variables de entorno', () => {
    expect(envNameFor('domainName')).toBe('FITROOM_DOMAIN_NAME');
    expect(envNameFor('wafRateLimitPer5Min')).toBe('FITROOM_WAF_RATE_LIMIT_PER5_MIN');
    expect(envNameFor('stage')).toBe('FITROOM_STAGE');
  });

  it('el contexto gana al entorno; convierte tipos', () => {
    const input = inputFromEnvironment((k) => ({ stage: 'prod', enableWaf: 'false' })[k], {
      FITROOM_STAGE: 'staging',
      FITROOM_DOMAIN_NAME: 'probador.example.com',
      FITROOM_HOSTED_ZONE_ID: FAKE_ZONE_ID,
      FITROOM_WAF_RATE_LIMIT_PER5_MIN: '500',
      FITROOM_BUDGET_EMAILS: 'a@b.co, c@d.co',
      FITROOM_REQUIRE_DIST: 'TRUE',
    });
    expect(input).toMatchObject({
      stage: 'prod',
      enableWaf: false,
      domainName: 'probador.example.com',
      wafRateLimitPer5Min: 500,
      budgetEmails: ['a@b.co', 'c@d.co'],
      requireDist: true,
    });
    expect(Object.keys(input)).not.toContain('alarmEmail');
  });

  it('errores claros ante valores mal formados', () => {
    const none = () => undefined;
    expect(() => inputFromEnvironment(none, { FITROOM_ENABLE_WAF: 'quizá' })).toThrow(
      /true o false/,
    );
    expect(() => inputFromEnvironment(none, { FITROOM_WAF_RATE_LIMIT_PER5_MIN: 'mucho' })).toThrow(
      /numérico/,
    );
    expect(() => inputFromEnvironment(none, { FITROOM_STAGE: 'dev' })).toThrow(/stage debe ser/);
    expect(() => inputFromEnvironment(none, { FITROOM_PRICE_CLASS: 'gratis' })).toThrow(
      /priceClass/,
    );
    expect(() => inputFromEnvironment(none, { FITROOM_REMOVAL_POLICY: 'borrar' })).toThrow(
      /removalPolicy/,
    );
  });

  it('cadenas vacías equivalen a «no definido»', () => {
    expect(inputFromEnvironment(() => '', { FITROOM_STAGE: '' })).toEqual({});
  });
});
