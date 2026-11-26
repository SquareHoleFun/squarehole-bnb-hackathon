// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { DRY_RUN_REASON, type AlphaApi, type AlphaMe, type ClaimState } from './alpha-api';
import { noteSetupRun } from './setup-signal';
import { JOIN_ENTRY, JOIN_PATH, setupRunLive, subscribeSetupRun, welcomeMe, welcomeOffer, welcomeVisitor } from './welcome-gate';

const ID = '0b6a2f9e-6c1d-4f3a-9b2e-1d2c3b4a5f60';
const claim = (status: ClaimState['status'], over: Partial<ClaimState> = {}): ClaimState => ({ id: ID, status, admitTx: null, sendTx: null, reason: null, at: status === 'queued' ? null : '2026-11-01T08:05:00Z', ...over });
const me = (over: Partial<AlphaMe> = {}): AlphaMe => ({ status: 'approved', handle: 'tester', claim: null, ...over });
const OTHER = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const started = (claimId: string | null = null) => ({ state: 'started' as const, claimId });
const hint = (state: 'done' | 'ended' | 'manual') => ({ state, claimId: null });

/**
 * F166 (SH-ALPHA-ONBOARDING): the welcome step's gate, which decides before any trade code loads: one rule, also the
 * step's own (trade-sepolia/AlphaWelcome.tsx).
 */
describe('the welcome step’s gate (F166)', () => {
  it('offers “Set me up” to an approved tester not set up: no claim, or one the dry run freed, and no wallet of their own', () => {
    expect(welcomeOffer(me(), null, false)).toBe('start');
    expect(welcomeOffer(me({ claim: claim('skipped', { reason: DRY_RUN_REASON }) }), null, false)).toBe('start');
    expect(welcomeOffer(me(), null, true)).toBeNull();
    for (const status of ['queued', 'sent', 'refused', 'failed'] as const) expect(welcomeOffer(me({ claim: claim(status) }), null, false), status).toBeNull();
    expect(welcomeOffer(me({ claim: claim('skipped', { reason: 'something else' }) }), null, false)).toBeNull();
  });

  it('offers “Finish setup” after a setup this device left midway: no claim, one the dry run freed, or the very claim it made; nothing once done, ended or left to the tester', () => {
    expect(welcomeOffer(me(), started(), false)).toBe('finish');
    expect(welcomeOffer(me({ claim: claim('skipped', { reason: DRY_RUN_REASON }) }), started(ID), false)).toBe('finish');
    for (const claimed of [claim('queued'), claim('sent')]) expect(welcomeOffer(me({ claim: claimed }), started(ID), false), claimed.status).toBe('finish');
    // af1 F6: a claim this setup did not make (by hand, or another device's) is not its own: nothing to finish.
    for (const claimed of [claim('queued'), claim('sent')]) expect(welcomeOffer(me({ claim: claimed }), started(OTHER), false), claimed.status).toBeNull();
    expect(welcomeOffer(me({ claim: claim('queued') }), started(), false)).toBeNull();
    for (const state of ['done', 'ended', 'manual'] as const) expect(welcomeOffer(me(), hint(state), false), state).toBeNull();
  });

  it('af1 F1: nothing while a wallet of the tester’s own is connected or still asking, not even “Finish setup”', () => {
    expect(welcomeOffer(me(), null, true)).toBeNull();
    expect(welcomeOffer(me(), started(), true)).toBeNull();
    expect(welcomeOffer(me({ claim: claim('queued') }), started(ID), true)).toBeNull();
  });

  it('af2: says whether a run of this visit shows, wherever it started (the shell’s mount keeps the chip then)', () => {
    const changes: boolean[] = [];
    const stop = subscribeSetupRun(() => changes.push(setupRunLive()));
    noteSetupRun(true);
    noteSetupRun(true);
    noteSetupRun(false);
    stop();
    noteSetupRun(true);
    expect(changes).toEqual([true, false]);
    expect(setupRunLive()).toBe(true);
    noteSetupRun(false);
  });

  it('offers nothing to anyone not approved, or without an answer it can read', () => {
    expect(welcomeOffer(null, null, false)).toBeNull();
    expect(welcomeOffer(me({ status: 'pending' }), null, false)).toBeNull();
    expect(welcomeOffer(me({ status: 'removed' }), started(), false)).toBeNull();
  });

  it('asks our server once: its answer, or null for a refusal', async () => {
    const answer = (value: Awaited<ReturnType<AlphaApi['me']>>) => ({ intake: vi.fn(async () => ({ ok: true as const, value: { open: true, returning: false } })), me: vi.fn(async () => value) }) as unknown as AlphaApi;
    expect(await welcomeMe(answer({ ok: true, value: me() }))).toEqual(me());
    expect(await welcomeMe(answer({ ok: false, status: 401, error: 'sign in required' }))).toBeNull();
    expect(await welcomeMe(answer({ ok: false, status: 0, error: 'no answer' }))).toBeNull();
  });
});

/** SH-275: the open site's entry to the join page is offered to a stranger only (our server's 401), never on no answer. */
describe('the open site’s entry (SH-275)', () => {
  it('tells a stranger from a visitor our server gave no readable answer for, with the one request', async () => {
    const asked = vi.fn();
    const answer = (result: Awaited<ReturnType<AlphaApi['me']>>): AlphaApi => ({ me: async () => { asked(); return result; } } as unknown as AlphaApi);
    expect(await welcomeVisitor(answer({ ok: true, value: me() }))).toEqual(me());
    expect(await welcomeVisitor(answer({ ok: false, status: 401, error: 'sign in required' }))).toBe('stranger');
    expect(await welcomeVisitor(answer({ ok: false, status: 0, error: 'no answer' }))).toBeNull();
    expect(await welcomeVisitor(answer({ ok: false, status: -1, error: 'unreadable' }))).toBeNull();
    expect(await welcomeVisitor(answer({ ok: false, status: 404, error: 'not found' }))).toBeNull();
    expect(asked).toHaveBeenCalledTimes(5);
    // The join page's own button text, and the join page.
    expect([JOIN_ENTRY, JOIN_PATH]).toEqual(['Sign in with X', '/join']);
  });
});
