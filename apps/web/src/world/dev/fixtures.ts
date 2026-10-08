import type {
  CatalogData,
  FabricDef,
  GarmentDefinition,
  GarmentSizeSpec,
  SwatchVariant,
} from '@fitroom/shared';

/**
 * Mini-catálogo de DESARROLLO tipado contra los esquemas compartidos (se valida en `fixtures.test.ts`).
 * Sólo se usa mientras `@fitroom/catalog` no esté READY o con `?mock=1`.
 */
const fabric = (
  id: string,
  es: string,
  en: string,
  family: FabricDef['family'],
  p: Omit<FabricDef, 'id' | 'name' | 'family'>,
): FabricDef => ({ id, name: { es, en }, family, ...p });

const FABRICS: FabricDef[] = [
  fabric('jersey-algodon', 'Jersey de algodón', 'Cotton jersey', 'cotton-jersey', {
    weightGsm: 160, stretch: 0.45, stiffness: 0.15, roughness: 0.82, sheen: 0.1, threadsPerCm: 14, tileCm: 12, thicknessMm: 0.6,
  }),
  fabric('lino-lavado', 'Lino lavado', 'Washed linen', 'linen', {
    weightGsm: 185, stretch: 0.05, stiffness: 0.35, roughness: 0.9, sheen: 0.05, threadsPerCm: 11, tileCm: 14, thicknessMm: 0.7,
  }),
  fabric('merino-fino', 'Lana merino', 'Merino wool', 'merino', {
    weightGsm: 260, stretch: 0.55, stiffness: 0.3, roughness: 0.92, sheen: 0.2, threadsPerCm: 9, tileCm: 10, thicknessMm: 2.2,
  }),
  fabric('denim-12oz', 'Denim 12 oz', 'Denim 12 oz', 'denim', {
    weightGsm: 400, stretch: 0.1, stiffness: 0.7, roughness: 0.85, sheen: 0.05, threadsPerCm: 22, tileCm: 10, thicknessMm: 1.1,
  }),
  fabric('twill-chino', 'Sarga de algodón', 'Cotton twill', 'twill', {
    weightGsm: 280, stretch: 0.12, stiffness: 0.5, roughness: 0.8, sheen: 0.08, threadsPerCm: 26, tileCm: 10, thicknessMm: 0.9,
  }),
  fabric('satin-seda', 'Satén de seda', 'Silk satin', 'satin', {
    weightGsm: 110, stretch: 0.08, stiffness: 0.1, roughness: 0.32, sheen: 0.9, threadsPerCm: 60, tileCm: 8, thicknessMm: 0.3,
  }),
  fabric('popelin-algodon', 'Popelín de algodón', 'Cotton poplin', 'cotton-poplin', {
    weightGsm: 120, stretch: 0.05, stiffness: 0.3, roughness: 0.75, sheen: 0.15, threadsPerCm: 40, tileCm: 8, thicknessMm: 0.35,
  }),
  fabric('tweed-lana', 'Tweed de lana', 'Wool tweed', 'tweed', {
    weightGsm: 420, stretch: 0.05, stiffness: 0.65, roughness: 0.95, sheen: 0.1, threadsPerCm: 8, tileCm: 16, thicknessMm: 2.6,
  }),
  fabric('felpa-algodon', 'Felpa de algodón', 'Cotton fleece', 'fleece', {
    weightGsm: 320, stretch: 0.35, stiffness: 0.25, roughness: 0.95, sheen: 0.15, threadsPerCm: 10, tileCm: 12, thicknessMm: 3,
  }),
];

const variant = (
  id: string,
  es: string,
  en: string,
  color: string,
  pattern: SwatchVariant['pattern'] = { type: 'solid' },
): SwatchVariant => ({ id, name: { es, en }, color, pattern });

type Dim = NonNullable<GarmentSizeSpec['garment']>;
const size = (
  label: string,
  body: GarmentSizeSpec['body'],
  garment: Dim,
): GarmentSizeSpec => ({ label, body, garment });

/** Tallas de parte de arriba: la referencia es el contorno de pecho del cuerpo. */
function topSizes(ease: number, shoulderEase: number, length: number, sleeve: number): GarmentSizeSpec[] {
  const rows: [string, [number, number], [number, number]][] = [
    ['XS', [80, 88], [36, 40]],
    ['S', [88, 96], [40, 43]],
    ['M', [96, 104], [43, 46]],
    ['L', [104, 112], [46, 49]],
    ['XL', [112, 122], [49, 52]],
  ];
  return rows.map(([label, chest, shoulder], i) =>
    size(label, { chestCm: chest, shoulderWidthCm: shoulder }, {
      chestCm: (chest[0] + chest[1]) / 2 + ease,
      shoulderWidthCm: (shoulder[0] + shoulder[1]) / 2 + shoulderEase,
      lengthCm: length + i * 2,
      sleeveLengthCm: sleeve + i * 1.2,
    }),
  );
}

/** Tallas de parte de abajo: la referencia es el contorno de cintura/cadera. */
function bottomSizes(waistEase: number, hipEase: number, inseam: number, legOpening: number): GarmentSizeSpec[] {
  const rows: [string, [number, number], [number, number]][] = [
    ['XS', [62, 70], [86, 94]],
    ['S', [70, 78], [94, 100]],
    ['M', [78, 86], [100, 106]],
    ['L', [86, 94], [106, 112]],
    ['XL', [94, 104], [112, 120]],
  ];
  return rows.map(([label, waist, hip], i) =>
    size(label, { waistCm: waist, hipCm: hip }, {
      waistCm: (waist[0] + waist[1]) / 2 + waistEase,
      hipCm: (hip[0] + hip[1]) / 2 + hipEase,
      thighCm: 62 + i * 3.5,
      legOpeningCm: legOpening + i * 1,
      inseamCm: inseam,
      riseCm: 25 + i * 0.5,
    }),
  );
}

function skirtSizes(): GarmentSizeSpec[] {
  return bottomSizes(6, 10, 74, 30).map((row) =>
    size(row.label, row.body, {
      waistCm: row.garment.waistCm,
      hipCm: row.garment.hipCm,
      lengthCm: 74,
    }),
  );
}

function dressSizes(): GarmentSizeSpec[] {
  const rows: [string, [number, number], [number, number], [number, number]][] = [
    ['XS', [80, 88], [62, 70], [86, 94]],
    ['S', [88, 96], [70, 78], [94, 100]],
    ['M', [96, 104], [78, 86], [100, 106]],
    ['L', [104, 112], [86, 94], [106, 112]],
  ];
  return rows.map(([label, chest, waist, hip], i) =>
    size(label, { chestCm: chest, waistCm: waist, hipCm: hip }, {
      chestCm: (chest[0] + chest[1]) / 2 + 8,
      waistCm: (waist[0] + waist[1]) / 2 + 10,
      hemCm: 150 + i * 6,
      lengthCm: 108 + i * 1.5,
      shoulderWidthCm: 38 + i * 2,
    }),
  );
}

const g = (d: Omit<GarmentDefinition, 'brand' | 'tags'> & { brand?: string; tags?: string[] }): GarmentDefinition => ({
  brand: 'Atelier Demo',
  tags: [],
  ...d,
});

const GARMENTS: GarmentDefinition[] = [
  g({
    id: 'camiseta-algodon',
    name: { es: 'Camiseta de algodón', en: 'Cotton tee' },
    description: {
      es: 'Jersey suave de algodón peinado, cuello redondo y caída recta.',
      en: 'Soft combed-cotton jersey with a crew neck and a straight drape.',
    },
    category: 'tops', template: 'tee', slot: 'upper', fit: 'regular', fabricId: 'jersey-algodon',
    variants: [
      variant('marfil', 'Marfil', 'Ivory', '#EFE6D2'),
      variant('oliva', 'Verde oliva', 'Olive green', '#5B6A3B'),
      variant('marino-rayas', 'Rayas marino', 'Navy stripes', '#F2EADB', { type: 'stripes', color2: '#27344F', widthMm: 9, gapMm: 9, angleDeg: 0 }),
      variant('terracota', 'Terracota', 'Terracotta', '#B4623E'),
    ],
    sizes: topSizes(8, 1, 66, 20),
    price: { amount: 29, currency: 'EUR' },
    tags: ['básico', 'algodón', 'verano'],
  }),
  g({
    id: 'camisa-lino',
    name: { es: 'Camisa de lino', en: 'Linen shirt' },
    description: {
      es: 'Lino lavado de caída natural, cuello camisero y puños con botón.',
      en: 'Washed linen with a natural drape, a shirt collar and button cuffs.',
    },
    category: 'tops', template: 'shirt', slot: 'upper', fit: 'relaxed', fabricId: 'lino-lavado',
    variants: [
      variant('natural', 'Natural', 'Natural', '#D9CBAA'),
      variant('salvia', 'Salvia', 'Sage', '#9CAA8A'),
      variant('cielo-cuadros', 'Cuadros cielo', 'Sky check', '#E9EEF2', { type: 'plaid', color2: '#8EA9C4', sizeMm: 36 }),
      variant('azul-rayas', 'Rayas azules', 'Blue stripes', '#F4F1E8', { type: 'stripes', color2: '#4A6FA5', widthMm: 4, gapMm: 10, angleDeg: 90 }),
    ],
    sizes: topSizes(14, 2, 74, 61),
    price: { amount: 69, currency: 'EUR' },
    tags: ['lino', 'camisa', 'verano'],
  }),
  g({
    id: 'jersey-merino',
    name: { es: 'Jersey de merino', en: 'Merino sweater' },
    description: {
      es: 'Punto fino de lana merino, cuello redondo y puños acanalados.',
      en: 'Fine merino knit with a crew neck and ribbed cuffs.',
    },
    category: 'tops', template: 'sweater', slot: 'upper', fit: 'regular', fabricId: 'merino-fino',
    variants: [
      variant('avena', 'Avena', 'Oatmeal', '#CDBFA6'),
      variant('bosque', 'Verde bosque', 'Forest green', '#2F4A36'),
      variant('burdeos', 'Burdeos', 'Burgundy', '#6B2232'),
    ],
    sizes: topSizes(10, 2, 68, 62),
    price: { amount: 89, currency: 'EUR' },
    tags: ['lana', 'invierno', 'punto'],
  }),
  g({
    id: 'sudadera-capucha',
    name: { es: 'Sudadera con capucha', en: 'Hoodie' },
    description: {
      es: 'Felpa de algodón cepillada por dentro, bolsillo canguro y corte amplio.',
      en: 'Brushed-back cotton fleece with a kangaroo pocket and a roomy cut.',
    },
    category: 'tops', template: 'hoodie', slot: 'upper', fit: 'oversized', fabricId: 'felpa-algodon',
    variants: [
      variant('gris', 'Gris piedra', 'Stone grey', '#9A968C'),
      variant('negro', 'Negro', 'Black', '#26231F'),
      variant('mostaza', 'Mostaza', 'Mustard', '#B98A2B'),
    ],
    sizes: topSizes(22, 5, 70, 63),
    price: { amount: 59, currency: 'EUR' },
    tags: ['felpa', 'casual'],
  }),
  g({
    id: 'vaquero-recto',
    name: { es: 'Vaquero recto', en: 'Straight jeans' },
    description: {
      es: 'Denim de 12 oz con corte recto, tiro medio y dobladillo con grosor.',
      en: 'Twelve-ounce denim with a straight cut, mid rise and a thick hem.',
    },
    category: 'bottoms', template: 'jeans', slot: 'lower', fit: 'regular', fabricId: 'denim-12oz',
    variants: [
      variant('indigo', 'Índigo', 'Indigo', '#2E3F63'),
      variant('lavado', 'Lavado claro', 'Light wash', '#7C93B5'),
      variant('negro', 'Negro', 'Black', '#25262A'),
    ],
    sizes: bottomSizes(2, 6, 80, 17),
    price: { amount: 79, currency: 'EUR' },
    tags: ['denim', 'básico'],
  }),
  g({
    id: 'chino-sarga',
    name: { es: 'Pantalón chino', en: 'Chinos' },
    description: {
      es: 'Sarga de algodón con ligera elasticidad y bajo estrecho.',
      en: 'Cotton twill with a touch of stretch and a tapered leg.',
    },
    category: 'bottoms', template: 'chinos', slot: 'lower', fit: 'slim', fabricId: 'twill-chino',
    variants: [
      variant('arena', 'Arena', 'Sand', '#C7B08A'),
      variant('oliva', 'Oliva', 'Olive', '#6A6C45'),
      variant('marino', 'Marino', 'Navy', '#2A3550'),
    ],
    sizes: bottomSizes(3, 6, 79, 15),
    price: { amount: 65, currency: 'EUR' },
    tags: ['sarga', 'oficina'],
  }),
  g({
    id: 'falda-midi',
    name: { es: 'Falda midi de satén', en: 'Satin midi skirt' },
    description: {
      es: 'Satén de seda cortado al bies; cae con movimiento propio.',
      en: 'Bias-cut silk satin that moves on its own.',
    },
    category: 'bottoms', template: 'skirt', slot: 'lower', fit: 'regular', fabricId: 'satin-seda',
    variants: [
      variant('tinta', 'Tinta', 'Ink', '#1D2430'),
      variant('burdeos', 'Burdeos', 'Bordeaux', '#5C1F2C'),
      variant('lunares', 'Lunares marfil', 'Ivory dots', '#2B3A33', { type: 'dots', color2: '#EDE3CC', radiusMm: 2.5, spacingMm: 14 }),
    ],
    sizes: skirtSizes(),
    price: { amount: 85, currency: 'EUR' },
    tags: ['seda', 'fiesta'],
  }),
  g({
    id: 'vestido-camisero',
    name: { es: 'Vestido camisero', en: 'Shirt dress' },
    description: {
      es: 'Popelín de algodón con cinturón de tela, botones al pecho y vuelo en la falda.',
      en: 'Cotton poplin with a fabric belt, a buttoned placket and a flared skirt.',
    },
    category: 'dresses', template: 'dress', slot: 'full', fit: 'regular', fabricId: 'popelin-algodon',
    variants: [
      variant('blanco-rayas', 'Rayas blancas', 'White stripes', '#F2EEE3', { type: 'stripes', color2: '#31507A', widthMm: 3, gapMm: 7, angleDeg: 90 }),
      variant('floral', 'Floral', 'Floral', '#E7DCC4', { type: 'floral', color2: '#9D4B3A', color3: '#5B6A3B', scaleMm: 50 }),
      variant('marino', 'Marino', 'Navy', '#27324A'),
    ],
    sizes: dressSizes(),
    price: { amount: 95, currency: 'EUR' },
    tags: ['vestido', 'primavera'],
  }),
  g({
    id: 'blazer-lana',
    name: { es: 'Blazer de lana', en: 'Wool blazer' },
    description: {
      es: 'Tweed de espiga con hombro natural, solapa en pico y forro interior.',
      en: 'Herringbone tweed with a natural shoulder, peak lapels and a lined interior.',
    },
    category: 'outerwear', template: 'blazer', slot: 'outer', fit: 'regular', fabricId: 'tweed-lana',
    variants: [
      variant('carbon-espiga', 'Espiga carbón', 'Charcoal herringbone', '#3A3A3C', { type: 'herringbone', color2: '#6C6A66', sizeMm: 8 }),
      variant('camel', 'Camel', 'Camel', '#A67C52'),
      variant('principe-gales', 'Cuadros', 'Check', '#8C8578', { type: 'plaid', color2: '#46423C', sizeMm: 48 }),
    ],
    sizes: topSizes(14, 2, 72, 62),
    price: { amount: 149, currency: 'EUR' },
    tags: ['lana', 'sastrería'],
  }),
  g({
    id: 'abrigo-largo',
    name: { es: 'Abrigo largo', en: 'Long coat' },
    description: {
      es: 'Paño de lana de caída recta, cierre cruzado y bolsillos de ojal.',
      en: 'Straight-hanging wool cloth with a double-breasted front and welt pockets.',
    },
    category: 'outerwear', template: 'coat', slot: 'outer', fit: 'relaxed', fabricId: 'tweed-lana',
    variants: [
      variant('camel', 'Camel', 'Camel', '#B08A5E'),
      variant('negro', 'Negro', 'Black', '#232225'),
    ],
    sizes: topSizes(20, 3, 104, 63),
    price: { amount: 189, currency: 'EUR' },
    tags: ['abrigo', 'invierno'],
  }),
];

export const DEV_CATALOG: CatalogData = { version: 1, fabrics: FABRICS, garments: GARMENTS };
