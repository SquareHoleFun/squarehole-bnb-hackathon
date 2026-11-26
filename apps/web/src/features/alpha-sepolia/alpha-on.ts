/**
 * SH-275: whether this build's pages carry the alpha (the welcome step and "Set me up", the Claim card, the made
 * wallet's resume, the wallet window's claim words, the privacy lines for Privy's items, the About line on a wallet
 * Privy made). The single switch every such page reads, instead of the profile's `alphaGate` alone:
 * - Sepolia (a closed alpha, `alphaOpen` off): `alphaGate`, exactly as before; the server's page lock and the founder's
 *   desk are in front.
 * - BNB Chain testnet (an open-site alpha, `alphaOpen` on): only with a Privy app id of the right form
 *   (privy-config.ts, its own app). With the placeholder the site is as it was before the alpha: no entry, no request
 *   to the sign-in service, no Claim card.
 * The join page itself (its own build) reads the app id directly and says sign-in is not set up yet without one.
 */
import { TESTNET, type TestnetSwitches } from '@squarehole/chain/write/wallet';
import { privyAppIdOf } from './privy-config';

export const alphaOn = (switches: Pick<TestnetSwitches, 'alphaGate' | 'alphaOpen'> = TESTNET.switches, appId: string | null = privyAppIdOf()): boolean =>
  switches.alphaGate && (!switches.alphaOpen || appId !== null);

/** This build: the alpha's parts are on its pages. */
export const ALPHA_ON: boolean = alphaOn();
/** This build: the alpha is on an open site (no page lock), so a visitor without a session gets the way to the join page. */
export const ALPHA_OPEN: boolean = ALPHA_ON && TESTNET.switches.alphaOpen;
