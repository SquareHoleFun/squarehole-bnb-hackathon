/**
 * The build target the suite runs against (SH-TA-02; apps/web/build-target.ts): the caller's `SH_TARGET`, which
 * playwright.production.config.ts hands to the build. `sepolia` is the Sepolia test site (the test network notice);
 * unset or `mainnet` the main site (the production drafts).
 */
export function productionTarget(env: Readonly<Record<string, string | undefined>> = process.env): 'mainnet' | 'sepolia' {
  const value = env.SH_TARGET ?? '';
  if (value === '' || value === 'mainnet') return 'mainnet';
  if (value === 'sepolia') return 'sepolia';
  throw new Error(`SH_TARGET must be unset, "mainnet" or "sepolia" (got "${value}")`);
}
