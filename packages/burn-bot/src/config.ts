import { z } from 'zod';
import { validateManifest } from './builders';
import { address, hash, label, manifestSchema, positive, requireThat, uint } from './schema';

const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
export const quoterSchema = z.strictObject({ routeId: label, address, codeHash: hash, kind: z.enum(['v3', 'v4']) });
export type QuoterConfig = z.output<typeof quoterSchema>;
export const runnerConfigSchema = z.strictObject({
  manifest: manifestSchema, rpcEnv: envName, serviceEnv: envName,
  startBlock: uint, logChunk: positive.refine(n => n <= 10000n), maxScanBlocks: positive,
  journal: z.string().min(1).refine(v => !v.includes('://') && !v.includes('\0')),
  quoters: z.array(quoterSchema),
});
export type RunnerConfig = z.output<typeof runnerConfigSchema>;
export function requireChain(chainId: bigint, allowMainnet = false) {
  requireThat(chainId !== 1n || allowMainnet, 'mainnet requires --allow-mainnet');
}
export function parseRunnerConfig(input: unknown, allowMainnet = false): RunnerConfig {
  const c = runnerConfigSchema.parse(input);
  requireChain(c.manifest.chainId, allowMainnet);
  c.manifest = validateManifest(c.manifest);
  requireThat(new Set(c.quoters.map(q => q.routeId)).size === c.quoters.length, 'duplicate quoter');
  return c;
}
