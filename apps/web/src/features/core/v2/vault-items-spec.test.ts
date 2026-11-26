/** Offline guards for the browser regression. The real chain assertions remain an integrator gate. */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// Located from this file, not from the working directory: the full gate starts the suite at the repository root.
const spec = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../e2e/core-v2-chain/vault-items.spec.mjs'), 'utf8');
const items = spec.slice(spec.indexOf('// ── The Items card:'));

describe('SH-235 browser spec guards', () => {
  it('every item button locator is exact, including item 1 alongside 10, 11 and 12', () => {
    const locators = [...spec.matchAll(/getByRole\('button', \{ name: (?:'Take out item \d+'|'Put back item \d+'|`Take out item \$\{id\}`|`Put back item \$\{id\}`)([^}]*)\}\)/g)];
    expect(locators.length).toBeGreaterThan(5);
    for (const match of locators) expect(match[1], match[0]).toMatch(/exact: true/);
  });
  it('waits for the resumed wallet before measuring sends, with no take or connect before the loop', () => {
    const beforeLoop = items.slice(0, items.indexOf('for (let id'));
    expect(beforeLoop).toContain("await expect(panel.getByRole('heading', { name: 'Yours', exact: true })).toBeVisible();");
    expect(beforeLoop).not.toContain('.click()');
    expect(beforeLoop).not.toContain('await connect()');
    expect(beforeLoop).toContain('const sentBefore = wallet.sent.length;');
  });
  it('the final reload only waits for connection and proves it sent nothing', () => {
    const reload = items.slice(items.indexOf('// ── Reload'));
    expect(reload).not.toContain('.click()');
    expect(reload).not.toContain('await connect()');
    expect(reload).toContain("await expect(panel.getByRole('heading', { name: 'Yours', exact: true })).toBeVisible();");
    expect(reload).toContain("expect(wallet.sent.length, 'the reload and the connection send nothing').toBe(sends);");
  });
});
