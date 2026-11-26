/** LINKS-SRV: bounded creator-signature checks, in the exact order of box-links-v2.md §4. */
import type { IncomingMessage } from 'node:http';
import { createPublicClient, encodeFunctionData, http, HttpRequestError, RpcRequestError, parseAbi, recoverAddress, type Address, type Hex } from 'viem';
import { BOX_LINKS_LIMITS as LIMIT, boxLinksDigest, canonicalWebsite, canonicalX, canonicalTelegram, ERC1271_MAGIC_WORD } from '../../../../chain/src/core/v2/box-links-v2';
import { LinksUnavailableError } from '../../links/pg-links';
import type { LinksService } from '../../links/links-service';
import type { LinkRow, LinksView } from '../../links/types';
import { logLine } from '../../service';

export const ERC1271_ABI = parseAbi(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);
export type SignatureCall = (creator: Address, data: Hex, blockHash: Hex) => Promise<Hex>;

export type CreatorCodeCall = (creator: Address, blockHash: Hex) => Promise<Hex>;
export type SignatureRpc = SignatureCall & { readonly getCode: CreatorCodeCall };

/** Separate keyless transport, no follower/fallback/retries. Both reads use the applied EIP-1898 hash. */
export function erc1271Rpc(urls: readonly string[]): SignatureRpc {
  const url = urls.at(-1);
  if (!url) throw new Error('missing links signature endpoint');
  const client = createPublicClient({ transport: http(url, {
    // viem's HTTP timeout stops at headers; the request deadline below also covers body consumption.
    timeout: 0, retryCount: 0, batch: false,
    // viem otherwise promotes a JSON-RPC-shaped non-2xx body into a node error.
    onFetchResponse(response) {
      if (!response.ok) throw new HttpRequestError({ url, status: response.status });
    },
  }) });
  const request = async (read: (signal: AbortSignal) => Promise<Hex>): Promise<Hex> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error('signature check unavailable');
        reject(error);
        controller.abort(error);
      }, LIMIT.rpcTimeoutMs);
    });
    // Settle even if the transport fails to honor abort; late results cannot populate the creator cache.
    try { return await Promise.race([read(controller.signal), deadline]); }
    finally { clearTimeout(timer); }
  };
  const call: SignatureCall = (creator, data, blockHash) => request(signal => client.request<{
    Parameters: [{ to: Address; data: Hex; gas: Hex }, { blockHash: Hex; requireCanonical: true }]; ReturnType: Hex;
  }>({ method: 'eth_call', params: [
    { to: creator, data, gas: `0x${LIMIT.rpcGas.toString(16)}` }, { blockHash, requireCanonical: true },
  ] }, { retryCount: 0, signal }));
  const getCode: CreatorCodeCall = (creator, blockHash) => request(signal => client.request<{
    Parameters: [Address, { blockHash: Hex; requireCanonical: true }]; ReturnType: Hex;
  }>({ method: 'eth_getCode', params: [creator, { blockHash, requireCanonical: true }] }, { retryCount: 0, signal }));
  return Object.assign(call, { getCode });
}

function isRevert(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    // Do not inspect transport causes, messages, response bodies or request metadata for a revert.
    if (error instanceof HttpRequestError) return false;
    if (error instanceof RpcRequestError) {
      const rpc = error.cause as { code?: unknown; message?: unknown } | undefined;
      return typeof rpc?.code === 'number' && (rpc.code === 3
        || (typeof rpc.message === 'string' && /^execution reverted(?::|$)/i.test(rpc.message)));
    }
    error = (error as { cause?: unknown }).cause;
  }
  return false;
}

/** One instance per server. Only code-bearing creators spend the contract-call budget; no request queue. */
export class Erc1271Verifier {
  private active = 0;
  private starts: number[] = [];
  // Successful code reads live for this server instance; concurrent reads of one creator share a promise.
  private readonly codes = new Map<string, Promise<boolean>>();
  constructor(private readonly call: SignatureRpc, private readonly now: () => number = Date.now) {}
  private hasCode(creator: Address, blockHash: Hex): Promise<boolean> {
    const key = creator.toLowerCase();
    const cached = this.codes.get(key);
    if (cached) return cached;
    this.active++;
    const pending = Promise.resolve().then(() => this.call.getCode(creator, blockHash)).then(code => {
      if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(code)) throw new Error('invalid creator code');
      return code !== '0x';
    }).catch(error => { this.codes.delete(key); throw error; }).finally(() => { this.active--; });
    this.codes.set(key, pending);
    return pending;
  }
  async check(creator: Address, digest: Hex, signature: Hex, blockHash: Hex): Promise<'valid' | 'invalid' | 'busy' | 'unavailable'> {
    if (!this.codes.has(creator.toLowerCase()) && this.active >= LIMIT.rpcConcurrent) return 'busy';
    try { if (!await this.hasCode(creator, blockHash)) return 'invalid'; }
    catch { return 'unavailable'; }
    const now = this.now(); this.starts = this.starts.filter(start => now - start < 60_000);
    if (this.active >= LIMIT.rpcConcurrent || this.starts.length >= LIMIT.rpcPerMinute) return 'busy';
    this.active++; this.starts.push(now);
    try {
      const data = encodeFunctionData({ abi: ERC1271_ABI, functionName: 'isValidSignature', args: [digest, signature] });
      const result = await this.call(creator, data, blockHash);
      return typeof result === 'string' && result.toLowerCase() === ERC1271_MAGIC_WORD ? 'valid' : 'invalid';
    } catch (error) { return isRevert(error) ? 'invalid' : 'unavailable'; }
    finally { this.active--; }
  }
}

export type LinksError = 'not found' | 'read-only' | 'no chain' | 'content type' | 'body too large' | 'body timeout'
  | 'bad json' | 'bad keys' | 'website not canonical' | 'x not canonical' | 'telegram not canonical'
  | 'issuedAt format' | 'signature format' | 'not following' | 'no box' | 'issuedAt ahead of chain' | 'not newer'
  | 'signature check busy' | 'signature check unavailable' | 'not the creator' | 'links store unavailable';
export interface LinksReply {
  readonly status: number;
  readonly body: LinksView | { error: LinksError; savedIssuedAt?: string };
  readonly cache: 'no-store' | 'public, max-age=1';
  readonly headers?: Record<string, string>;
}
interface Submission { website: string; x: string; telegram: string; issuedAt: string; signature: Hex }
interface LinksOptions {
  readonly chainId: number;
  readonly store: LinksService;
  readonly verifier: Erc1271Verifier;
  readonly following: () => boolean;
  readonly creatorOf: (token: string) => Address | null;
  readonly head: () => { number: bigint; hash: Hex; timestamp: bigint } | null;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
}
const KEYS = ['website', 'x', 'telegram', 'issuedAt', 'signature'] as const;
const HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

type BodyRead = { text: string } | { error: 'body too large' | 'body timeout' | 'bad json' };
function readBody(req: IncomingMessage): Promise<BodyRead> {
  // Byte length is checked before any body listener; no numeric precision loss for a hostile Content-Length.
  const length = req.headers['content-length'];
  if (length && /^\d+$/.test(length) && BigInt(length) > BigInt(LIMIT.bodyBytes)) return Promise.resolve({ error: 'body too large' });
  return new Promise(resolve => {
    const chunks: Buffer[] = []; let size = 0; let done = false;
    const finish = (result: BodyRead) => {
      if (done) return; done = true; clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('error', failed); req.off('aborted', failed); req.off('close', closed);
      req.pause(); resolve(result);
    };
    const data = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length;
      if (size > LIMIT.bodyBytes) finish({ error: 'body too large' }); else chunks.push(bytes);
    };
    const end = () => finish({ text: Buffer.concat(chunks).toString('utf8') });
    const failed = () => finish({ error: 'bad json' });
    const closed = () => { if (!req.complete) failed(); };
    const timer = setTimeout(() => finish({ error: 'body timeout' }), LIMIT.bodyTimeoutMs);
    req.on('data', data); req.on('end', end); req.on('error', failed); req.on('aborted', failed); req.on('close', closed);
  });
}

export class LinksV2 {
  private readonly log: NonNullable<LinksOptions['log']>;
  constructor(private readonly options: LinksOptions) { this.log = options.log ?? logLine; }
  refuse(status: number, reason: LinksError, savedIssuedAt?: string): LinksReply {
    this.log('links_refused', { reason });
    return { status, body: { error: reason, ...(savedIssuedAt !== undefined ? { savedIssuedAt } : {}) }, cache: 'no-store',
      ...(status === 503 ? { headers: { 'Retry-After': String(LIMIT.retryAfterSeconds) } } : {}) };
  }
  get(token: string): LinksReply {
    const creator = this.options.creatorOf(token);
    return creator ? { status: 200, body: this.options.store.view(token, creator), cache: 'public, max-age=1' } : this.refuse(404, 'no box');
  }
  private savedReply(token: string, creator: Address, body: Submission, saved: LinkRow | null): LinksReply | null {
    if (!saved) return null;
    if (saved.website === body.website && saved.x === body.x && saved.telegram === body.telegram && saved.issuedAt === body.issuedAt) {
      return { status: 200, body: this.options.store.view(token, creator, saved), cache: 'no-store' };
    }
    return BigInt(saved.issuedAt) >= BigInt(body.issuedAt) ? this.refuse(409, 'not newer', saved.issuedAt) : null;
  }
  async post(req: IncomingMessage, token: Address): Promise<LinksReply> {
    // Path, chain and method are checked by CoreGateway, before reaching this body reader.
    if (!/^(?:text\/plain|application\/json)(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) return this.refuse(415, 'content type');
    const read = await readBody(req);
    if ('error' in read) return this.refuse(read.error === 'body too large' ? 413 : read.error === 'body timeout' ? 408 : 400, read.error);
    let parsed: unknown;
    try { parsed = JSON.parse(read.text); } catch { return this.refuse(400, 'bad json'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length !== KEYS.length
      || KEYS.some(key => !Object.hasOwn(parsed, key) || typeof (parsed as Record<string, unknown>)[key] !== 'string')) return this.refuse(400, 'bad keys');
    const body = parsed as Submission;
    if (canonicalWebsite(body.website) !== body.website) return this.refuse(400, 'website not canonical');
    if (canonicalX(body.x) !== body.x) return this.refuse(400, 'x not canonical');
    if (canonicalTelegram(body.telegram) !== body.telegram) return this.refuse(400, 'telegram not canonical');
    if (!/^(0|[1-9][0-9]{0,19})$/.test(body.issuedAt) || BigInt(body.issuedAt) > LIMIT.issuedAtMax) return this.refuse(400, 'issuedAt format');
    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(body.signature) || body.signature.length > 2 + LIMIT.signatureBytes * 2) return this.refuse(400, 'signature format');
    if (!this.options.following()) return this.refuse(503, 'not following');
    const creator = this.options.creatorOf(token);
    if (!creator) return this.refuse(404, 'no box');
    const head = this.options.head();
    if (!head) return this.refuse(503, 'not following');
    if (BigInt(body.issuedAt) > head.timestamp + LIMIT.aheadSeconds) return this.refuse(400, 'issuedAt ahead of chain');
    const replay = this.savedReply(token, creator, body, this.options.store.get(token));
    if (replay) return replay;
    const digest = boxLinksDigest(this.options.chainId, token, body, body.issuedAt);
    let signerKind: 'eoa' | 'erc1271' = 'erc1271';
    if (body.signature.length === 132 && /^(1b|1c)$/i.test(body.signature.slice(-2))
      && BigInt(`0x${body.signature.slice(66, 130)}`) <= HALF_ORDER) {
      try {
        if ((await recoverAddress({ hash: digest, signature: body.signature })).toLowerCase() === creator.toLowerCase()) signerKind = 'eoa';
      } catch { /* Recovery failure still permits ERC-1271. */ }
    }
    if (signerKind === 'erc1271') {
      const verdict = await this.options.verifier.check(creator, digest, body.signature, head.hash);
      if (verdict === 'busy') return this.refuse(503, 'signature check busy');
      if (verdict === 'unavailable') return this.refuse(503, 'signature check unavailable');
      if (verdict === 'invalid') return this.refuse(403, 'not the creator');
    }
    let result: Awaited<ReturnType<LinksService['save']>>;
    try {
      result = await this.options.store.save({ chainId: this.options.chainId, token, ...body,
        signer: creator.toLowerCase(), signerKind, verifiedBlock: head.number.toString() });
    } catch (error) {
      if (error instanceof LinksUnavailableError) return this.refuse(503, 'links store unavailable');
      throw error;
    }
    if (!result.saved) {
      const raced = this.savedReply(token, creator, body, result.row);
      if (!raced) throw new Error('box_links upsert ordering invariant');
      return raced;
    }
    this.log('links_saved', { chainId: this.options.chainId, token, issuedAt: body.issuedAt, signerKind, block: head.number.toString() });
    return { status: 200, body: this.options.store.view(token, creator, result.row), cache: 'no-store' };
  }
}
