import { describe, expect, it } from 'vitest';
import { whenIdle } from './deps';

/**
 * How the fake window exposes paint timing:
 *   supported    PerformanceObserver with 'paint' in supportedEntryTypes
 *   unsupported  PerformanceObserver without 'paint' (older engines)
 *   throws       'paint' listed, but observe() throws
 *   absent       no PerformanceObserver at all (jsdom, very old browsers)
 */
type PaintSupport = 'supported' | 'unsupported' | 'throws' | 'absent';

interface FakeWindowOptions {
  readonly readyState: DocumentReadyState;
  readonly idle: boolean;
  readonly paint?: PaintSupport;
}

/** Minimal window whose load, paint entries, animation frames, idle callbacks and timers are stepped by the test. */
function fakeWindow({ readyState, idle, paint = 'absent' }: FakeWindowOptions) {
  const log: string[] = [];
  const frames = new Map<number, FrameRequestCallback>();
  const idles = new Map<number, IdleRequestCallback>();
  const timers = new Map<number, () => void>();
  /** Load listeners and whether they were registered with `{ once: true }`. */
  const loadListeners = new Map<() => void, boolean>();
  const observers = new Set<FakePaintObserver>();
  let constructed = 0;
  let nextId = 1;

  class FakePaintObserver {
    static readonly supportedEntryTypes: readonly string[] =
      paint === 'unsupported' ? ['mark', 'measure', 'resource'] : ['mark', 'measure', 'paint', 'resource'];
    constructor(readonly callback: PerformanceObserverCallback) {
      constructed += 1;
    }
    observe(init: PerformanceObserverInit): void {
      if (paint === 'throws') throw new TypeError('observe() is not supported');
      log.push(`observe ${init.type}${init.buffered ? ' (buffered)' : ''}`);
      observers.add(this);
    }
    disconnect(): void {
      if (observers.delete(this)) log.push('disconnect');
    }
  }

  const win = {
    document: { readyState },
    addEventListener: (type: string, listener: () => void, opts?: AddEventListenerOptions) => {
      if (type === 'load') loadListeners.set(listener, opts?.once === true);
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === 'load') loadListeners.delete(listener);
    },
    requestAnimationFrame: (cb: FrameRequestCallback) => {
      frames.set(nextId, cb);
      return nextId++;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    requestIdleCallback: idle
      ? (cb: IdleRequestCallback, opts?: IdleRequestOptions) => {
          log.push(`idle requested (timeout ${opts?.timeout})`);
          idles.set(nextId, cb);
          return nextId++;
        }
      : undefined,
    cancelIdleCallback: (id: number) => idles.delete(id),
    setTimeout: (cb: () => void, ms?: number) => {
      log.push(`timer set (${ms} ms)`);
      timers.set(nextId, cb);
      return nextId++;
    },
    clearTimeout: (id: number) => timers.delete(id),
    PerformanceObserver: paint === 'absent' ? undefined : FakePaintObserver,
  } as unknown as Window;

  const drain = <T>(map: Map<number, T>, run: (cb: T) => void, label: string) => () => {
    const pending = [...map.values()];
    map.clear();
    if (pending.length) log.push(label);
    pending.forEach(run);
  };
  return {
    win,
    log,
    fireLoad: () => {
      log.push('load');
      [...loadListeners].forEach(([listener, once]) => {
        if (once) loadListeners.delete(listener);
        listener();
      });
    },
    /** Delivers a paint entry to every connected observer, as the browser does after presenting the frame. */
    paintEntry: (name: 'first-paint' | 'first-contentful-paint') => {
      log.push(`paint ${name}`);
      const entry = { name, entryType: 'paint', startTime: 40, duration: 0 } as PerformanceEntry;
      const list = { getEntries: () => [entry] } as unknown as PerformanceObserverEntryList;
      [...observers].forEach((o) => o.callback(list, o as unknown as PerformanceObserver));
    },
    frame: drain(frames, (cb) => cb(0), 'frame'),
    idle: drain(idles, (cb) => cb({ didTimeout: false, timeRemaining: () => 10 }), 'idle'),
    timers: drain(timers, (cb) => cb(), 'timer'),
    framesPending: () => frames.size,
    observersConstructed: () => constructed,
    pending: () => frames.size + idles.size + timers.size + loadListeners.size + observers.size,
  };
}

describe('whenIdle: observed first contentful paint', () => {
  it('waits for load, a first-contentful-paint entry and an idle period, in that order', () => {
    const w = fakeWindow({ readyState: 'loading', idle: true, paint: 'supported' });
    let called = 0;
    whenIdle(w.win, () => (called += 1));
    w.paintEntry('first-contentful-paint');
    w.idle();
    expect(called, 'nothing before load').toBe(0);
    expect(w.observersConstructed()).toBe(0);

    w.fireLoad();
    w.frame();
    w.idle();
    expect(called, 'frames alone do not count as a presented paint').toBe(0);
    expect(w.framesPending()).toBe(0);

    w.paintEntry('first-paint');
    w.idle();
    expect(called, 'a non-contentful paint is not enough').toBe(0);

    w.paintEntry('first-contentful-paint');
    expect(called, 'idle time is requested only after the paint entry').toBe(0);
    w.idle();
    expect(called).toBe(1);
    expect(w.log).toEqual([
      'paint first-contentful-paint',
      'load',
      'observe paint (buffered)',
      'timer set (1500 ms)',
      'paint first-paint',
      'paint first-contentful-paint',
      'disconnect',
      'idle requested (timeout 2000)',
      'idle',
    ]);
    expect(w.pending(), 'cap timer cleared, observer disconnected').toBe(0);
  });

  it('observes buffered entries straight away when the document already loaded', () => {
    const w = fakeWindow({ readyState: 'complete', idle: true, paint: 'supported' });
    let called = 0;
    whenIdle(w.win, () => (called += 1));
    expect(w.log).toContain('observe paint (buffered)');
    w.paintEntry('first-contentful-paint');
    w.idle();
    expect(called).toBe(1);
    expect(w.pending()).toBe(0);
  });

  it('a late or repeated paint entry after the cap does not call back twice', () => {
    const w = fakeWindow({ readyState: 'complete', idle: true, paint: 'supported' });
    let called = 0;
    whenIdle(w.win, () => (called += 1));
    w.timers();
    w.paintEntry('first-contentful-paint');
    w.idle();
    w.paintEntry('first-contentful-paint');
    w.idle();
    expect(called).toBe(1);
    expect(w.pending()).toBe(0);
  });
});

describe('whenIdle: no contentful paint within the cap', () => {
  it('stops waiting after 1.5 s and asks for idle time anyway', () => {
    const w = fakeWindow({ readyState: 'loading', idle: true, paint: 'supported' });
    let called = 0;
    whenIdle(w.win, () => (called += 1));
    w.fireLoad();
    w.idle();
    expect(called).toBe(0);
    w.timers();
    expect(w.log.slice(-3)).toEqual(['timer', 'disconnect', 'idle requested (timeout 2000)']);
    w.idle();
    expect(called).toBe(1);
    expect(w.pending()).toBe(0);
  });
});

describe('whenIdle: paint timing unavailable (two animation frames instead)', () => {
  for (const paint of ['absent', 'unsupported', 'throws'] as const) {
    it(`paint timing ${paint}: waits for load, two frames and an idle period`, () => {
      const w = fakeWindow({ readyState: 'loading', idle: true, paint });
      let called = 0;
      whenIdle(w.win, () => (called += 1));
      w.frame();
      w.idle();
      expect(called).toBe(0); // nothing before load
      w.fireLoad();
      w.idle();
      w.timers();
      expect(called).toBe(0);
      w.frame();
      expect(called).toBe(0); // first frame is only being produced
      w.frame();
      expect(called).toBe(0); // first paint presented; now ask for idle time
      w.idle();
      expect(called).toBe(1);
      expect(w.log).toEqual(['load', 'frame', 'frame', 'idle requested (timeout 2000)', 'idle']);
      expect(w.observersConstructed()).toBe(paint === 'throws' ? 1 : 0);
      expect(w.pending()).toBe(0);
    });
  }

  it('falls back to a timer without requestIdleCallback (Safari)', () => {
    const w = fakeWindow({ readyState: 'complete', idle: false });
    let called = 0;
    whenIdle(w.win, () => (called += 1));
    w.frame();
    w.frame();
    w.timers();
    expect(called).toBe(1);
    expect(w.log).toEqual(['frame', 'frame', 'timer set (600 ms)', 'timer']);
  });
});

describe('whenIdle: cancel', () => {
  const cases = [
    { stage: 'load', paint: 'supported' },
    { stage: 'paint', paint: 'supported' },
    { stage: 'frame', paint: 'absent' },
    { stage: 'idle', paint: 'supported' },
    { stage: 'idle', paint: 'absent' },
  ] as const;

  for (const { stage, paint } of cases) {
    it(`stops every pending stage when cancelled at ${stage} (paint timing ${paint})`, () => {
      const w = fakeWindow({ readyState: 'loading', idle: true, paint });
      let called = 0;
      const cancel = whenIdle(w.win, () => (called += 1));
      if (stage !== 'load') w.fireLoad();
      if (stage === 'idle') {
        w.paintEntry('first-contentful-paint');
        w.frame();
        w.frame();
      }
      cancel();
      expect(w.pending(), `nothing pending after cancel at ${stage}`).toBe(0);
      w.fireLoad();
      w.paintEntry('first-contentful-paint');
      w.frame();
      w.frame();
      w.timers();
      w.idle();
      expect(called, `cancelled at ${stage}`).toBe(0);
    });
  }
});
