import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { RECIPE_CHOICES } from './trading-controls';

// SH-003 shell: responsive navigation, keyboard access, no overflow, no console errors, tokens and font.
// Run with E2E_PORT set per worktree (see playwright.config.ts).

const MISFITS_BOX = '/box/31337/0x000000000000000000000000000000000000f17e';
const ROUTES = [
  '/',
  '/?state=bonding&view=list',
  MISFITS_BOX,
  `${MISFITS_BOX}?tab=owning`,
  '/box/31337/0xde00700000000000000000000000000000000003',
  '/wallet/0xde00000000000000000000000000000000000a11',
  '/my-box',
  '/pairs',
  '/pairs?type=nft_collection&q=orchard',
  '/launch',
  '/rewards',
  '/portfolio',
  '/settings',
  '/about/risks',
  '/pair/31337/0x0000000000000000000000000000000000000066',
  '/pair/31337/0x0000000000000000000000000000000000000070',
  '/no/such/page',
];

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`);
  });
  page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()}`));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  return errors;
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function ready(page: Page) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect(page.locator('h1')).toBeVisible();
  // SH-254: Launch opens the visual way; it is ready once its picture is drawn (never read on its loading line), and
  // never as the error page.
  if (new URL(page.url()).pathname === '/create/v2-picture') await expect(page.locator('.sh-newbox[data-step] svg.sh-pic [data-part]')).toHaveCount(10);
  await expect(page.getByText(/hit a problem/)).toHaveCount(0);
}

/**
 * SH-254: the picture's own names of the two buy-back-and-burn recipes (its stations and What happens' rows show the
 * fee choice's name, recipes.ts `choiceLabel`), read like the recipe choices RECIPE_CHOICES leaves out: only an element
 * whose whole text is that recipe's name (or the first line of it, where the drawing wraps it) is set aside.
 */
const PICTURE_RECIPE_NAMES = '.sh-pic-ledger__label, svg.sh-pic text';
const TRADE_WORD = /\bbuy\b|\bsell\b|\bswap\b/i;
/** A control, or what a control is made of (round 2b: a picture's recipe name is set aside only as plain text). */
const CONTROLS = 'button, a[href], [role="button"], [role="link"], [tabindex]:not([tabindex^="-"]), input, select, textarea, summary';
// (A tabindex of -1 makes an element a focus target, not a control: the page's main and its heading carry one.)

/**
 * The page's text as the ban reads it: the recipe choices (RECIPE_CHOICES) and the picture's plain-text recipe names
 * set aside; a recipe name that is a control, sits inside one or holds one is read like any other text.
 */
async function readText(page: Page): Promise<string> {
  return page.locator('body').evaluate((body: HTMLElement, [selector, names, name, controls]: readonly [string, string, string, string]) => {
    const recipeName = new RegExp(name);
    const plain = (element: Element) => !element.matches(controls) && element.parentElement?.closest(controls) == null && element.querySelector(controls) === null;
    const exempt = [
      ...body.querySelectorAll<HTMLElement>(selector),
      ...[...body.querySelectorAll<HTMLElement>(names)].filter((element) => plain(element) && recipeName.test((element.textContent ?? '').trim())),
    ];
    const shown = exempt.map((element) => element.style.display);
    for (const element of exempt) element.style.display = 'none';
    try { return body.innerText; } finally { exempt.forEach((element, i) => { element.style.display = shown[i] ?? ''; }); }
  }, [RECIPE_CHOICES, PICTURE_RECIPE_NAMES, RECIPE_NAME.source, CONTROLS] as const);
}

test('the ban reads a recipe name set as a control: a button carrying the ledger label class and that text fails it', async ({ page }) => {
  await page.setContent('<body><main><p class="sh-pic-ledger__label">Buy back and burn the box coin</p></main></body>');
  expect(await readText(page)).not.toMatch(TRADE_WORD);
  await page.setContent('<body><main><button class="sh-pic-ledger__label" aria-label="Execute">Buy back and burn the box coin</button></main></body>');
  expect(await readText(page)).toMatch(TRADE_WORD);
  await page.setContent('<body><main><a href="/x"><span class="sh-pic-ledger__label">Buy back and burn the box coin</span></a></main></body>');
  expect(await readText(page)).toMatch(TRADE_WORD);
  await page.setContent('<body><main tabindex="-1"><p class="sh-pic-ledger__label">Buy back and burn the box coin</p></main></body>');
  expect(await readText(page)).not.toMatch(TRADE_WORD);
  await page.setContent('<body><main><span class="sh-pic-ledger__label" tabindex="0">Buy back and burn the box coin</span></main></body>');
  expect(await readText(page)).toMatch(TRADE_WORD);
});
const RECIPE_NAME = /^Buy back and burn(?: (?:the box coin|[A-Z0-9]{1,11})(?: in the vault)?)?$/;

test('every route loads directly, without console errors or horizontal overflow', async ({ page }) => {
  const errors = trackErrors(page);
  for (const route of ROUTES) {
    await page.goto(route);
    await ready(page);
    expect(await horizontalOverflow(page), route).toBeLessThanOrEqual(0);
  }
  expect(errors).toEqual([]);
});

test('/collections, the old pair feed’s NFT filter, opens the box feed: the pair feed is off in every build (F134 R46B)', async ({ page }) => {
  await page.goto('/collections');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Boxes' })).toBeVisible();
  await expect(page.locator('#primary-nav a').evaluateAll((links) => links.map((link) => link.textContent))).resolves.toEqual(['Boxes', 'Launch', 'Settings', 'About & risks']);
});

test('skip link is the first tab stop and moves focus to main', async ({ page }) => {
  await page.goto('/create/basics');
  await ready(page);
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(page.locator('main#main')).toBeFocused();
  await expect(page).toHaveURL(/\/create\/basics$/);
});

test('primary navigation is reachable and operable by keyboard', async ({ page }, testInfo) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await ready(page);
  const nav = page.getByRole('navigation', { name: 'Primary' });

  if (testInfo.project.name === 'mobile') {
    const menu = page.getByRole('button', { name: 'Menu' });
    await expect(nav).toBeHidden();
    await menu.focus();
    await page.keyboard.press('Enter');
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    await expect(nav).toBeVisible();
    // Menu → next tab stops are the nav links (in-flow disclosure, no focus trap needed).
    let guard = 0;
    while (!(await nav.getByRole('link', { name: 'Boxes' }).evaluate((el) => el === document.activeElement)) && guard++ < 8) {
      await page.keyboard.press('Tab');
    }
    await expect(nav.getByRole('link', { name: 'Boxes' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toBeFocused();
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Enter');
  }

  // Tab until the Settings nav link has focus, then activate it.
  const settings = nav.getByRole('link', { name: 'Settings', exact: true });
  for (let i = 0; i < 20 && !(await settings.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
  }
  await expect(settings).toBeFocused();
  const outline = await settings.evaluate((el) => getComputedStyle(el).outlineStyle + ' ' + getComputedStyle(el).outlineWidth);
  expect(outline).toBe('solid 3px');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeFocused();
  // Navigating closes the compact menu, so assert on the DOM rather than the (now hidden) accessible link.
  await expect(page.locator('#primary-nav a[href="/settings"]')).toHaveAttribute('aria-current', 'page');
  if (testInfo.project.name === 'mobile') {
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'false');
  }
  expect(errors).toEqual([]);
});

test('the dark focus halo survives on elements with their own shadow', async ({ page }) => {
  test.skip(test.info().project.name === 'mobile', 'the current nav link is inside the closed compact menu');
  await page.goto('/');
  await ready(page);
  const halo = 'rgb(8, 13, 22) 0px 0px 0px 7px';
  // The launch set has no primary button in the top bar ("Launch pair" left it): the current nav link carries its own
  // shadow; the pair feed's "Load more"-style buttons are covered by their own specs.
  for (const target of [
    page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Boxes' }), // aria-current="page"
  ]) {
    for (let i = 0; i < 20 && !(await target.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(target).toBeFocused();
    expect(await target.evaluate((el) => getComputedStyle(el).boxShadow)).toContain(halo);
    await page.goto('/');
    await ready(page);
  }
});

test('the header search trigger opens the box feed’s one search field (SH-006, launch set)', async ({ page }) => {
  await page.goto('/about/risks');
  await ready(page);
  await expect(page.getByRole('searchbox')).toHaveCount(0);
  await page.getByRole('button', { name: 'Search boxes' }).click();
  await expect(page).toHaveURL(/\/$/);
  const box = page.getByRole('searchbox', { name: 'Search boxes, tokens or a wallet' });
  await expect(box).toBeFocused();
  await expect(page.getByRole('searchbox')).toHaveCount(1);
  await box.fill('pots');
  await expect(page).toHaveURL(/\/\?q=pots$/);
  await expect(page.getByRole('list', { name: 'Boxes' }).getByRole('link')).toHaveCount(1);
});

test('desktop: the header has a compact search button, the box feed field is the wide one', async ({ page, isMobile }) => {
  test.skip(isMobile, 'desktop header');
  await page.goto('/launch');
  const trigger = page.getByRole('banner').getByRole('button', { name: 'Search boxes' });
  await expect(trigger).toContainText('Search');
  await expect(trigger).not.toContainText('Search boxes');
  const away = await trigger.boundingBox();
  expect(away?.width ?? 999).toBeLessThanOrEqual(140);
  await trigger.click();
  const boxes = page.getByRole('searchbox', { name: 'Search boxes, tokens or a wallet' });
  await expect(boxes).toBeFocused();
  await page.mouse.move(700, 600);
  const onFeed = await trigger.boundingBox();
  const field = await boxes.boundingBox();
  expect(onFeed?.width ?? 999).toBeLessThanOrEqual(80);
  expect(field?.width ?? 0).toBeGreaterThanOrEqual(360);
  // A button, not a look-alike text field: no field fill.
  await expect.poll(() => trigger.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
});

test.describe('long search queries never cause horizontal overflow (UI-06)', () => {
  // A pair address is the obvious input for "Name, ticker, address" and cannot wrap at spaces.
  const LONG_QUERIES = [
    ['a 42-character address', '0x0000000000000000000000000000000000000066'],
    ['a 120-character query (the input maxLength)', `0x${'a1'.repeat(59)}`],
  ] as const;

  for (const width of [390, 360]) {
    for (const [label, query] of LONG_QUERIES) {
      test(`${width}px: ${label} typed into the box feed search`, async ({ page }) => {
        const errors = trackErrors(page);
        await page.setViewportSize({ width, height: 800 });
        await page.goto('/');
        await ready(page);
        const boxes = page.getByRole('searchbox', { name: 'Search boxes, tokens or a wallet' });
        await boxes.fill(query);
        await expect(page).toHaveURL(`/?q=${query}`);
        expect(await horizontalOverflow(page), `${width} ${label} (boxes)`).toBeLessThanOrEqual(0);
        expect(errors).toEqual([]);
      });
    }
  }

  test('360px: a query longer than maxLength arriving by shared link', async ({ page }) => {
    const query = `0x${'f'.repeat(398)}`;
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(`/?q=${query}`);
    await ready(page);
    await expect(page.getByText('No boxes match.')).toBeVisible();
    await expect(page.getByRole('searchbox', { name: 'Search boxes, tokens or a wallet' })).toHaveValue(`0x${'f'.repeat(118)}`);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
});

test('unknown ?state= values and old ?type= links, including Object.prototype names, keep the app mounted', async ({ page }) => {
  const errors = trackErrors(page);
  for (const name of ['__proto__', 'constructor', 'toString']) {
    await page.goto(`/?state=${name}&q=pots`);
    await ready(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Boxes' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'State' }).getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('list', { name: 'Boxes' }).getByRole('link')).toHaveCount(1);
    // An old pair-feed link with the same names opens the box feed (the pair feed is off, F134 R46B).
    await page.goto(`/pairs?type=${name}&q=orchard`);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Boxes' })).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('no wallet prompt, trading control or canvas in the shell (UI-01, UI-07, UI-09)', async ({ page }) => {
  for (const route of ROUTES) {
    await page.goto(route);
    await ready(page);
    // SH-194 (IR-2, af2): the two buy-back-and-burn recipe choices on /launch are the only text exempt from the ban, the
    // scope trading-controls.ts gives them; the rest of the page is read as rendered, with only those choices left out.
    expect(await readText(page), route).not.toMatch(TRADE_WORD);
    // SH-015: the demo wallet sits behind a closed top-bar button; nothing is open or prompting on load.
    await expect(page.getByRole('banner').getByRole('button', { name: 'Connect wallet' }), route).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('dialog'), route).toHaveCount(0);
    // The pin's decorative shape-sorter may draw on a canvas once live; nothing else may.
    await expect(page.locator('canvas:not([data-scene-variant] canvas), iframe, input[type="number"]'), route).toHaveCount(0);
  }
  // F130: no Demo badge or word anywhere in the shell (the sample data has no source badge).
  await expect(page.getByText('Demo', { exact: true })).toHaveCount(0);
  await expect(page.locator('.sh-source-badge')).toHaveCount(0);
});

test('packaged font renders tabular figures', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  const result = await page.evaluate(() => {
    const probe = (text: string, numeric: boolean) => {
      const span = document.createElement('span');
      span.textContent = text;
      span.style.cssText = 'position:absolute;visibility:hidden;font-size:40px;white-space:nowrap';
      if (numeric) span.className = 'sh-numeric';
      document.body.append(span);
      const width = span.getBoundingClientRect().width;
      span.remove();
      return width;
    };
    return {
      loaded: document.fonts.check('16px "Plus Jakarta Sans Variable"'),
      family: getComputedStyle(document.body).fontFamily,
      proportional: [probe('111111', false), probe('000000', false)],
      tabular: [probe('111111', true), probe('000000', true)],
    };
  });
  expect(result.loaded).toBe(true);
  expect(result.family).toMatch(/^"?Plus Jakarta Sans Variable"?/);
  expect(Math.abs((result.proportional[0] ?? 0) - (result.proportional[1] ?? 0))).toBeGreaterThan(20);
  expect(result.tabular[0]).toBeCloseTo(result.tabular[1] ?? 0, 1);
});

test('reduced motion removes transitions', async ({ page }) => {
  // A box feed search with no match shows a button ("Clear search and state"); the top bar has none since "Launch pair"
  // left it, and the box page's vault actions are text behind a lock, not buttons.
  await page.goto('/?q=nothing-like-this');
  await expect(page.getByRole('button', { name: 'Clear search and state' })).toBeVisible();
  const durations = () =>
    Promise.all(
      ['.sh-nav__link', '.sh-button'].map((selector) =>
        page.locator(selector).first().evaluate((el) => getComputedStyle(el).transitionDuration),
      ),
    );
  expect(await durations()).toEqual(['0.12s', '0.12s']);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await durations()).toEqual(['0s', '0s']);
});

test.describe('responsive widths', () => {
  test.skip(({ isMobile }) => isMobile, 'explicit widths run once, in the desktop project');

  for (const [width, height, mode] of [
    [1024, 768, 'rail'],
    [720, 450, 'rail'], // 1440×900 at 200% zoom
    [360, 740, 'compact'],
  ] as const) {
    test(`${width}px: ${mode} navigation, no horizontal overflow`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      for (const route of ['/', MISFITS_BOX, '/pairs', '/about/risks', '/pair/31337/0x0000000000000000000000000000000000000066', '/nope']) {
        await page.goto(route);
        await ready(page);
        expect(await horizontalOverflow(page), `${width} ${route}`).toBeLessThanOrEqual(0);
      }
      const nav = page.getByRole('navigation', { name: 'Primary' });
      if (mode === 'rail') {
        await expect(nav).toBeVisible();
        const box = await nav.boundingBox();
        expect(box?.width).toBeLessThanOrEqual(96);
        await expect(nav.getByRole('link', { name: 'About & risks' })).toBeVisible();
      } else {
        await expect(nav).toBeHidden();
        await page.getByRole('button', { name: 'Menu' }).click();
        await expect(nav.getByRole('link', { name: 'About & risks' })).toBeVisible();
        const target = await nav.getByRole('link', { name: 'Boxes' }).boundingBox();
        expect(target?.height).toBeGreaterThanOrEqual(44);
      }
    });
  }
});

// Screenshots go to the test output folder by default; SH_EVIDENCE_SCREENSHOTS=1 refreshes the committed evidence
// PNGs, so an ordinary e2e run never dirties the tree with rendering drift.
test('desktop and mobile screenshots', async ({ page }, testInfo) => {
  await page.goto('/');
  await ready(page);
  const layout = await page.evaluate(() => {
    const top = document.querySelector('.sh-topbar')?.getBoundingClientRect();
    return {
      // SH-006 moved the search field into the feed controls, so the compact header is a single row.
      topbar: top?.height,
      nav: document.querySelector('#primary-nav')?.getBoundingClientRect().width,
    };
  });
  await testInfo.attach('layout.json', { body: JSON.stringify(layout), contentType: 'application/json' });
  if (testInfo.project.name === 'desktop') {
    expect(layout.topbar).toBeGreaterThanOrEqual(64);
    expect(layout.topbar).toBeLessThanOrEqual(72);
    expect(layout.nav).toBeGreaterThanOrEqual(176);
    expect(layout.nav).toBeLessThanOrEqual(208);
  } else {
    expect(layout.topbar).toBeGreaterThanOrEqual(56);
    expect(layout.topbar).toBeLessThanOrEqual(64);
  }
  const file = process.env.SH_EVIDENCE_SCREENSHOTS === '1'
    ? fileURLToPath(new URL(`../../../docs/evidence/screenshots/SH-003-${testInfo.project.name}.png`, import.meta.url))
    : testInfo.outputPath(`SH-003-${testInfo.project.name}.png`);
  await page.screenshot({ path: file });
});
