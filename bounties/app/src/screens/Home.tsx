import type { ReactElement } from 'react';
import type { Address } from 'viem';
import { curveLauncherAbi } from '../abi/flap';
import { fourVaultAbi } from '../abi/openfour';
import { fourPhaseWord, readFourToken } from './FourToken';
import { formatBps, shareBps } from '../lib/amounts';
import { useApp, useChainRead, type Loaded } from '../lib/app-context';
import { launchLists, readLaunchEvents } from '../lib/launch-events';
import { allPiles } from '../lib/config';
import { AddressLink, Help, ReadError } from '../components/bits';
import { shortAddress } from '../lib/chain';
import '../styles/rails.css';
import { FourPicture } from '../components/LaunchPicture';
import { LaunchPictureImg } from '../lib/pictures/read';

/** The list part of a rail card: launches once they are read; "No launch yet." only from an answer that says so. */
function Launches<T extends string>({ read, render }: { read: Loaded<T[]>; render: (item: T) => ReactElement }) {
  if (read.state === 'loading') return <p className="muted">Reading…</p>;
  if (read.state === 'error') return <ReadError text="Could not read the launches." testId="launches-error" />;
  if (read.value.length === 0) return <p className="empty">No launch yet.</p>;
  return (
    <ul className="list">
      {read.value.map((x) => (
        <li key={x}>{render(x)}</li>
      ))}
    </ul>
  );
}

/** SH-282: the platform's words for the row of the three lists (its Boxes page carries the same row). */
export const RAIL_WORDS = Object.freeze({ boxes: 'Boxes', flap: 'On Flap', four: 'On Four.meme', group: 'Launch on' });

/**
 * SH-282: at the top of one rail's list, the row the platform's Boxes page shows: Boxes back to the platform (`/`), On
 * Flap and On Four.meme, this list's own entry current.
 */
export function RailsRow({ current }: { current: 'flap' | 'four' }): ReactElement {
  const entry = (rail: 'flap' | 'four', label: string) => rail === current
    ? <span className="rails-row__option" aria-current="page">{label}</span>
    : <a className="rails-row__option" href={`#/${rail}`}>{label}</a>;
  return (
    <div className="rails-row" role="group" aria-label={RAIL_WORDS.group} data-launch-rails="">
      <span className="rails-row__switch">
        <a className="rails-row__option" href="/">{RAIL_WORDS.boxes}</a>
        {entry('flap', RAIL_WORDS.flap)}
        {entry('four', RAIL_WORDS.four)}
      </span>
    </div>
  );
}

/**
 * Home: the launches of both rails. `only` shows one rail (the platform's Create links to `#/flap` and `#/four`). The
 * OpenFour card is left out of home while the deployment file has no OpenFour part, so the page is whole with the Flap
 * rail alone.
 */
export function Home({ only }: { only?: 'flap' | 'four' } = {}) {
  const { config } = useApp();
  const showFlap = only === 'flap' || (only === undefined && config.flap !== undefined);
  const showFour = only === 'four' || (only === undefined && config.openfour !== undefined);
  const piles = allPiles(config);
  // Live launches: the factories' and Core's creation events from the deployment's first block (ONE scan for all of
  // them, shared with the pictures: lib/launch-events.ts), plus the sales and tokens the file names.
  const launches = useChainRead((c) => readLaunchEvents(c, config), [config.fromBlock]);
  const { sales, tokens } = launchLists(config, launches);
  return (
    <div className="home">
      {only ? <RailsRow current={only} /> : null}
      <section className="intro">
        <h1>Trading fees can fill a pile that holders redeem.</h1>
        <p className="muted">The pile&apos;s rule is set at creation. It has no owner.</p>
      </section>
      <div className="rails">
        {showFlap ? (
          <article className="sh-panel rail-card" data-testid="rail-flap">
            <h2>Curve sale, then a pool at the target</h2>
            <p className="muted small">Flap Pool Launch</p>
            {config.flap ? <Launches read={sales} render={(l) => <SaleLine launcher={l as Address} />} /> : <p className="empty">No launch yet.</p>}
            {config.flap ? (
              <a className="btn btn-primary" href="#/flap/create">
                Create
              </a>
            ) : null}
          </article>
        ) : null}
        {showFour ? (
          <article className="sh-panel rail-card" data-testid="rail-openfour">
            <h2>Bonding curve launch with a pile</h2>
            <p className="muted small">OpenFour</p>
            {config.openfour ? <Launches read={tokens} render={(t) => <FourLine token={t as Address} />} /> : <p className="empty">No launch yet.</p>}
            {config.openfour ? (
              <a className="btn btn-primary" href="#/four/create">
                Create
              </a>
            ) : null}
          </article>
        ) : null}
      </div>
      {piles.length > 0 && only === undefined ? (
        <section className="sh-panel rail-card" data-testid="piles">
          <h2>Piles</h2>
          <ul className="list">
            {piles.map((p) => (
              <li key={p.pile}>
                <a href={`#/pile/${p.pile}`}>{p.label ?? shortAddress(p.pile)}</a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <footer className="netline">
        <Help label="Contracts">
          {config.flap ? (
            <>
              Launcher Factory <AddressLink address={config.flap.curveLauncherFactory} />. Portal <AddressLink address={config.flap.portal} />.{' '}
            </>
          ) : null}
          {config.openfour ? (
            <>
              OpenFour Core <AddressLink address={config.openfour.core} />.{' '}
            </>
          ) : null}
        </Help>
      </footer>
    </div>
  );
}

function SaleLine({ launcher }: { launcher: Address }) {
  const info = useChainRead(
    async (c) => {
      const [cfg, p] = await Promise.all([
        c.readContract({ address: launcher, abi: curveLauncherAbi, functionName: 'config' }) as Promise<{ name: string; symbol: string; meta?: string }>,
        c.readContract({ address: launcher, abi: curveLauncherAbi, functionName: 'progress' }) as Promise<{ phase: number; sold: bigint; saleTokens: bigint }>,
      ]);
      return { cfg, p };
    },
    [launcher],
  );
  const v = info.state === 'ok' ? info.value : undefined;
  return (
    <a href={`#/flap/${launcher}`} className="sale-line" data-testid="sale-line">
      <span>
        <LaunchPictureImg link={v?.cfg.meta} size={28} className="launch-picture launch-picture--row" />
        {v ? `${v.cfg.name} · ${v.cfg.symbol}` : shortAddress(launcher)}</span>
      {v ? <span className="muted small">{v.p.phase === 1 ? 'Launched' : v.p.phase === 2 ? 'Missed' : formatBps(shareBps(v.p.sold, v.p.saleTokens)) + ' sold'}</span> : null}
    </a>
  );
}

function FourLine({ token }: { token: Address }) {
  const { config } = useApp();
  const core = config.openfour?.core;
  const info = useChainRead(
    async (c) => {
      if (!core) return undefined;
      const t = await readFourToken(c, core, token);
      const phase = Number(await c.readContract({ address: t.vault, abi: fourVaultAbi, functionName: 'phase' }));
      return { t, phase };
    },
    [core, token],
  );
  const v = info.state === 'ok' ? info.value : undefined;
  return (
    <a href={`#/four/${token}`} className="sale-line" data-testid="four-line">
      <span>
        <FourPicture token={token} size={28} className="launch-picture launch-picture--row" />
        {v ? `${v.t.name} · ${v.t.symbol}` : shortAddress(token)}</span>
      {v ? <span className="muted small">{fourPhaseWord(v.phase, v.t.paused)}</span> : null}
    </a>
  );
}
