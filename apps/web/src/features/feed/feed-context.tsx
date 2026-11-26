import type { ExternalLinkProvider } from '@squarehole/domain';
import { createChainExternalLinkProvider, createDemoExternalLinkProvider } from '@squarehole/links';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { createFeedSession, type FeedSession } from './feed-session';
import { NO_FEED_SOURCES, createDemoFeedSources, type FeedSourceFor } from './feed-sources';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export interface FeedContextValue {
  readonly sourceFor: FeedSourceFor;
  readonly session: FeedSession;
  readonly links: ExternalLinkProvider;
  readonly allowScenario: boolean;
}

const FeedContext = createContext<FeedContextValue | null>(null);

export interface FeedDataProviderProps {
  children: ReactNode;
  /** Chain sources or a test seam: replaces the demo sources. Must be stable for the provider's lifetime. */
  sourceFor?: FeedSourceFor;
  session?: FeedSession;
  /** Link adapter for the sources (default: the demo adapter). Must be stable for the provider's lifetime. */
  links?: ExternalLinkProvider;
  /** `?scenario=` exists only for the demo fixtures (default: demo builds allow it). */
  allowScenario?: boolean;
}

/** Feed sources, snapshot pins and link adapter for the whole app (one set per app mount). */
export function FeedDataProvider({ children, sourceFor, session, links, allowScenario }: FeedDataProviderProps) {
  const [value] = useState<FeedContextValue>(() => ({
    sourceFor: sourceFor ?? (DEMO_BUILD ? createDemoFeedSources() : NO_FEED_SOURCES),
    session: session ?? createFeedSession(),
    links: links ?? (DEMO_BUILD ? createDemoExternalLinkProvider() : createChainExternalLinkProvider({})),
    // `?scenario=` only exists in Demo builds.
    allowScenario: allowScenario ?? DEMO_BUILD,
  }));
  return <FeedContext.Provider value={value}>{children}</FeedContext.Provider>;
}

export function useFeedContext(): FeedContextValue {
  const value = useContext(FeedContext);
  if (!value) throw new Error('useFeedContext needs <FeedDataProvider> (see AppProviders)');
  return value;
}
