/**
 * Ensambla la aplicación CDK: lee la configuración (contexto `-c` + variables `FITROOM_*`), crea el stack del stage
 * y activa cdk-nag. Separado de `bin/fitroom.ts` para poder probarlo sin lanzar el CLI.
 */
import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { EDGE_REGION, inputFromEnvironment, resolveConfig } from './config';
import { FitroomWebStack } from './web-stack';

export interface BuildAppOptions {
  /** Contexto adicional (equivale a `-c clave=valor`). */
  readonly context?: Record<string, unknown>;
  /** Entorno de procesos; por defecto `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly outdir?: string;
}

export function buildApp(options: BuildAppOptions = {}): App {
  const env = options.env ?? process.env;
  const app = new App({ context: options.context, outdir: options.outdir });
  const input = inputFromEnvironment((key) => app.node.tryGetContext(key), env);
  const config = resolveConfig(input);
  // La cuenta: contexto explícito > CLI/entorno. Sin cuenta, el stack es agnóstico del entorno (síntesis sin credenciales).
  const account =
    (app.node.tryGetContext('account') as string | undefined) ?? env.CDK_DEFAULT_ACCOUNT;

  new FitroomWebStack(app, `FitroomWeb-${config.stage}`, {
    ...input,
    env: { account, region: EDGE_REGION },
  });

  // cdk-nag (reglas AWS Solutions): cualquier infracción no justificada interrumpe `cdk synth`.
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  return app;
}
