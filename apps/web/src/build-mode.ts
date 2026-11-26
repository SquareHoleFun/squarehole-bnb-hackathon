/**
 * The build mode (SH-V2-FE6; `SH_BUILD`, deployments-plugin.ts, vite.config.ts). The production site
 * (`SH_BUILD=production`, founder 2026-10-10: "a version with no demo at all") is built with
 * `import.meta.env.SH_PRODUCTION` defined as the literal `true`, and every module that reads the Demo starts with
 *
 *     const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;
 *
 * Read in the module itself (never imported from here): the bundler then sees the literal while it tree-shakes, so
 * `DEMO_BUILD && …` and `DEMO_BUILD ? demo : live` fold away with everything only they read, and the app's modules
 * count as free of side effects in production (vite.config.ts), so a Demo module nothing reads any more is dropped
 * whole, fixtures and all. `pnpm check:production` builds the site and fails on any Demo trace left.
 *
 * Elsewhere (the development build, the tests, other packages' tests that load these modules) the value is missing,
 * so the Demo stays exactly as it is. `?.`: where nothing defines `import.meta.env` at all (Node, when Playwright loads
 * a spec that imports these modules; the Pages Function's own bundle), it is `undefined`; Vite's define still folds
 * `import.meta.env?.SH_PRODUCTION`. Behaviour a test needs in both modes takes a parameter instead
 * (`DataSourceBuild.production`); the constant is for removal.
 */

/**
 * The `data-demo` attribute of a Demo-aware element (styles and tests read it), spread as `{...demoData(record.demo)}`.
 * React writes `data-demo="false"` for a plain `data-demo={false}`, so the production site gets no attribute at all.
 */
export const demoData = (demo: boolean | undefined): { readonly 'data-demo'?: boolean } => (!import.meta.env?.SH_PRODUCTION ? { 'data-demo': demo } : {});
