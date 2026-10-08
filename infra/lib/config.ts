/**
 * Configuración tipada y VALIDADA del stack web. Función pura (sin `aws-cdk-lib`) para poder probarla sin sintetizar.
 *
 * Origen de los valores, de mayor a menor prioridad: props del stack → contexto CDK (`-c clave=valor`) →
 * variable de entorno `FITROOM_<CLAVE_EN_MAYÚSCULAS>` → valor por defecto según el `stage`.
 * El workflow de despliegue usa variables de entorno (nunca interpola secretos/variables en comandos de shell).
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STAGES = ['staging', 'prod'] as const;
export type Stage = (typeof STAGES)[number];

/**
 * CloudFront exige que WAF (scope CLOUDFRONT) y los certificados ACM estén en us-east-1.
 * Para no repartir recursos en varias regiones, TODO el stack vive en us-east-1: el bucket sólo guarda
 * archivos públicos de la app (sin datos personales), así que su región no afecta a la privacidad.
 */
export const EDGE_REGION = 'us-east-1';

export const PRICE_CLASSES = ['PriceClass_100', 'PriceClass_200', 'PriceClass_All'] as const;
export type PriceClassName = (typeof PRICE_CLASSES)[number];

export class ConfigError extends Error {
  constructor(message: string) {
    super(`Configuración de infraestructura inválida: ${message}`);
    this.name = 'ConfigError';
  }
}

/** Entrada: todo opcional salvo lo que no tenga un valor por defecto razonable. */
export interface FitroomWebConfigInput {
  readonly stage?: Stage;
  /** Dominio propio (p. ej. `probador.example.com`). Obligatorio en prod (ver `allowDefaultDomainInProd`). */
  readonly domainName?: string;
  /** Zona Route53 que contiene el dominio; con ella se crean el certificado ACM (validación DNS) y los alias A/AAAA. */
  readonly hostedZoneId?: string;
  /** Nombre de la zona (por defecto, el propio `domainName`, es decir, dominio en el ápice). */
  readonly hostedZoneName?: string;
  /** Certificado ACM ya existente (debe estar en us-east-1). Si falta y hay zona, se crea uno. */
  readonly certificateArn?: string;
  readonly enableWaf?: boolean;
  /** Peticiones por IP en 5 minutos antes de bloquear (mínimo de WAF: 10). */
  readonly wafRateLimitPer5Min?: number;
  readonly priceClass?: PriceClassName;
  readonly hstsPreload?: boolean;
  /** CSP sin 'unsafe-inline' en style-src (ver security-headers.ts). Por defecto false hasta validar la UI final. */
  readonly strictStyleSrc?: boolean;
  /** Registros de acceso de CloudFront (contienen la IP del visitante: dato personal → retención corta). */
  readonly enableAccessLogs?: boolean;
  readonly logRetentionDays?: number;
  /** Cuántos días se conservan las versiones antiguas de los archivos (base del rollback desde S3). */
  readonly noncurrentVersionRetentionDays?: number;
  readonly alarmEmail?: string;
  /** Umbral (%) de la alarma de tasa de errores 5xx de CloudFront. */
  readonly error5xxThresholdPercent?: number;
  readonly monthlyBudgetUsd?: number;
  readonly budgetEmails?: readonly string[];
  /** Filtrar el presupuesto por la etiqueta de coste `Project` (hay que activarla antes en Billing). */
  readonly budgetFilterByProjectTag?: boolean;
  /** Carpeta con el build de la web (por defecto `../apps/web/dist`). */
  readonly webDistPath?: string;
  /** Falla la síntesis si no existe `webDistPath` (el workflow de despliegue lo activa). */
  readonly requireDist?: boolean;
  /** Publica los `.map` (por defecto NO: no regalamos el código fuente anotado). */
  readonly publishSourceMaps?: boolean;
  readonly removalPolicy?: 'retain' | 'destroy';
  /** Sólo para pruebas puntuales: permite prod sin dominio propio (TLS mínimo 1.0 con el certificado *.cloudfront.net). */
  readonly allowDefaultDomainInProd?: boolean;
  /** Países permitidos (ISO 3166-1 alfa-2). Por defecto, sin restricción geográfica. */
  readonly geoAllowCountries?: readonly string[];
  /** Etiquetas de coste adicionales. */
  readonly extraTags?: Readonly<Record<string, string>>;
}

export interface FitroomWebConfig {
  readonly stage: Stage;
  readonly domainName?: string;
  readonly hostedZoneId?: string;
  readonly hostedZoneName?: string;
  readonly certificateArn?: string;
  readonly enableWaf: boolean;
  readonly wafRateLimitPer5Min: number;
  readonly priceClass: PriceClassName;
  readonly hstsPreload: boolean;
  readonly strictStyleSrc: boolean;
  readonly enableAccessLogs: boolean;
  readonly logRetentionDays: number;
  readonly noncurrentVersionRetentionDays: number;
  readonly alarmEmail?: string;
  readonly error5xxThresholdPercent: number;
  readonly monthlyBudgetUsd?: number;
  readonly budgetEmails: readonly string[];
  readonly budgetFilterByProjectTag: boolean;
  readonly webDistPath: string;
  readonly requireDist: boolean;
  readonly publishSourceMaps: boolean;
  readonly removalPolicy: 'retain' | 'destroy';
  readonly allowDefaultDomainInProd: boolean;
  readonly geoAllowCountries: readonly string[];
  readonly extraTags: Readonly<Record<string, string>>;
}

const infraDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_WEB_DIST_PATH = resolve(infraDir, '../apps/web/dist');

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const HOSTED_ZONE_ID_RE = /^Z[A-Z0-9]{8,31}$/;
const CERT_ARN_RE = /^arn:aws:acm:us-east-1:\d{12}:certificate\/[0-9a-f-]{36}$/;
const EMAIL_RE = /^[^\s@,;<>()[\]\\]+@[^\s@,;<>()[\]\\]+\.[^\s@,;<>()[\]\\]+$/;
const COUNTRY_RE = /^[A-Z]{2}$/;

function fail(message: string): never {
  throw new ConfigError(message);
}

function checkInt(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${name} debe ser un entero entre ${min} y ${max} (recibido: ${String(value)})`);
  }
  return value;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/** Aplica valores por defecto según el `stage` y valida combinaciones. Lanza `ConfigError` con un mensaje accionable. */
export function resolveConfig(input: FitroomWebConfigInput = {}): FitroomWebConfig {
  const stage = input.stage ?? 'staging';
  if (!STAGES.includes(stage))
    fail(`stage debe ser uno de ${STAGES.join(', ')} (recibido: ${String(stage)})`);
  const prod = stage === 'prod';

  const domainName = input.domainName?.toLowerCase();
  if (domainName !== undefined && !HOSTNAME_RE.test(domainName)) {
    fail(`domainName no es un nombre de host válido: ${domainName}`);
  }
  if (input.hostedZoneId !== undefined && !HOSTED_ZONE_ID_RE.test(input.hostedZoneId)) {
    fail(
      `hostedZoneId no parece un id de zona Route53 (p. ej. Z0123456789ABCDEFGHIJ): ${input.hostedZoneId}`,
    );
  }
  if (input.certificateArn !== undefined && !CERT_ARN_RE.test(input.certificateArn)) {
    fail(
      'certificateArn debe ser un certificado ACM de us-east-1 (CloudFront sólo acepta esa región)',
    );
  }
  if (
    domainName === undefined &&
    (input.hostedZoneId || input.certificateArn || input.hostedZoneName)
  ) {
    fail('hostedZoneId/hostedZoneName/certificateArn requieren domainName');
  }
  if (domainName !== undefined && !input.hostedZoneId && !input.certificateArn) {
    fail(
      'domainName requiere hostedZoneId (se crea el certificado y el alias DNS) o certificateArn',
    );
  }
  const hostedZoneName = input.hostedZoneId
    ? (input.hostedZoneName ?? domainName)?.toLowerCase()
    : undefined;
  if (hostedZoneName !== undefined && domainName !== undefined) {
    if (!HOSTNAME_RE.test(hostedZoneName)) fail(`hostedZoneName no es válido: ${hostedZoneName}`);
    if (domainName !== hostedZoneName && !domainName.endsWith(`.${hostedZoneName}`)) {
      fail(`domainName (${domainName}) debe pertenecer a la zona ${hostedZoneName}`);
    }
  }

  const allowDefaultDomainInProd = input.allowDefaultDomainInProd ?? false;
  if (prod && domainName === undefined && !allowDefaultDomainInProd) {
    fail(
      'prod exige domainName: con el certificado por defecto *.cloudfront.net CloudFront no permite ' +
        'fijar TLS 1.2 como mínimo. (Sólo para pruebas: allowDefaultDomainInProd=true)',
    );
  }

  const removalPolicy = input.removalPolicy ?? (prod ? 'retain' : 'destroy');
  if (prod && removalPolicy === 'destroy') {
    fail('prod no admite removalPolicy=destroy: los buckets deben conservarse (retain)');
  }

  const enableWaf = input.enableWaf ?? prod;
  const wafRateLimitPer5Min = checkInt(
    'wafRateLimitPer5Min',
    input.wafRateLimitPer5Min ?? 2000,
    10,
    2_000_000_000,
  );
  const priceClass = input.priceClass ?? (prod ? 'PriceClass_All' : 'PriceClass_100');
  if (!PRICE_CLASSES.includes(priceClass))
    fail(`priceClass debe ser uno de ${PRICE_CLASSES.join(', ')}`);

  const logRetentionDays = checkInt(
    'logRetentionDays',
    input.logRetentionDays ?? (prod ? 30 : 14),
    1,
    365,
  );
  const noncurrentVersionRetentionDays = checkInt(
    'noncurrentVersionRetentionDays',
    input.noncurrentVersionRetentionDays ?? (prod ? 90 : 30),
    1,
    3650,
  );

  const error5xxThresholdPercent = input.error5xxThresholdPercent ?? 5;
  if (!(error5xxThresholdPercent > 0 && error5xxThresholdPercent <= 100)) {
    fail('error5xxThresholdPercent debe estar en (0, 100]');
  }

  if (input.alarmEmail !== undefined && !EMAIL_RE.test(input.alarmEmail))
    fail('alarmEmail no es un email válido');
  const budgetEmails = [...(input.budgetEmails ?? (input.alarmEmail ? [input.alarmEmail] : []))];
  for (const email of budgetEmails)
    if (!EMAIL_RE.test(email)) fail(`email de presupuesto inválido: ${email}`);
  if (input.monthlyBudgetUsd !== undefined) {
    if (!(Number.isFinite(input.monthlyBudgetUsd) && input.monthlyBudgetUsd > 0)) {
      fail('monthlyBudgetUsd debe ser un número > 0');
    }
    if (budgetEmails.length === 0)
      fail('monthlyBudgetUsd requiere alarmEmail o budgetEmails para notificar');
  }

  const geoAllowCountries = [...(input.geoAllowCountries ?? [])].map((c) => c.toUpperCase());
  for (const country of geoAllowCountries) {
    if (!COUNTRY_RE.test(country)) fail(`geoAllowCountries: código de país inválido: ${country}`);
  }

  const extraTags: Record<string, string> = { ...(input.extraTags ?? {}) };
  for (const [key, value] of Object.entries(extraTags)) {
    if (key.startsWith('aws:') || key.length > 128 || value.length > 256)
      fail(`etiqueta inválida: ${key}`);
  }

  return {
    stage,
    domainName,
    hostedZoneId: input.hostedZoneId,
    hostedZoneName,
    certificateArn: input.certificateArn,
    enableWaf,
    wafRateLimitPer5Min,
    priceClass,
    hstsPreload: input.hstsPreload ?? false,
    strictStyleSrc: input.strictStyleSrc ?? false,
    enableAccessLogs: input.enableAccessLogs ?? true,
    logRetentionDays,
    noncurrentVersionRetentionDays,
    alarmEmail: input.alarmEmail,
    error5xxThresholdPercent,
    monthlyBudgetUsd: input.monthlyBudgetUsd,
    budgetEmails,
    budgetFilterByProjectTag: input.budgetFilterByProjectTag ?? false,
    webDistPath: resolve(input.webDistPath ?? DEFAULT_WEB_DIST_PATH),
    requireDist: input.requireDist ?? false,
    publishSourceMaps: input.publishSourceMaps ?? false,
    removalPolicy,
    allowDefaultDomainInProd,
    geoAllowCountries,
    extraTags,
  };
}

/** Lectura de un valor «crudo» (contexto CDK o entorno). `undefined`/cadena vacía = no definido. */
export type RawGetter = (key: string) => unknown;

function toBoolean(name: string, raw: unknown): boolean | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'boolean') return raw;
  const text = String(raw).trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return fail(`${name} debe ser true o false (recibido: ${String(raw)})`);
}

function toNumber(name: string, raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
  return Number.isFinite(value)
    ? value
    : fail(`${name} debe ser numérico (recibido: ${String(raw)})`);
}

function toText(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  return text === '' ? undefined : text;
}

function toList(raw: unknown): string[] | undefined {
  const text = toText(raw);
  return text === undefined
    ? undefined
    : text
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}

/** `webDistPath` → `FITROOM_WEB_DIST_PATH`. */
export function envNameFor(key: string): string {
  return `FITROOM_${key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;
}

/**
 * Construye el input a partir de contexto CDK + entorno. `getContext` suele ser `app.node.tryGetContext.bind(app.node)`
 * y `env` `process.env`. Convierte cadenas a booleanos/números con errores claros.
 */
export function inputFromEnvironment(
  getContext: RawGetter,
  env: Readonly<Record<string, string | undefined>>,
): FitroomWebConfigInput {
  const get = (key: string): unknown => {
    const fromContext = getContext(key);
    if (fromContext !== undefined && fromContext !== null && fromContext !== '') return fromContext;
    return env[envNameFor(key)];
  };
  const stage = toText(get('stage'));
  if (stage !== undefined && !(STAGES as readonly string[]).includes(stage)) {
    fail(`stage debe ser uno de ${STAGES.join(', ')} (recibido: ${stage})`);
  }
  const priceClass = toText(get('priceClass'));
  if (priceClass !== undefined && !(PRICE_CLASSES as readonly string[]).includes(priceClass)) {
    fail(`priceClass debe ser uno de ${PRICE_CLASSES.join(', ')} (recibido: ${priceClass})`);
  }
  const removalPolicy = toText(get('removalPolicy'));
  if (removalPolicy !== undefined && removalPolicy !== 'retain' && removalPolicy !== 'destroy') {
    fail(`removalPolicy debe ser retain o destroy (recibido: ${removalPolicy})`);
  }
  const optional = {
    stage: stage as Stage | undefined,
    domainName: toText(get('domainName')),
    hostedZoneId: toText(get('hostedZoneId')),
    hostedZoneName: toText(get('hostedZoneName')),
    certificateArn: toText(get('certificateArn')),
    enableWaf: toBoolean('enableWaf', get('enableWaf')),
    wafRateLimitPer5Min: toNumber('wafRateLimitPer5Min', get('wafRateLimitPer5Min')),
    priceClass: priceClass as PriceClassName | undefined,
    hstsPreload: toBoolean('hstsPreload', get('hstsPreload')),
    strictStyleSrc: toBoolean('strictStyleSrc', get('strictStyleSrc')),
    enableAccessLogs: toBoolean('enableAccessLogs', get('enableAccessLogs')),
    logRetentionDays: toNumber('logRetentionDays', get('logRetentionDays')),
    noncurrentVersionRetentionDays: toNumber(
      'noncurrentVersionRetentionDays',
      get('noncurrentVersionRetentionDays'),
    ),
    alarmEmail: toText(get('alarmEmail')),
    error5xxThresholdPercent: toNumber('error5xxThresholdPercent', get('error5xxThresholdPercent')),
    monthlyBudgetUsd: toNumber('monthlyBudgetUsd', get('monthlyBudgetUsd')),
    budgetEmails: toList(get('budgetEmails')),
    budgetFilterByProjectTag: toBoolean(
      'budgetFilterByProjectTag',
      get('budgetFilterByProjectTag'),
    ),
    webDistPath: toText(get('webDistPath')),
    requireDist: toBoolean('requireDist', get('requireDist')),
    publishSourceMaps: toBoolean('publishSourceMaps', get('publishSourceMaps')),
    removalPolicy: removalPolicy as 'retain' | 'destroy' | undefined,
    allowDefaultDomainInProd: toBoolean(
      'allowDefaultDomainInProd',
      get('allowDefaultDomainInProd'),
    ),
    geoAllowCountries: toList(get('geoAllowCountries')),
  };
  // Se eliminan las claves sin valor para que no pisen los defaults de `resolveConfig`.
  return Object.fromEntries(
    Object.entries(optional).filter(([, value]) => isDefined(value)),
  ) as FitroomWebConfigInput;
}
