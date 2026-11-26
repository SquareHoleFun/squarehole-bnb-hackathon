import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { loadExamples } from '../../../../packages/box-spec/examples/v2/registry.mjs';
import { createExample } from './examples/create.mjs';
import { runLife } from './examples/life.mjs';
import { installWallet } from './examples/wallet.mjs';
import { assertProperties, RUN, stringify } from './examples/support.mjs';
import { followedIndexer } from './helpers.mjs';

// Contract readiness does not supply the local listings or hidden-art browser flow.
// Remove each gate only after its stand-in, creation helper and draw/reveal life work together.
const BROWSER_PREREQUISITES = {
  'frog-kiln': 'TA-30: local Test Frog (tFROG) listing with checked burn and browser symbol/fee selection; private kit pictures and draw/reveal flow are required.',
  'paper-certificates': 'TA-30: local Test Gold (tGOLD) listing and browser symbol selection; private kit pictures and draw/reveal flow are required.',
};

// Each life owns a fresh browser and creates at the current chain time. History stays append-only for the indexer.
test.describe.configure({ mode: 'default' });
for (const example of loadExamples()) {
  test.describe(() => {
    // Declare skips before Playwright creates the page fixture or reads the local chain.
    test.skip(example.status === 'pending', `${example.pendingStep}: ${example.pendingReason}`);
    test.skip(Boolean(BROWSER_PREREQUISITES[example.id]), BROWSER_PREREQUISITES[example.id]);
    test(`${example.id} · ${example.template.name}`, async ({ page }, info) => {
      const chain = JSON.parse(readFileSync(new URL('local-core-v2-chain.json', RUN), 'utf8'));
      const { assertLocalRpc } = await import('../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs');
      await assertLocalRpc(chain.rpcUrl);
      // SH-229: each life starts from an indexer that follows the chain; the life before it may have left a backlog.
      await followedIndexer(chain, info);
      const complete = new Set();
      const evidence = { example: example.id, template: example.template.name, properties: example.properties, transactions: [] };
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        const wallet = await installWallet(page, chain, evidence);
        const box = await test.step('Template → fields → live BoxSpec → local wallet createBox', () => createExample(page, chain, example, wallet, evidence));
        await test.step('Traders, keeper, exact chain accounting and page claims', () => runLife(page, chain, example, box, wallet, complete, evidence));
        assertProperties(example.properties, complete);
        expect(errors).toEqual([]);
        await page.screenshot({ path: info.outputPath(`${example.id}.png`), fullPage: true });
      } finally {
        evidence.completed = [...complete];
        await info.attach('example-evidence', { body: stringify(evidence), contentType: 'application/json' });
      }
    });
  });
}
