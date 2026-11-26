// @vitest-environment node
/**
 * SH-289: the launch cards' reads (copied from the launch page): the deployment file, the windows of the event reads,
 * which launches there are, each card's words, and at most two reads at a time.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { MIN_WINDOW, WINDOW, amount, inTwos, listLaunches, parseLaunchConfig, readEvents, readFourCard, readLaunchCards, type LaunchConfig } from './launch-reads';
import { fourKind, readRulesLine, rulesLine } from './launch-rules';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const FILE = JSON.parse(readFileSync(resolve(ROOT, 'bounties/app/public/addresses.json'), 'utf8')) as unknown;
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
/** SH-304 step 3: a rule line as the card holds it: non-breaking spaces inside each part, " · " between parts. */
const nb = (line: string) => line.split(' · ').map((p) => p.replace(/ /g, '\u00a0')).join(' · ');

describe('the deployment file (the launch page\'s own)', () => {
  it('reads the entries the cards need from the committed file', () => {
    const c = parseLaunchConfig(FILE);
    expect(c.fromBlock).toBe(144770777n);
    expect(c.flap?.curveLauncherFactory).toBe('0x151e43d81b3Ac5DBf566A1d01B5674cc2C4c7594');
    expect(c.flap?.sales).toEqual(['0x4938E88Ecf39A4549a38B858a4D02D2326D91D8d']);
    expect(c.flap?.tokenQuote?.sales).toEqual(['0xEc913d94Cb34df026Ee724E7084275196fE83493']);
    expect(c.openfour?.presetIds).toEqual([1778027700001n, 1778027615723n]);
    // Three since the real run of 26 November 2026: the preset launch, the tax launch and Snip, the launch with rules.
    expect(c.openfour?.tokens).toHaveLength(3);
    expect(c.openfour?.tokens[2]).toBe('0xdc787179a96bC8A826F5D5b618B6361c90e4215A');
    // SH-304: the two rules pairs since 26 November 2026, and the factories that prove a payee's name. SH-315: each
    // pair with the launches made through it, as the file names them (Sweet Jar; Pay Packet and Swap Deck).
    expect(c.flap?.rules).toEqual({
      native: { launcherFactory: '0x45A2BCDc29E379585e3D424FbA0c8a290FDe2560', rulesVaultFactory: '0x114Fa92D802dF51701E1A8888c37628949504391',
        sales: ['0x04Ed9202ffb8eb40971D6e07ca3F94F2db659A62'] },
      token: { launcherFactory: '0xD09d3D40EB9FC16B347D2778df918F33523A4C78', rulesVaultFactory: '0x0dbcdB88eF74bF55037e50Fa156fFDFfc3dAEd60',
        sales: ['0x7592b6a20254C0f6EB4919b02dA18f47C3E16689', '0x915A7aC8180B80153070eCD589d9020af05C1f82'] },
    });
    // SH-315: Snip's picture link, named in the file for when its creation event is not returned.
    expect(c.openfour?.tokenUris).toEqual({ '0xdc787179a96bc8a826f5d5b618b6361c90e4215a': 'https://arweave.net/NsBB0qXX3l8SNYmdBaOQNKUhPRf6NkG4EA3ReWI3BGU#sha256=c7d2bf3b151db24a1a637b51728842bdd7f1cc4cc35f9216926688cf15dff09f' });
    expect(c.shops).toBe('0x8332C91c9F1d8a9058B4e499dd7e4b44a6a6ADC2');
    expect(c.stakes).toBe('0x653A6686565dc1d55A7816EAe783cD98a5723af1');
    // SH-304 step 2: what decides a Four.meme token's kind, and the three named tokens' kinds (Snip is tax-rules).
    expect([c.openfour?.presetId, c.openfour?.taxPresetId, c.openfour?.taxTemplate, c.openfour?.rulesTemplate]).toEqual([1778027700001n, 1778027615723n, '0x9A665580052C37A235Fb3Bf914319BCD4C386036', '0x0B41E31f8D98796fE1DB09fB8d3c4B26aCe4502A']);
    expect(c.openfour?.kinds).toEqual({ '0x64019aea4e0322dc6cd4e314315cf08385c23afc': 'preset', '0x00c80dfac0465f10e9a8d3efb9cef8750a733835': 'tax', '0xdc787179a96bc8a826f5d5b618b6361c90e4215a': 'tax-rules' });
  });
  it('SH-304: a file without the rules pairs reads exactly as before', () => {
    const file = { chainId: 97, fromBlock: '5', flap: { curveLauncherFactory: a(0xf1), sales: [{ launcher: a(0x11) }] } };
    expect(parseLaunchConfig(file)).toStrictEqual({ fromBlock: 5n, flap: { curveLauncherFactory: a(0xf1), sales: [a(0x11)], tokenQuote: null }, openfour: null });
  });
  it('SH-304: a malformed optional entry is left out; the rest of the file still reads', () => {
    const base = { chainId: 97, fromBlock: '5', flap: { curveLauncherFactory: a(0xf1), sales: [{ launcher: a(0x11) }] } };
    const one = parseLaunchConfig({ ...base, flap: { ...base.flap, rules: { native: { launcherFactory: 'nope', rulesVaultFactory: a(0xa1) }, token: { launcherFactory: a(0xf4), rulesVaultFactory: a(0xa2) } } }, shops: { factory: 7 }, railStake: { factory: a(0x5e) } });
    expect(one.flap?.rules).toEqual({ native: null, token: { launcherFactory: a(0xf4), rulesVaultFactory: a(0xa2) } });
    expect(one.flap?.sales).toEqual([a(0x11)]);
    expect([one.shops, one.stakes]).toEqual([undefined, a(0x5e)]);
    // both pairs malformed, or the whole entry: as if the file had none
    expect(parseLaunchConfig({ ...base, flap: { ...base.flap, rules: { native: { launcherFactory: a(0xf3) }, token: 'x' } } }).flap?.rules).toBeUndefined();
    expect(parseLaunchConfig({ ...base, flap: { ...base.flap, rules: 'x' } }).flap?.rules).toBeUndefined();
    // a required entry still refuses the file
    expect(() => parseLaunchConfig({ ...base, flap: { ...base.flap, curveLauncherFactory: 'nope', rules: { native: { launcherFactory: a(0xf3), rulesVaultFactory: a(0xa1) } } } })).toThrow('not an address');
  });
  it('refuses another chain or a malformed address', () => {
    expect(() => parseLaunchConfig({ ...(FILE as object), chainId: 56 })).toThrow('another chain');
    expect(() => parseLaunchConfig({ chainId: 97, fromBlock: '1', flap: { curveLauncherFactory: 'nope', sales: [] } })).toThrow('not an address');
  });
});

describe('the windows (bounties/app/src/lib/logs.ts)', () => {
  it('40,000 blocks a window; a refused window is halved (to 5,000 at least) and grows back', async () => {
    const asked: [bigint, bigint][] = [];
    const c = { getContractEvents: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      asked.push([fromBlock, toBlock]);
      if (toBlock - fromBlock + 1n > 20_000n) throw new Error('range too large');
      return [{ args: { from: fromBlock } }];
    } };
    const logs = await readEvents(c as never, { address: a(1), abi: [], eventName: 'X', fromBlock: 0n }, 59_999n);
    expect(asked[0]).toEqual([0n, WINDOW - 1n]);
    expect(asked[1]).toEqual([0n, 19_999n]);
    expect(asked.filter(([f, t]) => t - f + 1n <= 20_000n).map(([f]) => f)).toEqual([0n, 20_000n, 40_000n]);
    expect(logs).toHaveLength(3);
  });
  it('a window refused even at 5,000 blocks fails the read', async () => {
    const c = { getContractEvents: async () => { throw new Error('refused'); } };
    await expect(readEvents(c as never, { address: a(1), abi: [], eventName: 'X', fromBlock: 0n }, MIN_WINDOW * 3n)).rejects.toThrow('refused');
  });
});

it('at most two reads at a time, in order', async () => {
  let running = 0; let most = 0;
  const job = (n: number) => async () => { running += 1; most = Math.max(most, running); await new Promise((r) => setTimeout(r, 5)); running -= 1; return n; };
  expect(await inTwos([1, 2, 3, 4, 5].map(job))).toEqual([1, 2, 3, 4, 5]);
  expect(most).toBe(2);
});

describe('the cards (Home.tsx, FlapSale.tsx, FourToken.tsx words)', () => {
  const config: LaunchConfig = { fromBlock: 100n,
    flap: { curveLauncherFactory: a(0xf1), sales: [a(0x11)], tokenQuote: { launcherFactory: a(0xf2), sales: [] } },
    openfour: { core: a(0xc0), presetIds: [7n], tokens: [a(0x41)], presetId: 7n } };
  const events: Record<string, unknown[]> = {
    CurveLauncherCreated: [{ args: { launcher: a(0x12) } }],
    TokenCurveLauncherCreated: [{ args: { launcher: a(0x13) } }],
    TokenCreated: [{ args: { presetId: 7n, token: a(0x42), tokenMetaUri: `https://arweave.net/${'B'.repeat(43)}#sha256=${'cd'.repeat(32)}` } }, { args: { presetId: 9n, token: a(0x43), tokenMetaUri: '' } }],
  };
  const progress: Record<string, unknown> = {
    [a(0x11)]: { phase: 0, curveBalance: 5n * 10n ** 16n, raiseTarget: 10n ** 18n },
    [a(0x12)]: { phase: 1, curveBalance: 0n, raiseTarget: 10n ** 18n },
    [a(0x13)]: { phase: 0, curveBalance: 2n * 10n ** 6n, raiseTarget: 10n * 10n ** 6n },
  };
  const client = {
    getBlockNumber: async () => 200n,
    getContractEvents: async ({ eventName }: { eventName: string }) => events[eventName] ?? [],
    readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: unknown[] }) => {
      if (functionName === 'config') return { name: `Sale ${address.slice(-2)}`, symbol: `S${address.slice(-2)}`, meta: address === a(0x12) ? `https://arweave.net/${'A'.repeat(43)}#sha256=${'ab'.repeat(32)}` : '' };
      if (functionName === 'progress') return progress[address];
      if (functionName === 'quote') return a(0x99);
      if (functionName === 'symbol') return 'tUSDC';
      if (functionName === 'decimals') return 6;
      if (functionName === 'tokens') { const t = args?.[0] as Address; const r: unknown[] = new Array(20).fill(0); r[2] = 7n; r[4] = `Four ${t.slice(-2)}`; r[5] = `F${t.slice(-2)}`; r[10] = t === a(0x41) ? a(0x51) : a(0x52); r[18] = false; return r; }
      if (functionName === 'phase') return address === a(0x51) ? 3 : 1;
      throw new Error(`unexpected ${functionName}`);
    },
  };
  it('one card per launch, newest first per rail, with its state, its rule line and its page', async () => {
    const cards = await readLaunchCards(client as never, config);
    expect(cards.map((c) => [c.rail, c.name, c.symbol, c.state, c.rules, c.href])).toEqual([
      ['flap', 'Sale 13', 'S13', 'Raised 2 of 10 tUSDC', nb('pile 100'), `/launches/#/flap/${a(0x13)}`],
      ['flap', 'Sale 12', 'S12', 'Launched', nb('pile 100'), `/launches/#/flap/${a(0x12)}`],
      ['flap', 'Sale 11', 'S11', 'Raised 0.05 of 1 BNB', nb('pile 100'), `/launches/#/flap/${a(0x11)}`],
      ['four', 'Four 42', 'F42', 'On the curve', nb('pile 100'), `/launches/#/four/${a(0x42)}`],
      ['four', 'Four 41', 'F41', 'On PancakeSwap', nb('pile 100'), `/launches/#/four/${a(0x41)}`],
    ]);
  });
  it('SH-294: a launch\'s picture from its own link: Flap\'s config meta, OpenFour\'s creation event; none otherwise', async () => {
    const cards = await readLaunchCards(client as never, config);
    expect(cards.map((c) => [c.name, c.picture])).toEqual([
      ['Sale 13', null],
      ['Sale 12', { id: 'A'.repeat(43), sha256: 'ab'.repeat(32) }],
      ['Sale 11', null],
      ['Four 42', { id: 'B'.repeat(43), sha256: 'cd'.repeat(32) }],
      ['Four 41', null],
    ]);
  });
});

describe('SH-316: launches named in the file when older creation events are missing', () => {
  const native = { launcherFactory: a(0xf3), rulesVaultFactory: a(0xa1) };
  const token = { launcherFactory: a(0xf4), rulesVaultFactory: a(0xa2) };
  const sale = (launcher: Address) => ({ launcher, token: a(0x99) });
  const picture = `https://arweave.net/${'A'.repeat(43)}`;
  const config = parseLaunchConfig({ chainId: 97, fromBlock: '100', flap: {
    curveLauncherFactory: a(0xf1), sales: [sale(a(1))], tokenQuote: { launcherFactory: a(0xf2), sales: [sale(a(2))] },
    rules: { native: { ...native, sales: [sale(a(3))] }, token: { ...token, sales: [sale(a(4)), sale(a(5))] } },
  }, openfour: { core: a(0xc0), presetId: 7, tokens: [{ token: a(0xab).replace('ab', 'AB'), tokenUri: picture }] } });
  const named = [
    { launcher: a(5), tokenQuote: true, rules: { ...token, sales: [a(4), a(5)] } },
    { launcher: a(4), tokenQuote: true, rules: { ...token, sales: [a(4), a(5)] } },
    { launcher: a(3), tokenQuote: false, rules: { ...native, sales: [a(3)] } },
    { launcher: a(2), tokenQuote: true, rules: null },
    { launcher: a(1), tokenQuote: false, rules: null },
  ];

  it('lists named sales in order with their rules and quote, and reads the picture link from the file', async () => {
    const result = await listLaunches({ getContractEvents: async () => [] } as never, config, 110n);
    expect(result.flap).toEqual(named);
    expect(result.links.get(a(0xab))).toBe(picture);
  });

  it('keeps each named sale in its place once and gives the creation event precedence even for an empty link', async () => {
    const events = {
      [a(0xf1)]: [{ args: { launcher: a(6) } }],
      [native.launcherFactory]: [{ args: { launcher: a(3) } }],
      [token.launcherFactory]: [{ args: { launcher: a(5) } }, { args: { launcher: a(4) } }],
      [a(0xc0)]: [{ args: { token: a(0xab), presetId: 7n, tokenMetaUri: '' } }],
    };
    const client = { getContractEvents: async ({ address }: { address: Address }) => events[address] ?? [] };
    const result = await listLaunches(client as never, config, 110n);
    expect(result.flap).toEqual([{ launcher: a(6), tokenQuote: false, rules: null }, ...named]);
    expect(result.four).toEqual([a(0xab)]);
    expect(result.links.get(a(0xab))).toBe('');
  });
});

describe('SH-304: the launches with the creator\'s rules (the rules pairs; launch-rules.ts)', () => {
  // The four Flap launcher factories, the two rules vault factories, our shop and stake factories, one creator.
  const [BNB_F, TOKEN_F, RULES_BNB_F, RULES_TOKEN_F] = [a(0xf1), a(0xf2), a(0xf3), a(0xf4)];
  const [VAULTS_BNB, VAULTS_TOKEN, SHOPS, STAKES, CREATOR] = [a(0xa1), a(0xa2), a(0x5a), a(0x5e), a(0xc1)];
  const config: LaunchConfig = { fromBlock: 100n, openfour: null, shops: SHOPS, stakes: STAKES,
    flap: { curveLauncherFactory: BNB_F, sales: [a(0x11)], tokenQuote: { launcherFactory: TOKEN_F, sales: [] },
      rules: { native: { launcherFactory: RULES_BNB_F, rulesVaultFactory: VAULTS_BNB }, token: { launcherFactory: RULES_TOKEN_F, rulesVaultFactory: VAULTS_TOKEN } } } };
  // Sweet Jar (BNB), Pay Packet and Swap Deck (test dollar), a launch paying a stranger's contract, one whose rules fail.
  const [SWEET, PACKET, DECK, STRANGER, BROKEN] = [a(0x21), a(0x22), a(0x23), a(0x24), a(0x25)];
  const token = (launcher: Address) => a(Number.parseInt(launcher.slice(-2), 16) + 0x100);
  const [STAKE, SHOP, OTHER] = [a(0x5001), a(0x5002), a(0x5003)];
  const creatorRule = (bps: number, target: Address = CREATOR) => ({ kind: 1, bps, target });
  const pile = (bps: number) => ({ kind: 2, bps, target: a(0) });
  const burn = (bps: number) => ({ kind: 3, bps, target: a(0) });
  const stored: Record<string, unknown> = {
    [SWEET]: [creatorRule(1000), pile(6000), burn(3000)],
    [PACKET]: [creatorRule(1000), pile(3000), creatorRule(4000, STAKE), burn(2000)],
    [DECK]: [creatorRule(1000), pile(3000), creatorRule(4000, SHOP), burn(2000)],
    [STRANGER]: [creatorRule(1000), pile(3000), creatorRule(4000, OTHER), burn(2000)],
  };
  const events: Record<string, unknown[]> = {
    // a sale the file names is found again by its factory's event: one card
    [BNB_F]: [{ args: { launcher: a(0x11) } }, { args: { launcher: a(0x12) } }],
    [TOKEN_F]: [{ args: { launcher: a(0x13) } }],
    [RULES_BNB_F]: [{ args: { launcher: SWEET } }, { args: { launcher: SWEET } }],
    [RULES_TOKEN_F]: [{ args: { launcher: PACKET } }, { args: { launcher: DECK } }, { args: { launcher: STRANGER } }, { args: { launcher: BROKEN } }],
  };
  const asked: string[] = [];
  const client = {
    getBlockNumber: async () => 200n,
    getContractEvents: async ({ address }: { address: Address }) => events[address] ?? [],
    readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: Address[] }) => {
      asked.push(`${functionName} ${address}`);
      const was = (x: Address) => address.toLowerCase() === x.toLowerCase();
      if (functionName === 'config') return { name: `Sale ${address.slice(-2)}`, symbol: `S${address.slice(-2)}`, meta: '' };
      if (functionName === 'progress') return { phase: 1, curveBalance: 0n, raiseTarget: 10n ** 18n };
      if (functionName === 'rulesOf') {
        const launcher = args?.[0] as Address;
        // each pair's record holds only its own launches
        if (!was(launcher === SWEET ? VAULTS_BNB : VAULTS_TOKEN)) throw new Error('another factory');
        if (launcher === BROKEN) throw new Error('refused');
        return stored[launcher];
      }
      if (functionName === 'creator') return CREATOR;
      if (functionName === 'pileVaultFactory') return address === SWEET ? VAULTS_BNB : VAULTS_TOKEN;
      if (functionName === 'predictedToken') return token(address);
      if (functionName === 'isShop') return was(SHOPS) && args?.[0] === SHOP;
      if (functionName === 'stakeOf') return was(STAKES) && args?.[0] === CREATOR && args[1] === token(PACKET) ? STAKE : a(0);
      if (functionName === 'isStake') return was(STAKES) && args?.[0] === STAKE;
      if (functionName === 'token') { if (was(SHOP)) return token(DECK); if (was(STAKE)) return token(PACKET); throw new Error('no such view'); }
      if (functionName === 'factory') { if (was(STAKE)) return STAKES; throw new Error('no such view'); }
      throw new Error(`unexpected ${functionName}`);
    },
  };

  it('finds the launches of all four factories once each, newest first, the rules pairs\' after the others', async () => {
    const { flap } = await listLaunches(client as never, config, 200n);
    expect(flap.map((l) => [l.launcher, l.tokenQuote, l.rules?.rulesVaultFactory ?? null])).toEqual([
      [BROKEN, true, VAULTS_TOKEN], [STRANGER, true, VAULTS_TOKEN], [DECK, true, VAULTS_TOKEN], [PACKET, true, VAULTS_TOKEN],
      [SWEET, false, VAULTS_BNB],
      [a(0x13), true, null], [a(0x12), false, null], [a(0x11), false, null],
    ]);
  });
  it('the rule line of each real shape, an unprovable payee as "paid out", none when the rules cannot be read; the link unchanged', async () => {
    asked.length = 0;
    const cards = await readLaunchCards(client as never, config);
    expect(cards.map((c) => [c.address, c.rules, c.href])).toEqual([
      [BROKEN, null, `/launches/#/flap/${BROKEN}`],
      [STRANGER, nb('creator 10 · pile 30 · paid out 40 · burn 20'), `/launches/#/flap/${STRANGER}`],
      [DECK, nb('creator 10 · pile 30 · card shop 40 · burn 20'), `/launches/#/flap/${DECK}`],
      [PACKET, nb('creator 10 · pile 30 · holders 40 · burn 20'), `/launches/#/flap/${PACKET}`],
      [SWEET, nb('creator 10 · pile 60 · burn 30'), `/launches/#/flap/${SWEET}`],
      [a(0x13), nb('pile 100'), `/launches/#/flap/${a(0x13)}`],
      [a(0x12), nb('pile 100'), `/launches/#/flap/${a(0x12)}`],
      [a(0x11), nb('pile 100'), `/launches/#/flap/${a(0x11)}`],
    ]);
    // only a rules launch reads its rules; only one whose rules pay someone besides its creator reads its token
    expect(asked.filter((q) => q.startsWith('creator ')).sort()).toEqual([SWEET, PACKET, DECK, STRANGER, BROKEN].map((l) => `creator ${l}`).sort());
    expect(asked.filter((q) => q.startsWith('predictedToken ')).sort()).toEqual([PACKET, DECK, STRANGER].map((l) => `predictedToken ${l}`).sort());
  });
  it('a payee is named only when every check holds: a stake of another factory, or a shop of another token, reads "paid out"', async () => {
    const line = (rules: unknown, reads: Record<string, unknown>, vaults: Address = VAULTS_TOKEN) => readRulesLine({
      readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
        if (functionName === 'rulesOf') return rules;
        if (functionName === 'creator') return CREATOR;
        if (functionName === 'pileVaultFactory') return vaults;
        if (functionName === 'predictedToken') return token(PACKET);
        const v = reads[`${functionName} ${address}`];
        if (v === undefined) throw new Error('no such view');
        return v;
      },
    } as never, PACKET, { rulesVaultFactory: VAULTS_TOKEN, shops: SHOPS, stakes: STAKES });
    const rules = [creatorRule(6000), creatorRule(4000, STAKE)];
    const stake = { [`stakeOf ${STAKES}`]: STAKE, [`isStake ${STAKES}`]: true, [`token ${STAKE}`]: token(PACKET), [`factory ${STAKE}`]: STAKES };
    expect(await line(rules, stake)).toBe(nb('creator 60 · holders 40'));
    expect(await line(rules, { ...stake, [`factory ${STAKE}`]: a(0x99) })).toBe(nb('creator 60 · paid out 40'));
    expect(await line(rules, { ...stake, [`isStake ${STAKES}`]: false })).toBe(nb('creator 60 · paid out 40'));
    // step 3 (each fails when its check in payeeNames is removed): the stake's token() is another token; the factory's
    // stakeOf(creator, token) is another address than the payee
    expect(await line(rules, { ...stake, [`token ${STAKE}`]: token(DECK) })).toBe(nb('creator 60 · paid out 40'));
    expect(await line(rules, { ...stake, [`stakeOf ${STAKES}`]: a(0x98) })).toBe(nb('creator 60 · paid out 40'));
    const shop = [creatorRule(6000), creatorRule(4000, SHOP)];
    expect(await line(shop, { [`isShop ${SHOPS}`]: true, [`token ${SHOP}`]: token(PACKET) })).toBe(nb('creator 60 · card shop 40'));
    expect(await line(shop, { [`isShop ${SHOPS}`]: true, [`token ${SHOP}`]: token(DECK) })).toBe(nb('creator 60 · paid out 40'));
    // a launch whose creator set no rules: the factory's record is PILE 100%
    expect(await line([pile(10_000)], {})).toBe(nb('pile 100'));
    // step 3: a launcher whose own vault factory is not the pair's: no line, even though rulesOf would answer PILE 100%
    expect(await line([pile(10_000)], {}, a(0xa9))).toBeNull();
    expect(await line(rules, stake, a(0xa9))).toBeNull();
  });
  it('the line is none rather than wrong: no rule, an unknown kind, parts that are not the whole; a part keeps its decimals', () => {
    expect(rulesLine([], CREATOR)).toBeNull();
    expect(rulesLine([{ kind: 4, bps: 10_000, target: a(0) }], CREATOR)).toBeNull();
    expect(rulesLine([{ kind: 0, bps: 10_000, target: a(0) }], CREATOR)).toBeNull();
    expect(rulesLine([pile(9_000)], CREATOR)).toBeNull();
    expect(rulesLine([pile(6_667), burn(3_333)], CREATOR)).toBe(nb('pile 66.67 · burn 33.33'));
    expect(rulesLine([creatorRule(5), pile(9_995)], CREATOR)).toBe(nb('creator 0.05 · pile 99.95'));
    // step 3: the word and its number stay together; only " · " between parts may break
    expect(rulesLine([creatorRule(4000, a(0x77)), pile(6000)], CREATOR, () => 'card shop')).toBe('card\u00a0shop\u00a040 · pile\u00a060');
  });
  it('step 2: a creator rule reads "creator" only when it pays the creator; another address reads "paid out", a proven one its name', () => {
    expect(rulesLine([creatorRule(4000), pile(6000)], CREATOR)).toBe(nb('creator 40 · pile 60'));
    expect(rulesLine([creatorRule(4000, a(0x77)), pile(6000)], CREATOR)).toBe(nb('paid out 40 · pile 60'));
    expect(rulesLine([creatorRule(4000, a(0x77)), pile(6000)], CREATOR, () => 'holders')).toBe(nb('holders 40 · pile 60'));
    // the creator's own address is "creator" whatever a name would say, as rules.ts ruleName
    expect(rulesLine([creatorRule(4000), pile(6000)], CREATOR, () => 'card shop')).toBe(nb('creator 40 · pile 60'));
  });
});

describe('SH-304 step 2: a Four.meme card\'s rule line, as the launch page proves the token\'s kind (FourToken.tsx findPile)', () => {
  const [CORE, TAX_TEMPLATE, RULES_TEMPLATE, CREATOR, SHOPS, STAKES] = [a(0xc0), a(0x7a), a(0x7b), a(0xc1), a(0x5a), a(0x5e)];
  const [PRESET_ID, TAX_ID] = [1778027700001n, 1778027615723n];
  const clone = (impl: Address) => `0x363d3d373d3d3d363d73${impl.slice(2)}5af43d82803e903d91602b57fd5bf3`;
  // token -> [Core's preset id, its founder's clone's code, the clone's parts (creator payee, creator, pile, burn)]
  type Shape = { presetId: bigint; code?: string; parts?: [Address, number, number, number]; founderFails?: boolean };
  const [SNIP, TAX, PRESET, UNREADABLE, FOREIGN, PAYS_OTHER, NO_KIND] = [a(0x41), a(0x42), a(0x43), a(0x44), a(0x45), a(0x46), a(0x47)];
  const shapes: Record<string, Shape> = {
    [SNIP]: { presetId: TAX_ID, code: clone(RULES_TEMPLATE), parts: [CREATOR, 2000, 5000, 3000] },
    [TAX]: { presetId: TAX_ID, code: clone(TAX_TEMPLATE) },
    [PRESET]: { presetId: PRESET_ID },
    [UNREADABLE]: { presetId: TAX_ID, founderFails: true },
    [FOREIGN]: { presetId: TAX_ID, code: clone(a(0x99)) },
    [PAYS_OTHER]: { presetId: TAX_ID, code: clone(RULES_TEMPLATE), parts: [a(0x77), 2000, 5000, 3000] },
    [NO_KIND]: { presetId: 9n },
  };
  const vaultOf = (t: Address) => a(Number.parseInt(t.slice(-2), 16) + 0x200);
  const founderOf = (t: Address) => a(Number.parseInt(t.slice(-2), 16) + 0x300);
  const tokenOf = (x: Address, base: number) => a(Number.parseInt(x.slice(-3), 16) - base);
  const asked: string[] = [];
  const client = {
    getCode: async ({ address }: { address: Address }) => { asked.push(`getCode ${address}`); return shapes[tokenOf(address, 0x200)]?.code; },
    readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: Address[] }) => {
      asked.push(`${functionName} ${address}`);
      if (functionName === 'tokens') {
        const t = args?.[0] as Address; const r: unknown[] = new Array(20).fill(0);
        r[1] = CREATOR; r[2] = shapes[t]?.presetId; r[4] = `Four ${t.slice(-2)}`; r[5] = `F${t.slice(-2)}`; r[10] = a(0x51); r[18] = false;
        return r;
      }
      if (functionName === 'phase') return 1;
      if (functionName === 'founder') { if (shapes[address]?.founderFails) throw new Error('refused'); return founderOf(address); }
      if (functionName === 'clonedVault') return vaultOf(tokenOf(address, 0x300));
      const parts = shapes[tokenOf(address, 0x200)]?.parts;
      if (parts && functionName === 'creator') return parts[0];
      if (parts && functionName === 'creatorBps') return parts[1];
      if (parts && functionName === 'pileBps') return parts[2];
      if (parts && functionName === 'burnBps') return parts[3];
      if (functionName === 'stakeOf') return a(0);
      if (functionName === 'isShop') return false;
      throw new Error(`no such view: ${functionName}`);
    },
  };
  const source = { presetId: PRESET_ID, taxPresetId: TAX_ID, taxTemplate: TAX_TEMPLATE, rulesTemplate: RULES_TEMPLATE, shops: SHOPS, stakes: STAKES };
  const line = async (token: Address, more: Partial<typeof source> & { kind?: string } = {}) => (await readFourCard(client as never, CORE, token, null, { ...source, ...more })).rules;

  it('Snip\'s shape (a clone of the rules template, 2000 / 5000 / 3000, paying its creator): its rules', async () => {
    expect(await line(SNIP)).toBe(nb('creator 20 · pile 50 · burn 30'));
  });
  it('a plain tax token (a clone of the tax template) and a preset token keep "pile 100"; the preset reads no vault', async () => {
    expect(await line(TAX)).toBe(nb('pile 100'));
    asked.length = 0;
    expect(await line(PRESET)).toBe(nb('pile 100'));
    expect(asked.filter((q) => !q.startsWith('tokens ') && !q.startsWith('phase '))).toEqual([]);
  });
  it('no line when the kind or the rules cannot be read: a refused read, a clone of neither template, no template in the file, an unknown kind', async () => {
    expect(await line(UNREADABLE)).toBeNull();
    expect(await line(FOREIGN)).toBeNull();
    expect(await line(SNIP, { rulesTemplate: undefined })).toBeNull();
    expect(await line(TAX, { taxTemplate: undefined })).toBeNull();
    expect(await line(NO_KIND)).toBeNull();
    // the card itself still shows
    expect((await readFourCard(client as never, CORE, UNREADABLE, null, source)).name).toBe('Four 44');
  });
  it('a rules clone paying an address that is not Core\'s creator, unproven: "paid out"', async () => {
    expect(await line(PAYS_OTHER)).toBe(nb('paid out 20 · pile 50 · burn 30'));
  });
  it('the kind: Core\'s preset id first, then the file\'s entry ("tax-rules" is a tax token proven by its clone)', async () => {
    expect([fourKind(TAX_ID, 'preset', source), fourKind(PRESET_ID, 'tax', source), fourKind(9n, 'tax-rules', source), fourKind(9n, 'tax', source), fourKind(9n, 'preset', source), fourKind(9n, undefined, source)])
      .toEqual(['tax', 'preset', 'tax', 'tax', null, null]);
    expect(await line(NO_KIND, { kind: 'tax-rules' })).toBeNull(); // a tax token whose founder has no clone here
  });
  it('step 3: a "preset" entry counts only when the file carries no preset ids (FourToken.tsx known / ours)', async () => {
    // with preset ids in the file, Core's preset id must match: an entry alone claims nothing, and nothing is read
    asked.length = 0;
    expect(await line(NO_KIND, { kind: 'preset' })).toBeNull();
    expect(asked.filter((q) => !q.startsWith('tokens ') && !q.startsWith('phase '))).toEqual([]);
    // a file without preset ids: the entry decides, as on the launch page
    expect(fourKind(9n, 'preset', {})).toBe('preset');
    expect(await line(NO_KIND, { kind: 'preset', presetId: undefined, taxPresetId: undefined })).toBe(nb('pile 100'));
  });
});

it('SH-294: a card\'s amount: four decimals at most, cut, no trailing zeros', () => {
  expect([amount(2_350_000_000_000_000_001n, 18), amount(5n * 10n ** 16n, 18), amount(10n ** 18n, 18), amount(123_456_789n, 6), amount(1n, 18)]).toEqual(['2.35', '0.05', '1', '123.4567', '0']);
});
