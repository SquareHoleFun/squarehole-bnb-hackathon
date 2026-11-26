/**
 * SH-EXISTING-NFTS-E08C: the set Create's runner on a real build (set-send.ts). Reads go to the source's RPC; the only
 * wallet requests are E-08B's sender's (`setSubmit`), each after the creator's Create, Continue or Revoke press. A run
 * of this tab (set-send-store.ts) is shown again after a reload, from the chain's state, before anything is sent.
 * Leaving Create stops the run (the step in flight finishes, its hash kept); the next step waits for Continue.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Address } from 'viem';
import type { SetSpecV2 } from '@squarehole/box-spec';
import { InsufficientGasFundsError, NotSendableError, WalletContextChangedError, WalletRejectedError, WalletRequestError, isWriteChainId, writeChain } from '@squarehole/chain/write';
import { gasFundsLine } from '../../tx/gas-words';
import type { Eip1193Request } from '@squarehole/chain/write/wallet';
import { liveChainLabel } from '../../wallet';
import type { SetSource } from '../../set/set-build';
import { SET_TX_GAS_CAP, SetCallError, setSubmit, type SetSubmit } from '../../set/set-calls';
import { SetActionError, sendRevoke } from '../../set/set-actions';
import { SetIdentityError } from '../../set/set-identity';
import { rpcSetReads, same, type SetReads } from '../../set/set-reads';
import {
  SetCreateRefusal, boxOfRun, prepareSetCreate, readSetProgress, runSetCreate, sameSetRun, specOfRun,
  type SetCoinLabel, type SetCreateChain, type SetProgress, type SetRun, type SetStepKind,
} from './set-send';
import { clearSetRun, loadSetRun, saveSetRun } from './set-send-store';

export type SetCreateView =
  | { readonly phase: 'idle' }
  | { readonly phase: 'preparing' }
  | { readonly phase: 'running'; readonly progress: SetProgress; readonly sending: SetStepKind | null; readonly stopping: boolean }
  | { readonly phase: 'stopped'; readonly progress: SetProgress }
  | { readonly phase: 'failed'; readonly progress: SetProgress | null; readonly message: string }
  | { readonly phase: 'done'; readonly progress: SetProgress; readonly box: string }
  /** The raise failed while loading: the box page sends the loaded items back to the creator. */
  | { readonly phase: 'closed'; readonly progress: SetProgress; readonly box: string };

/** The add-on release a source creates with. */
export function createChainOf(source: SetSource): SetCreateChain {
  const { release } = source;
  return { chainId: release.chainId, factory: release.factory.address, registry: release.registry.address, listingRegistry: release.listingRegistry.address,
    maxTxGas: isWriteChainId(release.chainId) ? writeChain(release.chainId).maxTxGas : SET_TX_GAS_CAP };
}

/** A plain sentence for what stopped the run (never the wallet's or the RPC's own text). */
export function setFailureText(error: unknown, chainId: number): string {
  if (error instanceof WalletRejectedError) return 'Declined in the wallet.';
  if (error instanceof WalletContextChangedError) return error.change === 'chain' ? `Switch the wallet to ${liveChainLabel(chainId)}.` : 'The wallet account changed. Connect it again.';
  if (error instanceof SetCreateRefusal || error instanceof SetActionError || error instanceof SetIdentityError) return error.message;
  if (error instanceof SetCallError || error instanceof NotSendableError) return 'This step is not one of this box’s. Nothing was sent.';
  if (error instanceof InsufficientGasFundsError) return gasFundsLine(error.chainId);
  if (error instanceof WalletRequestError) return 'The wallet did not send this step.';
  return 'The chain could not be read. Try again.';
}

export interface SetCreateInput {
  readonly source: SetSource | null;
  /** The draft's spec and ids; null while the draft is not complete. */
  readonly spec: SetSpecV2 | null;
  readonly ids: readonly bigint[] | null;
  readonly owner: Address | null;
  readonly wallet: Eip1193Request | null;
  readonly coin: SetCoinLabel;
  /** Tests pass an in-memory chain and sender; the page uses the source's RPC and E-08B's sender. */
  readonly reads?: SetReads;
  readonly submit?: SetSubmit | null;
}

/** The tab's one runner: a Create opened while another still runs shows nothing new until it has ended. */
let active: { readonly ended: Promise<void> } | null = null;

export function useSetCreate({ source, spec, ids, owner, wallet, coin, reads: givenReads, submit: givenSubmit }: SetCreateInput) {
  const chain = useMemo(() => (source ? createChainOf(source) : null), [source]);
  const reads = useMemo(() => (source ? givenReads ?? rpcSetReads(source.rpc) : null), [source, givenReads]);
  const submit = givenSubmit === undefined ? setSubmit() : givenSubmit;
  const [view, setView] = useState<SetCreateView>({ phase: 'idle' });
  const [run, setRun] = useState<SetRun | null>(null);
  const [revoking, setRevoking] = useState<{ readonly state: 'sending' | 'done' } | { readonly state: 'failed'; readonly message: string } | null>(null);
  const control = useRef<{ stopped: boolean } | null>(null);
  const busy = useRef(false);
  const live = useRef(true);
  const coinRef = useRef(coin);
  useEffect(() => { coinRef.current = coin; }, [coin]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (control.current) control.current.stopped = true;
    };
  }, []);

  const endView = (progress: SetProgress, r: SetRun): SetCreateView =>
    progress.failed ? { phase: 'closed', progress, box: boxOfRun(r) } : progress.next === null ? { phase: 'done', progress, box: boxOfRun(r) } : { phase: 'stopped', progress };

  // A run of this tab, for this creator and chain, is shown from the chain before anything is sent. One that sent
  // nothing and is not this draft's is forgotten; one that sent a step is kept, whatever the page's choices now are.
  useEffect(() => {
    if (!reads || !source || !chain || !owner || busy.current) return;
    let current = true;
    void (async () => {
      if (active) await active.ended;
      if (!current) return;
      const stored = loadSetRun();
      if (!stored || stored.chainId !== chain.chainId || !same(stored.creator, owner)) { setRun(null); setView({ phase: 'idle' }); return; }
      // A run another release prepared (the manifest changed on this chain) is not resumed: it is refused once, shown
      // as such, and nothing of it is sent; Start over forgets it.
      if (!same(stored.factory, chain.factory)) { setRun(null); setView({ phase: 'failed', progress: null, message: 'The factory is not this release’s.' }); return; }
      try {
        const created = await reads.code(stored.coordinator) !== '0x';
        if (!current) return;
        const mine = spec !== null && ids !== null && sameSetRun(stored, chain, owner, spec, ids);
        if (!created && Object.keys(stored.sent).length === 0 && !mine) { clearSetRun(); setRun(null); setView({ phase: 'idle' }); return; }
        const progress = await readSetProgress(reads, source, stored, coinRef.current);
        if (!current) return;
        setRun(stored);
        setView(created || Object.keys(stored.sent).length > 0 ? endView(progress, stored) : { phase: 'idle' });
      } catch (error) {
        if (current) setView({ phase: 'failed', progress: null, message: setFailureText(error, chain.chainId) });
      }
    })();
    return () => { current = false; };
    // The draft only decides whether an uncreated stored run is still this draft's (checked once per creator).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reads, source, chain, owner]);

  const shown = 'progress' in view ? view.progress : null;
  const resumes = run !== null && owner !== null && chain !== null && (shown?.created === true || Object.keys(run.sent).length > 0 || (spec !== null && ids !== null && sameSetRun(run, chain, owner, spec, ids)));

  const start = useCallback(async () => {
    if (busy.current || active || !reads || !source || !chain || !owner || !wallet) return;
    if (!submit) { setView({ phase: 'failed', progress: shown, message: 'Sending is not available in this build.' }); return; }
    busy.current = true;
    const mine = { stopped: false };
    control.current = mine;
    let settle!: () => void;
    const entry = { ended: new Promise<void>((resolve) => { settle = resolve; }) };
    active = entry;
    let progress: SetProgress | null = null;
    try {
      let current = resumes ? run : null;
      if (!current) {
        if (!spec || !ids) return;
        setView({ phase: 'preparing' });
        current = await prepareSetCreate(reads, chain, spec, ids, owner);
        saveSetRun(current);
        setRun(current);
      }
      const ended = await runSetCreate(current, {
        reads, source, chain, coin: coinRef.current, submit, wallet,
        onRun: (next) => { current = next; saveSetRun(next); if (live.current) setRun(next); },
        onProgress: (next, sending) => { progress = next; if (live.current) setView({ phase: 'running', progress: next, sending, stopping: mine.stopped }); },
        stopped: () => mine.stopped,
      });
      const last = current;
      if (live.current && progress && last) setView(ended === 'stopped' ? { phase: 'stopped', progress } : endView(progress, last));
    } catch (error) {
      if (!(error instanceof SetCreateRefusal || error instanceof WalletRejectedError || error instanceof WalletContextChangedError)) console.error('Create set: a step stopped', error);
      if (live.current) setView({ phase: 'failed', progress, message: setFailureText(error, chain.chainId) });
    } finally {
      busy.current = false;
      if (control.current === mine) control.current = null;
      if (active === entry) active = null;
      settle();
    }
  }, [reads, source, chain, owner, wallet, submit, run, spec, ids, resumes, shown]);

  const stop = useCallback(() => {
    if (control.current) control.current.stopped = true;
    setView((before) => (before.phase === 'running' ? { ...before, stopping: true } : before));
  }, []);

  const forget = useCallback(() => { clearSetRun(); setRun(null); setView({ phase: 'idle' }); setRevoking(null); }, []);

  /** After complete or failure: the creator takes back the vault's loading approval (its own transaction). */
  const revoke = useCallback(async () => {
    if (!reads || !source || !chain || !owner || !wallet || !run || busy.current) return;
    if (!submit) { setRevoking({ state: 'failed', message: 'Sending is not available in this build.' }); return; }
    busy.current = true;
    setRevoking({ state: 'sending' });
    try {
      await sendRevoke({ reads, submit, wallet }, { source, coordinator: run.coordinator, encodedSpec: run.encoded, account: owner });
      // The mined approval is undone: a later Continue asks for a new one instead of waiting on the old hash.
      const next: SetRun = { ...run, sent: Object.fromEntries(Object.entries(run.sent).filter(([key]) => key !== 'approveAll')) };
      saveSetRun(next);
      const progress = await readSetProgress(reads, source, next, coinRef.current);
      if (live.current) { setRun(next); setRevoking({ state: 'done' }); setView(endView(progress, next)); }
    } catch (error) {
      if (live.current) setRevoking({ state: 'failed', message: setFailureText(error, chain.chainId) });
    } finally {
      busy.current = false;
    }
  }, [reads, source, chain, owner, wallet, run, submit]);

  const runSpec = useMemo(() => (run ? specOfRun(run) : null), [run]);
  /** The stored run's box when it is not the page's draft (after a reload the choices may differ): its ticker. */
  const otherBox = run && runSpec && chain && owner && !(spec && ids && sameSetRun(run, chain, owner, spec, ids)) ? runSpec.tokenSymbol : null;
  return { available: chain !== null && reads !== null, canSend: submit !== null, view, run, runSpec, otherBox, resumes, start, stop, forget, revoke, revoking };
}
