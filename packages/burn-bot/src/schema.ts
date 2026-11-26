import { z } from 'zod';
import { safeConfigV2Schema } from '../../chain/src/core/v2/safe-config-v2';
import { isAddress, type Address, type Hex } from 'viem';

export const uint = z.union([z.bigint(), z.string().regex(/^(0|[1-9][0-9]*)$/).transform(BigInt)])
  .refine(n => n >= 0n && n < 2n ** 256n, 'unsigned uint256 required');
export const positive = uint.refine(n => n > 0n, 'positive amount required');
export const address = z.string().refine(s => isAddress(s, { strict: true }), 'invalid address')
  .transform(s => s.toLowerCase() as Address);
export const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(s => s.toLowerCase() as Hex);
export const hex = z.string().regex(/^0x([0-9a-fA-F]{2})*$/).transform(s => s.toLowerCase() as Hex);
export const label = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,200}$/);
// F164 D2: the bot has one Safe. Platform and conversion roles are retired and refused.
export const roleSchema = z.enum(['fit']);
export const blockSchema = z.strictObject({ number: uint, hash, timestamp: uint });
export const sourceSchema = z.strictObject({ txHash: hash, logIndex: uint, blockNumber: uint, blockHash: hash, timestamp: uint });
export const decimalsSchema = z.string().regex(/^(6|7|8|9|1[0-8])$/);
export const boxSchema = z.strictObject({ id: z.string().regex(/^(0|[1-9][0-9]*)$/), receiver: address, p: address });
const routeCommon = {
  id: label, version: label, tokenIn: address, tokenOut: address,
  maxInput: positive, maxDailyInput: positive, slippageBps: uint.refine(n => n < 10000n), quoteLifetime: positive,
};
export const routeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...routeCommon, kind: z.literal('v4'), router: address, codeHash: hash,
    routerVersion: z.enum(['UniversalRouter-v2', 'UniversalRouter-v2-per-hop-price']), permit2: address, permit2CodeHash: hash,
    path: z.array(z.strictObject({ intermediateCurrency: address,
      fee: z.string().regex(/^(0|[1-9][0-9]*)$/).refine(v => BigInt(v) <= 1000000n || v === '8388608'),
      tickSpacing: z.string().regex(/^[1-9][0-9]*$/).refine(v => BigInt(v) <= 32767n),
      hooks: address, hookData: hex,
    })).min(1).max(4),
  }),
  z.strictObject({ ...routeCommon, kind: z.literal('v3'), router: address, codeHash: hash,
    routerVersion: z.literal('SwapRouter-v1'), path: z.array(address).min(2).max(5),
    fees: z.array(z.union([z.number().int().min(1).max(999999),
      z.string().regex(/^[1-9][0-9]{0,5}$/).transform(v => parseInt(v, 10))])).min(1).max(4) }),
  z.strictObject({ ...routeCommon, kind: z.literal('unwrap'), router: address, codeHash: hash, routerVersion: z.literal('SwapRouter02') }),
]);
export const box0Schema = z.strictObject({ coordinator: address, executor: address, fit: address });
export const manifestSchema = z.strictObject({
  policyVersion: label, chainId: positive,
  safes: z.strictObject({ fit: address }),
  owners: z.strictObject({ bot: address, founder: address, backup: address }),
  safeConfigs: z.strictObject({ fit: safeConfigV2Schema }),
  multiSend: z.strictObject({ address, codeHash: hash, version: z.literal('1.4.1-call-only') }),
  weth: address, wethCodeHash: hash, box0: box0Schema, boxes: z.array(boxSchema), routes: z.array(routeSchema),
  assetDecimals: z.record(address, decimalsSchema),
  limits: z.strictObject({ maxActionsPerDay: positive, maxGasPerDay: positive, transactionGas: positive, maxFeePerGas: positive }),
});
export const snapshotSchema = z.strictObject({
  chainId: positive, block: blockSchema, canonical: z.literal(true), finalized: z.literal(true),
  quoteBlocks: z.array(blockSchema).optional(),
  safe: address, singleton: address, nonce: uint, owners: z.array(address), threshold: positive, version: z.string(),
  modules: z.array(address), guard: address, fallbackHandler: address,
  codeHashes: z.record(address, hash), balances: z.record(address, uint),
  box0: box0Schema.extend({ graduated: z.boolean(), failed: z.boolean() }),
  boxes: z.array(boxSchema.extend({ phase: z.enum(['pre-graduation', 'graduated', 'failed']) })),
});
export const lotSchema = z.strictObject({
  id: label, role: roleSchema, chainId: positive, safe: address, asset: address, amount: positive,
  decimals: decimalsSchema, boxId: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(), receiver: address.nullable(),
  kind: z.enum(['fee', 'proceeds']), source: sourceSchema,
});
// Backlog amounts retain provenance without inventing metadata for foreign assets.
export const quarantineSchema = lotSchema.omit({ decimals: true }).extend({ decimals: decimalsSchema.optional() });
export const quarantineReasonSchema = z.enum(['unattributed', 'unsupported-asset', 'unsupported-route', 'forward-pending', 'paused-token']);
export const quoteSchema = z.strictObject({ chainId: positive, routeId: label, routeVersion: label, tokenIn: address,
  tokenOut: address, amountIn: positive, quotedOut: positive, block: blockSchema, deadline: positive });
const actionCommon = { lotId: label, amount: positive };
export const actionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...actionCommon, kind: z.literal('sale'), routeId: label, quote: quoteSchema }),
  z.strictObject({ ...actionCommon, kind: z.literal('fund') }),
  z.strictObject({ ...actionCommon, kind: z.literal('burn') }),
]);

export function requireThat(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

export function present<T>(value: T | null | undefined, reason: string): T {
  requireThat(value !== null && value !== undefined, reason); return value;
}
