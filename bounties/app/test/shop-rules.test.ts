import { afterEach, describe, expect, it } from 'vitest';
import type { Address, PublicClient } from 'viem';
import { checkConfig } from '../src/lib/config';
import { forgetScans } from '../src/lib/logs';
import { flapCreatorOf, flapRulesLauncherOf, flapRulesPayees, linkedShops } from '../src/lib/shop';
import { forgetOrigins } from '../src/lib/flap-origin';

// SH-281 step 3: the link from a Flap RULES sale to its shop, and the shop page's view of who launched the token.
const A = (n: string) => `0x${n.padStart(40, '0')}` as Address;
const SHOPS = A('f1');
const RVF = A('e1'); // the deployment file's rules vault factory (token pair)
const RLF = A('e2'); // the rules pair's launcher factory
const LAUNCHER = A('d1');
const TOKEN = A('b1');
const CREATOR = A('c1');
const SHOP = A('a1'); // our factory's shop for TOKEN, named by a rule
const STRANGER_SHOP = A('a9'); // someone else's contract that says it is TOKEN's shop
const OTHER_TOKEN_SHOP = A('a3'); // our factory's shop, for another token
const config = (() => {
  const r = checkConfig({
    chainId: 97,
    rpcUrls: ['https://bsc-testnet-rpc.publicnode.com'],
    explorer: 'https://testnet.bscscan.com',
    fromBlock: '1',
    shops: { factory: SHOPS },
    flap: { portal: A('11'), tokenImpl: A('12'), pileVaultFactory: A('13'), curveLauncherFactory: A('14'), sales: [], rules: { token: { launcherFactory: RLF, rulesVaultFactory: RVF } } },
  });
  if (!r.ok) throw new Error(r.problem);
  return r.value;
})();

type Q = { address: string; functionName?: string; eventName?: string; args?: unknown };
function client(rules: { kind: number; bps: number; target: Address }[]): PublicClient {
  return {
    getBlockNumber: async () => 100n,
    readContract: async (q: Q & { args?: unknown[] }) => {
      const a = q.address.toLowerCase();
      if (a === RVF.toLowerCase() && q.functionName === 'rulesOf') return rules;
      if (a === SHOPS.toLowerCase() && q.functionName === 'isShop') return [SHOP, OTHER_TOKEN_SHOP].some((s) => s.toLowerCase() === String(q.args![0]).toLowerCase());
      if (q.functionName === 'token') {
        if (a === SHOP.toLowerCase() || a === STRANGER_SHOP.toLowerCase()) return TOKEN;
        if (a === OTHER_TOKEN_SHOP.toLowerCase()) return A('b9');
      }
      if (q.functionName === 'shopCountBy') return 0n;
      // the sale and its factory (SH-303: the sale's maker proven by the factory's own address prediction)
      if (a === LAUNCHER.toLowerCase() && q.functionName === 'factory') return RLF;
      if (a === LAUNCHER.toLowerCase() && q.functionName === 'creator') return CREATOR;
      if (a === LAUNCHER.toLowerCase() && q.functionName === 'config') return { salt: '0x' + '11'.repeat(32) };
      if (a === RLF.toLowerCase() && q.functionName === 'predictLauncher') return LAUNCHER;
      throw new Error(`execution reverted: ${q.functionName} at ${q.address}`);
    },
    // the tab's one scan of creation events (lib/launch-events.ts)
    getLogs: async (q: { address: string[] }) =>
      q.address.some((x) => x.toLowerCase() === RVF.toLowerCase()) ? [{ address: RVF, eventName: 'RulesVaultCreated', blockNumber: 5n, args: { token: TOKEN, launcher: LAUNCHER } }] : [],
  } as unknown as PublicClient;
}

afterEach(() => {
  forgetScans();
  forgetOrigins();
});

describe('a Flap rules sale and its shop', () => {
  const rules = [
    { kind: 1, bps: 2000, target: CREATOR },
    { kind: 2, bps: 3000, target: A('0') },
    { kind: 1, bps: 3000, target: SHOP },
    { kind: 3, bps: 2000, target: A('0') },
  ];
  it("the sale's payees come from the deployment's rules vault factory: the paying rules' targets, in order", async () => {
    expect(await flapRulesPayees(client(rules), RVF, LAUNCHER)).toEqual([CREATOR, SHOP]);
    expect(await flapRulesPayees(client([]), RVF, LAUNCHER)).toEqual([]);
    expect(await flapRulesPayees(client(rules), A('99'), LAUNCHER)).toBeNull(); // a factory that does not answer
  });
  it('a rules sale whose rule names a shop links exactly that shop', async () => {
    const c = client(rules);
    expect(await linkedShops(c, config, TOKEN, { payees: await flapRulesPayees(c, RVF, LAUNCHER), creator: CREATOR })).toEqual([SHOP]);
  });
  it("a stranger's shop for the same token is never linked, nor our shop for another token", async () => {
    const strangerRules = [{ kind: 1, bps: 5000, target: STRANGER_SHOP }, { kind: 1, bps: 2500, target: OTHER_TOKEN_SHOP }, { kind: 2, bps: 2500, target: A('0') }];
    const c = client(strangerRules);
    expect(await linkedShops(c, config, TOKEN, { payees: await flapRulesPayees(c, RVF, LAUNCHER), creator: CREATOR })).toEqual([]);
  });
  it("a rules sale's creator is found (the rules pair's launcher factory), and the shop page finds the sale from the token", async () => {
    const c = client(rules);
    expect(await flapCreatorOf(c, config, LAUNCHER)).toBe(CREATOR);
    expect(await flapRulesLauncherOf(c, config, TOKEN)).toBe(LAUNCHER);
    expect(await flapRulesLauncherOf(c, config, A('b9'))).toBe(null);
  });
  it('without a rules pair in the deployment file: no rules sale is found (as before)', async () => {
    const plain = checkConfig({ chainId: 97, rpcUrls: ['https://bsc-testnet-rpc.publicnode.com'], explorer: 'https://testnet.bscscan.com', fromBlock: '1', flap: { portal: A('11'), tokenImpl: A('12'), pileVaultFactory: A('13'), curveLauncherFactory: A('14'), sales: [] } });
    if (!plain.ok) throw new Error(plain.problem);
    expect(await flapCreatorOf(client(rules), plain.value, LAUNCHER)).toBe(null);
    expect(await flapRulesLauncherOf(client(rules), plain.value, TOKEN)).toBe(null);
  });
});
