/**
 * The v2 parts beyond the Demo page (M1-53-b): the clone line's link on Sepolia and its refusal to call another
 * implementation a clone of the release (F103); "Close box" on a box with no sender (a chain box in this build), with a
 * sender that fails, after a wallet window closed without connecting and on another network; the header of a box that
 * is closed, closable or still waiting, and of a broken answer.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { demoHeader } from '../../boxes/box-stats';
import { DEMO_WRONG_CHAIN_ID, WalletProvider, createDemoWalletAdapter, useWallet } from '../../wallet';
import { CloneLine } from './CloneLine';
import { CloseBox, type CloseRequest } from './CloseBox';
import { demoV2Boxes } from './demo-v2';
import { v2Header } from './v2-header';
import { CLONE_LINE, CLOSE_BOX, IMPLEMENTATION_LINK, IMPLEMENTATION_UNCHECKED } from './v2-words';

afterEach(cleanup);

const NOW = BigInt(Math.floor(Date.now() / 1000));
const [marbles, keys, hats, boats] = demoV2Boxes(NOW);
if (!marbles?.v2 || !keys?.v2 || !hats?.v2 || !boats?.v2) throw new Error('the Demo v2 boxes: Glass Marbles, Brass Keys, Felt Hats, Cork Boats');
const facts = marbles.v2;
const boatsFacts = boats.v2;
const hatsFacts = hats.v2;

describe('CloneLine (F103)', () => {
  it('on Sepolia: the link to the implementation’s verified code, opened apart', () => {
    render(<CloneLine facts={{ ...facts, network: 'sepolia' }} />);
    const link = screen.getByRole('link', { name: new RegExp(`^${IMPLEMENTATION_LINK}`) });
    expect(link.getAttribute('href')).toBe(`https://sepolia.etherscan.io/address/${facts.tImplementation}#code`);
    expect([link.getAttribute('target'), link.getAttribute('rel')]).toEqual(['_blank', 'noopener noreferrer']);
    expect(document.body.textContent).toContain(CLONE_LINE);
  });

  it('another implementation than the release’s: no clone claim and no link', () => {
    render(<CloneLine facts={{ ...facts, network: 'sepolia', tImplementation: '0x00000000000000000000000000000000000bad01' }} />);
    expect(document.body.textContent).toBe(IMPLEMENTATION_UNCHECKED);
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('CloseBox without the Demo’s sender', () => {
  /** The header's own wallet controls, outside the Close box flow. */
  function Elsewhere() {
    const wallet = useWallet();
    return (
      <>
        <button type="button" onClick={() => wallet.disconnect()}>
          Disconnect
        </button>
        <button type="button" onClick={() => void wallet.connect('box_wallet_a')}>
          Connect elsewhere
        </button>
        <button type="button" onClick={() => void wallet.connect('box_wallet_a', { chainId: DEMO_WRONG_CHAIN_ID })}>
          Connect on another chain
        </button>
      </>
    );
  }
  const renderClose = (sender: ((request: CloseRequest) => Promise<void>) | null) =>
    render(
      <WalletProvider adapter={createDemoWalletAdapter({ latencyMs: 0 })} walletKinds="demo">
        <CloseBox record={marbles} sender={sender} />
        <Elsewhere />
      </WalletProvider>,
    );

  it('a wallet window closed without connecting goes back to the button; a later connection elsewhere asks nothing', async () => {
    const seen: CloseRequest[] = [];
    renderClose(async (request) => {
      seen.push(request);
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: CLOSE_BOX })));
    await act(async () => fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' })));
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Connect elsewhere' })));
    expect(screen.queryByRole('group', { name: CLOSE_BOX })).toBeNull();
    expect(screen.getByRole('button', { name: CLOSE_BOX })).toBeTruthy();
    expect(seen).toEqual([]);
  });

  it('a wallet on another network: "Wrong network", Confirm disabled, nothing sent', async () => {
    const seen: CloseRequest[] = [];
    renderClose(async (request) => {
      seen.push(request);
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Connect on another chain' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: CLOSE_BOX })));
    const confirm = screen.getByRole('group', { name: CLOSE_BOX });
    expect(confirm.textContent).toContain('Wrong network');
    const button = within(confirm).getByRole('button', { name: 'Confirm close' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await act(async () => fireEvent.click(button));
    expect(seen).toEqual([]);
  });

  it('a wallet that disconnects during the confirmation takes it away: back to the button, nothing sent', async () => {
    const seen: CloseRequest[] = [];
    renderClose(async (request) => {
      seen.push(request);
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: CLOSE_BOX })));
    await act(async () => fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Connect sample wallet' })));
    // Cancel, then press again with the wallet connected: straight to the confirmation.
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: CLOSE_BOX })));
    expect(screen.getByRole('group', { name: CLOSE_BOX })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Disconnect' })));
    expect(screen.queryByRole('group', { name: CLOSE_BOX })).toBeNull();
    expect(screen.getByRole('button', { name: CLOSE_BOX })).toBeTruthy();
    expect(seen).toEqual([]);
  });

  it('no sender (a chain box in this build): no button, though the box could be closed', () => {
    renderClose(null);
    expect(screen.queryByRole('button', { name: CLOSE_BOX })).toBeNull();
  });

  it('a send that fails says so and keeps the confirmation; the request was the coordinator’s fail()', async () => {
    const seen: CloseRequest[] = [];
    renderClose(async (request) => {
      seen.push(request);
      throw new Error('the wallet said no');
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: CLOSE_BOX })));
    const dialog = screen.getByRole('dialog');
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Connect sample wallet' })));
    const confirm = screen.getByRole('group', { name: CLOSE_BOX });
    await act(async () => fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm close' })));
    expect(screen.getByRole('alert').textContent).toBe('Not closed · the wallet said no');
    expect(seen).toEqual([{ to: facts.coordinator, call: 'fail', data: '0xa9cc4718' }]);
  });
});

describe('v2Header: a closed box’s band and amounts', () => {
  const base = { stats: [{ label: 'Items', value: '1' }], band: { figure: null, barBps: null }, phase: null };

  it('the band carries the closing price per 1M; pool and tip at most 4 decimals, truncated', () => {
    const closed = { ...marbles, demoState: 'failed' as const, v2: { ...facts, failure: { cause: 'deadline' as const, at: NOW, closing: { pInRange: 1_723_861_834_850_000_000n, tOutstanding: 410_123_456n * 10n ** 18n, tip: 999_999_999_999_999n } } } };
    const head = v2Header(closed, base, NOW);
    expect(head.band.figure).toBe('0.0042032 ETH per 1M');
    expect(head.stats.map((stat) => [stat.label, stat.value, stat.unit])).toEqual([
      ['Items', '1', undefined],
      ['Closing price', '0.0042032', 'ETH per 1M MRBL'],
      ['Closing pool', '1.7238', 'ETH'],
    ]);
    expect(head.phase).toBe('Closed · deadline passed · closer’s tip 0.0009 ETH');
    expect(v2Header(hats, base, NOW).band.figure).toBe('13.738 USDC per 1M');
  });

  it('the closing price’s info says it is paid in the pricing token, never in the box’s own token', () => {
    const info = v2Header(hats, base, NOW).stats.find((stat) => stat.label === 'Closing price')?.info;
    expect(info).toMatch(/paid in USDC/);
    expect(info).not.toMatch(/HATS|own token/);
  });

  it('a hostile or broken answer (decimals out of range, negative amounts) shows "Not available", never throws', () => {
    const hostile = (v2: typeof hatsFacts) => v2Header({ ...hats, v2 }, base, NOW);
    const closing = { pInRange: -8_412_500_000n, tOutstanding: 10n ** 24n, tip: -1n };
    const failure = { cause: 'deadline' as const, at: NOW, closing };
    for (const head of [hostile({ ...hatsFacts, failure }), hostile({ ...hatsFacts, pricing: { ...hatsFacts.pricing, decimals: 99 } }), hostile({ ...hatsFacts, pricing: { ...hatsFacts.pricing, decimals: 1.5 } })]) {
      expect(head.band.figure).toBeNull();
      expect(head.stats.slice(1).map((stat) => typeof stat.value)).toEqual(['object', 'object']);
      expect(head.phase).toBe('Closed · deadline passed');
    }
    expect(v2Header({ ...marbles, v2: { ...facts, pricing: { ...facts.pricing, decimals: 40 } } }, base, NOW).phase).toBe('Anyone can close it');
  });
});

describe('v2Header: a box anyone may close, or one still waiting (IBoxHookV2: every swap reverts from the deadline)', () => {
  const stats = (head: ReturnType<typeof demoHeader>) => head.stats.map((stat) => [stat.label, stat.value, stat.unit]);

  it('past its deadline: no running curve, no price; the band says why, the phase who may close it', () => {
    const head = demoHeader(marbles);
    expect(head.band).toEqual({ figure: 'Deadline passed', barBps: null });
    expect(stats(head)).toEqual([
      ['Items', '80', undefined],
      ['Reserved', '11', undefined],
      ['Progress', '41.0%', 'at the deadline'],
    ]);
    expect(head.phase).toBe('Anyone can close it · tip up to 0.001 ETH');
  });

  it('still closed past the gate’s cap: the band says so', () => {
    const head = demoHeader(keys);
    expect(head.band).toEqual({ figure: 'Not open after 14 days', barBps: null });
    expect(head.phase).toBe('Anyone can close it · tip up to 0.05 LINK');
  });

  it('before its deadline: the days left come from the deadline itself', () => {
    expect(demoHeader(boats).phase).toBe('Ends in 21 d if the curve does not fill');
    const soon = { ...boats, v2: { ...boatsFacts, deadline: NOW + 5n * 3_600n } };
    expect(demoHeader(soon, Number(NOW) * 1_000).phase).toBe('Ends in 5 h if the curve does not fill');
  });
});
