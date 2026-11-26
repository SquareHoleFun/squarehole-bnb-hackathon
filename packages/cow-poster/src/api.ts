import type { Address, Hex } from 'viem';
import { orderFields } from './order';
import type { Clock, CowApi, Log, Order } from './types';

const rawAmount = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 2n ** 256n;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** Hex strings (addresses, hashes) compare without case. */
const sameHex = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
/** CoW echoes the request's app data as sent: the poster sends the full JSON with its hash, so a quote carries the JSON in
 * `appData` and the hash in `appDataHash`; a hash-only request gets the hash alone. Either names this order's appData,
 * and a quote naming any other is not this sale. */
const sameAppData = (q: Record<string, unknown>, full: string, hash: Hex) =>
  (q.appDataHash === undefined || sameHex(q.appDataHash, hash)) && (q.appData === full || sameHex(q.appData, hash));

/** At least this long between two request starts: one CoW API base's whole budget for this poster process. */
export const REQUEST_SPACING_MS = 4000;
const STATUSES = ['open', 'fulfilled', 'cancelled', 'expired', 'presignaturePending'];

/** All quote, post and status calls share this queue. Redirects and automatic retries are disabled. */
export class CowHttp implements CowApi {
  private tail: Promise<unknown> = Promise.resolve();
  private nextRequestAt = 0;
  private backoffs = 0;
  private quotes = new Map<string, number>();
  constructor(private readonly base: string, private readonly clock: Clock, private readonly log: Log,
    private readonly fetcher: typeof fetch = fetch, private readonly signal?: AbortSignal) {}

  private request(path: string, body?: unknown, canSend = () => true): Promise<unknown> {
    const run = this.tail.then(async () => {
      while (this.clock.now() < this.nextRequestAt) {
        await this.clock.sleep(Math.min(this.nextRequestAt - this.clock.now(), 2_147_483_647));
      }
      this.signal?.throwIfAborted();
      if (!canSend()) { this.log('api_expired_quote'); return null; }
      this.nextRequestAt = this.clock.now() + REQUEST_SPACING_MS;
      try {
        const response = await this.fetcher(`${this.base}/api/v1/${path}`, {
          method: body === undefined ? 'GET' : 'POST', redirect: 'error',
          signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
          headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (response.status === 429 || response.status === 403) {
          const delay = Math.min(1_800_000, 30_000 * 2 ** Math.min(this.backoffs++, 6));
          const retry = response.headers.get('retry-after');
          const retryMs = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - this.clock.now() : 0;
          const jitter = Math.floor(delay * 0.25 * this.clock.random());
          const wait = Math.max(delay, Number.isFinite(retryMs) ? retryMs : 0) + jitter;
          this.nextRequestAt = Math.max(this.nextRequestAt, this.clock.now() + wait);
          this.log('api_backoff', { status: response.status, retryAt: this.nextRequestAt });
          await response.body?.cancel();
          return null;
        }
        if (!response.ok) {
          this.log('api_no_data', { status: response.status });
          await response.body?.cancel();
          return null;
        }
        const value: unknown = await response.json();
        this.backoffs = 0;
        return value;
      } catch {
        // Never log exceptions, URLs or response bodies: they may contain provider credentials.
        this.log('api_no_data'); return null;
      }
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  async quote(order: Order, from: Address): Promise<{ feeAmount: bigint } | null> {
    const fields = orderFields(order);
    const key = JSON.stringify({ ...fields, from });
    for (const [k, expiry] of this.quotes) if (expiry <= this.clock.now()) this.quotes.delete(k);
    this.quotes.delete(key);
    const response = await this.request('quote', {
      sellToken: fields.sellToken, buyToken: fields.buyToken, receiver: fields.receiver,
      kind: 'sell', sellAmountBeforeFee: fields.sellAmount, from, signingScheme: 'eip1271', onchainOrder: false,
      validTo: fields.validTo, appData: fields.appData, appDataHash: fields.appDataHash,
      sellTokenBalance: fields.sellTokenBalance, buyTokenBalance: fields.buyTokenBalance,
    });
    if (!object(response) || !object(response.quote)) return null;
    const q = response.quote;
    // A quote is data only if it describes THIS sale. Fees are in sell-token raw units.
    if (!sameHex(response.from, from) || !sameHex(q.sellToken, order.sellToken)
      || !sameHex(q.buyToken, order.buyToken) || !sameHex(q.receiver, order.receiver)
      || q.kind !== 'sell' || q.sellTokenBalance !== 'erc20' || q.buyTokenBalance !== 'erc20'
      || q.partiallyFillable !== false || q.validTo !== order.validTo
      || !sameAppData(q, fields.appData, fields.appDataHash) || !rawAmount(q.sellAmount) || !rawAmount(q.feeAmount)
      || !rawAmount(q.buyAmount) || BigInt(q.buyAmount) === 0n
      || BigInt(q.sellAmount) + BigInt(q.feeAmount) !== order.sellAmount
      || typeof response.expiration !== 'string' || !(Date.parse(response.expiration) > this.clock.now())) return null;
    this.quotes.set(key, Math.min(Date.parse(response.expiration), order.validTo * 1000));
    return { feeAmount: BigInt(q.feeAmount) };
  }

  async post(order: Order, from: Address, signature: Hex): Promise<string | null> {
    const fields = { ...orderFields(order), from };
    const key = JSON.stringify(fields);
    const response = await this.request('orders', { ...fields, signature, signingScheme: 'eip1271' }, () => {
      const expiry = this.quotes.get(key);
      this.quotes.delete(key);
      return expiry !== undefined && expiry > this.clock.now();
    });
    return typeof response === 'string' && /^0x[0-9a-fA-F]{112}$/.test(response) ? response.toLowerCase() : null;
  }
  async status(uid: string): Promise<string | null> {
    if (!/^0x[0-9a-fA-F]{112}$/.test(uid)) throw new Error('invalid UID');
    const response = await this.request(`orders/${uid}`);
    return object(response) && typeof response.status === 'string' && STATUSES.includes(response.status) ? response.status : null;
  }
  /** RC6RR2-COW-2: the order CoW stores under `uid`: its status and the signature bytes it was posted with. */
  async stored(uid: string): Promise<{ status: string | null; signature: Hex | null } | null> {
    if (!/^0x[0-9a-fA-F]{112}$/.test(uid)) throw new Error('invalid UID');
    const response = await this.request(`orders/${uid}`);
    if (!object(response)) return null;
    return { status: typeof response.status === 'string' && STATUSES.includes(response.status) ? response.status : null,
      signature: typeof response.signature === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(response.signature)
        ? response.signature.toLowerCase() as Hex : null };
  }
}
