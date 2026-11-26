/**
 * SH-252: the examples inside the app. The explainer (Basics, How it works and the ten examples, each part of a picture
 * selectable with its explanation) is a static page of its own at `EXAMPLES_PAGE`, the generator's output copied into
 * the app's public files (apps/web/public/examples, made and checked by apps/web/build/examples-copy.mjs). It brings its
 * own styles and scripts and is served with the app's own headers, behind the same page lock as every app path.
 *
 * `EXAMPLES_PATH` is the app's address for it (Create's "Examples" link, SH-251): the route there hands the visit over
 * to the page with a full load (its styles and scripts own their document), replacing the history entry so Back returns
 * to where the link was. It targets the page's file itself: `/examples/` would serve the same file on the test host,
 * but Vite's dev server answers a folder address with the app.
 */
export const EXAMPLES_PATH = '/examples';
export const EXAMPLES_PAGE = '/examples/index.html';
/**
 * SH-324: the list of the demo boxes on chain 97 (SH-261), which `/examples` showed in a BNB build before the explainer
 * came there too. An address of the app's own: no file of the explainer's page is named so, so a host that serves an
 * existing file before the app (hackathon/stack/Caddyfile `try_files {path} /index.html`) hands it to the app.
 */
export const DEMO_BOXES_PATH = '/examples/boxes';

/** The page with a place on it (`#rent-free`, `#how-it-works-1`): only a plain place name is passed on. */
export function examplesPageFor(hash: string): string {
  return /^#[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(hash) ? `${EXAMPLES_PAGE}${hash}` : EXAMPLES_PAGE;
}

/** The one way out of the app to the page (a seam: jsdom cannot leave its document). */
export const examplesNavigation = {
  go(url: string): void {
    window.location.replace(url);
  },
};
