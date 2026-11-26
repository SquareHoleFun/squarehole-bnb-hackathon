import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionResult, keccak256, type Address, type Hex, type PublicClient } from 'viem';
import { AtlasBook, ATLAS_MAINNET_REGISTRY, atlasAbi, type AtlasFeed } from '../../chain/src/atlas/atlas-price';
import type { CoinFeed } from '../../chain/src/atlas/atlas-feeds';
import { testCoinRates, type EthParityPin } from '../src/income-parity-manifest';
import { readEthParityPrice } from '../src/income-parity';
import { atlasSettingsFrom, bookRates, setAtlasRates, DEFAULT_ATLAS_MAINNET_RPC_URLS } from '../src/atlas-rates';
import { incomeRefusal, type IncomeSnapshot } from '../src/income';

// SH-266: on chain 97 a pinned coin with an Atlas feed is valued at live prices (coin USD over BNB USD); without a
// fresh price the box's income counts nothing (no upkeep). Fixture pins and a fixture coin table: the real ones are
// checked in bnb-testnet-parity.test.ts and in packages/chain.
const mocked = vi.hoisted(() => ({ entries: undefined as Record<string, EthParityPin> | undefined }));
vi.mock('../src/income-parity-manifest', async original => {
  const real = await original<typeof import('../src/income-parity-manifest')>();
  return { ...real, get ethParityManifest() { return mocked.entries ?? real.ethParityManifest; } };
});
afterEach(() => { mocked.entries = undefined; setAtlasRates(null); });

const code = '0x6000600060006000';
const tNVDA: Address = '0x9797979797979797979797979797979797970001';
const tGOLD: Address = '0x9797979797979797979797979797979797970003';
const pin = (token: Address, weiPerCoin: string): EthParityPin => ({ chainId: '97', token, decimals: '18', codeHash: keccak256(code), weiPerCoin });
const pub = { getChainId: vi.fn(async () => 97), getBytecode: vi.fn(async () => code), readContract: vi.fn(async () => 18n) } as unknown as PublicClient;
const block = { number: 5_000_000n, timestamp: 1_800_000_000n };

const BNB_FEED: Address = '0x9797979797979797979797979797979797979797';
const feeds: AtlasFeed[] = [
  { name: 'BNB/USD', atlasId: 633, source: { kind: 'single', chainId: 97n, address: BNB_FEED }, maxAgeSeconds: 180n },
  { name: 'NVDAB/USD', atlasId: 934, source: { kind: 'multi', chainId: 56n, registry: ATLAS_MAINNET_REGISTRY, feedId: 934 }, maxAgeSeconds: 180n },
];
const table: CoinFeed[] = [{ symbol: 'tNVDA', token: tNVDA.toLowerCase() as Address, decimals: 18, feed: 'NVDAB/USD', standsInFor: 'NVDAB' }];
// Prices as Atlas answered on 25 November 2026: BNB/USD 542.62 (chain 97), NVDAB/USD 149.91 (BNB mainnet).
const BNB_USD = 542623466255465080160n, NVDAB_USD = 149912509665791584390n;
const T = 1_800_000_000n;

function book(at = T, nvdabAt = at) {
  const dec = encodeFunctionResult({ abi: atlasAbi, functionName: 'decimals', result: 18 });
  const answer = (to: Address, data: Hex): Hex => {
    if (data.startsWith('0x313ce567')) return dec;
    if (to.toLowerCase() === BNB_FEED.toLowerCase()) return encodeFunctionResult({ abi: atlasAbi, functionName: 'latestRoundData', result: [1n, BNB_USD, at - 1n, at, 1n] });
    return encodeFunctionResult({ abi: atlasAbi, functionName: 'fetchBatch', result: [{ price: NVDAB_USD, aggregatedTs: Number(nvdabAt), onchainTs: Number(nvdabAt) }] });
  };
  const call = async (to: Address, data: Hex) => answer(to, data);
  return new AtlasBook(feeds, () => [call, async (t: Address, d: Hex) => call(t, d)]);
}

describe('SH-266: the keeper values chain-97 income at Atlas prices', () => {
  it('a mapped coin: live value (coin USD over BNB USD), not the rate literal; logs price and age', async () => {
    mocked.entries = { [`97:${tNVDA.toLowerCase()}`]: pin(tNVDA, testCoinRates.tNVDA) };
    const b = book();
    await b.refresh(T + 20n);
    const info = vi.fn(), warn = vi.fn();
    setAtlasRates(bookRates(b, '97', () => T + 30n, { info, warn }, table));
    const price = await readEthParityPrice(pub, tNVDA, block);
    expect(price?.quote(10n ** 18n)).toBe(10n ** 18n * NVDAB_USD * 10n ** 18n / (BNB_USD * 10n ** 18n));
    // 0.2762... tBNB per tNVDA where the pin said 10: 36 times less.
    expect(price?.quote(10n ** 18n)).toBe(276273546922523510n);
    expect(BigInt(testCoinRates.tNVDA) / (price?.quote(10n ** 18n) ?? 1n)).toBe(36n);
    expect(price?.route.startsWith('atlas:97:')).toBe(true);
    expect(info).toHaveBeenCalledWith('atlas: income valued at live prices', expect.objectContaining({ coin: 'tNVDA', priceAgeSeconds: '30', bnbAgeSeconds: '30', source: 'Atlas' }));
  });

  it('fail closed: a stale price refuses (VALUATION_UNAVAILABLE), never the rate literal', async () => {
    mocked.entries = { [`97:${tNVDA.toLowerCase()}`]: pin(tNVDA, testCoinRates.tNVDA) };
    const b = book();
    await b.refresh(T);
    const warn = vi.fn();
    setAtlasRates(bookRates(b, '97', () => T + 181n, { info: vi.fn(), warn }, table));
    await expect(readEthParityPrice(pub, tNVDA, block)).rejects.toMatchObject({ code: 'VALUATION_UNAVAILABLE', message: 'atlas price unavailable: NVDAB/USD STALE' });
    expect(warn).toHaveBeenCalledWith('atlas: no fresh price, no upkeep paid by this coin', { coin: 'tNVDA', feed: 'NVDAB/USD', refusal: 'STALE' });
    // Never read at all: refused too.
    setAtlasRates(bookRates(book(), '97', () => T, undefined, table));
    await expect(readEthParityPrice(pub, tNVDA, block)).rejects.toMatchObject({ code: 'VALUATION_UNAVAILABLE' });
  });

  it('one stale leg at a time refuses, and a quote held past its prices refuses at use', async () => {
    mocked.entries = { [`97:${tNVDA.toLowerCase()}`]: pin(tNVDA, testCoinRates.tNVDA) };
    // The stock leg stale, BNB fresh.
    const a = book(T, T - 100n);
    await a.refresh(T);
    setAtlasRates(bookRates(a, '97', () => T + 81n, undefined, table));
    await expect(readEthParityPrice(pub, tNVDA, block)).rejects.toMatchObject({ message: 'atlas price unavailable: NVDAB/USD STALE' });
    // BNB stale, the stock fresh.
    const b = book(T - 100n, T);
    await b.refresh(T);
    setAtlasRates(bookRates(b, '97', () => T + 81n, undefined, table));
    await expect(readEthParityPrice(pub, tNVDA, block)).rejects.toMatchObject({ message: 'atlas price unavailable: BNB/USD STALE' });
    // A quote taken while fresh, used after expiry.
    let now = T + 10n;
    const c = book();
    await c.refresh(T);
    setAtlasRates(bookRates(c, '97', () => now, undefined, table));
    const price = await readEthParityPrice(pub, tNVDA, block);
    expect(price?.quote(10n ** 18n)).toBeGreaterThan(0n);
    now = T + 181n;
    expect(() => price?.quote(10n ** 18n)).toThrow(/expired at use/);
  });

  it('a coin without a feed keeps its pin and the log says so; with no provider every coin keeps its pin', async () => {
    mocked.entries = { [`97:${tGOLD.toLowerCase()}`]: pin(tGOLD, testCoinRates.tGOLD), [`97:${tNVDA.toLowerCase()}`]: pin(tNVDA, testCoinRates.tNVDA) };
    const info = vi.fn();
    setAtlasRates(bookRates(book(), '97', () => T, { info, warn: vi.fn() }, table));
    expect((await readEthParityPrice(pub, tGOLD, block))?.quote(10n ** 18n)).toBe(BigInt(testCoinRates.tGOLD));
    expect(info).toHaveBeenCalledWith('atlas: pinned, no feed', { token: tGOLD });
    setAtlasRates(null);
    expect((await readEthParityPrice(pub, tNVDA, block))?.quote(10n ** 18n)).toBe(BigInt(testCoinRates.tNVDA));
  });

  it('the income rule with live prices: one deepening at 0.1 gwei is refused under its cost and allowed over it', async () => {
    mocked.entries = { [`97:${tNVDA.toLowerCase()}`]: pin(tNVDA, testCoinRates.tNVDA) };
    const b = book();
    await b.refresh(T);
    setAtlasRates(bookRates(b, '97', () => T, undefined, table));
    const price = await readEthParityPrice(pub, tNVDA, block);
    const box: Address = '0x0000000000000000000000000000000000000b0c';
    // A deepening reserves 8,000,000 gas at 0.1 gwei: 0.0008 tBNB (hackathon/stack/keeper.env.example).
    const cost = 8_000_000n * 100_000_000n;
    const snapshot = (shareWei: bigint): IncomeSnapshot => ({ at: T, platformWei: shareWei * 4n, boxes: { [box]: { shareWei, tipsWei: 0n } }, mined: {} });
    // 0.002 tNVDA of the box's own income: 0.00055 tBNB at Atlas prices, under the cost (the pin would have said 0.02).
    expect(incomeRefusal(box, cost, [], snapshot(price?.quote(2n * 10n ** 15n) ?? 0n))).toBe('box income cap');
    // 0.003 tNVDA: 0.00083 tBNB, over the cost.
    expect(incomeRefusal(box, cost, [], snapshot(price?.quote(3n * 10n ** 15n) ?? 0n))).toBeNull();
  });

  it('settings: on by default for chain 97 only, public https endpoints only', () => {
    // Off unless switched on, on every network.
    expect(atlasSettingsFrom({}, 97)).toEqual({ enabled: false, mainnetRpcUrls: DEFAULT_ATLAS_MAINNET_RPC_URLS });
    expect(atlasSettingsFrom({}, 11155111).enabled).toBe(false);
    expect(atlasSettingsFrom({ SH_KEEPER_ATLAS: '1' }, 97).enabled).toBe(true);
    expect(() => atlasSettingsFrom({ SH_KEEPER_ATLAS: '1' }, 11155111)).toThrow(/chain 97 only/);
    expect(() => atlasSettingsFrom({ SH_KEEPER_ATLAS_MAINNET_RPC_URLS: 'https://example.invalid/?key=x' }, 97)).toThrow(/public https/);
    expect(atlasSettingsFrom({ SH_KEEPER_ATLAS_MAINNET_RPC_URLS: 'https://a.example, https://b.example' }, 97).mainnetRpcUrls).toEqual(['https://a.example', 'https://b.example']);
  });
});

describe('SH-266: the band references on disk', () => {
  it('an existing reference file that cannot be read holds every valuation (never the pin), until a save rewrites it', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { startAtlasService } = await import('../src/atlas-service');
    const dir = mkdtempSync(join(tmpdir(), 'sh266-'));
    writeFileSync(join(dir, 'keeper.json.dry.atlas.json'), '{ not json');
    mocked.entries = { [`97:${tNVDA.toLowerCase()}`]: pin(tNVDA, testCoinRates.tNVDA) };
    const warn = vi.fn();
    const cfg = { chainId: 97, stateFile: join(dir, 'keeper.json'), dryRun: true, rpcUrl: 'https://bsc-testnet-rpc.publicnode.com', rpcFallbackUrl: null } as never;
    const service = startAtlasService({ env: { SH_KEEPER_ATLAS: '1' }, cfg, log: { info: vi.fn(), warn } });
    expect(service).not.toBeNull();
    expect(warn).toHaveBeenCalledWith('atlas: references unreadable, valuations wait until they are rewritten', {});
    // tNVDA is mapped in the real table only by its real address; the fixture coin stays pinned, so ask for the real one.
    const realNvda = '0x2F8029A6447663e0881b0E21F5E4aD0f1717627e' as Address;
    mocked.entries = { [`97:${realNvda.toLowerCase()}`]: pin(realNvda, testCoinRates.tNVDA) };
    await expect(readEthParityPrice(pub, realNvda, block)).rejects.toMatchObject({ code: 'VALUATION_UNAVAILABLE', message: 'atlas prices held: references unreadable' });
  });
});
