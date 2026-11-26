const pager = document.querySelector('.pager');
const bar = pager && pager.querySelector('.pager__tabs');

if (bar) {
  const pages = [...pager.querySelectorAll('.pager__page')];
  const tabs = new Map(pages.map((page) => [page, bar.querySelector(`.pager__tab[href="#${page.id}"]`)]));
  let tracks = false;
  let lit = null;
  let shown = null;
  let width = 0;
  let queued = false;
  const follow = () => {
    queued = false;
    const line = Math.max(0, bar.getBoundingClientRect().bottom) + 1;
    const reached = pages.filter((p) => p.getBoundingClientRect().top <= line);
    const page = reached.length ? reached[reached.length - 1] : pages[0];
    const tab = (page && tabs.get(page)) || null;
    if (tracks && tab !== lit) {
      if (lit) lit.classList.remove('pager__tab--current');
      if (tab) tab.classList.add('pager__tab--current');
      lit = tab;
    }
    if (tab && (tab !== shown || bar.clientWidth !== width)) {
      shown = tab;
      width = bar.clientWidth;
      const view = bar.getBoundingClientRect();
      const own = tab.getBoundingClientRect();
      const from = (tab.previousElementSibling ?? tab).getBoundingClientRect().left;
      const to = (tab.nextElementSibling ?? tab).getBoundingClientRect().right;
      if (from < view.left || to > view.right) bar.scrollLeft += (own.left + own.right - view.left - view.right) / 2;
    }
  };
  const queue = () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(follow);
    }
  };
  if (!CSS.supports('selector(:target-current)')) {
    tracks = true;
    pager.classList.add('pager--tracks');
  }
  addEventListener('scroll', queue, { passive: true });
  addEventListener('resize', queue);
  follow();

  pager.addEventListener(
    'toggle',
    (event) => {
      const words = event.target;
      if (words instanceof HTMLDetailsElement && words.open && words.classList.contains('slide__words')) {
        const box = words.getBoundingClientRect();
        const head = words.closest('.pager__page')?.querySelector('.pager__head');
        const covered = bar.getBoundingClientRect().bottom + (head ? head.getBoundingClientRect().height : 0);
        const top = getComputedStyle(bar).position === 'sticky' ? covered + 8 : 8;
        const bottom = innerHeight - 16;
        let by = box.bottom > bottom ? box.bottom - bottom : 0;
        if (box.top - by < top) by = box.top - top;
        if (Math.abs(by) >= 1) scrollBy({ top: by });
      }
    },
    true,
  );

  addEventListener(
    'click',
    (event) => {
      for (const words of pager.querySelectorAll('.slide__words[open]')) {
        if (!words.contains(event.target) && !words.closest('.slide--follow')) words.open = false;
      }
    },
    true,
  );

  if (pages.length && 'IntersectionObserver' in window) {
    const near = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          near.disconnect();
          const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/examples/follow.css' });
          css.addEventListener('load', () => document.head.append(Object.assign(document.createElement('script'), { src: '/examples/follow.js' })));
          document.head.append(css);
        }
      },
      { rootMargin: '50% 0px' },
    );
    pages.forEach((page) => near.observe(page));
  }
}
