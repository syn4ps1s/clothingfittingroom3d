import type { FabricFamily } from '@fitroom/shared';
import type { FamilyBuilder } from '../types.js';
import { buildDenim, buildLinen, buildPoplin, buildSatin, buildTweed, buildTwill } from './woven.js';
import { buildJersey, buildMerino, buildWoolKnit } from './knit.js';
import { buildCorduroy, buildFleece, buildLeather, buildSilkCrepe } from './misc.js';

/** Registro de constructores por familia (exhaustivo: el tipo obliga a cubrir `FABRIC_FAMILIES`). */
export const FAMILY_BUILDERS: Readonly<Record<FabricFamily, FamilyBuilder>> = {
  'cotton-jersey': buildJersey,
  'cotton-poplin': buildPoplin,
  denim: buildDenim,
  linen: buildLinen,
  'wool-knit': buildWoolKnit,
  merino: buildMerino,
  satin: buildSatin,
  'silk-crepe': buildSilkCrepe,
  leather: buildLeather,
  corduroy: buildCorduroy,
  fleece: buildFleece,
  twill: buildTwill,
  tweed: buildTweed,
};
