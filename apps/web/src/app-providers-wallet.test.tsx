/**
 * SH-V21-EXAMPLES-E2E-FIX2 O-2: the wallet's target chain is the source's wallet chain. On the local twin carrying a core
 * v2 deployment that is the deployment's own chain (Sepolia's id on anvil), so a wallet there is not "Wrong network";
 * every other source keeps its chain (31337 for the sample data and the local chains, 11155111 for Sepolia).
 */
import { cleanup, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { AppProviders } from './app-providers';
import * as dataSource from './features/data-source';
import { useWallet } from './features/wallet';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Target({ seen }: { seen: (chainId: number) => void }) {
  const wallet = useWallet();
  useEffect(() => seen(wallet.targetChainId));
  return null;
}

it.each([[11_155_111, 11_155_111], [31_337, 31_337]])('the wallet is checked against the source’s wallet chain %i', (walletChainId, expected) => {
  const useSource = dataSource.useDataSource;
  vi.spyOn(dataSource, 'useDataSource').mockImplementation(function useTwinSource() { return { ...useSource(), chainId: 31_337, walletChainId }; });
  let target = 0;
  render(<AppProviders><Target seen={(chainId) => { target = chainId; }} /></AppProviders>);
  expect(target).toBe(expected);
});
