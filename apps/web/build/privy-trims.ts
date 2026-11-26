import type { Plugin } from 'vite';

/**
 * F161 (4), SH-ALPHA-SITE: packages Privy's SDK reaches only for features the alpha turns off, replaced in our builds
 * by stubs that refuse if anything ever calls them. Privy imports each one lazily, from the code of a feature we
 * configure away (features/trade-sepolia/privy-live.tsx `PRIVY_CLIENT_CONFIG`):
 * - WalletConnect (`@walletconnect/ethereum-provider`, `@walletconnect/universal-provider`, and through them Reown's
 *   AppKit): Privy's external-wallet connectors, which are off (`disableAllExternalWallets`, `walletConnect.enabled:
 *   false`); browser wallets stay on our own EIP-6963 path. Their packages ship under the "WalletConnect Community
 *   License Agreement", a proprietary licence (attribution, a required network connection, paid use above 500 monthly
 *   users), not one of the licences build/third-party-notices.ts allows: shipping it needs a reviewed decision, so the
 *   code stays out instead.
 * - Solana's program clients (`@solana-program/system`, `@solana-program/token`): Privy's Solana funding screens; the
 *   alpha is Ethereum only (`walletChainType: 'ethereum-only'`). Both ship no licence text.
 * Each stub exports the names Privy imports (a name it lacks fails the build: Rolldown's missing-export error), as
 * constants that hold nothing or functions and classes that throw. The alpha-access suite runs the sign-in with
 * Privy's real SDK and these stubs in place (e2e/alpha-access/privy-sdk.spec.mjs, Privy's service stood in); the made
 * wallet needs Privy's real wallet frame, which no suite has. docs/evidence/SH-ALPHA-SITE.md has the counts.
 */
export const PRIVY_TRIMMED: Readonly<Record<string, { readonly calls: readonly string[]; readonly values?: Readonly<Record<string, string>> }>> = Object.freeze({
  '@walletconnect/ethereum-provider': { calls: ['EthereumProvider'], values: { OPTIONAL_METHODS: '[]', OPTIONAL_EVENTS: '[]' } },
  '@walletconnect/universal-provider': { calls: ['UniversalProvider'] },
  '@solana-program/system': { calls: ['getTransferSolInstruction'] },
  '@solana-program/token': {
    calls: ['findAssociatedTokenPda', 'getCreateAssociatedTokenIdempotentInstruction', 'getCreateAssociatedTokenInstructionAsync', 'getTransferInstruction', 'getTransferCheckedInstruction', 'getApproveInstruction', 'fetchMaybeToken', 'fetchToken', 'fetchMint'],
    values: { TOKEN_PROGRAM_ADDRESS: '""' },
  },
});

const PREFIX = '\0sh-privy-trimmed:';

/** The stub's source: every listed name, the callable ones refusing, and a default export refusing too. */
export function trimmedStub(name: string): string {
  const entry = PRIVY_TRIMMED[name];
  if (!entry) throw new Error(`${name} is not trimmed`);
  const refuse = `const refuse = () => { throw new Error(${JSON.stringify(`${name} is not part of this build (build/privy-trims.ts)`)}); };`;
  const calls = entry.calls.map((call) => `export function ${call}() { refuse(); }`);
  const values = Object.entries(entry.values ?? {}).map(([key, value]) => `export const ${key} = ${value};`);
  return [refuse, ...calls, ...values, 'export default refuse;', ''].join('\n');
}

export function privyTrims(): Plugin {
  return {
    name: 'squarehole-privy-trims',
    enforce: 'pre',
    resolveId(source) {
      return Object.hasOwn(PRIVY_TRIMMED, source) ? `${PREFIX}${source}` : null;
    },
    load(id) {
      return id.startsWith(PREFIX) ? trimmedStub(id.slice(PREFIX.length)) : null;
    },
  };
}
