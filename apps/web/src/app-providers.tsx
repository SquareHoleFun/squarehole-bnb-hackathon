import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { CORE_INDEXER_ORIGINS } from 'virtual:squarehole-deployments';
import { AccountDataProvider, type AccountSources } from './features/accounts';
import { useDataSource } from './features/data-source';
import { FeedDataProvider } from './features/feed/feed-context';
import type { FeedSession } from './features/feed/feed-session';
import type { FeedSourceFor } from './features/feed/feed-sources';
import { termsAcceptance, useTermsAccepted } from './features/legal';
import { useWithheldSource, withheldOriginFor } from './features/pictures/withheld';
import { ClaimFlowProvider } from './features/rewards/claim-flow-context';
import { CHAIN_TX_FLOW_CONFIG, TxFlowConfigProvider } from './features/tx';
import { WalletProvider, type WalletAdapter } from './features/wallet';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

/**
 * One shared query cache (06-ARCHITECTURE). Failed reads are not retried automatically: the feed shows an explicit
 * "Feed unavailable" state with a "Try again" action instead of stalling behind hidden back-off.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
    },
  });
}

export interface AppProvidersProps {
  children: ReactNode;
  /** Test seams; production omits them. */
  queryClient?: QueryClient;
  feedSources?: FeedSourceFor;
  feedSession?: FeedSession;
  walletAdapter?: WalletAdapter;
  accountSources?: AccountSources;
}

/**
 * Every app-wide provider, fed by the current data source (SH-C): the demo fixtures (mock providers, demo link adapter,
 * demo wallet, demo clock) or a chain session (chain providers, chain link adapter, browser wallets on the source's
 * chain, wall-clock deadlines, no demo flows). The App keys this tree by the source id, so switching sources starts
 * with a fresh cache, wallet and flows.
 */
export function AppProviders({ children, queryClient, feedSources, feedSession, walletAdapter, accountSources }: AppProvidersProps) {
  const [client] = useState(() => queryClient ?? createQueryClient());
  const source = useDataSource();
  // SH-WITHHELD-SITE (F157 (3)): our withheld-picture list comes from the API origin this source reads; nothing is
  // read until a picture is about to be fetched (so nothing is asked behind the Terms gate either).
  useWithheldSource(withheldOriginFor(source.id, CORE_INDEXER_ORIGINS));
  // F135: a remembered browser wallet reconnects only once the Terms are accepted (nothing acts behind the gate).
  const termsAccepted = useTermsAccepted(termsAcceptance);
  const { chain } = source;
  const tree = (
    <FeedDataProvider
      sourceFor={feedSources ?? chain?.feedSources}
      session={feedSession}
      links={chain?.links}
      allowScenario={chain ? false : undefined}
    >
      <AccountDataProvider sources={accountSources ?? chain?.accountSources}>
        <WalletProvider
          adapter={walletAdapter}
          targetChainId={source.walletChainId}
          defaultDialog={!DEMO_BUILD || chain ? 'browser' : 'demo'}
          walletKinds={!DEMO_BUILD || chain ? 'browser' : 'demo'}
          localRpcUrl={source.localRpcUrl}
          reconnect={termsAccepted}
        >
          {/*
            Claim requests live above the routes, so a signed claim outlives the page and card that started it. They
            are the pair pages' claims, which the production site does not have (routes.tsx).
          */}
          {DEMO_BUILD ? <ClaimFlowProvider>{children}</ClaimFlowProvider> : children}
        </WalletProvider>
      </AccountDataProvider>
    </FeedDataProvider>
  );
  return (
    <QueryClientProvider client={client}>
      {chain ? <TxFlowConfigProvider value={CHAIN_TX_FLOW_CONFIG}>{tree}</TxFlowConfigProvider> : tree}
    </QueryClientProvider>
  );
}
