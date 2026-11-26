/**
 * The token card's line for a v2 box (F103; ADR-0017 § 6): its token is a non-upgradeable EIP-1167 clone of the
 * release's one T implementation, so a scanner's "proxy" flag can be checked against that implementation's verified
 * code. Said only when the indexer's implementation is the release's (box-v2.ts `tokenFormOf`); a link only where a
 * public explorer exists (Sepolia), through the links allowlist.
 */
import { shortAddress } from '../../fit-pair/fit-format';
import { implementationHref, tokenFormOf, type BoxV2Facts } from './box-v2';
import { CLONE_LINE, IMPLEMENTATION_LINK, IMPLEMENTATION_UNCHECKED } from './v2-words';

export function CloneLine({ facts }: { facts: BoxV2Facts }) {
  const form = tokenFormOf(facts);
  if (form.kind !== 'clone') {
    return (
      <p className="sh-v2-clone" data-token-form="unchecked">
        {IMPLEMENTATION_UNCHECKED}
      </p>
    );
  }
  const href = implementationHref(facts);
  const address = <code title={form.implementation}>{shortAddress(form.implementation)}</code>;
  return (
    <p className="sh-v2-clone" data-token-form="clone">
      <strong>{CLONE_LINE}</strong>
      {' · '}
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {IMPLEMENTATION_LINK} {address}
        </a>
      ) : (
        <>
          Implementation {address}
          <span className="sh-muted">{facts.network === 'demo' ? ' · No links on a local chain' : ' · No public explorer'}</span>
        </>
      )}
    </p>
  );
}
