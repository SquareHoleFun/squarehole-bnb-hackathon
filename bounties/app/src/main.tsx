import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/plus-jakarta-sans/wght.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/app.css';
import './styles/platform-bar.css';
import { App } from './App';
import { PlatformBar, PlatformFooter } from './components/PlatformBar';
import { AppProvider } from './lib/app-context';
import { checkReadChain } from './lib/chain';
import { fetchConfig, type Loaded } from './lib/config';
import { SiteSignInProvider } from './lib/site-signin';
import { WalletProvider } from './lib/wallet';

const FALLBACK_RPC = ['https://bsc-testnet-rpc.publicnode.com'];
const FALLBACK_EXPLORER = 'https://testnet.bscscan.com';

/**
 * Starts from the deployment file beside the page, validated as a whole, and read endpoints that answer chain 97.
 * On any failure the page says why and does nothing else: no reads, no writes.
 */
function Root() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    void (async () => {
      const file = await fetchConfig();
      if (!file.ok) return setLoaded(file);
      const reads = await checkReadChain(file.config);
      setLoaded(reads.ok ? { ...file, config: { ...file.config, rpcUrls: reads.rpcUrls, rpcUrl: reads.rpcUrls[0]! } } : reads);
    })();
  }, []);
  if (!loaded) return null;
  if (!loaded.ok) {
    return (
      <WalletProvider rpcUrls={FALLBACK_RPC} explorer={FALLBACK_EXPLORER}>
        <PlatformBar />
        <main className="main">
          <p className="refusal" role="alert" data-testid="blocked">
            The page cannot start: {loaded.problem}.
          </p>
        </main>
        <PlatformFooter />
      </WalletProvider>
    );
  }
  return (
    <AppProvider config={loaded.config}>
      <WalletProvider rpcUrls={loaded.config.rpcUrls} explorer={loaded.config.explorer}>
        <App />
      </WalletProvider>
    </AppProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SiteSignInProvider>
      <Root />
    </SiteSignInProvider>
  </StrictMode>,
);
