/**
 * SH-BOX-LIFE-VIEW § 3: a v2 box names its price coin by the coin's own symbol, read the way Create reads a listed coin's
 * (an ERC-20 `symbol()` view call, a 1-32 character string), the native coin "ETH" as Create names it, and the coin's
 * short address while the symbol is unread or unreadable: never "P". The record carries the name, so every amount on
 * the page and on the feed card is in it.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionResult, erc20Abi, type Address, type Hex } from 'viem';
import { parseSnapshotV2 } from './indexer-v2';
import { coinLabelV2, readCoinSymbolV2, shortCoinV2, usePriceCoinSymbolsV2 } from './price-coin';
import { recordV2, summaryV2 } from './record-v2';
import { gpuPoorLifeV2, recordedLifeV2, sepoliaLifeSourceV2 } from './test-support/life-v2';

const source = sepoliaLifeSourceV2();
const TNVDA = '0x2cbBAD2607fCCFEe778d959d386997862099f33B' as Address;
const NATIVE = '0x0000000000000000000000000000000000000000' as Address;
const symbolData = (symbol: string): Hex => encodeFunctionResult({ abi: erc20Abi, functionName: 'symbol', result: symbol });

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('the price coin’s name', () => {
  it('reads a listed coin’s symbol; a revert, no data or no short string is no symbol; a failed read rejects', async () => {
    expect(await readCoinSymbolV2({ call: async () => symbolData('tNVDA') }, TNVDA)).toBe('tNVDA');
    expect(await readCoinSymbolV2({ call: async () => null }, TNVDA)).toBeNull();
    expect(await readCoinSymbolV2({ call: async () => symbolData('') }, TNVDA)).toBeNull();
    expect(await readCoinSymbolV2({ call: async () => symbolData('X'.repeat(33)) }, TNVDA)).toBeNull();
    expect(await readCoinSymbolV2({ call: async () => '0x1234' as Hex }, TNVDA)).toBeNull();
    await expect(readCoinSymbolV2({ call: async () => { throw new Error('rate limited'); } }, TNVDA)).rejects.toThrow('rate limited');
  });

  it('names the native coin ETH, a read coin by its symbol, an unread one by its short address: never P', () => {
    expect(coinLabelV2(NATIVE, null)).toBe('ETH');
    expect(coinLabelV2(NATIVE, 'WHATEVER')).toBe('ETH');
    expect(coinLabelV2(TNVDA, 'tNVDA')).toBe('tNVDA');
    expect(coinLabelV2(TNVDA, null)).toBe('0x2cbB…f33B');
    expect(shortCoinV2(TNVDA)).toBe('0x2cbB…f33B');
  });

  it('the record carries it, so the card and the page name tNVDA (GPU Poor), ETH (Dragon’s Hoard), or the short address', () => {
    const gpu = parseSnapshotV2(gpuPoorLifeV2('raising').body, source);
    const named = recordV2(gpu, source, null, 'tNVDA');
    expect([named.pairAsset, named.setup]).toEqual(['tNVDA', '1% of every trade: in tNVDA on buys, in VRAM on sales']);
    expect(summaryV2(named, gpu, false).figure.text).toBe('42.1% · 42.1 / 100 tNVDA');
    expect(recordV2(gpu, source).pairAsset).toBe('0x2cbB…f33B');
    const hoard = parseSnapshotV2(recordedLifeV2.dragonsHoard.body, source);
    expect(recordV2(hoard, source, null, null).pairAsset).toBe('ETH');
  });

  it('the hook reads each listed coin once for the page’s life (never the native coin), and retries a failed read twice', async () => {
    vi.useFakeTimers();
    const reads: string[] = [];
    let failures = 2;
    const reader = {
      call: async (to: Address) => {
        reads.push(to.toLowerCase());
        if (to.toLowerCase() === TNVDA.toLowerCase() && failures-- > 0) throw new Error('busy');
        return symbolData(to.toLowerCase() === TNVDA.toLowerCase() ? 'tNVDA' : 'tUSDC');
      },
    };
    const USDC = '0x5B397F65571deF193Ba5DBE8b2a353C3963c65F6';
    function Probe({ coins }: { coins: readonly string[] }) {
      const symbolOf = usePriceCoinSymbolsV2(source, coins, reader);
      return <p>{coins.map((coin) => coinLabelV2(coin, symbolOf(coin))).join(' | ')}</p>;
    }
    const client = new QueryClient();
    const view = render(<QueryClientProvider client={client}><Probe coins={[TNVDA, NATIVE, USDC, TNVDA.toLowerCase()]} /></QueryClientProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('0x2cbB…f33B | ETH | tUSDC | 0x2cbb…f33b')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    // react-query hands results on in a timer of its own.
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText('tNVDA | ETH | tUSDC | tNVDA')).toBeTruthy();
    expect(reads.filter((r) => r === TNVDA.toLowerCase())).toHaveLength(3);
    expect(reads).not.toContain(NATIVE);
    // A new feed read with the same coins asks nothing again.
    view.rerender(<QueryClientProvider client={client}><Probe coins={[USDC, TNVDA]} /></QueryClientProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(reads).toHaveLength(4);
    expect(screen.getByText('tUSDC | tNVDA')).toBeTruthy();
  });
});
