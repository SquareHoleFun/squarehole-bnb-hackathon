import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { STORED_ON_DEVICE } from '../features/legal';
import { appCopyFraming, renderedCopy } from '../features/legal/wording';
import { PrivacyPage } from './PrivacyPage';

afterEach(cleanup);

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/about/privacy']}>
      <PrivacyPage />
    </MemoryRouter>,
  );
}

describe('/about/privacy (Fable review S1)', () => {
  it('is the draft privacy notice with its date', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Privacy notice' })).toBeTruthy();
    expect(document.title).toBe('Privacy notice · Square Hole');
    const text = document.body.textContent ?? '';
    expect(text).toContain('DRAFT pending legal review.');
    expect(text).toContain('Draft of 11 October 2026');
    // Only the page and "In short" are named regions; the section cards are not landmarks.
    expect(screen.getAllByRole('region').map((region) => region.getAttribute('aria-labelledby'))).toEqual(['page-title', 'privacy-summary']);
  });

  it('shows every stored item with its key, and the four sections', () => {
    const { container } = renderPage();
    const device = document.getElementById('privacy-device');
    for (const item of STORED_ON_DEVICE) expect(device?.textContent, item.key).toContain(item.key);
    expect(container.querySelectorAll('#privacy-device code')).toHaveLength(STORED_ON_DEVICE.length);
    for (const name of ['In short', 'What stays on your device', 'What others see', 'Wallet addresses are public', 'Who we are and changes']) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeTruthy();
    }
    expect(document.getElementById('privacy-others')?.textContent).toContain('Cloudflare Pages');
  });

  it('marks open placeholders, leaves no raw markup, links only inside the site and passes the wording rule', () => {
    const { container } = renderPage();
    expect(container.textContent).not.toContain('**');
    const marks = Array.from(container.querySelectorAll('mark'), (mark) => mark.textContent ?? '');
    expect(marks.length).toBeGreaterThanOrEqual(2);
    for (const mark of marks) expect(mark).toMatch(/^\[(COUNSEL|FOUNDER|ENGINEERING)\b.*\]$/);
    const hrefs = Array.from(container.querySelectorAll('a[href]'), (link) => link.getAttribute('href'));
    expect(hrefs).toEqual(['/', '/about/terms', '/about/risks']);
    expect(container.querySelectorAll('button, input, select, textarea, iframe')).toHaveLength(0);
    expect(appCopyFraming(renderedCopy(container))).toEqual([]);
  });
});
