/**
 * The About tab: the tagline and one line (the launch's, with N from the data: the vault's once read), then the facts in
 * words: what is in the box, each fee side's kind (a sell flagged in one line, F70; a holder payout with "Pending legal
 * review", F74 U1), the fee cap (amount first), the royalty, the fixed set-up, pair asset, deadline (the Misfits have
 * none, F44 F4), the collection contract with its links (F71 (1)), the collection's cover and page (F74 U3), the site
 * links, Terms, and every contract address behind "Show all". "Kind" is not used here: on the creation page it names
 * the fee sides ("Box kind").
 */
import { Link } from 'react-router';
import { TEST_NETWORK_LINK } from '../legal';
import { FitContracts } from '../fit-pair/FitContracts';
import { formatCount } from '../fit-pair/fit-format';
import type { FitMarketTarget } from '../fit-pair/fit-target';
import { CopyButton } from '../pair/CopyButton';
import { KIND_LABELS, type BoxRecord, type BoxState } from './box-model';
import { collectionContract } from './collection-contract';
import { sellsLine, sideWords } from './fee-kinds';
import { HOLDERS_PENDING } from './spec-network';
import { MISFITS_TAGLINE, misfitsLine } from './misfits-content';
import { linkHref, type LinkKey } from './site-links';
import { bpsText, ethText } from './spec-record';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

const LINK_LABELS: Readonly<Record<LinkKey, string>> = { website: 'Website', x: 'X', telegram: 'Telegram' };

/** The collection contract: its address (or what stands in for it), the F71 label, and the explorer and marketplace links or why there are none. */
export function CollectionRow({ record }: { record: BoxRecord }) {
  const row = collectionContract(record);
  return (
    <div className="sh-box-collection" data-collection={row.address ? 'address' : 'none'}>
      <dt>{row.label}</dt>
      <dd>
        {row.address ? (
          <span className="sh-box-kv__address">
            <code>{row.address}</code>
            <CopyButton value={row.address} label={`Copy the ${row.label.toLowerCase()} address`} />
          </span>
        ) : (
          <span>{row.note}</span>
        )}
        {row.verification === 'unverified' ? (
          <span className="sh-status-chip sh-box-collection__badge" data-disclosure="">
            Unverified collection
          </span>
        ) : null}
        {row.address !== null || record.kind !== 'token' ? (
          <span className="sh-box-collection__links">
            {row.explorer.href ? (
              <a href={row.explorer.href} target="_blank" rel="noopener noreferrer">
                Explorer
              </a>
            ) : (
              <span className="sh-muted">{`Explorer · ${row.explorer.reason}`}</span>
            )}
            {row.marketplace.href ? (
              <a href={row.marketplace.href} target="_blank" rel="noopener noreferrer">
                Marketplace
              </a>
            ) : (
              <span className="sh-muted">{`Marketplace · ${row.marketplace.reason}`}</span>
            )}
          </span>
        ) : null}
      </dd>
    </div>
  );
}

function SiteLinksRow({ record }: { record: BoxRecord }) {
  const links = record.spec?.links;
  if (!links) return null;
  const shown = (['website', 'x', 'telegram'] as const).flatMap((key) => {
    const link = linkHref(key, links[key]);
    return link ? [{ key, ...link }] : [];
  });
  if (shown.length === 0) return null;
  return (
    <div>
      <dt>Links</dt>
      <dd className="sh-box-links">
        {shown.map((link) => (
          <span key={link.key}>
            {`${LINK_LABELS[link.key]}: `}
            <a href={link.href} target="_blank" rel="noopener noreferrer">
              {link.text}
            </a>
          </span>
        ))}
      </dd>
    </div>
  );
}

const EXCESS_WORDS: Readonly<Record<'burn' | 'pool' | 'holders', string>> = Object.freeze({ burn: 'burned', pool: 'into the pool', holders: 'to holders' });

/** A note beside a value offered early ("Pending legal review": a holder payout in the Demo, F74 U1), in words. */
const Pending = ({ note }: { note: string | null }) => (note === null ? null : <span className="sh-box-flag">{note}</span>);

/** Each fee side's kind, the sell flags, the cap and the pending notes (a box built from a BoxSpec). */
function FeeRows({ record }: { record: BoxRecord }) {
  const spec = record.spec;
  if (!spec) return null;
  const q = record.pairAsset;
  const t = record.ticker;
  const sells = spec.buyers?.converts === 'sells' || spec.sellers?.converts === 'sells';
  return (
    <>
      <div>
        <dt>Buyers’ fees</dt>
        <dd>
          {sideWords(spec.buyers, t, q)}
          <Pending note={spec.buyers?.pending ?? null} />
        </dd>
      </div>
      <div>
        <dt>Sellers’ fees</dt>
        <dd>
          {sideWords(spec.sellers, t, q)}
          {sells ? <span className="sh-box-flag">{sellsLine(t, q)}</span> : null}
          <Pending note={spec.sellers?.pending ?? null} />
        </dd>
      </div>
      {spec.capRaw > 0n ? (
        <div>
          <dt>Fee cap</dt>
          <dd>
            {`${ethText(spec.capRaw)} ${q} / 30 days · above it ${EXCESS_WORDS[spec.capExcess ?? 'burn']}`}
            <Pending note={spec.capExcess === 'holders' ? HOLDERS_PENDING : null} />
          </dd>
        </div>
      ) : null}
      {spec.royaltyBps > 0 && spec.royaltyTo !== null ? (
        <div>
          <dt>Royalty</dt>
          <dd>{`${bpsText(BigInt(spec.royaltyBps))} of NFT sales, ${spec.royaltyTo === 'creator' ? 'to the creator' : spec.royaltyTo === 'pool' ? 'into the pool' : 'into the fee handling'}`}</dd>
        </div>
      ) : null}
    </>
  );
}

export function AboutPanel({ record, state, target, launchContent, size: n }: { record: BoxRecord; state: BoxState | null; target: FitMarketTarget | null; launchContent: boolean; size: bigint }) {
  const size = formatCount(n);
  const line = launchContent ? misfitsLine(size) : (record.line ?? (record.kind === 'token' ? `${record.name}: a token, paired with ${record.pairAsset}.` : `${record.name}: ${size} ${record.itemNoun}, paired with ${record.pairAsset}.`));
  const figures = DEMO_BUILD ? record.demoFigures : null;
  const deadline = figures === null ? 'None' : state === 'failed' ? `Ended · ${figures.deadlineDays} days` : `${figures.deadlineDays} days from the open`;
  return (
    <div className="sh-box-about">
      <h2 className="sh-visually-hidden">About</h2>
      {launchContent ? <p className="sh-box-about__tagline">{MISFITS_TAGLINE}</p> : null}
      <p className="sh-box-about__line">{line}</p>
      <dl className="sh-box-kv">
        <div>
          <dt>In the box</dt>
          <dd>{record.kind === 'token' ? KIND_LABELS.token : `${KIND_LABELS[record.kind]} · ${size} ${record.itemNoun}`}</dd>
        </div>
        <FeeRows record={record} />
        <div>
          <dt>Set-up</dt>
          <dd>
            {record.setup}
            {/* A Demo box's own set-up line names its holder claims: flagged as a created box flags its side (F74 U1). */}
            {record.spec === null && record.claims === 'holders' ? <Pending note={HOLDERS_PENDING} /> : null}
          </dd>
        </div>
        <div>
          <dt>Paired with</dt>
          <dd>{record.pairAsset === 'ETH' ? 'Native ETH' : record.pairAsset}</dd>
        </div>
        <div>
          <dt>Deadline</dt>
          <dd>{deadline}</dd>
        </div>
        <CollectionRow record={record} />
        {record.spec?.collectionCoverUrl ? (
          <div>
            <dt>Collection cover</dt>
            <dd>
              <img className="sh-box-about__cover" src={record.spec.collectionCoverUrl} width={48} height={48} alt="Collection cover" />
            </dd>
          </div>
        ) : null}
        {record.spec?.externalLink ? (
          <div>
            <dt>Collection page</dt>
            <dd>{record.spec.externalLink}</dd>
          </div>
        ) : null}
        <SiteLinksRow record={record} />
        {record.vault ? (
          <div>
            <dt>Vault</dt>
            <dd className="sh-box-kv__address">
              <code>{record.vault}</code>
              <CopyButton value={record.vault} label="Copy the vault address" />
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Terms</dt>
          <dd>
            <Link to="/about/terms">{TEST_NETWORK_LINK ?? 'Terms of Use'}</Link>
          </dd>
        </div>
      </dl>
      {target ? <FitContracts target={target} /> : null}
    </div>
  );
}
