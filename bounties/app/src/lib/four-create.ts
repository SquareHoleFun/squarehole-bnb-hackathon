import { decodeAbiParameters, encodeAbiParameters, isAddress, isHex, keccak256, parseUnits, toBytes, zeroAddress, zeroHash, type AbiParameter, type Address, type Hex } from 'viem';
import { parseAmount, parsePercentToBps } from './amounts';
import type { RulesParts } from './rules';

/**
 * The Four.meme rail's create form and its call to the creation signer (bounties/openfour/sign/README.md): the
 * request body exactly as the signer takes it, and its answer checked before anything is sent.
 */
export type FourKind = 'preset' | 'tax';

export interface FourForm {
  kind: FourKind;
  name: string;
  symbol: string;
  quote: string; // an address from the deployment's allowed quote coins
  raise: string; // whole coins, decimal
  buy: string; // percent
  sell: string; // percent
}

export const FOUR_DEFAULTS: FourForm = { kind: 'preset', name: 'My Pile', symbol: 'PILE', quote: '', raise: '1', buy: '1', sell: '1' };

export type FourRequest =
  | { kind: 'preset'; creator: Address; name: string; symbol: string; tokenUri: string; quote: Address; raiseAmount: string; buyFeeBps: number; sellFeeBps: number }
  | { kind: 'tax'; creator: Address; name: string; symbol: string; tokenUri: string; quote: Address; raiseAmount: string; taxBuyBps: number; taxSellBps: number }
  | {
      kind: 'tax-rules';
      creator: Address;
      name: string;
      symbol: string;
      tokenUri: string;
      quote: Address;
      raiseAmount: string;
      taxBuyBps: number;
      taxSellBps: number;
      creatorBps: number;
      pileBps: number;
      burnBps: number;
    };

export type FourRefusal = { field: keyof FourForm; text: string };

/** The signer's own bounds (its README's error table), checked here first so the visitor sees them at once. */
export function readFourForm(
  f: FourForm,
  creator: Address | undefined,
  quotes: readonly Address[],
  decimalsOf: (quote: string) => number | undefined = () => 18,
  /** SH-287: the creator's parts, where the deployment and the signer offer rules; a tax launch then asks for them. */
  rules?: RulesParts,
): { ok: true; body: FourRequest } | { ok: false; refusal: FourRefusal } {
  const no = (field: keyof FourForm, text: string) => ({ ok: false as const, refusal: { field, text } });
  if (!/^[A-Za-z0-9 .-]{1,32}$/.test(f.name)) return no('name', '1 to 32 letters, digits, spaces, dots or dashes.');
  if (!/^[A-Z0-9]{1,10}$/.test(f.symbol)) return no('symbol', '1 to 10 capital letters or digits.');
  if (!isAddress(f.quote) || !quotes.some((q) => q.toLowerCase() === f.quote.toLowerCase())) return no('quote', 'Choose a coin.');
  // The signer encodes the raise with 18 decimals, so only 18-decimal coins are offered (its allowlist is WBNB and tETH).
  if (decimalsOf(f.quote) !== 18) return no('quote', 'Choose a coin.');
  const raise = parseAmount(f.raise, 18);
  if (!raise.ok) return no('raise', 'Enter the raise.');
  const buy = parsePercentToBps(f.buy);
  const sell = parsePercentToBps(f.sell);
  if (f.kind === 'preset') {
    if (!buy.ok || buy.value > 1000n) return no('buy', 'From 0 to 10%.');
    if (!sell.ok || sell.value > 1000n) return no('sell', 'From 0 to 10%.');
    if (buy.value === 0n && sell.value === 0n) return no('sell', 'Not both 0.');
  } else {
    if (!buy.ok || buy.value > 1000n) return no('buy', 'From 0 to 10%.');
    if (!sell.ok || sell.value < 100n || sell.value > 1000n) return no('sell', 'From 1% to 10%.');
  }
  if (!creator) return no('name', 'Connect a wallet first.');
  const common = { creator, name: f.name, symbol: f.symbol, tokenUri: '', quote: f.quote as Address, raiseAmount: f.raise.trim() };
  if (f.kind === 'preset') return { ok: true, body: { kind: 'preset', ...common, buyFeeBps: Number(buy.ok ? buy.value : 0n), sellFeeBps: Number(sell.ok ? sell.value : 0n) } };
  const tax = { ...common, taxBuyBps: Number(buy.ok ? buy.value : 0n), taxSellBps: Number(sell.ok ? sell.value : 0n) };
  if (!rules) return { ok: true, body: { kind: 'tax', ...tax } };
  return { ok: true, body: { kind: 'tax-rules', ...tax, creatorBps: rules.creator, pileBps: rules.pile, burnBps: rules.burn } };
}

export interface FourSigned {
  createArgs: Hex;
  signature: Hex;
  requestId: string;
  validUntil: number;
}

/** The signer's refusal codes and the page's fixed text for each (its README's error table); never the answer's text. */
export const SIGNER_REFUSALS: Record<string, string> = {
  BAD_BODY: 'The signer refused the request.',
  UNKNOWN_FIELD: 'The signer refused the request.',
  BAD_KIND: 'The signer refused this kind of launch.',
  BAD_CREATOR: 'The signer refused this wallet.',
  BAD_NAME: 'The signer refused the name: 1 to 32 letters, digits, spaces, dots or dashes.',
  BAD_SYMBOL: 'The signer refused the symbol: 1 to 10 capital letters or digits.',
  BAD_URI: 'The signer refused the picture link.',
  BAD_QUOTE: 'The signer refused this coin.',
  BAD_RAISE: 'The signer refused the raise: it is outside the allowed range.',
  BAD_PRESET_FEES: 'The signer refused the fees: 0 to 10% each, not both 0.',
  BAD_TAX_FEES: 'The signer refused the tax: buy 0 to 10%, sell 1% to 10%.',
  BAD_RULES: 'The signer refused the parts: whole numbers that add up to 100.',
};

/**
 * Whether the signer offers the tax-rules kind (SH-287), asked the quiet way first (SH-303): its health answer
 * (`GET <base>api/four/health`), when it is a good answer (HTTP 2xx) that names its `kinds`, says it with no request
 * to the signing route. A signer
 * whose health names no kinds (before lane b's update) is asked by its refusal of a request that has only the kind:
 * one that offers it passes the kind and refuses the missing wallet (`BAD_CREATOR`); one that does not refuses the
 * kind (`BAD_KIND`). Nothing is signed either way. Each ask has SIGNER_ASK_MS. Anything else leaves the offer unknown.
 */
export const SIGNER_ASK_MS = 10_000;
export async function askSigner(signRoute: string, fetchFn: typeof fetch = fetch): Promise<boolean | undefined> {
  const healthUrl = signRoute.replace(/sign-create$/, 'health');
  try {
    const h = await fetchFn(healthUrl, { method: 'GET', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(SIGNER_ASK_MS) });
    const body = (await h.json().catch(() => null)) as { kinds?: unknown } | null;
    if (h.ok && body && Array.isArray(body.kinds)) return body.kinds.includes('tax-rules');
  } catch {
    // no health answer in time: ask the old way
  }
  try {
    const res = await fetchFn(signRoute, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'tax-rules' }),
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(SIGNER_ASK_MS),
    });
    const a = (await res.json().catch(() => null)) as { error?: unknown } | null;
    if (res.status === 400 && a?.error === 'BAD_CREATOR') return true;
    if (res.status === 400 && a?.error === 'BAD_KIND') return false;
    return undefined;
  } catch {
    return undefined;
  }
}
export async function signerOffersRules(signRoute: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  return (await askSigner(signRoute, fetchFn)) ?? false;
}

/**
 * The signer's answer kept for the visit of the site (one question per visit, never per render or poll). No answer is
 * not kept: the next visit to the create screen asks again.
 */
const offered = new Map<string, Promise<boolean | undefined>>();
export function signerOffersRulesOnce(signRoute: string, fetchFn: typeof fetch = fetch): Promise<boolean | undefined> {
  const had = offered.get(signRoute);
  if (had) return had;
  const asked = askSigner(signRoute, fetchFn).then((yes) => {
    if (yes === undefined) offered.delete(signRoute);
    return yes;
  });
  offered.set(signRoute, asked);
  return asked;
}
/** Forgets the kept answers (tests). */
export function forgetSignerOffer(): void {
  offered.clear();
}

/** The page's text for a signer's HTTP answer that is not a signature: its code's fixed text, or a plain refusal. */
export function signerRefusal(status: number, answer: unknown): string {
  const code = typeof answer === 'object' && answer !== null ? (answer as { error?: unknown }).error : undefined;
  if (status === 400 && typeof code === 'string' && Object.hasOwn(SIGNER_REFUSALS, code)) return SIGNER_REFUSALS[code]!;
  return 'The signer refused, so nothing was sent.';
}

/** The signer's answer, checked: bytes are bytes, it is for this creator and kind, and still valid. */
export function checkSigned(answer: unknown, body: FourRequest, nowSeconds: number): FourSigned | string {
  if (typeof answer !== 'object' || answer === null) return 'The signer gave no answer.';
  const a = answer as Record<string, unknown>;
  if (a.error !== undefined) return signerRefusal(400, answer);
  if (!isHex(a.createArgs) || !isHex(a.signature)) return 'The signer gave no signature.';
  if (typeof a.creator !== 'string' || a.creator.toLowerCase() !== body.creator.toLowerCase()) return 'The signature is for another wallet.';
  if (a.kind !== body.kind) return 'The signature is for another kind of launch.';
  if (typeof a.validUntil !== 'number' || a.validUntil <= nowSeconds) return 'The signature has expired.';
  return { createArgs: a.createArgs, signature: a.signature, requestId: String(a.requestId ?? ''), validUntil: a.validUntil };
}

/** Where the signer answers: on this page's own origin, under the build's base. */
export function signUrl(base: string): string {
  return `${base.endsWith('/') ? base : base + '/'}api/four/sign-create`;
}

/** One module parameter as OpenFour's Tools reports it (`getPresetEncodeSchemas`). */
export interface SchemaParam {
  name: string;
  abiType: string;
  decimals: number;
  optional: boolean;
  defaultValue: string;
}
export const MODULES = ['token', 'vault', 'curve', 'trade', 'migrate', 'customData'] as const;
export type Schemas = Record<(typeof MODULES)[number], SchemaParam[]>;

/** What the signer fixes for every launch (sign-create.js), and the ForwardVault type id of the tax preset. */
const SUPPLY = parseUnits('1000000000', 18);
const SALE = parseUnits('800000000', 18);
const VALID_SECONDS = 600n;
/** The signer dates its 10 minutes by its own clock; the chain's may differ by this much. */
const CLOCK_SLACK = 300n;
export const FORWARD_VAULT_TYPE_ID = keccak256(toBytes('SafuSkill.ForwardVault.v1'));

/** The rules template clone's own parameters (bounties/openfour sign-create.js RULES_TUPLE). */
const RULES_TUPLE: AbiParameter = {
  type: 'tuple',
  components: [
    { type: 'address', name: 'creator' },
    { type: 'uint16', name: 'creatorBps' },
    { type: 'uint16', name: 'pileBps' },
    { type: 'uint16', name: 'burnBps' },
  ],
};

const INIT_PARAMS: AbiParameter = {
  type: 'tuple',
  name: 'initParams',
  components: [
    { type: 'string', name: 'name' },
    { type: 'string', name: 'symbol' },
    { type: 'string', name: 'tokenUri' },
    { type: 'uint256', name: 'maxSupply' },
    { type: 'uint256', name: 'saleAmount' },
    { type: 'uint256', name: 'raiseAmount' },
    { type: 'address', name: 'quoteAsset' },
    { type: 'bytes32', name: 'tokenSalt' },
    { type: 'bytes', name: 'tokenParams' },
    { type: 'bytes', name: 'vaultParams' },
    { type: 'bytes', name: 'curveParams' },
    { type: 'bytes', name: 'tradeParams' },
    { type: 'bytes', name: 'migrateParams' },
    { type: 'bytes', name: 'customDataParams' },
  ],
};
const CREATE_ARGS: AbiParameter[] = [
  {
    type: 'tuple',
    components: [
      { type: 'uint256', name: 'requestId' },
      { type: 'uint256', name: 'presetId' },
      { type: 'uint256', name: 'validTimestamp' },
      { type: 'uint256', name: 'createFee' },
      { type: 'uint256', name: 'presaleQuote' },
      { type: 'bool', name: 'antiSniperEnabled' },
      { type: 'address', name: 'partner' },
      INIT_PARAMS,
    ],
  },
];

function zeroValue(abiType: string): unknown {
  if (abiType.endsWith('[]')) return [];
  if (abiType === 'address') return zeroAddress;
  if (abiType === 'bool') return false;
  if (abiType === 'bytes32') return zeroHash;
  if (abiType === 'bytes') return '0x';
  if (abiType === 'string') return '';
  return 0n;
}

/** One module's parameters from its on-chain schema: our values first, then the schema's defaults (as the signer does). */
export function encodeModule(params: readonly SchemaParam[], values: Record<string, unknown>): Hex {
  if (!params.length) return '0x';
  const out = params.map((p) => {
    let raw = values[p.name];
    if (raw === undefined || raw === null || String(raw) === '') raw = p.defaultValue;
    if (raw === undefined || raw === null || String(raw) === '') {
      if (p.optional) return zeroValue(p.abiType);
      throw new Error(`the schema needs ${p.name}`);
    }
    const v = String(raw);
    if (p.abiType === 'bool') return v === 'true' || v === '1';
    if (['address', 'string', 'bytes32', 'bytes'].includes(p.abiType)) return v;
    return Number(p.decimals) > 0 ? parseUnits(v, Number(p.decimals)) : BigInt(v);
  });
  return encodeAbiParameters([{ type: 'tuple', components: params.map((p) => ({ type: p.abiType })) }], [out]);
}

/** The terms a launch with this form must carry: the deployment's preset (and for a tax launch our template). */
export interface ExpectedTerms {
  body: FourRequest;
  presetId: bigint;
  template?: Address;
  schemas: Schemas;
  quoteDecimals: number;
}

/** The createArgs the signer must have signed for these terms, with the request id and validity it chose. */
export function expectedCreateArgs(t: ExpectedTerms, requestId: bigint, validTimestamp: bigint): Hex {
  const b = t.body;
  const values: Record<string, unknown> =
    b.kind === 'preset'
      ? { buyFeeBps: b.buyFeeBps, sellFeeBps: b.sellFeeBps }
      : {
          founder: b.creator,
          buyFeeRate: b.taxBuyBps,
          sellFeeRate: b.taxSellBps,
          rateFounder: 100,
          rateHolder: 0,
          rateBurn: 0,
          rateLiquidity: 0,
          minShare: 10000,
          taxVaultTypeId: FORWARD_VAULT_TYPE_ID,
          // tax-rules: the clone's parameters are the creator's rules, the creator part paid to the requester
          taxVaultInitParams: encodeAbiParameters(
            [{ type: 'tuple', components: [{ type: 'address' }, { type: 'bytes' }] }],
            [[t.template!, b.kind === 'tax-rules' ? encodeAbiParameters([RULES_TUPLE], [[b.creator, b.creatorBps, b.pileBps, b.burnBps]]) : '0x']],
          ),
        };
  const m = (k: (typeof MODULES)[number]) => encodeModule(t.schemas[k], values);
  return encodeAbiParameters(CREATE_ARGS, [
    [
      requestId,
      t.presetId,
      validTimestamp,
      0n,
      0n,
      false,
      zeroAddress,
      [b.name, b.symbol, b.tokenUri, SUPPLY, SALE, parseUnits(b.raiseAmount, t.quoteDecimals), b.quote, zeroHash, m('token'), m('vault'), m('curve'), m('trade'), m('migrate'), m('customData')],
    ],
  ]);
}

/**
 * The signed bytes, decoded and compared with the form and the deployment before anything is simulated: every value
 * (name, symbol, coin, raise in the coin's own decimals, fees, preset, the fixed supply and fees, for a tax launch our
 * template) must be the one the form asked for, and the validity must lie ahead of the chain's time by at most the
 * signer's 10 minutes. Returns the refusal text, or null.
 */
export function checkCreateArgs(createArgs: Hex, t: ExpectedTerms, chainNow: bigint): string | null {
  if (t.body.kind !== 'preset' && !t.template) return 'This page has no tax template, so nothing was sent.';
  let requestId: bigint;
  let validTimestamp: bigint;
  try {
    const [d] = decodeAbiParameters(CREATE_ARGS, createArgs) as unknown as [{ requestId: bigint; validTimestamp: bigint }];
    requestId = d.requestId;
    validTimestamp = d.validTimestamp;
  } catch {
    return 'The signed launch could not be read, so nothing was sent.';
  }
  if (requestId === 0n) return 'The signed launch could not be read, so nothing was sent.';
  if (validTimestamp <= chainNow || validTimestamp > chainNow + VALID_SECONDS + CLOCK_SLACK) return 'The signature is not valid now, so nothing was sent.';
  let expected: Hex;
  try {
    expected = expectedCreateArgs(t, requestId, validTimestamp);
  } catch {
    return 'The signed launch could not be read, so nothing was sent.';
  }
  return expected.toLowerCase() === createArgs.toLowerCase() ? null : 'The signed launch differs from this form, so nothing was sent.';
}

/** The validity the signer chose (decoded from the signed bytes), for the check when the creation goes to the wallet. */
export function validTimestampOf(createArgs: Hex): bigint {
  const [d] = decodeAbiParameters(CREATE_ARGS, createArgs) as unknown as [{ validTimestamp: bigint }];
  return d.validTimestamp;
}
