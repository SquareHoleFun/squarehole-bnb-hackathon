/**
 * SH-303: which of OUR Flap launcher factories made a sale, proven with three reads instead of scanning the factories'
 * creation events from the deployment's first block. A launcher is a clone the factory deploys at a deterministic
 * address (CREATE2 from the factory, `predictLauncher(creator, salt)`); the sale names its factory, its creator and
 * its salt, and the named factory must, for that creator and salt, predict exactly this address. Only the factory
 * itself can have deployed a contract there. The factory must be one of the deployment file's: the plain pair (native,
 * token quote) or a rules pair's launcher factory. The answer does not change, so it is kept for the visit.
 */
import type { Address, PublicClient } from 'viem';
import { curveFactoryAbi, curveLauncherAbi } from '../abi/flap';
import type { AppConfig, FlapRulesPair } from './config';
import { decodeError } from './errors';

export interface FlapOrigin {
  origin: 'native' | 'token';
  rules?: FlapRulesPair;
  creator: Address;
}

/** The deployment file's launcher factories: which kind of sale each makes, and its rules pair if it is one's. */
export function ourLauncherFactories(config: AppConfig): { factory: Address; origin: 'native' | 'token'; rules?: FlapRulesPair }[] {
  const f = config.flap;
  if (!f) return [];
  return [
    { factory: f.curveLauncherFactory, origin: 'native' as const },
    ...(f.tokenQuote ? [{ factory: f.tokenQuote.launcherFactory, origin: 'token' as const }] : []),
    ...(f.rules?.native ? [{ factory: f.rules.native.launcherFactory, origin: 'native' as const, rules: f.rules.native }] : []),
    ...(f.rules?.token ? [{ factory: f.rules.token.launcherFactory, origin: 'token' as const, rules: f.rules.token }] : []),
  ];
}

const proven = new Map<string, FlapOrigin | null>();

/** Forgets the kept answers (tests). */
export function forgetOrigins(): void {
  proven.clear();
}

/**
 * The sale's origin, or null when no factory of the file made it. Kept for the visit only when the three reads were
 * answered (a proof, a named factory that is not ours, or a prediction that differs). A read that failed is never kept:
 * an endpoint failure is thrown (the caller says it could not check), and a revert is "not ours" for this round only
 * (an endpoint's internal error can reach here dressed as a revert), so the next round asks again.
 */
export async function flapOriginOf(c: PublicClient, config: AppConfig, launcher: Address): Promise<FlapOrigin | null> {
  const key = `${config.flap?.curveLauncherFactory ?? ''}|${launcher.toLowerCase()}`;
  if (proven.has(key)) return proven.get(key)!;
  let named: Address, creator: Address, cfg: { salt: `0x${string}` };
  try {
    [named, creator, cfg] = await Promise.all([
      c.readContract({ address: launcher, abi: curveLauncherAbi, functionName: 'factory' }) as Promise<Address>,
      c.readContract({ address: launcher, abi: curveLauncherAbi, functionName: 'creator' }) as Promise<Address>,
      c.readContract({ address: launcher, abi: curveLauncherAbi, functionName: 'config' }) as Promise<{ salt: `0x${string}` }>,
    ]);
  } catch (e) {
    // a revert or no code: not ours this round, never kept; a failed endpoint is thrown on
    if (decodeError(e).name === 'unknown') throw e;
    return null;
  }
  const ours = ourLauncherFactories(config).find((x) => x.factory.toLowerCase() === named.toLowerCase());
  let answer: FlapOrigin | null = null;
  if (ours) {
    // both factory kinds share predictLauncher(address creator, bytes32 salt)
    const predicted = (await c.readContract({ address: ours.factory, abi: curveFactoryAbi, functionName: 'predictLauncher', args: [creator, cfg.salt] })) as Address;
    if (predicted.toLowerCase() === launcher.toLowerCase()) answer = { origin: ours.origin, ...(ours.rules ? { rules: ours.rules } : {}), creator };
  }
  proven.set(key, answer);
  return answer;
}
