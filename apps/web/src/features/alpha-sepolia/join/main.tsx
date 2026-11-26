/**
 * F161 (4), SH-ALPHA-SITE: the join page's entry (apps/web/join/index.html; its own build, build/alpha-pages.ts). It
 * loads the design's styles and the legal notice's, and nothing of the private app: every file it needs lands in
 * `join/assets/`, which Caddy serves to anyone.
 */
import '@squarehole/design/styles.css';
import '../../legal/legal.css';
import './join.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { JoinPage } from './JoinPage';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <JoinPage />
  </StrictMode>,
);
