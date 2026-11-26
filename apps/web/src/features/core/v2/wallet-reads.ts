/**
 * SH-274: after a mined send from the box page (a trade in its trade box, a give, pick or approval in its shop), the
 * page's reads of the connected wallet are read again through this one place. The reads keyed by the snapshot's block
 * (the claims' quotes, the holder fee share, the item payouts, the vault's items and coins, the launch tax) follow
 * `v2-feed`: a new snapshot gives them a new key. Two reads are keyed by the account alone and are named here: the
 * shop's read of the wallet's coin (`v2-shop-coins`) and the index's list of the wallet's claims (`v2-wallet-claims`);
 * SH-291: and My Box's holdings (`v2-holdings`).
 */
import type { QueryClient } from '@tanstack/react-query';

/** The box page's reads a mined send can change and no snapshot block names. */
export const WALLET_READ_KEYS: readonly string[] = Object.freeze(['v2-feed', 'v2-shop-coins', 'v2-wallet-claims', 'v2-holdings']);

/** Reads them again, with the caller's own reads (`extra`) beside them. */
export async function refreshWalletReads(queries: QueryClient, extra: readonly string[] = []): Promise<void> {
  await Promise.all([...new Set([...WALLET_READ_KEYS, ...extra])].map((name) => queries.invalidateQueries({ queryKey: [name] })));
}
