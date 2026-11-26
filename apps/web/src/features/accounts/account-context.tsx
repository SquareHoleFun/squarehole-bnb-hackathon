import { createContext, useContext, useState, type ReactNode } from 'react';
import { NO_ACCOUNT_SOURCES, createDemoAccountSources, type AccountSources } from './account-sources';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

const AccountContext = createContext<AccountSources | null>(null);

export interface AccountDataProviderProps {
  children: ReactNode;
  /** Test seam: replaces the demo sources. Must be stable for the provider's lifetime. */
  sources?: AccountSources;
}

/** Personal data sources for the whole app (one set per app mount, so demo settlements last for the tab). */
export function AccountDataProvider({ children, sources }: AccountDataProviderProps) {
  const [value] = useState<AccountSources>(() => sources ?? (DEMO_BUILD ? createDemoAccountSources() : NO_ACCOUNT_SOURCES));
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccountSources(): AccountSources {
  const value = useContext(AccountContext);
  if (!value) throw new Error('useAccountSources needs <AccountDataProvider> (see AppProviders)');
  return value;
}
