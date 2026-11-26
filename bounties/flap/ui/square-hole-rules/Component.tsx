"use client";

// Square Hole: the creator's rules of a token launched by one of our rules sales on Flap (RulesVault). It shows what
// arrived and waits to be shared, each rule with its part, what it was sent and what still waits; anyone can share
// out (distribute) or pay a creator part that waits (payOwedCreator). The pile part's holders redeem at the pile,
// reached through the vault's own pileOf(token) resolver: approval and redeem in one press.
// Amounts stay bigint and are formatted here exactly. The coin the vault pays in: the native coin (18 decimals), the
// host's payment token when it is the vault's asset (no extra read then), otherwise what the asset's own contract
// answers for decimals() and symbol(), asked beside the page's own reads and never awaited by them; without a usable
// answer no amount is shown and nothing can be redeemed. Every figure on screen is kept with the vault, token and
// chain it was read for and shown only for them. A quote of 0 never sends: a
// hand-in that pays nothing is refused on the page, and again at the press before any approval. The minimum accepted
// is the pile's own quoteRedeem for the amount, read just before sending (for a fixed amount it cannot fall: see the
// note at that line). When the pile cannot be resolved, the page says so and offers nothing else.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VaultComponentProps } from "@/src/sdk";
import { erc20Abi, formatPercentBps, handleTxError, isActionAvailableForPhase, readTaxVaultHostContext, useFlapSdk } from "@/src/sdk";
import { AddressLink, Alert, Button, Card, CardContent, CardHeader, CardTitle, DataRow, Metric, StatusBadge } from "@/src/ui";
import { kindBuyBurn, kindCreator, kindPile, pileAbi, vaultAbi } from "./VaultABI";

type Address = `0x${string}`;
type Rule = { kind: number; bps: number; target: Address; owed: bigint; delivered: bigint; burned: bigint };
type Shared = { asset: Address; pending: bigint; totalOwed: bigint; rules: Rule[]; tokenDecimals: number };
type Pile = { address: Address; pile: bigint; perToken: bigint | null };
type Mine = { balance: bigint; allowance: bigint | null };
type Unit = { symbol: string; decimals: number };
/** What the asset's own contract answered for decimals() and symbol(), unchecked. */
type UnitAnswer = { decimals: unknown; symbol: unknown };
type UnitRead = UnitAnswer | null;
/** A figure with what it was read for (`of`: the chain, vault and token, or those and more). */
type Owned<T> = T & { of: string };
type PaymentToken = { address: string; symbol: string; decimals: number } | undefined;

// ── Amounts and decisions (pure; our own tests run them) ───────────────────────────────────────────────────────────

/** Base units as a plain decimal string, exact: no grouping, no exponent, trailing zeros dropped. */
function exactDecimal(value: bigint, decimals: number) {
  const base = 10n ** BigInt(decimals);
  const fraction = decimals === 0 ? "" : (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return (value / base).toString() + (fraction ? "." + fraction : "");
}

/** A typed plain decimal into base units, exact; null unless it is positive with at most `decimals` places. */
function parseExact(text: string, decimals: number) {
  const match = /^([0-9]{1,40})(?:\.([0-9]*))?$/.exec(text.trim());
  if (!match || (match[2] ?? "").length > decimals) return null;
  const value = BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt((match[2] ?? "").padEnd(decimals, "0") || "0");
  return value > 0n ? value : null;
}

/** For display, always rounded DOWN (a page must not show more than the chain pays): `places` decimals, or as many
 * as the first three significant digits need when the amount is smaller than that. So zero reads "0" and an amount
 * that is not zero never does: 462962 base units of an 18-decimal coin read "0.000000000000462". */
function shown(value: bigint, decimals: number, places = 4) {
  if (value <= 0n) return exactDecimal(value, decimals);
  // the decimal place of the first significant digit (0 or less: the amount is one whole unit or more)
  const firstPlace = decimals - value.toString().length + 1;
  const keep = Math.max(places, firstPlace + 2);
  const cut = decimals > keep ? 10n ** BigInt(decimals - keep) : 1n;
  return exactDecimal(value / cut * cut, decimals);
}

/** Thousands separators in the whole part of a plain decimal string ("1080000000.5" reads "1,080,000,000.5"). */
function grouped(plain: string) {
  const [whole, fraction] = plain.split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction ? "." + fraction : "");
}

/** A token count for display: from one token up, whole tokens with thousands separators (rounded down); below one
 * token its first digits, so a count that is not zero never reads "0". */
function tokenCount(value: bigint, decimals: number) {
  const one = 10n ** BigInt(decimals);
  return value >= one ? grouped((value / one).toString()) : shown(value, decimals);
}

/** Whether the host's payment token (its address and decimals) is the vault's asset, with whole decimals 0 to 36. */
function hostDescribes(asset: string, address: string | undefined, decimals: number | undefined) {
  return address !== undefined && decimals !== undefined && address.toLowerCase() === asset.toLowerCase()
    && Number.isInteger(decimals) && decimals >= 0 && decimals <= 36;
}

/** The host's payment token as the unit, when it is the vault's asset; else null. */
function hostUnit(asset: string, payment: PaymentToken): Unit | null {
  return payment && hostDescribes(asset, payment.address, payment.decimals) ? { symbol: payment.symbol, decimals: payment.decimals } : null;
}

/** Whether the asset's own contract must be asked for the unit: never for the native coin, and never when the host's
 * payment token is the asset (then the host's unit is used and no extra read is made). */
function needsUnitRead(asset: string, hostAddress: string | undefined, hostDecimals: number | undefined) {
  return !/^0x0{40}$/i.test(asset) && !hostDescribes(asset, hostAddress, hostDecimals);
}

/** The asset's own answer for its unit, asked once per key (chain and asset) for the visit: the promise is kept from
 * the moment it starts, so a refresh while it is on its way starts no second pair of reads, and an answer stays
 * kept, usable or not. A failed pair answers null and is forgotten, so the next round asks again. Each read starts
 * in its own promise callback: one that throws at once is a failed read like any other and cannot leave the other's
 * failure unhandled. Never rejects. */
function unitFromCoin(answers: Map<string, Promise<UnitRead>>, key: string, reads: (() => Promise<unknown>)[]): Promise<UnitRead> {
  const known = answers.get(key);
  if (known) return known;
  const asked: Promise<UnitRead> = Promise.all(reads.map((read) => Promise.resolve().then(read)))
    .then(([decimals, symbol]) => ({ decimals, symbol }), () => null);
  answers.set(key, asked);
  void asked.then((answer) => { if (answer === null && answers.get(key) === asked) answers.delete(key); });
  return asked;
}

/** A kept figure, only for what it was read for: another vault, token, chain, coin or amount gets null. */
function owned<T extends { of: string }>(value: T | null, of: string | null): T | null {
  return value !== null && of !== null && value.of === of ? value : null;
}

/** The coin the vault pays in: the native coin (18); the host's payment token when it is the vault's asset; otherwise
 * the asset contract's own answer, taken only when it is plain: whole decimals from 0 to 36 and a symbol that starts
 * with a letter and has at most 16 letters, digits, dots, underscores or dashes (a symbol of digits would read as
 * part of the number). Anything else is null: the page then shows no amount and refuses to redeem. */
function quoteUnit(asset: string, payment: PaymentToken, nativeSymbol: string, read: UnitRead = null): Unit | null {
  if (/^0x0{40}$/i.test(asset)) return { symbol: nativeSymbol, decimals: 18 };
  const fromHost = hostUnit(asset, payment);
  if (fromHost) return fromHost;
  if (!read) return null;
  const decimals = typeof read.decimals === "bigint" ? Number(read.decimals) : read.decimals;
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  if (typeof read.symbol !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,15}$/.test(read.symbol)) return null;
  return { symbol: read.symbol, decimals };
}

/** A coin amount for display: rounded down, thousands separators in its whole part, the coin's symbol; "-" while the
 * coin's unit is not known. */
function coinText(value: bigint, unit: Unit | null, places = 4) {
  return unit ? grouped(shown(value, unit.decimals, places)) + " " + unit.symbol : "-";
}

/** Asks one quote for the entered amount and shows its answer if and only if what it was asked for (`key`: chain,
 * vault, token, coin and amount) is what the page shows when the answer arrives; any other answer is dropped.
 * Nothing is held: no flag, no queue, no timer. A quote that never answers blocks nothing, a failed one changes
 * nothing, and several can be on their way at once. The read starts inside the promise, so one that throws at once
 * is a failed quote like any other. Never rejects. */
function askQuote(key: string, read: () => Promise<bigint>, showing: () => string | null, show: (key: string, value: bigint) => void): Promise<void> {
  return Promise.resolve().then(read).then((value) => { if (showing() === key) show(key, value); }, () => undefined);
}

/** The lines of "How it works", in the closed "More" part (message keys), by the parts this vault has: a line about
 * a creator part, the buy and burn or the pile appears only with such a part. The payout line follows the coin: the
 * native coin needs a wallet that can receive it; a token payout says only where it goes. Before the rules are read
 * (`kinds` null) only the lines true of every vault are listed. */
function howLines(kinds: number[] | null, asset: string | null) {
  const has = (kind: number) => kinds !== null && kinds.includes(kind);
  const payout = asset === null ? [] : [/^0x0{40}$/i.test(asset) ? "how.payoutNative" : "how.payoutToken"];
  return [
    "how.sources", "how.taxEnds", "how.lag",
    ...(has(kindCreator) ? ["how.payee"] : []),
    ...(has(kindBuyBurn) ? ["how.burn"] : []),
    ...(has(kindPile) ? ["how.share", "how.whole", "how.approval", ...payout] : []),
    "how.upgrade",
  ];
}

/** Why a hand-in cannot go ahead (a message key), or null. A quote of 0 refuses: the tokens would burn for nothing. */
function redeemRefusal(x: { balance: bigint | null; amount: bigint | null; quote: bigint | null; unitKnown: boolean }) {
  if (!x.unitKnown) return "states.unitUnknown";
  if (x.balance === null) return "states.loading";
  if (x.balance === 0n) return "states.noTokens";
  if (x.amount === null) return "states.enterAmount";
  if (x.amount > x.balance) return "states.tooMany";
  if (x.quote === null) return "states.loading";
  if (x.quote === 0n) return "states.forNothing";
  return null;
}

/** The minimum sent with redeem: the fresh quote itself, or null (send nothing) when it is 0. */
function minOutFor(fresh: bigint) {
  return fresh > 0n ? fresh : null;
}

/** What the pile section shows: nothing without a PILE rule, the redemption once the pile resolved, a plain sentence
 * when it could not be resolved, or a wait while it is being read. */
/** The note beside a buy-and-burn part that waits. The swap guard (Flap's fix as written) buys at most once a minute,
 * at most 0.05% of the pool's coin side; what is not bought waits. Its state is private: no countdown, and no claim
 * about the next press (a share-out can buy nothing for other reasons: no pool yet, a slice too small). */
function burnNotes(owed: bigint) {
  return owed === 0n ? [] : ["notices.burnPaced"];
}

function pileView(kinds: number[], resolved: boolean, failed: boolean) {
  if (!kinds.includes(kindPile)) return "none";
  return resolved ? "redeem" : failed ? "unreachable" : "reading";
}

/** The wall clock, for the load's time limit. */
function nowMs() {
  return Date.now();
}

export default function SquareHoleRules(_props: VaultComponentProps) {
  void _props;
  const sdk = useFlapSdk();
  const { context, i18n, wallet } = sdk;
  const t = i18n.t;
  const host = readTaxVaultHostContext(context.host);
  const riskLevel = host.vaultInfo?.riskLevel ?? host.taxInfo?.vaultInfo?.riskLevel ?? null;
  const riskLabel = riskLevel === 1 ? t("risk.low") : riskLevel === 2 ? t("risk.lowMedium") : riskLevel === 3 ? t("risk.medium") : riskLevel === 4 ? t("risk.high") : riskLevel === 0 ? t("risk.unverified") : t("risk.missing");
  const riskTone = riskLevel === null || riskLevel === 0 || riskLevel >= 4 ? "danger" : riskLevel >= 3 ? "warning" : "success";
  const stageAvailable = isActionAvailableForPhase("both", host.marketPhase);
  const validVault = /^0x[0-9a-fA-F]{40}$/.test(context.vaultAddress) && !/^0x0{40}$/i.test(context.vaultAddress);
  // Nothing of one vault is ever shown for another: each kept figure names what it was read for (the chain, the
  // vault and the token; the pile and the quote also the coin, the quote also the amount) and is used only while
  // that is what the page shows.
  // (The keys are plain text of the values as given: the same address in another spelling counts as another, which
  // only ever shows less.)
  const identity = `${context.chainId}:${context.vaultAddress}:${context.tokenAddress}`;
  const [sharedRaw, setSharedRaw] = useState<Owned<Shared> | null>(null);
  const [pileRaw, setPileRaw] = useState<Owned<Pile> | null>(null);
  const [pileFailedOf, setPileFailedOf] = useState<string | null>(null);
  const [mineRaw, setMineRaw] = useState<Owned<Mine> | null>(null);
  const [amountRaw, setAmountRaw] = useState<Owned<{ text: string }> | null>(null);
  const [quoteRaw, setQuoteRaw] = useState<Owned<{ value: bigint }> | null>(null);
  const [unitAnswer, setUnitAnswer] = useState<Owned<{ read: UnitAnswer }> | null>(null);
  const shared = owned(sharedRaw, identity);
  // the pile's figure is in the vault's coin: it is shown only with the asset it was read under
  const coinOf = shared ? `${identity}:${shared.asset}` : null;
  const pile = owned(pileRaw, coinOf);
  const pileFailed = pileFailedOf !== null && pileFailedOf === coinOf;
  // the visitor's own figures also name the connected account: a wallet switch shows nothing of the previous wallet
  const mineOf = `${identity}:${context.userAddress ?? ""}`;
  const mine = owned(mineRaw, mineOf);
  const amountText = owned(amountRaw, identity)?.text ?? "";
  const setAmountText = (text: string) => setAmountRaw({ of: identity, text });
  const [round, setRound] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const lock = useRef(false);
  const revision = useRef(0);
  const inFlight = useRef(false);
  const startedAt = useRef(0);
  const unitAnswers = useRef(new Map<string, Promise<UnitRead>>());
  // what the page shows now for the entered amount (its key and the amount): answers are compared with it
  const showing = useRef<{ key: string; amount: bigint } | null>(null);
  // the host's payment token by value, so that a host passing a new object every render does not restart the load
  const paymentAddress = context.paymentToken?.address;
  const paymentDecimals = context.paymentToken?.decimals;
  const messages = useMemo(() => ({ userRejected: t("errors.userRejected"), walletDisconnected: t("errors.walletDisconnected"), insufficientFunds: t("errors.insufficientFunds"), simulationFailed: t("errors.simulationFailed"), reverted: t("errors.reverted"), unknown: t("errors.transaction") }), [t]);
  const pileRule = shared?.rules.find((r) => r.kind === kindPile) ?? null;
  const doneText: Record<string, string> = { shared: t("messages.shared"), paid: t("messages.paid"), redeemed: t("messages.redeemed") };

  const unitRead = shared ? owned(unitAnswer, `${context.chainId}:${shared.asset}`)?.read ?? null : null;
  const unit = shared ? quoteUnit(shared.asset, context.paymentToken, t("units.native"), unitRead) : null;
  const tokenDecimals = shared?.tokenDecimals ?? 18;
  const amount = shared ? parseExact(amountText, shared.tokenDecimals) : null;
  const coin = (value: bigint, places = 4) => coinText(value, unit, places);
  // the quote belongs to this vault, this coin and this amount; it is shown for nothing else
  const quoteKey = coinOf !== null && pile && amount !== null ? `${coinOf}:${amount}` : null;
  const quote = owned(quoteRaw, quoteKey)?.value ?? null;
  const setQuote = (value: bigint | null) => setQuoteRaw(value === null || quoteKey === null ? null : { of: quoteKey, value });
  const view = pileView(shared ? shared.rules.map((rule) => rule.kind) : [], pile !== null, pileFailed);

  // One load at a time: a timer tick while a load runs starts nothing, so a slow load always lands. A result is
  // dropped only when the page's inputs (vault, token, account, network) changed meanwhile: the effect's cleanup
  // moves `revision` on exactly then.
  const loadData = useCallback(async () => {
    // a load still running after 30 seconds no longer holds the page: the next tick starts a fresh one
    if (inFlight.current && nowMs() - startedAt.current < 30_000) return;
    inFlight.current = true;
    startedAt.current = nowMs();
    const r = revision.current;
    try {
      if (!validVault) { setSharedRaw(null); setPileRaw(null); setMineRaw(null); setError(t("errors.binding")); return; }
      const [taxToken, asset, pending, totalOwed, count, decimals] = await Promise.all([
        sdk.readContract<Address>({ contract: "vault", address: context.vaultAddress, abi: vaultAbi, functionName: "taxToken" }),
        sdk.readContract<Address>({ contract: "vault", address: context.vaultAddress, abi: vaultAbi, functionName: "asset" }),
        sdk.readContract<bigint>({ contract: "vault", address: context.vaultAddress, abi: vaultAbi, functionName: "pending" }),
        sdk.readContract<bigint>({ contract: "vault", address: context.vaultAddress, abi: vaultAbi, functionName: "totalOwed" }),
        sdk.readContract<bigint>({ contract: "vault", address: context.vaultAddress, abi: vaultAbi, functionName: "ruleCount" }),
        sdk.readContract<number>({ contract: "token", address: context.tokenAddress, abi: erc20Abi, functionName: "decimals" }),
      ]);
      if (r !== revision.current) return;
      if (taxToken.toLowerCase() !== context.tokenAddress.toLowerCase() || count === 0n || count > 4n) { setSharedRaw(null); setPileRaw(null); setMineRaw(null); setError(t("errors.binding")); return; }
      // every rule's four reads at once (one round trip, not one per rule)
      const indexes = Array.from({ length: Number(count) }, (_, k) => BigInt(k));
      const rules: Rule[] = await Promise.all(indexes.map(async (i) => {
        const [ruleTuple, owed, delivered, burned] = await Promise.all([
          sdk.readContract<readonly [number, number, Address]>({ contract: "vault", address: context.vaultAddress, abi: vaultAbi, functionName: "rule", args: [i] }),
          sdk.readContract<bigint>({ contract: "vault", address: context.vaultAddress, abi: vaultAbi, functionName: "owed", args: [i] }),
          sdk.readContract<bigint>({ contract: "vault", address: context.vaultAddress, abi: vaultAbi, functionName: "delivered", args: [i] }),
          sdk.readContract<bigint>({ contract: "vault", address: context.vaultAddress, abi: vaultAbi, functionName: "burned", args: [i] }),
        ]);
        return { kind: Number(ruleTuple[0]), bps: Number(ruleTuple[1]), target: ruleTuple[2], owed, delivered, burned };
      }));
      if (r !== revision.current) return;
      // the rules, the shares and "Share out now" never wait for the pile, nor for the coin's unit
      setSharedRaw({ of: identity, asset, pending, totalOwed, rules, tokenDecimals: Number(decimals) });
      setError(null);
      setLoading(false);
      // The coin's unit from the coin itself, only when the host's payment token is another coin or missing (when it
      // is the asset, the host's unit is used and nothing more is read). The vault's asset is the sale's quote token
      // (the pile's asset is the same: the vault refuses any other pile at its start): decimals() and symbol() are
      // read on it, nothing is ever written to it. NOT awaited: the rules, "Share out now", "Pay this part now" and
      // the rest of this load never wait for the coin; until it answers, coin amounts read "-" and redeem stays
      // refused.
      const quoteTokenAddress = asset;
      if (needsUnitRead(quoteTokenAddress, paymentAddress, paymentDecimals)) {
        const unitOf = `${context.chainId}:${quoteTokenAddress}`;
        void unitFromCoin(unitAnswers.current, unitOf, [
          () => sdk.readContract<unknown>({ contract: "token", address: quoteTokenAddress, abi: erc20Abi, functionName: "decimals" }),
          () => sdk.readContract<unknown>({ contract: "token", address: quoteTokenAddress, abi: erc20Abi, functionName: "symbol" }),
        ]).then((answer) => {
          if (answer && r === revision.current) setUnitAnswer((was) => (was && was.of === unitOf && was.read === answer ? was : { of: unitOf, read: answer }));
        });
      }
      const figureOf = `${identity}:${asset}`;
      const connected = Boolean(context.userAddress) && !wallet.isWrongNetwork;
      let balance: bigint | null = null;
      if (connected && context.userAddress) {
        balance = await sdk.readContract<bigint>({ contract: "token", address: context.tokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [context.userAddress] });
        if (r !== revision.current) return;
        const known = balance;
        setMineRaw({ of: mineOf, balance: known, allowance: null });
      } else setMineRaw(null);
      // The pile, on its own and time-boxed: only when the rules have a PILE part (the vault's pileOf(token) reverts
      // NoPileRule otherwise); if it does not answer within 20 seconds the page says so, and the next load tries again.
      if (!rules.some((rule) => rule.kind === kindPile)) { setPileRaw(null); setPileFailedOf(null); return; }
      const pileRead = (async () => {
        const handle = await sdk.resolveContract("pile", [context.tokenAddress]);
        const [pileAmount, circulating] = await Promise.all([
          sdk.readContract<bigint>({ contract: handle, abi: pileAbi, functionName: "pile" }),
          sdk.readContract<bigint>({ contract: handle, abi: pileAbi, functionName: "circulatingSupply" }),
        ]);
        // What one whole token redeems for: quoteRedeem reverts once less than one token circulates, so it is read
        // only from one circulating token up, and on its own: its failure never hides the rest.
        const one = 10n ** BigInt(decimals);
        const perToken = circulating >= one
          ? await sdk.readContract<bigint>({ contract: handle, abi: pileAbi, functionName: "quoteRedeem", args: [one] }).catch(() => null)
          : null;
        const allowance = connected && context.userAddress
          ? await sdk.readContract<bigint>({ contract: "token", address: context.tokenAddress, abi: erc20Abi, functionName: "allowance", args: [context.userAddress, handle.address] })
          : null;
        return { pile: { address: handle.address, pile: pileAmount, perToken }, allowance };
      })();
      const timeBox = new Promise<null>((resolve) => { setTimeout(() => resolve(null), 20_000); });
      const next = await Promise.race([pileRead, timeBox]).catch(() => null);
      if (r !== revision.current) return;
      if (next) {
        setPileRaw({ of: figureOf, ...next.pile });
        setPileFailedOf(null);
        // one more landed round of the pile: the entered amount is quoted again (below)
        setRound((n) => n + 1);
        if (balance !== null) setMineRaw({ of: mineOf, balance, allowance: next.allowance });
      } else {
        setPileRaw(null);
        setPileFailedOf(figureOf);
      }
    } catch {
      if (r === revision.current) { setSharedRaw(null); setPileRaw(null); setMineRaw(null); setError(t("errors.read")); }
    } finally {
      inFlight.current = false;
      if (r === revision.current) setLoading(false);
    }
  }, [context.chainId, context.tokenAddress, context.userAddress, context.vaultAddress, identity, mineOf, paymentAddress, paymentDecimals, sdk, t, validVault, wallet.isWrongNetwork]);

  useEffect(() => {
    // the first read right after mount, then every 15 seconds (a tick while a load runs starts nothing)
    const first = setTimeout(() => void loadData(), 0);
    const timer = setInterval(() => void loadData(), 15000);
    return () => { clearTimeout(first); clearInterval(timer); revision.current += 1; inFlight.current = false; };
  }, [loadData, sdk.refetchNonce]);

  // What the entered amount pays now: the pile's own quoteRedeem, asked 0.4 s after each change of the amount and at every
  // landed refresh round. Memory-free: an answer is shown if and only if what it was asked for is what the page shows
  // when it arrives (askQuote); nothing is held, so nothing can get stuck, and no answer cancels or blocks another.
  const quoteFor = useCallback((key: string, amountNow: bigint) => {
    void askQuote(key, async () => {
      const handle = await sdk.resolveContract("pile", [context.tokenAddress]);
      return sdk.readContract<bigint>({ contract: handle, abi: pileAbi, functionName: "quoteRedeem", args: [amountNow] });
    }, () => showing.current?.key ?? null, (of, value) => setQuoteRaw({ of, value }));
  }, [context.tokenAddress, sdk]);

  // A change of the amount (or of the vault): what the page shows moves at once, so an answer for the older amount is
  // dropped when it arrives; the new amount is quoted once it has stood for 0.4 s.
  useEffect(() => {
    showing.current = quoteKey !== null && amount !== null ? { key: quoteKey, amount } : null;
    if (quoteKey === null || amount === null) return;
    const timer = setTimeout(() => quoteFor(quoteKey, amount), 400);
    return () => clearTimeout(timer);
  }, [amount, quoteFor, quoteKey]);

  // A landed refresh round (`round`): the entered amount is quoted again, so "You get now" follows the pile like the
  // numbers above it. Quotes already on their way are left alone.
  useEffect(() => {
    const now = showing.current;
    if (now !== null) quoteFor(now.key, now.amount);
  }, [quoteFor, round]);

  const blocked = !validVault ? t("errors.binding")
    : !context.userAddress || !wallet.isConnected ? t("states.connect")
    : wallet.isWrongNetwork ? t("states.wrongNetwork")
    : !stageAvailable ? t("states.phase")
    : loading || !shared ? t("states.loading")
    : null;
  const refusal = redeemRefusal({ balance: mine?.balance ?? null, amount, quote, unitKnown: unit !== null });
  const refusalText: Record<string, string> = {
    "states.unitUnknown": t("states.unitUnknown"), "states.loading": t("states.loading"), "states.noTokens": t("states.noTokens"),
    "states.enterAmount": t("states.enterAmount"), "states.tooMany": t("states.tooMany"), "states.forNothing": t("states.forNothing"),
  };
  const redeemBlocked = blocked ?? (!pile ? t("states.loading") : refusal === null ? null : refusalText[refusal]);
  const nothingToShare = !shared || (shared.pending === 0n && shared.totalOwed === 0n);

  async function send(kind: string, run: () => Promise<boolean>) {
    if (lock.current) return;
    lock.current = true; setBusy(kind); setDone(null); setError(null);
    try {
      if (await run()) {
        setDone(kind);
        sdk.notify.success(doneText[kind]);
        await sdk.refetch();
      }
    } catch (cause) {
      setError(handleTxError(cause, messages));
    } finally {
      lock.current = false; setBusy(null);
    }
  }

  async function confirmed(hash: `0x${string}`) {
    const receipt = await sdk.waitForTx(hash);
    if (receipt.status !== "success") { setError(t("errors.reverted")); return false; }
    return true;
  }

  const shareOut = () => send("shared", async () => {
    if (blocked || nothingToShare) return false;
    const simulation = await sdk.simulateContract({ contract: "vault", address: context.vaultAddress, abi: vaultAbi, functionName: "distribute", args: [] });
    return confirmed(await sdk.writeContract(simulation.request));
  });

  const payCreator = (i: number) => send("paid", async () => {
    if (blocked) return false;
    const simulation = await sdk.simulateContract({ contract: "vault", address: context.vaultAddress, abi: vaultAbi, functionName: "payOwedCreator", args: [BigInt(i)] });
    return confirmed(await sdk.writeContract(simulation.request));
  });

  const redeem = () => send("redeemed", async () => {
    if (redeemBlocked || amount === null || !pile) return false;
    const handle = await sdk.resolveContract("pile", [context.tokenAddress]);
    // a hand-in that would pay nothing stops here, before any approval
    const first = await sdk.readContract<bigint>({ contract: handle, abi: pileAbi, functionName: "quoteRedeem", args: [amount] });
    if (minOutFor(first) === null) { setQuote(0n); setError(t("states.forNothing")); return false; }
    if ((mine?.allowance ?? 0n) < amount) {
      const approval = await sdk.simulateContract({ contract: "token", address: context.tokenAddress, abi: erc20Abi, functionName: "approve", args: [handle.address, amount] });
      if (!(await confirmed(await sdk.writeContract(approval.request)))) return false;
    }
    // The least accepted is exactly what the pile quotes for this amount now, with no tolerance. The pile refuses a
    // payout below it (FeeRules.sol _redeem: BelowMinimum, the hand-in is rolled back), so nobody receives less than
    // this quote. Assumption that keeps it from refusing for nothing: for a fixed amount the quote cannot fall. The
    // quote is pile x amount / circulating supply, rounded down (quoteRedeem, _quote). Another holder's redemption
    // takes at most its own rounded-down share and lowers the supply by what it handed in, so the pile per circulating
    // token does not fall; income only adds; nothing but a redemption moves the pile out; and the supply cannot grow:
    // the pile has no excluded holders (PileVault.initialize), never sends the token out, and the token's total
    // supply is taken as never growing. If any of that changed (other pile code behind the beacon, a token that
    // mints), the redemption would be refused; it would not pay less.
    const minOut = minOutFor(await sdk.readContract<bigint>({ contract: handle, abi: pileAbi, functionName: "quoteRedeem", args: [amount] }));
    if (minOut === null) { setQuote(0n); setError(t("states.forNothing")); return false; }
    const simulation = await sdk.simulateContract({ contract: handle, abi: pileAbi, functionName: "redeem", args: [amount, minOut] });
    if (!(await confirmed(await sdk.writeContract(simulation.request)))) return false;
    setAmountText("");
    setQuote(null);
    return true;
  });

  const noteText: Record<string, string> = { "notices.burnPaced": t("notices.burnPaced") };
  const howText: Record<string, string> = {
    "how.sources": t("how.sources"), "how.taxEnds": t("how.taxEnds"), "how.lag": t("how.lag"), "how.payee": t("how.payee"),
    "how.burn": t("how.burn"), "how.share": t("how.share"), "how.whole": t("how.whole"), "how.approval": t("how.approval"),
    "how.payoutNative": t("how.payoutNative"), "how.payoutToken": t("how.payoutToken"), "how.upgrade": t("how.upgrade"),
  };

  const kindLabel = (kind: number) => kind === kindCreator ? t("rules.creator") : kind === kindPile ? t("rules.pile") : kind === kindBuyBurn ? t("rules.buyBurn") : t("rules.unknown");

  return <div className="w-full min-w-0 space-y-4">
    <Card className="overflow-hidden rounded-[18px] border-white/10 bg-black/25">
      <CardHeader className="space-y-3 p-4 pb-3 sm:p-5 sm:pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            {/* the Square Hole mark: static inline SVG (a square with a rim), no file, no link, no motion */}
            <svg className="h-7 w-7 shrink-0" width="28" height="28" viewBox="0 0 32 32" role="img" aria-label={t("brand.name")}>
              <defs><linearGradient id="square-hole-mark" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#8b7cf6" /><stop offset="1" stopColor="#e9e5ff" /></linearGradient></defs>
              <rect x="2" y="2" width="28" height="28" rx="8" fill="url(#square-hole-mark)" />
              <rect x="10.5" y="10.5" width="11" height="11" rx="2" fill="#080d16" />
            </svg>
            <CardTitle>{t("title")}</CardTitle>
          </div>
          <StatusBadge tone={riskTone}>{riskLabel}</StatusBadge>
        </div>
        {riskLevel === null ? <Alert tone="danger">{t("notices.riskMissing")}</Alert> : riskLevel === 0 || riskLevel >= 4 ? <Alert tone="warning">{t("notices.review")}</Alert> : null}
        <p className="text-sm leading-6 text-white/60">{t("description")}</p>
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-0 sm:p-5 sm:pt-0">
        <div className="grid gap-3 sm:grid-cols-2">
          <Metric label={t("labels.pending")} value={shared ? coin(shared.pending) : "-"} />
          <Metric label={t("labels.waiting")} value={shared ? coin(shared.totalOwed) : "-"} />
        </div>
        <section aria-label={t("sections.rules")} className="space-y-3 rounded-[14px] border border-white/10 bg-black/30 p-3 sm:p-4">
          <h3 className="text-sm font-semibold text-white">{t("sections.rules")}</h3>
          {shared ? shared.rules.map((rule, i) => (
            <div key={i} className="space-y-1 border-t border-white/10 pt-2 first:border-t-0 first:pt-0">
              <DataRow label={kindLabel(rule.kind)} value={formatPercentBps(rule.bps)} />
              <DataRow label={t("labels.sent")} value={coin(rule.delivered)} />
              <DataRow label={t("labels.ruleWaiting")} value={coin(rule.owed)} />
              {rule.kind === kindBuyBurn ? <DataRow label={t("labels.burned")} value={tokenCount(rule.burned, tokenDecimals)} /> : null}
              {rule.kind === kindBuyBurn ? burnNotes(rule.owed).map((key) => <p key={key} className="text-xs leading-5 text-white/55">{noteText[key]}</p>) : null}
              {rule.kind !== kindBuyBurn ? <DataRow label={t("labels.to")} value={<AddressLink address={rule.target} explorerBaseUrl={context.explorerBaseUrl} />} /> : null}
              {rule.kind === kindCreator && rule.owed > 0n ? (
                <Button variant="outline" type="button" disabled={Boolean(blocked) || busy !== null} loading={busy === "paid"} onClick={() => void payCreator(i)}>{t("actions.payCreator")}</Button>
              ) : null}
            </div>
          )) : <p className="text-xs leading-5 text-white/55">{loading ? t("states.loading") : "-"}</p>}
          {blocked ? <Alert tone="warning">{blocked}</Alert> : nothingToShare ? <Alert tone="warning">{t("states.nothingToShare")}</Alert> : null}
          <Button className="w-full" type="button" disabled={Boolean(blocked) || nothingToShare || busy !== null} loading={busy === "shared"} onClick={() => void shareOut()}>{busy === "shared" ? t("actions.working") : t("actions.shareOut")}</Button>
          <p className="text-xs leading-5 text-white/55">{t("notices.anyone")}</p>
        </section>
        {view !== "none" ? (
          <section aria-label={t("sections.redeem")} className="space-y-3 rounded-[14px] border border-white/10 bg-black/30 p-3 sm:p-4">
            <h3 className="text-sm font-semibold text-white">{t("sections.redeem")}</h3>
            {view === "redeem" && pile ? <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Metric label={t("labels.pile")} value={coin(pile.pile)} />
                <Metric label={t("labels.perToken")} value={pile.perToken !== null ? coin(pile.perToken, 8) : "-"} />
              </div>
              <DataRow label={t("labels.yourTokens")} value={mine ? grouped(shown(mine.balance, tokenDecimals)) : "-"} />
              <label className="block space-y-1">
                <span className="text-xs leading-5 text-white/55">{t("labels.amount")}</span>
                <div className="flex gap-2">
                  <input className="min-w-0 flex-1 rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-white" inputMode="decimal" value={amountText} disabled={busy !== null}
                    onChange={(event) => { setAmountText(event.target.value); setQuote(null); setDone(null); }} />
                  <Button variant="outline" type="button" disabled={busy !== null || !mine || mine.balance === 0n} onClick={() => { if (mine) { setAmountText(exactDecimal(mine.balance, tokenDecimals)); setQuote(null); } }}>{t("actions.all")}</Button>
                </div>
              </label>
              <DataRow label={t("labels.youGet")} value={amount !== null && quote !== null ? coin(quote, 8) : "-"} />
              {redeemBlocked ? <Alert tone="warning">{redeemBlocked}</Alert> : null}
              <Button className="w-full" type="button" disabled={Boolean(redeemBlocked) || busy !== null} loading={busy === "redeemed"} onClick={() => void redeem()}>{busy === "redeemed" ? t("actions.working") : t("actions.redeem")}</Button>
              <p className="text-xs leading-5 text-white/55">{t("notices.burned")}</p>
            </> : view === "unreachable" ? <Alert tone="warning">{t("states.pileUnreachable")}</Alert> : <p className="text-xs leading-5 text-white/55">{t("states.loading")}</p>}
          </section>
        ) : null}
        {done ? <Alert tone="success">{doneText[done]}</Alert> : null}
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <details className="border-t border-white/10 pt-3">
          <summary className="cursor-pointer text-sm text-white/70">{t("labels.more")}</summary>
          <div className="mt-3 space-y-2">
            <DataRow label={t("labels.vault")} value={<AddressLink address={context.vaultAddress} explorerBaseUrl={context.explorerBaseUrl} />} />
            {pileRule ? <DataRow label={t("labels.pileAddress")} value={<AddressLink address={pileRule.target} explorerBaseUrl={context.explorerBaseUrl} />} /> : null}
            <DataRow label={t("labels.token")} value={<AddressLink address={context.tokenAddress} explorerBaseUrl={context.explorerBaseUrl} />} />
            <DataRow label={t("labels.factory")} value={<AddressLink address={context.factoryAddress} explorerBaseUrl={context.explorerBaseUrl} />} />
            <Button variant="outline" type="button" disabled={loading || busy !== null} onClick={() => { setLoading(true); void loadData(); }}>{t("actions.refresh")}</Button>
            <h4 className="pt-2 text-xs font-semibold text-white/70">{t("sections.how")}</h4>
            <ul className="list-disc space-y-1 pl-5 text-xs leading-5 text-white/55">
              {howLines(shared ? shared.rules.map((rule) => rule.kind) : null, shared ? shared.asset : null).map((key) => <li key={key}>{howText[key]}</li>)}
            </ul>
          </div>
        </details>
      </CardContent>
    </Card>
  </div>;
}
