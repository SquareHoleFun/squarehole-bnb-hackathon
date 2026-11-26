import { z, isAddress, lower, need, ZERO, BURN_SELECTOR } from './common.mjs';

const address = z.string().refine(v => isAddress(v, { strict: true })).transform(lower);
const nonzero = address.refine(v => v !== ZERO);
const uint = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine(v => BigInt(v) < 1n << 256n);
const positive = uint.refine(v => BigInt(v) > 0n);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(lower);
const pin = z.strictObject({ address: nonzero, codeHash: hash });
const token = z.strictObject({ token: nonzero, class: z.enum(['STABLE', 'STOCK', 'OTHER']),
  burnSelector: z.literal(BURN_SELECTOR).optional(), referenceAmount: positive.optional() });
const policy = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('native-twap'), ethRaise: positive.optional(),
    rounding: z.strictObject({ increment: positive, mode: z.enum(['up', 'down', 'nearest']) }).optional() }),
  z.strictObject({ kind: z.literal('fixed'), amounts: z.record(address, positive) }),
]);
const schema = z.strictObject({
  chainId: z.enum(['1', '11155111', '31337']), rpcEnv: z.literal('LISTING_RPC'),
  registry: pin, safe: nonzero, multiSend: pin, weth: nonzero,
  tokens: z.array(token).min(1).max(1000), bridges: z.array(nonzero).max(12).default([]),
  referenceAmount: positive, scanFromBlock: uint, logChunk: positive.refine(v => BigInt(v) <= 10000n),
  maxScanBlocks: positive.refine(v => BigInt(v) <= 1000000n).default('100000'),
  raisePolicy: policy.default({ kind: 'native-twap' }),
  routePolicy: z.strictObject({ maxDailyInput: positive, slippageBps: uint.refine(v => BigInt(v) < 10000n), quoteLifetime: positive }),
  market: z.strictObject({
    v2: z.strictObject({ factory: pin }),
    v3: z.strictObject({ factory: pin, quoter: pin, router: pin, fees: z.array(positive.refine(v => BigInt(v) < 1000000n)).min(1).max(16) }),
    v4: z.strictObject({ manager: pin, stateView: pin, quoter: pin, router: pin, permit2: pin, fromBlock: uint, allowedHooks: z.array(nonzero).max(100).default([]) }),
  }),
});
export function parseInput(input, allowMainnet = false) {
  need(['1', '11155111', '31337'].includes(input?.chainId), 'unsupported listing chain');
  need(input.chainId !== '1' || allowMainnet === true, 'mainnet requires --allow-mainnet');
  let config;
  try { config = schema.parse(input); } catch { throw new Error('invalid public listing input'); }
  need(new Set(config.tokens.map(t => t.token)).size === config.tokens.length, 'duplicate token');
  need(new Set(config.bridges).size === config.bridges.length, 'duplicate bridge');
  need(new Set(config.market.v3.fees).size === config.market.v3.fees.length, 'duplicate fee tier');
  need(config.tokens.every(t => BigInt(t.referenceAmount ?? config.referenceAmount) <= BigInt(config.routePolicy.maxDailyInput)), 'reference amount exceeds daily route limit');
  need(config.safe !== config.registry.address && config.safe !== config.multiSend.address, 'overlapping infrastructure');
  return config;
}
