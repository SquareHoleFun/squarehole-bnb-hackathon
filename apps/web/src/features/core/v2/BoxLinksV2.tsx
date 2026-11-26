/**
 * LINKS-WEB (docs/design/box-links-v2.md § 5; F148, F149): one component for a v2 box's creator-signed links, in two
 * places:
 * - the box page (V2BoxPage): the row under the header, and for the connected creator Edit links (Add links when
 *   there are none), the editor and Sign links · free;
 * - after Create (CreateV2Flow's done state, `BoxLinksAfterCreate`): the draft's links read-only, plus Sign links · free.
 *
 * The links show plainly as the creator's own: the whole host, no label or badge (F149). Nothing asks the wallet on
 * navigation: the creator check compares the connected address, already known, with the box's on-chain creator; the
 * one wallet request is the Sign click's `eth_signTypedData_v4` (Switch network first when the wallet is on another
 * chain). The signature stays in this page's memory only; Try again re-sends it without the wallet.
 */
import { InjectedWalletError, signTypedDataV4 } from '@squarehole/chain/write/wallet';
import { sameAddress, type Address } from '@squarehole/domain';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { boxLinksTypedData, type BoxLinks } from '../../../../../../packages/chain/src/core/v2';
import { TextField } from '../../create/create-parts';
import { MESSAGES } from '../../create/reason-copy';
import { useOptionalWallet } from '../../wallet';
import { canonicalLinks, fieldsOf, hasLinks, linkItems, nextIssuedAt, sendableSignature, sendLinks, type LinkKey, type LinksFetch, type PostLimiter, type ShownLinks, type SignedLinks } from './box-links';
import { feedReadsStarted, type V2Source } from './indexer-v2';
import { feedQueryV2 } from './useV2';
import './v2-page.css';

/** Every word this part shows (the founder edits them; docs/evidence/SH-LINKS-WEB.md lists the new ones). */
export const LINKS_WORDS = Object.freeze({
  label: 'Links',
  sign: 'Sign links · free',
  edit: 'Edit links',
  add: 'Add links',
  signAgain: 'Sign again',
  tryAgain: 'Try again',
  cancel: 'Cancel',
  switchNetwork: 'Switch network',
  confirm: 'Confirm in your wallet',
  sending: 'Sending…',
  saved: 'Saved',
  stopped: 'Not sent yet.',
  conflict: 'Newer links are already saved.',
  notCreator: 'Not signed by the box’s creator.',
  refused: 'Our server refused these links.',
  declined: 'Declined in the wallet.',
  pending: 'The wallet already has a request open; finish or close it in the wallet first.',
  noSignature: 'The wallet did not sign.',
  website: 'Website',
  x: 'X',
  telegram: 'Telegram',
});

/** The editor's field messages: the Create page's own for the same three fields. */
const FIELD_MESSAGE: Readonly<Record<LinkKey, string>> = Object.freeze({ website: MESSAGES.httpsLink, x: MESSAGES.xLink, telegram: MESSAGES.telegramLink });
const FIELDS: readonly { readonly key: LinkKey; readonly placeholder: string }[] = [
  { key: 'website', placeholder: 'https://' },
  { key: 'x', placeholder: '@handle' },
  { key: 'telegram', placeholder: 'https://t.me/' },
];
const REL = 'noopener noreferrer nofollow ugc';

/** The row: `junkyard.fun · @junkyard · t.me/junkyard`, each a plain link to the creator's own target, in full. */
export function LinksRow({ links }: { readonly links: BoxLinks }) {
  const items = linkItems(links);
  if (items.length === 0) return null;
  return (
    <p className="sh-v2-links" data-box-links="">
      {items.map((item, index) => (
        <Fragment key={item.key}>
          {index > 0 ? <span className="sh-v2-links__dot" aria-hidden="true"> · </span> : null}
          <a href={item.href} title={item.href} target="_blank" rel={REL} referrerPolicy="no-referrer" data-link={item.key}>{item.text}</a>
        </Fragment>
      ))}
    </p>
  );
}

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'signing' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'refused'; readonly status: 400 | 403 }
  | { readonly kind: 'wallet'; readonly message: string };

function walletText(error: unknown): string {
  if (error instanceof InjectedWalletError && error.code === 'rejected') return LINKS_WORDS.declined;
  if (error instanceof InjectedWalletError && error.code === 'pending_request') return LINKS_WORDS.pending;
  return LINKS_WORDS.noSignature;
}

const newest = (...times: readonly (bigint | null | undefined)[]): bigint | null =>
  times.reduce<bigint | null>((best, time) => (time === null || time === undefined ? best : best === null || time > best ? time : best), null);

/**
 * This page's newest save, from the POST's answer: its links (null: a removal), its time, and `after`, how many feed
 * reads had started when the POST completed (`feedReadsStarted`): a read numbered higher started after it.
 */
interface LocalSave {
  readonly links: ShownLinks | null;
  readonly issuedAt: bigint;
  readonly after: number;
}

/**
 * Fix rounds 1 and 2 (F3, F4): whether the feed has caught up with this page's save, so the feed is shown again: a
 * feed record at least as new (the save, or a newer one), or the answer of a read that started after the POST completed
 * (the server sent the 200 after the save, so that read holds it, and whatever it shows is the truth: a removal
 * elsewhere too). Never the chain block: the save's head is read before the server checks the signature and writes, so
 * a higher block can predate the save. Older reads, in flight or cached, are ignored.
 */
function feedCaughtUp(local: LocalSave, links: ShownLinks | null, feedRead: number | null): boolean {
  if (links !== null && links.issuedAt >= local.issuedAt) return true;
  return feedRead !== null && feedRead > local.after;
}

export interface BoxLinksV2Props {
  readonly source: Pick<V2Source, 'origin' | 'manifest'>;
  readonly token: Address;
  /** The box's on-chain creator (its registry record): the only address whose signature the server keeps. */
  readonly creator: Address;
  /** Whether the box is in the feed the page polls; the POST waits for it. */
  readonly inFeed: boolean;
  /** The links the feed shows for the box now (null: none). */
  readonly links: ShownLinks | null;
  /** The feed's asOf.timestamp (chain time); null until the feed has answered. */
  readonly asOf: bigint | null;
  /**
   * Which feed read `links` came from (`readFeedV2`, numbered in the order reads start); null when unknown. Only a read
   * that started after a save's POST completed takes over from that save (or a record at least as new).
   */
  readonly feedRead?: number | null;
  /** After Create: the draft's links in canonical form, shown read-only and signed as they are. Absent on the box page. */
  readonly draft?: BoxLinks;
  /** Test seams: the POST, and the tab's limit of 10 a minute. */
  readonly post?: LinksFetch;
  readonly limiter?: PostLimiter;
}

export function BoxLinksV2({ source, token, creator, inFeed, links, asOf, feedRead = null, draft, post, limiter }: BoxLinksV2Props) {
  const wallet = useOptionalWallet();
  const queries = useQueryClient();
  const fieldId = useId();
  const chainId = source.manifest.chainId;
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  /** This page's newest save (null links: a removal), shown at once from the POST's answer until the feed catches up. */
  const [local, setLocal] = useState<LocalSave | null>(null);
  /** The newest time this page saved links at, kept after the feed takes over again: the next signature comes after it. */
  const [lastSaved, setLastSaved] = useState<bigint | null>(null);
  /** The time a 409 named: Sign again signs after it. */
  const [conflictAt, setConflictAt] = useState<bigint | null>(null);
  const [editing, setEditing] = useState(false);
  const [fields, setFields] = useState<BoxLinks>(fieldsOf(null));
  const [checked, setChecked] = useState(false);
  /** The signature of the last Sign press, kept in memory for Try again (never stored on the device). */
  const [kept, setKept] = useState<SignedLinks | null>(null);
  const run = useRef<AbortController | null>(null);
  // Bumped by Cancel, a new Sign and leaving: a wallet answer or POST result of an earlier press is dropped.
  const press = useRef(0);
  const inFeedNow = useRef(inFeed);
  useEffect(() => { inFeedNow.current = inFeed; }, [inFeed]);
  useEffect(() => () => { press.current += 1; run.current?.abort(); }, []);

  const account = wallet?.status === 'connected' ? wallet.account : null;
  const signer = wallet?.signer ?? null;
  const isCreator = account !== null && signer !== null && sameAddress(account, creator);
  const wrongChain = isCreator && wallet?.chainId !== chainId;
  // Once the feed has caught up, the page's own save gives way for good (React's "adjust state while rendering"): a
  // later null from the feed (links removed in another tab, or through the API) then removes the row.
  if (local !== null && feedCaughtUp(local, links, feedRead)) setLocal(null);
  const shown = local !== null ? local.links : links;
  const savedAt = newest(links?.issuedAt, lastSaved, conflictAt);
  const busy = phase.kind === 'signing' || phase.kind === 'sending';
  const done = draft !== undefined;
  // After Create: already saved when the feed (or this page's save) shows exactly these links.
  const draftSaved = done && shown !== null && shown.website === draft.website && shown.x === draft.x && shown.telegram === draft.telegram;

  const send = async (next: SignedLinks, at: number) => {
    run.current?.abort();
    const controller = new AbortController();
    run.current = controller;
    setPhase({ kind: 'sending' });
    const outcome = await sendLinks({ source, token, signed: next, inFeed: () => inFeedNow.current, signal: controller.signal, fetch: post, limiter });
    if (press.current !== at || run.current !== controller) return;
    run.current = null;
    if (outcome.kind === 'saved') {
      const issuedAt = newest(outcome.links?.issuedAt, next.issuedAt) ?? next.issuedAt;
      setLocal({ links: outcome.links, issuedAt, after: feedReadsStarted() });
      setLastSaved((before) => newest(before, issuedAt));
      // A read that starts now holds the save: ask for one (the feed's reads in flight give way) rather than wait.
      void queries.invalidateQueries({ queryKey: ['v2-feed'] });
      setKept(null);
      setPhase({ kind: 'saved' });
      setEditing(false);
    } else if (outcome.kind === 'conflict') {
      setConflictAt(outcome.savedIssuedAt ?? next.issuedAt);
      setKept(null);
      setPhase({ kind: 'conflict' });
    } else if (outcome.kind === 'refused') {
      setKept(null);
      setPhase({ kind: 'refused', status: outcome.status });
    } else if (outcome.kind === 'stopped') {
      setPhase({ kind: 'stopped' });
    }
  };

  /** The Sign click: one `eth_signTypedData_v4` for these links at max(asOf, saved + 1), then the POST. */
  const sign = async (next: BoxLinks) => {
    if (!isCreator || signer === null || account === null || asOf === null || busy) return;
    const at = ++press.current;
    run.current?.abort();
    const issuedAt = nextIssuedAt(asOf, savedAt);
    setPhase({ kind: 'signing' });
    let signature: `0x${string}`;
    try {
      signature = await signTypedDataV4(signer.request, account, boxLinksTypedData(chainId, token, next, issuedAt));
    } catch (error) {
      if (press.current === at) setPhase({ kind: 'wallet', message: walletText(error) });
      return;
    }
    if (press.current !== at) return;
    if (!sendableSignature(signature)) { setPhase({ kind: 'wallet', message: LINKS_WORDS.noSignature }); return; }
    const made: SignedLinks = { links: next, issuedAt, signature };
    setKept(made);
    await send(made, at);
  };

  /** Try again: the same signature, no wallet request. */
  const again = () => {
    if (kept === null || busy) return;
    void send(kept, ++press.current);
  };

  const switchNetwork = () => { void wallet?.switchChain(chainId).catch(() => undefined); };

  const signDraft = () => { if (draft) void sign(draft); };
  const edited = canonicalLinks(fields);
  const fieldError = (key: LinkKey) => (checked && edited.refused.includes(key) ? FIELD_MESSAGE[key] : null);
  const signEdited = () => {
    setChecked(true);
    if (edited.refused.length === 0) void sign(edited.links);
  };

  /** The one primary action, by where the signing stands: Switch network, Try again, Sign again or Sign links · free. */
  const action: 'switch' | 'again' | 'resign' | 'sign' = wrongChain ? 'switch' : phase.kind === 'stopped' && kept !== null ? 'again' : phase.kind === 'conflict' ? 'resign' : 'sign';
  const actionLabel = { switch: LINKS_WORDS.switchNetwork, again: LINKS_WORDS.tryAgain, resign: LINKS_WORDS.signAgain, sign: LINKS_WORDS.sign }[action];
  const actionOff = action === 'sign' && (busy || asOf === null);
  const statusText = phase.kind === 'signing' ? LINKS_WORDS.confirm : phase.kind === 'sending' ? LINKS_WORDS.sending : phase.kind === 'stopped' ? LINKS_WORDS.stopped
    : phase.kind === 'conflict' ? LINKS_WORDS.conflict : null;
  const alertText = phase.kind === 'refused' ? (phase.status === 403 ? LINKS_WORDS.notCreator : LINKS_WORDS.refused) : phase.kind === 'wallet' ? phase.message : null;
  const lines = <>
    {statusText ? <p className="sh-newbox-note" role="status" data-links-status={phase.kind}>{statusText}</p> : null}
    {alertText ? <p className="sh-newbox-error" role="alert" data-links-error={phase.kind}><span aria-hidden="true">!</span> {alertText}</p> : null}
  </>;

  if (done) {
    if (!hasLinks(draft) || !isCreator) return null;
    return (
      <section className="sh-panel sh-v2-links-card" aria-label={LINKS_WORDS.label} data-links-card="">
        <LinksRow links={draft} />
        {draftSaved || phase.kind === 'saved'
          ? <p className="sh-newbox-note" role="status" data-links-status="saved">{LINKS_WORDS.saved}</p>
          : <><div className="sh-v2-links-actions">
            <button type="button" className="sh-button sh-button--primary" disabled={actionOff} onClick={action === 'switch' ? switchNetwork : action === 'again' ? again : signDraft}>{actionLabel}</button>
          </div>{lines}</>}
      </section>
    );
  }

  const open = () => {
    setFields(fieldsOf(shown));
    setChecked(false);
    setKept(null);
    setPhase({ kind: 'idle' });
    setEditing(true);
  };
  const cancel = () => {
    press.current += 1;
    run.current?.abort();
    run.current = null;
    setKept(null);
    setPhase({ kind: 'idle' });
    setEditing(false);
  };
  const type = (key: LinkKey, value: string) => {
    setFields((before) => ({ ...before, [key]: value }));
    // Other links than the ones signed: the kept signature no longer covers them.
    if (!busy && phase.kind !== 'idle') { setKept(null); setPhase({ kind: 'idle' }); }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); if (!wrongChain && phase.kind !== 'stopped') signEdited(); };

  if (shown === null && !isCreator) return null;
  return (
    <>
      <div className="sh-v2-links-bar">
        {shown ? <LinksRow links={shown} /> : null}
        {isCreator && !editing ? <button type="button" className="sh-button" onClick={open}>{shown ? LINKS_WORDS.edit : LINKS_WORDS.add}</button> : null}
      </div>
      {isCreator && editing ? (
        <form className="sh-panel sh-v2-links-edit" aria-label={LINKS_WORDS.label} noValidate onSubmit={submit} data-links-editor="">
          <fieldset disabled={busy}>
            {FIELDS.map((field) => (
              <TextField key={field.key} id={`${fieldId}-${field.key}`} label={LINKS_WORDS[field.key]} value={fields[field.key]} placeholder={field.placeholder} spellCheck={false}
                onChange={(value) => type(field.key, value)} error={fieldError(field.key)} />
            ))}
          </fieldset>
          <div className="sh-v2-links-actions">
            <button type="button" className="sh-button sh-button--primary" disabled={actionOff} onClick={action === 'switch' ? switchNetwork : action === 'again' ? again : signEdited}>{actionLabel}</button>
            <button type="button" className="sh-button" onClick={cancel}>{LINKS_WORDS.cancel}</button>
          </div>
          {lines}
        </form>
      ) : null}
    </>
  );
}

export interface BoxLinksAfterCreateProps {
  readonly source: V2Source;
  readonly token: Address;
  readonly creator: Address;
  /** The Create draft's links as typed (TA-27 keeps them; empty after Load settings unless typed). */
  readonly draft: BoxLinks;
  readonly post?: LinksFetch;
  readonly limiter?: PostLimiter;
}

/**
 * After Create: the card under "Open your box" when the draft has links the canonicalizer keeps (a refused one is left
 * out; it can be added on the box page). It reads the feed the box page reads (the same query): the POST waits for the
 * box to appear in it, and `issuedAt` comes from its asOf.
 */
export function BoxLinksAfterCreate({ source, token, creator, draft, post, limiter }: BoxLinksAfterCreateProps) {
  const links = useMemo(() => canonicalLinks(draft).links, [draft]);
  const wanted = hasLinks(links);
  // The box page's feed query itself (useV2.ts): the same key, read, deadline and retry.
  const feed = useQuery({ ...feedQueryV2(source), enabled: wanted });
  if (!wanted) return null;
  const snapshots = feed.data?.snapshots ?? [];
  const view = snapshots.find((snapshot) => sameAddress(snapshot.token, token)) ?? null;
  // Every card of one feed answer carries the feed's asOf; before the box is listed, any card's is the feed's.
  const asOf = view?.timestamp ?? snapshots[0]?.timestamp ?? null;
  return <BoxLinksV2 source={source} token={token} creator={creator} inFeed={view !== null} links={view?.links ?? null} asOf={asOf} feedRead={feed.data?.read ?? null} draft={links} post={post} limiter={limiter} />;
}
