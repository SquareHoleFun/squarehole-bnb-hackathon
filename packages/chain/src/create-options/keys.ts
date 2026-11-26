import { decodeAbiParameters, encodeAbiParameters, type Address } from 'viem';
import { CREATE_ADDON_KEYS_V2, CREATE_FEE_KEYS_V2, CREATE_KIND_KEYS_V2, type BoxSpecV2, type SideV2 } from '../core/v2/spec-v2';
import { pileConfigV2 } from '../core/v2/m3-spec-v2';
import type { CreateOptionsDocument } from './schema';

export const TEMPLATE_CREATE_OPTIONS = [
  'template.liquidity', 'template.burn', 'template.creator', 'template.holders', 'template.collection',
  'template.collection-burn', 'template.pile', 'template.alchemist-pile', 'template.shop', 'template.blank',
] as const;
type FeeSuffix = (typeof CREATE_FEE_KEYS_V2)[keyof typeof CREATE_FEE_KEYS_V2][0];
export type StaticCreateOptionKey = (typeof TEMPLATE_CREATE_OPTIONS)[number]
  | NonNullable<(typeof CREATE_KIND_KEYS_V2)[keyof typeof CREATE_KIND_KEYS_V2]>
  | NonNullable<(typeof CREATE_ADDON_KEYS_V2)[keyof typeof CREATE_ADDON_KEYS_V2]>
  | `fee.buyers.${Exclude<FeeSuffix, 'shop'>}` | `fee.sellers.${FeeSuffix}`;
export type CreateOptionKey = StaticCreateOptionKey | `price.${Address}` | `pile.coin.${Address}` | `module.${Address}.${number}`;
export const STATIC_CREATE_OPTIONS: readonly StaticCreateOptionKey[] = Object.freeze([
  ...TEMPLATE_CREATE_OPTIONS,
  ...Object.values(CREATE_KIND_KEYS_V2).filter((key): key is NonNullable<typeof key> => key !== null),
  ...Object.values(CREATE_ADDON_KEYS_V2).filter((key): key is NonNullable<typeof key> => key !== null),
  ...Object.values(CREATE_FEE_KEYS_V2).flatMap(([suffix]) => suffix === 'shop'
    ? ['fee.sellers.shop' as const] : [`fee.buyers.${suffix}` as const, `fee.sellers.${suffix}` as const]),
]);
const known = new Set<string>(STATIC_CREATE_OPTIONS);
/** Native is the zero address. Module rows are canonical decimal uint32, including row zero.
 * The negative lookahead requires the absolute end of the input. */
export const DYNAMIC_CREATE_OPTION_GRAMMAR = Object.freeze({
  price: /^price\.0x[0-9a-f]{40}(?![\s\S])/,
  pileCoin: /^pile\.coin\.0x[0-9a-f]{40}(?![\s\S])/,
  module: /^module\.0x[0-9a-f]{40}\.(0|[1-9][0-9]{0,9})(?![\s\S])/,
});
export function isCreateOptionKey(key: string): key is CreateOptionKey {
  if (key.length > 96 || /[^a-z0-9.-]/.test(key)) return false;
  if (known.has(key) || DYNAMIC_CREATE_OPTION_GRAMMAR.price.test(key) || DYNAMIC_CREATE_OPTION_GRAMMAR.pileCoin.test(key)) return true;
  const module = DYNAMIC_CREATE_OPTION_GRAMMAR.module.exec(key);
  return module !== null && module[1] !== undefined && BigInt(module[1]) <= 0xffffffffn;
}

function feeSuffix(side: SideV2): FeeSuffix {
  if (side.split !== 1 || side.splitParams !== '0x' || side.b.leg !== 0 || side.b.dest !== 0
    || side.b.legParams !== '0x' || side.b.destParams !== '0x' || side.a.legParams !== '0x') throw new Error('unsupported Create fee wire');
  const match = Object.values(CREATE_FEE_KEYS_V2).find(([, leg, dest]) => leg === side.a.leg && dest === side.a.dest);
  if (!match) throw new Error('unsupported Create fee wire');
  const [suffix] = match;
  const params = side.a.destParams.toLowerCase();
  if (suffix === 'alchemist') {
    const abi = [{ type: 'uint32' }] as const;
    const values = decodeAbiParameters(abi, params as `0x${string}`);
    if (encodeAbiParameters(abi, values) !== params) throw new Error('noncanonical module row');
  } else {
    const uint8 = (n: number) => encodeAbiParameters([{ type: 'uint8' }], [n]);
    const allowed = suffix === 'holders-p' ? [uint8(1)] : suffix === 'holders-t' ? [uint8(2)]
      : suffix === 'items-p' || suffix === 'items-t' ? [1, 2, 3].map(uint8)
        : suffix === 'shop' ? [2, 4, 8].map(uint8) : ['0x'];
    if (!allowed.includes(params)) throw new Error('unsupported Create fee parameters');
  }
  return suffix;
}

/** Only new Create requirements, derived from decoded wire choices. Unsupported wires throw; never silently omit them.
 * The module row wire has no directory address. Supply the selected release's directory for module rows; no default
 * release or saved-run provenance is guessed. All other specs need only the decoded spec. */
export function requiredCreateOptions(spec: BoxSpecV2, moduleDirectory?: Address): CreateOptionKey[] {
  if (spec.format !== 2 || spec.version !== 2) throw new Error('unsupported Create spec version');
  const keys = new Set<CreateOptionKey>();
  const add = (key: string | null | undefined) => {
    if (!key || !isCreateOptionKey(key)) throw new Error('unsupported Create option');
    keys.add(key);
  };
  add((CREATE_KIND_KEYS_V2 as Readonly<Record<number, string | null>>)[spec.boxType]);
  for (const side of ['buyers', 'sellers'] as const) {
    const suffix = feeSuffix(spec[side]);
    add(`fee.${side}.${suffix}`);
    if (suffix === 'shop') add('fee.sellers.holders-p');
    if (suffix === 'alchemist') {
      if (!moduleDirectory) throw new Error('module row requires the release directory, absent from BoxSpecV2');
      const [row] = decodeAbiParameters([{ type: 'uint32' }], spec[side].a.destParams);
      add(`module.${moduleDirectory.toLowerCase()}.${row}`);
    }
  }
  for (const addon of spec.addOns) add((CREATE_ADDON_KEYS_V2 as Readonly<Record<number, string | null>>)[addon.id]);
  add(`price.${spec.pricing.token.toLowerCase()}`);
  if (spec.boxType === 5) add(`pile.coin.${pileConfigV2(spec.contentsParams).asset.toLowerCase()}`);
  return [...keys];
}

/** Distinct requested keys, in request order. This list can only remove options from an otherwise valid request. */
export function switchedOff(document: CreateOptionsDocument, keys: readonly CreateOptionKey[]): CreateOptionKey[] {
  const off = new Set(document.off.map(entry => entry.key));
  return [...new Set(keys)].filter(key => off.has(key));
}
