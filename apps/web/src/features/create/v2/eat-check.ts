/**
 * V21-MONEY-01 in the creation flow: whether a box priced in a coin may eat it is the factory's answer, never a rule
 * repeated here. The page asks the release's factory through its public refusal() view (no funds move, no wallet)
 * about a probe: a token box priced in the coin, both sides Eat. The factory refuses it with
 * BoxTokenNeedsCheckedBurn(coin) when the coin is a box coin whose listing records no checked burn: locking such a coin
 * at the dead address would give that address a share of its own box's holder fees that nobody can claim. Every other
 * coin is burned or locked. Only that refusal, naming this coin, refuses Eat; an empty answer allows it; any other
 * refusal or a failed read concludes nothing, and the menu then leaves Eat out.
 */
import { decodeErrorResult, decodeFunctionResult, encodeFunctionData, parseAbi, type Address } from 'viem';
import { factoryV2Abi } from '../../../../../../packages/chain/src/core/v2/abi-v2';
import { PROBE_OWNER } from '../create-checks';
import { DEFAULT_FORM, EMPTY_PAGE, type CoverState } from '../create-model';
import type { TokenReader } from './issuer-powers';
import type { EatAnswer, SiteListing } from './listings';
import { DEFAULT_V2, buildSpecV2 } from './model';
import { pickFor } from './recipes';
import type { BoxSpecV2 } from './spec-types';

/** The planner's refusal for this case (BoxFactoryV2Planner, V21-MONEY-01); the chain package's ABIs cover its interfaces only. */
export const EAT_REFUSALS_ABI = parseAbi(['error BoxTokenNeedsCheckedBurn(address token)']);
/** A stand-in logo hash: the probe is only checked, never created, so it needs no picture. */
const PROBE_COVER: CoverState = Object.freeze({ sha256: `0x${'11'.repeat(32)}`, url: null, bytes: 1, data: '' });

/** The probe put to the factory: a token box priced in `listing`, both sides Eat, everything else the page's defaults. */
export function eatProbeSpec(listing: SiteListing): BoxSpecV2 {
  return buildSpecV2({
    form: { ...DEFAULT_FORM, name: 'Eat check', ticker: 'EAT', contents: 'token', rights: true },
    art: null, commitment: null, cover: PROBE_COVER, collectionCover: null, page: EMPTY_PAGE, owner: PROBE_OWNER, nowMs: 0,
    v2: { ...DEFAULT_V2, pricing: listing.token, buyers: pickFor('eat'), sellers: pickFor('eat'), pile: null },
    listings: [listing],
  });
}

/** The factory's answer for eating `listing`'s coin: refused, allowed, or null when its answer concludes nothing. */
export async function eatAnswerV21(reader: TokenReader, factory: Address, listing: SiteListing): Promise<EatAnswer | null> {
  const data = encodeFunctionData({ abi: factoryV2Abi, functionName: 'refusal', args: [eatProbeSpec(listing), PROBE_OWNER] });
  const reply = await reader.call(factory, data);
  if (reply === null) return null;
  const refusal = decodeFunctionResult({ abi: factoryV2Abi, functionName: 'refusal', data: reply });
  if (refusal === '0x') return 'allowed';
  try {
    const error = decodeErrorResult({ abi: EAT_REFUSALS_ABI, data: refusal });
    return error.args[0].toLowerCase() === listing.token.toLowerCase() ? 'refused' : null;
  } catch {
    // Another refusal (the probe itself refused, say): nothing is concluded about eating this coin.
    return null;
  }
}
