import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import type { FitroomWebConfigInput } from '../lib/config';
import { FitroomWebStack } from '../lib/web-stack';

const here = dirname(fileURLToPath(import.meta.url));

/** Miniatura de `apps/web/dist` (index.html, assets con hash, wasm, modelo) usada por TODAS las pruebas. */
export const FIXTURE_DIST = resolve(here, 'fixtures/site');
export const INFRA_DIR = resolve(here, '..');
export const REPO_ROOT = resolve(here, '../..');

/** Valores ficticios: ninguna prueba toca AWS. */
export const FAKE_ACCOUNT = '111111111111';
export const FAKE_ZONE_ID = 'Z0123456789ABCDEFGHIJ';
export const FAKE_CERT_ARN = `arn:aws:acm:us-east-1:${FAKE_ACCOUNT}:certificate/12345678-1234-1234-1234-123456789012`;

export const STAGING: FitroomWebConfigInput = { stage: 'staging', webDistPath: FIXTURE_DIST };
export const PROD: FitroomWebConfigInput = {
  stage: 'prod',
  webDistPath: FIXTURE_DIST,
  domainName: 'probador.example.com',
  hostedZoneId: FAKE_ZONE_ID,
};
/** Prod con TODAS las opciones opcionales activas (peor caso para cdk-nag y para el snapshot). */
export const PROD_FULL: FitroomWebConfigInput = {
  ...PROD,
  alarmEmail: 'ops@example.com',
  monthlyBudgetUsd: 25,
  budgetFilterByProjectTag: true,
  hstsPreload: true,
  geoAllowCountries: ['ES', 'MX'],
};

export function makeApp(): App {
  return new App({
    outdir: mkdtempSync(join(tmpdir(), 'fitroom-cdk-')),
    context: {
      // Sin copiar los ~60 MB de la capa de aws-cli a cada síntesis: acelera las pruebas.
      'aws:cdk:disable-asset-staging': true,
      '@aws-cdk/core:target-partitions': ['aws'],
    },
  });
}

export function makeStack(input: FitroomWebConfigInput, app: App = makeApp()): FitroomWebStack {
  return new FitroomWebStack(app, `FitroomWeb-${input.stage ?? 'staging'}`, {
    ...input,
    env: { account: FAKE_ACCOUNT, region: 'us-east-1' },
  });
}

export function synth(input: FitroomWebConfigInput): {
  stack: FitroomWebStack;
  template: Template;
  json: TemplateJson;
} {
  const stack = makeStack(input);
  const template = Template.fromStack(stack);
  return { stack, template, json: template.toJSON() as TemplateJson };
}

export interface TemplateResource {
  readonly Type: string;
  readonly Properties?: Record<string, unknown>;
  readonly DeletionPolicy?: string;
  readonly UpdateReplacePolicy?: string;
  readonly DependsOn?: string | string[];
}
export interface TemplateJson {
  readonly Resources: Record<string, TemplateResource>;
  readonly Outputs?: Record<string, { Value: unknown }>;
}

export function resourcesOfType(json: TemplateJson, type: string): [string, TemplateResource][] {
  return Object.entries(json.Resources).filter(([, resource]) => resource.Type === type);
}
