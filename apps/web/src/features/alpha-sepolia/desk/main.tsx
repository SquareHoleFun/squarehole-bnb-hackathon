/**
 * F161 (4), SH-ALPHA-SITE: the founder's desk entry (apps/web/desk/index.html; its own build, build/alpha-pages.ts),
 * behind Cloudflare Access. Every file it needs lands in `desk/assets/`; nothing of the private app or the join page.
 */
import '@squarehole/design/styles.css';
import '../join/join.css';
import './desk.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DeskPage } from './DeskPage';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <DeskPage />
  </StrictMode>,
);
