/**
 * SH-203: the reveal session's public interface, doubled for page tests (RevealItemsV2, HiddenDrawsV2). It keeps the
 * real session's press rule: an action is granted only while a click is being dispatched, once per click
 * (reveal-session.ts `trustedRevealPresses`, minus `isTrusted`, which a test's events never are). `calls` records every
 * action, its arguments and whether a click granted it; `set` publishes a state; `resolve` settles a pending action.
 */
import { act } from '@testing-library/react';
import { vi } from 'vitest';
import type { createRevealSession, RevealSessionOptions, RevealSessionState } from '../reveal-session';

export type Action = 'prepare' | 'start' | 'askRelease' | 'confirmRelease' | 'prepareOpening' | 'open' | 'startPictures';
export function double(options: RevealSessionOptions, initial: Partial<RevealSessionState>) {
  let state: RevealSessionState = Object.freeze({ source: 'ready', mode: 'open', busy: false, cancelled: false, unresolved: [], hidden: [], ...initial });
  const subscribers = new Set<(next: RevealSessionState) => void>();
  const calls: { action: Action; args: unknown[]; granted: boolean }[] = [];
  const used = new WeakSet<Event>();
  let dispatching: Event | undefined;
  const capture = (event: Event) => { dispatching = event; };
  window.addEventListener('click', capture, true);
  const take = (action: Action, args: unknown[]) => {
    const event = dispatching;
    const granted = event !== undefined && event.eventPhase !== Event.NONE && !used.has(event);
    if (event) used.add(event);
    calls.push({ action, args, granted });
    if (!granted) throw new Error('user-press-required');
  };
  const pending: Record<string, (value: unknown) => void> = {};
  const failing: Record<string, (error: unknown) => void> = {};
  const action = (name: Action) => vi.fn((...args: unknown[]) => {
    try { take(name, args); } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => { pending[name] = resolve; failing[name] = reject; });
  });
  const api = {
    ready: Promise.resolve(),
    getState: () => state,
    subscribe: vi.fn((listener: (next: RevealSessionState) => void) => { subscribers.add(listener); listener(state); return () => { subscribers.delete(listener); }; }),
    prepare: action('prepare'), start: action('start'), askRelease: action('askRelease'), confirmRelease: action('confirmRelease'),
    prepareOpening: action('prepareOpening'), open: action('open'), startPictures: action('startPictures'),
    cancel: vi.fn(), exportJournal: vi.fn(async () => '{"version":1}'), dispose: vi.fn(() => { window.removeEventListener('click', capture, true); }),
  };
  return {
    options, api, calls, pending,
    set: (patch: Partial<RevealSessionState>) => act(() => { state = Object.freeze({ ...state, ...patch }); for (const listener of subscribers) listener(state); }),
    resolve: (name: Action, value: unknown) => act(async () => { pending[name]?.(value); await Promise.resolve(); }),
    /** Settles a pending action with a refusal (a late answer, after its session was disposed, say). */
    reject: (name: Action, error: unknown) => act(async () => { failing[name]?.(error); await Promise.resolve(); await Promise.resolve(); }),
  };
}


/** A factory for the page's `createSession` seam: every session it makes, newest last; `refuse` makes the next throw. */
export function doubleFactory(initial: () => Partial<RevealSessionState> = () => ({})) {
  const made: ReturnType<typeof double>[] = [];
  let refuse: string | null = null;
  const factory = vi.fn((options: RevealSessionOptions) => {
    if (refuse) throw new Error(refuse);
    const d = double(options, initial());
    made.push(d);
    return d.api as unknown as ReturnType<typeof createRevealSession>;
  });
  return { factory, made, refuse: (code: string | null) => { refuse = code; },
    last: () => { const d = made.at(-1); if (!d) throw new Error('no session'); return d; } };
}
