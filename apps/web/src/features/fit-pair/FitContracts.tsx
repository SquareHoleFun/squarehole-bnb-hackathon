import { CopyButton } from '../pair/CopyButton';
import { formatBlock, formatEth } from './fit-format';
import type { FitMarketTarget } from './fit-target';
import { DisclosureIcon } from './FitParts';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

type Row = readonly [label: string, value: string | null, copyLabel: string];

/** The record's addresses in reading order, labelled with the names the contracts carry. */
export function contractRows(target: FitMarketTarget): readonly Row[] {
  const n = target.names;
  const launch = n.kind === 'launch';
  const rows: Row[] = [
    [`${n.tokenSymbol} token`, target.token, `Copy the ${n.tokenSymbol} token address`],
    ['Pool id (Uniswap v4)', target.poolId, 'Copy the pool id'],
    ['Pool hook', target.hook, 'Copy the Pool hook address'],
    ['Uniswap v4 PoolManager', target.poolManager, 'Copy the Uniswap v4 PoolManager address'],
    ['Launch router', target.launchRouter, 'Copy the Launch router address'],
    // SH-258 round 3: a BNB build has no box 0 market; its names fold away.
    launch && !(import.meta.env?.SH_BNB === true) ? ['Misfits vault', target.vault, 'Copy the Misfits vault address'] : ['Vault', target.vault, 'Copy the Vault address'],
    launch ? ['Placeholders', target.placeholders, 'Copy the Placeholders address'] : [`Placeholders (${n.placeholderSymbol})`, target.placeholders, 'Copy the Placeholders address'],
    launch
      ? (import.meta.env?.SH_BNB === true ? ['Collection', target.collection, 'Copy the Collection address'] : ['The Misfits collection', target.collection, 'Copy the Misfits collection address'])
      : [`${n.collectionName} (${n.collectionSymbol})`, target.collection, 'Copy the collection address'],
  ];
  // The rest of a deployment, listed only when its record names it (the launch record and the Demo do not today).
  const extra: readonly Row[] = [
    ['Genesis', target.genesis, 'Copy the Genesis address'],
    ['Fee collector', target.collector, 'Copy the Fee collector address'],
    ['Executor (buyback and burn)', target.executor, 'Copy the Executor address'],
    ['Randomness source', target.randomnessSource, 'Copy the Randomness source address'],
  ];
  return [...rows, ...extra.filter(([, value]) => value !== null)];
}

function curveWords(target: FitMarketTarget): string {
  if (target.curveName !== 'misfits') return 'the Sepolia rehearsal curve';
  return target.names.kind === 'launch' && !(import.meta.env?.SH_BNB === true) ? 'the Misfits launch curve (FitLaunchShape)' : `the launch curve, which raises exactly the ${formatEth(target.curve.targetWei, 9)} target`;
}

/**
 * Every address of the market, each with a copy button (identity comes from the market record, never from names), in a
 * closed disclosure. The heading stays outside it so heading navigation finds it; the summary carries a visible chevron.
 */
export function FitContracts({ target }: { target: FitMarketTarget }) {
  const rows = contractRows(target);
  return (
    <section className="sh-detail-card sh-fit-contracts" aria-labelledby="fit-contracts-title">
      <h2 id="fit-contracts-title" className="sh-detail-card__subtitle">
        All contract addresses
      </h2>
      <details className="sh-fit-details">
        <summary>
          <span className="sh-fit-details__chevron" aria-hidden="true">
            <DisclosureIcon />
          </span>
          {'Show all '}
          <span className="sh-visually-hidden">contract addresses</span>
        </summary>
        <dl className="sh-identity sh-fit-contracts__list">
          {rows.map(([label, value, copyLabel]) =>
            value === null ? (
              <div key={label}>
                <dt>{label}</dt>
                <dd className="sh-muted">Not in this market record</dd>
              </div>
            ) : (
              <div key={label}>
                <dt>{label}</dt>
                <dd className="sh-identity__address">
                  <code>{value}</code>
                  <CopyButton value={value} label={copyLabel} />
                </dd>
              </div>
            ),
          )}
        </dl>
        <p className="sh-muted sh-fit-contracts__note">
          {DEMO_BUILD && target.kind === 'demo' ? '' : `${target.label}. `}
          Curve shape: {curveWords(target)}; launch window from block{' '}
          {formatBlock(target.openBlock)}.
        </p>
      </details>
    </section>
  );
}
