import { isAddress, zeroAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import record from './coin-deployment.json' with { type: 'json' };
import { isTradeChain, requireTrade } from './trade';

const address = z.string().refine(a => isAddress(a) && a !== zeroAddress).transform(a => a as Address);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(h => h as Hex);
const contract = z.object({ address, codeHash: hash.nullable() }).strict();
const schema = z.object({
  // SH-258: 97 is BNB Chain testnet's record (coin-deployment-97.json, written by its deploy runbook).
  chainId: z.union([z.literal(31337), z.literal(11155111), z.literal(97)]), status: z.enum(['predicted', 'deployed']),
  teth: contract, pairHelper: contract, poolManager: address, poolSwapTest: address, poolSwapTestCodeHash: hash,
  pairs: z.array(z.object({ coin: address, symbol: z.string().min(1), decimals: z.number().int().min(0).max(255),
    fee: z.literal('3000'), tickSpacing: z.literal(60), hooks: z.literal(zeroAddress),
    tickLower: z.literal(-887220), tickUpper: z.literal(887220) }).strict()),
}).strict();
export type CoinDeployment = Readonly<Omit<z.infer<typeof schema>, 'pairs' | 'teth' | 'pairHelper'> & {
  readonly teth: Readonly<z.infer<typeof contract>>;
  readonly pairHelper: Readonly<z.infer<typeof contract>>;
  readonly pairs: readonly Readonly<z.infer<typeof schema>['pairs'][number]>[];
}>;

/** Parse and copy the trusted deployment record; caller mutation cannot change prepared authority. */
export function parseCoinDeployment(value: unknown): CoinDeployment {
  const parsed = schema.safeParse(value);
  requireTrade(parsed.success, 'invalid_deployment');
  const d = parsed.data;
  const addresses = [d.teth.address, d.pairHelper.address, d.poolManager, d.poolSwapTest, ...d.pairs.map(p => p.coin)];
  requireTrade(new Set(addresses.map(a => a.toLowerCase())).size === addresses.length, 'invalid_deployment');
  requireTrade(d.status === 'predicted' || d.teth.codeHash && d.pairHelper.codeHash, 'invalid_deployment');
  return Object.freeze({ ...d, teth: Object.freeze(d.teth), pairHelper: Object.freeze(d.pairHelper), pairs: Object.freeze(d.pairs.map(p => Object.freeze(p))) });
}
export const SEPOLIA_COIN_DEPLOYMENT = parseCoinDeployment(record);

export function coinDeployment(chainId: number, local: unknown): CoinDeployment {
  requireTrade(isTradeChain(chainId), 'chain_not_allowed');
  requireTrade(chainId === 11155111 || local, 'deployment_required');
  const d = chainId === 11155111 ? SEPOLIA_COIN_DEPLOYMENT : parseCoinDeployment(local);
  requireTrade(d.chainId === chainId, 'deployment_chain_mismatch');
  requireTrade(d.status === 'deployed', 'deployment_predicted');
  return d;
}
