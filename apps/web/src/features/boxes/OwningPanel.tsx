/**
 * "Owning one": what owning an item means, in four tiles (a label of at most three words, a line of at most five), with
 * the price picture first for a launch box (F49 M1, price-model.ts).
 *
 * The price picture shows the founder's point ("They all cost the same - the thing to understand is the change in price
 * due to NFTs going in and out") as the vault's mechanics, each checked against packages/domain/src/vault-math.ts and
 * MisfitsVault.sol: the two figures (FIT per item from the vault's quote ⌈(S − E)/n⌉, the market price per 1M tokens),
 * then what going in and out does: taking one out locks that quote in the vault (its 1% fee burned), putting one back
 * releases it (5% burned), and the totals (items outside, tokens locked, tokens outside the vault). In and out keep the
 * FIT per item; only burned tokens lower it, slowly. The ETH price of an item follows the token's market price. It never
 * multiplies the two into an "ETH per Misfit" figure (M1) and never says that locking moves the token's price (a
 * prediction; F23 safe wording). A cost is rounded up, a release down (price-format.ts).
 */
import type { ReactNode } from 'react';
import { formatCount, formatTokenShort } from '../fit-pair/fit-format';
import { InfoButton, InfoPanel, useInfoTip } from '../fit-pair/InfoTip';
import { withArticle } from '../fit-pair/market-names';
import type { BoxRecord, BoxState } from './box-model';
import { InGlyph, LockGlyph, OutGlyph } from './BoxParts';
import { ownItems } from './HeaderSide';
import { costTokens, perMillion, releaseTokens } from './price-format';
import { chargedQuote, priceModel, type PriceInputs } from './price-model';
import { HOLDERS_PENDING } from './spec-network';


/** The id of the tab's lead heading: the header's "Owning one" row moves focus here. */
export const OWNING_LEAD_ID = 'box-owning-lead';

export interface PriceExplainerProps {
  readonly record: BoxRecord;
  readonly state: BoxState | null;
  readonly inputs: PriceInputs | null;
  /** ETH per token from the pool, or null (unverified, unavailable, before any data). */
  readonly priceEthPerToken: string | null;
  /** The latest vault read failed: the figures are the last good read's (said, never hidden). */
  readonly outdated?: boolean;
}

export function PriceExplainer({ record, state, inputs, priceEthPerToken, outdated = false }: PriceExplainerProps) {
  const tip = useInfoTip();
  const model = inputs ? priceModel(inputs) : null;
  const t = record.ticker;
  const one = record.itemNoun.replace(/s$/, '');
  const cost = chargedQuote(model, inputs);
  const release = model ? (model.releasePerItem ?? model.fitPerItem) : null;
  const outWord = state === 'graduated' ? 'outside' : 'placeholders';
  return (
    <section className="sh-box-price" aria-labelledby="box-price-title" data-check={model?.check ?? 'unavailable'}>
      <div className="sh-box-block-head">
        <h3 id="box-price-title">Price</h3>
        {model?.check === 'mismatch' ? (
          <span className="sh-status-chip" data-disclosure="">
            Unverified
          </span>
        ) : null}
        {outdated ? (
          <span className="sh-status-chip" data-disclosure="">
            May be out of date
          </span>
        ) : null}
        <InfoButton tip={tip} label="About the price" />
      </div>
      <InfoPanel tip={tip}>
        <p>{`Every ${one} costs the same ${t}: the vault’s quote, all ${t} not locked in the vault divided by the ${record.itemNoun} inside. Taking one out locks that ${t} in the vault; putting one back releases today’s quote, less 5%. In and out keep that number; only burned ${t} lowers it, slowly.`}</p>
        <p>{`What changes ${withArticle(one)}’s ETH price is ${t}’s market price. Fees on one ${one}, all burned: 1% for a placeholder or a draw, 25% for a named pick, 5% to put one back.`}</p>
        {model?.check === 'mismatch' ? <p>The vault’s own quote does not match this computation, so the page shows the vault’s quote, marked unverified.</p> : null}
        {outdated ? <p>The latest vault read failed: these figures are from the last good read.</p> : null}
        {inputs?.block !== null && inputs?.block !== undefined ? <p>{`Read at block ${formatCount(inputs.block)}.`}</p> : null}
      </InfoPanel>
      <dl className="sh-box-price__row">
        <div>
          <dt>{`1 ${one}`}</dt>
          <dd>
            {cost !== null ? <strong>{`${costTokens(cost)} ${t}`}</strong> : <span className="sh-na">Not available</span>}
            <small>Vault quote</small>
          </dd>
        </div>
        <div>
          <dt>{`1M ${t}`}</dt>
          <dd>
            {priceEthPerToken ? <strong>{`${perMillion(priceEthPerToken)} ETH`}</strong> : <span className="sh-na">Not available</span>}
            <small>Market price</small>
          </dd>
        </div>
      </dl>
      {model && cost !== null && release !== null ? (
        <>
          <ul className="sh-box-flow" aria-label={`What going in and out does to the ${t} in the vault`}>
            <li data-flow="out">
              <span className="sh-box-flow__icon">
                <OutGlyph />
              </span>
              <span className="sh-box-flow__what">{record.kind === 'existing' ? 'Pick one out' : 'Take one out'}</span>
              <span className="sh-box-flow__does">
                <strong>{`+${costTokens(cost)} ${t}`}</strong> locked · {record.kind === 'existing' ? '25%' : '1%'} burned
              </span>
            </li>
            <li data-flow="in">
              <span className="sh-box-flow__icon">
                <InGlyph />
              </span>
              <span className="sh-box-flow__what">Put one back</span>
              <span className="sh-box-flow__does">
                <strong>{`${releaseTokens(release)} ${t}`}</strong> released · 5% burned
              </span>
            </li>
          </ul>
          <p className="sh-box-flow__total">
            <LockGlyph />
            <span>{`${formatCount(model.outside)} ${outWord} · ${formatTokenShort(model.locked, t)} locked · ${formatTokenShort(model.unlocked, t)} outside the vault`}</span>
          </p>
        </>
      ) : null}
    </section>
  );
}

interface Tile {
  readonly icon: ReactNode;
  readonly label: string;
  readonly line: string;
  readonly chip?: string;
}

function nowLine(record: BoxRecord, state: BoxState | null): string {
  if (record.kind === 'token') return `No items: this box is just ${record.ticker}.`;
  const one = record.itemNoun.replace(/s$/, '');
  switch (state) {
    case 'upcoming':
      return 'Now: nothing yet. Opens with the curve.';
    case 'window':
    case 'bonding':
      return record.kind === 'existing' ? 'Now: conversions open at graduation.' : `Now: placeholders only. Each opens as ${withArticle(one)} at graduation.`;
    case 'graduating':
      return 'Now: waiting for graduation.';
    case 'graduated':
      return 'Now: take one out or put it back.';
    case 'failed':
      return 'Now: open your placeholder or hand it back.';
    default:
      return 'Now: not available.';
  }
}

/** The four tiles: the header's "Owning one" row with one line each. */
function tilesOf(record: BoxRecord, state: BoxState | null, cost: bigint | null): Tile[] {
  const t = record.ticker;
  if (record.kind === 'token') {
    const [none, fees] = ownItems(record, state);
    return [
      ...(none ? [{ icon: none.icon, label: none.text, line: 'Token' }] : []),
      ...(fees ? [{ icon: fees.icon, label: fees.text, line: 'Of each 1% fee: 10/15 a side' }] : []),
    ];
  }
  const [take, back, claims, fourth] = ownItems(record, state);
  const fee = record.kind === 'existing' ? '25%' : '1%';
  const tiles: Tile[] = [];
  if (take) tiles.push({ icon: take.icon, label: take.text, line: cost === null ? `The vault’s quote + ${fee} fee` : `${costTokens(cost)} ${t} + ${fee} fee` });
  if (back) tiles.push({ icon: back.icon, label: back.text, line: 'Today’s quote back, less 5%' });
  if (claims) {
    if (record.claims === 'per-item') tiles.push({ icon: claims.icon, label: claims.text, line: 'Fee stream per item', chip: 'Planned' });
    // Holder payouts: the Demo only, "Pending legal review" (F74 U1); nothing is built for them yet (S14).
    else if (record.claims === 'holders') tiles.push({ icon: claims.icon, label: claims.text, line: `For ${t} holders`, chip: HOLDERS_PENDING ?? 'Not built yet' });
    else tiles.push({ icon: claims.icon, label: 'No claims', line: claims.text });
  }
  if (fourth) {
    const line = fourth.text === 'Your companion' ? 'Next to your wallet' : fourth.text === 'Original NFTs' ? 'Held in the box' : fourth.text === 'Shows in My Box' ? 'Taken out, in your wallet' : 'Opens at graduation';
    tiles.push({ icon: fourth.icon, label: fourth.text, line, chip: fourth.text === 'Your companion' ? 'Planned' : undefined });
  }
  return tiles;
}

export function OwningPanel({ record, state, explainer, cost }: { record: BoxRecord; state: BoxState | null; explainer: ReactNode; cost: bigint | null }) {
  return (
    <div className="sh-box-owning">
      <h2 id={OWNING_LEAD_ID} className="sh-box-lead" tabIndex={-1}>
        {nowLine(record, state)}
      </h2>
      {explainer}
      <ul className="sh-box-tiles">
        {tilesOf(record, state, cost).map((tile) => (
          <li key={tile.label} className="sh-box-tile">
            <span className="sh-box-tile__icon">{tile.icon}</span>
            <strong>{tile.label}</strong>
            <span>{tile.line}</span>
            {tile.chip ? <span className="sh-box-example">{tile.chip}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
