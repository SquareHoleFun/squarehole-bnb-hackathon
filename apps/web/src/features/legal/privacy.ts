/**
 * The one-page privacy notice on `/about/privacy` (Fable review S1 / R-25): what the app keeps on the visitor's device,
 * that there are no accounts, that wallet addresses are public on chain, and that the host sees IP addresses. Like the
 * Terms it is a DRAFT pending counsel, uses the same two marks (`**bold**`, `[COUNSEL: …]` placeholders) and the same
 * wording rule, and is readable without accepting the Terms (GATE_FREE_PATHS).
 *
 * `STORED_ON_DEVICE` names every browser-storage key and database the app writes. privacy.test.ts scans the source for
 * localStorage, sessionStorage, IndexedDB and cookie use, so a new stored item cannot ship without a line here.
 *
 * The production build (`SH_BUILD=production`) shows privacy-production.ts instead (SH-V2-FE7, a DRAFT FOR COUNSEL with
 * no Demo), and the Sepolia test build (`SH_TARGET=sepolia`, SH-TA-02) the test network notice's part on privacy
 * (test-network.ts); `PRIVACY_NOTICE` picks one at build time. All show this build's `STORED_ON_DEVICE`.
 */
import { BOX_LINKS_PRIVACY, PRODUCTION_PRIVACY_NOTICE } from './privacy-production';
import { deepFreeze, TERMS_DATE_TEXT } from './terms';
import { TEST_NETWORK_NOTICE } from './test-network';
import { ALPHA_SESSION_COOKIE, PRIVY_BROWSER_STORAGE } from '../alpha-sepolia/privy-storage';
import { SETUP_HINT_ITEM } from '../alpha-sepolia/setup-hint';
import { ALPHA_ON } from '../alpha-sepolia/alpha-on';
import { TESTNET } from '@squarehole/chain/write/wallet';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;
// The Sepolia test site (SH-TA-02, apps/web/build-target.ts): the test network notice instead of the production draft.
const TEST_NETWORK_BUILD = !DEMO_BUILD && import.meta.env?.SH_TEST_NETWORK === true;
// F161 (4), SH-ALPHA-SITE: the Sepolia alpha's sign-in is in this build (the trade literal, build-target.ts).
const ALPHA_BUILD = import.meta.env?.SH_SEPOLIA_TRADE === true;

/** Where a stored item lives. */
export type DeviceStore = 'localStorage' | 'sessionStorage' | 'IndexedDB' | 'cookie';

export interface StoredItem {
  /** The key, cookie or database name, as the browser's developer tools show it. */
  readonly key: string;
  readonly store: DeviceStore;
  /** What it holds, in plain words. */
  readonly what: string;
  /** The source file that writes it (repository-relative; for the sync test, never shown). */
  readonly source: string;
  /**
   * F161 (4): who writes it when not the app's own code: our server (a cookie it sets; `source` names the server file)
   * or Privy's SDK (`source` lists its keys, alpha-sepolia/privy-storage.ts). Unset: the app's code writes it.
   */
  readonly writer?: 'server' | 'privy';
}

/**
 * F161 (4), F166: the Sepolia alpha's items, which `STORED_ON_DEVICE` lists in its builds only: our server's sign-in
 * and returning cookies, Privy's own items and the setup's hint on this device (alpha-sepolia/setup-hint.ts, SH-ALPHA-ONBOARDING).
 * A function, so a build without the alpha's code keeps none of it; privacy.test.ts reads it too, since the unit
 * tests' build holds no alpha code.
 */
export function alphaStoredOnDevice(): readonly StoredItem[] {
  return [ALPHA_SESSION_COOKIE, {
    key: '__Host-alpha_returning',
    store: 'cookie',
    what: 'For 30 days: a marker linked to your X account, sent to our server with each page. It stays after sign-out and lets this browser start sign-in when new sign-ups are closed, but gives no access.',
    source: 'infra/server/services/alpha-api.mjs',
    writer: 'server',
  }, ...PRIVY_BROWSER_STORAGE, SETUP_HINT_ITEM];
}

/** Everything the app keeps in this browser; each item names any transmission to our server. */
export const STORED_ON_DEVICE: readonly StoredItem[] = deepFreeze([
  {
    key: 'squarehole.terms',
    store: 'localStorage',
    // The Sepolia test site's record is the test network notice's acceptance (SH-TA-02).
    what: TEST_NETWORK_BUILD ? 'That you accepted the test network notice: the version and the time.' : 'That you accepted the Terms: the version and the time.',
    source: 'apps/web/src/features/legal/terms-acceptance.ts',
  },
  {
    key: 'squarehole.terms',
    store: 'cookie',
    what: 'The same record, only if this browser blocks local storage. Your browser sends this cookie with requests to our host. No server code of ours reads it.',
    source: 'apps/web/src/features/legal/terms-acceptance.ts',
  },
  {
    key: 'squarehole.settings.v1',
    store: 'localStorage',
    what: 'Your settings: motion and the "/" search shortcut.',
    source: 'apps/web/src/features/settings/preferences.ts',
  },
  {
    key: 'squarehole.data-source.v1',
    store: 'localStorage',
    what: DEMO_BUILD ? 'The data source you chose (the sample data, a local chain or a test network).' : 'The data source you chose.',
    source: 'apps/web/src/features/data-source/data-source.ts',
  },
  {
    key: 'squarehole.feed.pinCollapsed',
    store: 'localStorage',
    what: 'Whether the pinned card on the feed is collapsed.',
    source: 'apps/web/src/features/feed/pin-preference.ts',
  },
  {
    key: 'sh.wallet.last-rdns',
    store: 'localStorage',
    what: 'Which wallet extension you last connected with, by its identifier. Not your address.',
    source: 'apps/web/src/features/wallet/injected-adapter.ts',
  },
  {
    key: 'sh.wallet.connected.v1',
    store: 'localStorage',
    what: 'The browser wallet you connected here and its address, so that it reconnects when you come back, without opening the wallet. Disconnect removes it.',
    source: 'apps/web/src/features/wallet/injected-adapter.ts',
  },
  {
    key: 'squarehole-chain-index',
    store: 'IndexedDB',
    what: 'A copy of public blockchain data the app has already read, so it loads faster.',
    source: 'packages/chain/src/indexer/store.ts',
  },
  {
    key: 'sh.create.draft.v2',
    store: 'sessionStorage',
    what: 'For this tab only: the choices for the box you are launching, your links and whether you confirmed your rights.',
    source: 'apps/web/src/features/create/draft.ts',
  },
  {
    key: 'sh.create.art.v2',
    store: 'sessionStorage',
    what: 'For this tab only: your art’s fingerprints, secret salts, traits and small previews for the box you are launching, never the files.',
    source: 'apps/web/src/features/create/draft.ts',
  },
  {
    key: 'sh.create.cover.v2',
    store: 'sessionStorage',
    what: 'For this tab only: the logo of the box you are launching, as resized here (the copy its fingerprint is taken from).',
    source: 'apps/web/src/features/create/draft.ts',
  },
  {
    key: 'sh.create.collection-cover.v2',
    store: 'sessionStorage',
    what: 'For this tab only: your collection cover, as resized here (the copy its fingerprint is taken from).',
    source: 'apps/web/src/features/create/draft.ts',
  },
  {
    key: 'sh.create.page.v2',
    store: 'sessionStorage',
    what: 'For this tab only: the banner and teaser pictures of the box you are launching, as resized here.',
    source: 'apps/web/src/features/create/draft.ts',
  },
  {
    key: 'sh.create.send.v2',
    store: 'sessionStorage',
    what: 'For this tab only: the box you are creating on chain, your address and the transactions sent for it, so that a reload continues where the chain stands.',
    source: 'apps/web/src/features/create/v2/create-send-store.ts',
  },
  // SH-192 (BOXSPEC-AUTOSAVE): wording for the founder and counsel to review (docs/evidence/SH-BOXSPEC-AUTOSAVE-af1.md).
  {
    key: 'sh.reveal.keep.v1',
    store: 'IndexedDB',
    what: 'For each box you create here: its reveal data (the spec, each item’s fingerprints and secret salt), so its items can still be revealed if your box file is lost. Removed after an attempt is confirmed unsent and its box absent. While the app is open, it checks kept copies on their available chains and removes them once every item is revealed; failed checks or removals retry on later visits.',
    source: 'apps/web/src/features/create/v2/reveal-keep.ts',
  },
  // SH-203: the reveal run's journal (SH-202). Working wording for the founder and counsel to review (docs/evidence/SH-203.md).
  {
    key: 'squarehole-reveal-run-v2',
    store: 'IndexedDB',
    what: 'For each box whose items you reveal here: a record of every reveal this browser starts, written before your wallet is asked: your address, the item numbers, the most it may cost and when it started; then what became of it (refused, sent with or without a transaction id, its block and result) and the times that count toward the wait before an unclear send may be released. So a reload or another tab picks up where the chain stands. It holds no secret salts or pictures. Kept until you clear this site’s data.',
    source: 'apps/web/src/features/core/v2/reveal-indexeddb.ts',
  },
  // SH-258: pictures go to Arweave only where the test network keeps them there (not on BNB Chain testnet).
  ...(TESTNET.switches.arweavePictures ? [{
    key: 'sh.create.v2.arweave',
    store: 'sessionStorage',
    what: 'For this tab only: which of your box’s pictures this tab already published to Arweave, by fingerprint, so none is sent twice.',
    source: 'apps/web/src/features/create/v2/usePicturePublish.tsx',
  } as const] : []),
  // SH-EXISTING-NFTS-E08C: the existing-NFTs add-on's Create flow, local only until its release ticket: the production
  // site has neither the flow nor these keys.
  ...(DEMO_BUILD
    ? [
        {
          key: 'sh.create.set.v1',
          store: 'sessionStorage',
          what: 'For this tab only: the choices for the box of existing NFTs you are launching, its logo as resized here, the collection and the ids you pasted.',
          source: 'apps/web/src/features/create/set/set-draft.ts',
        } as const,
        {
          key: 'sh.create.set-send.v1',
          store: 'sessionStorage',
          what: 'For this tab only: the box of existing NFTs you are creating on chain, its ids, your address and the transactions sent for it, so that a reload continues where the chain stands.',
          source: 'apps/web/src/features/create/set/set-send-store.ts',
        } as const,
      ]
    : []),
  // Kept by the Demo only: the production site writes neither (SH-V2-FE6).
  ...(DEMO_BUILD
    ? [
        {
          key: 'sh.boxes.sample-created.v1',
          store: 'sessionStorage',
          what: 'For this tab only: the sample boxes you created, with small pictures, your links, your address and your rights confirmation.',
          source: 'apps/web/src/features/boxes/created-boxes.ts',
        } as const,
        {
          key: 'sh.sample-tx-scenario',
          store: 'sessionStorage',
          what: 'For this tab only: the transaction scenario you chose for the sample data.',
          source: 'apps/web/src/features/tx/demo-scenario.ts',
        } as const,
      ]
    : []),
  // F161 (4), SH-ALPHA-SITE: the Sepolia alpha's sign-in, in its builds only: our server's cookie and Privy's own items;
  // F166 (SH-ALPHA-ONBOARDING): the setup's hint.
  // SH-258: only where the test network has the alpha's sign-in; SH-275: on BNB Chain testnet only with its own Privy
  // app (alpha-on.ts).
  ...(ALPHA_BUILD && ALPHA_ON ? alphaStoredOnDevice() : []),
]);

export interface PrivacySection {
  /** Anchor and heading id, e.g. "privacy-device". */
  readonly id: string;
  readonly title: string;
  readonly paragraphs?: readonly string[];
  readonly bullets?: readonly string[];
}

/** A privacy notice: front matter, the summary and the sections (the first one lists `STORED_ON_DEVICE`). */
export interface PrivacyNoticeCopy {
  readonly title: string;
  readonly status: string;
  readonly versionLine: string;
  readonly summary: { readonly title: string; readonly bullets: readonly string[] };
  readonly sections: readonly PrivacySection[];
}

/** The privacy notice (rendered on `/about/privacy`): this build's text. */
export const PRIVACY_NOTICE: PrivacyNoticeCopy = DEMO_BUILD ? deepFreeze({
  title: 'Privacy notice',
  status: 'DRAFT pending legal review. It describes this build of the Square Hole app.',
  versionLine: `Draft of ${TERMS_DATE_TEXT}`,
  summary: {
    title: 'In short',
    bullets: [
      'You do not sign up. Square Hole has no accounts and asks for no name, email address or other contact details.',
      'The app keeps your choices on your device only, and sends none of them to us, except links you sign for a box you made.',
      'Wallet addresses and transactions are public on the blockchain, for anyone to see, for good.',
      'Our host sees your IP address with every page request, like any website.',
      'The app contains no analytics, advertising or tracking code.',
    ] as readonly string[],
  },
  sections: [
    {
      id: 'privacy-device',
      title: 'What stays on your device',
      paragraphs: [
        'The app keeps a few items in your browser so it remembers your choices. They stay on this device and are never sent to Square Hole. You can remove all of them at any time by clearing this site’s data in your browser.',
      ],
    },
    {
      id: 'privacy-others',
      title: 'What others see',
      bullets: [
        '**Our host** (Cloudflare Pages) receives your IP address, your browser’s details and the pages you request, as every web host does. [COUNSEL: Cloudflare’s role and how long it keeps these records; FOUNDER: confirm that Cloudflare Web Analytics is off for the site.]',
        '**Blockchain data providers.** With the sample data, the app reads no blockchain. If you choose a test network as the data source, the app reads it through public RPC providers (for Sepolia: PublicNode and Tenderly), which see your IP address and the addresses the app looks up. A local chain runs on your own computer.',
        '**Your wallet** sees every transaction you sign. Wallet extensions run their own code in your browser.',
        '**Sites you open from a link**, such as block explorers and trading venues, see your visit.',
        BOX_LINKS_PRIVACY,
      ],
    },
    {
      id: 'privacy-wallets',
      title: 'Wallet addresses are public',
      paragraphs: [
        'When you connect a wallet, the app reads your address to show your balances and claims. It does not send your address to Square Hole. Your address, and every transaction you sign, is public on the blockchain. Anyone can see it and may link it to you, and nobody can delete it.',
      ],
    },
    {
      id: 'privacy-contact',
      title: 'Who we are and changes',
      paragraphs: [
        'Square Hole is run by [COUNSEL: legal entity, once formed, and a contact for privacy requests; the rights of people in the EU and the UK if they may use the Services]. We update this notice, with a new date, when what the app keeps or shares changes. The Terms of Use (Section 17.6) point here.',
      ],
    },
  ] as readonly PrivacySection[],
}) : TEST_NETWORK_BUILD ? TEST_NETWORK_NOTICE.privacyNotice : PRODUCTION_PRIVACY_NOTICE;

/** Every sentence-bearing string of a notice and its stored items, in reading order (for the wording check); this build's by default. */
export function allPrivacyText(notice: PrivacyNoticeCopy = PRIVACY_NOTICE, stored: readonly StoredItem[] = STORED_ON_DEVICE): string[] {
  return [
    notice.title,
    notice.status,
    notice.summary.title,
    ...notice.summary.bullets,
    ...notice.sections.flatMap((section) => [section.title, ...(section.paragraphs ?? []), ...(section.bullets ?? [])]),
    ...stored.map((item) => item.what),
  ];
}
