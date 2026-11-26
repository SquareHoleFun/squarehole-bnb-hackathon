/**
 * Box 0's action panel on its page (SH-BOX0-ACTIONS): only for box 0 (the row's registry and id, never a name), with
 * its tickets and stream, once graduated. The ids it lists come from the indexer's wallet answer for the address the
 * app already shows as connected; reading that answer asks the wallet nothing.
 */
import type { BoxRow } from '@squarehole/chain';
import type { Address } from 'viem';
import { useOptionalWallet } from '../../wallet';
import type { CoreSource } from '../core-build';
import type { Fetcher } from '../core-client';
import { useCoreWallet } from '../useCore';
import { Box0Actions } from './Box0Actions';
import { NO_HOLDINGS, type Box0Holdings } from './box0-reads';
import type { Box0Roles } from './box0-send';

/**
 * The reveal service's signer per chain, for "Let the service open it" (box0-reveal-service.md, holder UI). None is
 * provisioned yet: the founder names it (and approves this route) before it is added here.
 */
export const REVEAL_SERVICE_BY_CHAIN: Readonly<Record<number, Address>> = Object.freeze({});

export function box0RolesOf(row: BoxRow): Box0Roles | null {
  const c = row.contracts;
  if (!row.isBox0 || !c.token || !c.tickets || !c.itemStream || !c.vault) return null;
  return { chainId: row.chainId, token: c.token, tickets: c.tickets, stream: c.itemStream, vault: c.vault, service: REVEAL_SERVICE_BY_CHAIN[row.chainId] ?? null };
}

const ids = (values: readonly string[] | undefined): bigint[] => (values ?? []).filter((v) => /^[0-9]+$/.test(v)).map(BigInt);

export function Box0Panel({ row, core, graduated, disabled, ticker, fetcher }: { row: BoxRow; core: CoreSource; graduated: boolean; disabled: boolean; ticker: string; fetcher?: Fetcher }) {
  const wallet = useOptionalWallet();
  const roles = box0RolesOf(row);
  // The wallet answer is fetched only where the panel shows (box 0, graduated): other box pages make no extra request.
  const account = wallet?.status === 'connected' && roles !== null && graduated ? (wallet.account as Address | null) : null;
  const answer = useCoreWallet(core, account, fetcher);
  // No wallet context (a page mounted on its own, as in its tests): no panel; the app always has one.
  if (!wallet || !roles || !graduated || core.status !== 'ready') return null;
  const token = roles.token.toLowerCase();
  const box = answer?.status === 'ready' ? answer.value.boxes.find((b) => b.box.token.toLowerCase() === token)?.box : undefined;
  const holdings: Box0Holdings = box ? { tickets: ids(box.tickets), draws: ids(box.draws), items: ids(box.items) } : NO_HOLDINGS;
  return <Box0Actions key={`${roles.chainId}:${token}`} roles={roles} rpcUrl={core.rpcUrl} ticker={ticker} noun="Misfit" holdings={holdings} disabled={disabled} />;
}
