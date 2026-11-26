import type { Address } from 'viem';
import { walletClaimsPageSchemaV2, type WalletClaimsPageV2 } from './claims-types';
export type { WalletClaimV2, WalletClaimsPageV2, ClaimsAsOfV2 } from './claims-types';

export interface WalletClaimsRequestV2 {
  readonly baseUrl: string;
  readonly chainId: number;
  readonly wallet: Address;
  readonly after?: string | null;
  /** Bounds candidates examined, so a page may be empty and still have a next cursor. */
  readonly limit?: number;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof globalThis.fetch;
}

/** Read-only HTTP; never requests wallet access or sends a transaction. Raw values remain decimal strings. */
export async function readWalletClaimsPageV2(request: WalletClaimsRequestV2): Promise<WalletClaimsPageV2> {
  if (!/^0x[0-9a-f]{40}$/i.test(request.wallet) || !Number.isSafeInteger(request.chainId) || request.chainId < 1) throw new Error('invalid claims wallet or chain');
  const limit = request.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('claims limit is 1-100');
  const url = new URL(`${request.baseUrl.replace(/\/$/, '')}/v2/wallets/${request.chainId}/${request.wallet.toLowerCase()}/claims`);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('claims URL must be HTTP');
  url.searchParams.set('limit', String(limit));
  if (request.after) url.searchParams.set('after', request.after);
  const response = await (request.fetch ?? globalThis.fetch)(url, { signal: request.signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`wallet claims HTTP ${response.status}${response.status === 409 ? ': restart pagination at the canonical head' : ''}`);
  const page = walletClaimsPageSchemaV2.parse(await response.json());
  if (page.chainId !== request.chainId || page.wallet !== request.wallet.toLowerCase()) throw new Error('claims wallet or chain mismatch');
  return page;
}

/** Complete traversal or an error; never return a partial Claim all after a failed/reorged page. */
export async function readAllWalletClaimsV2(request: Omit<WalletClaimsRequestV2, 'after'>): Promise<WalletClaimsPageV2> {
  const first = await readWalletClaimsPageV2(request);
  const items = [...first.items]; const cursors = new Set<string>(); const ids = new Set(items.map(row => row.id));
  let after = first.next;
  while (after !== null) {
    if (cursors.has(after)) throw new Error('repeated claims cursor');
    cursors.add(after);
    const page = await readWalletClaimsPageV2({ ...request, after });
    if (JSON.stringify(page.asOf) !== JSON.stringify(first.asOf) || page.recentFromBlock !== first.recentFromBlock) throw new Error('claims snapshot changed between pages');
    for (const row of page.items) {
      if (ids.has(row.id)) throw new Error('repeated claim across pages');
      ids.add(row.id); items.push(row);
    }
    after = page.next;
  }
  return { ...first, items, next: null };
}
