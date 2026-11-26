/**
 * SH-265: where a launch happens, in the BNB Chain testnet build only: the two bounty entries are part of the
 * platform, as a choice at the top of Create. Flap's
 * Pool Launch, Four.meme's OpenFour, or "Own pool", the platform's own Create (this page, unchanged and current): the
 * first two open the launch page that is served beside this site under `LAUNCHES_PATH` (bounties/app). It shares the ways-in
 * row's look (create-picture.css). Any other test network shows nothing.
 */
import { TESTNET } from '@squarehole/chain/write/wallet';

/** Where the site serves the launch page of the two bounty entries (bounties/app, built with this base). */
export const LAUNCHES_PATH = '/launches/';

/** The founder's words (25 November 2026): "Launch on" Flap, Four.meme, Own pool, in that order. */
export const LAUNCH_ON_WORDS = Object.freeze({
  label: 'Launch on',
  flap: 'Flap',
  four: 'Four.meme',
  own: 'Own pool',
});

/** `network`: the build's test network (tests pass both). */
export function LaunchOn({ network = TESTNET.name }: { network?: string }) {
  if (network !== 'bnb') return null;
  return (
    <span className="sh-pic-ways" role="group" aria-label={LAUNCH_ON_WORDS.label} data-launch-on="">
      <span aria-hidden="true">{LAUNCH_ON_WORDS.label}</span>
      <span className="sh-pic-ways__switch">
        <a href={`${LAUNCHES_PATH}#/flap/create`} className="sh-pic-ways__option">{LAUNCH_ON_WORDS.flap}</a>
        <a href={`${LAUNCHES_PATH}#/four/create`} className="sh-pic-ways__option">{LAUNCH_ON_WORDS.four}</a>
        <span className="sh-pic-ways__option" aria-current="true">{LAUNCH_ON_WORDS.own}</span>
      </span>
    </span>
  );
}
