import { CurvePanel } from './CurvePanel';
import type { DemoScenario } from './demo-chain';
import { FeeDisclosure } from './FeeDisclosure';
import { FitContracts } from './FitContracts';
import { FitHeader } from './FitHeader';
import type { FitMarketTarget } from './fit-target';
import { LaunchWindow } from './LaunchWindow';
import { PoolCard } from './PoolCard';
import type { LiveDeps } from './live-controller';
import { TradeTape } from './TradeTape';
import { useLivePool, useVaultCounters } from './useLivePool';
import type { VaultCounters } from './direct-source';
import { VaultCard } from './VaultCard';

export interface FitPairViewProps {
  readonly target: FitMarketTarget;
  readonly scenario: DemoScenario;
  /** Test seams: the live transports and the vault read. */
  readonly deps?: LiveDeps;
  readonly readVault?: () => Promise<VaultCounters>;
}

/**
 * The v2 FIT / Misfits pair page (T19), built for a five-second read (founder, 2026-10-01): the header (name, phase
 * chip and its one line, the launch tax whenever it applies, contract address with its copy button, the links out),
 * then the curve card (one freshness chip, the price, the progress band, the drawing, three figures), the launch
 * window and the tape; beside them the vault, the fees and every contract address. One column on phones in that order
 * (DOM order = reading order); on wide screens the vault, fees and contracts sit right of the curve. Explanations are
 * behind (i) buttons and disclosures; every card with invented Demo data says "Demo". A rehearsal's record (the full
 * v2 system on Sepolia) shows the same page in its neutral names.
 */
export function FitPairView({ target, scenario, deps, readVault }: FitPairViewProps) {
  const view = useLivePool(target, scenario, deps);
  const vault = useVaultCounters(target, scenario, readVault);
  const data = view.data;
  const stale = view.freshness === 'stale' || view.freshness === 'unverified';
  return (
    <div className="sh-fit" data-freshness={view.freshness} data-stale={stale}>
      <FitHeader target={target} view={view} />
      <div className="sh-fit-grid">
        <div className="sh-fit-grid__main">
          <CurvePanel view={view} target={target} />
          <LaunchWindow data={data} target={target} />
          <TradeTape data={data} target={target} direct={view.source === 'direct'} />
        </div>
        <div className="sh-fit-grid__side">
          <VaultCard vault={vault} data={data} target={target} />
          <FeeDisclosure data={data} names={target.names} deployment={target.kind} />
          <PoolCard data={data} target={target} />
          <FitContracts target={target} />
        </div>
      </div>
    </div>
  );
}
