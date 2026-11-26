/**
 * SH-V2-FE8 (LOCAL-COINS-B review): a listing's issuer lines come from the listed token's own contract, read at the
 * listing's address, never from its ticker; "could not be read" only when the chain could not be asked. The stub chain
 * below answers exactly as packages/contracts/script/local/LocalQuoteMocks.sol does for the local coins (NVDAon and
 * AAPLon name one shared LocalStockControls with `paused()` and `frozen(address)`; USDC, LINK, WBTC, PAXG and XAUt are
 * plain faucets), plus the issuers' own interfaces (Circle's USDC blocklist, Paxos' PAXG pause and freeze).
 */
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, erc20Abi, type Address, type Hex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { publishedV2 } from '../../core/v2/test-support/published-v2';
import { loadListingsV2, resetListingSymbolsForTests, rpcTokenReader } from './indexer-listings';
import { PAUSE_ALL_LINE, PAUSE_LINE, RETRY_MS, UNREAD_LINE, issuerPowerLines, powerLines, readIssuerPowers, resetIssuerPowersForTests, type TokenCall, type TokenReader } from './issuer-powers';
import { FREEZE_LINE, NATIVE_TOKEN, ONDO_LINE, STOCK_LINE, issuerLines } from './listings';
import { ListingClass, ListingKind } from './spec-types';

const at = (n: number): Address => `0x50000000000000000000000000000000000000${n.toString(16).padStart(2, '0')}` as Address;
const CONTROLS = at(0x10);
const COINS = {
  USDC: at(1), LINK: at(2), WBTC: at(3), NVDAon: at(4), AAPLon: at(5), PAXG: at(6), XAUt: at(7),
  // The issuers' own contracts (not the local faucets): Circle's USDC blocklist; Paxos' PAXG pause and freeze.
  CircleUSDC: at(8), PaxosPAXG: at(9),
  // A coin that only calls itself NVDAon: no controller, so no power is claimed for it.
  FakeNVDAon: at(0x0a),
} as const;

const ABI = [
  ...erc20Abi,
  { type: 'function', name: 'controls', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  ...['frozen', 'isFrozen', 'isBlacklisted', 'isBlackListed', 'isBlocked'].map((name) => ({ type: 'function', name, stateMutability: 'view', inputs: [{ type: 'address', name: 'account' }], outputs: [{ type: 'bool' }] }) as const),
] as const;

const word = (value: boolean | Address): Hex => (typeof value === 'boolean' ? encodeAbiParameters([{ type: 'bool' }], [value]) : encodeAbiParameters([{ type: 'address' }], [value]));
const text = (value: string): Hex => encodeAbiParameters([{ type: 'string' }], [value]);

/** What each contract answers (as LocalQuoteMocks.sol and the issuers' contracts would); anything else reverts. */
const CHAIN: Readonly<Record<string, Readonly<Record<string, Hex>>>> = {
  [COINS.USDC]: { symbol: text('USDC') },
  [COINS.LINK]: { symbol: text('LINK') },
  [COINS.WBTC]: { symbol: text('WBTC') },
  [COINS.NVDAon]: { symbol: text('NVDAon'), controls: word(CONTROLS) },
  [COINS.AAPLon]: { symbol: text('AAPLon'), controls: word(CONTROLS) },
  [COINS.PAXG]: { symbol: text('PAXG') },
  [COINS.XAUt]: { symbol: text('XAUt') },
  [CONTROLS]: { paused: word(false), frozen: word(false) },
  [COINS.CircleUSDC]: { symbol: text('USDC'), isBlacklisted: word(false) },
  [COINS.PaxosPAXG]: { symbol: text('PAXG'), paused: word(false), isFrozen: word(false) },
  [COINS.FakeNVDAon]: { symbol: text('NVDAon') },
};

interface Stub { readonly reader: TokenReader; readonly calls: string[] }
/** A chain that answers as CHAIN says; every contract in it has code, any other address none. */
function stubChain({ down = false }: { down?: boolean } = {}): Stub {
  const calls: string[] = [];
  const call: TokenCall = async (to, data) => {
    const { functionName } = decodeFunctionData({ abi: ABI, data });
    calls.push(`${to}.${functionName}`);
    if (down) throw new Error('fetch failed');
    return CHAIN[to]?.[functionName] ?? null;
  };
  const hasCode = async (address: Address) => {
    if (down) throw new Error('fetch failed');
    return CHAIN[address] !== undefined;
  };
  return { reader: { call, hasCode }, calls };
}

const listed = (token: Address) => ({ token, kind: ListingKind.LISTED });
// Both caches last a page's life (issuer powers, symbols): each test starts with none.
afterEach(() => { resetIssuerPowersForTests(); resetListingSymbolsForTests(); });

describe('issuer powers from the listed contract (SH-V2-FE8, LOCAL-COINS-B)', () => {
  it('the local stocks: one shared controller pauses or blocks every coin naming it, and freezes addresses', async () => {
    const { reader } = stubChain();
    for (const token of [COINS.NVDAon, COINS.AAPLon]) {
      expect(await readIssuerPowers(reader, token)).toEqual({ pause: 'shared', freeze: true });
      expect(await issuerPowerLines(reader, 31_337, listed(token))).toEqual([PAUSE_ALL_LINE, FREEZE_LINE]);
    }
  });

  it('USDC with its issuer\'s blocklist says freeze; the issuers\' pause and freeze say both', async () => {
    const { reader } = stubChain();
    expect(await issuerPowerLines(reader, 31_337, listed(COINS.CircleUSDC))).toEqual([FREEZE_LINE]);
    expect(await issuerPowerLines(reader, 31_337, listed(COINS.PaxosPAXG))).toEqual([PAUSE_LINE, FREEZE_LINE]);
  });

  it('the plain local faucets (USDC, LINK, WBTC, PAXG, XAUt) have no power to name, and say nothing', async () => {
    const { reader } = stubChain();
    for (const token of [COINS.USDC, COINS.LINK, COINS.WBTC, COINS.PAXG, COINS.XAUt]) expect(await issuerPowerLines(reader, 31_337, listed(token)), token).toEqual([]);
  });

  it('never from the ticker: a coin that calls itself NVDAon, with no controller, claims no power and no issuer', async () => {
    const { reader } = stubChain();
    expect(await issuerPowerLines(reader, 31_337, listed(COINS.FakeNVDAon))).toEqual([]);
    expect(PAUSE_ALL_LINE).not.toMatch(/Ondo/);
  });

  it('ETH and a box token have no issuer: no call at all', async () => {
    const { reader, calls } = stubChain();
    expect(await issuerPowerLines(reader, 31_337, listed(NATIVE_TOKEN))).toEqual([]);
    expect(await issuerPowerLines(reader, 31_337, { token: COINS.NVDAon, kind: ListingKind.BOX_TOKEN })).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('the one fallback, only when the chain cannot be read; a later read tries again (not before RETRY_MS) and is then kept', async () => {
    let clock = 1_000_000;
    const now = () => clock;
    const down = stubChain({ down: true });
    expect(await issuerPowerLines(down.reader, 31_337, listed(COINS.NVDAon), now)).toEqual([UNREAD_LINE]);
    const up = stubChain();
    // The listing book refetches every 6 s: no new read until RETRY_MS has passed.
    clock += 6_000;
    expect(await issuerPowerLines(up.reader, 31_337, listed(COINS.NVDAon), now)).toEqual([UNREAD_LINE]);
    expect(up.calls).toEqual([]);
    clock += RETRY_MS;
    expect(await issuerPowerLines(up.reader, 31_337, listed(COINS.NVDAon), now)).toEqual([PAUSE_ALL_LINE, FREEZE_LINE]);
    const reads = up.calls.length;
    expect(await issuerPowerLines(up.reader, 31_337, listed(COINS.NVDAon), now)).toEqual([PAUSE_ALL_LINE, FREEZE_LINE]);
    expect(up.calls).toHaveLength(reads);
    // By chain and address: the same address on another chain is read on its own.
    await issuerPowerLines(up.reader, 11_155_111, listed(COINS.NVDAon), now);
    expect(up.calls.length).toBeGreaterThan(reads);
  });

  it('an address with no code proves nothing (a lagging or reset node): the fallback, never "no powers"', async () => {
    const { reader } = stubChain();
    expect(await issuerPowerLines(reader, 31_337, listed(at(0x30)))).toEqual([UNREAD_LINE]);
    // A controller the token names must hold code too.
    const named: TokenReader = { ...reader, call: async (to, data) => (to === COINS.USDC && decodeFunctionData({ abi: ABI, data }).functionName === 'controls' ? word(at(0x31)) : reader.call(to, data)) };
    resetIssuerPowersForTests();
    expect(await issuerPowerLines(named, 31_337, listed(COINS.USDC))).toEqual([UNREAD_LINE]);
  });

  it('a value that is not one well-formed word is not the getter', async () => {
    const call: TokenCall = async (_to, data) => (data === encodeFunctionData({ abi: ABI, functionName: 'paused' }) ? (`0x${'0'.repeat(63)}2` as Hex) : data.startsWith(encodeFunctionData({ abi: ABI, functionName: 'controls' })) ? (`0x${'1'.repeat(64)}` as Hex) : null);
    expect(await readIssuerPowers({ call, hasCode: async () => true }, COINS.USDC)).toEqual({ pause: null, freeze: false });
    expect(powerLines({ pause: null, freeze: false })).toEqual([]);
  });
});

describe('the listing book on a chain source: each coin\'s own lines, the stock note by class', () => {
  const RAISE: Readonly<Record<string, [bigint, number, keyof typeof ListingClass]>> = {
    ETH: [4_206_980_085_000_000_000n, 18, 'NATIVE'],
    USDC: [8_413_960_170n, 6, 'STABLE'],
    LINK: [280_000_000_000_000_000_000n, 18, 'OTHER'],
    WBTC: [7_011_634n, 8, 'OTHER'],
    NVDAon: [42_069_800_850_000_000_000n, 18, 'STOCK'],
    AAPLon: [33_655_840_680_000_000_000n, 18, 'STOCK'],
    PAXG: [2_103_490_042_500_000_000n, 18, 'OTHER'],
    XAUt: [2_103_491n, 6, 'OTHER'],
  };
  const TOKENS: Readonly<Record<string, Address>> = { ETH: NATIVE_TOKEN, USDC: COINS.USDC, LINK: COINS.LINK, WBTC: COINS.WBTC, NVDAon: COINS.NVDAon, AAPLon: COINS.AAPLon, PAXG: COINS.PAXG, XAUt: COINS.XAUt };

  async function book() {
    const { source } = await publishedV2();
    const release = source.manifest.releases[0];
    if (!release) throw new Error('no release');
    const listings = Object.entries(RAISE).map(([symbol, [raise, decimals, cls]], index) => {
      const id = index + 1;
      const token = TOKENS[symbol] as Address;
      const detail = { id, token, decimals, class: cls, kind: 'LISTED', listedAt: '1', raise: raise.toString(), q: { bootstrapQ: '1', batchMinQ: '1', tipMaxQ: '1', swapStepMinQ: '1' } };
      return { id, token, class: cls, kind: 'LISTED', raise: raise.toString(), detail };
    });
    const body = { schema: 'sh.core-listings.v2', chainId: source.manifest.chainId, registry: release.registry.address.toLowerCase(), listings };
    return { source, fetcher: async () => new Response(JSON.stringify(body)) };
  }

  it('eight local coins: the stocks name the shared pause and the freeze, then the stock note; gold and the rest say nothing', async () => {
    const { source, fetcher } = await book();
    const rows = await loadListingsV2(source, fetcher, stubChain().reader);
    const lines = Object.fromEntries(rows.map((row) => [row.symbol, issuerLines(row)]));
    expect(lines).toEqual({
      ETH: [],
      USDC: [],
      LINK: [],
      WBTC: [],
      NVDAon: [PAUSE_ALL_LINE, FREEZE_LINE, STOCK_LINE],
      AAPLon: [PAUSE_ALL_LINE, FREEZE_LINE, STOCK_LINE],
      PAXG: [],
      XAUt: [],
    });
    // Gold keeps its own units: PAXG 18 decimals, XAUt 6.
    expect(rows.filter((row) => ['PAXG', 'XAUt'].includes(row.symbol)).map((row) => [row.symbol, row.decimals, row.class])).toEqual([['PAXG', 18, ListingClass.OTHER], ['XAUt', 6, ListingClass.OTHER]]);
    // No row carries the old placeholder, and no row names Ondo: no issuer is certified from a ticker.
    for (const row of rows) expect(issuerLines(row).join(' ')).not.toMatch(/have not been checked|Ondo/);
    expect(ONDO_LINE).toMatch(/^Ondo/);
  });

  it('reads each coin’s symbol once per chain and address, so a book refetched every 6 s asks no symbol again', async () => {
    const { source, fetcher } = await book();
    const chain = stubChain();
    const first = await loadListingsV2(source, fetcher, chain.reader);
    const symbolCalls = () => chain.calls.filter((call) => call.endsWith('.symbol')).length;
    const once = symbolCalls();
    expect(once).toBe(first.length - 1);
    const again = await loadListingsV2(source, fetcher, chain.reader);
    expect(again.map((row) => row.symbol)).toEqual(first.map((row) => row.symbol));
    expect(symbolCalls()).toBe(once);
  });

  it('a chain that cannot be read: each coin with an issuer says so once, the stock note still by class; ETH says nothing', async () => {
    const { source, fetcher } = await book();
    const rows = await loadListingsV2(source, fetcher, stubChain({ down: true }).reader);
    const lines = Object.fromEntries(rows.map((row) => [row.symbol, issuerLines(row)]));
    expect(lines[NATIVE_TOKEN] ?? lines.ETH).toEqual([]);
    // The symbol read failed too, so the coins show their addresses.
    expect(lines[COINS.NVDAon]).toEqual([UNREAD_LINE, STOCK_LINE]);
    expect(lines[COINS.PAXG]).toEqual([UNREAD_LINE]);
  });
});

describe('the RPC reader: only a revert is "absent"; every other failure concludes nothing (viem\'s own HTTP transport)', () => {
  const RPC = 'https://rpc.invalid';
  type Reply = { status?: number; body: unknown } | 'network';
  /** A fetch that answers eth_chainId with `chain`, eth_getCode with `code`, and eth_call with `call`. */
  function rpc(call: Reply, { chain = 31_337, code = '0x6080' }: { chain?: number; code?: Hex } = {}): typeof fetch {
    return (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id: number; method: string };
      const reply: Reply = request.method === 'eth_chainId' ? { body: { result: `0x${chain.toString(16)}` } } : request.method === 'eth_getCode' ? { body: { result: code } } : call;
      if (reply === 'network') throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(reply.body as object) }), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  }
  const data = encodeFunctionData({ abi: ABI, functionName: 'paused' });

  it('a revert (anvil\'s code 3, a node\'s "execution reverted") is absent', async () => {
    for (const error of [{ code: 3, message: 'execution reverted' }, { code: -32000, message: 'execution reverted' }]) {
      expect(await rpcTokenReader(RPC, 31_337, rpc({ body: { error } })).call(COINS.USDC, data), error.message).toBeNull();
    }
    expect(await rpcTokenReader(RPC, 31_337, rpc({ body: { result: '0x' } })).call(COINS.USDC, data)).toBeNull();
    expect(await rpcTokenReader(RPC, 31_337, rpc({ body: { result: word(true) } })).call(COINS.USDC, data)).toBe(word(true));
  });

  it('a rate limit, another RPC error, a server error or no network rejects (then the card says it could not read)', async () => {
    const failures: Reply[] = [
      { status: 429, body: { error: { code: -32005, message: 'rate limited' } } },
      { body: { error: { code: -32005, message: 'limit exceeded' } } },
      { status: 503, body: { error: { code: -32603, message: 'internal error' } } },
      { body: { error: { code: -32000, message: 'header not found' } } },
      'network',
    ];
    for (const failure of failures) await expect(rpcTokenReader(RPC, 31_337, rpc(failure)).call(COINS.USDC, data), JSON.stringify(failure)).rejects.toThrow();
  });

  it('an RPC serving another chain rejects every read; no code is no code', async () => {
    await expect(rpcTokenReader(RPC, 31_337, rpc({ body: { result: word(true) } }, { chain: 1 })).call(COINS.USDC, data)).rejects.toThrow(/serves chain 1/);
    await expect(rpcTokenReader(RPC, 31_337, rpc({ body: { result: word(true) } }, { chain: 1 })).hasCode(COINS.USDC)).rejects.toThrow(/serves chain 1/);
    expect(await rpcTokenReader(RPC, 31_337, rpc({ body: { result: '0x' } }, { code: '0x' })).hasCode(COINS.USDC)).toBe(false);
    expect(await rpcTokenReader(RPC, 31_337, rpc({ body: { result: '0x' } })).hasCode(COINS.USDC)).toBe(true);
  });

  it('a rate-limited freeze getter never reads as "no freeze": the coin says it could not read', async () => {
    const limited = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id: number; method: string; params?: [{ data: Hex }] };
      const name = request.method === 'eth_call' ? decodeFunctionData({ abi: ABI, data: request.params?.[0].data ?? '0x' }).functionName : request.method;
      const body = name === 'eth_chainId' ? { result: '0x7a69' } : name === 'eth_getCode' ? { result: '0x6080' } : name === 'isBlacklisted' ? { error: { code: -32005, message: 'rate limited' } } : { error: { code: 3, message: 'execution reverted' } };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...body }), { status: name === 'isBlacklisted' ? 429 : 200 });
    }) as typeof fetch;
    expect(await issuerPowerLines(rpcTokenReader(RPC, 31_337, limited), 31_337, listed(COINS.CircleUSDC))).toEqual([UNREAD_LINE]);
  });
});
