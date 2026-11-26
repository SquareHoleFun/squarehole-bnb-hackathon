/**
 * F161 (4), SH-ALPHA-SITE: the Sepolia alpha's Privy app, by its public app ID (Privy's dashboard, Configuration > App
 * settings; docs/design/alpha-access-privy.md § 5, "Keys": "The app ID and the verification key are public: a config
 * file"). The release build takes no caller setting (infra/server/app/build.mjs runs a closed environment), so the ID
 * lives here, committed: the founder's production app for https://test-app.squarehole.fun (XR-ALPHA-SITE af1). The
 * placeholder stays as the guard's value: put back, or an ID of another form, and the join page says sign-in is not
 * set up yet and nothing loads Privy. The app secret never comes here (it stays in the dashboard). The second,
 * development app for localhost (section 5, step 3) does not exist yet; this production app answers only its own
 * domain, so a local run cannot sign in with it.
 *
 * The same ID goes to alpha-api as SH_ALPHA_PRIVY_APP_ID (infra/server/services/alpha-api.env.example), with the
 * verification key: alpha-api checks the identity token's audience against it.
 *
 * SH-275: the BNB Chain testnet site has a Privy app of its own, never Sepolia's: the founder's app for the hackathon
 * site (login by X only, identity tokens on, no wallet made at login, its one allowed origin the hackathon site's
 * address, so a local run cannot sign in with it either). Committed as Sepolia's is (a public id). A production build
 * holds its own network's id only (`SH_BNB`, `SH_PRODUCTION` fold the choice); vitest and development builds pick by the
 * profile. The placeholder path stays: a build whose id is the
 * placeholder has no sign-in (the join page says so) and, on the open site, none of the alpha's parts (alpha-on.ts).
 * The same id goes to that deployment's sign-in service as its SH_ALPHA_PRIVY_APP_ID.
 */
import { TESTNET } from '@squarehole/chain/write/wallet';

export const PRIVY_APP_ID_PLACEHOLDER = 'REPLACE_WITH_PUBLIC_PRIVY_APP_ID';
/** The Sepolia alpha's app (the founder's production app for the Sepolia test site). */
const SEPOLIA_PRIVY_APP_ID = 'cmvtgx1tx019q0il8tg89ebfz';
/** The BNB Chain testnet site's own app (SH-275). */
export const BNB_PRIVY_APP_ID = 'cmwwb2y9p00gv0gl9m9im0uve';
/** This build's app: Sepolia's, or the BNB Chain testnet site's. */
export const PRIVY_APP_ID: string = import.meta.env?.SH_BNB === true || (import.meta.env?.SH_PRODUCTION !== true && TESTNET.name === 'bnb') ? BNB_PRIVY_APP_ID : SEPOLIA_PRIVY_APP_ID;

/** The browser suites' builds with the Privy stand-in (build-target.ts `alphaStandinOf`) need an ID of the right form. */
const STANDIN_APP_ID = 'standinappid0000000000000';

/**
 * A Privy app ID as the dashboard shows it (lower-case letters and digits), never the placeholder. A development build
 * with the stand-in takes the stand-in's own (no production build has the literal, so this folds away there).
 */
export const privyAppIdOf = (id: string = import.meta.env?.SH_ALPHA_STANDIN === true ? STANDIN_APP_ID : PRIVY_APP_ID): string | null => (id !== PRIVY_APP_ID_PLACEHOLDER && /^[a-z0-9]{20,40}$/.test(id) ? id : null);
