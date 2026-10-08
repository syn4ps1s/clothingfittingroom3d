#!/usr/bin/env node
/**
 * Punto de entrada de CDK (`cdk.json` → `tsx bin/fitroom.ts`). NO ejecutar `cdk deploy` hasta que la persona dueña
 * apruebe el MVP (docs/deploy.md). Ejemplos de síntesis local, sin credenciales:
 *
 *   pnpm --filter @fitroom/infra synth                                  # staging
 *   CDK_DEFAULT_ACCOUNT=111111111111 pnpm --filter @fitroom/infra exec cdk synth \
 *     -c stage=prod -c domainName=probador.example.com -c hostedZoneId=Z0123456789ABCDEFGHIJ
 */
import { buildApp } from '../lib/app';

buildApp();
