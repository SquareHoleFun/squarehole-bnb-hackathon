import { toHex, type Address, type PublicClient } from 'viem';
import { ViemChain } from '../../src/chain';
import { emptyMemory, plan } from '../../src/plan';
import { addr, keeper, options, quiet, time } from './v2';

export const parts = { registry: addr(90), factory: addr(91), co: addr(1), hook: addr(2), receiver: addr(3),
  vault: addr(30), router: addr(6), ledger: addr(16), asset: addr(8) };
export const YEAR = 31_536_000n;
export function m3Fixture() {
  const s = { block: 100n, now: time, failed: false, graduated: true, gate: true,
    funding: 50n, lifecycle: 40n, processedFunding: 0n, processedLifecycle: 0n, pendingCaughtUp: false,
    residue: 7n, credit: 10n ** 24n, item: true, wiring: true, pile: false, sameFactory: true,
    seed: 10n ** 24n, asset: parts.asset as Address, pendingSeed: true, seedReturn: 10n ** 24n,
    failedAt: time - YEAR, pot: 100n, left: 20n, duplicates: false,
    broken: new Set<string>(), simulations: [] as string[],
    reads: [] as { fn: string; blockNumber?: bigint; blockTag?: string }[] };
  const client = {
    getChainId: async () => 11155111,
    request: async () => ({ number: toHex(s.block), timestamp: toHex(s.now), baseFeePerGas: '0x1' }),
    getBlock: async () => ({ number: s.block, timestamp: s.now, baseFeePerGas: 1n, gasLimit: 30_000_000n }),
    getLogs: async () => s.duplicates ? [{ args: { token: parts.asset } }, { args: { token: parts.asset } }] : [],
    getBytecode: async () => '0x',
    readContract: async (r: { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint; blockTag?: string }) => {
      const { functionName: fn, args = [] } = r;
      s.reads.push({ fn, blockNumber: r.blockNumber, blockTag: r.blockTag });
      if (s.broken.has(fn)) throw new Error(`unavailable ${fn}`);
      switch (fn) {
        case 'boxCount': return 1n;
        case 'roleOf': return ({ 0: parts.co, 1: addr(10), 2: parts.hook, 3: parts.vault, 5: parts.receiver,
          6: parts.router, 16: s.item ? parts.ledger : addr(0), 19: s.pile && s.seed > 0n ? parts.vault : addr(0) } as Record<string, Address>)[String(args[1])] ?? addr(0);
        case 'factory': return r.address === parts.co && !s.sameFactory ? addr(92) : parts.factory;
        case 'isPileVault': return s.pile;
        case 'poolId': return `0x${'11'.repeat(32)}`;
        case 'poolManager': return addr(50);
        case 'q': return addr(0);
        case 'graduated': return s.graduated;
        case 'failed': return s.failed;
        case 'gateOpen': return s.gate;
        case 'closed': case 'graduationSettled': return true;
        case 'openAt': case 'closedAt': return time - 10n;
        case 'deadline': return time + 1000n;
        case 'failedAt': return s.failedAt;
        case 'claimState': return [s.pot, s.left];
        case 'itemLedger': return s.wiring ? parts.ledger : addr(99);
        case 'itemFundingCount': return s.funding;
        case 'itemLifecycleCount': return s.lifecycle;
        case 'fundingCursor': return r.blockTag === 'pending' && s.pendingCaughtUp ? s.funding : s.processedFunding;
        case 'lifecycleCursor': return r.blockTag === 'pending' && s.pendingCaughtUp ? s.lifecycle : s.processedLifecycle;
        case 'asset': return s.asset;
        case 'seedAmount': return s.seed;
        case 'starterSetPending': return s.pendingSeed;
        default: return 0n;
      }
    },
    simulateContract: async ({ functionName: fn }: { functionName: string }) => {
      s.simulations.push(fn);
      if (s.broken.has(`simulate:${fn}`)) throw new Error('temporarily unavailable');
      if (fn === 'collect') return { result: { buyersP: 0n, sellersP: 0n, qToReserve: 0n, tip: 0n } };
      if (fn === 'sync' || fn === 'loadSeed') return { result: undefined };
      if (fn === 'flushResidue') return { result: s.residue };
      if (fn === 'returnSeed') return { result: s.seedReturn };
      return { result: 0n };
    },
    estimateGas: async () => 100_000n,
  } as unknown as PublicClient;
  const cfg = { ...options(), boxRegistry: parts.registry, priorityFeeWei: 1n };
  const restart = () => new ViemChain(cfg, client, keeper, { public: null, private: null }, null, quiet);
  const chain = restart();
  const candidates = async () => plan(await chain.read(), emptyMemory(), cfg).candidates;
  return { s, chain, cfg, restart, candidates };
}
