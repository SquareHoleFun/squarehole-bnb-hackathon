/**
 * Box 0's draw, open and claim panel (SH-BOX0-ACTIONS), on its page once graduated. Numbers first, one line each. The
 * reads are public RPC reads; the wallet is asked nothing until a button is clicked (no connect, no account request
 * on navigation): a click without a connection opens the wallet dialog, and a click with one prepares the step from
 * fresh chain reads and asks for a confirmation in the page before the one wallet request.
 *
 * SH-BOX0-EXITS: once box 0 is in terminal mode on chain (someone else called `enterTerminal`), a requested draw and a
 * placeholder without a number get their FIT back, and from 3 days on one hidden item can be taken by its number. Each
 * shows only when its call would succeed now. Before that the page has no stop and says nothing about stuck draws,
 * deadlines or missing numbers (F142, desk R61-STOP "hide"); a dead head only keeps the draw button off (`QueueDead`).
 */
import { handBackMinFor } from '@squarehole/chain';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Eip1193Request } from '@squarehole/chain/write/wallet';
import { useRef, useState } from 'react';
import type { Address } from 'viem';
import { formatToken } from '../../fit-pair/fit-format';
import { BrowserWalletDialog, DemoWalletDialog, useWallet } from '../../wallet';
import { PHASE, claimOffer, drawOffer, drawRow, placeholderRow, queueBlocked, roundDownFit, roundUpFit, takeOffer, type Box0Action, type Box0Row } from './box0-model';
import { readBox0, type Box0Holdings, type Box0Reads } from './box0-reads';
import { DrawValueRoseError, box0ErrorText, box0IO, prepareDraw, prepareTake, sendBox0, type Box0IO, type Box0Roles, type Box0Step, type DrawPlan, type TakePlan } from './box0-send';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;
const READ_MS = 12_000;

export interface Box0ActionsProps {
  readonly roles: Box0Roles;
  readonly rpcUrl: string;
  readonly ticker: string;
  /** One item's name ("Misfit"). */
  readonly noun: string;
  /** Placeholder, draw and item ids from the indexer's wallet answer (none without it). */
  readonly holdings: Box0Holdings;
  /** The box view is stale or unverified: every button is off. */
  readonly disabled: boolean;
  /** Test seams: the chain reads and the RPC edge of a send. */
  readonly read?: (account: Address | null, holdings: Box0Holdings) => Promise<Box0Reads>;
  readonly ioFor?: (request: Eip1193Request) => Box0IO;
}

type Pending =
  | { readonly kind: 'draw'; readonly plan: DrawPlan }
  | { readonly kind: 'claim'; readonly ids: readonly bigint[]; readonly amount: bigint }
  | { readonly kind: 'row'; readonly action: Box0Action }
  | { readonly kind: 'take'; readonly plan: TakePlan; readonly itemId: bigint; readonly poolIndex: bigint };

/**
 * ETH rounded UP at 4 decimals: a charge is never shown below what may be sent. A draw's ETH is already a whole number
 * of 0.0001 ETH (`drawValueAt`), so its line is exactly the amount sent (SH-BOX0-DRAW-VALUE).
 */
const ethUp = (raw: bigint): string => formatToken(((raw + 10n ** 14n - 1n) / 10n ** 14n) * 10n ** 14n, 'ETH', { digits: 4 });

function stepOf(action: Box0Action): Box0Step {
  switch (action.kind) {
    case 'open-draw': return { kind: 'open-draw', ticket: action.ticket };
    case 'open': return { kind: 'open', tokenId: action.tokenId };
    case 'approve-service': return { kind: 'approve-service', tokenId: action.tokenId };
    case 'cancel-draw': return { kind: 'cancel-draw', ticket: action.ticket };
    // The floor: the quote shown less 1% (a hand-back between the read and the send can move it a little).
    case 'hand-back': return { kind: 'hand-back', tokenId: action.tokenId, min: handBackMinFor(action.amount) };
  }
}

function questionOf(action: Box0Action, ticker: string): string {
  switch (action.kind) {
    case 'approve-service': return `Let the reveal service open placeholder ${action.tokenId}? This approval also lets it move that placeholder.`;
    case 'cancel-draw': return `Cancel draw ${action.ticket} and get about ${formatToken(roundDownFit(action.amount), ticker)} back?`;
    case 'hand-back': return `Hand back placeholder ${action.tokenId} for at least ${formatToken(roundDownFit(handBackMinFor(action.amount)), ticker)}?`;
    default: return `${action.kind === 'open' ? `Open placeholder ${action.tokenId}` : `Open draw ${action.ticket}`} now? Its picture comes later.`;
  }
}

/** A row's button: an amount after the label when the action pays one ("Get back · 999.5 FIT", rounded down). */
const buttonOf = (action: Box0Action, ticker: string): string =>
  action.kind === 'cancel-draw' || action.kind === 'hand-back' ? `${action.label} · ${formatToken(roundDownFit(action.amount), ticker)}` : action.label;

export function Box0Actions({ roles, rpcUrl, ticker, noun, holdings, disabled, read, ioFor = box0IO.bind(null, rpcUrl) }: Box0ActionsProps) {
  const wallet = useWallet();
  const queries = useQueryClient();
  const ref = useRef<HTMLButtonElement>(null);
  const [dialog, setDialog] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [session, setSession] = useState<readonly bigint[]>([]);
  const connected = wallet.status === 'connected' && wallet.account !== null;
  const account = connected ? (wallet.account as Address) : null;
  const wrong = connected && (wallet.chainId !== roles.chainId || wallet.kind !== 'injected');
  const draws = [...new Set([...holdings.draws, ...session].map(String))].map(BigInt);
  const held: Box0Holdings = { ...holdings, draws };
  const key = ['box0-actions', rpcUrl, roles.tickets, account ?? '', held.tickets.join(','), draws.join(','), held.items.join(',')];
  const query = useQuery({ queryKey: key, queryFn: () => (read ?? ((a, h) => readBox0(rpcUrl, roles, a, h)))(account, held), refetchInterval: READ_MS });
  const r = query.data;
  if (!r) return null;
  const offer = drawOffer(r.phase, r.quote, queueBlocked(r));
  const rows: Box0Row[] = [
    ...r.draws.map((d) => drawRow(d, r.now, noun, r.phase === PHASE.Terminal, r.refund)).filter((row): row is Box0Row => row !== null),
    ...r.placeholders.map((p) => placeholderRow(p, { phase: r.phase, wordAcceptedAt: r.wordAcceptedAt, now: r.now, service: roles.service, refund: r.refund }, noun)),
  ];
  const claim = claimOffer({ owed: r.owed, pending: r.pending, held: r.held, ids: r.items });
  const take = takeOffer(r);
  if (!offer && rows.length === 0 && !claim && !take) return null;
  const off = disabled || busy;

  const run = async (work: (io: Box0IO, me: Address) => Promise<void>) => {
    if (!wallet.signer || !account || wrong || disabled || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await work(ioFor(wallet.signer.request), account);
    } catch (error) {
      setMessage(box0ErrorText(error));
    } finally {
      setBusy(false);
    }
  };
  const refresh = () => Promise.all([queries.invalidateQueries({ queryKey: ['box0-actions'] }), queries.invalidateQueries({ queryKey: ['core-wallet'] }), queries.invalidateQueries({ queryKey: ['core-box'] })]);
  const begin = (next: () => void) => {
    setMessage(null);
    if (!connected) setDialog(true);
    else next();
  };
  const startDraw = () => begin(() => void run(async (io, me) => setPending({ kind: 'draw', plan: await prepareDraw(roles, me, io) })));
  const startTake = (itemId: bigint, poolIndex: bigint) => begin(() => void run(async (io, me) => setPending({ kind: 'take', plan: await prepareTake(roles, me, io), itemId, poolIndex })));
  const confirm = () =>
    void run(async (io, me) => {
      if (!pending) return;
      if (pending.kind === 'draw') {
        if (pending.plan.needsApproval) {
          await sendBox0(roles, me, { kind: 'approve-fit', amount: pending.plan.limit }, io);
          setPending({ kind: 'draw', plan: await prepareDraw(roles, me, io) });
          setMessage('FIT approved. Now confirm the draw.');
          return;
        }
        let sent: Awaited<ReturnType<typeof sendBox0>>;
        try {
          // SH-BOX0-DRAW-VALUE: exactly the ETH this confirmation showed.
          sent = await sendBox0(roles, me, { kind: 'draw', limit: pending.plan.limit, value: pending.plan.value }, io);
        } catch (error) {
          if (!(error instanceof DrawValueRoseError)) throw error;
          // Nothing was sent: the new amount is shown and needs its own Confirm draw. Should reading it fail, the old
          // confirmation is already gone.
          setPending(null);
          setPending({ kind: 'draw', plan: await prepareDraw(roles, me, io) });
          setMessage(error.message);
          return;
        }
        if (sent.ticketId !== undefined) setSession((s) => [...s, sent.ticketId as bigint]);
        setMessage('Drawn · waiting for its number');
      } else if (pending.kind === 'take') {
        if (pending.plan.needsApproval) {
          await sendBox0(roles, me, { kind: 'approve-fit', amount: pending.plan.limit }, io);
          setPending({ ...pending, plan: await prepareTake(roles, me, io) });
          setMessage('FIT approved. Now confirm the take.');
          return;
        }
        await sendBox0(roles, me, { kind: 'take', itemId: pending.itemId, poolIndex: pending.poolIndex, limit: pending.plan.limit }, io);
        setMessage(`Taken · ${noun} ${pending.itemId}`);
      } else if (pending.kind === 'claim') {
        await sendBox0(roles, me, { kind: 'claim', ids: pending.ids }, io);
        setMessage('Claimed');
      } else {
        await sendBox0(roles, me, stepOf(pending.action), io);
        setMessage('Confirmed. Reading the box…');
      }
      setPending(null);
      await refresh();
    });

  return (
    <section className="sh-panel sh-box0-actions" aria-label="Draw and claim">
      {wrong ? <p>Connect a browser wallet on this box’s network.</p> : null}
      {offer ? (
        <button ref={ref} type="button" className="sh-button sh-button--primary" disabled={off} onClick={startDraw}>
          {`Draw one · ${formatToken(roundUpFit(offer.quote), ticker)}`}
        </button>
      ) : null}
      {take?.kind === 'take' ? (
        <button ref={ref} type="button" className="sh-button sh-button--primary" disabled={off} onClick={() => startTake(take.itemId, take.poolIndex)}>
          {`Take one · ${formatToken(roundUpFit(take.quote), ticker)}`}
        </button>
      ) : null}
      {take?.kind === 'wait' ? <p>{`Take one · in ${take.days} d`}</p> : null}
      {rows.length > 0 ? (
        <ul className="sh-box0-actions__rows">
          {rows.map((row) => (
            <li key={row.key}>
              <span>{row.text}</span>
              {row.action ? (
                <button type="button" className="sh-button" disabled={off} onClick={() => begin(() => setPending({ kind: 'row', action: row.action as Box0Action }))}>
                  {buttonOf(row.action, ticker)}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {claim ? (
        <p className="sh-box0-actions__claim">
          <span>{`Claimable · ${formatToken(claim.amount, ticker)}`}</span>
          <button type="button" className="sh-button" disabled={off} onClick={() => begin(() => setPending({ kind: 'claim', ids: claim.ids, amount: claim.amount }))}>
            Claim
          </button>
        </p>
      ) : null}
      {pending ? (
        <div role="group" aria-label="Confirm transaction">
          {pending.kind === 'draw' ? (
            <>
              <p>{`Up to ${formatToken(roundUpFit(pending.plan.limit), ticker)}`}</p>
              {/* SH-BOX0-DRAW-VALUE fix round 1 (F2): a wallet that refuses ETH leaves it all in the round's pot
                  (DrandWords.payRound). */}
              <p>{`+ up to ${ethUp(pending.plan.value)} for the random number, the unused part comes back if your wallet accepts ETH`}</p>
              {pending.plan.short ? <p>{`Not enough ${ticker}`}</p> : null}
            </>
          ) : pending.kind === 'take' ? (
            <>
              <p>{`Up to ${formatToken(roundUpFit(pending.plan.limit), ticker)}`}</p>
              <p>{`${noun} ${pending.itemId} · its picture comes later`}</p>
              {pending.plan.short ? <p>{`Not enough ${ticker}`}</p> : null}
            </>
          ) : (
            <p>
              {pending.kind === 'claim' ? `Send ${formatToken(pending.amount, ticker)} to your wallet?` : questionOf(pending.action, ticker)}
            </p>
          )}
          <button type="button" className="sh-button sh-button--primary" disabled={off || wrong || ((pending.kind === 'draw' || pending.kind === 'take') && pending.plan.short)} onClick={confirm}>
            {busy ? 'Waiting for confirmation…' : pending.kind === 'draw' || pending.kind === 'take' ? (pending.plan.needsApproval ? `Approve ${ticker}` : pending.kind === 'draw' ? 'Confirm draw' : 'Confirm take') : 'Confirm'}
          </button>
          <button type="button" className="sh-button" disabled={busy} onClick={() => setPending(null)}>
            Cancel
          </button>
        </div>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      <BrowserWalletDialog open={dialog && wallet.defaultDialog === 'browser'} onClose={() => setDialog(false)} returnFocus={ref} />
      {DEMO_BUILD ? <DemoWalletDialog open={dialog && wallet.defaultDialog === 'demo'} onClose={() => setDialog(false)} returnFocus={ref} /> : null}
    </section>
  );
}
