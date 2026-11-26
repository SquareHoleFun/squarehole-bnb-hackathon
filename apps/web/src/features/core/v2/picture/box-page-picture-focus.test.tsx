/**
 * SH-273: a sheet shut by Escape gives focus back to its part a moment later (a timeout, after the sheet is gone). On a
 * busy page (BNB Chain testnet's data refreshes about every second) that moment can come after the reader has already
 * opened the next part's sheet: focus then jumped to the old part, the new sheet took that as focus leaving it and shut
 * (the look on chain 97: 3 and 4 of 99 openings). The way back to the part may only take focus that went nowhere.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AppProviders } from '../../../../app-providers';
import { createDemoWalletAdapter } from '../../../wallet';
import { lifeStepsV2 } from '../life-state';
import { boxPictureFixture } from '../test-support/box-picture-v2';
import BoxPagePicture from './BoxPagePicture';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function page() {
  const { record, view } = boxPictureFixture('gpu-poor');
  const nowSec = view.timestamp;
  render(
    <AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}><MemoryRouter>
      <BoxPagePicture record={record} view={view} life={{ steps: lifeStepsV2({ view, nowSec, coin: 'tNVDA', ticker: 'VRAM', price: '0.58', graduatedAt: view.timestamp - 3_600n }), stage: 'graduated', nowSec }}
        alchemist={{ buyers: false, sellers: false }} pileCoin={null} idLine={null} notice={null} creatorClaim={null} entries={[]} closable={false} />
    </MemoryRouter></AppProviders>,
  );
}
const part = (id: string) => document.querySelector(`[data-part="${id}"]`) as SVGGElement;

it('the next sheet opened before the way back runs stays open, with focus in it', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  page();
  fireEvent.click(part('raise'));
  expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  // The reader is quicker than the page: the pool's sheet opens before the way back to the raise runs.
  act(() => { part('pool').focus(); });
  fireEvent.click(part('pool'));
  const sheet = screen.getByRole('dialog');
  act(() => { vi.runAllTimers(); });
  expect(screen.queryByRole('dialog')).toBe(sheet);
  expect(sheet.contains(document.activeElement)).toBe(true);
});

it('with nothing opened meanwhile, Escape still gives focus back to the part', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  page();
  act(() => { part('raise').focus(); });
  fireEvent.click(part('raise'));
  expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.keyDown(document, { key: 'Escape' });
  act(() => { vi.runAllTimers(); });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(part('raise'));
});
