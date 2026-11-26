/**
 * The test network notice (SH-TA-02; founder 2026-10-23: "yes" to a short test-network notice on the public Sepolia
 * test site instead of the draft production Terms; mainnet stays blocked until counsel fills the blanks).
 *
 * Only the Sepolia test build ships it (`SH_BUILD=production SH_TARGET=sepolia`, apps/web/build-target.ts): there the
 * entry gate asks visitors to accept it, `/about/terms` and `/about/privacy` both show it, and every legal link in the
 * app points to it. terms.ts and privacy.ts pick it at build time, so the test site carries none of the production
 * drafts (and none of their open `[COUNSEL|FOUNDER|ENGINEERING …]` items), and the main site carries none of this text.
 *
 * Its words come from the production Terms where they say the same thing (5.3(b), (c) and (e); the gate's eligibility
 * line; the privacy notice's summary), cut to what is true of the test site. It holds no placeholder: a fact it does
 * not have is left out, not marked. The wording rule of terms.ts applies (wording.ts).
 *
 * Version 3 (SH-ALPHA-NOTICE, work package N of docs/design/sepolia-alpha-v1.md; F156, F157) is the closed alpha's:
 * test trades on the box pages, the launch window's tax, tETH for admitted addresses, no points or prizes, withheld
 * pictures (F157 (3)) and a contact. Version 4 (SH-ALPHA-SITE, round 2; F161 (4)): the sign-in with X through Privy,
 * the founder's approval, the claim that links an X account to one wallet, the wallet Privy can make, what Privy and
 * our server keep and for how long, and the review's three fixes (the device line's cookie exception). Draft words: the
 * founder edits them (the session's alpha-notice/draft.md lists every line, old and new). The tax figures are the
 * release's (pinned to about-facts.ts by test-network.test.ts, so this module, which the gate loads, never pulls the
 * box spec in). No trade marker of production-check.ts belongs in these words, and no host of Privy's: the join page
 * loads them at first paint.
 *
 * A new text means a new version: everyone is asked to accept again (set it in apps/web/e2e/terms-state.ts as well).
 */
import type { PrivacyNoticeCopy } from './privacy';
import { deepFreeze, eligibilityBullet, type TermsDocumentCopy, type TermsGateCopy } from './terms-common';
import { TESTNET, type TestnetProfile } from '@squarehole/chain/write/wallet';
import { alphaOn } from '../alpha-sepolia/alpha-on';

export interface TestNetworkNotice {
  /** Stored with each acceptance; a different stored version shows the gate again. */
  readonly version: string;
  /** Date of this version (ISO) and as shown. */
  readonly date: string;
  readonly dateText: string;
  /** The label of every legal link on the test site. */
  readonly link: string;
  readonly title: string;
  readonly lede: string;
  readonly versionLine: string;
  /** What the test site is, one point per line (`**bold**` marks the lead words). */
  readonly points: readonly string[];
  readonly privacy: { readonly title: string; readonly bullets: readonly string[]; readonly deviceTitle: string; readonly device: string };
  /** The same text in the shapes the gate, the Terms page and the privacy page read (terms.ts, privacy.ts). */
  readonly gate: TermsGateCopy;
  readonly document: TermsDocumentCopy;
  readonly privacyNotice: PrivacyNoticeCopy;
}

/**
 * SH-258: the notice of the build's test network. Sepolia's text is version 6, unchanged. BNB Chain testnet
 * (`SH_TESTNET=bnb`) has no closed alpha, no sign-in, no Privy, no starter coins and no Arweave: its text keeps every
 * Sepolia sentence that is true there, with the network's and the coin's names swapped, and leaves the others out
 * (hackathon/evidence/SH-258.md, "Words, old and new"). A new text, so its own version.
 *
 * SH-275: BNB Chain testnet with the alpha's sign-in (`signIn`, alpha-on.ts: its own Privy app) gets back Sepolia's
 * sentences on the sign-in with X, Privy and the claim, where they are true there: no "Closed alpha" point (every first
 * sign-in is approved), no "two transactions" (the open faucet admits nobody: one starter send), no notice cookie (no
 * page lock reads one). Its own version again (hackathon/evidence/SH-275.md).
 *
 * SH-285 (the founder, 26 November, R142-LOGO: "arweave"): where the profile keeps box pictures on Arweave
 * (`switches.arweavePictures`, on for BNB Chain testnet since then) the notice gets back Sepolia's two Arweave sentences
 * word for word: the privacy line on Turbo and the gateways, and the Pictures point's "Its copies on Arweave stay where
 * they are." A new text, so a new version (3 with the sign-in, 4 without); every visitor is asked to accept again.
 */
export function buildTestNetworkNotice(profile: TestnetProfile = TESTNET, signIn: boolean = alphaOn(profile.switches)): TestNetworkNotice {
  const sepolia = profile.name === 'sepolia';
  // SH-275: the alpha's sign-in on another test network than Sepolia.
  const alpha = !sepolia && signIn;
  const net = profile.networkName;
  const keep = <T,>(on: boolean, ...values: T[]): T[] => (on ? values : []);
  // SH-ARWEAVE-PICTURES-WEB: version 2 added the Arweave line below. SH-ALPHA-NOTICE: version 3 is the closed alpha's;
  // SH-ALPHA-SITE: version 4 its sign-in with X through Privy (a new text: every visitor is asked again).
  // SH-198-af1: version 5 discloses the returning-browser cookie.
  // SH-241: version 6 names two providers; the third left the site's endpoint list (SH-240, F201).
  // SH-285: the Arweave sentences come with the profile's switch, under versions of their own; without the switch each
  // text keeps its earlier version.
  const arweave = profile.switches.arweavePictures;
  const version = sepolia ? '2026-11-20-sepolia-test-6'
    : alpha ? (arweave ? '2026-11-26-bnb-test-3' : '2026-11-26-bnb-test-2')
      : (arweave ? '2026-11-26-bnb-test-4' : '2026-11-25-bnb-test-1');
  const dateText = sepolia ? '20 November 2026' : alpha || arweave ? '26 November 2026' : '25 November 2026';
  const title = 'Test network notice';
  // Sepolia's sentences stay literal strings (the build tests look for them in the bundle); BNB's are built.
  const lede = sepolia ? 'This is the Square Hole test site. It runs on the Sepolia test network only.' : `This is the Square Hole test site. It runs on the ${profile.badgeName} test network only.`;
  const versionLine = `Version ${version} · ${dateText}`;
  const points = [
    // F161 (4): testers sign in with X through Privy; the founder approves each X account on the desk.
    ...keep(sepolia, '**Closed alpha.** You sign in with X. We let in the X accounts we approve.'),
    // Second since version 3: the gate's checkbox confirms it, and eleven points no longer fit its window unscrolled.
    `**Who may use it.** ${eligibilityBullet()}`,
    sepolia ? '**Test tokens only.** Tokens, ETH and NFTs on Sepolia are test tokens. They have no value. We do not exchange them for anything of value.'
      : `**Test tokens only.** Tokens, ${profile.coin.symbol} and NFTs on ${net} are test tokens. They have no value. We do not exchange them for anything of value.`,
    // F156 (2): the buy and sell box of the Sepolia builds; version 2's "No real money" point, folded in.
    '**Test trades only.** Box pages buy and sell test tokens only. Nothing on this site uses real money.',
    // F157 (1): window buys go through the box's launch router, which takes the window tax (about-facts.ts ABOUT_FACTS).
    '**Launch tax.** In a box’s first 6.4 minutes, a tax takes 93.2% of a buy at first, falling to 8.1%. The box shows the current tax.',
    // F156 (3), F157 (2), F161 (4): tETH's faucet admits the wallet a tester claims with (design § 2: the desk key's
    // `admitOne`, then the starter SepETH); both transactions are public.
    sepolia ? '**tETH.** A test token with no value. Its faucet opens for the wallet you claim with. Admitting that wallet, and the starter SepETH we send it from our desk address, are public transactions.'
      : '**tETH.** A test token with no value.',
    '**No outside audit.** The smart contracts have not been audited by an outside firm. Our own reviews are not audits.',
    // F156 (1): the alpha gives no rewards (the wording rule never lets that word into app copy, wording.ts APP_COPY_NEVER).
    sepolia ? '**Nothing carries over.** The alpha gives no points or prizes. Using this site, a test network or a test token gives you no right to any future token, NFT, allocation or airdrop.'
      : '**Nothing carries over.** Using this site, a test network or a test token gives you no right to any future token, NFT, allocation or airdrop.',
    // F157 (3): the narrow exception to F149, never for taste; Arweave's copies and the chain are untouched.
    sepolia || arweave ? '**Pictures.** We hide a picture on this site only if it is illegal or comes with a legal notice. Its copies on Arweave stay where they are.'
      : '**Pictures.** We hide a picture on this site only if it is illegal or comes with a legal notice.',
    '**Full Terms before mainnet.** The full Terms of Use come before Square Hole runs on mainnet. Nothing here promises a launch or a date.',
    // F131 R45I: mail to hello@ is forwarded to the founder.
    '**Contact.** hello@squarehole.fun, for questions, feedback and legal notices.',
  ];
  const privacy = {
    title: 'Your data',
    bullets: [
      // F161 (4), SH-ALPHA-SITE (docs/design/alpha-access-privy.md § 5, "Notice lines that change"). Version 2 said "You do
      // not sign up" and "no accounts"; version 3 named Cloudflare Access; the sign-in is X's through Privy now.
      ...keep(sepolia || alpha, 'You sign in with X through Privy, a Stripe company. X shows Privy’s name. Privy and our server log sign-ins.',
      // What alpha-api keeps (infra/server/services/alpha/store.mjs: the sign-up's X number, Privy user ID (privyDid),
      // handle, name and picture, its sign-in times, our decisions, sessions and the claim) and its deletion
      // (alpha/purge.mjs). XR-ALPHA-SITE af2 named the Privy user ID, and Privy's view of a page using a made wallet.
      'Privy receives your X account’s number, handle, name and picture, your IP address, device and sign-in times, and keeps them in the United States. If Privy makes a wallet for you, it also keeps that wallet’s address with your X account. We get your X number, handle, name, picture and Privy user ID from Privy and keep them with your sign-up and sign-in times, our decision and the wallet you claim with, so each account claims once. We delete them 30 days after the alpha.',
      sepolia ? 'To claim, your wallet signs a message that links your X account to that address. Only we keep that link, and Privy too for a wallet it made. The two transactions to it are public.'
        : 'To claim, your wallet signs a message that links your X account to that address. Only we keep that link, and Privy too for a wallet it made.',
      'A wallet Privy makes for you is yours. You and Privy hold its key, and we cannot move its coins. Export the key to keep it after the alpha.'),
      'Wallet addresses and transactions are public on the blockchain, for anyone to see, for good.',
      'Our host sees your IP address with every page request, like any website.',
      ...keep(sepolia || alpha, 'Privy and X see your IP address when you sign in, and Privy whenever a page uses a wallet it made.'),
      'Our own server sees your IP address when the app reads box data from it, and the wallet addresses whose boxes and claims the app shows.',
      // LINKS-WEB (F148): the first sentence of the production notice's BOX_LINKS_PRIVACY (features/core/v2/box-links.ts
      // posts them to our server).
      'If you made a box and sign its links, your browser sends the links and your signature to our server, which keeps them and shows them with the box.',
      sepolia ? 'The app reads Sepolia through PublicNode and Tenderly. They see your IP address and the addresses the app looks up.'
        : `The app reads ${net} through ${profile.rpcProviders}. They see your IP address and the addresses the app looks up.`,
      // SH-ARWEAVE-PICTURES-WEB: draft wording for the founder and counsel (box logos and covers on Arweave, 2026-10-24).
      ...keep(arweave, 'Box pictures are published to Arweave through ArDrive Turbo and load from turbo-gateway.com, arweave.net and goldsky.arweave.net, which see your IP address and which picture you asked for.'),
      // The production notice's line for the contact above.
      'If you write to us, we receive your email address and your message.',
    ],
    deviceTitle: 'What stays on your device',
    // F161 (4) with the review's fix F2 (the notice's own cookie goes to our host where the browser stores nothing else),
    // as the alpha-access suite's run of Privy's real SDK found it (alpha-sepolia/privy-storage.ts).
    device: alpha ? 'The app keeps a few items in your browser so it remembers your choices, and Privy keeps its sign-in tokens there, which it sends only to Privy; the page sends us its identity token once, when you sign in. Our server sets a 7-day sign-in cookie, which your browser sends to it with each page. Our 30-day returning cookie is linked to your X account and sent to our server with each page. It stays after sign-out and lets this browser start sign-in when new sign-ups are closed, but gives no access. Nothing else here is sent to Square Hole. You can remove them all by clearing this site’s data in your browser.'
      : !sepolia ? 'The app keeps a few items in your browser so it remembers your choices. Nothing else here is sent to Square Hole. You can remove them all by clearing this site’s data in your browser.'
      : 'The app keeps a few items in your browser so it remembers your choices, and Privy keeps its sign-in tokens there, which it sends only to Privy; the page sends us its identity token once, when you sign in. Our server sets a 7-day sign-in cookie, which your browser sends to it with each page; so does the notice’s cookie, if the browser cannot store your acceptance otherwise. Our 30-day returning cookie is linked to your X account and sent to our server with each page. It stays after sign-out and lets this browser start sign-in when new sign-ups are closed, but gives no access. Nothing else here is sent to Square Hole. You can remove them all by clearing this site’s data in your browser.',
  };
  const link = 'Test network notice';
  return deepFreeze({
    version,
    date: '2026-11-20',
    dateText,
    link,
    title,
    lede,
    versionLine,
    points,
    privacy,
    gate: {
      title: 'Before you enter the test site',
      status: sepolia ? 'Sepolia test network. Test tokens with no value.' : `${profile.badgeName} test network. Test tokens with no value.`,
      intro: 'Please read this short notice. It applies to the whole test site.',
      bullets: points,
      fullTermsLink: 'Read the test network notice',
      summaryLabel: 'Summary of the test network notice',
      checkbox: 'I have read and accept the test network notice, and I confirm that I am at least 18 and not someone it excludes.',
      decline: 'Decline',
      accept: 'Accept',
      declined: 'You need to accept the test network notice to use the test site. You can close this page, or go back and read it again.',
      reviewAgain: 'Review the notice again',
    },
    document: {
      title,
      status: lede,
      versionLine,
      disputeNotice: '',
      readFirst: { title: 'In short', bullets: points },
      sections: [],
      closing: '',
    },
    privacyNotice: {
      title,
      status: lede,
      versionLine,
      summary: { title: privacy.title, bullets: privacy.bullets },
      sections: [{ id: 'privacy-device', title: privacy.deviceTitle, paragraphs: [privacy.device] }],
    },
  });
}

/** The notice, built once (a pure call: every build but the Sepolia test one reads none of it and drops it). */
export const TEST_NETWORK_NOTICE: TestNetworkNotice = /* @__PURE__ */ buildTestNetworkNotice();
