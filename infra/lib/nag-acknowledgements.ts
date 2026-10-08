/**
 * Reconocimientos («supresiones») de cdk-nag, MÍNIMOS y justificados por escrito.
 *
 * Política: cada hallazgo se reconoce individualmente (cdk-nag v3 no admite prefijos), sólo sobre el
 * constructo afectado, y sólo si la condición que lo causa se da de verdad en esta configuración. Si algún día
 * el motivo deja de ser cierto (p. ej. se activa WAF), el reconocimiento correspondiente deja de añadirse y
 * cdk-nag volverá a exigir cumplimiento. El resto de reglas AwsSolutions (S1, S2, S10, CFR3, CFR5, CFR7, SNS2/3,
 * KMS5…) se CUMPLEN sin excepción.
 *
 * El test `test/nag.test.ts` vuelve a ejecutar cdk-nag sobre staging y prod y falla si aparece algo nuevo.
 */
import { DefaultStackSynthesizer, Token, Validations, type Stack } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';
import type { FitroomWebConfig } from './config';

/** Lista de reconocimientos aplicados (para que los tests y la documentación no se desincronicen del código). */
export interface AppliedAcknowledgement {
  readonly path: string;
  readonly id: string;
  readonly reason: string;
}

function ack(
  applied: AppliedAcknowledgement[],
  target: IConstruct,
  id: string,
  reason: string,
): void {
  Validations.of(target).acknowledge({ id: `AwsSolutions::${id}`, reason });
  applied.push({ path: target.node.path, id, reason });
}

export function acknowledgeKnownFindings(
  stack: Stack,
  config: FitroomWebConfig,
): AppliedAcknowledgement[] {
  const applied: AppliedAcknowledgement[] = [];

  // ── 1. Proveedor `BucketDeployment` (singleton de CDK: Lambda + rol) ───────────────────────────
  // No es código ni política nuestra: la genera aws-cdk-lib. Sólo se reconoce lo que no podemos cambiar desde aquí.
  const deployment = stack.node.children.find((child) =>
    child.node.id.startsWith('Custom::CDKBucketDeployment'),
  );
  if (deployment) {
    ack(
      applied,
      deployment,
      'AwsSolutions-L1',
      'Lambda singleton interna de aws-cdk-lib (BucketDeployment) con runtime Python fijado por la versión de CDK; ' +
        'no es configurable por el usuario y se actualiza al subir aws-cdk-lib (Dependabot agrupa CDK).',
    );
    ack(
      applied,
      deployment,
      'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
      'Rol de la Lambda interna de BucketDeployment: AWSLambdaBasicExecutionRole sólo concede escribir sus propios logs en CloudWatch.',
    );
    const wildcardActions = [
      'Action::s3:GetObject*',
      'Action::s3:GetBucket*',
      'Action::s3:List*',
      'Action::s3:Abort*',
      'Action::s3:DeleteObject*',
    ];
    for (const action of wildcardActions) {
      ack(
        applied,
        deployment,
        `AwsSolutions-IAM5[${action}]`,
        'Comodín generado por CDK para `aws s3 sync --delete`: leer el activo (bucket de bootstrap) y sincronizar/podar ' +
          'el bucket del sitio. Los recursos están acotados a esos dos buckets (ver ack de Resource).',
      );
    }
    ack(
      applied,
      deployment,
      'AwsSolutions-IAM5[Resource::*]',
      'CloudFront no permite acotar por recurso las acciones de invalidación que genera BucketDeployment ' +
        '(GetInvalidation/CreateInvalidation); sólo permiten crear/consultar invalidaciones, no leer contenido.',
    );
    ack(
      applied,
      deployment,
      'AwsSolutions-IAM5[Resource::<SiteBucket397A1860.Arn>/*]',
      'Objetos del bucket del sitio: la Lambda debe escribir/podar cualquier clave de la web publicada.',
    );
    // El bucket de activos del bootstrap lleva la cuenta y la región en el nombre: se cubren las formas literal y simbólica.
    const qualifier = DefaultStackSynthesizer.DEFAULT_QUALIFIER;
    const accounts = new Set([
      '<AWS::AccountId>',
      Token.isUnresolved(stack.account) ? '' : stack.account,
    ]);
    for (const partition of ['aws', '<AWS::Partition>']) {
      for (const account of accounts) {
        if (!account) continue;
        for (const region of ['us-east-1', '<AWS::Region>']) {
          ack(
            applied,
            deployment,
            `AwsSolutions-IAM5[Resource::arn:${partition}:s3:::cdk-${qualifier}-assets-${account}-${region}/*]`,
            'Lectura del zip del activo en el bucket de bootstrap de CDK (nombre con cuenta/región); sólo lectura.',
          );
        }
      }
    }
  }

  // ── 2. CloudFront ──────────────────────────────────────────────────────────────────────────
  const distribution =
    stack.node.findChild('Distribution').node.defaultChild ?? stack.node.findChild('Distribution');
  if (config.geoAllowCountries.length === 0) {
    ack(
      applied,
      distribution,
      'AwsSolutions-CFR1',
      'Producto de audiencia global sin restricción legal por país: bloquear países excluiría a personas usuarias legítimas. ' +
        'Si se necesita, se activa con `geoAllowCountries` y este reconocimiento deja de aplicarse.',
    );
  }
  if (!config.enableWaf) {
    ack(
      applied,
      distribution,
      'AwsSolutions-CFR2',
      `WAF desactivado de forma explícita (stage=${config.stage}) para evitar ~10 USD/mes en un entorno sin tráfico real. ` +
        'El stage prod lo activa por defecto y el test de prod exige que esté presente.',
    );
  }
  if (!config.enableAccessLogs) {
    ack(
      applied,
      distribution,
      'AwsSolutions-CFR3',
      'Registros de acceso de CloudFront desactivados de forma explícita (enableAccessLogs=false) para no almacenar IPs de ' +
        'visitantes (privacidad por diseño). Por defecto están activos con retención de 14-30 días.',
    );
  }
  if (!config.domainName) {
    ack(
      applied,
      distribution,
      'AwsSolutions-CFR4',
      'Sin dominio propio CloudFront sirve el certificado *.cloudfront.net, cuya política TLS está fijada a TLSv1 y no se puede ' +
        'cambiar. Sólo se admite en staging: la configuración de prod exige domainName (TLSv1.2_2021 como mínimo).',
    );
  }
  return applied;
}
