#!/usr/bin/env node
/**
 * Smoke test post-despliegue (y local). Ejemplos:
 *   pnpm --filter @fitroom/infra smoke -- --url http://127.0.0.1:4180 --dist ../apps/web/dist
 *   pnpm --filter @fitroom/infra smoke -- --outputs cdk-outputs.json --stage prod --dist ../apps/web/dist
 * Sale con código 1 si falta alguna cabecera de seguridad o algún metadato no coincide.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatSmokeResult, runSmokeTests } from '../lib/smoke';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function urlFromOutputs(file: string, stage: string): string {
  const outputs = JSON.parse(readFileSync(resolve(file), 'utf8')) as Record<
    string,
    Record<string, string>
  >;
  const url = outputs[`FitroomWeb-${stage}`]?.SiteUrl;
  if (!url) throw new Error(`No hay SiteUrl para FitroomWeb-${stage} en ${file}`);
  return url;
}

async function main(): Promise<void> {
  const stage = arg('stage') ?? 'staging';
  const outputsFile = arg('outputs');
  const url =
    arg('url') ??
    process.env.SMOKE_URL ??
    (outputsFile ? urlFromOutputs(outputsFile, stage) : undefined);
  if (!url)
    throw new Error(
      'Indica --url, SMOKE_URL o --outputs <cdk-outputs.json> --stage <staging|prod>',
    );
  const dist = arg('dist');
  console.log(`Smoke test de ${url}${dist ? ` (dist: ${resolve(dist)})` : ''}`);
  const result = await runSmokeTests({
    baseUrl: url,
    distDir: dist ? resolve(dist) : undefined,
    hstsPreload: process.env.FITROOM_HSTS_PRELOAD === 'true',
    strictStyles: process.env.FITROOM_STRICT_STYLE_SRC === 'true',
  });
  console.log(formatSmokeResult(result));
  process.exit(result.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
