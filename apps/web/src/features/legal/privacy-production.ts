/**
 * DRAFT FOR COUNSEL (SH-V2-FE7): the privacy notice the production build (`SH_BUILD=production`) shows on
 * `/about/privacy`. The development build keeps its own notice (privacy.ts); privacy.ts picks one at build time.
 *
 * Source: the updated notice of the counsel pack (docs/legal/counsel-pack-2026-10.md, Part 4, 7 October 2026), with
 * no Demo and no local chain, and corrected where the production app does more than that text says: with an indexer
 * configured (the build's `SH_CORE_*_INDEXER_ORIGIN`; optional, hence the [ENGINEERING] item below), the app asks our
 * server for the boxes and claims of the wallets it shows, so that server receives those wallet addresses with the
 * visitor's IP address
 * (features/core/core-client.ts `loadWallet`, features/core/v2/claims-index.ts). docs/evidence/SH-V2-FE7.md has the
 * side-by-side table. The list of stored items is the build's own (`STORED_ON_DEVICE` in privacy.ts).
 *
 * SH-V2-FE9 filled the founder's answers of desk round 45 (F131, 2026-10-11): Cloudflare Web Analytics is on; mail to
 * hello@ and hi@ goes through Cloudflare Email Routing to a Gmail mailbox; on Ethereum mainnet the app reads through
 * Infura, with PublicNode as a fallback, and through our own indexer. The counsel parts of those lines stay.
 * SH-V2-FE10 (F134 R46F): the server's own mainnet provider is no longer called "paid"; (F135) a connected browser
 * wallet is remembered on the device and asked, without opening, on the next visit.
 * LINKS-WEB (F148): a creator who signs a box's links sends them and the signature to our server (the summary's
 * exception and the "Box links" line, `BOX_LINKS_PRIVACY`).
 *
 * Placeholders mark what this text does not know; `pnpm check:production` fails while any of them ships.
 */
import { deepFreeze } from './terms-common';
import type { PrivacyNoticeCopy } from './privacy';

const COUNSEL_SIGN_OFF = '[FOUNDER + COUNSEL: delete "DRAFT pending legal review" once counsel has approved this notice (counsel pack, Question 37).]';

/**
 * LINKS-WEB (docs/design/box-links-v2.md § 5 "Privacy"; F148): what a box creator's signed links send and keep. The
 * design's wording, for the founder and counsel to review; both notices (privacy.ts and this one) carry it.
 */
export const BOX_LINKS_PRIVACY = '**Box links.** If you made a box and sign its links, your browser sends the links and your signature to our server, which keeps them and shows them with the box. They are public and tied to your address. Sign empty links to remove them; our backups keep older versions for up to 7 days.';

function buildProductionPrivacy(): PrivacyNoticeCopy {
  return deepFreeze({
    title: 'Privacy notice',
    status: `DRAFT pending legal review. It describes the Square Hole site and the services we run for it. ${COUNSEL_SIGN_OFF}`,
    versionLine: 'Draft of 11 October 2026',
    summary: {
      title: 'In short',
      bullets: [
        'You do not sign up. Square Hole has no accounts and asks for no name, email address or other contact details.',
        'The app keeps your choices on your device only, and sends none of them to us, except links you sign for a box you made.',
        'Wallet addresses and transactions are public on the blockchain, for anyone to see, for good.',
        'Our host sees your IP address with every page request, like any website.',
        'Our own server sees your IP address when the app reads box data from it, and the wallet addresses whose boxes and claims the app shows.',
        'Our server also sees the IP address of anyone who loads a box’s preview picture, for example when a box link is shared.',
        'If you write to us, we receive your email address and your message.',
        'Apart from Cloudflare Web Analytics, our host’s count of visits, the site contains no analytics, advertising or tracking code.',
      ],
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
          '**Our host** (Cloudflare Pages) receives your IP address, your browser’s details and the pages you request, as every web host does. We also use Cloudflare Web Analytics, Cloudflare’s count of visits and page loads. [COUNSEL: Cloudflare’s role and how long it keeps these records.]',
          '**Our server.** Square Hole runs one server, at api.squarehole.fun, rented from DigitalOcean. It keeps an index of public blockchain data and draws the preview pictures for shared box links. It will also run our automated caller (a "keeper"). The app reads boxes, activity and claims from it. When the app shows a wallet’s boxes or claims, for example on My Box or for the wallet you connected, it asks this server for them, so the server receives that wallet address together with your IP address and browser details. When a website or app shows a preview of a box link, the picture is loaded from this server, which then sees the IP address and browser details of whoever loads it: often the preview service, and sometimes your own device. Our reveal system will run on separate servers. [ENGINEERING: confirm the server the production build reads from; name the reveal servers’ providers, and whether this server is one of them. ENGINEERING + COUNSEL: whether the server keeps access logs and for how long.]',
          '**Blockchain data providers.** On Ethereum mainnet the app reads the chain through Infura, with PublicNode as a fallback, and through our own indexer on our server (above). Infura and PublicNode see your IP address and the addresses the app looks up; our indexer receives the wallet addresses whose boxes and claims the app shows. On our separate test site, the app reads Sepolia through PublicNode and Tenderly. Our server reads mainnet through its own provider; that does not involve your browser.',
          '**Your wallet** sees every transaction you sign. Wallet extensions run their own code in your browser.',
          '**Sites you open from a link**, such as block explorers and trading venues, see your visit.',
          '**Email.** Mail to hello@ or hi@ at squarehole.fun, squarehole.xyz or squarehole.fit is forwarded by Cloudflare Email Routing to a Gmail mailbox. We use your address and message only to answer you. [COUNSEL: how long we keep emails.]',
          '**Social channels.** Our X account and Telegram channel run on those platforms, under their own privacy policies. What you post there is seen by others.',
          BOX_LINKS_PRIVACY,
        ],
      },
      {
        id: 'privacy-wallets',
        title: 'Wallet addresses are public',
        paragraphs: [
          'When you connect a wallet, the app reads your address to show your balances and claims, and asks our server for that address’s boxes and claims (above). For a browser wallet it also keeps a record of the wallet and your address on this device; when you come back, it asks that wallet, without opening it, whether it still shares your address, and if so shows you connected. Disconnect removes that record. Your address, and every transaction you sign, is public on the blockchain. That includes every box you create, every draw, claim and close, and the random numbers used for draws. Anyone can see it and may link it to you, and nobody can delete it.',
        ],
      },
      {
        id: 'privacy-contact',
        title: 'Who we are and changes',
        paragraphs: [
          'Square Hole is run by [COUNSEL: legal entity, once formed, and a contact for privacy requests; the rights of people in the EU and the UK if they may use the Services; who is the controller of the data our server and our email receive, on what legal basis, and for how long it is kept]. We update this notice, with a new date, when what the app keeps or shares changes. The Terms of Use (Section 17.6) point here.',
        ],
      },
    ],
  });
}

/** The production notice, built once (a pure call: the development build, which reads none of it, drops it). */
export const PRODUCTION_PRIVACY_NOTICE: PrivacyNoticeCopy = /* @__PURE__ */ buildProductionPrivacy();
