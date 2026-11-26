import { CopyButton } from '../pair/CopyButton';
import { shortAddress } from './fit-format';
import type { FitMarketTarget } from './fit-target';
import { MarketIcon } from './FitParts';

// The sample data in this build: false on the production site, where every sample branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

/**
 * The token's contract address with its copy button (F37 (2): "real trenchers work with CAs"). On a chain source the
 * row names the network (the sample data's row names nothing: no Demo badge since F130, and its network is in the
 * header's (i)), and a rehearsal's record (neutral names) adds "Rehearsal · test set". Taken out of
 * the pair page's header so the box page can use it: `compact` is the box header's one line ("FIT 0x12…ab Copy"),
 * the full block is the pair page's and the Token tab's.
 */
export function ContractAddress({ target, compact = false }: { target: FitMarketTarget; compact?: boolean }) {
  const names = target.names;
  const copyLabel = `Copy the ${names.tokenSymbol} contract address`;
  if (compact) {
    return (
      <p className="sh-fit-ca sh-fit-ca--compact">
        <MarketIcon names={names} size={18} />
        <strong>{names.tokenSymbol}</strong>
        <code className="sh-fit-ca__short" title={target.token}>
          {shortAddress(target.token)}
        </code>
        <CopyButton value={target.token} label={copyLabel} />
      </p>
    );
  }
  return (
    <div className="sh-fit-ca">
      <div className="sh-fit-label-row">
        <p className="sh-fit-label">Contract address</p>
        {DEMO_BUILD && target.kind === 'demo' ? null : <span className="sh-fit-ca__network">{target.networkLabel}</span>}
        {names.kind === 'neutral' ? (
          <span className="sh-status-chip sh-fit-head__rehearsal" data-disclosure="">
            Rehearsal · test set<span className="sh-visually-hidden">: neutral names, test tokens with no value</span>
          </span>
        ) : null}
      </div>
      <div className="sh-fit-ca__row">
        <code className="sh-fit-ca__address">{target.token}</code>
        <CopyButton value={target.token} label={copyLabel} />
      </div>
    </div>
  );
}
