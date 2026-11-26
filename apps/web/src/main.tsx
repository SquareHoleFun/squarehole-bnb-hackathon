import '@squarehole/design/styles.css';
import './shell/shell.css';
import './pages/pages.css';
import './features/brand/loader.css';
import './features/feed/feed.css';
import './features/feed/rows.css';
import './features/feed/cards.css';
import './features/feed/pin.css';
import './features/feed/pin-compact.css';
import './features/feed/controls.css';
import './features/feed/chain.css';
import './features/pair/pair.css';
import './features/pair/pair-chart-trade.css';
import './features/pair/pair-sections.css';
import './pages/risks.css';
import './features/pair/pair-responsive.css';
import './features/fit-pair/fit-head.css';
import './features/fit-pair/fit-curve.css';
import './features/fit-pair/fit-window-tape.css';
import './features/fit-pair/fit-side.css';
import './features/boxes/box-base.css';
import './features/boxes/box-feed.css';
import './features/boxes/box-head.css';
import './features/boxes/box-contents.css';
import './features/boxes/box-panels.css';
import './features/boxes/box-wallet.css';
import './features/core/core.css';
import './features/wallet/wallet.css';
import './features/tx/tx.css';
import './features/create/create.css';
import './features/accounts/accounts.css';
import './features/rewards/rewards.css';
import './features/portfolio/portfolio.css';
import './features/settings/settings.css';
import './features/legal/legal.css';
import './shell/shell-responsive.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyMotionPreference, readPreferences } from './features/settings';

// Before the first paint, so a saved "Reduce motion" never shows a transition on load.
applyMotionPreference(readPreferences());

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
