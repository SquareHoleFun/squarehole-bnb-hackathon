import { useEffect, useState, type ReactNode } from 'react';
import { bytesToHex, encodeAbiParameters, parseEventLogs, type Address, type Hex, type TransactionReceipt } from 'viem';
import type { Abi } from 'viem';
import { curveConfigParam, curveFactoryAbi, flapPortalAbi, rulesVaultFactoryAbi, tokenCurveFactoryAbi } from '../abi/flap';
import type { FlapRulesPair } from '../lib/config';
import { BUY_BACK_SAYS, FINAL_SAYS } from '../components/RulesPanel';
import { isPileOnly, readRules, RULES_DEFAULT, rulesArg, rulesRefusals, type RulesField, type RulesForm } from '../lib/rules';
import { MintTestCoin } from '../components/MintTestCoin';
import { Amount, Help, Stat, TxStatus } from '../components/bits';
import { CurveChart } from '../components/CurveChart';
import { useWriteGate } from '../components/WalletBar';
import { formatAmount, toDecimalString } from '../lib/amounts';
import { sendWrite, useApp, useChainRead, useTx } from '../lib/app-context';
import { NATIVE_QUOTE, tokenQuote, type SaleQuote } from '../lib/quote';
import { decodeError, PageRefusal } from '../lib/errors';
import { CREATE_DEFAULTS, mineSalt, readCreateForm, type CreateForm, type CurveConfig } from '../lib/flap';
import { PictureField } from '../components/PictureField';
import { belowPageMinimum, decideDefault, exactMinimum, minimumStep, pageMinFor, shortMinimum, smallAcceptedBy } from '../lib/flap-floor';
import { useLaunchPictureUrl } from '../lib/pictures/read';
import { useWallet } from '../lib/wallet';
import { flapPicture, flapRefusals, FLAP_FIELD_PART, type PartId } from '../picture/launch-picture';
import { LaunchPictureView } from '../picture/LaunchPictureView';
import { FlapHappens } from '../picture/WhatHappens';
import { LaunchWays, type Way } from '../picture/LaunchWays';
import '../picture/picture.css';

type Curve = readonly [bigint, bigint, bigint, bigint, bigint, bigint];

const FIELDS: { key: keyof CreateForm; label: string; unit?: string; wide?: boolean }[] = [
  { key: 'name', label: 'Name', wide: true },
  { key: 'symbol', label: 'Symbol' },
  { key: 'target', label: 'Target', unit: 'BNB' },
  { key: 'saleTokens', label: 'Tokens for sale' },
  { key: 'virtualBnb', label: 'Curve depth', unit: 'BNB' },
  { key: 'durationHours', label: 'Deadline in', unit: 'whole hours' },
  { key: 'tradeFee', label: 'Curve fee', unit: '%' },
  { key: 'buyTax', label: 'Buy tax', unit: '%' },
  { key: 'sellTax', label: 'Sell tax', unit: '%' },
  { key: 'burnShare', label: 'Tax burned', unit: '%' },
  { key: 'taxDays', label: 'Tax runs', unit: 'whole days' },
];

/** The two ways a sale can be paid: the test token (the default where the deployment has it) or the native coin. */
type QuoteChoice = 'token' | 'native';

/** The defaults of each choice: the entry's own sale scripts (CreateSale, CreateTokenSale). */
const DEFAULTS: Record<QuoteChoice, CreateForm> = {
  native: CREATE_DEFAULTS,
  token: { ...CREATE_DEFAULTS, name: 'Pile Curve USD', symbol: 'UPILE', target: '1700', virtualBnb: '11600' },
};

export function FlapCreate() {
  const { config } = useApp();
  const flap = config.flap;
  const tokenPair = flap?.tokenQuote;
  const [choice, setChoice] = useState<QuoteChoice>(tokenPair ? 'token' : 'native');
  // Visual first and shown by default; Steps one press away. Both ways edit the same form (CreateWithFactory's).
  const [way, setWay] = useState<Way>('visual');
  const coin = useChainRead((c) => (tokenPair ? tokenQuote(c, config, tokenPair.quote) : Promise.resolve(undefined)), [tokenPair?.quote]);
  if (!flap) {
    return (
      <section className="sh-panel panel">
        <LaunchWays rail="flap" way={way} onWay={setWay} />
        <h1 className="screen-title">Create</h1>
        <p className="empty">No Flap launches on this page yet.</p>
      </section>
    );
  }
  const token = choice === 'token' && tokenPair && coin.state === 'ok' && coin.value ? coin.value : undefined;
  if (choice === 'token' && tokenPair && !token) return <p className="muted">Reading…</p>;
  // SH-287: where this coin has a rules pair in the deployment file, Create uses its launcher factory and offers the
  // creator's rules; without it, today's factories and no rule fields.
  const rulesPair = token ? flap.rules?.token : flap.rules?.native;
  const factory = rulesPair ? rulesPair.launcherFactory : token && tokenPair ? tokenPair.launcherFactory : flap.curveLauncherFactory;
  const paidIn = tokenPair ? (
    <div className="segmented quote-choice" role="tablist" aria-label="Paid in" data-testid="quote-choice">
      <span className="muted small">Paid in</span>
      {(['token', 'native'] as const).map((k) => (
        <button key={k} type="button" role="tab" aria-selected={choice === k} className={choice === k ? 'on' : ''} onClick={() => setChoice(k)} data-testid={`quote-${k}`}>
          {k === 'token' ? tokenPair.label : NATIVE_QUOTE.symbol}
        </button>
      ))}
    </div>
  ) : null;
  return (
    <>
      <LaunchWays rail="flap" way={way} onWay={setWay} />
      <CreateWithFactory
        way={way}
        paidIn={paidIn}
        key={factory}
        factory={factory}
        fAbi={token ? tokenCurveFactoryAbi : curveFactoryAbi}
        eventName={token ? 'TokenCurveLauncherCreated' : 'CurveLauncherCreated'}
        quote={token ?? NATIVE_QUOTE}
        defaults={DEFAULTS[token ? 'token' : 'native']}
        rulesPair={rulesPair}
      />
    </>
  );
}

/** The launcher this receipt created for `salt` (the factory's own event), or undefined. */
export function createdIn(receipt: TransactionReceipt, factory: Address, salt: Hex, fAbi: Abi = curveFactoryAbi, eventName = 'CurveLauncherCreated'): Address | undefined {
  const l = parseEventLogs({ abi: fAbi, logs: receipt.logs, eventName }).find(
    (x) => x.address.toLowerCase() === factory.toLowerCase() && (x.args as { salt: Hex }).salt === salt,
  );
  return l ? (l.args as { launcher: Address }).launcher : undefined;
}

/**
 * The salt of rules already stored by this visit whose create did not follow (setRules is taken only once per sale and
 * only before it exists), by factory, account and parts: the next press with the same three reuses it. Kept in the
 * page's memory for the visit, across "Paid in" and the two ways; a reload forgets it (those rules then belong to a
 * sale that is never created, and a new salt is mined).
 */
const STORED_RULES = new Map<string, Hex>();

function CreateWithFactory(props: {
  factory: Address;
  fAbi: Abi;
  eventName: string;
  quote: SaleQuote;
  defaults: CreateForm;
  way: Way;
  paidIn: ReactNode;
  rulesPair?: FlapRulesPair;
}) {
  const { factory, fAbi, eventName, quote, defaults, way, paidIn, rulesPair } = props;
  // SH-287: the creator's three parts of the rest (whole percent; Pile 100 by default, today's behaviour).
  const [rulesForm, setRulesForm] = useState<RulesForm>(RULES_DEFAULT);
  const rulesRead = readRules(rulesForm);
  const rulesBad = rulesPair ? !rulesRead.ok : false;

  const [open, setOpen] = useState<PartId | null>(null);
  const { client } = useApp();
  const wallet = useWallet();
  const sym = quote.symbol;
  const { ready, gate } = useWriteGate();
  const tx = useTx();
  const [form, setFormState] = useState<CreateForm>(defaults);
  // SH-296: the default target is decided once, by the first floor answer (decideDefault), unless the visitor has
  // edited the target or the curve's depth by then.
  const [touched, setTouched] = useState(false);
  const [decided, setDecided] = useState(false);
  const setForm = (next: CreateForm) => {
    if (next.target !== form.target || next.virtualBnb !== form.virtualBnb) setTouched(true);
    setFormState(next);
  };
  // SH-294: the launch's picture link (`meta`), shared by both ways; '' for none.
  const [launchPicture, setLaunchPicture] = useState('');
  const coinPicture = useLaunchPictureUrl(launchPicture);
  const [viaPortal, setViaPortal] = useState(true);
  const [mining, setMining] = useState(false);
  // From the press until the wallet has answered, the form is locked: what is sent is what is on screen.
  const locked = mining || tx.busy;
  const read = readCreateForm(form, quote.decimals);
  // Every field's own refusal, for the picture's marks (the Steps way shows the first, as it always did).
  const refusals = flapRefusals(form, quote.decimals);

  const basics = useChainRead(
    async (c) => {
      const [hub, tokenImpl, fee, factoryQuote] = await Promise.all([
        c.readContract({ address: factory, abi: fAbi, functionName: 'hub' }),
        c.readContract({ address: factory, abi: fAbi, functionName: 'tokenImpl' }),
        c.readContract({ address: factory, abi: fAbi, functionName: 'creationFee' }),
        quote.kind === 'token' ? c.readContract({ address: factory, abi: fAbi, functionName: 'quote' }) : Promise.resolve(undefined),
      ]);
      // A token-quote factory's own coin must be the one this page shows; otherwise nothing can be created here.
      const coinOk = quote.kind !== 'token' || (typeof factoryQuote === 'string' && factoryQuote.toLowerCase() === quote.address.toLowerCase());
      return { hub: hub as Address, tokenImpl: tokenImpl as Address, fee: fee as bigint, coinOk };
    },
    [factory],
  );

  const key = read.ok ? `${read.config.saleTokens}-${read.config.targetRaise}-${read.config.virtualBnb}-${viaPortal}` : 'x';
  const preview = useChainRead(
    async (c) => {
      if (!read.ok) return undefined;
      const { saleTokens, targetRaise, virtualBnb } = read.config;
      let curve: Curve;
      try {
        curve = (await c.readContract({ address: factory, abi: fAbi, functionName: 'curveFor', args: [saleTokens, targetRaise, virtualBnb] })) as Curve;
      } catch (e) {
        const d = decodeError(e);
        if (d.name === 'unknown') throw e;
        return { error: d };
      }
      const [, raise, poolToken, totalSupply] = curve;
      const floor = (await c.readContract({ address: factory, abi: fAbi, functionName: 'liquidityFloor', args: [raise, poolToken, totalSupply, viaPortal] })) as readonly [bigint, bigint];
      return { curve, floor };
    },
    [factory, key],
  );

  // SH-296: whether Flap accepts the small BNB default now (its floor, read live, as the Portal will apply it). The first
  // answer decides the default once (the small one when accepted, today's otherwise); later answers change nothing, and
  // an answer that arrives while a press is under way or after the visitor's own edit leaves the form as it is.
  const small = useChainRead(async (c) => (quote.kind === 'native' ? smallAcceptedBy(c, factory, fAbi, viaPortal) : null), [factory, viaPortal]);
  const smallAccepted = small.state === 'ok' ? small.value : null;
  useEffect(() => {
    const next = decideDefault({ decided, touched, locked, smallAccepted });
    if (next.decided !== decided) setDecided(next.decided);
    if (next.set && (form.target !== next.set.target || form.virtualBnb !== next.set.virtualBnb)) setFormState({ ...form, ...next.set });
  }, [smallAccepted]); // eslint-disable-line react-hooks/exhaustive-deps

  // The factory's own checks, with a salt mined once for previews (checkConfig wants a token address ending in 7777):
  // every refusal the factory would give appears in the form before anything is sent.
  const [previewSalt, setPreviewSalt] = useState<Hex | undefined>();
  useEffect(() => {
    if (basics.state !== 'ok' || previewSalt) return;
    const seed = bytesToHex(crypto.getRandomValues(new Uint8Array(32))) as Hex;
    void mineSalt(basics.value.tokenImpl, basics.value.hub, seed, { yieldFn: () => new Promise((r) => setTimeout(r, 0)) }).then(
      (m) => setPreviewSalt(m.salt),
      () => undefined,
    );
  }, [basics.state, previewSalt]); // eslint-disable-line react-hooks/exhaustive-deps
  const formKey = read.ok ? JSON.stringify(read.config, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) : '';
  const check = useChainRead(
    async (c) => {
      if (!read.ok || !previewSalt) return undefined;
      try {
        await c.readContract({ address: factory, abi: fAbi, functionName: 'checkConfig', args: [{ ...read.config, salt: previewSalt }, viaPortal] });
        return null;
      } catch (e) {
        const d = decodeError(e);
        if (d.name === 'unknown') throw e;
        return d;
      }
    },
    [factory, formKey, previewSalt, viaPortal],
  );
  const checkError = check.state === 'ok' && check.value && check.value.name !== 'BelowLiquidityFloor' ? check.value : undefined;
  // Create needs the current preview to have answered, and the factory's check to have passed, for these settings.
  const checkPassed = check.state === 'ok' && check.value === null;

  const p = preview.state === 'ok' ? preview.value : undefined;
  const curveError = p && 'error' in p ? p.error : undefined;
  const curve = p && 'curve' in p ? p.curve : undefined;
  const floor = p && 'floor' in p ? p.floor : undefined;
  const belowFloor = floor ? floor[0] < floor[1] : false;
  // SH-296: the smallest target Flap accepts now for this form's tokens and depth (the page's own minimum when Flap has
  // none), shown only once reads at that exact number have passed and one step below has not (exactMinimum). Read again
  // when the tokens, the depth, the Portal choice or whether there is a floor at all change; not on each target typed.
  const pageMin = pageMinFor(quote.kind === 'native', quote.decimals);
  const minKey = read.ok ? `${read.config.saleTokens}-${read.config.virtualBnb}-${viaPortal}-${floor ? (floor[1] === 0n ? 'none' : 'some') : 'x'}` : 'x';
  const minimum = useChainRead(
    async (c) => {
      if (!read.ok || !floor) return undefined;
      const { saleTokens, virtualBnb, targetRaise } = read.config;
      const probe = async (target: bigint) => {
        const at = (await c.readContract({ address: factory, abi: fAbi, functionName: 'curveFor', args: [saleTokens, target, virtualBnb] })) as Curve;
        return (await c.readContract({ address: factory, abi: fAbi, functionName: 'liquidityFloor', args: [at[1], at[2], at[3], viaPortal] })) as readonly [bigint, bigint];
      };
      return exactMinimum(probe, { target: targetRaise, floor }, pageMin, minimumStep(quote.decimals));
    },
    [factory, minKey],
  );
  const minTarget = minimum.state === 'ok' ? minimum.value : undefined;
  const pageMinLine = read.ok ? belowPageMinimum(read.config.targetRaise, pageMin, quote.decimals) : null;
  const fieldRefusal = read.ok ? undefined : read.refusal;
  const fee = basics.state === 'ok' ? basics.value.fee : undefined;
  const coinOk = basics.state === 'ok' && basics.value.coinOk;
  const canCreate = read.ok && !rulesBad && Boolean(curve) && !belowFloor && !pageMinLine && !curveError && checkPassed && basics.state === 'ok' && coinOk && !locked;

  const create = () => {
    if (!read.ok || basics.state !== 'ok' || (rulesPair && !rulesRead.ok)) return;
    const settings = { ...read.config, meta: launchPicture };
    const portal = basics.value.hub;
    const shownFee = basics.value.fee;
    const parts = rulesPair && rulesRead.ok ? rulesRead.parts : null;
    const withRules = parts !== null && !isPileOnly(parts);
    let salt: Hex | undefined;
    void tx
      .run(
        'Create',
        wallet,
        async (press) => {
          const key = JSON.stringify([factory, press.account.toLowerCase(), parts]);
          const kept = withRules ? STORED_RULES.get(key) : undefined;
          setMining(true);
          let cfg: CurveConfig;
          try {
            let mined: { salt: Hex; token: Address };
            if (kept) {
              mined = { salt: kept, token: (await client.readContract({ address: factory, abi: fAbi, functionName: 'predictToken', args: [kept] })) as Address };
            } else {
              const seed = bytesToHex(crypto.getRandomValues(new Uint8Array(32))) as Hex;
              mined = await mineSalt(basics.value.tokenImpl, portal, seed, { yieldFn: () => new Promise((r) => setTimeout(r, 0)) });
            }
            // The factory's own preview must agree before anything is sent.
            const onChain = (await client.readContract({ address: factory, abi: fAbi, functionName: 'predictToken', args: [mined.salt] })) as Address;
            if (onChain.toLowerCase() !== mined.token.toLowerCase()) {
              throw new PageRefusal('prediction', 'The token address could not be confirmed, so nothing was sent.');
            }
            cfg = { ...settings, salt: mined.salt };
            salt = mined.salt;
          } finally {
            setMining(false);
          }
          if (withRules && rulesPair && parts) {
            // The sale this press creates, as both factories name it: the rules are stored for exactly that one.
            const launcher = (await client.readContract({ address: factory, abi: fAbi, functionName: 'predictLauncher', args: [press.account, cfg.salt] })) as Address;
            const named = (await client.readContract({ address: rulesPair.rulesVaultFactory, abi: rulesVaultFactoryAbi, functionName: 'launcherFor', args: [factory, press.account, cfg.salt] })) as Address;
            if (named.toLowerCase() !== launcher.toLowerCase()) throw new PageRefusal('prediction', 'The factories name another sale, so nothing was sent.');
            const isSet = () => client.readContract({ address: rulesPair.rulesVaultFactory, abi: rulesVaultFactoryAbi, functionName: 'rulesSet', args: [launcher] }) as Promise<boolean>;
            if (await isSet()) {
              // stored by this visit's earlier press: only the create is left
              press.steps(['Create']);
            } else {
              press.steps(['Set the rules', 'Create']);
              const hash = await sendWrite(
                client,
                wallet,
                { address: rulesPair.rulesVaultFactory, abi: rulesVaultFactoryAbi, functionName: 'setRules', args: [factory, cfg.salt, rulesArg(parts, press.account)] },
                press,
                async () => ((await client.getBytecode({ address: launcher })) ? 'the sale exists already' : (await isSet()) ? 'the rules are stored already' : null),
              );
              // kept from the moment it is sent: if it lands and the create does not, the next press reuses the salt
              STORED_RULES.set(key, cfg.salt);
              await press.mined(hash);
              press.next((await isSet()) ? undefined : 'the stored rules');
            }
          }
          // The fee again, now: the value sent is the one on screen; if the Portal's salt lock changed, it is shown and
          // needs a new press.
          const value = (await client.readContract({ address: factory, abi: fAbi, functionName: 'creationFee' })) as bigint;
          if (value !== shownFee) throw new PageRefusal('fee-moved', `The fee is now ${toDecimalString(value, 18)} BNB. Press again to pay that.`);
          await client.readContract({ address: factory, abi: fAbi, functionName: 'checkConfig', args: [cfg, viaPortal] });
          const { request } = viaPortal
            ? await client.simulateContract({
                account: press.account,
                address: portal,
                abi: flapPortalAbi,
                functionName: 'newLauncher',
                args: [factory, encodeAbiParameters(curveConfigParam, [cfg])],
                value,
              })
            : await client.simulateContract({ account: press.account, address: factory, abi: fAbi, functionName: 'createLauncher', args: [cfg], value });
          // The fee read when it goes to the wallet must still be the one sent.
          return sendWrite(client, wallet, request, press, async () =>
            ((await client.readContract({ address: factory, abi: fAbi, functionName: 'creationFee' })) as bigint) === value ? null : 'the fee changed. Press again',
          );
        },
        (receipt) =>
          salt && createdIn(receipt, factory, salt, fAbi, eventName) ? { ok: true } : { ok: false, error: { name: 'not-created', sentence: 'No sale was created.' } },
      )
      .then((receipt) => {
        const launcher = receipt && salt ? createdIn(receipt, factory, salt, fAbi, eventName) : undefined;
        if (launcher) for (const [k, v] of STORED_RULES) if (v === salt) STORED_RULES.delete(k);
        if (launcher) window.location.hash = `#/flap/${launcher}`;
      });
  };

  /** One field of the form, as both ways show it (the same input, the same state, the same refusal). */
  const field = (f: (typeof FIELDS)[number]) => (
    <label key={f.key} className={`field${f.wide ? ' field-wide' : ''}`}>
      <span className="field-label">
        {f.label}
        {f.unit ? <span className="muted">{f.unit === 'BNB' ? sym : f.unit}</span> : null}
      </span>
      <input
        value={form[f.key]}
        inputMode={f.key === 'name' || f.key === 'symbol' ? 'text' : 'decimal'}
        aria-invalid={way === 'visual' ? Boolean(refusals[f.key]) : fieldRefusal?.field === f.key}
        disabled={locked}
        onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
        data-testid={`create-${f.key}`}
      />
      {/* SH-296: Flap's smallest target now, under the field (in the label it wrapped at 390 and pushed this input below
          its neighbour's). */}
      {f.key === 'target' && minTarget !== undefined ? (
        <span className="muted small" data-testid="create-min">
          min {shortMinimum(minTarget, quote.decimals)}
        </span>
      ) : null}
      {(way === 'visual' ? refusals[f.key] : fieldRefusal?.field === f.key ? fieldRefusal.text : undefined) ? (
        <span className="refusal" data-testid="create-refusal">
          {way === 'visual' ? refusals[f.key] : fieldRefusal?.text}
        </span>
      ) : null}
      {f.key === 'target' && pageMinLine ? (
        <span className="refusal" data-testid="create-refusal">
          {pageMinLine}
        </span>
      ) : null}
      {f.key === 'target' && belowFloor && floor ? (
        <span className="refusal" data-testid="create-floor">
          Below the Portal&apos;s floor: the pool would hold ${formatAmount(floor[0], 18)}, it needs ${formatAmount(floor[1], 18)}.
        </span>
      ) : null}
      {f.key === 'target' && curveError ? (
        <span className="refusal" data-testid="create-refusal">
          {curveError.sentence}
        </span>
      ) : null}
    </label>
  );
  const pictureField = <PictureField value={launchPicture} onChange={setLaunchPicture} disabled={locked} chainId={97} />;
  const portalBox = (
    <label className="check">
      <input type="checkbox" checked={viaPortal} disabled={locked} onChange={(e) => setViaPortal(e.target.checked)} data-testid="create-portal" />
      Through Flap&apos;s Portal
    </label>
  );
  const chart = curve && read.ok ? <CurveChart virtualBnb={read.config.virtualBnb} virtualTokens={curve[0]} saleTokens={read.config.saleTokens} symbol={sym} decimals={quote.decimals} /> : null;
  const stats = curve ? (
    <div className="stats">
      <Stat label="Raise" testId="create-raise">
        <Amount value={curve[1]} decimals={quote.decimals} symbol={sym} />
      </Stat>
      <Stat label="Start price">
        <Amount value={curve[4]} decimals={quote.decimals} symbol={sym} />
      </Stat>
      <Stat label="Final price">
        <Amount value={curve[5]} decimals={quote.decimals} symbol={sym} />
      </Stat>
      <Stat label="Supply">
        <Amount value={curve[3]} decimals={18} />
      </Stat>
    </div>
  ) : null;
  const checkLine =
    checkError && !curveError && !fieldRefusal ? (
      <p className="refusal" data-testid="create-check">
        {checkError.sentence}
      </p>
    ) : null;
  const coinLine =
    basics.state === 'ok' && !coinOk ? (
      <p className="refusal" data-testid="create-coin">
        This factory takes another coin than the one shown, so nothing can be created here.
      </p>
    ) : null;
  const review =
    fee !== undefined && canCreate ? (
      <p className="review" data-testid="create-review">
        You send <Amount value={fee} decimals={18} symbol="BNB" />
      </p>
    ) : null;
  const help = (
    <Help label="About this sale">
      Until the deadline, buyers can buy and sell back along the curve. A buy that reaches the target launches the token on Flap&apos;s Pool
      Launch, with the raise as its pool. If the deadline passes first, buyers can take back what the sale holds for them, and the salt lock
      fee is spent. After the launch, the token&apos;s tax is split between burning and {rulesPair ? 'the rules' : 'the pile'}. Name and symbol are trimmed of spaces;
      the deadline is set in whole hours and the tax in whole days. Flap&apos;s minimum on the test network can change at any time.
    </Help>
  );
  const fieldsOf = (part: PartId) => FIELDS.filter((f) => FLAP_FIELD_PART[f.key] === part).map(field);

  // SH-287: the creator's three parts of the tax's rest, as both ways show them (only with a rules pair).
  const rulesRefused = rulesRefusals(rulesForm);
  const RULE_FIELDS: { key: RulesField; label: string; says: string }[] = [
    { key: 'creator', label: 'Creator', says: 'Paid to your address at every share-out.' },
    { key: 'pile', label: 'Pile', says: 'Added to the pile that holders redeem from.' },
    {
      key: 'burn',
      label: 'Buy back and burn',
      says: BUY_BACK_SAYS.flap,
    },
  ];
  const ruleField = (r: (typeof RULE_FIELDS)[number], withSays: boolean) => (
    <div key={r.key} className="field">
      <label className="field-label" htmlFor={`rules-${r.key}`}>
        {r.label}
        <span className="muted">%</span>
      </label>
      <input
        id={`rules-${r.key}`}
        value={rulesForm[r.key]}
        inputMode="numeric"
        aria-invalid={Boolean(rulesRefused[r.key])}
        disabled={locked}
        onChange={(e) => setRulesForm({ ...rulesForm, [r.key]: e.target.value })}
        data-testid={`rules-${r.key}`}
      />
      {withSays ? <span className="sh-lp-says small">{r.says}</span> : null}
    </div>
  );
  const rulesRefusalLine = (['creator', 'pile', 'burn'] as const).map((k) => rulesRefused[k]).find(Boolean);
  const rulesBlock = (withSays: boolean) =>
    rulesPair ? (
      <div className="rules-fields" data-testid="rules-fields">
        <p className="field-label">The curve fees at the launch, and the tax left after Flap&apos;s share and the burned part, go to</p>
        {RULE_FIELDS.map((r) => ruleField(r, withSays))}
        {rulesRefusalLine ? (
          <p className="refusal" data-testid="rules-refusal">
            {rulesRefusalLine}
          </p>
        ) : null}
        <p className="sh-lp-says small">
          A part that cannot be paid now stays owed and is tried again at the next share-out. {FINAL_SAYS.flap}
        </p>
      </div>
    ) : null;

  if (way === 'steps') {
    return (
      <section className="sh-panel panel" data-testid="flap-create">
        {paidIn}
        <header className="panel-head">
          <h1 className="screen-title">Create a curve sale</h1>
          {help}
        </header>
        {chart}
        {stats}
        <fieldset className="form-grid plain" disabled={locked} data-testid="create-form">
          {FIELDS.map(field)}
          {pictureField}
          {portalBox}
        </fieldset>
        {rulesBlock(false)}
        {checkLine}
        {coinLine}
        {quote.kind === 'token' ? <MintTestCoin /> : null}
        {review}
        <div className="actions">
          {gate ??
            (ready ? (
              <button type="button" className="btn btn-primary" disabled={!canCreate} onClick={create} data-testid="create">
                {mining ? 'Finding the token address…' : 'Create'}
              </button>
            ) : null)}
        </div>
        <TxStatus step={tx.step} />
      </section>
    );
  }

  // The Visual way: the same form, drawn. A press that cannot send opens the first part with a problem.
  const picture = flapPicture({
    form,
    symbol: sym,
    decimals: quote.decimals,
    refusals,
    fee: fee !== undefined ? `${formatAmount(fee, 18)} BNB` : undefined,
    raiseProblem: belowFloor || Boolean(curveError),
    checkProblem: Boolean(checkError && !curveError && !fieldRefusal),
    coinProblem: basics.state === 'ok' && !coinOk,
    ...(rulesPair ? { rules: { form: rulesForm, refusals: rulesRefused } } : {}),
  });
  const firstProblem = picture.warn[0] ?? null;
  const pressVisual = () => {
    if (canCreate) create();
    else if (firstProblem) setOpen(firstProblem);
  };
  const sheetBody = (part: PartId): ReactNode => {
    switch (part) {
      case 'price':
        return (
          <>
            {paidIn ?? <p className="sh-lp-says">Paid in {sym}.</p>}
            {coinLine}
          </>
        );
      case 'raise':
        return (
          <>
            {fieldsOf('raise')}
            {stats}
          </>
        );
      case 'deadline':
        return (
          <>
            {fieldsOf('deadline')}
            <p className="sh-lp-says">If the deadline passes first, buyers can take back what the sale holds for them, and the salt lock fee is spent.</p>
          </>
        );
      case 'buyers':
      case 'sellers':
        return (
          <>
            {fieldsOf(part)}
            {part === 'sellers' ? field(FIELDS.find((f) => f.key === 'tradeFee')!) : null}
            <p className="sh-lp-says">The curve fee is paid on every trade before the launch; the tax on every pool trade after it.</p>
          </>
        );
      case 'tax':
        return (
          <>
            {fieldsOf('tax')}
            {rulesPair ? (
              rulesBlock(true)
            ) : (
              <p className="sh-lp-says">After the launch, the token&apos;s tax is split between burning and the pile.</p>
            )}
          </>
        );
      case 'pool':
        return <p className="sh-lp-says">A buy that reaches the target launches the token on Flap&apos;s Pool Launch, with the raise as its pool.</p>;
      case 'pile':
        return (
          <>
            <p className="sh-lp-says">
              {rulesPair
                ? "The curve fees at the launch, and the tax left after Flap's share and the burned part, go to the rules; the pile gets its part of them."
                : "The pile gets the tax's rest after Flap's share, and the curve fees at the launch."}
            </p>
            <p className="sh-lp-says">A holder hands tokens in and receives pile × tokens handed in ÷ tokens in circulation.</p>
          </>
        );
      case 'creator':
        return (
          <>
            {portalBox}
            {fee !== undefined ? (
              <p className="sh-lp-says">
                You send <Amount value={fee} decimals={18} symbol="BNB" />
              </p>
            ) : null}
            {checkLine}
          </>
        );
      case 'token':
        return (
          <>
            {fieldsOf(part)}
            {pictureField}
          </>
        );
      default:
        return fieldsOf(part);
    }
  };
  return (
    <section className="sh-lp-page" data-testid="flap-create" data-way="visual">
      <header className="sh-lp-head">
        <h1 className="screen-title">Create a curve sale</h1>
        {help}
      </header>
      <div className="sh-lp-layout">
        <div className="sh-lp-main">
          <LaunchPictureView picture={picture} open={open} onOpen={setOpen} sheetBody={sheetBody} name="Your launch on Flap" coinPicture={coinPicture} />
          {chart}
          {stats}
        </div>
        <div className="sh-lp-side">
          {quote.kind === 'token' ? <MintTestCoin /> : null}
          <section className="sh-pic-card">
            {review}
            {picture.warn.length > 0 ? (
              <ul className="sh-lp-issues" data-testid="create-problems">
                {picture.warn.map((id) => (
                  <li key={id}>
                    <button type="button" data-problem={id} onClick={() => setOpen(id)}>
                      {picture.parts.find((p) => p.id === id)?.name}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="actions">
              {gate ??
                (ready ? (
                  <button type="button" className="btn btn-primary sh-lp-create" disabled={locked || (!canCreate && !firstProblem)} onClick={pressVisual} data-testid="create">
                    {mining ? 'Finding the token address…' : 'Create'}
                  </button>
                ) : null)}
            </div>
            <TxStatus step={tx.step} />
          </section>
          <FlapHappens form={form} symbol={sym} decimals={quote.decimals} refused={refusals} {...(rulesPair ? { rules: rulesForm } : {})} />
        </div>
      </div>
    </section>
  );
}
