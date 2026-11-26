/**
 * F161 (4), SH-ALPHA-SITE: the join page as it ships, with Privy's real SDK behind it (privy-live.tsx through the join
 * page's own door), for the alpha-access suite's run against a stand-in of Privy's service (privy-sdk.spec.mjs). Its
 * one difference from the release's join page is the app ID, the suite's own. Built by vite.config.ts next to this
 * file into .cache/alpha-access/probe and served by the suite's edge at /__probe/; never part of the site.
 */
import '@squarehole/design/styles.css';
import '../../../src/features/legal/legal.css';
import '../../../src/features/alpha-sepolia/join/join.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { JoinPage } from '../../../src/features/alpha-sepolia/join/JoinPage';

/** The audience the suite's alpha-api checks the identity token against (privy-config.ts `STANDIN_APP_ID`). */
const APP_ID = 'standinappid0000000000000';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <JoinPage appId={APP_ID} />
  </StrictMode>,
);
