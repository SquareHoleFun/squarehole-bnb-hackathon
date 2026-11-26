import { CastCharacter } from '@squarehole/design';
import { DEMO_CHAIN_ID, DEMO_NOW } from '@squarehole/domain';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { DATA_LABELS, useDataSource, type DataSourceValue } from '../features/data-source';
import { TESTNET } from '../features/data-source/testnet';
import { DisclosureIcon } from '../features/fit-pair/FitParts';
import { formatAsOf } from '../features/feed/format';
import { PRIVACY_PATH, RESTRICTED_COUNTRIES, TERMS_PATH, TEST_NETWORK_LINK, TermsText } from '../features/legal';
import { CopyButton } from '../features/pair/CopyButton';
import { BOX0_BUY_SPLIT, BOX0_SELL_SPLIT } from './about-facts';
import {
  BOX_CARD,
  COINS_CARD,
  CURVE_CARD,
  FAILURE_CARD,
  FEES_CARD,
  IN_APP_TRADING,
  LEGAL_LEAD,
  MISFITS_CARD,
  MISFITS_SHOWN,
  V2_SPLIT_SHOWN,
  MORE_LEAD,
  MORE_RISKS,
  OURS_CARD,
  OUR_BOXES,
  OURS_SHOWN,
  TRADING_CARD,
  termsLabel,
  type AboutCardCopy,
  type AboutFigure,
  type OurBox,
} from './about-content';
import { BoxGlyph, ChartGlyph, ClockGlyph, CoinGlyph, CurveGlyph, FailureSteps, GemGlyph, LinkOutGlyph, ListGlyph, SplitBar, TaxBars, TermsGlyph, WarningGlyph } from './about-visuals';
import { PAGE_TITLE_ID, PageHeading, usePageTitle } from './page-parts';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

interface SourceFacts {
  readonly network: string;
  readonly data: string;
  /** Only where the build's manifest names one (local chains, a Sepolia registry). */
  readonly deployment: string | null;
  /** A test network's tokens have no value. */
  readonly testnet: boolean;
}

/**
 * The status facts of the source on screen (SH-C review): the Demo keeps the Demo's words; a chain source states the
 * chain it reads and that figures come from it. Never "mock data" or "not deployed" beside real chain data.
 */
function sourceFacts(source: DataSourceValue): SourceFacts {
  if (DEMO_BUILD && source.id === 'local') {
    const commit = source.deployment?.gitCommit ?? null;
    const dirty = source.deployment?.gitDirty === true ? ', uncommitted changes' : '';
    return {
      network: `Local anvil chain (${source.chainId})`,
      data: 'Read from the chain; each page shows its block and time',
      deployment: commit ? `Local anvil deployment (manifest commit ${commit.slice(0, 10)}${dirty})` : 'Local anvil deployment (manifest commit unknown)',
      testnet: true,
    };
  }
  // The production site's one source is Sepolia (no Demo, no local chain).
  if (!DEMO_BUILD || source.id === 'sepolia') {
    const registry = source.deployment?.registry ?? null;
    return { network: `${DATA_LABELS.sepolia} (${source.chainId})`, data: 'Read from the chain; each page shows its block and time', deployment: registry ? `${TESTNET.networkName} test deployment (registry ${registry})` : null, testnet: true };
  }
  return demoFacts();
}

/** The Demo's facts (a function, so a production bundle keeps none of them). */
const demoFacts = (): SourceFacts =>
  DEMO_BUILD
    ? { network: `Local chain ${DEMO_CHAIN_ID}`, data: `Fixed at ${formatAsOf(DEMO_NOW) ?? DEMO_NOW}`, deployment: null, testnet: false }
    : { network: '', data: '', deployment: null, testnet: false };

/** A figure longer than this takes two columns (risks.css), so a number never breaks inside itself. */
const WIDE_FIGURE = 9;

/** Figures first: the value large, its 1-3 word label under it (a <dl>, read label then value). */
function Figures({ figures }: { figures: readonly AboutFigure[] }) {
  return (
    <dl className="sh-about-figures">
      {figures.map((figure) => (
        <div key={`${figure.label}:${figure.value}`} className="sh-about-figure" data-wide={figure.value.length > WIDE_FIGURE ? '' : undefined}>
          <dt>{figure.label}</dt>
          <dd>{figure.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** "Details" behind a disclosure, named after its card for screen readers. */
function More({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="sh-fit-details sh-about-more">
      <summary>
        <span className="sh-fit-details__chevron" aria-hidden="true">
          <DisclosureIcon />
        </span>
        Details<span className="sh-visually-hidden">{`: ${title}`}</span>
      </summary>
      {children}
    </details>
  );
}

/**
 * One section: icon and a short title, the figures, a picture, one sentence, then the details and the Terms clause.
 * Exported for the tests of the trading card the other build shows (SH-ALPHA-NOTICE).
 */
export function AboutCard({ copy, icon, visual }: { copy: AboutCardCopy; icon: ReactNode; visual?: ReactNode }) {
  return (
    <section className="sh-detail-card sh-about-card" aria-labelledby={copy.id} data-card={copy.id}>
      <div className="sh-about-card__head">
        <span className="sh-about-card__icon">{icon}</span>
        <h2 id={copy.id} className="sh-detail-card__title">
          {copy.title}
        </h2>
      </div>
      <Figures figures={copy.figures} />
      {visual}
      <p className="sh-about-card__lead">{copy.lead}</p>
      <More title={copy.title}>
        <ul className="sh-facts">
          {copy.details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {/* The Sepolia test site's test network notice has no sections to cite (SH-TA-02). */}
        {TEST_NETWORK_LINK ? null : (
          <p className="sh-about-more__terms">
            <Link to={`${TERMS_PATH}#terms-${copy.terms[0] ?? '1'}`}>{termsLabel(copy.terms)}</Link>
          </p>
        )}
      </More>
    </section>
  );
}

function FeesVisual() {
  return (
    <div className="sh-about-splits">
      <SplitBar title="Other boxes · each side" parts={V2_SPLIT_SHOWN} />
      {(import.meta.env?.SH_BNB !== true && MISFITS_SHOWN) ? <SplitBar title="Box 0 · buys (ETH)" parts={BOX0_BUY_SPLIT} /> : null}
      {(import.meta.env?.SH_BNB !== true && MISFITS_SHOWN) ? <SplitBar title="Box 0 · sells (FIT)" parts={BOX0_SELL_SPLIT} /> : null}
    </div>
  );
}

/** The Collector, the cast's NFT collector (storytelling only, Terms 5.22): box 0 is a collection. */
function MisfitsVisual() {
  return <CastCharacter id="collector" size={96} caption={false} className="sh-about-art" />;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** A box's contract address to check and copy, or, before its deployment, the marked open item that stands in for it. */
export function OurBoxAddress({ box }: { box: OurBox }) {
  if (!ADDRESS.test(box.address)) {
    return (
      <span className="sh-about-ours__address">
        <TermsText text={box.address} />
      </span>
    );
  }
  return (
    <span className="sh-about-ours__address">
      <code>{box.address}</code>
      <CopyButton value={box.address} label={`Copy the contract address of ${box.name}`} />
    </span>
  );
}

/** Square Hole's own boxes (F133): name, box number and token, then the address. Never a badge on the boxes themselves. */
function OurBoxes() {
  return (
    <ul className="sh-about-ours">
      {OUR_BOXES.map((box) => (
        <li key={box.label} className="sh-about-ours__box">
          <span className="sh-about-ours__name">{box.name}</span>
          <span className="sh-about-ours__meta">{`${box.label} · ${box.token}`}</span>
          <OurBoxAddress box={box} />
        </li>
      ))}
    </ul>
  );
}

/** The other risks: a grid of 1-3 word labels, one sentence behind each. */
function MoreRisks() {
  return (
    <section className="sh-detail-card sh-about-card" aria-labelledby="risks-more" data-card="risks-more">
      <div className="sh-about-card__head">
        <span className="sh-about-card__icon">
          <WarningGlyph />
        </span>
        <h2 id="risks-more" className="sh-detail-card__title">
          More risks
        </h2>
      </div>
      <p className="sh-about-card__lead">{MORE_LEAD}</p>
      <ul className="sh-about-risks">
        {MORE_RISKS.map((risk) => (
          <li key={risk.label}>
            <details className="sh-fit-details sh-about-risk">
              <summary>
                <span className="sh-fit-details__chevron" aria-hidden="true">
                  <DisclosureIcon />
                </span>
                {risk.label}
              </summary>
              <p>{risk.text}</p>
            </details>
          </li>
        ))}
      </ul>
      {TEST_NETWORK_LINK ? null : (
        <p className="sh-about-more__terms">
          <Link to={`${TERMS_PATH}#terms-6`}>Terms, Section 6: every risk</Link>
        </p>
      )}
    </section>
  );
}

/** Who may use Square Hole, and the links to the full Terms and the privacy notice (always visible). */
function LegalCard() {
  const places = RESTRICTED_COUNTRIES.map((country) => country.short.replace(/^the /, '')).join(' · ');
  return (
    <section className="sh-detail-card sh-about-card" aria-labelledby="risks-legal" data-card="risks-legal">
      <div className="sh-about-card__head">
        <span className="sh-about-card__icon">
          <TermsGlyph />
        </span>
        <h2 id="risks-legal" className="sh-detail-card__title">
          Terms
        </h2>
      </div>
      <Figures
        figures={[
          { value: '18+', label: 'Age' },
          { value: places, label: 'Not for' },
          { value: 'Sanctioned', label: 'Not for' },
        ]}
      />
      <p className="sh-about-card__lead">{LEGAL_LEAD}</p>
      <ul className="sh-about-links">
        {TEST_NETWORK_LINK ? (
          <li>
            <Link to={TERMS_PATH}>{TEST_NETWORK_LINK}</Link>
          </li>
        ) : (
          <>
            <li>
              <Link to={TERMS_PATH}>Terms of Use</Link>
            </li>
            <li>
              <Link to={`${TERMS_PATH}#terms-6`}>Risks · Section 6</Link>
            </li>
            <li>
              <Link to={`${TERMS_PATH}#terms-11`}>Fees · Section 11</Link>
            </li>
            <li>
              <Link to={PRIVACY_PATH}>Privacy notice</Link>
            </li>
          </>
        )}
        {/* SH-THIRD-PARTY-NOTICES integrator request 1: every production build carries the file at its root (G07). */}
        {import.meta.env?.SH_PRODUCTION ? (
          <li>
            <a href={`${import.meta.env.BASE_URL}third-party-notices.txt`}>Third-party notices</a>
          </li>
        ) : null}
      </ul>
    </section>
  );
}

/**
 * `/about/risks` (UI-03; SH-V2-FE7 rewrite for core v2): what a box is, the curve and graduation, fees and claim-only
 * payouts, failure and its claim without end, listed coins, box 0 and the Misfits, Square Hole's own boxes by address
 * (F133, SH-V2-FE10), then the other risks and the Terms.
 * Numbers and pictures first, one sentence per card, the rest behind "Details", each pointing to its clause.
 */
export function RisksPage() {
  usePageTitle('About & risks');
  const source = useDataSource();
  const facts = sourceFacts(source);
  return (
    <section className="sh-page sh-risks" aria-labelledby={PAGE_TITLE_ID}>
      <div className="sh-risks__intro sh-detail-card">
        <CastCharacter id="sorter" size={84} caption={false} className="sh-risks__art" />
        <div className="sh-risks__intro-body">
          <PageHeading>About &amp; risks</PageHeading>
          <p className="sh-page__lede">
            {TEST_NETWORK_LINK ? (
              <>
                How a box works, in numbers. Read the <Link to={TERMS_PATH}>{TEST_NETWORK_LINK.toLowerCase()}</Link> first.
              </>
            ) : (
              <>
                How a box works, in numbers. The <Link to={TERMS_PATH}>Terms of Use</Link> say it in full.
              </>
            )}
          </p>
          <dl className="sh-risks__status" data-source={source.id}>
            <div>
              <dt>Network</dt>
              <dd>{facts.network}</dd>
            </div>
            <div>
              <dt>Data</dt>
              <dd>{facts.data}</dd>
            </div>
            {facts.deployment ? (
              <div>
                <dt>Deployment</dt>
                <dd>{facts.deployment}</dd>
              </div>
            ) : null}
            {facts.testnet ? (
              <div>
                <dt>Test tokens</dt>
                <dd>No value</dd>
              </div>
            ) : null}
            <div>
              <dt>Audit</dt>
              <dd>No outside audit</dd>
            </div>
            <div>
              <dt>In-app trading</dt>
              <dd>{IN_APP_TRADING}</dd>
            </div>
            <div>
              <dt>Payouts</dt>
              <dd>Claim only</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="sh-about-grid">
        <AboutCard copy={BOX_CARD} icon={<BoxGlyph />} />
        <AboutCard copy={CURVE_CARD} icon={<CurveGlyph />} visual={<TaxBars />} />
        <AboutCard copy={FEES_CARD} icon={<CoinGlyph />} visual={<FeesVisual />} />
        <AboutCard copy={FAILURE_CARD} icon={<ClockGlyph />} visual={<FailureSteps />} />
        <AboutCard copy={COINS_CARD} icon={<ChartGlyph />} />
        {(import.meta.env?.SH_BNB !== true && MISFITS_SHOWN) ? <AboutCard copy={MISFITS_CARD} icon={<GemGlyph />} visual={<MisfitsVisual />} /> : null}
        {OURS_SHOWN ? <AboutCard copy={OURS_CARD} icon={<ListGlyph />} visual={<OurBoxes />} /> : null}
        <MoreRisks />
        <AboutCard copy={TRADING_CARD} icon={<LinkOutGlyph />} />
        <LegalCard />
      </div>

      <p>
        <Link to="/">Back to the feed</Link>
      </p>
    </section>
  );
}
