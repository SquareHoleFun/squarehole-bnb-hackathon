/**
 * SH-318: "What happens" beside a launch picture: 100 made-up trades of one coin each and where their money goes, from
 * the form as it stands (what-happens.ts is the model; what it does not know it shows as shares). It moves no money,
 * reads nothing and calls nothing; it follows the form at once. The words are the platform's where it has them
 * (apps/web box-picture/picture-words.ts: "What happens", "100 trades", the traded line, "About the fees").
 */
import { useId, type ReactNode } from 'react';
import { Amount, Help } from '../components/bits';
import { formatAmount, parsePercentToBps } from '../lib/amounts';
import type { CreateForm } from '../lib/flap';
import type { FourForm } from '../lib/four-create';
import { readRules, RULE_NAME, type RulesForm } from '../lib/rules';
import { WORDS } from './launch-picture';
import { bpsText, BPS, flapFlow, fourFlow, PILE_ONLY, type Flow, type Parts } from './what-happens';

export const TRADES = 100;

export const HAPPENS_WORDS = Object.freeze({
  title: 'What happens',
  hundred: '100 trades',
  about: 'About the fees',
  before: 'Before the launch',
  after: 'After the launch',
  restAfterFlap: "The rest, after Flap's share",
});

type Kind = 'creator' | 'pile' | 'buyburn' | 'burn' | 'rest';

interface Row {
  readonly kind: Kind;
  readonly label: string;
  /** Its width in the bar, in basis points of the bar. */
  readonly bps: bigint;
  /** An amount, or null where the row is a share. */
  readonly amount: bigint | null;
}

const CELL: Readonly<Record<Kind, string>> = Object.freeze({
  creator: 'sh-pic-cell--creator',
  pile: 'sh-pic-cell--pick',
  buyburn: 'sh-pic-cell--buyburn',
  burn: 'sh-pic-cell--burn',
  rest: 'sh-wh-rest',
});

/** The rules' rows in rule order, parts above 0 only; with amounts where the flow has them. */
function ruleRows(parts: Parts, flow: Flow | null): Row[] {
  const rows: Row[] = [];
  if (parts.creator > 0n) rows.push({ kind: 'creator', label: RULE_NAME[1]!, bps: parts.creator, amount: flow ? flow.split.creator : null });
  if (parts.pile > 0n) rows.push({ kind: 'pile', label: RULE_NAME[2]!, bps: parts.pile, amount: flow ? flow.split.pile : null });
  if (parts.burn > 0n) rows.push({ kind: 'buyburn', label: RULE_NAME[3]!, bps: parts.burn, amount: flow ? flow.split.burn : null });
  return rows;
}

/** The creator's parts from the form, PILE_ONLY without rules, null while a part has a problem. */
function partsOf(rules: RulesForm | undefined): Parts | null {
  if (!rules) return PILE_ONLY;
  const r = readRules(rules);
  return r.ok ? { creator: BigInt(r.parts.creator), pile: BigInt(r.parts.pile), burn: BigInt(r.parts.burn) } : null;
}

function Bar({ rows }: { rows: readonly Row[] }) {
  // The key re-mounts the bar when the shares change, so it fills again (CSS only; none with reduced motion).
  const key = rows.map((r) => `${r.kind}${r.bps}`).join('-');
  return (
    <div className="sh-wh-bar" key={key} aria-hidden="true">
      {rows.map((r) => (
        <span key={r.kind} className={CELL[r.kind]} style={{ flexGrow: Number(r.bps) }} />
      ))}
    </div>
  );
}

function Rows({ rows, symbol, decimals }: { rows: readonly Row[]; symbol: string; decimals: number }) {
  return (
    <ul className="sh-wh-rows">
      {rows.map((r) => (
        <li key={r.kind} data-row={r.kind}>
          <span className={`sh-wh-dot ${CELL[r.kind]}`} aria-hidden="true" />
          <span className="sh-wh-label">{r.label}</span>
          <span className="sh-wh-value">{r.amount !== null ? <Amount value={r.amount} decimals={decimals} symbol={symbol} /> : bpsText(r.bps)}</span>
        </li>
      ))}
    </ul>
  );
}

/** "100 trades · 100 BNB traded · fee 1 BNB" (the platform's traded line), or "?" pieces while a rate has a problem. */
function tradedLine(flow: Flow | null, word: 'fee' | 'tax', symbol: string, decimals: number): string {
  if (!flow) return `${HAPPENS_WORDS.hundred} · ${word} ?`;
  return `${HAPPENS_WORDS.hundred} · ${formatAmount(flow.run.traded, decimals)} ${symbol} traded · ${word} ${formatAmount(flow.run.income, decimals)} ${symbol}`;
}

function Panel({ children, about, testId }: { children: ReactNode; about: ReactNode; testId: string }) {
  const titleId = useId();
  return (
    <section className="sh-pic-card sh-wh" aria-labelledby={titleId} data-testid={testId}>
      <header className="sh-wh-head">
        <h2 id={titleId} className="sh-wh-title">
          {HAPPENS_WORDS.title}
        </h2>
        <Help label={HAPPENS_WORDS.about}>{about}</Help>
      </header>
      {children}
    </section>
  );
}

const pct = (text: string): bigint | null => {
  const r = parsePercentToBps(text);
  return r.ok ? r.value : null;
};

export interface FlapHappensProps {
  readonly form: CreateForm;
  readonly symbol: string;
  readonly decimals: number;
  /** The creator's rules, where this rail's deployment has them; without: everything to the pile. */
  readonly rules?: RulesForm;
  /** The form's own refusals (flapRefusals). */
  readonly refused: { readonly tradeFee?: string; readonly burnShare?: string };
}

/** Flap: the curve fees (amounts) and the tax after the launch (shares; Flap's own share has no rate here). */
export function FlapHappens({ form, symbol, decimals, rules, refused }: FlapHappensProps) {
  const fee = refused.tradeFee ? null : pct(form.tradeFee);
  const burned = refused.burnShare ? null : pct(form.burnShare);
  const parts = partsOf(rules);
  const one = 10n ** BigInt(decimals);
  const flow = fee !== null && parts ? flapFlow(TRADES, one, fee, burned ?? 0n, parts) : null;
  const curveRows = parts ? ruleRows(parts, flow ? flow.curve : null) : [];
  const restRows = parts ? ruleRows(parts, null) : [];
  return (
    <Panel
      testId="what-happens"
      about={
        <>
          {`${TRADES} made-up trades of 1 ${symbol} each, buys and sells in turn. `}
          {rules ? 'The curve fees go to the rules at the launch. ' : 'The curve fees go to the pile at the launch. '}
          {"The tax is shown in shares: Flap's share is set by Flap."}
        </>
      }
    >
      <h3 className="sh-wh-sub">{HAPPENS_WORDS.before}</h3>
      <p className="sh-wh-line" data-testid="wh-traded">
        {tradedLine(flow ? flow.curve : null, 'fee', symbol, decimals)}
      </p>
      {flow ? <Bar rows={curveRows} /> : null}
      {parts ? <Rows rows={curveRows} symbol={symbol} decimals={decimals} /> : <p className="sh-wh-line">?</p>}
      <h3 className="sh-wh-sub">{HAPPENS_WORDS.after}</h3>
      {burned !== null && burned > 0n ? (
        <>
          <Bar rows={[{ kind: 'burn', label: WORDS.burned, bps: burned, amount: null }, { kind: 'rest', label: '', bps: BPS - burned, amount: null }]} />
          <Rows rows={[{ kind: 'burn', label: WORDS.burned, bps: burned, amount: null }]} symbol={symbol} decimals={decimals} />
        </>
      ) : null}
      <p className="sh-wh-line">{HAPPENS_WORDS.restAfterFlap}</p>
      {parts ? (
        <>
          <Bar rows={restRows} />
          <Rows rows={restRows} symbol={symbol} decimals={decimals} />
        </>
      ) : (
        <p className="sh-wh-line">?</p>
      )}
    </Panel>
  );
}

export interface FourHappensProps {
  readonly form: FourForm;
  readonly symbol: string;
  readonly decimals: number;
  /** The creator's rules for a tax launch where offered; without: everything to the pile. */
  readonly rules?: RulesForm;
  readonly refused: { readonly buy?: string; readonly sell?: string };
}

/** Four.meme: the curve fee (to the pile) or the token's tax (to the rules, or the pile): amounts. */
export function FourHappens({ form, symbol, decimals, rules, refused }: FourHappensProps) {
  const tax = form.kind === 'tax';
  const buy = refused.buy ? null : pct(form.buy);
  const sell = refused.sell ? null : pct(form.sell);
  const parts = partsOf(tax ? rules : undefined);
  const one = 10n ** BigInt(decimals);
  const flow = buy !== null && sell !== null && parts ? fourFlow(TRADES, one, buy, sell, parts) : null;
  const rows = parts ? ruleRows(parts, flow) : [];
  return (
    <Panel
      testId="what-happens"
      about={
        <>
          {`${TRADES} made-up trades of 1 ${symbol} each, buys and sells in turn. `}
          {tax ? (rules ? "The token's tax goes to the rules." : "The token's tax goes to the pile.") : 'Each curve trade pays its fee into the pile.'}
        </>
      }
    >
      <p className="sh-wh-line" data-testid="wh-traded">
        {tradedLine(flow, tax ? 'tax' : 'fee', symbol, decimals)}
      </p>
      {flow ? <Bar rows={rows} /> : null}
      {parts ? <Rows rows={rows} symbol={symbol} decimals={decimals} /> : <p className="sh-wh-line">?</p>}
    </Panel>
  );
}
