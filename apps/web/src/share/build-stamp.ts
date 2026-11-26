/**
 * The production site's mark in its own index.html (SH-V2-FE6). The production build writes it into the page head
 * (deployments-plugin.ts, `productionIndexHtml`); the link-preview Pages Function (share-edge.ts), which Pages builds
 * on its own and not Vite, reads it from the index.html it serves, so it knows no Demo box on the production site
 * even when the Pages project sets no `SH_BUILD`. No imports: the Vite config loads this file too.
 */
export const PRODUCTION_STAMP = '<meta name="squarehole-build" content="production" />';

/** Whether this index.html is the production site's (the production build stamped it). */
export const isProductionPage = (html: string): boolean => html.includes(PRODUCTION_STAMP);
