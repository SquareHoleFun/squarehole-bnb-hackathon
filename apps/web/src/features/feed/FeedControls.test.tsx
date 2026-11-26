import type { AssetIdentity } from '@squarehole/domain';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedControls, SEARCH_DEBOUNCE_MS } from './FeedControls';
import { DEFAULT_FEED_STATE, type FeedUrlState } from './feed-params';

const AAPLX = '0x0000000000000000000000000000000000002329';
const USDC = '0x000000000000000000000000000000000000232a';
const asset = (address: string, symbol: string): AssetIdentity =>
  ({ chainId: 31337, address: address as AssetIdentity['address'], symbol, decimals: 18, issuerStatus: 'mock' });
const ASSETS = [asset(AAPLX, 'AAPLx-DEMO'), asset(USDC, 'USDC-DEMO')];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup(state: FeedUrlState = DEFAULT_FEED_STATE, rewardAssets = ASSETS) {
  const onChange = vi.fn();
  const view = render(<FeedControls state={state} rewardAssets={rewardAssets} onChange={onChange} revision={{}} />);
  /** A navigation: new URL state and a new history-entry identity. */
  const rerender = (next: FeedUrlState) =>
    view.rerender(<FeedControls state={next} rewardAssets={rewardAssets} onChange={onChange} revision={{}} />);
  return { ...view, onChange, rerender };
}

const searchbox = () => screen.getByRole('searchbox', { name: 'Search pairs' }) as HTMLInputElement;
const radio = (name: string) => screen.getByRole('radio', { name }) as HTMLInputElement;
const radios = (group: string) =>
  within(screen.getByRole('radiogroup', { name: group }))
    .getAllByRole('radio')
    .map((radio) => [(radio.closest('label') as HTMLElement).textContent, (radio as HTMLInputElement).checked]);
const options = (label: string) =>
  Array.from((screen.getByLabelText(label) as HTMLSelectElement).options).map((option) => [option.textContent, option.value]);

describe('FeedControls (SH-006: one search, sorts and filters)', () => {
  it('renders exactly one search field, named "Search pairs", holding the URL query', () => {
    setup({ ...DEFAULT_FEED_STATE, q: 'orch' });
    expect(screen.getAllByRole('searchbox')).toHaveLength(1);
    expect(searchbox().value).toBe('orch');
    expect(searchbox().type).toBe('search');
    expect(screen.getByRole('search')).toBeTruthy();
  });

  it('offers the sorts as one exclusive radio group, Market cap first and checked by default', () => {
    setup();
    expect(radios('Sort by')).toEqual([
      ['Market cap', true],
      ['New', false],
      ['Turnover (24h)', false],
    ]);
  });

  it('offers the asset types as a radio group', () => {
    setup({ ...DEFAULT_FEED_STATE, type: 'nft_collection' });
    expect(radios('Asset type')).toEqual([
      ['All', false],
      ['Tokens', false],
      ['NFT collections', true],
    ]);
  });

  it('lists reward options: any, own token, then the snapshot’s reward assets by symbol', () => {
    setup();
    expect(options('Fee share in')).toEqual([
      ['Any asset', ''],
      ['Own token (T)', 'T'],
      ['AAPLx-DEMO', AAPLX],
      ['USDC-DEMO', USDC],
    ]);
  });

  it('lists lifecycle options', () => {
    setup();
    expect(options('Lifecycle')).toEqual([
      ['Any lifecycle', ''],
      ['Bonding curve', 'curve'],
      ['Graduating', 'graduating'],
      ['AMM', 'amm'],
    ]);
  });

  it('pushes a history entry for sort and filter changes', () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByRole('radio', { name: 'New' }));
    expect(onChange).toHaveBeenLastCalledWith({ sort: 'new' }, { replace: false });
    fireEvent.click(screen.getByRole('radio', { name: 'Tokens' }));
    expect(onChange).toHaveBeenLastCalledWith({ type: 'token' }, { replace: false });
    fireEvent.change(screen.getByLabelText('Fee share in'), { target: { value: USDC } });
    expect(onChange).toHaveBeenLastCalledWith({ reward: USDC }, { replace: false });
    fireEvent.change(screen.getByLabelText('Fee share in'), { target: { value: 'T' } });
    expect(onChange).toHaveBeenLastCalledWith({ reward: 'T' }, { replace: false });
    fireEvent.change(screen.getByLabelText('Lifecycle'), { target: { value: 'curve' } });
    expect(onChange).toHaveBeenLastCalledWith({ lifecycle: 'curve' }, { replace: false });
    fireEvent.change(screen.getByLabelText('Lifecycle'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ lifecycle: 'all' }, { replace: false });
  });

  it('shows a chosen sort, type or filter at once, before the URL change commits', () => {
    const { rerender } = setup(); // onChange does not update `state`, like a navigation still in its transition
    fireEvent.click(screen.getByRole('radio', { name: 'New' }));
    expect(radio('New').checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Tokens' }));
    expect(radio('Tokens').checked).toBe(true);
    fireEvent.change(screen.getByLabelText('Lifecycle'), { target: { value: 'amm' } });
    expect((screen.getByLabelText('Lifecycle') as HTMLSelectElement).value).toBe('amm');
    fireEvent.change(screen.getByLabelText('Fee share in'), { target: { value: USDC } });
    expect((screen.getByLabelText('Fee share in') as HTMLSelectElement).value).toBe(USDC);
    // The URL then moves elsewhere (e.g. Back): the controls follow it.
    rerender({ ...DEFAULT_FEED_STATE, sort: 'turnover' });
    expect(radio('Turnover (24h)').checked).toBe(true);
    expect(radio('All').checked).toBe(true);
    expect((screen.getByLabelText('Lifecycle') as HTMLSelectElement).value).toBe('');
  });

  it('drops a pending choice when Back returns to the same URL before the choice was rendered', () => {
    const { rerender } = setup({ ...DEFAULT_FEED_STATE, sort: 'new' });
    fireEvent.click(screen.getByRole('radio', { name: 'Turnover (24h)' }));
    expect(radio('Turnover (24h)').checked).toBe(true);
    rerender({ ...DEFAULT_FEED_STATE, sort: 'new' }); // same URL, new history entry identity
    expect(radio('New').checked).toBe(true);
  });

  it('debounces typing and replaces the history entry (≤200 ms)', () => {
    const { onChange } = setup();
    fireEvent.change(searchbox(), { target: { value: 'or' } });
    act(() => vi.advanceTimersByTime(50));
    fireEvent.change(searchbox(), { target: { value: ' orc ' } });
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1));
    expect(onChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ q: 'orc' }, { replace: true });
    expect(SEARCH_DEBOUNCE_MS).toBeLessThanOrEqual(200);
  });

  it('commits immediately on Enter', () => {
    const { onChange } = setup();
    fireEvent.change(searchbox(), { target: { value: 'tree' } });
    fireEvent.submit(searchbox().closest('form') as HTMLFormElement);
    expect(onChange).toHaveBeenCalledWith({ q: 'tree' }, { replace: true });
    act(() => vi.advanceTimersByTime(500));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('keeps a trailing space while typing (the URL holds the normalised query)', () => {
    const { onChange, rerender } = setup();
    fireEvent.change(searchbox(), { target: { value: 'little ' } });
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(onChange).toHaveBeenCalledWith({ q: 'little' }, { replace: true });
    rerender({ ...DEFAULT_FEED_STATE, q: 'little' });
    expect(searchbox().value).toBe('little ');
  });

  it('keeps a keystroke typed while its previous commit is still reaching the URL', () => {
    const { onChange, rerender } = setup();
    fireEvent.change(searchbox(), { target: { value: 'or' } });
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    fireEvent.change(searchbox(), { target: { value: 'orc' } });
    rerender({ ...DEFAULT_FEED_STATE, q: 'or' }); // the echo of the first commit arrives late
    expect(searchbox().value).toBe('orc');
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(onChange).toHaveBeenLastCalledWith({ q: 'orc' }, { replace: true });
  });

  it('follows the URL again after an external change back to an earlier query', () => {
    const { rerender } = setup();
    fireEvent.change(searchbox(), { target: { value: 'orc' } });
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    rerender({ ...DEFAULT_FEED_STATE, q: 'orc' });
    rerender({ ...DEFAULT_FEED_STATE, q: 'tree' }); // Back
    expect(searchbox().value).toBe('tree');
    rerender({ ...DEFAULT_FEED_STATE, q: 'orc' }); // Forward
    expect(searchbox().value).toBe('orc');
  });

  it('follows the URL on Back/Forward and drops a pending commit', () => {
    const { onChange, rerender } = setup({ ...DEFAULT_FEED_STATE, q: 'orch' });
    fireEvent.change(searchbox(), { target: { value: 'orchx' } });
    rerender({ ...DEFAULT_FEED_STATE, q: 'tree' });
    expect(searchbox().value).toBe('tree');
    act(() => vi.advanceTimersByTime(500));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not commit an unchanged query', () => {
    const { onChange } = setup({ ...DEFAULT_FEED_STATE, q: 'orch' });
    fireEvent.change(searchbox(), { target: { value: 'orch  ' } });
    act(() => vi.advanceTimersByTime(500));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('has no amount or number inputs (UI-01)', () => {
    const { container } = setup();
    expect(container.querySelectorAll('input[type="number"], textarea')).toHaveLength(0);
    expect(container.textContent).not.toMatch(/\b(buy|sell|swap)\b/i);
  });
});
