import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createWalletClient, custom, numberToHex, type Address, type Hash, type PublicClient, type TransactionReceipt } from 'viem';
import { CHAIN_ID, publicClientFor } from './chain';
import type { AppConfig } from './config';
import { decodeError, PageRefusal, type ContractKind, type DecodedError } from './errors';
import { REFUSALS } from './forms';
import { forgetHead } from './logs';
import { pageLimiter } from './limiter';
import { readSendFees, withFees, type SendFees } from './fees';
import { useWallet, type Eip1193 } from './wallet';
import { erc20Abi } from '../abi/feeRules';

interface AppCtx {
  config: AppConfig;
  client: PublicClient;
  /** Every read reports here, by its own key: the bar says how old the oldest failing read's numbers are. */
  health: ReadHealth;
  /** Grows after every confirmed write and on a timer: reads that depend on it run again. */
  tick: number;
  bump(): void;
  /** The page-wide write lock: at most one write from its press until it settled. */
  lock: WriteLock;
}

/**
 * A press of a write button: its steps (an approval, then the call), each ending in one of three outcomes: confirmed
 * (a successful receipt, with its event where the step needs one), not sent (refused before the wallet, or rejected
 * by the wallet), or unknown (the wallet was asked and no hash came back). A sent step without a receipt can be left
 * pending; a reverted receipt is "failed".
 */
export type StepState = 'waiting' | 'wallet' | 'sent' | 'confirmed' | 'notSent' | 'unknown' | 'pending' | 'failed';
export interface PressStep {
  label: string;
  state: StepState;
  hash?: Hash;
  reason?: string;
  /** The wallet was asked for this step's transaction. */
  asked?: boolean;
  /** Confirmed, but what followed could not be read (for example "the new balance"). */
  unread?: string;
}
export interface PressView {
  id: number;
  /** The account that pressed: only it sees the outcome. */
  owner: string;
  title: string;
  steps: PressStep[];
  /** A transaction request of this press reached the wallet: no Cancel from then on. */
  walletAsked: boolean;
  /** A sent step has waited longer than 180 s for its receipt. */
  slow: boolean;
  /** The last receipt read failed (the endpoint, not the transaction). */
  readFailing?: boolean;
  /** Once every step is settled or the press stopped: the one line that says what happened. */
  final?: string;
}
export interface Ticket {
  id: number;
  /** Cancelled, stopped or left: nothing of this press updates the page any more. */
  detached: boolean;
  /** SH-303: gives back the press's hold on the page's pause (lib/limiter.ts); twice is once. */
  pauseAgain?: () => void;
  checkNow?: () => void;
  cancel?: () => void;
  stop?: () => void;
  leave?: () => void;
}
export interface WriteLock {
  current: PressView | null;
  /** Takes the lock for a press, or null when another press holds it (a second press does nothing). */
  take(title: string, owner: string): Ticket | null;
  show(t: Ticket, v: PressView): void;
  /** Close, once the press has its last line. */
  close(): void;
  /** Cancel, only before the press's first wallet request. */
  cancel(): void;
  /** The wallet does not answer: the press ends with its outcome unknown. */
  stopWaiting(): void;
  /** A sent step has no receipt: the dialog closes, the box keeps the steps and their links. */
  leavePending(): void;
  checkAgain(): void;
}

/** Counts every navigation (hash change, and the page being left): a press made before one never reaches the wallet. */
let navCount = 0;
export const navNow = () => navCount;

const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('AppProvider missing');
  return c;
}

/**
 * SH-303: a launch page changes slowly; one re-read a half minute (a press re-reads at once). The local stands' development
 * server may set a shorter one (PILE_POLL_MS, vite.config.ts; a build refuses it).
 */
const POLL_MS: number = (import.meta.env.PILE_POLL_MS as number | null) ?? 30_000;
const POLL_MAX_MS = 64000;

export interface ReadHealth {
  /** The oldest last success among the reads failing now (ms since epoch), or null when none fails. */
  failingSince: number | null;
  ok(key: string): void;
  fail(key: string): void;
}

export function AppProvider({ config, children }: { config: AppConfig; children: ReactNode }) {
  const client = useMemo(() => publicClientFor(config), [config]);
  const [tick, setTick] = useState(0);
  // a new round of reads: the event scans read the head again (lib/logs.ts)
  const bump = useCallback(() => {
    forgetHead();
    setTick((t) => t + 1);
  }, []);
  // Per read: when it last succeeded (or was first tried), and whether it fails now.
  const reads = useRef(new Map<string, { lastOk: number; failing: boolean }>());
  const [failingSince, setFailingSince] = useState<number | null>(null);
  const fails = useRef(0);
  const recompute = useCallback(() => {
    let oldest: number | null = null;
    for (const r of reads.current.values()) if (r.failing && (oldest === null || r.lastOk < oldest)) oldest = r.lastOk;
    setFailingSince(oldest);
    fails.current = oldest === null ? 0 : fails.current;
  }, []);
  const ok = useCallback(
    (key: string) => {
      reads.current.set(key, { lastOk: Date.now(), failing: false });
      recompute();
    },
    [recompute],
  );
  const fail = useCallback(
    (key: string) => {
      const prev = reads.current.get(key);
      reads.current.set(key, { lastOk: prev?.lastOk ?? Date.now(), failing: true });
      fails.current += 1;
      recompute();
    },
    [recompute],
  );
  // Polls every POLL_MS; while reads fail the wait doubles up to 64 s, so a rate-limited endpoint is not hammered.
  // SH-303: a hidden tab does not poll; it reads again at once when it is shown.
  useEffect(() => {
    const wait = failingSince !== null ? Math.min(POLL_MS * 2 ** Math.min(fails.current, 6), POLL_MAX_MS) : POLL_MS;
    const id = window.setTimeout(() => {
      if (!document.hidden) bump();
    }, wait);
    const shown = () => {
      if (!document.hidden) bump();
    };
    document.addEventListener('visibilitychange', shown);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [bump, tick, failingSince]);
  const health = useMemo<ReadHealth>(() => ({ failingSince, ok, fail }), [failingSince, ok, fail]);
  useEffect(() => {
    const on = () => {
      navCount += 1;
    };
    window.addEventListener('hashchange', on);
    window.addEventListener('pagehide', on);
    return () => {
      window.removeEventListener('hashchange', on);
      window.removeEventListener('pagehide', on);
    };
  }, []);
  // The press lock: a ref answers a press at once (no second press in the same moment); the state draws the dialog.
  const holder = useRef<{ ticket: Ticket; view: PressView } | null>(null);
  const [held, setHeld] = useState<PressView | null>(null);
  const ticketSeq = useRef(0);
  const release = useCallback(() => {
    holder.current = null;
    setHeld(null);
  }, []);
  const lock = useMemo<WriteLock>(
    () => ({
      current: held,
      take(title, owner) {
        if (holder.current) return null;
        const ticket: Ticket = { id: ++ticketSeq.current, detached: false };
        const view: PressView = { id: ticket.id, owner, title, steps: [{ label: title, state: 'waiting' }], walletAsked: false, slow: false };
        holder.current = { ticket, view };
        setHeld(view);
        return ticket;
      },
      show(t, v) {
        if (holder.current?.ticket !== t) return;
        holder.current = { ticket: t, view: v };
        setHeld(v);
      },
      close() {
        if (holder.current?.view.final !== undefined) release();
      },
      cancel() {
        holder.current?.ticket.cancel?.();
      },
      stopWaiting() {
        holder.current?.ticket.stop?.();
        bump();
      },
      leavePending() {
        const h = holder.current;
        if (!h) return;
        h.ticket.leave?.();
        h.ticket.pauseAgain?.();
        release();
        bump();
      },
      checkAgain() {
        holder.current?.ticket.checkNow?.();
      },
    }),
    [held, release, bump],
  );
  // SH-303: a press still running when the provider goes is ended (its plan's next check stops it before the wallet)
  // and does not keep the page's pause off
  useEffect(
    () => () => {
      const t = holder.current?.ticket;
      if (!t) return;
      t.detached = true;
      t.pauseAgain?.();
    },
    [],
  );
  const value = useMemo(() => ({ config, client, tick, bump, health, lock }), [config, client, tick, bump, health, lock]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * A read's state. `ok` carries when it was read (`at`) and whether a later read of the same thing has failed since
 * (`stale`): absence ("no pile", "no sale") is shown only from an `ok` answer that says so.
 */
export type Loaded<T> =
  | { state: 'loading' }
  | { state: 'ok'; value: T; at: number; stale: boolean }
  | { state: 'error'; error: DecodedError };

let readSeq = 0;

/**
 * Runs `read` now and again on every tick. On a tick it keeps the last good value (marked stale while a newer read
 * fails); when its inputs change (a new amount typed) the old value is never shown: a quote always belongs to its input.
 * A read that resolves to `undefined` did not ask the chain and reports nothing to the health of the reads.
 */
export function useChainRead<T>(
  read: (client: PublicClient) => Promise<T>,
  deps: unknown[],
  opts: {
    keepOnChange?: boolean;
    /** The account the read belongs to: a value kept from another account passes through `forOtherOwner` first. */
    owner?: string;
    forOtherOwner?: (v: T) => T;
  } = {},
): Loaded<T> {
  const { client, tick, health } = useApp();
  const key = deps.map((d) => (typeof d === 'bigint' ? `${d}n` : String(d))).join('|');
  const id = useRef(`r${++readSeq}`);
  const owner = opts.owner?.toLowerCase();
  const [out, setOut] = useState<{ key: string; owner?: string; v: Loaded<T> }>({ key, owner, v: { state: 'loading' } });
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    read(client).then(
      (value) => {
        if (value !== undefined) health.ok(id.current);
        if (n === seq.current) setOut({ key, owner, v: { state: 'ok', value, at: Date.now(), stale: false } });
      },
      (e) => {
        const error = decodeError(e);
        // A contract's answer is an answer; anything else is the endpoint failing: keep the last good numbers.
        if (error.name === 'unknown') health.fail(id.current);
        if (n === seq.current) setOut((prev) => afterFailedRead(prev, key, owner, Boolean(opts.keepOnChange), error));
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, tick, key]);
  // A value read for another account keeps only its public part (`forOtherOwner`), from the first render on.
  const own = (v: Loaded<T>): Loaded<T> =>
    v.state === 'ok' && out.owner !== owner && opts.forOtherOwner ? { ...v, value: opts.forOtherOwner(v.value) } : v;
  if (out.key === key) return own(out.v);
  // A screen's own state (not a quote): while the read for new inputs (another account) runs, the last value stays,
  // marked stale, so the screen and its write statuses stay in place.
  return opts.keepOnChange && out.v.state === 'ok' ? own({ ...out.v, stale: true }) : { state: 'loading' };
}

/**
 * What a read's screen state becomes when the read fails: the last good numbers stay, marked stale (the screen shows
 * "Numbers from N s ago"), when they are for the same inputs (or the screen keeps them on purpose); else the failure.
 * A later answered read replaces it with fresh numbers (stale: false), which clears the badge.
 */
export function afterFailedRead<T>(
  prev: { key: string; owner?: string; v: Loaded<T> },
  key: string,
  owner: string | undefined,
  keepOnChange: boolean,
  error: DecodedError,
): { key: string; owner?: string; v: Loaded<T> } {
  return (prev.key === key || keepOnChange) && prev.v.state === 'ok'
    ? { key, owner: prev.owner, v: { ...prev.v, stale: true } }
    : { key, owner, v: { state: 'error', error } };
}

/** An earlier transaction of the same press (an approval), with its own state and hash. */
export interface TxLeg {
  label: string;
  hash: Hash;
  state: StepState;
}

/** What a box shows of its last press: its current step while it runs, then its outcome and every known hash. */
export type TxStep = (
  | { kind: 'idle' }
  | { kind: 'checking'; label: string }
  | { kind: 'wallet'; label: string }
  | { kind: 'sent'; label: string; hash: Hash }
  | { kind: 'done'; label: string; hash: Hash; note?: string }
  | { kind: 'failed'; label: string; error: DecodedError; hash?: Hash }
) & { legs?: TxLeg[] };

/** The chain state a step needs when it goes to the wallet: null, or why it is gone. Every step has one. */
export type Need = () => Promise<string | null>;
/** For a step that depends on no chain state (a mint of the open test coin): said explicitly at its call. */
export const NO_STATE: Need = async () => null;

/**
 * A press: the account and wallet counter it was made with, and its steps. Every wallet request checks the counters
 * and the step's chain state (`Need`, plus `alsoNeeds` for the call after an approval) inside the provider call.
 */
export interface Press {
  account: Address;
  epoch: number;
  check(): void;
  /** The steps of this press, declared before its first wallet request. */
  steps(labels: string[]): void;
  /** What the current step needs besides its own Need (the call after an approval: the allowance as approved). */
  alsoNeeds?: Need;
  onWallet(): void;
  sent(hash: Hash): void;
  /** Waits for the receipt as long as it takes; a reverted one is this step's failure. */
  mined(hash: Hash): Promise<TransactionReceipt>;
  /** The current step is confirmed (`unread`: what could not be read after it); the next one starts. */
  next(unread?: string): void;
}

/** The allowance `owner` gives `spender` on `token`, read at `block` (or the latest). */
export function allowanceAt(client: PublicClient, token: Address, owner: Address, spender: Address, block?: bigint): Promise<bigint> {
  return client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender], ...(block !== undefined ? { blockNumber: block } : {}) });
}

const MAX_UINT = 2n ** 256n - 1n;
const APPROVAL_WAIT_MS = 20_000;

/** Check the receipt block alongside two consecutive latest-state reads on the page's client. */
export async function waitForApproval(press: Press, visible: () => Promise<boolean>, atReceipt?: () => Promise<boolean>): Promise<void> {
  let polling = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pause: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), APPROVAL_WAIT_MS);
  });
  async function visibleTwice() {
    let previous = false;
    while (polling) {
      press.check();
      const seen = await visible().catch(() => false);
      if (!polling) break;
      if (seen && previous) return true;
      previous = seen;
      await new Promise<void>((resolve) => { pause = setTimeout(resolve, 1000); });
    }
    return false;
  }
  try {
    const receipt = atReceipt ? atReceipt().catch(() => undefined) : Promise.resolve(true);
    const latest = Promise.race([visibleTwice(), deadline]);
    const mined = await Promise.race([receipt, latest.then(() => undefined)]);
    press.next(mined === undefined ? 'the allowance' : undefined);
    if (mined === false) throw new PageRefusal('state', 'the allowance on chain is not the amount approved');
    if (!(await latest)) throw new PageRefusal('approval-not-visible', 'The approval is confirmed, but the network does not show it yet. Press again in a moment.');
  } finally {
    polling = false;
    clearTimeout(pause);
    clearTimeout(timer);
  }
}

/**
 * Every approval on the page, removals too. At the press the pressing owner's allowance is read ("Checking allowance"
 * meanwhile). A grant: when it is not exactly `amount`, the press gets the step `approveLabel` (exactly `amount`; zero
 * and the largest number refused), its allowance read at the receipt's block, then the call `mainLabel`, which needs
 * the allowance exactly `amount` when it goes to the wallet. A removal (`amount` 0, no `mainLabel`): the one step,
 * returned for the press to wait on.
 */
export async function withApproval(
  client: PublicClient,
  wallet: WalletLike,
  press: Press,
  a: { token: Address; spender: Address; amount: bigint; approveLabel: string; mainLabel?: string; need: Need; gas?: bigint },
): Promise<Hash | undefined> {
  const removal = a.mainLabel === undefined;
  if (removal ? a.amount !== 0n : a.amount === 0n || a.amount >= MAX_UINT) throw new PageRefusal('bad-amount', 'That amount cannot be approved.');
  press.steps(['Checking allowance']);
  const now = await allowanceAt(client, a.token, press.account, a.spender);
  const hasAmount = async (block?: bigint) => (await allowanceAt(client, a.token, press.account, a.spender, block)) === a.amount;
  const exact: Need = async () => ((await hasAmount()) ? null : 'the allowance changed');
  if (removal) {
    if (now === 0n) throw new PageRefusal('state', 'the allowance is already zero');
    press.steps([a.approveLabel]);
    const need: Need = async () => (await a.need()) ?? ((await allowanceAt(client, a.token, press.account, a.spender)) === 0n ? 'the allowance is already zero' : null);
    return sendWrite(client, wallet, { address: a.token, abi: erc20Abi, functionName: 'approve', args: [a.spender, 0n] }, press, need, a.gas);
  }
  const balance = await client.readContract({ address: a.token, abi: erc20Abi, functionName: 'balanceOf', args: [press.account], blockTag: 'latest' }).catch(() => undefined);
  if (balance !== undefined && balance < a.amount) throw new PageRefusal('over-balance', REFUSALS['over-balance']);
  if (now === a.amount) {
    press.steps([a.mainLabel!]);
    press.alsoNeeds = exact;
    return undefined;
  }
  press.steps([a.approveLabel, a.mainLabel!]);
  const hash = await sendWrite(client, wallet, { address: a.token, abi: erc20Abi, functionName: 'approve', args: [a.spender, a.amount] }, press, a.need, a.gas);
  const receipt = await press.mined(hash);
  await waitForApproval(press, hasAmount, () => hasAmount(receipt.blockNumber));
  press.alsoNeeds = exact;
  return undefined;
}

export interface WalletLike {
  account?: Address;
  currentEpoch(): number;
  provider(): Eip1193 | undefined;
}

export type Confirmed = { ok: true; note?: string } | { ok: false; error: DecodedError };

/** Development pages may shorten the 180 s and slow the receipt polling (tests); a build always uses the defaults. */
function devNumber(name: string, fallback: number): number {
  if (import.meta.env.DEV) {
    const v = Number((window as unknown as Record<string, unknown>)[name]);
    if (v > 0) return v;
  }
  return fallback;
}

/** A refusal's sentence as a reason inside a line ("the wallet changed"). */
export function reasonOf(sentence: string): string {
  const r = sentence
    .replace(/,? so nothing (else )?was (sent|done)\.?$/i, '')
    .replace(/\.$/, '')
    .trim();
  return r.charAt(0).toLowerCase() + r.slice(1);
}

/** The one line that says what a settled press did. "Nothing was sent" only when no step reached the wallet. */
export function finalLine(steps: PressStep[]): string {
  const one = steps.length === 1;
  const who = (st: PressStep, i: number) => (one ? st.label : `Step ${i + 1}`);
  const word = (st: PressStep, i: number) => {
    switch (st.state) {
      case 'confirmed':
        return st.unread ? `${who(st, i)} confirmed; ${st.unread} could not be read.` : `${who(st, i)} confirmed.`;
      case 'unknown':
        return `Your wallet did not answer for step ${i + 1}. It may still send it: check your wallet's activity before pressing again.`;
      case 'pending':
        return `Step ${i + 1} is still pending: check it on the explorer before pressing again.`;
      case 'failed':
        return `${who(st, i)} failed: ${st.reason ?? 'it was undone on chain'}.`;
      default:
        return `${who(st, i)} was not sent${st.reason ? `: ${st.reason}` : ''}.`;
    }
  };
  if (!steps.some((st) => st.asked)) {
    const why = steps.find((st) => st.reason)?.reason;
    return `Nothing was sent${why ? `: ${why}` : ''}.`;
  }
  return steps.map(word).join(' ');
}

/** What the box shows of a press: its current step while it runs, then its outcome with every known hash. */
function boxStepOf(v: PressView, note?: string): TxStep {
  const known = v.steps.flatMap((st) => (st.hash ? [{ label: st.label, hash: st.hash, state: st.state }] : []));
  const last = v.steps[v.steps.length - 1]!;
  const legs = known.filter((l) => l.hash !== last.hash);
  const withLegs = <T extends TxStep>(x: T): T => (legs.length ? { ...x, legs } : x);
  if (v.final !== undefined) {
    if (v.steps.every((st) => st.state === 'confirmed') && last.hash) return withLegs({ kind: 'done', label: v.title, hash: last.hash, note: [note, last.unread ? `${last.unread} could not be read.` : undefined].filter(Boolean).join(' ') || undefined });
    const name = v.steps.find((st) => st.state !== 'confirmed')?.state ?? 'notSent';
    return withLegs({ kind: 'failed', label: v.title, error: { name: name === 'notSent' ? 'not-sent' : name, sentence: v.final }, hash: last.hash });
  }
  const cur = v.steps.find((st) => st.state !== 'confirmed') ?? last;
  if (cur.state === 'sent' && cur.hash) return withLegs({ kind: 'sent', label: cur.label, hash: cur.hash });
  if (cur.state === 'wallet') return withLegs({ kind: 'wallet', label: cur.label });
  return withLegs({ kind: 'checking', label: cur.label });
}

/**
 * One write button's press. `plan` declares the steps (or the press is one step named `title`), sends them through
 * `sendWrite` and returns the last step's hash; the press waits for its receipt as long as it takes. `confirm` checks
 * the claimed outcome in the receipt; if it cannot read what it needs, the step stays confirmed and `after` names what
 * could not be read. Only the account that pressed sees the box's result (`ownerOnly`) and the dialog's.
 */
export function useTx(opts: { decimals?: number; ownerOnly?: boolean; errors?: ContractKind } = {}) {
  const { client, bump, lock } = useApp();
  const decimals = opts.decimals ?? 18;
  const [step, setStep] = useState<{ s: TxStep; owner?: string }>({ s: { kind: 'idle' } });
  const run = useCallback(
    async (
      title: string,
      wallet: WalletLike,
      plan: (press: Press) => Promise<Hash>,
      confirm?: (receipt: TransactionReceipt) => Confirmed | Promise<Confirmed>,
      after = 'the result',
    ): Promise<TransactionReceipt | null> => {
      if (!wallet.account) return null;
      const owner = wallet.account.toLowerCase();
      const ticket = lock.take(title, owner);
      if (!ticket) return null;
      const view: PressView = { id: ticket.id, owner, title, steps: [{ label: title, state: 'waiting' }], walletAsked: false, slow: false };
      let at = 0;
      let note: string | undefined;
      let refusalLine: string | undefined;
      const publish = () => {
        if (ticket.detached) return;
        const copy = { ...view, steps: view.steps.map((x) => ({ ...x })) };
        lock.show(ticket, copy);
        setStep({ s: boxStepOf(copy, note), owner });
      };
      /** Ends the press now (Cancel, Stop waiting, Leave it pending): its line, then nothing of it updates the page. */
      const endNow = (mark: (cur: PressStep) => void, laterWhy: string) => {
        if (view.final !== undefined || ticket.detached) return;
        const cur = view.steps[at];
        if (cur) mark(cur);
        for (const later of view.steps.slice(at + 1)) {
          later.state = 'notSent';
          later.reason = laterWhy;
        }
        view.slow = false;
        view.final = finalLine(view.steps);
        publish();
        ticket.detached = true;
        ticket.pauseAgain?.(); // SH-303: an ended press no longer holds the page's pause off, whatever its wallet does
      };
      ticket.cancel = () => {
        if (view.walletAsked) return;
        endNow((cur) => {
          cur.state = 'notSent';
          cur.reason = 'cancelled';
        }, 'cancelled');
      };
      ticket.stop = () => {
        const cur = view.steps[at];
        if (!cur || cur.state === 'sent' || view.final !== undefined) return;
        navCount += 1;
        endNow((c) => {
          if (c.asked) c.state = 'unknown';
          else {
            c.state = 'notSent';
            c.reason = 'you stopped waiting';
          }
        }, `step ${at + 1} did not finish`);
      };
      ticket.leave = () => {
        const cur = view.steps[at];
        if (!cur || cur.state !== 'sent') return;
        endNow((c) => {
          c.state = 'pending';
        }, `step ${at + 1} is still pending`);
      };
      const nav = navNow();
      const press: Press = {
        account: wallet.account,
        epoch: wallet.currentEpoch(),
        check: () => {
          if (ticket.detached) throw new PageRefusal('stopped', 'This press was ended.');
          if (navNow() !== nav) throw new PageRefusal('moved', 'The page changed.');
        },
        steps: (labels) => {
          view.steps = labels.map((label) => ({ label, state: 'waiting' }));
          at = 0;
          publish();
        },
        onWallet: () => {
          const cur = view.steps[at]!;
          cur.state = 'wallet';
          cur.asked = true;
          view.walletAsked = true;
          publish();
        },
        sent: (h) => {
          const cur = view.steps[at]!;
          cur.state = 'sent';
          cur.hash = h;
          publish();
        },
        mined: (h) =>
          new Promise<TransactionReceipt>((resolve, reject) => {
            let settled = false;
            const finish = (r: TransactionReceipt) => {
              if (settled || r.transactionHash.toLowerCase() !== h.toLowerCase()) return;
              settled = true;
              window.clearTimeout(slow);
              view.slow = false;
              view.readFailing = false;
              if (r.status !== 'success') {
                reject(Object.assign(new PageRefusal('reverted', 'it was undone on chain'), { receipt: true }));
                return;
              }
              resolve(r);
            };
            const slow = window.setTimeout(() => {
              view.slow = true;
              publish();
            }, devNumber('__slowAfterMs', 180_000));
            const read = () =>
              client.getTransactionReceipt({ hash: h }).then(finish, (e: unknown) => {
                // "not found yet" is the normal answer; anything else is the endpoint failing, said in the dialog.
                const failing = !String((e as { name?: string })?.name ?? '').includes('NotFound');
                if (failing !== Boolean(view.readFailing)) {
                  view.readFailing = failing;
                  publish();
                }
              });
            ticket.checkNow = () => void read();
            // No time limit: the receipt is read until it comes or the press is left pending.
            const loop = async () => {
              while (!settled && !ticket.detached) {
                await read();
                if (!settled) await new Promise((r) => window.setTimeout(r, devNumber('__receiptPollMs', 1500)));
              }
              // SH-303: the press was ended (Stop waiting, Leave it pending): this wait ends too, so the runner finishes
              if (!settled) {
                settled = true;
                window.clearTimeout(slow);
                reject(new PageRefusal('stopped', 'This press was ended.'));
              }
            };
            void loop();
          }),
        next: (unread) => {
          view.steps[at]!.state = 'confirmed';
          if (unread) view.steps[at]!.unread = unread;
          at += 1;
          press.alsoNeeds = undefined;
          publish();
        },
      };
      publish();
      // SH-303: the press's reads (its quotes, the simulation, the gas and fee reads) never wait behind the page's pause
      const release = (ticket.pauseAgain = pageLimiter.openForPress());
      try {
        const hash = await plan(press);
        const receipt = await press.mined(hash);
        bump();
        const cur = view.steps[at]!;
        let c: Confirmed;
        try {
          c = confirm ? await confirm(receipt) : { ok: true as const };
        } catch {
          // The receipt succeeded; only what followed could not be read: the step stays confirmed and says so.
          c = { ok: true };
          cur.unread = after;
        }
        if (!c.ok) {
          cur.state = 'failed';
          cur.reason = reasonOf(c.error.sentence);
          return null;
        }
        note = c.note;
        cur.state = 'confirmed';
        return ticket.detached ? null : receipt;
      } catch (e) {
        const d = decodeError(e, decimals, opts.errors);
        if (d.name === 'approval-not-visible' || d.name === 'over-balance') refusalLine = d.sentence;
        const cur = view.steps[at];
        if (cur && view.final === undefined) {
          const reason = d.name === 'rejected' ? 'you rejected it in your wallet' : reasonOf(d.sentence);
          if (cur.hash) {
            cur.state = 'failed';
            cur.reason = reason;
          } else if (cur.asked && d.name !== 'rejected') {
            cur.state = 'unknown';
          } else {
            cur.state = 'notSent';
            cur.reason = refusalLine ? undefined : reason;
          }
          for (const later of view.steps.slice(at + 1)) {
            later.state = 'notSent';
            later.reason = `step ${at + 1} did not go through`;
          }
        }
        bump();
        return null;
      } finally {
        release();
        if (view.final === undefined) {
          view.final = refusalLine ?? finalLine(view.steps);
          publish();
        }
      }
    },
    [client, bump, decimals, opts.errors, lock.take, lock.show], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const reset = useCallback(() => setStep({ s: { kind: 'idle' } }), []);
  const walletNow = useWalletAccount();
  const shown = opts.ownerOnly && step.owner && step.owner !== walletNow ? ({ kind: 'idle' } as TxStep) : step.s;
  return { step: shown, run, reset, busy: shown.kind === 'checking' || shown.kind === 'wallet' || shown.kind === 'sent' };
}

/**
 * Sends one step's transaction. Before: the press's counters, and the wallet's selected account and chain. Then,
 * inside the provider call that hands the transaction over (after the library's own wallet requests, immediately
 * before it is forwarded): the counters, the step's chain state (`need`, required, and the press's `alsoNeeds`) read
 * then, the chain's fee read then (SH-280, fees.ts: both EIP-1559 fields set by the page, for every wallet), and the
 * counters once more. The gas limit is the node's estimate plus half, or a fixed one.
 */
export async function sendWrite(
  client: PublicClient,
  wallet: WalletLike,
  request: Record<string, unknown>,
  press: Press,
  need: Need,
  fixedGas?: bigint,
): Promise<Hash> {
  const req = { ...request, account: press.account } as never;
  const gas = fixedGas ?? ((await client.estimateContractGas(req)) * 3n) / 2n + 100_000n;
  const stillSame = () => {
    press.check();
    if (wallet.currentEpoch() !== press.epoch) throw new PageRefusal('wallet-changed', 'The wallet changed.');
  };
  stillSame();
  const eth = wallet.provider();
  if (!eth) throw new PageRefusal('no-wallet', 'No wallet.');
  const [selected] = (await eth.request({ method: 'eth_accounts' })) as string[];
  const chain = Number((await eth.request({ method: 'eth_chainId' })) as string);
  if (!selected || selected.toLowerCase() !== press.account.toLowerCase() || chain !== CHAIN_ID) {
    throw new PageRefusal('wallet-changed', 'The wallet changed.');
  }
  stillSame();
  const also = press.alsoNeeds;
  const state: Need = async () => (await need()) ?? (also ? await also() : null);
  const wc = createWalletClient({
    account: press.account,
    chain: client.chain,
    transport: custom(guardSends(eth, press.account, stillSame, () => press.onWallet(), state, () => readSendFees(client))),
  });
  const { chain: _c, account: _a, ...rest } = req as Record<string, unknown>;
  const hash = await wc.writeContract({ ...rest, account: press.account, gas } as never);
  press.sent(hash);
  return hash;
}

function useWalletAccount(): string | undefined {
  return useWallet().account?.toLowerCase();
}

/** The methods that hand a transaction to the wallet. Only the two that viem uses for a wallet's own account pass. */
const SEND_METHODS = new Set(['eth_sendTransaction', 'wallet_sendTransaction']);
const OTHER_SENDS = new Set(['eth_sendRawTransaction', 'eth_signTransaction', 'wallet_sendCalls']);

/**
 * The provider the page writes through: other requests pass unchanged. A transaction: the counters (`check`), the
 * step's chain state read now (`state`), the counters again with no wait before the wallet's own `request`; it
 * carries `from` and chain id 0x61 explicitly.
 */
export function guardSends(eth: Eip1193, account: Address, check: () => void, onWallet: () => void = () => undefined, state: Need = NO_STATE, fees?: () => Promise<SendFees>): Eip1193 {
  return {
    ...eth,
    request: async (args: { method: string; params?: unknown[] }) => {
      if (OTHER_SENDS.has(args.method)) throw new PageRefusal('wallet-changed', 'The wallet changed, so nothing was sent.');
      if (!SEND_METHODS.has(args.method)) return eth.request(args);
      check();
      const gone = await state();
      if (gone) throw new PageRefusal('state', gone);
      // SH-280: the fee the page sets, read now (the wallet's own guess is not used; a made wallet shows no window).
      const fee = fees ? await fees() : null;
      check();
      const [tx, ...more] = (args.params ?? []) as Record<string, unknown>[];
      const priced = fee ? withFees(tx ?? {}, fee) : tx;
      onWallet();
      return eth.request({ method: args.method, params: [{ ...priced, from: account, chainId: numberToHex(CHAIN_ID) }, ...more] });
    },
  } as Eip1193;
}

/**
 * The minimum for a guarded call, taken at the press from a fresh quote: refused when zero, and when worse than the
 * minimum the visitor saw (`shown`), so the visitor looks again.
 */
export function minimumAtPress(fresh: bigint, guardBps: bigint, shown: bigint | undefined): bigint {
  const min = (fresh * (10_000n - guardBps)) / 10_000n;
  if (min <= 0n) throw new PageRefusal('zero-minimum', 'The least you would get is zero, so nothing was sent.');
  if (shown !== undefined && min < shown) throw new PageRefusal('quote-moved', 'The quote moved. Check the new numbers and press again.');
  return min;
}

export type { Address };
