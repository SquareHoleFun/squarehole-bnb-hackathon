import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { parseUnits, type Address } from 'viem';
import { BrowserWalletDialog, DemoWalletDialog, useWallet } from '../../wallet';
import { rolesOfV2 } from '../../../../../../packages/chain/src/core/v2';
import { actionIO, sendActionV2, type ActionV2 } from './actions-v2';
import { withSingleClaim, type SingleKnown } from './claim-all';
import { claimAllIO, sendCreatorFeesV2 } from './claim-all-actions';
import { singleSessionKey, useCreatorQuoteV2 } from './claim-reads';
import type { V2Snapshot, V2Source } from './indexer-v2';
import type { CloseCall } from './v2-frozen';
import { CLAIM_WINDOW_LINE } from './v2-words';
import { InsufficientGasFundsError } from '@squarehole/chain/write';
import { gasFundsLine } from '../../tx/gas-words';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;
/** The page's actions; the creator's fees are their own (FINAL-OC01: the next payment, through `sendCreatorFeesV2`). */
type PageAction = ActionV2 | { readonly kind: 'creator' };
export function V2Actions({ source, view, close, disabled, symbol }: { source: V2Source; view: V2Snapshot; close: CloseCall | null; disabled: boolean; symbol: string }) {
  const wallet = useWallet(); const queries = useQueryClient(); const ref = useRef<HTMLButtonElement>(null);
  const [dialog, setDialog] = useState(false); const [pending, setPending] = useState<{ action: PageAction; account: Address } | null>(null);
  // The payee's next payment (the receiver's own quote, shared with the creator panel and Claim all), never creatorOwed;
  // nothing once this session's claim is mined, until a later read finds more (the block rule).
  const quote = useCreatorQuoteV2(source, view);
  const creatorP = quote.state.kind === 'ready' && !quote.failed ? quote.state.read.amount : 0n;
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState<string | null>(null); const [coins, setCoins] = useState('');
  const amount = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(coins) ? parseUnits(coins, 18) : 0n;
  const connected = wallet.status === 'connected' && wallet.account !== null;
  const active = pending?.account.toLowerCase() === wallet.account?.toLowerCase() ? pending?.action : null;
  const wrong = connected && (wallet.chainId !== source.manifest.chainId || wallet.kind !== 'injected');
  const eligible = amount > 0n && view.closing !== null && amount <= view.closing.tLeft;
  const begin = (action: PageAction) => { setMessage(null); if (!connected) setDialog(true); else if (wallet.account) setPending({ action, account: wallet.account }); };
  const confirm = async () => {
    if (!active || disabled || wrong || !wallet.account || !wallet.signer || busy) return;
    setBusy(true); setMessage(null);
    try {
      const roles = rolesOfV2(view.record).contracts;
      if (active.kind === 'creator') {
        // The quote shown now, re-read at this snapshot's hash by the guarded sender; this session records the paid amount.
        const r = await sendCreatorFeesV2(source, view, wallet.account, creatorP, claimAllIO(source, view, wallet.signer.request));
        queries.setQueryData<SingleKnown>(singleSessionKey('creator', source.manifest.chainId, roles.receiver ?? null, wallet.account), (known) =>
          withSingleClaim(known, { tx: r.transactionHash, block: r.blockNumber, paid: r.paidP ?? creatorP }));
      } else await sendActionV2({ chainId: source.manifest.chainId, token: view.token, coordinator: roles.coordinator as Address, receiver: roles.receiver as Address, p: view.record.q }, wallet.account, active, actionIO(source.rpc, wallet.signer.request));
      setMessage(active.kind === 'approve' ? 'Approval confirmed. Claim in a separate transaction.' : 'Confirmed. Reading the updated box…');
      setPending(null);
      await Promise.all([queries.invalidateQueries({ queryKey: ['v2-feed'] }), queries.invalidateQueries({ queryKey: ['v2-wallet-claims'] })]);
    } catch (error) { setMessage(error instanceof InsufficientGasFundsError ? gasFundsLine(error.chainId) : error instanceof Error ? error.message : 'Nothing confirmed. Try again.'); }
    finally { setBusy(false); }
  };
  const owner = wallet.account?.toLowerCase();
  const creator = view.money && owner === view.money.creatorPayee.toLowerCase();
  return <div className="sh-v2-actions">
    {wrong ? <p>Connect a browser wallet on this box’s network.</p> : null}
    {close ? <button ref={ref} type="button" className="sh-button sh-button--primary" disabled={disabled || busy} onClick={() => begin({ kind: 'close', call: close })}>Close box</button> : null}
    {view.closing && view.closing.tLeft > 0n ? <>
      <label>Coins to claim<input className="sh-newbox-input" inputMode="decimal" value={coins} onChange={(e) => { setCoins(e.target.value); setPending(null); }} /></label>
      <button type="button" className="sh-button" disabled={disabled || busy || !eligible} onClick={() => begin({ kind: 'approve', amount })}>Approve coins</button>
      <button type="button" className="sh-button sh-button--primary" disabled={disabled || busy || !eligible} onClick={() => begin({ kind: 'claim', amount })}>{`Claim ${symbol}`}</button>
      <p>{`Approve, then claim · ${CLAIM_WINDOW_LINE.toLowerCase()}`}</p>
    </> : null}
    {view.closing && view.closing.creatorEntitlement > 0n && (!connected || owner === view.record.creator.toLowerCase()) ? <button type="button" className="sh-button" disabled={disabled || busy} onClick={() => begin({ kind: 'no-buyers' })}>Claim creator remainder</button> : null}
    {view.graduated && !view.failed && creatorP > 0n && (!connected || creator) ? <button type="button" className="sh-button" disabled={disabled || busy} onClick={() => begin({ kind: 'creator' })}>Claim creator fees</button> : null}
    {active ? <div role="group" aria-label="Confirm transaction"><p>{active.kind === 'close' ? 'Close this box into the holders’ claim?' : active.kind === 'approve' ? `Approve exactly ${coins} coins for this box’s claim?` : 'Send this claim to your connected wallet?'}</p>
      <button type="button" className="sh-button sh-button--primary" disabled={disabled || busy || wrong || !connected} onClick={() => void confirm()}>{busy ? 'Waiting for confirmation…' : 'Confirm'}</button>
      <button type="button" className="sh-button" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
    </div> : null}
    {message ? <p role="status">{message}</p> : null}
    <BrowserWalletDialog open={dialog && wallet.defaultDialog === 'browser'} onClose={() => setDialog(false)} returnFocus={ref} />
    {DEMO_BUILD ? <DemoWalletDialog open={dialog && wallet.defaultDialog === 'demo'} onClose={() => setDialog(false)} returnFocus={ref} /> : null}
  </div>;
}
