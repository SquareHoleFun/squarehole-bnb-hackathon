/**
 * SH-SITE-FIXES-10: a link to a section of the Terms (`/about/terms#terms-6`, from About & risks or Create) lands on that
 * section, not at the top: on arrival by a link, on a direct load, and from another section of the same page; a plain
 * page change still opens at the top with the page's heading focused; Back and Forward keep the browser's scrolling.
 * The real Shell, Terms page and About & risks page; jsdom has no layout, so `scrollIntoView` is recorded.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../app-providers';
import { RisksPage } from '../pages/RisksPage';
import { TermsPage } from '../pages/TermsPage';
import { Shell } from './Shell';

const scrolled: Element[] = [];
beforeEach(() => {
  scrolled.length = 0;
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this); };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function Back() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(-1)}>Back</button>;
}

function renderAt(start: string) {
  render(
    <AppProviders>
      <MemoryRouter initialEntries={[start]}>
        <Routes>
          <Route element={<><Shell /><Back /><Link to="/about/terms#terms-11">To section 11</Link><Link to="/about/terms#no-such-section">To nowhere</Link></>}>
            <Route path="about/risks" element={<RisksPage />} />
            <Route path="about/terms" element={<TermsPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AppProviders>,
  );
}

const section = (n: number) => document.getElementById(`terms-${n}`) as HTMLElement;
const title = (n: number) => document.getElementById(`terms-${n}-title`) as HTMLElement;

describe('SH-SITE-FIXES-10 section links land on their section', () => {
  it('from About & risks, “Risks · Section 6” opens the Terms at section 6, its heading focused, never at the top', async () => {
    renderAt('/about/risks');
    const link = within(screen.getByRole('region', { name: 'Terms' })).getByRole('link', { name: 'Risks · Section 6' });
    expect(link.getAttribute('href')).toBe('/about/terms#terms-6');
    vi.mocked(window.scrollTo).mockClear();
    await act(async () => { fireEvent.click(link); });
    expect(scrolled).toEqual([section(6)]);
    expect(document.activeElement).toBe(title(6));
    expect(title(6).getAttribute('tabindex')).toBe('-1');
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it('every Terms section link of About & risks names a section the Terms page has, and lands on it', async () => {
    renderAt('/about/risks');
    const hrefs = [...new Set(within(screen.getByRole('main')).getAllByRole('link').map((a) => a.getAttribute('href') ?? '').filter((href) => href.startsWith('/about/terms#')))];
    expect(hrefs.length).toBeGreaterThanOrEqual(3);
    for (const href of hrefs) {
      cleanup(); scrolled.length = 0;
      renderAt('/about/risks');
      await act(async () => { fireEvent.click(within(screen.getByRole('main')).getAllByRole('link').find((a) => a.getAttribute('href') === href) as HTMLElement); });
      const id = href.split('#')[1] as string;
      expect(scrolled, href).toEqual([document.getElementById(id)]);
      expect(document.activeElement, href).toBe(document.getElementById(`${id}-title`));
    }
  });

  it('a direct load (or a reload) of /about/terms#terms-6 lands on section 6 once the page has rendered', () => {
    renderAt('/about/terms#terms-6');
    expect(scrolled).toEqual([section(6)]);
    expect(document.activeElement).toBe(title(6));
  });

  it('a link to another section of the same page goes there too; a plain page change opens at the top; Back keeps the browser’s scrolling', async () => {
    renderAt('/about/terms#terms-6');
    await act(async () => { fireEvent.click(screen.getByRole('link', { name: 'To section 11' })); });
    expect(scrolled).toEqual([section(6), section(11)]);
    expect(document.activeElement).toBe(title(11));
    await act(async () => { fireEvent.click(screen.getAllByRole('link', { name: 'About & risks' })[0] as HTMLElement); });
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
    expect(document.activeElement?.tagName).toBe('H1');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Back' })); });
    // Back to the Terms (a new render of it): no section is scrolled to; the browser restores its own position.
    expect(scrolled.map((element) => element.id)).toEqual(['terms-6', 'terms-11']);
  });

  it('a hash that names nothing on the page changes nothing: the page opens at the top, its heading focused, as before', async () => {
    renderAt('/about/risks');
    vi.mocked(window.scrollTo).mockClear();
    await act(async () => { fireEvent.click(screen.getByRole('link', { name: 'To nowhere' })); });
    expect(scrolled).toEqual([]);
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
    expect(document.activeElement?.tagName).toBe('H1');
    cleanup();
    renderAt('/about/terms#no-such-section');
    expect(scrolled).toEqual([]);
  });
});
