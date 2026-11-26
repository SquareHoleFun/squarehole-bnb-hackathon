import { z } from 'zod';
import type { Address, Hex } from 'viem';
import { requireChain } from './config';
import { address, hash, requireThat, uint } from './schema';
import type { SafeProposer, SafeServicePayload } from './types';

export interface PendingSafeTransaction { safe: Address; hash: Hex; nonce: bigint; confirmations: Address[] }
export interface SafeService extends SafeProposer {
  listPending(safe: Address): Promise<PendingSafeTransaction[]>;
  confirmations(id: Hex): Promise<Address[]>;
  nonce(safe: Address): Promise<bigint>;
  cancel(original: SafeServicePayload, replacement: SafeServicePayload): Promise<void>;
}
const serviceCounter = z.union([uint, z.number().int().nonnegative().max(9007199254740991).transform(BigInt)]);
const confirmation = z.object({ owner: address });
const pending = z.object({ safe: address, safeTxHash: hash, nonce: serviceCounter,
  isExecuted: z.literal(false), confirmations: z.array(confirmation).nullable() });
function cancellation(original: SafeServicePayload, replacement: SafeServicePayload) {
  requireThat(original.safe === replacement.safe && original.nonce === replacement.nonce, 'cancellation requires same nonce and Safe');
  requireThat(replacement.to === original.safe && replacement.value === '0' && replacement.data === '0x'
    && replacement.operation === 0 && replacement.safeTxGas === '0' && replacement.baseGas === '0'
    && replacement.gasPrice === '0' && replacement.contractTransactionHash !== original.contractTransactionHash,
  'cancellation requires zero-effect self-call');
}
export function nextSafeNonce(chainNonce: bigint, rows: PendingSafeTransaction[]): bigint {
  // Avoid gaps even when a service has a distant queued nonce. Replacements share a reservation.
  const used = new Set(rows.map(r => r.nonce)); let nonce = chainNonce;
  while (used.has(nonce)) nonce++;
  return nonce;
}
/** No execution/broadcast API. Service responses are untrusted hints, never settlement evidence. */
export class SafeTransactionService implements SafeService {
  private base: URL;
  constructor(chainId: bigint, url: string, private fetcher: typeof fetch = fetch, allowMainnet = false) {
    requireChain(chainId, allowMainnet);
    this.base = new URL(url);
    requireThat(this.base.protocol === 'https:' && !this.base.username && !this.base.password && !this.base.search && !this.base.hash,
      'HTTPS Safe service origin required');
  }
  private async request(path: string, body?: SafeServicePayload): Promise<unknown> {
    const url = new URL(path, this.base);
    requireThat(url.origin === this.base.origin && !url.username && !url.password, 'foreign service pagination refused');
    let response: Response;
    try { response = await this.fetcher(url, { method: body ? 'POST' : 'GET', redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error('Safe service unavailable'); }
    requireThat(response.ok, `Safe service HTTP ${response.status}`);
    if (body) return null;
    try { return await response.json(); } catch { throw new Error('invalid Safe service response'); }
  }
  async propose(payload: SafeServicePayload) {
    // SafeTxHash is the server's idempotency key. Do not silently treat a conflict/error as success.
    await this.request(`/api/v1/safes/${payload.safe}/multisig-transactions/`, payload);
  }
  async listPending(safe: Address): Promise<PendingSafeTransaction[]> {
    let path: string | null = `/api/v1/safes/${safe}/multisig-transactions/?executed=false&ordering=nonce`;
    const result: PendingSafeTransaction[] = []; const visited = new Set<string>();
    while (path) {
      requireThat(!visited.has(path) && visited.size < 100, 'unbounded service pagination'); visited.add(path);
      const page = z.object({ next: z.string().nullable(), results: z.array(pending) }).parse(await this.request(path));
      for (const p of page.results) {
        requireThat(p.safe === safe, 'wrong Safe in service response');
        result.push({ safe, hash: p.safeTxHash, nonce: p.nonce, confirmations: (p.confirmations ?? []).map(c => c.owner) });
      }
      path = page.next;
    }
    return result;
  }
  async confirmations(id: Hex): Promise<Address[]> {
    const row = z.object({ safeTxHash: hash, confirmations: z.array(confirmation).nullable() })
      .parse(await this.request(`/api/v1/multisig-transactions/${id}/`));
    requireThat(row.safeTxHash === id, 'wrong service transaction');
    return (row.confirmations ?? []).map(c => c.owner);
  }
  async nonce(safe: Address): Promise<bigint> {
    const row = z.object({ address, nonce: serviceCounter }).parse(await this.request(`/api/v1/safes/${safe}/`));
    requireThat(row.address === safe, 'wrong service Safe'); return row.nonce;
  }
  async cancel(original: SafeServicePayload, replacement: SafeServicePayload) {
    cancellation(original, replacement); await this.propose(replacement);
  }
}
/** Offline double with the same replacement/nonce semantics; no fake data enters the production runner. */
export class FakeSafeService implements SafeService {
  readonly proposals = new Map<Hex, SafeServicePayload>();
  readonly owners = new Map<Hex, Address[]>();
  readonly nonces = new Map<Address, bigint>();
  async propose(payload: SafeServicePayload) { this.proposals.set(payload.contractTransactionHash, structuredClone(payload)); }
  async listPending(safe: Address) {
    return [...this.proposals.values()].filter(p => p.safe === safe && BigInt(p.nonce) >= (this.nonces.get(safe) ?? 0n))
      .map(p => ({ safe, hash: p.contractTransactionHash, nonce: BigInt(p.nonce), confirmations: this.owners.get(p.contractTransactionHash) ?? [] }));
  }
  async confirmations(id: Hex) { return [...(this.owners.get(id) ?? [])]; }
  async nonce(safe: Address) { return this.nonces.get(safe) ?? 0n; }
  async cancel(original: SafeServicePayload, replacement: SafeServicePayload) { cancellation(original, replacement); await this.propose(replacement); }
}
