/**
 * MF23-6 pinned before T06 moved the 3D viewer into a shared component (scene/ItemModelView.tsx): the v1 item list's View 3D
 * behaves as before. Nothing is asked for a model until the press; the press asks loadItemModel for the indexer's art
 * route with the committed hash; a failed load keeps the picture and says so; Close aborts the read and disposes what
 * was drawn. The controller module is a double here (the real loader has its own tests in scene/controller.test.ts).
 */
import { DEMO_CHAIN_ID } from '@squarehole/domain';
import { rawCid } from '@squarehole/indexer/client';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_BOX0_ROW } from '../core/demo-row';
import { recordFromRow } from '../core/row-record';
import { RevealedItems } from './ChainItems';

const loader = vi.hoisted(() => ({ calls: [] as { host: HTMLElement; url: string; sha256: string; signal: AbortSignal }[], next: null as null | (() => Promise<() => void>) }));
vi.mock('../scene/controller', () => ({
  loadItemModel: (host: HTMLElement, url: string, sha256: string, signal: AbortSignal) => {
    loader.calls.push({ host, url, sha256, signal });
    return loader.next ? loader.next() : new Promise<() => void>(() => undefined);
  },
}));

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const ORIGIN = 'https://indexer.invalid';
const hash = `0x${'12'.repeat(32)}` as const;
const record = recordFromRow({ row: DEMO_BOX0_ROW, network: 'local' }, { nowMs: NOW });
const item = { schema: 'sh.core-item.v1', chainId: record.chainId, token: record.token, id: '1',
  asOf: { block: '100', hash: `0x${'ab'.repeat(32)}`, timestamp: '1800000000', tier: 'head' }, revealed: true, traitsPacked: '1', traits: [],
  art: { image: { sha256: hash, cid: rawCid(hash) }, avatar: { sha256: hash, cid: rawCid(hash) }, model: { sha256: hash, cid: rawCid(hash) } } };
const fetcher = vi.fn(async () => new Response(JSON.stringify({ items: [item], next: null })));

afterEach(() => { cleanup(); loader.calls = []; loader.next = null; fetcher.mockClear(); });

async function open() {
  const view = render(<RevealedItems record={record} origin={ORIGIN} fetcher={fetcher} />);
  await screen.findByRole('button', { name: 'View 3D model for #1' });
  return view;
}

describe('MF23-6 the v1 item list’s View 3D (pinned for T06)', () => {
  it('asks for nothing until the press; the press loads the indexer’s model route with the committed hash into its own host', async () => {
    const { container } = await open();
    expect(loader.calls).toHaveLength(0);
    expect(container.querySelector('.sh-box-item__model, canvas')).toBeNull();
    expect(record.chainId).toBe(DEMO_CHAIN_ID);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'View 3D model for #1' })); });
    await waitFor(() => expect(loader.calls).toHaveLength(1));
    const [call] = loader.calls;
    expect(call?.url).toBe(`${ORIGIN}/v1/boxes/${record.chainId}/${record.token?.toLowerCase()}/items/1/art/model`);
    expect(call?.sha256).toBe(hash);
    const host = screen.getByRole('img', { name: '3D model for #1' });
    expect(call?.host).toBe(host);
    expect(host.className).toBe('sh-box-item__model');
    expect(host.hasAttribute('tabindex')).toBe(false);
    expect(screen.getByRole('button', { name: 'Close 3D model for #1' }).textContent).toBe('Close 3D');
  });

  it('a failed load says so and keeps the picture; Close aborts the read; a later press asks again', async () => {
    loader.next = () => Promise.reject(new Error('model hash mismatch'));
    await open();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'View 3D model for #1' })); });
    expect(await screen.findByText('3D model unavailable. The picture remains available.')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Item #1' }).tagName).toBe('IMG');
    expect(loader.calls[0]?.signal.aborted).toBe(false);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close 3D model for #1' })); });
    expect(loader.calls[0]?.signal.aborted).toBe(true);
    expect(screen.queryByText('3D model unavailable. The picture remains available.')).toBeNull();
    expect(screen.queryByRole('img', { name: '3D model for #1' })).toBeNull();
    loader.next = null;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'View 3D model for #1' })); });
    await waitFor(() => expect(loader.calls).toHaveLength(2));
  });

  it('a drawn model is disposed once when its view closes; a load that ends after Close is disposed at once', async () => {
    const dispose = vi.fn();
    loader.next = () => Promise.resolve(dispose);
    await open();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'View 3D model for #1' })); });
    await waitFor(() => expect(loader.calls).toHaveLength(1));
    await act(async () => { await Promise.resolve(); });
    expect(dispose).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close 3D model for #1' })); });
    expect(dispose).toHaveBeenCalledTimes(1);
    let finish: (cleanup: () => void) => void = () => undefined;
    const late = vi.fn();
    loader.next = () => new Promise<() => void>((resolve) => { finish = resolve; });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'View 3D model for #1' })); });
    await waitFor(() => expect(loader.calls).toHaveLength(2));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close 3D model for #1' })); });
    await act(async () => { finish(late); await Promise.resolve(); await Promise.resolve(); });
    expect(late).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
