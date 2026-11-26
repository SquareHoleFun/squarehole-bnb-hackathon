import { useEffect, useState, type ReactNode } from 'react';
import { parseEventLogs, type Address, type TransactionReceipt } from 'viem';
import { erc20Abi } from '../abi/feeRules';
import { CREATE_TAX_GAS, fourCoreAbi, fourToolsAbi } from '../abi/openfour';
import { Help, TxStatus } from '../components/bits';
import { PictureField } from '../components/PictureField';
import { useLaunchPictureUrl } from '../lib/pictures/read';
import { useWriteGate } from '../components/WalletBar';
import { sendWrite, useApp, useChainRead, useTx } from '../lib/app-context';
import { PageRefusal } from '../lib/errors';
import { validTimestampOf, checkCreateArgs, checkSigned, FOUR_DEFAULTS, MODULES, readFourForm, signerOffersRulesOnce, signerRefusal, signUrl, type FourForm, type FourKind, type SchemaParam, type Schemas } from '../lib/four-create';
import { readRules, RULES_DEFAULT, rulesRefusals, type RulesForm } from '../lib/rules';
import { RulesFields } from '../components/RulesFields';
import { useWallet } from '../lib/wallet';
import { fourPicture, fourRefusals, type PartId } from '../picture/launch-picture';
import { LaunchPictureView } from '../picture/LaunchPictureView';
import { FourHappens } from '../picture/WhatHappens';
import { LaunchWays, type Way } from '../picture/LaunchWays';
import '../picture/picture.css';

const KINDS: { kind: FourKind; label: string }[] = [
  { kind: 'preset', label: 'Curve fee' },
  { kind: 'tax', label: 'Tax token' },
];

/** The new token in a creation receipt (Core's TokenCreated event), or undefined. */
export function tokenCreatedIn(receipt: TransactionReceipt, core: Address): Address | undefined {
  const l = parseEventLogs({ abi: fourCoreAbi, logs: receipt.logs, eventName: 'TokenCreated' }).find((x) => x.address.toLowerCase() === core.toLowerCase());
  return l ? (l.args as { token: Address }).token : undefined;
}

/** The module schemas of a preset, from OpenFour's Tools on chain (what the signer encodes with). */
async function readSchemas(c: ReturnType<typeof useApp>['client'], tools: Address, presetId: bigint): Promise<Schemas> {
  const all = (await c.readContract({ address: tools, abi: fourToolsAbi, functionName: 'getPresetEncodeSchemas', args: [presetId] })) as readonly { params: readonly SchemaParam[] }[];
  return Object.fromEntries(
    MODULES.map((m, i) => [
      m,
      all[i]!.params.map((p) => ({ name: p.name, abiType: p.abiType, decimals: Number(p.decimals), optional: Boolean(p.optional), defaultValue: p.defaultValue })),
    ]),
  ) as Schemas;
}

/**
 * Create on the Four.meme rail: the form goes to the creation signer on this site (its README is the contract of the
 * call); the visitor's own wallet then sends `Core.createToken(createArgs, signature)` after a simulation (a fixed
 * 12,000,000 gas for a tax token). The new token's page offers to create its pile when it has none yet.
 */
export function FourCreate() {
  const { config, client } = useApp();
  const wallet = useWallet();
  const { ready, gate } = useWriteGate();
  const tx = useTx();
  const o = config.openfour;
  const quotes = o?.quotes ?? [];
  const [form, setForm] = useState<FourForm>({ ...FOUR_DEFAULTS, quote: quotes[0] ?? '' });
  // SH-294: the launch's picture link (`tokenUri`), shared by both ways; '' for none.
  const [launchPicture, setLaunchPicture] = useState('');
  const coinPicture = useLaunchPictureUrl(launchPicture);
  // Visual first and shown by default; Steps one press away. Both ways edit this same form.
  const [way, setWay] = useState<Way>('visual');
  const [open, setOpen] = useState<PartId | null>(null);
  // SH-287: the creator's rules for a tax launch, offered where the deployment names our rules template AND the
  // signer offers the kind (its health answer's kinds, else its refusal of a request with only the kind; asked once per
  // visit of the site: signerOffersRulesOnce).
  const [rulesForm, setRulesForm] = useState<RulesForm>(RULES_DEFAULT);
  const [offered, setOffered] = useState<boolean>();
  const rulesTemplate = o?.rulesTemplate;
  useEffect(() => {
    if (!rulesTemplate) return;
    let live = true;
    void signerOffersRulesOnce(signUrl(import.meta.env.BASE_URL)).then((yes) => {
      if (live) setOffered(yes);
    });
    return () => {
      live = false;
    };
  }, [rulesTemplate]);
  const symbols = useChainRead(
    async (c) =>
      Promise.all(
        quotes.map(
          async (q) =>
            [q, await c.readContract({ address: q, abi: erc20Abi, functionName: 'symbol' }), await c.readContract({ address: q, abi: erc20Abi, functionName: 'decimals' })] as const,
        ),
      ),
    [quotes.join(',')],
  );
  if (!o) {
    return (
      <>
        <LaunchWays rail="four" way={way} onWay={setWay} />
        <p className="empty">No OpenFour launches on this page yet.</p>
      </>
    );
  }
  const core = o.core;
  const decimals = symbols.state === 'ok' ? Object.fromEntries(symbols.value.map(([q, , d]) => [q.toLowerCase(), d])) : {};
  const taxWithTemplate = Boolean(rulesTemplate) && form.kind === 'tax';
  const waitingForSigner = taxWithTemplate && offered === undefined;
  const rulesOn = taxWithTemplate && offered === true;
  const rulesRead = readRules(rulesForm);
  const rulesBad = rulesOn && !rulesRead.ok;
  const read = readFourForm(form, wallet.account, quotes, (q) => decimals[q.toLowerCase()], rulesOn && rulesRead.ok ? rulesRead.parts : undefined);
  const refusal = read.ok ? undefined : read.refusal;
  const locked = tx.busy;
  const names = symbols.state === 'ok' ? Object.fromEntries(symbols.value.map(([q, n]) => [q, n])) : {};

  const create = () => {
    if (!read.ok || rulesBad || waitingForSigner) return;
    const body = { ...read.body, tokenUri: launchPicture };
    void tx
      .run(
        'Create',
        wallet,
        async (press) => {
          if (body.creator.toLowerCase() !== press.account.toLowerCase()) throw new PageRefusal('wallet-changed', 'The wallet changed, so nothing was sent.');
          let res: Response;
          try {
            res = await fetch(signUrl(import.meta.env.BASE_URL), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
              redirect: 'error',
              credentials: 'omit',
            });
          } catch {
            throw new PageRefusal('signer', 'The signer did not answer, so nothing was sent.');
          }
          const answer = await res.json().catch(() => null);
          if (!res.ok) throw new PageRefusal('signer', signerRefusal(res.status, answer));
          const signed = checkSigned(answer, body, Math.floor(Date.now() / 1000));
          if (typeof signed === 'string') throw new PageRefusal('signer', signed);
          // The signed bytes must describe exactly this form's launch on this deployment, valid from the chain's time.
          const presetId = body.kind === 'preset' ? o.presetId : o.taxPresetId;
          if (presetId === undefined) throw new PageRefusal('signer', 'This page has no preset for this launch, so nothing was sent.');
          const [schemas, block, quoteDecimals] = await Promise.all([
            readSchemas(client, o.tools, BigInt(presetId)),
            client.getBlock({ blockTag: 'latest' }),
            client.readContract({ address: body.quote, abi: erc20Abi, functionName: 'decimals' }),
          ]);
          const template = body.kind === 'tax-rules' ? o.rulesTemplate : o.taxTemplate;
          const wrong = checkCreateArgs(signed.createArgs, { body, presetId: BigInt(presetId), template, schemas, quoteDecimals }, block.timestamp);
          if (wrong) throw new PageRefusal('signer', wrong);
          const gas = body.kind === 'preset' ? undefined : CREATE_TAX_GAS;
          const { request } = await client.simulateContract({
            account: press.account,
            address: core,
            abi: fourCoreAbi,
            functionName: 'createToken',
            args: [signed.createArgs, signed.signature],
            gas,
          });
          // The signed request must still be valid by the chain's time when it goes to the wallet.
          const validTimestamp = validTimestampOf(signed.createArgs);
          return sendWrite(
            client,
            wallet,
            request,
            press,
            async () => ((await client.getBlock({ blockTag: 'latest' })).timestamp < validTimestamp ? null : 'the signature has expired'),
            gas,
          );
        },
        (receipt) => (tokenCreatedIn(receipt, core) ? { ok: true } : { ok: false, error: { name: 'not-created', sentence: 'No token was created.' } }),
      )
      .then((receipt) => {
        const token = receipt ? tokenCreatedIn(receipt, core) : undefined;
        if (token) window.location.hash = `#/four/${token}`;
      });
  };

  const refusals = fourRefusals(form, quotes, (q) => decimals[q.toLowerCase()]);
  /** One field, as both ways show it (the same input, the same state, the same refusal). */
  const field = (key: 'name' | 'symbol' | 'raise' | 'buy' | 'sell', label: string, unit?: string) => {
    const text = way === 'visual' ? refusals[key] : refusal?.field === key && wallet.account ? refusal.text : undefined;
    return (
      <label className="field" key={key}>
        <span className="field-label">
          {label}
          {unit ? <span className="muted">{unit}</span> : null}
        </span>
        <input value={form[key]} disabled={locked} onChange={(e) => setForm({ ...form, [key]: e.target.value })} aria-invalid={Boolean(text)} data-testid={`four-${key}`} />
        {text ? (
          <span className="refusal" data-testid="four-refusal">
            {text}
          </span>
        ) : null}
      </label>
    );
  };
  const quoteField = (
    <label className="field">
      <span className="field-label">Raised in</span>
      <select value={form.quote} disabled={locked} onChange={(e) => setForm({ ...form, quote: e.target.value })} data-testid="four-quote">
        {quotes.map((q) => (
          <option key={q} value={q}>
            {names[q] ?? q}
          </option>
        ))}
      </select>
      {way === 'visual' && refusals.quote ? (
        <span className="refusal" data-testid="four-refusal">
          {refusals.quote}
        </span>
      ) : null}
    </label>
  );
  const kinds = (
    <div className="segmented" role="tablist" aria-label="Kind of launch">
      {KINDS.map((k) => (
        <button
          key={k.kind}
          type="button"
          role="tab"
          aria-selected={form.kind === k.kind}
          className={form.kind === k.kind ? 'on' : ''}
          disabled={locked}
          onClick={() => setForm({ ...form, kind: k.kind, sell: k.kind === 'tax' && form.sell === '0' ? '1' : form.sell })}
          data-testid={`four-kind-${k.kind}`}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
  const unitOf = names[form.quote] ?? '';
  const buyField = () => field('buy', form.kind === 'preset' ? 'Buy fee' : 'Buy tax', '%');
  const sellField = () => field('sell', form.kind === 'preset' ? 'Sell fee' : 'Sell tax', '%');
  const help = (
    <Help label="About this launch">
      A bonding curve launch on our OpenFour copy. Curve fee: each curve trade pays its fee into the pile. Tax token: the token&apos;s tax goes
      to the pile through OpenFour&apos;s tax vault, on the curve and after the move to PancakeSwap. 1,000,000,000 tokens, 800,000,000 of them
      on the curve. The creation is signed by this site&apos;s signer for your wallet and is good for 10 minutes.
    </Help>
  );

  if (way === 'steps') {
    return (
      <>
        <LaunchWays rail="four" way={way} onWay={setWay} />
        <section className="sh-panel panel" data-testid="four-create">
          <header className="panel-head">
            <h1 className="screen-title">Create on OpenFour</h1>
            {help}
          </header>
          <fieldset className="plain" disabled={locked} data-testid="four-form">
            {kinds}
            <div className="form-grid">
              {field('name', 'Name')}
              {field('symbol', 'Symbol')}
              <PictureField value={launchPicture} onChange={setLaunchPicture} disabled={locked} chainId={97} />
              {quoteField}
              {field('raise', 'Raise', unitOf)}
              {buyField()}
              {sellField()}
            </div>
          </fieldset>
          {rulesOn ? <RulesFields form={rulesForm} onChange={setRulesForm} disabled={locked} withSays={false} heading="The token's tax goes to" /> : null}
          <div className="actions">
            {gate ??
              (ready ? (
                <button type="button" className="btn btn-primary" disabled={!read.ok || rulesBad || locked || waitingForSigner} onClick={create} data-testid="four-create-btn">
                  Create
                </button>
              ) : null)}
          </div>
          <TxStatus step={tx.step} />
        </section>
      </>
    );
  }

  // The Visual way: the same form, drawn. A press that cannot send opens the first part with a problem.
  const picture = fourPicture({ form, symbol: unitOf, refusals, ...(rulesOn ? { rules: { form: rulesForm, refusals: rulesRefusals(rulesForm) } } : {}) });
  const firstProblem = picture.warn[0] ?? null;
  const press = () => {
    if (read.ok && !rulesBad) create();
    else if (firstProblem) setOpen(firstProblem);
  };
  const tax = form.kind === 'tax';
  const sheetBody = (part: PartId): ReactNode => {
    switch (part) {
      case 'token':
        return (
          <>
            {field('name', 'Name')}
            {field('symbol', 'Symbol')}
            <PictureField value={launchPicture} onChange={setLaunchPicture} disabled={locked} chainId={97} />
          </>
        );
      case 'price':
        return quoteField;
      case 'raise':
        return (
          <>
            {field('raise', 'Raise', unitOf)}
            <p className="sh-lp-says">1,000,000,000 tokens, 800,000,000 of them on the curve.</p>
          </>
        );
      case 'buyers':
        return buyField();
      case 'sellers':
        return sellField();
      case 'tax':
        return rulesOn ? (
          <RulesFields form={rulesForm} onChange={setRulesForm} disabled={locked} withSays heading="The token's tax goes to" />
        ) : (
          <p className="sh-lp-says">
            {tax
              ? "Tax token: the token's tax goes to the pile through OpenFour's tax vault, on the curve and after the move to PancakeSwap."
              : 'Curve fee: each curve trade pays its fee into the pile.'}
          </p>
        );
      case 'pool':
        return <p className="sh-lp-says">When the raise is reached, the token moves to a PancakeSwap pool.</p>;
      case 'pile':
        return <p className="sh-lp-says">A holder hands tokens in and receives pile × tokens handed in ÷ tokens in circulation.</p>;
      case 'creator':
        return <p className="sh-lp-says">The creation is signed by this site&apos;s signer for your wallet and is good for 10 minutes.</p>;
      default:
        return null;
    }
  };
  return (
    <>
      <LaunchWays rail="four" way={way} onWay={setWay} />
      <section className="sh-lp-page" data-testid="four-create" data-way="visual">
        <header className="sh-lp-head">
          <h1 className="screen-title">Create on OpenFour</h1>
          {help}
        </header>
        <div className="sh-lp-layout">
          <LaunchPictureView picture={picture} open={open} onOpen={setOpen} sheetBody={sheetBody} name="Your launch on Four.meme" titles={{ raise: 'Raise', price: 'Raised in', tax: tax ? 'Tax' : 'Fees' }} coinPicture={coinPicture} />
          <div className="sh-lp-side">
            <section className="sh-pic-card">
              {kinds}
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
                    <button type="button" className="btn btn-primary sh-lp-create" disabled={locked || waitingForSigner || ((!read.ok || rulesBad) && !firstProblem)} onClick={press} data-testid="four-create-btn">
                      Create
                    </button>
                  ) : null)}
              </div>
              <TxStatus step={tx.step} />
            </section>
            <FourHappens form={form} symbol={unitOf || '?'} decimals={decimals[form.quote.toLowerCase()] ?? 18} refused={refusals} {...(rulesOn ? { rules: rulesForm } : {})} />
          </div>
        </div>
      </section>
    </>
  );
}
