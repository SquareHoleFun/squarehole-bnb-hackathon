/**
 * SH-255 (the full run of 25 November): the page's clock ticks every second; the picture's drawing must not render
 * again for it. A tick changes only what reads the clock: the life strip and an open raise sheet's "Full ... ago". A
 * new snapshot renders the drawing again. The drawing's renders are counted through the shared component.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AppProviders } from '../../../../app-providers';
import { createDemoWalletAdapter } from '../../../wallet';
import { lifeStepsV2 } from '../life-state';
import { boxPictureFixture } from '../test-support/box-picture-v2';
import BoxPagePicture from './BoxPagePicture';
import type { V2Snapshot } from '../indexer-v2';

const renders = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../../create/picture/BoxPictureSvg', async (original) => {
  const mod = await original<typeof import('../../../create/picture/BoxPictureSvg')>();
  return { ...mod, BoxPictureSvg: (props: Parameters<typeof mod.BoxPictureSvg>[0]) => { renders.count += 1; return mod.BoxPictureSvg(props); } };
});
afterEach(cleanup);

it('a tick of the clock re-renders the strip and the open raise sheet, never the drawing; a new snapshot does', async () => {
  const { record, view } = boxPictureFixture('gpu-poor');
  // As V2BoxPage renders it on each tick: a new life object, new objects for the checks and the pile coin.
  const tree = (shown: V2Snapshot, nowSec: bigint) => (
    <AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}><MemoryRouter>
      <BoxPagePicture record={record} view={shown} life={{ steps: lifeStepsV2({ view: shown, nowSec, coin: 'tNVDA', ticker: 'VRAM', price: '0.58', graduatedAt: shown.timestamp - 3_600n }), stage: 'graduated', nowSec }}
        alchemist={{ buyers: false, sellers: false }} pileCoin={null} idLine={null} notice={null} creatorClaim={null} entries={[]} closable={false} />
    </MemoryRouter></AppProviders>
  );
  const t = view.timestamp;
  const page = render(tree(view, t));
  fireEvent.click(document.querySelector('[data-part="raise"]') as Element);
  const sheetText = () => screen.getByRole('dialog').textContent ?? '';
  const stripText = () => document.querySelector('.sh-bpic-head .sh-life')?.textContent ?? '';
  const before = { renders: renders.count, sheet: sheetText(), strip: stripText() };
  // Two days later on the reader's clock, the same snapshot ("... ago" moves at any scale).
  await act(async () => { page.rerender(tree(view, t + 172_800n)); });
  expect(renders.count).toBe(before.renders);
  expect(sheetText()).not.toBe(before.sheet);
  expect(stripText()).not.toBe(before.strip);
  // A new snapshot: the drawing renders again.
  await act(async () => { page.rerender(tree({ ...view, block: view.block + 1n, timestamp: view.timestamp + 12n }, t + 172_812n)); });
  expect(renders.count).toBeGreaterThan(before.renders);
});
