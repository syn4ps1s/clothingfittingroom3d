/**
 * `FitroomWebStack`: hosting estático privado y endurecido para la SPA del Probador 3D.
 *
 *   Usuario ──HTTPS(TLS≥1.2, HTTP/2+3)──▶ CloudFront ──OAC(SigV4)──▶ S3 privado (versionado, SSE-S3, sólo SSL)
 *                                           │  ├─ ResponseHeadersPolicy (CSP estricta, HSTS, Permissions-Policy…)
 *                                           │  ├─ WAFv2 (reglas gestionadas + límite de tasa)   [opcional]
 *                                           │  └─ logs de acceso → bucket de logs (retención corta)
 *                                           └─ alarmas CloudWatch (5xx) → SNS cifrado [opcional]
 *
 * Principios (docs/ENGINEERING.md §1): privacidad por diseño (nada de terceros, registros con retención corta),
 * todo del mismo origen, mínimo privilegio. NO se despliega nada hasta que la persona dueña apruebe el MVP:
 * este stack sólo se sintetiza/prueba en local hasta entonces (ver docs/deploy.md).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  Annotations,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Size,
  Stack,
  type StackProps,
  Tags,
  Token,
} from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import {
  ASSET_CLASSES,
  CACHE_IMMUTABLE,
  EDGE_PATH_PATTERNS,
  SHELL_CLASS,
  shellExcludePatterns,
  type AssetClass,
} from './asset-policy';
import {
  EDGE_REGION,
  resolveConfig,
  type FitroomWebConfig,
  type FitroomWebConfigInput,
} from './config';
import { acknowledgeKnownFindings, type AppliedAcknowledgement } from './nag-acknowledgements';
import {
  HSTS_MAX_AGE_SECONDS,
  PERMISSIONS_POLICY,
  buildCsp,
  cspDirectivesFor,
} from './security-headers';

export interface FitroomWebStackProps extends StackProps, FitroomWebConfigInput {}

const PRICE_CLASS_MAP: Record<FitroomWebConfig['priceClass'], cloudfront.PriceClass> = {
  PriceClass_100: cloudfront.PriceClass.PRICE_CLASS_100,
  PriceClass_200: cloudfront.PriceClass.PRICE_CLASS_200,
  PriceClass_All: cloudfront.PriceClass.PRICE_CLASS_ALL,
};

export class FitroomWebStack extends Stack {
  public readonly config: FitroomWebConfig;
  public readonly siteBucket: s3.Bucket;
  public readonly logsBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;
  public readonly responseHeadersPolicy: cloudfront.ResponseHeadersPolicy;
  public readonly webAcl?: wafv2.CfnWebACL;
  public readonly alertsTopic?: sns.Topic;
  /** `true` si se encontró `apps/web/dist` y, por tanto, se publican los archivos de la web. */
  public readonly deploysAssets: boolean;
  /** Reconocimientos de cdk-nag aplicados (id + motivo): los verifica `test/nag.test.ts` y se citan en docs/deploy.md. */
  public readonly acknowledgements: readonly AppliedAcknowledgement[];

  constructor(scope: Construct, id: string, props: FitroomWebStackProps = {}) {
    const { env, terminationProtection, description, stackName, ...configInput } = props;
    const config = resolveConfig(configInput);
    super(scope, id, {
      env,
      stackName: stackName ?? `fitroom-web-${config.stage}`,
      description:
        description ??
        `Probador 3D (${config.stage}): hosting estatico privado (S3 + CloudFront OAC + cabeceras de seguridad)`,
      // En prod la pila no se borra por accidente (los buckets además son RETAIN).
      terminationProtection: terminationProtection ?? config.stage === 'prod',
    });
    this.config = config;

    // Todo vive en us-east-1 (WAF/ACM de CloudFront). Si la región ya es conocida y es otra, mejor fallar aquí
    // que en mitad de un despliegue.
    if (!Token.isUnresolved(this.region) && this.region !== EDGE_REGION) {
      throw new Error(
        `FitroomWebStack debe desplegarse en ${EDGE_REGION} (WAF y ACM de CloudFront); región configurada: ${this.region}`,
      );
    }

    const destroyable = config.removalPolicy === 'destroy';
    const removalPolicy = destroyable ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;

    // ───────────────────────────── Etiquetas de coste ─────────────────────────────
    Tags.of(this).add('Project', 'fitroom');
    Tags.of(this).add('Stage', config.stage);
    Tags.of(this).add('ManagedBy', 'cdk');
    for (const [key, value] of Object.entries(config.extraTags)) Tags.of(this).add(key, value);

    // ───────────────────────────── Buckets ─────────────────────────────
    this.logsBucket = this.createLogsBucket(config, removalPolicy);
    this.siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      serverAccessLogsBucket: this.logsBucket,
      serverAccessLogsPrefix: 's3-access/',
      removalPolicy,
      autoDeleteObjects: destroyable,
      lifecycleRules: [
        {
          id: 'ExpireNoncurrentVersions',
          noncurrentVersionExpiration: Duration.days(config.noncurrentVersionRetentionDays),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
    });

    // ───────────────────────────── Cabeceras de seguridad ─────────────────────────────
    this.responseHeadersPolicy = this.createResponseHeadersPolicy(config);

    // ───────────────────────────── WAF (opcional) ─────────────────────────────
    if (config.enableWaf) this.webAcl = this.createWebAcl(config);

    // ───────────────────────────── Dominio y certificado (opcionales) ─────────────────────────────
    const zone = config.hostedZoneId
      ? route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
          hostedZoneId: config.hostedZoneId,
          zoneName: config.hostedZoneName ?? config.domainName ?? '',
        })
      : undefined;
    let certificate: acm.ICertificate | undefined;
    if (config.domainName) {
      certificate = config.certificateArn
        ? acm.Certificate.fromCertificateArn(this, 'Certificate', config.certificateArn)
        : new acm.Certificate(this, 'Certificate', {
            domainName: config.domainName,
            validation: acm.CertificateValidation.fromDns(zone),
          });
    }

    // ───────────────────────────── CloudFront ─────────────────────────────
    this.distribution = this.createDistribution(config, certificate);

    if (zone && config.domainName) {
      const target = route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(this.distribution),
      );
      new route53.ARecord(this, 'AliasA', { zone, recordName: config.domainName, target });
      new route53.AaaaRecord(this, 'AliasAaaa', { zone, recordName: config.domainName, target });
    }

    // ───────────────────────────── Publicación de la web ─────────────────────────────
    this.deploysAssets = this.deployAssets(config);

    // ───────────────────────────── Observabilidad y coste ─────────────────────────────
    this.alertsTopic = this.createAlarms(config, removalPolicy);
    this.createBudget(config);

    // ───────────────────────────── Salidas ─────────────────────────────
    new CfnOutput(this, 'SiteUrl', {
      description: 'URL publica de la web',
      value: config.domainName
        ? `https://${config.domainName}`
        : `https://${this.distribution.distributionDomainName}`,
    });
    new CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
    });
    new CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    new CfnOutput(this, 'BucketName', { value: this.siteBucket.bucketName });
    new CfnOutput(this, 'LogsBucketName', { value: this.logsBucket.bucketName });
    if (this.webAcl) new CfnOutput(this, 'WebAclArn', { value: this.webAcl.attrArn });

    this.acknowledgements = acknowledgeKnownFindings(this, config);
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────

  /** Bucket de logs (S3 + CloudFront). Sin versionado, cifrado SSE-S3 (el único que admite S3 como destino de logs) y expiración corta. */
  private createLogsBucket(config: FitroomWebConfig, removalPolicy: RemovalPolicy): s3.Bucket {
    return new s3.Bucket(this, 'LogsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // CloudFront (registros estándar) entrega los logs con ACL → hay que permitir ACL, pero sin acceso público.
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      removalPolicy,
      autoDeleteObjects: removalPolicy === RemovalPolicy.DESTROY,
      lifecycleRules: [
        {
          id: 'ExpireLogs',
          // Los logs de CloudFront contienen la IP del visitante (dato personal): retención mínima necesaria.
          expiration: Duration.days(config.logRetentionDays),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
    });
  }

  private createResponseHeadersPolicy(config: FitroomWebConfig): cloudfront.ResponseHeadersPolicy {
    return new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      comment: `Probador 3D (${config.stage}): cabeceras de seguridad. Fuente unica: infra/lib/security-headers.ts`,
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: buildCsp(
            cspDirectivesFor({ strictStyles: config.strictStyleSrc }),
          ),
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.seconds(HSTS_MAX_AGE_SECONDS),
          includeSubdomains: true,
          preload: config.hstsPreload,
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          { header: 'Permissions-Policy', value: PERMISSIONS_POLICY, override: true },
          { header: 'Cross-Origin-Opener-Policy', value: 'same-origin', override: true },
          { header: 'Cross-Origin-Resource-Policy', value: 'same-origin', override: true },
        ],
      },
    });
  }

  private createWebAcl(config: FitroomWebConfig): wafv2.CfnWebACL {
    const metric = (name: string): wafv2.CfnWebACL.VisibilityConfigProperty => ({
      cloudWatchMetricsEnabled: true,
      // Las muestras de WAF incluyen cabeceras/IP y se conservan 3 h: útiles para falsos positivos (ver docs/privacy.md).
      sampledRequestsEnabled: true,
      metricName: `fitroom-${config.stage}-${name}`,
    });
    const managed = (name: string, priority: number): wafv2.CfnWebACL.RuleProperty => ({
      name,
      priority,
      overrideAction: { none: {} },
      statement: { managedRuleGroupStatement: { vendorName: 'AWS', name } },
      visibilityConfig: metric(name),
    });
    return new wafv2.CfnWebACL(this, 'WebAcl', {
      name: `fitroom-${config.stage}-web`,
      description: 'Probador 3D: reglas gestionadas de AWS y limite de tasa por IP',
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: metric('web-acl'),
      rules: [
        managed('AWSManagedRulesCommonRuleSet', 10),
        managed('AWSManagedRulesKnownBadInputsRuleSet', 20),
        managed('AWSManagedRulesAmazonIpReputationList', 30),
        {
          name: 'RateLimitPerIp',
          priority: 40,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: config.wafRateLimitPer5Min,
              aggregateKeyType: 'IP',
              evaluationWindowSec: 300,
            },
          },
          visibilityConfig: metric('rate-limit-per-ip'),
        },
      ],
    });
  }

  private createCachePolicies(): Record<
    'noCache' | 'immutable' | 'revalidate',
    cloudfront.CachePolicy
  > {
    // Sin parámetros de caché de consulta/cookies/cabeceras: la web no los usa, y así se maximiza el acierto.
    const common = { enableAcceptEncodingBrotli: true, enableAcceptEncodingGzip: true };
    return {
      noCache: new cloudfront.CachePolicy(this, 'HtmlNoCache', {
        comment:
          'index.html y archivos sin hash: sin cache en el borde (el origen manda max-age=0)',
        defaultTtl: Duration.seconds(0),
        minTtl: Duration.seconds(0),
        // Un máximo > 0 es necesario para poder activar la compresión; el origen envía max-age=0, así que en la práctica es 0.
        maxTtl: Duration.seconds(60),
        ...common,
      }),
      immutable: new cloudfront.CachePolicy(this, 'ImmutableAssets', {
        comment: 'Archivos con hash de contenido (assets/*): 1 ano',
        defaultTtl: Duration.days(365),
        minTtl: Duration.days(365),
        maxTtl: Duration.days(365),
        ...common,
      }),
      revalidate: new cloudfront.CachePolicy(this, 'RevalidatedBinaries', {
        comment:
          'Modelos .task y WASM sin hash: 1 dia en el borde (s-maxage); el navegador siempre revalida',
        defaultTtl: Duration.days(1),
        minTtl: Duration.seconds(0),
        maxTtl: Duration.days(365),
        ...common,
      }),
    };
  }

  private createDistribution(
    config: FitroomWebConfig,
    certificate?: acm.ICertificate,
  ): cloudfront.Distribution {
    const policies = this.createCachePolicies();
    // Origen privado con Origin Access Control (SigV4): el bucket sólo acepta a ESTA distribución.
    const origin = origins.S3BucketOrigin.withOriginAccessControl(this.siteBucket);
    const behavior = (cachePolicy: cloudfront.ICachePolicy): cloudfront.BehaviorOptions => ({
      origin,
      cachePolicy,
      responseHeadersPolicy: this.responseHeadersPolicy,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
      compress: true,
    });
    const spaFallback = (httpStatus: number): cloudfront.ErrorResponse => ({
      httpStatus,
      responseHttpStatus: 200,
      responsePagePath: '/index.html',
      // TTL corto: tras un despliegue no queremos que un 404 transitorio quede «pegado» en el borde.
      ttl: Duration.seconds(10),
    });
    const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {};
    for (const pattern of EDGE_PATH_PATTERNS.immutable)
      additionalBehaviors[pattern] = behavior(policies.immutable);
    for (const pattern of EDGE_PATH_PATTERNS.revalidate)
      additionalBehaviors[pattern] = behavior(policies.revalidate);

    return new cloudfront.Distribution(this, 'Distribution', {
      comment: `Probador 3D (${config.stage})`,
      defaultRootObject: 'index.html',
      defaultBehavior: behavior(policies.noCache),
      additionalBehaviors,
      // SPA: S3 devuelve 403 (OAC sin ListBucket) para claves inexistentes → ambos códigos caen a index.html.
      errorResponses: [spaFallback(403), spaFallback(404)],
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      // Con el certificado por defecto (*.cloudfront.net) CloudFront ignora estos dos ajustes (TLS fijo en 1.0):
      // por eso prod exige dominio propio. Con certificado propio: TLS 1.2 mínimo (política 2021) y SNI.
      ...(certificate
        ? {
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
            sslSupportMethod: cloudfront.SSLMethod.SNI,
          }
        : {}),
      priceClass: PRICE_CLASS_MAP[config.priceClass],
      domainNames: config.domainName ? [config.domainName] : undefined,
      certificate,
      webAclId: this.webAcl?.attrArn,
      geoRestriction:
        config.geoAllowCountries.length > 0
          ? cloudfront.GeoRestriction.allowlist(...config.geoAllowCountries)
          : undefined,
      enableLogging: config.enableAccessLogs,
      logBucket: config.enableAccessLogs ? this.logsBucket : undefined,
      logFilePrefix: 'cloudfront/',
      // Nunca registrar cookies (la app no usa ninguna, y las cookies serían datos personales).
      logIncludesCookies: false,
    });
  }

  /**
   * Publica `apps/web/dist` con UNA `BucketDeployment` por clase de activo (ver `asset-policy.ts`):
   * cada clase lleva su `Cache-Control` y, cuando importa, su `Content-Type` exacto. La última (`Shell`)
   * recoge el resto y es la única que invalida CloudFront, para generar una sola invalidación.
   * `prune` borra del bucket lo que ya no está en `dist` (dentro del filtro de cada clase).
   */
  private deployAssets(config: FitroomWebConfig): boolean {
    if (!existsSync(join(config.webDistPath, 'index.html'))) {
      const message =
        `No existe ${config.webDistPath}/index.html: se omite la publicación de la web (sólo infraestructura). ` +
        'Ejecuta `pnpm --filter @fitroom/web build` antes de desplegar.';
      if (config.requireDist) throw new Error(message);
      Annotations.of(this).addWarningV2('@fitroom/infra:dist-missing', message);
      return false;
    }

    const source = (): s3deploy.ISource =>
      s3deploy.Source.asset(config.webDistPath, {
        // Los .map exponen el código fuente anotado: sólo se publican si se pide expresamente.
        exclude: config.publishSourceMaps ? [] : ['**/*.map'],
      });
    // Logs de la Lambda de publicación (sólo nombres de archivo): 1 mes basta; sin datos personales.
    const logGroup = new logs.LogGroup(this, 'DeploymentLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy:
        this.config.removalPolicy === 'destroy' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
    });
    const common = {
      destinationBucket: this.siteBucket,
      prune: true,
      // Si se borra el stack, el contenido publicado se conserva (el bucket es RETAIN en prod).
      retainOnDelete: true,
      memoryLimit: 1024,
      ephemeralStorageSize: Size.gibibytes(2),
      logGroup,
    } as const;

    const deployClass = (
      cls: AssetClass,
      extra: Partial<s3deploy.BucketDeploymentProps>,
    ): s3deploy.BucketDeployment =>
      new s3deploy.BucketDeployment(this, `Deploy${cls.id}`, {
        ...common,
        sources: [source()],
        cacheControl: [s3deploy.CacheControl.fromString(cls.cacheControl)],
        contentType: cls.contentType,
        ...extra,
      });

    const classDeployments = ASSET_CLASSES.map((cls) =>
      // `aws s3 sync` aplica los filtros en orden: primero se excluye todo y luego se incluye la clase.
      deployClass(cls, { exclude: ['*'], include: [...cls.include] }),
    );
    const shell = deployClass(SHELL_CLASS, {
      exclude: shellExcludePatterns(),
      distribution: this.distribution,
      distributionPaths: ['/*'],
    });
    // Primero los activos con hash y los binarios; el `index.html` (que los referencia) se publica al final.
    for (const deployment of classDeployments) shell.node.addDependency(deployment);
    return true;
  }

  /** Alarma de 5xx + tema SNS cifrado (sólo si hay email). CloudFront emite sus métricas en us-east-1, donde vive el stack. */
  private createAlarms(
    config: FitroomWebConfig,
    removalPolicy: RemovalPolicy,
  ): sns.Topic | undefined {
    const alarm = new cloudwatch.Alarm(this, 'Http5xxRateAlarm', {
      alarmDescription: `Mas del ${config.error5xxThresholdPercent}% de las respuestas de CloudFront son 5xx (${config.stage})`,
      // OJO: `distribution.metric5xxErrorRate()` de CDK sólo añade la dimensión DistributionId, pero las métricas de
      // CloudFront exigen también Region=Global; sin ella la alarma nunca recibiría datos (y, con
      // treatMissingData=notBreaching, jamás saltaría). Por eso se declara la métrica completa.
      metric: new cloudwatch.Metric({
        namespace: 'AWS/CloudFront',
        metricName: '5xxErrorRate',
        dimensionsMap: { DistributionId: this.distribution.distributionId, Region: 'Global' },
        period: Duration.minutes(5),
        statistic: 'Average',
      }),
      threshold: config.error5xxThresholdPercent,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      // Sin tráfico no hay datos: no es una avería.
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    if (!config.alarmEmail) return undefined;

    // Las alarmas de CloudWatch NO pueden publicar en un tema cifrado con la clave gestionada de AWS
    // (alias/aws/sns): hace falta una clave propia cuya política dé acceso a cloudwatch.amazonaws.com.
    const key = new kms.Key(this, 'AlertsKey', {
      description: `Cifrado del tema SNS de alertas de Probador 3D (${config.stage})`,
      enableKeyRotation: true,
      removalPolicy,
    });
    key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchAlarmsToPublish',
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    );
    const topic = new sns.Topic(this, 'AlertsTopic', {
      displayName: `Probador 3D ${config.stage}: alertas`,
      masterKey: key,
      enforceSSL: true,
    });
    topic.addSubscription(new snsSubscriptions.EmailSubscription(config.alarmEmail));
    alarm.addAlarmAction(new cloudwatchActions.SnsAction(topic));
    alarm.addOkAction(new cloudwatchActions.SnsAction(topic));
    return topic;
  }

  /** Presupuesto mensual opcional con avisos al 80 % (real) y 100 % (previsto) por correo. */
  private createBudget(config: FitroomWebConfig): void {
    if (config.monthlyBudgetUsd === undefined) return;
    const subscribers = config.budgetEmails.map((address) => ({
      subscriptionType: 'EMAIL',
      address,
    }));
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: `fitroom-${config.stage}-monthly`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: config.monthlyBudgetUsd, unit: 'USD' },
        // Requiere activar la etiqueta `Project` como «cost allocation tag» en Billing; si no, el filtro no casa nada.
        costFilters: config.budgetFilterByProjectTag
          ? { TagKeyValue: ['user:Project$fitroom'] }
          : undefined,
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 80,
            thresholdType: 'PERCENTAGE',
          },
          subscribers,
        },
        {
          notification: {
            notificationType: 'FORECASTED',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers,
        },
      ],
    });
  }
}

// `CACHE_IMMUTABLE` se re-exporta para que los tests comprueben el mismo valor que se despliega.
export { CACHE_IMMUTABLE };
