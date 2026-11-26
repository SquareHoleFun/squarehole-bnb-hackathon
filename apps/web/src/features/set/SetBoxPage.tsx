/**
 * `/box/:chain/:address` for a box of the existing-NFTs add-on (SH-EXISTING-NFTS-E08C), numbers first. Its five states:
 * loading (k of N loaded), open (trading, conversion waits for graduation), graduated (named picks and returns),
 * failed, and failed with some items back with the creator.
 *
 * The actions are exactly the add-on's: named picks (up to 32 a transaction, priced at one block with a 1% limit and a
 * 20-minute deadline), returns (up to 16, each item approved to the vault on its own), and after a failed raise the
 * items going back to the creator (up to 32 at a time, anyone may send them) and the coordinator's close and claim.
 * There is nothing to draw, reveal or collect here; items are shown by id and collection, their pictures read
 * defensively from outside metadata that can change. Opening the page asks the wallet nothing.
 */
import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { Address } from 'viem';
import { SET_PICK_BATCH, SET_RELEASE_BATCH, SET_RETURN_BATCH } from '@squarehole/box-spec';
import { formatTokenAmount, formatUnits } from '@squarehole/domain';
import { PAGE_TITLE_ID, PageHeading, usePageTitle } from '../../pages/page-parts';
import type { BoxRecord } from '../boxes/box-model';
import { Bar, BoxCover } from '../boxes/BoxParts';
import { formatCount } from '../fit-pair/fit-format';
import { DisclosureIcon } from '../fit-pair/FitParts';
import { BrowserWalletDialog, useWallet } from '../wallet';
import { amountText } from '../create/v2/listings';
import { closeOf, graduatable, sendClaim, sendClose, sendGraduate, sendPick, sendRelease, sendReturn, sendRevoke, type SetActionContext, type SetActionIO, type SetActionStep } from './set-actions';
import { allMembers } from './set-indexer';
import { ERC721_ABI } from './set-calls';
import { readSetIdentity } from './set-identity';
import { bpsOf, countsOf, memberRows, ofCount, percentOfBps, phaseLine, raiseText, recoveryOf, type SetMemberRow, type SetPhase } from './set-model';
import { useItemOwner } from './set-owners';
import { amountOf, prepareConversion, quoteErrorText } from './set-conversion';
import { same } from './set-reads';
import { SetItemPicture } from './SetItemPicture';
import { useSetBox, type SetBoxSeams, type SetRecordData } from './useSetBox';
import { useSetRun, type SetRunStatus } from './useSetRun';
import { VirtualList } from './VirtualList';
import './set-page.css';

/** A members row is this tall; the list shows about seven at once. */
const ROW_PX = 52;
const LIST_PX = 364;
const DECIMALS = 18;

export interface SetBoxPageProps {
  readonly record: BoxRecord;
  /** Test seams: the chain's reads, the indexer and E-08B's sender. */
  readonly seams?: SetBoxSeams;
}

export function SetBoxPage({ record, seams }: SetBoxPageProps) {
  usePageTitle(`${record.ticker} · ${record.name}`);
  const set = record.set;
  if (!set) return <section className="sh-page"><PageHeading>{record.name}</PageHeading><p role="status">Unavailable</p></section>;
  return <SetBoxView record={record} set={set} seams={seams ?? {}} />;
}

type Data = ReturnType<typeof useSetBox>;

function SetBoxView({ record, set, seams }: { record: BoxRecord; set: SetRecordData; seams: SetBoxSeams }) {
  const data = useSetBox(set, seams);
  const { box, phase, coin, facts, ones } = data;
  const counts = countsOf(box);
  // Headline figures: grouped, at most 4 decimals, truncated (never more than the chain says); quotes stay exact.
  const t = (raw: bigint) => `${formatTokenAmount(raw, DECIMALS, { maxFractionDigits: 4 })} ${record.ticker}`;
  const raise = raiseText(box, coin);
  const pct = percentOfBps(box.spec.pickFeeBps);
  const figures: readonly (readonly [string, string])[] =
    phase === 'pending' ? [['Loaded', ofCount(counts.loaded, counts.count)], ['Raise', raise ?? 'Unavailable'], ['Pick fee', pct]]
      : phase === 'open' ? [['Items', formatCount(counts.count)], ['Raise', raise ?? 'Unavailable'], ['Pick fee', pct], ['Deadline', `${box.spec.deadlineDays} days`]]
        : phase === 'graduated' ? [['In the box', formatCount(counts.inside)], ['Out', formatCount(counts.outside)], ['Pick one', ones?.pick ? t(amountOf(ones.pick)) : 'Unavailable'], ['One back pays', ones?.back ? t(amountOf(ones.back)) : 'Unavailable']]
          : [['Back', ofCount(counts.released, counts.loaded)], ['Claim pot', facts?.claim && coin ? amountText(facts.claim.pot, coin) : 'Unavailable'], ['Coins left', facts?.claim ? t(facts.claim.tLeft) : 'Unavailable']];
  const bar = phase === 'pending' ? bpsOf(counts.loaded, counts.count) : phase === 'recovering' ? bpsOf(counts.released, counts.loaded) : null;
  const close = facts ? closeOf(facts) : null;
  return (
    <section className="sh-page sh-box-page sh-set-page" aria-labelledby={PAGE_TITLE_ID} data-phase={phase}>
      <p><Link to="/">Back to boxes</Link></p>
      <header className="sh-set-head">
        <BoxCover record={record} slot="square" className="sh-set-head__cover" />
        <div>
          <PageHeading>{record.name}</PageHeading>
          <p className="sh-set-head__line" data-set-state="">{`${record.ticker} · ${phaseLine(box, data.trading)}`}</p>
        </div>
      </header>
      {data.stale ? <p role="status">Stale · reading again</p> : null}
      <dl className="sh-set-figures" aria-label="Numbers">
        {figures.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      {bar !== null ? <Bar bps={bar} /> : null}
      {/* Graduate and Close stay mounted (only shown while possible), above the next phase's panel: a press's last
          line stays where the button was. */}
      <SetGraduate data={data} open={phase === 'open' && facts !== null && graduatable(facts)} />
      <SetClose data={data} open={(phase === 'pending' || phase === 'open') && close !== null} />
      {phase === 'graduated' ? <SetConvert data={data} record={record} /> : null}
      {phase === 'failed' || phase === 'recovering' ? <SetRecovery data={data} record={record} /> : null}
      <SetRevoke data={data} phase={phase} />
      {phase !== 'graduated' ? <SetMembers data={data} /> : null}
      <details className="sh-fit-details">
        <summary><span className="sh-fit-details__chevron" aria-hidden="true"><DisclosureIcon /></span>Contract details</summary>
        <dl className="sh-set-details">
          <div><dt>Collection</dt><dd className="sh-set-code">{box.collection}</dd></div>
          <div><dt>Box token</dt><dd className="sh-set-code">{box.token}</dd></div>
          <div><dt>Vault</dt><dd className="sh-set-code">{box.vault}</dd></div>
          <div><dt>Set hash</dt><dd className="sh-set-code">{box.spec.setHash}</dd></div>
          <div><dt>Creator</dt><dd className="sh-set-code">{box.creator}</dd></div>
        </dl>
        <p>Pictures come from the collection’s own metadata, which its issuer can change.</p>
        <p>{`Read at block ${data.asOf.block}`}</p>
      </details>
    </section>
  );
}

/** The connected wallet as the panels use it: the account, the sender's request, and whether it is on this chain. */
function useActor(data: Data) {
  const wallet = useWallet();
  const account: Address | null = wallet.status === 'connected' ? wallet.account : null;
  const wrong = account !== null && (wallet.chainId !== data.source.chainId || wallet.kind !== 'injected');
  const io = (): SetActionIO | null => (wallet.signer ? { reads: data.reads, submit: data.submit, wallet: wallet.signer.request } : null);
  return { wallet, account, wrong, io };
}

function context(data: Data, account: Address): SetActionContext {
  return { source: data.source, coordinator: data.box.coordinator as Address, encodedSpec: data.box.encodedSpec as `0x${string}`, account };
}

function StatusLine({ status }: { status: SetRunStatus | null }) {
  return status ? <p role="status" data-state={status.state} data-set-status="">{status.text}</p> : null;
}

/** The outside collection the items belong to: their address, beside their ids (no label about it). */
function CollectionLine({ data }: { data: Data }) {
  return <p className="sh-set-collection"><span>Collection</span> <code className="sh-set-code">{data.box.collection}</code></p>;
}

function NoSender({ data }: { data: Data }) {
  return data.submit ? null : <p className="sh-set-note" data-no-sender="">Sending is not available in this build.</p>;
}

/** An item row: its place, its picture, its id and (out of the box) a chip; a button when the item can be chosen. */
function ItemRow({ row, data, account, choosable, chosen, onToggle, mine }: {
  row: SetMemberRow; data: Data; account: Address | null; choosable: boolean; chosen: boolean; onToggle: () => void; mine: boolean;
}) {
  const box = data.box;
  const body = (
    <>
      <span className="sh-set-item__pos">{formatCount(BigInt(row.index + 1))}</span>
      <SetItemPicture reads={data.reads} chainId={data.source.chainId} collection={box.collection as Address} id={row.id} ipfs={data.source.art} />
      <span className="sh-set-item__id">{`#${row.id.toString()}`}</span>
      {row.state !== 'Inside' ? <span className="sh-set-item__chip" data-state={row.state}>{row.state === 'Outside' ? (mine && account ? 'Yours' : 'Out') : row.state === 'Released' ? 'Back' : 'Retry'}</span> : null}
    </>
  );
  if (!choosable) return <span className="sh-set-item">{body}</span>;
  return (
    <button type="button" className="sh-set-item sh-set-item--pick" aria-pressed={chosen} aria-label={`#${row.id.toString()}`} onClick={onToggle}>
      <span className="sh-set-item__check" aria-hidden="true">{chosen ? '✓' : ''}</span>
      {body}
    </button>
  );
}

/** An Outside row in Return: its holder, read lazily, decides whether it is this wallet's. */
function ReturnRow(props: { row: SetMemberRow; data: Data; account: Address | null; chosen: boolean; onToggle: (mine: boolean) => void }) {
  const owner = useItemOwner(props.account ? props.data.reads : null, props.data.source.chainId, props.data.box.collection as Address, props.row.id);
  const mine = props.account !== null && same(owner, props.account);
  return <ItemRow {...props} choosable={mine} mine={mine} onToggle={() => props.onToggle(mine)} />;
}

/** Graduated: choose named items, then Pick (up to 32) or Return (up to 16), priced at one block. */
function SetConvert({ data, record }: { data: Data; record: BoxRecord }) {
  const actor = useActor(data);
  const { account, wallet } = actor;
  const primary = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState<'pick' | 'return'>('pick');
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<readonly bigint[]>([]);
  const [dialog, setDialog] = useState(false);
  const runner = useSetRun(data.refresh);
  const rows = useMemo(() => memberRows(data.members ?? []), [data.members]);
  const wanted = mode === 'pick' ? 'Inside' : 'Outside';
  const digits = query.replace(/[^0-9]/g, '');
  const listed = useMemo(() => rows.filter((row) => row.state === wanted && (digits === '' || row.id.toString().includes(digits))), [rows, wanted, digits]);
  const max = mode === 'pick' ? SET_PICK_BATCH : SET_RETURN_BATCH;
  const t = (raw: bigint) => `${formatUnits(raw, DECIMALS)} ${record.ticker}`;
  // E-08B's preparation of the chosen items (the quote and its limit at one block; who asks does not change it).
  const quote = useQuery({
    queryKey: [...data.base, 'quote', mode, chosen.map(String).join(','), data.asOf.block, data.box.state.inside],
    queryFn: async () => {
      const identity = await readSetIdentity(data.reads, data.source, data.box.coordinator as Address, data.box.encodedSpec as `0x${string}`);
      return { kind: mode, prepared: await prepareConversion(data.reads, identity, (account ?? identity.creator) as Address, mode, chosen) };
    },
    enabled: chosen.length > 0, retry: false,
  });
  const switchMode = (next: 'pick' | 'return') => { setMode(next); setChosen([]); runner.clear(); };
  const toggle = (id: bigint) => setChosen((before) => (before.includes(id) ? before.filter((known) => known !== id) : before.length >= max ? before : [...before, id]));
  const plan = quote.data;
  const line = plan === undefined ? null : `${t(amountOf(plan.prepared))} · ${plan.kind === 'pick' ? 'at most' : 'at least'} ${t(plan.prepared.limit)}`;
  const act = async () => {
    const io = actor.io();
    if (!account || !io) { setDialog(true); return; }
    if (!plan || chosen.length === 0) return;
    const ids = [...chosen];
    const done = await runner.run((onStep) => (plan.kind === 'pick'
      ? sendPick(io, { ...context(data, account), onStep }, ids, plan.prepared.limit)
      : sendReturn(io, { ...context(data, account), onStep }, ids, plan.prepared.limit)), plan.kind === 'pick' ? `Picked ${ids.length}` : `Returned ${ids.length}`);
    if (done) setChosen([]);
  };
  const canSend = data.submit !== null && !actor.wrong && !runner.busy && plan !== undefined && chosen.length > 0;
  return (
    <section className="sh-panel sh-set-convert" aria-label="Pick and return">
      <div className="sh-set-tabs" role="group" aria-label="Action">
        <button type="button" className="sh-button" aria-pressed={mode === 'pick'} onClick={() => switchMode('pick')}>Pick</button>
        <button type="button" className="sh-button" aria-pressed={mode === 'return'} onClick={() => switchMode('return')}>Return</button>
      </div>
      <label className="sh-set-find">
        <span>Find id</span>
        <input className="sh-newbox-input" inputMode="numeric" autoComplete="off" spellCheck={false} value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
      </label>
      <CollectionLine data={data} />
      <p className="sh-set-count" aria-live="polite">{`${formatCount(BigInt(listed.length))} ${mode === 'pick' ? 'in the box' : 'out'} · ${chosen.length}/${max} chosen`}</p>
      {data.members === null ? <p>{data.membersFailed ? 'Items unavailable.' : 'Reading…'}</p> : (
        <VirtualList
          items={listed}
          rowHeight={ROW_PX}
          height={LIST_PX}
          label={mode === 'pick' ? 'Items in the box' : 'Items out of the box'}
          keyOf={(row) => row.id.toString()}
          render={(row) => (mode === 'pick'
            ? <ItemRow row={row} data={data} account={account} choosable chosen={chosen.includes(row.id)} mine={false} onToggle={() => toggle(row.id)} />
            : <ReturnRow row={row} data={data} account={account} chosen={chosen.includes(row.id)} onToggle={(mine) => { if (mine) toggle(row.id); }} />)}
        />
      )}
      {mode === 'return' && !account ? <p className="sh-set-note">Connect a wallet to see yours.</p> : null}
      {chosen.length > 0 ? <p className="sh-set-quote" data-set-quote="">{quote.isError ? quoteErrorText(quote.error) : line ?? 'Reading…'}</p> : null}
      <div className="sh-v2-actions">
        <button ref={primary} type="button" className="sh-button sh-button--primary" disabled={account !== null && !canSend} onClick={() => void act()}>
          {account === null ? 'Connect wallet' : `${mode === 'pick' ? 'Pick' : 'Return'} ${chosen.length}`}
        </button>
        {chosen.length > 0 ? <button type="button" className="sh-button" disabled={runner.busy} onClick={() => setChosen([])}>Clear</button> : null}
      </div>
      <StatusLine status={runner.status} />
      {actor.wrong ? <p className="sh-set-note">Use a browser wallet on this box’s network.</p> : null}
      <NoSender data={data} />
      <details>
        <summary>Pick and return details</summary>
        <p>{`A pick pays each item’s share of the ${record.ticker} in circulation plus the ${percentOfBps(data.box.spec.pickFeeBps)} pick fee, which is burned. A return pays that share less a 5% fee, also burned.`}</p>
        <p>The price may move by at most 1% from the one shown, within 20 minutes, or nothing happens. The last item always stays in the box.</p>
        <p>Each return first lets the vault take that item, one wallet confirmation per item.</p>
      </details>
      <BrowserWalletDialog open={dialog && wallet.defaultDialog === 'browser'} onClose={() => setDialog(false)} returnFocus={primary} />
    </section>
  );
}

/** A failed raise: the loaded items go back to the creator (anyone may send them), and holders claim from the pot. */
function SetRecovery({ data, record }: { data: Data; record: BoxRecord }) {
  const actor = useActor(data);
  const { account, wallet } = actor;
  const primary = useRef<HTMLButtonElement>(null);
  const [dialog, setDialog] = useState(false);
  const [coins, setCoins] = useState('');
  const runner = useSetRun(data.refresh);
  const rows = useMemo(() => memberRows(data.members ?? []), [data.members]);
  // Where the next retry starts: after the last item the previous one sent (this page's own state; a reload starts over).
  const [retryAfter, setRetryAfter] = useState<number | null>(null);
  // Items never sent back first; ones the collection refused before (Deferred) apart, taking turns (set-model.ts).
  const { untried, retry } = useMemo(() => recoveryOf(rows, SET_RELEASE_BATCH, retryAfter), [rows, retryAfter]);
  const lastRetried = useMemo(() => rows.find((row) => row.id === retry.at(-1))?.index ?? null, [rows, retry]);
  const claim = data.facts?.claim ?? null;
  const amount = /^(?:0|[1-9][0-9]{0,30})(?:\.[0-9]{1,18})?$/.test(coins) ? coinsOf(coins) : 0n;
  const creator = account !== null && same(account, data.box.creator);
  const begin = async <T,>(work: (io: SetActionIO, ctx: SetActionContext, onStep: (step: SetActionStep) => void) => Promise<T>, done: string | ((result: T) => string)): Promise<boolean> => {
    const io = actor.io();
    if (!account || !io) { setDialog(true); return false; }
    return runner.run((onStep) => work(io, context(data, account), onStep), done);
  };
  // What went back, as the chain says after the receipt (a refused item stays inside to retry).
  // The members' own record, read again at the press: a released item sent back to the vault since is still Released.
  const members = async () => {
    if (!data.indexer) throw new Error('no indexer');
    return (await allMembers(data.indexer, { token: data.box.token, boxId: data.box.boxId })).members;
  };
  const release = (ids: readonly bigint[]) => begin((io, ctx, onStep) => sendRelease(io, { ...ctx, onStep }, ids, members), (result) => `Sent back ${ofCount(BigInt(result.back), BigInt(result.sent))}`);
  const off = data.submit === null || actor.wrong || runner.busy;
  return (
    <section className="sh-panel sh-set-recovery" aria-label="Back to the creator">
      <h2>Back to the creator</h2>
      <p className="sh-set-count">{`${ofCount(countsOf(data.box).released, countsOf(data.box).loaded)} back`}</p>
      <div className="sh-v2-actions">
        {untried.length > 0 ? (
          <button ref={primary} type="button" className="sh-button sh-button--primary" disabled={account !== null && off} onClick={() => void release(untried)}>
            {`Send back ${untried.length}`}
          </button>
        ) : null}
        {retry.length > 0 ? (
          <button type="button" className="sh-button" disabled={account !== null && off} onClick={() => {
            const after = lastRetried;
            // Once a retry went through (whatever the collection refused again), the next one starts after it.
            void release(retry).then((sent) => { if (sent && after !== null) setRetryAfter(after); });
          }}>
            {`Retry ${retry.length}`}
          </button>
        ) : null}
      </div>
      {claim && claim.tLeft > 0n ? (
        <div className="sh-set-claim">
          <h3>Claim</h3>
          <label className="sh-set-find"><span>{`Your ${record.ticker}`}</span>
            <input className="sh-newbox-input" inputMode="decimal" autoComplete="off" value={coins} onChange={(event) => setCoins(event.currentTarget.value)} />
          </label>
          <button type="button" className="sh-button" disabled={account !== null && (off || amount <= 0n || amount > claim.tLeft)} onClick={() => void begin((io, ctx, onStep) => sendClaim(io, { ...ctx, onStep }, amount), 'Claimed')}>Claim</button>
        </div>
      ) : null}
      {data.facts?.remainder != null && (account === null || creator) ? (
        <button type="button" className="sh-button" disabled={account !== null && off} onClick={() => void begin((io, ctx, onStep) => sendClaim(io, { ...ctx, onStep }, 0n), 'Claimed')}>Claim creator remainder</button>
      ) : null}
      <StatusLine status={runner.status} />
      {actor.wrong ? <p className="sh-set-note">Use a browser wallet on this box’s network.</p> : null}
      <NoSender data={data} />
      <details>
        <summary>Details</summary>
        <p>Every loaded item goes back to the creator’s address, up to 32 a transaction. Anyone may send them. One the collection refuses stays here to try again.</p>
        <p>Each claim hands in coins for their share of the pot, to the claiming wallet.</p>
      </details>
      <BrowserWalletDialog open={dialog && wallet.defaultDialog === 'browser'} onClose={() => setDialog(false)} returnFocus={primary} />
    </section>
  );
}

/** Coins typed as a plain decimal, in raw units of the box token (18 decimals). */
function coinsOf(text: string): bigint {
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * 10n ** BigInt(DECIMALS) + BigInt(fraction.padEnd(DECIMALS, '0') || '0');
}

/**
 * A full raise: anyone may graduate the box (its curve is full, it has neither graduated nor failed). Mounted on every
 * box page, shown only while `open`: once the box is past graduating (graduated by this press, or by someone else just
 * before it) the button goes and the press's last line stays.
 */
function SetGraduate({ data, open }: { data: Data; open: boolean }) {
  const actor = useActor(data);
  const primary = useRef<HTMLButtonElement>(null);
  const [dialog, setDialog] = useState(false);
  const runner = useSetRun(data.refresh);
  if (!open) return <StatusLine status={runner.status} />;
  const act = async () => {
    const io = actor.io();
    if (!actor.account || !io) { setDialog(true); return; }
    await runner.run((onStep) => sendGraduate(io, { ...context(data, actor.account as Address), onStep }), 'Graduated');
  };
  return (
    <section className="sh-panel sh-set-graduate" aria-label="Graduate">
      <div className="sh-v2-actions">
        <button ref={primary} type="button" className="sh-button sh-button--primary" disabled={actor.account !== null && (data.submit === null || actor.wrong || runner.busy)} onClick={() => void act()}>Graduate</button>
      </div>
      <StatusLine status={runner.status} />
      <NoSender data={data} />
      <BrowserWalletDialog open={dialog && actor.wallet.defaultDialog === 'browser'} onClose={() => setDialog(false)} returnFocus={primary} />
    </section>
  );
}

/**
 * A raise that can no longer succeed: anyone may close it now (its deadline, the gate's cap or the graduation hatch).
 * Mounted on every box page, shown only while `open`: once the raise is closed (by this press, or by someone else just
 * before it) the button goes and the press's last line stays.
 */
function SetClose({ data, open }: { data: Data; open: boolean }) {
  const actor = useActor(data);
  const primary = useRef<HTMLButtonElement>(null);
  const [dialog, setDialog] = useState(false);
  const runner = useSetRun(data.refresh);
  if (!open) return <StatusLine status={runner.status} />;
  const act = async () => {
    const io = actor.io();
    if (!actor.account || !io) { setDialog(true); return; }
    await runner.run((onStep) => sendClose(io, { ...context(data, actor.account as Address), onStep }), 'Closed');
  };
  return (
    <section className="sh-panel sh-set-close" aria-label="Close">
      <div className="sh-v2-actions">
        <button ref={primary} type="button" className="sh-button sh-button--primary" disabled={actor.account !== null && (data.submit === null || actor.wrong || runner.busy)} onClick={() => void act()}>Close box</button>
      </div>
      <StatusLine status={runner.status} />
      <NoSender data={data} />
      <BrowserWalletDialog open={dialog && actor.wallet.defaultDialog === 'browser'} onClose={() => setDialog(false)} returnFocus={primary} />
    </section>
  );
}

/** The creator's wallet, after loading: take back the vault's loading approval (only while it is still on). */
function SetRevoke({ data, phase }: { data: Data; phase: SetPhase }) {
  const actor = useActor(data);
  const runner = useSetRun(data.refresh);
  const creator = actor.account !== null && same(actor.account, data.box.creator);
  const over = phase !== 'pending';
  const approved = useQuery({
    queryKey: [...data.base, 'approval', data.box.creator],
    queryFn: () => data.reads.read(data.box.collection as Address, ERC721_ABI, 'isApprovedForAll', [data.box.creator, data.box.vault]),
    enabled: creator && over, retry: false,
  });
  if (!creator || !over || approved.data !== true) return runner.status ? <StatusLine status={runner.status} /> : null;
  const act = async () => {
    const io = actor.io();
    if (!io || !actor.account) return;
    await runner.run((onStep) => sendRevoke(io, { ...context(data, actor.account as Address), onStep }), 'Loading approval revoked');
    void approved.refetch();
  };
  return (
    <section className="sh-panel sh-set-revoke" aria-label="Loading approval">
      <p>Loading approval is still on.</p>
      <button type="button" className="sh-button" disabled={data.submit === null || actor.wrong || runner.busy} onClick={() => void act()}>Revoke loading approval</button>
      <StatusLine status={runner.status} />
    </section>
  );
}

/** Every loaded item and where it is now (no choosing: loading, open and failed boxes). */
function SetMembers({ data }: { data: Data }) {
  const rows = useMemo(() => memberRows(data.members ?? []), [data.members]);
  if (data.box.state.loaded === '0') return null;
  return (
    <section className="sh-panel sh-set-members" aria-label="Items">
      <h2>{`Items · ${formatCount(BigInt(rows.length))}`}</h2>
      <CollectionLine data={data} />
      {data.members === null ? <p>{data.membersFailed ? 'Items unavailable.' : 'Reading…'}</p> : (
        <VirtualList items={rows} rowHeight={ROW_PX} height={LIST_PX} label="Items" keyOf={(row) => row.id.toString()}
          render={(row) => <ItemRow row={row} data={data} account={null} choosable={false} chosen={false} mine={false} onToggle={() => undefined} />} />
      )}
    </section>
  );
}

