/**
 * SH-291: the wallet window's "Open My Box" link on both networks (SH-276 B had left it out on BNB Chain testnet, where
 * My Box listed nothing of the current box generation).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.resetModules(); });

async function link(bnb: boolean) {
  if (bnb) vi.stubEnv('SH_TESTNET', 'bnb');
  vi.resetModules();
  const { MyBoxLink } = await import('./MyBoxLink');
  render(createElement(MemoryRouter, null, createElement(MyBoxLink, { onOpen: () => undefined })));
  return screen.queryByRole('link', { name: 'Open My Box' });
}

describe('the wallet window\'s My Box link', () => {
  it('BNB Chain testnet: the link to /my-box', async () => { expect((await link(true))?.getAttribute('href')).toBe('/my-box'); });
  it('the other network: the link to /my-box', async () => { expect((await link(false))?.getAttribute('href')).toBe('/my-box'); });
});
