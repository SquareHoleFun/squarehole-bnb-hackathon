/**
 * F161 (4), SH-ALPHA-SITE: the Sepolia alpha's calls to our own alpha-api (infra/server/services/alpha-api.mjs; the
 * routes and their answers: docs/runbooks/alpha-access.md, "API and approvals"). Same-origin requests only: the
 * session is our server's `__Host-alpha_session` cookie, HttpOnly, which this code never reads or writes; the browser
 * sends it. Every answer is checked for its exact shape before the page shows anything of it, and a refusal keeps the
 * server's status and short reason (the server never echoes tokens, profiles or signatures in one).
 *
 * The join page (public) uses the session calls, the Claim card (the app, approved testers) the claim calls, and the
 * desk (behind Cloudflare Access) the desk calls. Sepolia builds only: nothing reaches this module from a mainnet build
 * (production-check.ts keeps `/alpha/` out of one).
 */

export type AlphaStatus = 'pending' | 'approved' | 'removed';
export type ClaimStatus = 'queued' | 'waiting' | 'sending' | 'sent' | 'skipped' | 'refused' | 'failed';

/** A claim as `/alpha/me` and `/alpha/claim/<id>` show it: queued, or the sender's receipt (design § 6). */
export interface ClaimState {
  readonly id: string;
  readonly position?: number;
  readonly status: ClaimStatus;
  readonly admitTx: `0x${string}` | null;
  readonly sendTx: `0x${string}` | null;
  readonly reason: string | null;
  readonly at: string | null;
}

export interface AlphaMe {
  readonly status: AlphaStatus;
  readonly handle: string;
  readonly claim: ClaimState | null;
}

export interface ClaimChallenge {
  readonly id: string;
  readonly address: `0x${string}`;
  /** The exact text the wallet signs (EIP-191), as the server issued it. */
  readonly message: string;
  readonly requestedAt: string;
}

export interface Signup {
  readonly xId: string;
  readonly privyDid: string;
  readonly handle: string;
  readonly name: string;
  readonly status: AlphaStatus;
  readonly signedUpAt: string;
  readonly lastSignIn: string;
}

export type Decision = 'approve' | 'remove' | 'reset';

export interface DecisionRecord {
  readonly seq: number;
  readonly xId: string;
  readonly decision: Decision;
  readonly actor: string;
  readonly at: string;
}

export interface Intake { readonly open: boolean; readonly returning: boolean }
export interface AlphaLoad {
  readonly pending: number; readonly approved: number; readonly cap: number; readonly claimsWaiting: number;
  readonly senderFloat: 'ready' | 'low' | 'unknown';
}
export interface Desk {
  readonly load?: AlphaLoad;
  readonly signups: readonly Signup[];
  readonly decisions: readonly DecisionRecord[];
}

/** An answer: the checked value, or why not (`status` 0 when no answer came at all, -1 when it was not well formed). */
export type AlphaResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly status: number; readonly error: string };

export const ALPHA_STATUSES: readonly AlphaStatus[] = Object.freeze(['pending', 'approved', 'removed']);
const CLAIM_STATUSES: readonly ClaimStatus[] = ['queued', 'waiting', 'sending', 'sent', 'skipped', 'refused', 'failed'];
const DECISIONS: readonly Decision[] = ['approve', 'remove', 'reset'];
/** X's own limits, as the server checks them (alpha/auth.mjs, alpha/message.mjs). */
export const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;
export const X_ID = /^[1-9][0-9]{0,19}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const TX = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
/** The one dry-run outcome that frees a claim for a fresh attempt (design § 6, "Integrated storage and retry contract"). */
export const DRY_RUN_REASON = 'dry run; no transactions';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const isTime = (value: unknown): value is string => typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value));

export function claimStateOf(value: unknown): ClaimState | null {
  if (!isObject(value) || typeof value.id !== 'string' || !UUID.test(value.id) || !CLAIM_STATUSES.includes(value.status as ClaimStatus)) return null;
  const status = value.status as ClaimStatus;
  if (status === 'queued') {
    if (value.position !== undefined && (!Number.isSafeInteger(value.position) || (value.position as number) < 1)) return null;
    return Object.freeze({ id: value.id, status, ...(value.position === undefined ? {} : { position: value.position as number }), admitTx: null, sendTx: null, reason: null, at: null });
  }
  const hash = (field: unknown): `0x${string}` | null | undefined => (field === null ? null : typeof field === 'string' && TX.test(field) ? field as `0x${string}` : undefined);
  const admitTx = hash(value.admitTx);
  const sendTx = hash(value.sendTx);
  const reason = value.reason === null ? null : isText(value.reason, 2048) ? value.reason : undefined;
  if (admitTx === undefined || sendTx === undefined || reason === undefined || !isTime(value.at)) return null;
  if (status === 'sending' && (admitTx !== null || sendTx !== null || reason !== null)) return null;
  if (status === 'waiting' && (admitTx !== null || sendTx !== null || reason !== 'insufficient float for starter and gas')) return null;
  return Object.freeze({ id: value.id, status, admitTx, sendTx, reason, at: value.at });
}

export function meOf(value: unknown): AlphaMe | null {
  if (!isObject(value) || !ALPHA_STATUSES.includes(value.status as AlphaStatus) || typeof value.handle !== 'string' || !X_HANDLE.test(value.handle)) return null;
  const claim = value.claim === null ? null : claimStateOf(value.claim);
  if (value.claim !== null && claim === null) return null;
  return Object.freeze({ status: value.status as AlphaStatus, handle: value.handle, claim });
}

export function challengeOf(value: unknown, address: string): ClaimChallenge | null {
  if (!isObject(value) || typeof value.id !== 'string' || !UUID.test(value.id) || typeof value.address !== 'string' || !ADDRESS.test(value.address)) return null;
  if (value.address.toLowerCase() !== address.toLowerCase() || !isText(value.message, 4096) || !isTime(value.requestedAt)) return null;
  // The text must name this claim and this address in its own slots (the sender checks the whole text again).
  if (!value.message.includes(`Claim ID: ${value.id}\n`) || !value.message.includes(` to wallet ${value.address}.\n`)) return null;
  return Object.freeze({ id: value.id, address: value.address as `0x${string}`, message: value.message, requestedAt: value.requestedAt });
}

function signupOf(value: unknown): Signup | null {
  if (!isObject(value) || typeof value.xId !== 'string' || !X_ID.test(value.xId) || typeof value.handle !== 'string' || !X_HANDLE.test(value.handle)) return null;
  if (!isText(value.privyDid, 256) || !isText(value.name, 256) || !ALPHA_STATUSES.includes(value.status as AlphaStatus) || !isTime(value.signedUpAt) || !isTime(value.lastSignIn)) return null;
  return Object.freeze({ xId: value.xId, privyDid: value.privyDid, handle: value.handle, name: value.name, status: value.status as AlphaStatus, signedUpAt: value.signedUpAt, lastSignIn: value.lastSignIn });
}

function decisionOf(value: unknown): DecisionRecord | null {
  if (!isObject(value) || !Number.isSafeInteger(value.seq) || typeof value.xId !== 'string' || !X_ID.test(value.xId)) return null;
  if (!DECISIONS.includes(value.decision as Decision) || !isText(value.actor, 512) || !isTime(value.at)) return null;
  return Object.freeze({ seq: value.seq as number, xId: value.xId, decision: value.decision as Decision, actor: value.actor, at: value.at });
}

export function deskOf(value: unknown): Desk | null {
  if (!isObject(value) || !Array.isArray(value.signups) || !Array.isArray(value.decisions)) return null;
  const signups = value.signups.map(signupOf);
  const decisions = value.decisions.map(decisionOf);
  if (signups.some((row) => row === null) || decisions.some((row) => row === null)) return null;
  if (value.load !== undefined && (!isObject(value.load)
    || !['pending', 'approved', 'cap', 'claimsWaiting'].every(k => Number.isSafeInteger((value.load as Record<string, unknown>)[k]) && ((value.load as Record<string, unknown>)[k] as number) >= (k === 'cap' ? 1 : 0))
    || !['ready', 'low', 'unknown'].includes(value.load.senderFloat as string))) return null;
  return Object.freeze({ ...(value.load === undefined ? {} : { load: value.load as unknown as AlphaLoad }), signups: Object.freeze(signups as Signup[]), decisions: Object.freeze(decisions as DecisionRecord[]) });
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** One same-origin request: its checked JSON value, or the refusal's status and short reason. */
async function call<T>(fetcher: Fetch, path: string, init: RequestInit, read: (value: unknown) => T | null, expect: readonly number[] = [200]): Promise<AlphaResult<T>> {
  let response: Response;
  try {
    response = await fetcher(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', ...init, headers: { accept: 'application/json', ...(init.headers as Record<string, string> | undefined) } });
  } catch {
    return { ok: false, status: 0, error: 'no answer' };
  }
  let body: unknown;
  try { body = await response.json(); } catch { body = null; }
  if (!expect.includes(response.status)) {
    const error = isObject(body) && isText(body.error, 200) ? body.error : 'request refused';
    return { ok: false, status: response.status, error };
  }
  const value = read(body);
  return value === null ? { ok: false, status: -1, error: 'unexpected answer' } : { ok: true, value };
}

const post = (body?: unknown, headers: Record<string, string> = {}): RequestInit => (body === undefined
  ? { method: 'POST', headers }
  : { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });

export interface AlphaApi {
  intake(): Promise<AlphaResult<Intake>>;
  /** `GET /alpha/me`: this browser's sign-up, or 401 without a session. */
  me(): Promise<AlphaResult<AlphaMe>>;
  /** `POST /alpha/session` with Privy's identity token (header `privy-id-token`, nothing else sent). */
  session(identityToken: string): Promise<AlphaResult<AlphaMe>>;
  /** `POST /alpha/signout`: ends our session (the cookie goes). */
  signOut(): Promise<AlphaResult<true>>;
  /** `GET /alpha/claim/message?address=`: the exact text to sign for this address (approved testers only). */
  claimMessage(address: string): Promise<AlphaResult<ClaimChallenge>>;
  /** `POST /alpha/claim`: the signed text; 202 with the queued claim. */
  claim(input: { readonly address: string; readonly message: string; readonly signature: string }): Promise<AlphaResult<ClaimState>>;
  /** `GET /alpha/claim/<id>`: queued, or the sender's receipt. */
  claimState(id: string): Promise<AlphaResult<ClaimState>>;
  /** `GET /desk/api/signups` (Cloudflare Access in front). */
  signups(): Promise<AlphaResult<Desk>>;
  /** `POST /desk/api/decide`: the founder's decision for one X account, by its number. */
  decide(xId: string, decision: Decision): Promise<AlphaResult<AlphaStatus>>;
}

export function alphaApi(fetcher: Fetch = (input, init) => fetch(input, init)): AlphaApi {
  return {
    intake: () => call(fetcher, '/alpha/intake', { method: 'GET' }, value => isObject(value) && typeof value.open === 'boolean' && typeof value.returning === 'boolean' ? { open: value.open, returning: value.returning } : null),
    me: () => call(fetcher, '/alpha/me', { method: 'GET' }, meOf),
    session: (identityToken) => call(fetcher, '/alpha/session', post(undefined, { 'privy-id-token': identityToken }), meOf),
    signOut: () => call(fetcher, '/alpha/signout', post(), (value) => (isObject(value) && value.status === 'signed-out' ? true : null)),
    claimMessage: (address) => call(fetcher, `/alpha/claim/message?address=${encodeURIComponent(address)}`, { method: 'GET' }, (value) => challengeOf(value, address)),
    claim: (input) => call(fetcher, '/alpha/claim', post({ address: input.address, message: input.message, signature: input.signature }), claimStateOf, [202]),
    claimState: (id) => (UUID.test(id) ? call(fetcher, `/alpha/claim/${id}`, { method: 'GET' }, claimStateOf) : Promise.resolve({ ok: false, status: -1, error: 'invalid claim id' })),
    signups: () => call(fetcher, '/desk/api/signups', { method: 'GET' }, deskOf),
    decide: (xId, decision) => call(fetcher, '/desk/api/decide', post({ xId, decision }), (value) => (isObject(value) && ALPHA_STATUSES.includes(value.status as AlphaStatus) ? value.status as AlphaStatus : null)),
  };
}
