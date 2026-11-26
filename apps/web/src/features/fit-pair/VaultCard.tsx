import { Loader } from '../brand';
import { formatBlock, formatCount } from './fit-format';
import type { FitMarketTarget } from './fit-target';
import { LockIcon } from './FitParts';
import { InfoButton, InfoPanel, useInfoTip } from './InfoTip';
import { capitalized, withArticle } from './market-names';
import type { LiveData } from './live-model';
import type { VaultState } from './useLivePool';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

function Count({ value }: { value: bigint | null }) {
  return value === null ? <span className="sh-na">Not available</span> : <>{formatCount(value)}</>;
}

/** Where the counts come from, in the few words the card shows (failures and unavailability are always said). */
function sourceLine(vault: VaultState): string | null {
  if (vault.status === 'loading') return 'Reading the vault…';
  if (vault.status === 'unavailable') return `Unavailable: ${vault.reason} Nothing is shown as zero in its place.`;
  if (DEMO_BUILD && vault.counters.source === 'demo') return null;
  return `Chain read · block ${formatBlock(vault.counters.block ?? 0n)}${vault.failed ? ' · the latest read failed, so these may be out of date' : ''}`;
}

/**
 * The vault counters (BOX-SYSTEM § 1.5, § 2.2 custody), read-only: Misfits (or a rehearsal's items) inside and the
 * placeholders taken (F36 a), labelled "Reserved", and whether the vault is shut or open, in two words beside a lock.
 * Demo counts carry the Demo badge; a rehearsal's test set says so in one line. This page offers no withdraw or return
 * (T19's conversion dialogs are separate work). Custody is counted in items and never mixed with token or ETH amounts.
 */
export function VaultCard({ vault, data, target }: { vault: VaultState; data: LiveData | null; target: FitMarketTarget }) {
  const tip = useInfoTip();
  const counters = vault.status === 'ready' ? vault.counters : null;
  const size = counters?.collectionSize ?? target.collectionSize;
  const graduated = counters?.gateOpen === true || data?.state.phase === 'migrated';
  const source = sourceLine(vault);
  const n = target.names;
  const items = n.items;
  return (
    <section className="sh-detail-card sh-fit-vault" aria-labelledby="fit-vault-title">
      <div className="sh-detail-card__head">
        <h2 id="fit-vault-title" className="sh-detail-card__title">
          {`${n.collectionName} vault`}
        </h2>
        <div className="sh-fit-card-tools">
          <InfoButton tip={tip} label="About the vault" />
        </div>
      </div>
      <InfoPanel tip={tip}>
        <p>
          {graduated
            ? `The vault opened at graduation: ${items} can leave and come back through its own contract. Withdraw and return are not in this app yet.`
            : `Reserved: placeholders taken for ${n.tokenSymbol} during the curve; each opens as ${withArticle(n.item)} at graduation. Until then every ${n.item} stays inside.`}
        </p>
        <p>The pool’s liquidity sits outside the vault. Read-only.</p>
        {n.kind === 'neutral' ? (
          <p>{`The ${formatCount(size)} ${items} commit to made-up traits with no art behind them, so a revealed ${n.item} shows test data.`}</p>
        ) : null}
      </InfoPanel>
      <dl className="sh-fit-vault__counts">
        <div className="sh-fit-vault__count">
          <dt>{`${capitalized(items)} inside`}</dt>
          <dd>
            <strong>
              <Count value={counters?.inside ?? null} />
            </strong>{' '}
            <span className="sh-muted">of {formatCount(size)}</span>
          </dd>
        </div>
        <div className="sh-fit-vault__count">
          <dt>Reserved</dt>
          <dd>
            <strong>
              <Count value={counters?.placeholdersTaken ?? null} />
            </strong>
          </dd>
        </div>
      </dl>
      <p className="sh-fit-vault__shutter" data-open={graduated}>
        <LockIcon />
        <span>{graduated ? 'Open since graduation' : 'Opens at graduation'}</span>
      </p>
      {n.kind === 'neutral' ? (
        <p className="sh-fit-vault__source sh-fit-vault__test sh-muted" data-disclosure="">
          Test set only: made-up traits, no art.
        </p>
      ) : null}
      {source ? (
        <p
          className={vault.status === 'loading' ? 'sh-fit-vault__source sh-muted sh-loader-line' : 'sh-fit-vault__source sh-muted'}
          data-disclosure={vault.status === 'unavailable' || (vault.status === 'ready' && vault.failed) ? '' : undefined}
        >
          {vault.status === 'loading' ? <Loader size="button" decorative /> : null}
          {source}
        </p>
      ) : null}
    </section>
  );
}
