import type { Plugin } from 'vite';

/**
 * F161 (4), SH-ALPHA-SITE: one fix to Privy's React SDK 3.51.0, found by the alpha-access suite's run of the real SDK
 * (e2e/alpha-access/privy-sdk.spec.mjs). `PrivyProvider` takes `config` off its props before it makes the client that
 * stores the session (`K(r)` gets every prop but `config`), so the documented `sessions.cookieWriteBehavior` never
 * reaches that client, and the SDK copies its tokens into three cookies of this site (`privy-token`, `privy-id-token`,
 * `privy-session`), which the browser then sends to our server with every page. The fix hands that client the config
 * the provider was given, and the core client its `sessions`; nothing else changes. Privy's own docs for the option:
 * cookies "are only read by a same-origin server, never by Privy, so 'never' does not affect auth".
 *
 * Exact text, exactly once, in the exact file of 3.51.0: any other version of the SDK in a build fails it, until this
 * is looked at again (the run above tells whether a newer SDK still needs it).
 */
const PROVIDER_FILE = /[\\/]@privy-io[\\/]react-auth[\\/]dist[\\/]esm[\\/]index-CaWn8tEz\.mjs$/;
const REACT_AUTH = /[\\/]@privy-io[\\/]react-auth[\\/]/;

export const PRIVY_FIXES: readonly { readonly find: string; readonly replace: string }[] = Object.freeze([
  {
    find: 'K(r);let a=o((()=>new p({appId:r.appId,clientId:r.clientId,storage:Oe,baseUrl:r.apiUrl,sdkVersion:"react-auth:3.51.0"})),[])',
    replace: 'K({...r,config:t});let a=o((()=>new p({appId:r.appId,clientId:r.clientId,storage:Oe,baseUrl:r.apiUrl,sdkVersion:"react-auth:3.51.0",sessions:t?.sessions})),[])',
  },
]);

/** The change, as the notices file states it for the package (Apache-2.0 § 4(b): modified files say so). */
export const PRIVY_CHANGES: Readonly<Record<string, string>> = Object.freeze({
  '@privy-io/react-auth@3.51.0': 'dist/esm/index-CaWn8tEz.mjs: PrivyProvider hands the client that stores the session the config it was given, so its cookie setting holds (Square Hole, build/privy-fixes.ts).',
});

/** The provider file with each fix applied; throws unless each one's text is there exactly once. */
export function applyPrivyFixes(code: string): string {
  let fixed = code;
  for (const { find, replace } of PRIVY_FIXES) {
    const count = fixed.split(find).length - 1;
    if (count !== 1) throw new Error(`privy-fixes.ts: Privy's provider holds the text it mends ${count} times, not once: look at its session cookies again`);
    fixed = fixed.replace(find, replace);
  }
  return fixed;
}

/** The Vite plugin: the fix in the provider's file, and a refusal of any build with Privy's React SDK but not that file. */
export function privyFixes(): Plugin {
  let reactAuth = false;
  let fixed = false;
  return {
    name: 'squarehole-privy-fixes',
    enforce: 'pre',
    buildStart() {
      reactAuth = false;
      fixed = false;
    },
    transform(code, id) {
      const path = id.split('?')[0] ?? id;
      if (!REACT_AUTH.test(path)) return null;
      reactAuth = true;
      if (!PROVIDER_FILE.test(path)) return null;
      fixed = true;
      return { code: applyPrivyFixes(code), map: null };
    },
    buildEnd(error) {
      if (!error && reactAuth && !fixed) this.error('privy-fixes.ts: this build has Privy\'s React SDK but not the 3.51.0 provider file it mends: look at its session cookies again');
    },
  };
}
