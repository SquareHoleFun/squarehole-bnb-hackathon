import { sha256Hex } from '@squarehole/artwork';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadItemModel, createAccentController, type AccentController, type AccentStatus } from './controller';
import type { SceneModule } from './sceneTypes';
import { VISIBLE_ENV, createFakeScene, createHarness, flushAsync, type FakeScene, type Harness } from './testing';

interface Mounted {
  readonly harness: Harness;
  readonly host: HTMLDivElement;
  readonly statuses: AccentStatus[];
  readonly controller: AccentController;
}

const mounted: Mounted[] = [];

function mount(harness: Harness = createHarness()): Mounted {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const statuses: AccentStatus[] = [];
  const controller = createAccentController({
    host,
    variant: 'pin',
    deps: harness.deps,
    canvasClassName: 'scene-canvas',
    onStatus: (s) => statuses.push(s),
  });
  const m = { harness, host, statuses, controller };
  mounted.push(m);
  return m;
}

/** Idle + in view: the path to a live scene. */
async function goLive(m: Mounted): Promise<void> {
  m.harness.runIdle();
  m.harness.setInView(true);
  await flushAsync();
}

const last = (m: Mounted) => m.statuses.at(-1);

afterEach(() => {
  mounted.splice(0).forEach((m) => {
    m.controller.dispose();
    m.host.remove();
  });
});

describe('gating before any download', () => {
  it('starts on the poster and does not import three.js before idle', () => {
    const m = mount();
    m.harness.setInView(true);
    expect(last(m)).toEqual({ phase: 'poster', reason: null, settled: false, frames: null });
    expect(m.harness.loadScene).not.toHaveBeenCalled();
  });

  it('prefers-reduced-motion: keeps the poster and never imports the scene', async () => {
    const m = mount(createHarness({ ...VISIBLE_ENV, reducedMotion: true }));
    await goLive(m);
    expect(m.harness.loadScene).not.toHaveBeenCalled();
    expect(m.harness.probeContext).not.toHaveBeenCalled();
    expect(last(m)).toMatchObject({ phase: 'fallback', reason: 'reduced-motion' });
    expect(m.host.querySelector('canvas')).toBeNull();
  });

  it('data saver: keeps the poster and never imports the scene', async () => {
    const m = mount(createHarness({ ...VISIBLE_ENV, saveData: true }));
    await goLive(m);
    expect(m.harness.loadScene).not.toHaveBeenCalled();
    expect(last(m)).toMatchObject({ phase: 'fallback', reason: 'save-data' });
  });

  it('no WebGL2: keeps the poster and never imports the scene', async () => {
    const m = mount(createHarness({ ...VISIBLE_ENV, webgl2: false }));
    await goLive(m);
    expect(m.harness.loadScene).not.toHaveBeenCalled();
    expect(last(m)).toMatchObject({ phase: 'fallback', reason: 'no-webgl' });
  });

  it('WebGL context creation failure: poster remains, no import, no canvas', async () => {
    const harness = createHarness();
    harness.probeContext.mockReturnValue({ ok: false, reason: 'context-failed' });
    const m = mount(harness);
    await goLive(m);
    expect(harness.probeContext).toHaveBeenCalledTimes(1);
    expect(harness.loadScene).not.toHaveBeenCalled();
    expect(last(m)).toMatchObject({ phase: 'fallback', reason: 'context-failed' });
    expect(m.host.querySelector('canvas')).toBeNull();
  });

  it('software rasteriser (GPU-free): poster remains, no import', async () => {
    const harness = createHarness();
    harness.probeContext.mockReturnValue({ ok: false, reason: 'software-renderer' });
    const m = mount(harness);
    await goLive(m);
    expect(harness.loadScene).not.toHaveBeenCalled();
    expect(last(m)).toMatchObject({ phase: 'fallback', reason: 'software-renderer' });
  });

  it('hidden document: defers the import until the tab becomes visible', async () => {
    const m = mount(createHarness({ ...VISIBLE_ENV, hidden: true }));
    await goLive(m);
    expect(m.harness.loadScene).not.toHaveBeenCalled();
    expect(last(m)?.phase).toBe('poster');
    m.harness.setHidden(false);
    await flushAsync();
    expect(m.harness.loadScene).toHaveBeenCalledTimes(1);
  });

  it('offscreen: waits until the accent scrolls into view', async () => {
    const m = mount();
    m.harness.runIdle();
    await flushAsync();
    expect(m.harness.loadScene).not.toHaveBeenCalled();
    m.harness.setInView(true);
    await flushAsync();
    expect(m.harness.loadScene).toHaveBeenCalledTimes(1);
  });

  it('re-checks reduced motion at idle time (setting changed after mount)', async () => {
    const m = mount();
    m.harness.env = { ...m.harness.env, reducedMotion: true };
    await goLive(m);
    expect(m.harness.loadScene).not.toHaveBeenCalled();
    expect(last(m)).toMatchObject({ phase: 'fallback', reason: 'reduced-motion' });
  });
});

describe('live scene', () => {
  it('imports once, mounts the canvas, caps the pixel ratio and plays the sequence', async () => {
    const m = mount();
    await goLive(m);
    expect(m.harness.loadScene).toHaveBeenCalledTimes(1);
    const scene = m.harness.scene();
    expect(scene.options.pixelRatio).toBe(1.5);
    expect(scene.options).toMatchObject({ variant: 'pin', width: 360, height: 170 });
    const canvas = m.host.querySelector('canvas');
    expect(canvas?.className).toBe('scene-canvas');
    expect(canvas?.getAttribute('aria-hidden')).toBe('true');
    expect(last(m)).toMatchObject({ phase: 'live', settled: false });
    expect(scene.play).toHaveBeenCalledTimes(1);
  });

  it('reports settle with the frame count', async () => {
    const m = mount();
    await goLive(m);
    m.harness.scene().settle({ frames: 160, sequenceFrames: 158 });
    expect(last(m)).toEqual({ phase: 'live', reason: null, settled: true, frames: 158 });
  });

  it('pauses offscreen and on hidden tabs, resumes when visible again', async () => {
    const m = mount();
    await goLive(m);
    const scene = m.harness.scene();
    m.harness.setInView(false);
    expect(scene.setActive).toHaveBeenLastCalledWith(false);
    m.harness.setInView(true);
    expect(scene.setActive).toHaveBeenLastCalledWith(true);
    m.harness.setHidden(true);
    expect(scene.setActive).toHaveBeenLastCalledWith(false);
    m.harness.setHidden(false);
    expect(scene.setActive).toHaveBeenLastCalledWith(true);
  });

  it('forwards size changes to the scene', async () => {
    const m = mount();
    await goLive(m);
    m.harness.resizeTo(480, 227);
    expect(m.harness.scene().resize).toHaveBeenLastCalledWith(480, 227);
  });

  it('applies a resize that arrived while the scene was compiling before the first still frame', async () => {
    let finishCompile: (() => void) | undefined;
    const created: FakeScene[] = [];
    const harness = createHarness();
    harness.loadScene.mockResolvedValue({
      createShapeSorterScene: (options) =>
        new Promise((resolve) => {
          finishCompile = () => {
            const scene = createFakeScene(options);
            created.push(scene);
            resolve(scene);
          };
        }),
    });
    const m = mount(harness);
    await goLive(m);
    harness.resizeTo(480, 227); // host resized mid-compile: no scene yet to forward it to
    finishCompile?.();
    await flushAsync();
    const scene = created[0];
    if (!scene) throw new Error('scene was not created');
    expect(scene.options).toMatchObject({ width: 360, height: 170 });
    expect(scene.resize).toHaveBeenLastCalledWith(480, 227);
    const renderStill = vi.mocked(scene.renderStill);
    expect(renderStill).toHaveBeenCalledTimes(1);
    expect(scene.resize.mock.invocationCallOrder[0]).toBeLessThan(renderStill.mock.invocationCallOrder[0] ?? 0);
  });

  it('replay restarts the sequence', async () => {
    const m = mount();
    await goLive(m);
    const scene = m.harness.scene();
    scene.settle();
    m.controller.replay();
    expect(scene.play).toHaveBeenCalledTimes(2);
    expect(last(m)).toMatchObject({ phase: 'live', settled: false });
  });

  it('switching on reduced motion while live tears the scene down to the poster', async () => {
    const m = mount();
    await goLive(m);
    m.harness.setReducedMotion(true);
    expect(m.harness.scene().dispose).toHaveBeenCalledTimes(1);
    expect(m.host.querySelector('canvas')).toBeNull();
    expect(last(m)).toMatchObject({ phase: 'fallback', reason: 'reduced-motion' });
  });

  it('webglcontextlost falls back to the poster and disposes the scene', async () => {
    const m = mount();
    await goLive(m);
    const canvas = m.host.querySelector('canvas');
    expect(canvas).not.toBeNull();
    canvas?.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(m.harness.scene().dispose).toHaveBeenCalledTimes(1);
    expect(m.host.querySelector('canvas')).toBeNull();
    expect(last(m)).toMatchObject({ phase: 'fallback', reason: 'context-lost' });
  });

  it('a failed chunk download keeps the poster and frees the probed context', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const harness = createHarness();
    harness.loadScene.mockRejectedValue(new Error('network'));
    const m = mount(harness);
    await goLive(m);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    expect(last(m)).toMatchObject({ phase: 'fallback', reason: 'load-failed' });
    expect(harness.lostContexts).toBe(1);
    expect(m.host.querySelector('canvas')).toBeNull();
  });
});

describe('teardown', () => {
  it('unmount disposes the scene, removes the canvas and all listeners', async () => {
    const m = mount();
    await goLive(m);
    expect(m.harness.listenerCount()).toBeGreaterThan(0);
    m.controller.dispose();
    expect(m.harness.scene().dispose).toHaveBeenCalledTimes(1);
    expect(m.host.querySelector('canvas')).toBeNull();
    expect(m.harness.listenerCount()).toBe(0);
  });

  it('unmount during the chunk download frees the context, never creates a scene, emits nothing further', async () => {
    let finishDownload: (() => void) | undefined;
    const harness = createHarness();
    const create = vi.fn<SceneModule['createShapeSorterScene']>();
    harness.loadScene.mockImplementation(
      () => new Promise<SceneModule>((resolve) => (finishDownload = () => resolve({ createShapeSorterScene: create }))),
    );
    const m = mount(harness);
    await goLive(m);
    const emitted = m.statuses.length;
    m.controller.dispose();
    expect(harness.lostContexts).toBe(1);
    finishDownload?.();
    await flushAsync();
    expect(create).not.toHaveBeenCalled();
    expect(m.statuses.length).toBe(emitted);
    expect(m.host.querySelector('canvas')).toBeNull();
  });

  it('unmount while the scene is still compiling disposes the late scene', async () => {
    let finishCompile: (() => void) | undefined;
    const late: FakeScene[] = [];
    const harness = createHarness();
    harness.loadScene.mockResolvedValue({
      createShapeSorterScene: (options) =>
        new Promise((resolve) => {
          finishCompile = () => {
            const scene = createFakeScene(options);
            late.push(scene);
            resolve(scene);
          };
        }),
    });
    const m = mount(harness);
    await goLive(m);
    m.controller.dispose();
    finishCompile?.();
    await flushAsync();
    expect(late).toHaveLength(1);
    expect(late[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(last(m)?.phase).toBe('loading');
    expect(m.host.querySelector('canvas')).toBeNull();
  });

  it('unmount before idle cancels everything without importing', () => {
    const m = mount();
    m.controller.dispose();
    m.harness.runIdle();
    m.harness.setInView(true);
    expect(m.harness.loadScene).not.toHaveBeenCalled();
    expect(m.harness.listenerCount()).toBe(0);
  });
});


it('MF23-6: refuses a model with wrong bytes before parsing or rendering', async () => {
  const mount = vi.fn();
  const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
  await expect(loadItemModel(document.createElement('div'), '/model', `0x${'12'.repeat(32)}`, new AbortController().signal, fetcher, mount)).rejects.toThrow();
  expect(mount).not.toHaveBeenCalled();
});


it('MF23-6: a verified self-contained GLB mounts and is disposed when its view closes', async () => {
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }] }));
  const padded = Math.ceil(json.length / 4) * 4;
  const bytes = new Uint8Array(20 + padded);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.length, true);
  view.setUint32(12, padded, true); view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(32, 20); bytes.set(json, 20);
  const dispose = vi.fn();
  const mount = vi.fn(async () => dispose);
  const controller = new AbortController();
  const cleanup = await loadItemModel(document.createElement('div'), '/model', sha256Hex(bytes), controller.signal, async () => new Response(bytes), mount);
  expect(mount).toHaveBeenCalledTimes(1);
  cleanup();
  expect(dispose).toHaveBeenCalledTimes(1);
});

it('MF23-6: cancels a streamed model above one raw block before waiting for its end', async () => {
  const cancel = vi.fn();
  const mount = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(new Uint8Array(1_048_577)); },
    cancel,
  });
  await expect(loadItemModel(document.createElement('div'), '/model', `0x${'12'.repeat(32)}`, new AbortController().signal,
    async () => new Response(body), mount)).rejects.toThrow('model exceeds one raw block');
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(mount).not.toHaveBeenCalled();
});
