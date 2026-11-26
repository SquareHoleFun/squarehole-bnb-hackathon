/**
 * The app-level claim flow store: a signed claim outlives the card that started it (persona switch, a scenario change
 * that unmounts the list, navigation), is found again by (account, pair), and is settled in the demo ledger exactly
 * once when it finalizes, even if no card is on screen at that moment (06-ARCHITECTURE; ADR-0008 §4; UI-08).
 */
import { DEMO_CHAIN_ID, canonicalPairId, type AccountClaims, type ClaimView } from '@squarehole/domain';
import { DEMO_PERSONAS, createMockAccountProvider } from '@squarehole/providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixturePair } from '../../test-support/fixture';
import type { DemoSettlement } from '../accounts';
import { createTxFlowController, type TxFlowEnvironment, type TxFlowRequest } from '../tx';
import { claimActionOf } from './claim-model';
import { ClaimFlowStore, claimFlowKey } from './claim-flows';

const STEP = 100;
const PAST = DEMO_PERSONAS.find((persona) => persona.id === 'past_holder')?.address ?? '0x00000000000000000000000000000000de000002';
const CURRENT = DEMO_PERSONAS.find((persona) => persona.id === 'current_holder')?.address ?? '0x00000000000000000000000000000000de000001';
const ORCHARD = fixturePair('ORCHARD');
const REQUEST: TxFlowRequest = { kind: 'claim', label: 'Claim ORCHARD fee share', requiredChainId: DEMO_CHAIN_ID };

const env = (account: string | null, scenario: TxFlowEnvironment['scenario'] = 'success'): TxFlowEnvironment => ({
  account: account as TxFlowEnvironment['account'],
  chainId: account === null ? null : DEMO_CHAIN_ID,
  switchWalletChain: () => Promise.resolve(),
  scenario,
  now: () => Date.parse('2026-09-25T12:00:00Z'),
  stepMs: STEP,
});

const pick = (claims: AccountClaims, pairId: string): ClaimView => {
  const found = claims.claims.find((claim) => canonicalPairId(claim.pairId) === canonicalPairId(pairId));
  if (!found) throw new Error(`no claim for ${pairId}`);
  return found;
};

async function orchardClaim(): Promise<ClaimView> {
  return pick(await createMockAccountProvider().listClaims(PAST), ORCHARD.pairId);
}

function makeStore() {
  const recorded: DemoSettlement[] = [];
  const refresh = vi.fn();
  const store = new ClaimFlowStore({ createController: createTxFlowController, record: (s) => recorded.push(s), refresh });
  return { store, recorded, refresh };
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));
const step = async (ms = STEP) => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ClaimFlowStore', () => {
  it('keys flows by account and canonical pair id, case-insensitively', () => {
    expect(claimFlowKey(PAST, ORCHARD.pairId)).toBe(claimFlowKey(PAST.toUpperCase().replace('0X', '0x') as typeof PAST, ORCHARD.pairId.toUpperCase().replace('0X', '0x')));
    expect(claimFlowKey(PAST, ORCHARD.pairId)).not.toBe(claimFlowKey(CURRENT, ORCHARD.pairId));
  });

  it('an unsigned flow is dropped when its last card goes away (nothing was signed, nothing to track)', async () => {
    const { store } = makeStore();
    const claim = await orchardClaim();
    const entry = store.obtain(PAST, ORCHARD.pairId, REQUEST, env(PAST));
    const release = store.attach(entry.key);
    store.start(entry.key, { claim, action: claimActionOf(claim), pair: ORCHARD });
    await step();
    expect(entry.controller.getSnapshot().state.status).toBe('awaiting_signature');
    release();
    await flush();
    expect(store.get(entry.key)).toBeNull();
    // Later, the same key starts fresh.
    expect(store.obtain(PAST, ORCHARD.pairId, REQUEST, env(PAST)).controller.getSnapshot().state.status).toBe('idle');
  });

  it('a card that detaches and re-attaches in the same turn (StrictMode, re-keying) keeps its flow', async () => {
    const { store } = makeStore();
    const entry = store.obtain(PAST, ORCHARD.pairId, REQUEST, env(PAST));
    store.attach(entry.key)();
    const again = store.attach(entry.key);
    await flush();
    expect(store.get(entry.key)?.controller).toBe(entry.controller);
    again();
  });

  it('a signed flow survives its card, keeps running, and settles once when it finalizes with no card on screen', async () => {
    const { store, recorded, refresh } = makeStore();
    const claim = await orchardClaim();
    const entry = store.obtain(PAST, ORCHARD.pairId, REQUEST, env(PAST));
    const release = store.attach(entry.key);
    store.start(entry.key, { claim, action: claimActionOf(claim), pair: ORCHARD });
    await step();
    entry.controller.sign();
    expect(store.get(entry.key)?.signed).toBe(true);
    expect(store.getSigned().map((signed) => signed.key)).toEqual([entry.key]);

    // The card unmounts (persona switch, scenario change, navigation): the flow is kept and keeps running.
    release();
    await flush();
    expect(store.get(entry.key)?.controller).toBe(entry.controller);
    for (let i = 0; i < 4; i += 1) await step();
    expect(entry.controller.getSnapshot().state.status).toBe('finalized');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ owner: claim.owner, pairId: claim.pairId, qConsumedRaw: claim.claimableQRaw });
    expect(refresh).toHaveBeenCalledTimes(1);

    // A card for the same (account, pair) re-attaches to the same flow; nothing is recorded twice.
    const back = store.obtain(PAST, ORCHARD.pairId, REQUEST, env(CURRENT));
    expect(back.controller).toBe(entry.controller);
    back.controller.configure(REQUEST, env(CURRENT));
    expect(back.controller.getSnapshot().state.status).toBe('finalized');
    expect(recorded).toHaveLength(1);
  });

  it('after signing, a different wallet account does not touch the tracked transaction', async () => {
    const { store } = makeStore();
    const claim = await orchardClaim();
    const entry = store.obtain(PAST, ORCHARD.pairId, REQUEST, env(PAST));
    store.attach(entry.key);
    store.start(entry.key, { claim, action: claimActionOf(claim), pair: ORCHARD });
    await step();
    entry.controller.sign();
    entry.controller.configure(REQUEST, env(CURRENT));
    expect(entry.controller.getSnapshot().state.status).toBe('submitted');
  });

  it('a finished signed claim can be hidden from the tracked lists; a new request makes it visible again', async () => {
    const { store } = makeStore();
    const claim = await orchardClaim();
    const entry = store.obtain(PAST, ORCHARD.pairId, REQUEST, env(PAST, 'revert'));
    store.attach(entry.key);
    store.start(entry.key, { claim, action: claimActionOf(claim), pair: ORCHARD });
    await step();
    entry.controller.sign();
    for (let i = 0; i < 4; i += 1) await step();
    expect(entry.controller.getSnapshot().state.status).toBe('reverted');
    const before = store.getSigned();
    store.hide(entry.key);
    expect(store.getSigned()).toEqual([]);
    expect(store.getSigned()).not.toBe(before);
    store.start(entry.key, { claim, action: claimActionOf(claim), pair: ORCHARD });
    expect(store.get(entry.key)?.hidden).toBe(false);
    expect(store.get(entry.key)?.signed).toBe(false);
  });

  it('a busy flow cannot be hidden, and start is ignored while a request is open', async () => {
    const { store } = makeStore();
    const claim = await orchardClaim();
    const entry = store.obtain(PAST, ORCHARD.pairId, REQUEST, env(PAST));
    store.attach(entry.key);
    store.start(entry.key, { claim, action: claimActionOf(claim), pair: ORCHARD });
    await step();
    entry.controller.sign();
    store.hide(entry.key);
    expect(store.get(entry.key)?.hidden).toBe(false);
    const started = store.get(entry.key)?.started;
    store.start(entry.key, { claim, action: claimActionOf(claim), pair: ORCHARD });
    expect(store.get(entry.key)?.started).toBe(started);
    expect(entry.controller.getSnapshot().state.status).toBe('submitted');
  });

  it('the signed list keeps its identity while nothing in it changes (a stable external-store snapshot)', async () => {
    const { store } = makeStore();
    const first = store.getSigned();
    store.obtain(PAST, ORCHARD.pairId, REQUEST, env(PAST));
    expect(store.getSigned()).toBe(first);
  });
});
