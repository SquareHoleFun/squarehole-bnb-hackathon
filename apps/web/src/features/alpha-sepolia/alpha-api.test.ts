import { describe, expect, it } from 'vitest';
import { alphaApi, challengeOf, claimStateOf, deskOf, meOf, DRY_RUN_REASON } from './alpha-api';

it('reads the refill wait as a held claim, and rejects waits with any transaction or unknown reason', async () => {
  const waiting = { v: 1, id: ID, status: 'waiting', admitTx: null, sendTx: null,
    reason: 'insufficient float for starter and gas', at: '2026-11-11T12:00:00.000Z' };
  expect(claimStateOf(waiting)).toMatchObject({ status: 'waiting', reason: waiting.reason });
  expect(meOf({ status: 'approved', handle: 'tester', claim: waiting })?.claim?.status).toBe('waiting');
  expect((await answering(200, waiting).api.claimState(ID)).ok).toBe(true);
  expect(claimStateOf({ ...waiting, admitTx: TX })).toBeNull();
  expect(claimStateOf({ ...waiting, sendTx: TX })).toBeNull();
  expect(claimStateOf({ ...waiting, reason: 'other reason' })).toBeNull();
});

/**
 * F161 (4), SH-ALPHA-SITE: the alpha's calls to our own alpha-api (infra/server/services/alpha-api.mjs). Each answer is
 * checked for its exact shape before a page shows any of it; each refusal keeps the server's status and short reason.
 */
const ID = '0b6a2f9e-6c1d-4f3a-9b2e-1d2c3b4a5f60';
const ADDRESS = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const TX = `0x${'ab'.repeat(32)}`;
const message = (id = ID, address = ADDRESS) => `Square Hole alpha claim\n\nI link my X account @tester (X ID 123) to wallet ${address}.\nI request starter SepETH on Sepolia (chain 11155111).\nClaim ID: ${id}\nTime: 2026-10-29T12:00:00.000Z\nSite: https://test-app.squarehole.fun`;

type Call = { readonly input: string; readonly init: RequestInit };
const answering = (status: number, body: unknown) => {
  const calls: Call[] = [];
  const fetcher = (input: string, init?: RequestInit) => {
    calls.push({ input, init: init ?? {} });
    return Promise.resolve(new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  };
  return { calls, api: alphaApi(fetcher) };
};

describe('the alpha API client (F161 (4), SH-ALPHA-SITE)', () => {
  it('reads /alpha/me: the status, the handle and the claim, nothing else', async () => {
    const { api, calls } = answering(200, { status: 'pending', handle: 'tester_1', claim: null });
    expect(await api.me()).toEqual({ ok: true, value: { status: 'pending', handle: 'tester_1', claim: null } });
    expect(calls[0]?.input).toBe('/alpha/me');
    expect(calls[0]?.init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    expect((calls[0]?.init.headers as Record<string, string>).accept).toBe('application/json');
  });

  it('keeps a refusal’s status and reason, and says when no answer or an unreadable one came', async () => {
    expect(await answering(401, { error: 'sign in required' }).api.me()).toEqual({ ok: false, status: 401, error: 'sign in required' });
    expect(await answering(503, { error: 'service unavailable' }).api.me()).toEqual({ ok: false, status: 503, error: 'service unavailable' });
    expect(await answering(200, { status: 'member', handle: 'x', claim: null }).api.me()).toEqual({ ok: false, status: -1, error: 'unexpected answer' });
    expect(await answering(500, 'not json').api.me()).toEqual({ ok: false, status: 500, error: 'request refused' });
    const offline = alphaApi(() => Promise.reject(new TypeError('network')));
    expect(await offline.me()).toEqual({ ok: false, status: 0, error: 'no answer' });
  });

  it('sends Privy’s identity token once, in its header only, with no body', async () => {
    const { api, calls } = answering(200, { status: 'approved', handle: 'tester', claim: null });
    expect((await api.session('header.payload.signature')).ok).toBe(true);
    expect(calls[0]).toEqual({ input: '/alpha/session', init: { credentials: 'same-origin', cache: 'no-store', redirect: 'error', method: 'POST', headers: { accept: 'application/json', 'privy-id-token': 'header.payload.signature' } } });
  });

  it('signs out with an empty POST and reads only the server’s own answer', async () => {
    const done = answering(200, { status: 'signed-out' });
    expect(await done.api.signOut()).toEqual({ ok: true, value: true });
    expect(done.calls[0]?.init.method).toBe('POST');
    expect(done.calls[0]?.init.body).toBeUndefined();
    expect((await answering(200, { status: 'other' }).api.signOut()).ok).toBe(false);
  });

  it('asks for the claim text of one address, and takes it only when it names that claim and that address', async () => {
    const { api, calls } = answering(200, { id: ID, address: ADDRESS, message: message(), requestedAt: '2026-10-29T12:00:00.000Z' });
    const result = await api.claimMessage(ADDRESS.toLowerCase());
    expect(result).toEqual({ ok: true, value: { id: ID, address: ADDRESS, message: message(), requestedAt: '2026-10-29T12:00:00.000Z' } });
    expect(calls[0]?.input).toBe(`/alpha/claim/message?address=${ADDRESS.toLowerCase()}`);
    // Another address, another claim id in the text, an address in the text that is not the answer's: refused.
    expect(challengeOf({ id: ID, address: ADDRESS, message: message(), requestedAt: '2026-10-29T12:00:00.000Z' }, '0x0000000000000000000000000000000000000001')).toBeNull();
    expect(challengeOf({ id: ID, address: ADDRESS, message: message('1b6a2f9e-6c1d-4f3a-9b2e-1d2c3b4a5f60'), requestedAt: '2026-10-29T12:00:00.000Z' }, ADDRESS)).toBeNull();
    expect(challengeOf({ id: ID, address: ADDRESS, message: message(ID, '0x0000000000000000000000000000000000000002'), requestedAt: '2026-10-29T12:00:00.000Z' }, ADDRESS)).toBeNull();
    expect(challengeOf({ id: 'not-a-uuid', address: ADDRESS, message: message(), requestedAt: '2026-10-29T12:00:00.000Z' }, ADDRESS)).toBeNull();
  });

  it('posts the signed claim as JSON and takes its 202', async () => {
    const { api, calls } = answering(202, { id: ID, status: 'queued' });
    const result = await api.claim({ address: ADDRESS, message: message(), signature: `0x${'11'.repeat(65)}` });
    expect(result).toEqual({ ok: true, value: { id: ID, status: 'queued', admitTx: null, sendTx: null, reason: null, at: null } });
    expect(calls[0]?.init.method).toBe('POST');
    expect((calls[0]?.init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ address: ADDRESS, message: message(), signature: `0x${'11'.repeat(65)}` });
    expect(await answering(409, { error: 'already claimed' }).api.claim({ address: ADDRESS, message: message(), signature: '0x' })).toEqual({ ok: false, status: 409, error: 'already claimed' });
    expect(await answering(429, { error: 'daily claim cap reached' }).api.claim({ address: ADDRESS, message: message(), signature: '0x' })).toEqual({ ok: false, status: 429, error: 'daily claim cap reached' });
  });

  it('reads a claim’s receipt by its exact shape (design § 6), and asks nothing for an id that is not one', async () => {
    const sent = { v: 1, id: ID, status: 'sent', admitTx: TX, sendTx: TX, reason: null, at: '2026-10-29T12:05:00Z' };
    expect(claimStateOf(sent)).toEqual({ id: ID, status: 'sent', admitTx: TX, sendTx: TX, reason: null, at: '2026-10-29T12:05:00Z' });
    expect(claimStateOf({ ...sent, status: 'skipped', admitTx: null, sendTx: null, reason: DRY_RUN_REASON })?.reason).toBe(DRY_RUN_REASON);
    expect(claimStateOf({ ...sent, status: 'done' })).toBeNull();
    expect(claimStateOf({ ...sent, sendTx: '0x12' })).toBeNull();
    expect(claimStateOf({ ...sent, at: 'yesterday' })).toBeNull();
    const { api, calls } = answering(200, sent);
    expect((await api.claimState(ID)).ok).toBe(true);
    expect(calls[0]?.input).toBe(`/alpha/claim/${ID}`);
    const none = answering(200, sent);
    expect(await none.api.claimState('../desk/api/signups')).toEqual({ ok: false, status: -1, error: 'invalid claim id' });
    expect(none.calls).toHaveLength(0);
  });

  it('reads the desk’s sign-ups and decisions whole, or not at all, and posts a decision by X number', async () => {
    const signup = { xId: '123', privyDid: 'did:privy:abc', handle: 'tester', name: 'A <b>name</b>', picture: null, status: 'pending', signedUpAt: '2026-10-29T10:00:00.000Z', lastSignIn: '2026-10-29T11:00:00.000Z' };
    const decision = { seq: 1, xId: '123', decision: 'approve', actor: 'founder@example.test', at: '2026-10-29T11:30:00.000Z' };
    expect(deskOf({ signups: [signup], decisions: [decision] })?.signups[0]).toEqual({ xId: '123', privyDid: 'did:privy:abc', handle: 'tester', name: 'A <b>name</b>', status: 'pending', signedUpAt: '2026-10-29T10:00:00.000Z', lastSignIn: '2026-10-29T11:00:00.000Z' });
    expect(deskOf({ signups: [{ ...signup, handle: 'not a handle!' }], decisions: [] })).toBeNull();
    expect(deskOf({ signups: [{ ...signup, xId: '0123' }], decisions: [] })).toBeNull();
    expect(deskOf({ signups: [signup], decisions: [{ ...decision, decision: 'ban' }] })).toBeNull();
    const { api, calls } = answering(200, { status: 'approved' });
    expect(await api.decide('123', 'approve')).toEqual({ ok: true, value: 'approved' });
    expect(calls[0]?.input).toBe('/desk/api/decide');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ xId: '123', decision: 'approve' });
  });

  it('takes a me answer only with a handle X allows and a well-formed claim', () => {
    expect(meOf({ status: 'approved', handle: 'a'.repeat(16), claim: null })).toBeNull();
    expect(meOf({ status: 'approved', handle: 'ok', claim: { id: ID, status: 'queued' } })?.claim?.status).toBe('queued');
    expect(meOf({ status: 'approved', handle: 'ok', claim: { id: ID } })).toBeNull();
  });
});


it('SH-198 validates queue positions and signed sending progress', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  expect(claimStateOf({ id, status: 'queued', position: 7 })?.position).toBe(7);
  for (const position of [0, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1]) expect(claimStateOf({ id, status: 'queued', position })).toBeNull();
  expect(claimStateOf({ id, status: 'sending', admitTx: null, sendTx: null, reason: null, at: '2026-11-11T00:00:00Z' })?.status).toBe('sending');
});
