/**
 * T06: the shared item model viewer (ItemModelView.tsx) and its default loader, on real models: a Rent Free house and a
 * Bag Holders bag from their kits (3D, founder R74-ART) and a placeholder model of Create's 3D fixture (T01). The still
 * renderer needs WebGL, which this test DOM lacks, so `mountItemModel` is a double here; the browser suite draws the same
 * models (e2e/core-v2-item-3d.spec.ts). The GLB parse that the renderer starts with runs for real below.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Mesh, type Object3D } from 'three';
import { bagHoldersItem, rentFreeItem, threeDFixtureItem } from '../core/v2/test-support/item-models';
import { ItemModelView, loadModel, type ItemModelLoader } from './ItemModelView';

const mounted = vi.hoisted(() => ({ calls: [] as { host: HTMLElement; bytes: Uint8Array; options: unknown }[], dispose: null as null | (() => void), fail: false }));
vi.mock('./deps', () => ({
  mountItemModel: async (host: HTMLElement, bytes: Uint8Array, options: unknown) => {
    mounted.calls.push({ host, bytes, options });
    // As the renderer does without WebGL, or with a GLB that has nothing to draw.
    if (mounted.fail) throw new Error('nothing to draw');
    return mounted.dispose ?? (() => undefined);
  },
}));

const rent = rentFreeItem();
const bags = bagHoldersItem();
const create = threeDFixtureItem(1);
type Seen = { url: string; init: RequestInit | undefined };

/** A fetch answering by URL: bytes (200, model/gltf-binary) or a status. */
function gateway(answers: Readonly<Record<string, Uint8Array | number>>) {
  const seen: Seen[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    const answer = answers[String(url)];
    if (answer === undefined || typeof answer === 'number') return new Response(null, { status: typeof answer === 'number' ? answer : 404 });
    return new Response(answer.slice(), { headers: { 'content-type': 'model/gltf-binary', 'content-length': String(answer.length) } });
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, seen };
}

beforeEach(() => { mounted.calls = []; mounted.dispose = null; mounted.fail = false; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('T06 loadModel: one request; the model is drawn only when its bytes pass every check (XR-ITEM-3D-V2 F3)', () => {
  const ONE = 'https://one.test/ipfs/m';
  const options = { keyboard: true, anonymous: true } as const;
  const load = (url: string, sha256: `0x${string}`) => loadModel(document.createElement('div'), url, sha256, new AbortController().signal, options);

  it('Rent Free’s house: the exact bytes are drawn, from the one url asked', async () => {
    const { seen } = gateway({ [ONE]: rent.model });
    const dispose = await load(ONE, rent.modelSha256);
    expect(typeof dispose).toBe('function');
    expect(seen.map((s) => s.url)).toEqual([ONE]);
    expect(mounted.calls).toHaveLength(1);
    expect(mounted.calls[0]?.bytes).toEqual(rent.model);
    expect(mounted.calls[0]?.options).toEqual({ keyboard: true });
    // A public gateway is asked with no cookies and no referrer, no redirect followed, nothing cached, under a deadline.
    expect(seen[0]?.init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store' });
    expect(seen[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });
  it('Bag Holders’ bag; the v1 route keeps the plain fetch and the plain renderer', async () => {
    const { seen } = gateway({ 'https://indexer.test/art/model': bags.model });
    await loadModel(document.createElement('div'), 'https://indexer.test/art/model', bags.modelSha256, new AbortController().signal, { keyboard: false, anonymous: false });
    expect(seen[0]?.init?.credentials).toBeUndefined();
    expect(seen[0]?.init?.referrerPolicy).toBeUndefined();
    expect(mounted.calls[0]?.options).toBeUndefined();
  });
  it('Create’s 3D fixture model passes the hash check (it is a valid GLB); what is drawn is the renderer’s to refuse', async () => {
    gateway({ [ONE]: create.model });
    await load(ONE, create.modelSha256);
    expect(mounted.calls[0]?.bytes).toEqual(create.model);
  });
  it.each([
    ['not there (404)', 404],
    ['a server error (503)', 503],
    ['another model’s bytes (the hash does not match)', bags.model],
    ['not a GLB (the item’s picture)', rent.picture],
  ] as const)('a failed fetch or check, %s: refused after exactly one request, nothing drawn', async (_case, answer) => {
    const { seen } = gateway({ [ONE]: answer });
    await expect(load(ONE, rent.modelSha256)).rejects.toThrow();
    expect(seen.map((s) => s.url)).toEqual([ONE]);
    expect(mounted.calls).toHaveLength(0);
  });
  it('no answer in time (the request’s deadline aborts it): refused after exactly one request', async () => {
    const fetch = vi.fn(async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); });
    vi.stubGlobal('fetch', fetch);
    await expect(load(ONE, rent.modelSha256)).rejects.toThrow('timeout');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mounted.calls).toHaveLength(0);
  });
  it('a model that passed every check but could not be drawn: refused after one request', async () => {
    mounted.fail = true;
    const { seen } = gateway({ [ONE]: create.model });
    await expect(load(ONE, create.modelSha256)).rejects.toThrow('nothing to draw');
    expect(seen.map((s) => s.url)).toEqual([ONE]);
    expect(mounted.calls).toHaveLength(1);
  });
  it('closed before it starts: nothing is asked', async () => {
    const { fetch } = gateway({ [ONE]: rent.model });
    const controller = new AbortController();
    controller.abort();
    await expect(loadModel(document.createElement('div'), ONE, rent.modelSha256, controller.signal, options)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(mounted.calls).toHaveLength(0);
  });
});

describe('T06 the real models parse into meshes; the fixture’s placeholder has nothing to draw', () => {
  const meshes = (root: Object3D | undefined) => {
    let count = 0;
    root?.traverse((object) => { if (object instanceof Mesh) count += 1; });
    return count;
  };
  it.each([['Rent Free #1', rent], ['Bag Holders #1', bags]])('%s: a scene with geometry, as the viewer centres and frames it', async (_name, art) => {
    const gltf = await new GLTFLoader().parseAsync(art.model.slice().buffer, '');
    expect(meshes(gltf.scene)).toBeGreaterThan(0);
  });
  it('Create’s 3D fixture model (T01): a GLB with no scene, so the viewer shows “3D unavailable” and the picture stays', async () => {
    const gltf = await new GLTFLoader().parseAsync(create.model.slice().buffer, '');
    expect(gltf.scene).toBeUndefined();
  });
});

describe('T06 ItemModelView: loaded once mounted, aborted and disposed when it closes', () => {
  function rig(answer: () => Promise<() => void>) {
    const calls: { host: HTMLElement; url: string; sha256: string; signal: AbortSignal; options: unknown }[] = [];
    const load: ItemModelLoader = (host, url, sha256, signal, options) => { calls.push({ host, url, sha256, signal, options }); return answer(); };
    const outcomes: string[] = [];
    const view = render(<ItemModelView url="https://one.test/ipfs/m" sha256={rent.modelSha256} label="3D model of item #1" className="view"
      keyboard anonymous describedBy="hint" onOutcome={(outcome) => outcomes.push(outcome)} load={load} />);
    return { ...view, calls, outcomes, host: () => screen.getByLabelText('3D model of item #1') };
  }

  it('draws into its own host with the url, the hash and the options; once drawn, a 3D model widget that takes focus with Tab', async () => {
    const dispose = vi.fn();
    const { calls, outcomes, host, unmount } = rig(async () => dispose);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ host: host(), url: 'https://one.test/ipfs/m', sha256: rent.modelSha256, options: { keyboard: true, anonymous: true } });
    expect(host().hasAttribute('tabindex')).toBe(false);
    expect(host().getAttribute('role')).toBe('img');
    await act(async () => { await Promise.resolve(); });
    expect(outcomes).toEqual(['shown']);
    expect(host().getAttribute('tabindex')).toBe('0');
    // A screen reader passes the arrow keys to a widget, not to an image.
    expect(screen.getByRole('application', { name: '3D model of item #1' })).toBe(host());
    expect(host().getAttribute('aria-roledescription')).toBe('3D model');
    expect(host().getAttribute('aria-describedby')).toBe('hint');
    unmount();
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
  it('a failed load reports it once; closing then aborts, and nothing was drawn to dispose', async () => {
    const { calls, outcomes, host, unmount } = rig(async () => { throw new Error('model hash mismatch'); });
    await act(async () => { await Promise.resolve(); });
    expect(outcomes).toEqual(['failed']);
    expect(host().hasAttribute('tabindex')).toBe(false);
    expect(host().getAttribute('role')).toBe('img');
    unmount();
    expect(calls[0]?.signal.aborted).toBe(true);
  });
  it('closed while loading: the read is aborted, a late model is disposed at once and nothing is reported', async () => {
    let finish: (cleanup: () => void) => void = () => undefined;
    const late = vi.fn();
    const { calls, outcomes, unmount } = rig(() => new Promise((resolve) => { finish = resolve; }));
    unmount();
    expect(calls[0]?.signal.aborted).toBe(true);
    await act(async () => { finish(late); await Promise.resolve(); await Promise.resolve(); });
    expect(late).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([]);
  });
});
