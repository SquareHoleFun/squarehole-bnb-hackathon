import { required } from './test-support/required';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { expect, it, vi } from 'vitest';
import { AppProviders } from '../../../app-providers';
import { BoxPage } from '../../../pages/BoxPage';
import { demoV2Boxes } from './demo-v2';

const selected = vi.hoisted(() => ({ record: null as unknown }));
vi.mock('../../boxes/useBoxSources', () => ({ useBoxSources: () => ({ boxes: [selected.record], core: { status: 'none' } }) }));
vi.mock('../RowBoxPage', () => ({ RowBoxPage: () => <p>V1 page retained</p> }));
it('CQ11-E4: a v2 chain row dispatches to v2, with an unavailable snapshot rather than invented figures', () => {
  const base = required(demoV2Boxes(1700000000n, new Map())[0]);
  selected.record = { ...base, demo: false, v2Chain: { source: null, snapshot: null } };
  render(<AppProviders><MemoryRouter initialEntries={[`/box/31337/${base.token}`]}><Routes><Route path="/box/:chain/:address" element={<BoxPage />} /></Routes></MemoryRouter></AppProviders>);
  expect(screen.getByText('V2 box data unavailable')).toBeTruthy();
  expect(screen.queryByText('V1 page retained')).toBeNull();
});
