import { usePageTitle } from './lib/page-title';
import { useEffect, useState } from 'react';
import { isAddress, type Address } from 'viem';
import { PilePanel } from './components/PilePanel';
import { useApp } from './lib/app-context';
import { listedTokenOf, isListedPile } from './lib/config';
import { PlatformBar, PlatformFooter } from './components/PlatformBar';
import { PressDialog } from './components/PressDialog';
import { FlapCreate } from './screens/FlapCreate';
import { FlapSale } from './screens/FlapSale';
import { FourCreate } from './screens/FourCreate';
import { FourToken } from './screens/FourToken';
import { Home } from './screens/Home';
import { ShopPage } from './screens/ShopPage';

export type Route =
  | { name: 'home' }
  | { name: 'flap' }
  | { name: 'four' }
  | { name: 'pile'; address: Address }
  | { name: 'flap-create' }
  | { name: 'flap-sale'; address: Address }
  | { name: 'four-token'; address: Address }
  | { name: 'four-create' }
  | { name: 'shop'; address: Address }
  | { name: 'unknown' };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const a = parts[1];
  if (parts.length === 0) return { name: 'home' };
  if (parts.length === 1 && parts[0] === 'flap') return { name: 'flap' };
  if (parts.length === 1 && parts[0] === 'four') return { name: 'four' };
  if (parts[0] === 'pile' && a && isAddress(a)) return { name: 'pile', address: a };
  if (parts[0] === 'flap' && a === 'create') return { name: 'flap-create' };
  if (parts[0] === 'flap' && a && isAddress(a)) return { name: 'flap-sale', address: a };
  if (parts[0] === 'four' && a === 'create') return { name: 'four-create' };
  if (parts[0] === 'four' && a && isAddress(a)) return { name: 'four-token', address: a };
  // SH-288: a card shop of our factory.
  if (parts[0] === 'shop' && a && isAddress(a)) return { name: 'shop', address: a };
  return { name: 'unknown' };
}

export function currentEntry(screen: Route['name']) {
  if (screen === 'unknown') return undefined;
  return screen === 'flap-create' || screen === 'four-create' ? 'launch' : 'boxes';
}

function useHash(): string {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

/** While a read fails, the numbers on screen stay and this says how old the oldest of them is. */
function StaleBadge() {
  const { health } = useApp();
  const [, setNow] = useState(0);
  const since = health.failingSince;
  useEffect(() => {
    if (since === null) return;
    const id = window.setInterval(() => setNow((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [since]);
  if (since === null) return null;
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  return (
    <span className="pill stale" role="status" data-testid="stale">
      Numbers from {s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`} ago
    </span>
  );
}

export function App() {
  const route = parseRoute(useHash());
  // Detail screens take their title from their existing chain read.
  usePageTitle(['flap-sale', 'four-token', 'shop'].includes(route.name) ? null : route.name);
  return (
    <>
      <PlatformBar current={currentEntry(route.name)}>
        <StaleBadge />
      </PlatformBar>
      <main className="main">
        {route.name === 'home' && <Home />}
        {route.name === 'flap' && <Home only="flap" />}
        {route.name === 'four' && <Home only="four" />}
        {route.name === 'pile' && <PileRoute pile={route.address} />}
        {route.name === 'flap-create' && <FlapCreate />}
        {route.name === 'flap-sale' && <FlapSale launcher={route.address} key={route.address} />}
        {route.name === 'four-token' && <FourToken token={route.address} key={route.address} />}
        {route.name === 'four-create' && <FourCreate />}
        {route.name === 'shop' && <ShopPage shop={route.address} key={route.address} />}
        {route.name === 'unknown' && (
          <p className="muted">
            Not found. <a href="#/">Home</a>
          </p>
        )}
      </main>
      <PlatformFooter />
      <PressDialog />
    </>
  );
}

/** Any pile may be read; only a pile the deployment file names may be written to (its own token, checked). */
function PileRoute({ pile }: { pile: Address }) {
  const { config } = useApp();
  // The file's pairing is kept: a pile it pairs with a token is writable only while the pile names that token.
  return <PilePanel pile={pile} key={pile} writable={isListedPile(config, pile) ? { token: listedTokenOf(config, pile) } : undefined} />;
}
