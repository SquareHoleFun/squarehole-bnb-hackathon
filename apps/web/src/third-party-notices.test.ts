// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Rolldown } from 'vite';
import { describe, expect, it } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';
import { thirdPartyNotices } from '../build/third-party-notices';
import { PRIVY_CHANGES } from '../build/privy-fixes';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MIT = `MIT License

Copyright (c) 2026 Fixture Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
// Fixture text is deliberately distinctive: the plugin must copy the shipped bytes, not supply a template.
const APACHE = 'Apache License\nVersion 2.0, January 2004\nFixture license terms.\n';

const override = (license = 'MIT') => ({
  license,
  copyright: 'Copyright (c) 2026 Fixture Authors',
  source: { url: 'https://example.com/fixture/LICENSE', dateRead: '2026-10-29' },
});

function fixture() {
  const scratch = join(ROOT, '.cache/third-party-notices-tests');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'case-'));
  const write = (file: string, text: string | Uint8Array) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  write('package.json', JSON.stringify({ name: '@squarehole/fixture', version: '0.0.0' }));
  const pkg = (name: string, license: string | undefined, files: Record<string, string | Uint8Array> = {}, version = '1.2.3', directory = `node_modules/${name}`) => {
    write(`${directory}/package.json`, JSON.stringify({ name, version, license, type: 'module', main: './index.js' }));
    write(`${directory}/index.js`, `export default ${JSON.stringify(name)};`);
    for (const [file, text] of Object.entries(files)) write(`${directory}/${file}`, text);
  };
  const run = async (entry: string, overrides?: Record<string, ReturnType<typeof override>>) => {
    write('entry.js', entry);
    const result = await build({
      configFile: false,
      root,
      logLevel: 'silent',
      plugins: [thirdPartyNotices(overrides)],
      build: {
        write: false,
        emptyOutDir: false,
        minify: false,
        rolldownOptions: { input: join(root, 'entry.js'), preserveEntrySignatures: 'strict' },
      },
    }) as Rolldown.RolldownOutput;
    const asset = result.output.find((item) => item.fileName === 'third-party-notices.txt');
    expect(asset?.type).toBe('asset');
    if (!asset || asset.type !== 'asset') throw new Error('No root notices asset');
    return String(asset.source);
  };
  return { root, write, pkg, run };
}

describe('third-party notices from bundled packages (SH-025 / G07)', () => {
  it('emits the name, version, license, copyright and complete shipped MIT text', async () => {
    const f = fixture();
    f.pkg('one', 'MIT', { LICENSE: MIT });
    const text = await f.run("export { default } from 'one';");
    expect(text).toContain('Package: one@1.2.3\nLicense: MIT\n');
    expect(text).toContain('Copyright (c) 2026 Fixture Authors');
    expect(text).toContain(MIT);
    expect(text).toContain('Package: @squarehole/fixture@0.0.0\nLicense: Square Hole workspace (ours)');
    expect(text).not.toContain(f.root);
    expect(thirdPartyNotices().apply).toBe('build');
  });

  it('copies Apache LICENSE and NOTICE text', async () => {
    const f = fixture();
    const notice = 'A fixture distribution\nCopyright 2026 Notice Authors\nRetain this attribution.\n';
    f.pkg('apache-notice', 'Apache-2.0', { 'LICENSE.txt': APACHE, NOTICE: notice });
    const text = await f.run("export { default } from 'apache-notice';");
    expect(text).toContain('License: Apache-2.0');
    expect(text).toContain(APACHE);
    expect(text).toContain(notice);
  });

  it('lists copyright notices that state no year', async () => {
    const f = fixture();
    f.pkg('undated', 'MIT', { LICENSE: MIT.replace('2026 Fixture Authors', 'Fixture Authors') });
    const text = await f.run("export { default } from 'undated';");
    expect(text).toContain('Copyright lines:\nCopyright (c) Fixture Authors\n');
  });

  it('retains Apache attribution from the original bundled header without NOTICE', async () => {
    const f = fixture();
    const attribution = 'Fixture Chart™, Copyright (c) 2026 Example Authors';
    f.pkg('header-only', 'Apache-2.0', {
      LICENSE: APACHE,
      'index.js': `/*!\n * ${attribution}\n * Released under Apache License 2.0.\n */\nexport default 42;`,
    });
    const text = await f.run("export { default } from 'header-only';");
    expect(text).toContain(attribution);
    expect(text).toContain('Released under Apache License 2.0.');
    expect(text).not.toContain('export default 42');
  });

  it('uses the committed fancy-canvas override and labels the complete standard MIT text', async () => {
    const f = fixture();
    f.pkg('fancy-canvas', 'MIT', {}, '2.1.0');
    const text = await f.run("export { default } from 'fancy-canvas';");
    expect(text).toContain('Package: fancy-canvas@2.1.0\nLicense: MIT');
    expect(text).toContain('Copyright lines:\nCopyright (c) 2019 TradingView, Inc\n');
    expect(text).toContain('https://github.com/tradingview/fancy-canvas/blob/master/LICENSE');
    expect(text).toContain('date read: 2026-10-29');
    expect(text).toContain('License text: MIT (standard text; the package ships none) -> sha256:');
    expect(text).toContain(MIT.replace('Copyright (c) 2026 Fixture Authors', 'Copyright (c) 2019 TradingView, Inc'));
    expect(text).not.toContain('License file:');
  });

  it('fails with the package name when a license field has no text and no override', async () => {
    const f = fixture();
    f.pkg('needs-review', 'MIT');
    await expect(f.run("export { default } from 'needs-review';")).rejects.toThrow(/needs-review@1\.2\.3.*no shipped license.*override/i);
  });

  it.each(['NOTICE', 'notice.txt'])('requires an override when %s contains only attribution and no license file ships', async (file) => {
    const f = fixture();
    f.pkg('notice-only', 'MIT', { [file]: 'Copyright 2026 Notice Authors\nRetain this attribution.\n' });
    await expect(f.run("export { default } from 'notice-only';", {})).rejects.toThrow(/notice-only@1\.2\.3.*no shipped license.*override/i);
  });

  it.each(['NOTICE', 'notice.txt'])('keeps %s attribution alongside marked complete standard terms with a valid override', async (file) => {
    const f = fixture();
    const notice = 'Copyright 2026 Notice Authors\nRetain this attribution.\n';
    f.pkg('notice-only', 'MIT', { [file]: notice });
    const text = await f.run("export { default } from 'notice-only';", { 'notice-only@1.2.3': override() });
    expect(text).toContain('Package: notice-only@1.2.3\nLicense: MIT');
    expect(text).toContain('License text: MIT (standard text; the package ships none) -> sha256:');
    expect(text).toContain(MIT);
    expect(text).toContain(`Notice file: ${file} -> sha256:`);
    expect(text).toContain(notice);
    expect(text).toContain('Copyright source: https://example.com/fixture/LICENSE (date read: 2026-10-29)');
    expect(text).not.toContain('License file:');
  });

  it('does not carry an override to a new package version', async () => {
    const f = fixture();
    f.pkg('fancy-canvas', 'MIT', {}, '2.1.1');
    await expect(f.run("export { default } from 'fancy-canvas';")).rejects.toThrow(/fancy-canvas@2\.1\.1.*override/i);
  });

  it.each([
    ['MIT', 'Permission is hereby granted, free of charge', 'SOFTWARE.'],
    ['ISC', 'Permission to use, copy, modify, and/or distribute this software', 'THE USE OR PERFORMANCE OF THIS SOFTWARE.'],
    ['BSD-2-Clause', 'Redistributions in binary form must reproduce the above copyright', 'EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.'],
    ['BSD-3-Clause', 'Neither the name of the copyright holder nor the names of its', 'EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.'],
    ['Apache-2.0', '3. Grant of Patent License.', 'limitations under the License.'],
  ])('supplies reviewed %s standard terms with their conditions and disclaimer', async (license, condition, ending) => {
    const f = fixture();
    f.pkg('reviewed', license);
    const text = await f.run("export { default } from 'reviewed';", { 'reviewed@1.2.3': override(license) });
    expect(text).toContain(`License text: ${license} (standard text; the package ships none) -> sha256:`);
    expect(text).toContain('Copyright (c) 2026 Fixture Authors');
    expect(text).toContain(condition);
    expect(text).toContain(ending);
    expect(text).not.toContain('[year]');
    expect(text).not.toContain('[fullname]');
    if (license === 'Apache-2.0') {
      expect(text).toContain('9. Accepting Warranty or Additional Liability.');
      expect(text).toContain('APPENDIX: How to apply the Apache License to your work.');
    }
  });

  it.each([
    { ...override(), license: 'ISC' },
    { ...override(), copyright: '' },
    { ...override(), copyright: 'Copyright (c) 2026 Fixture Authors\nextra line' },
    { ...override(), source: { url: '', dateRead: '2026-10-29' } },
    { ...override(), source: { url: 'https://', dateRead: '2026-10-29' } },
    { ...override(), source: { url: 'file:LICENSE', dateRead: '2026-10-29' } },
    { ...override(), source: { url: 'https://example.com/LICENSE', dateRead: '' } },
    { ...override(), source: { url: 'https://example.com/LICENSE', dateRead: '2026-02-30' } },
  ])('rejects incomplete or mismatched override metadata: %j', async (entry) => {
    const f = fixture();
    f.pkg('reviewed', 'MIT');
    await expect(f.run("export { default } from 'reviewed';", { 'reviewed@1.2.3': entry })).rejects.toThrow(/reviewed@1\.2\.3.*invalid.*override/i);
  });

  it('keeps an override copyright line exactly, including an undated copyright', async () => {
    const f = fixture();
    f.pkg('undated-override', 'MIT');
    const copyright = 'Copyright Undated Fixture Authors';
    const text = await f.run("export { default } from 'undated-override';", { 'undated-override@1.2.3': { ...override(), copyright } });
    expect(text).toContain(`Copyright lines:\n${copyright}\n`);
    expect(text).toContain(MIT.replace('Copyright (c) 2026 Fixture Authors', copyright));
  });

  it('preserves shipped text even when an override exists', async () => {
    const f = fixture();
    f.pkg('reviewed', 'MIT', { LICENSE: MIT });
    const text = await f.run("export { default } from 'reviewed';", { 'reviewed@1.2.3': override('ISC') });
    expect(text).toContain(MIT);
    expect(text).not.toContain('standard text; the package ships none');
    expect(text).not.toContain('https://example.com/fixture/LICENSE');
  });

  it.each(['OFL-1.1', '(MIT OR ISC)'])('requires review rather than guessing standard terms for %s', async (license) => {
    const f = fixture();
    f.pkg('unsupported-template', license);
    await expect(f.run("export { default } from 'unsupported-template';", { 'unsupported-template@1.2.3': override(license) }))
      .rejects.toThrow(/unsupported-template@1\.2\.3.*no standard text/i);
  });

  it('does not use an override to allow an unapproved license', async () => {
    const f = fixture();
    f.pkg('unapproved', 'GPL-3.0-only');
    await expect(f.run("export { default } from 'unapproved';", { 'unapproved@1.2.3': override() })).rejects.toThrow(/unapproved@1\.2\.3.*not allowed/i);
  });

  it('emits both installed chart packages and their exact header in a real Sepolia production build', () => {
    const scratch = join(ROOT, '.cache/third-party-notices-tests');
    mkdirSync(scratch, { recursive: true });
    const outDir = mkdtempSync(join(scratch, 'production-'));
    const webRoot = join(ROOT, 'apps/web');
    const result = spawnSync(process.execPath, [
      join(webRoot, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', outDir, '--emptyOutDir', 'false',
    ], {
      cwd: webRoot,
      env: { ...process.env, VITEST: '', NODE_ENV: 'production', SH_BUILD: 'production', SH_TARGET: 'sepolia' },
      encoding: 'utf8', timeout: 120_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const text = readFileSync(join(outDir, 'third-party-notices.txt'), 'utf8');
    expect(text).toContain('Package: lightweight-charts@5.2.1\nLicense: Apache-2.0');
    expect(text).toContain('Package: fancy-canvas@2.1.0\nLicense: MIT');
    const chartRoot = join(webRoot, 'node_modules/lightweight-charts');
    const manifest = JSON.parse(readFileSync(join(chartRoot, 'package.json'), 'utf8')) as { module: string };
    const source = readFileSync(join(chartRoot, manifest.module), 'utf8');
    const header = source.match(/^\s*(\/\*[\s\S]*?\*\/)/)?.[1];
    expect(header).toMatch(/TradingView Lightweight Charts[\s\S]*Copyright/);
    expect(text).toContain(header);
    expect(text).toContain(readFileSync(join(chartRoot, 'LICENSE'), 'utf8'));
    expect(text).toContain('Copyright (c) 2019 TradingView, Inc');
    expect(text).toContain('standard text; the package ships none');
  }, shLimit(150_000));

  it('writes identical license texts once and refers to the shared text by name', async () => {
    const f = fixture();
    f.pkg('alpha', 'MIT', { LICENSE: MIT });
    f.pkg('beta', 'MIT', { LICENCE: MIT });
    const text = await f.run("export { default as a } from 'alpha'; export { default as b } from 'beta';");
    expect(text.split(MIT)).toHaveLength(2);
    const references = [...text.matchAll(/^License file: (?:LICENSE|LICENCE) -> (.+)$/gm)].map((match) => match[1]);
    expect(references).toHaveLength(2);
    expect(references[0]).toBe(references[1]);
    expect(text).toContain(`Text: ${references[0]}`);
  });

  it('rejects a package with neither a license field nor a license file', async () => {
    const f = fixture();
    f.pkg('unlicensed', undefined);
    await expect(f.run("export { default } from 'unlicensed';")).rejects.toThrow(/unlicensed@1\.2\.3.*no license field and no license file/i);
  });

  it.each(['GPL-3.0-only', 'LGPL-2.1-or-later', 'AGPL-3.0-only', 'MPL-2.0', 'Unknown', '(MIT OR GPL-3.0-only)'])(
    'rejects the unapproved license %s and names its package', async (license) => {
      const f = fixture();
      f.pkg('unapproved', license, { LICENSE: 'Unapproved fixture terms.\n' });
      await expect(f.run("export { default } from 'unapproved';")).rejects.toThrow(/unapproved@1\.2\.3.*not allowed/i);
    },
  );

  it('recognizes a file-only MIT license but refuses unknown file-only terms', async () => {
    const f = fixture();
    f.pkg('file-only', undefined, { COPYING: MIT });
    expect(await f.run("export { default } from 'file-only';")).toContain('License: MIT');
    f.pkg('unknown-file', undefined, { LICENCE: 'These terms require a decision.\n' });
    await expect(f.run("export { default } from 'unknown-file';")).rejects.toThrow(/unknown-file@1\.2\.3.*not allowed/i);
  });

  it('accepts expressions only when every license is allowed', async () => {
    const f = fixture();
    f.pkg('dual', '(MIT OR Apache-2.0)', { 'LICENSE-MIT': MIT, 'LICENSE-APACHE': APACHE });
    const text = await f.run("export { default } from 'dual';");
    expect(text).toContain('License: (MIT OR Apache-2.0)');
    expect(text).toContain(MIT);
    expect(text).toContain(APACHE);
  });

  it('is byte-identical across import order, different roots and duplicate modules', async () => {
    const first = fixture();
    const second = fixture();
    for (const f of [first, second]) {
      f.pkg('zeta', 'MIT', { LICENSE: MIT, 'extra.js': 'export default 2;' });
      f.pkg('alpha', 'MIT', { LICENSE: MIT });
    }
    const a = await first.run("export { default as z } from 'zeta'; export { default as a } from 'alpha'; export { default as extra } from 'zeta/extra.js';");
    const b = await second.run("export { default as a } from 'alpha'; export { default as extra } from 'zeta/extra.js'; export { default as z } from 'zeta';");
    expect(a).toBe(b);
    expect(a.indexOf('Package: alpha@')).toBeLessThan(a.indexOf('Package: zeta@'));
    expect(a.match(/Package: zeta@/g)).toHaveLength(1);
  });

  it('keeps different versions and walks past a nested type-only package.json', async () => {
    const f = fixture();
    f.pkg('nested', 'MIT', { LICENSE: MIT, 'esm/package.json': '{"type":"module"}', 'esm/index.js': 'export default 1;' });
    f.pkg('nested', 'MIT', { LICENSE: MIT }, '2.0.0', 'node_modules/parent/node_modules/nested');
    const text = await f.run("export { default as a } from './node_modules/nested/esm/index.js?fixture'; export { default as b } from './node_modules/parent/node_modules/nested/index.js';");
    expect(text).toContain('Package: nested@1.2.3');
    expect(text).toContain('Package: nested@2.0.0');
  });

  it('includes CSS @imports and both inline and emitted fonts, even without a JS module', async () => {
    const f = fixture();
    const ofl = 'Copyright 2026 Fixture Font Authors\nSIL OPEN FONT LICENSE Version 1.1\nFixture font terms.\n';
    f.pkg('@fontsource/fixture', 'OFL-1.1', {
      LICENSE: ofl,
      'font.css': '@font-face { font-family: Fixture; src: url("./small.woff2") } @font-face { font-family: FixtureBig; src: url("./big.woff2") }',
      'small.woff2': 'small fixture font',
      'big.woff2': new Uint8Array(5000).fill(65),
    });
    f.write('style.css', '@import "@fontsource/fixture/font.css"; body { color: red }');
    const text = await f.run("import './style.css'; export default 1;");
    expect(text).toContain('Package: @fontsource/fixture@1.2.3\nLicense: OFL-1.1');
    expect(text).toContain(ofl);
  });

  it('rejects unapproved CSS-only dependencies and ignores unbundled JS dependencies', async () => {
    const f = fixture();
    f.pkg('unused', 'GPL-3.0-only', { LICENSE: 'GPL fixture', 'index.js': 'export default 1;' });
    f.pkg('bad-css', 'MPL-2.0', { LICENSE: 'MPL fixture', 'style.css': 'body { color: blue }' });
    f.write('style.css', '@import "bad-css/style.css";');
    const text = await f.run("import unused from 'unused'; export default 42;");
    expect(text).not.toContain('Package: unused@');
    await expect(f.run("import './style.css'; export default 42;")).rejects.toThrow(/bad-css@1\.2\.3.*not allowed/i);
  });

  it('includes a font package referenced only by an inline URL in local CSS', async () => {
    const f = fixture();
    f.pkg('inline-font', 'OFL-1.1', { LICENSE: 'Fixture OFL terms\nCopyright 2026 Font Authors\n', 'font.woff2': 'inline font' });
    f.write('style.css', '@font-face { font-family: Inline; src: url("./node_modules/inline-font/font.woff2") }');
    expect(await f.run("import './style.css'; export default 1;")).toContain('Package: inline-font@1.2.3\nLicense: OFL-1.1');
  });

  it('includes a font explicitly forced inline in local CSS', async () => {
    const f = fixture();
    f.pkg('forced-inline-font', 'OFL-1.1', { LICENSE: 'Fixture OFL terms\nCopyright 2026 Font Authors\n', 'font.woff2': 'inline font' });
    f.write('style.css', '@font-face { font-family: Inline; src: url("./node_modules/forced-inline-font/font.woff2?inline") }');
    expect(await f.run("import './style.css'; export default 1;")).toContain('Package: forced-inline-font@1.2.3\nLicense: OFL-1.1');
  });

  it('ignores repository files outside a named workspace package', async () => {
    const f = fixture();
    f.write('package.json', '{"name":"squarehole","private":true}');
    f.pkg('one', 'MIT', { LICENSE: MIT });
    expect(await f.run("export { default } from 'one';")).toContain('Package: one@1.2.3');
  });

  it('does not deduplicate different legal texts that declare the same license', async () => {
    const f = fixture();
    f.pkg('alice', 'MIT', { LICENSE: MIT });
    const other = MIT.replace('Fixture Authors', 'Other Authors').replaceAll('\n', '\r\n');
    f.pkg('bob', 'MIT', { LICENSE: other });
    const text = await f.run("export { default as a } from 'alice'; export { default as b } from 'bob';");
    expect(text).toContain(MIT);
    expect(text).toContain(other);
    expect([...text.matchAll(/^License file: LICENSE -> (.+)$/gm)].map((match) => match[1])).toHaveLength(2);
  });

  it('covers the real packaged font copyright and OFL text', async () => {
    const f = fixture();
    const fontRoot = join(ROOT, 'packages/design/node_modules/@fontsource-variable/plus-jakarta-sans');
    const text = await f.run(`import ${JSON.stringify(join(fontRoot, 'wght.css'))}; export default 1;`);
    expect(text).toContain('Package: @fontsource-variable/plus-jakarta-sans@5.3.0\nLicense: OFL-1.1');
    expect(text).toContain(readFileSync(join(fontRoot, 'LICENSE'), 'utf8'));
  });
});

/**
 * F161 (4), SH-ALPHA-SITE: what Privy's SDK brought to the Sepolia build. A subpath's own `private: true` manifest
 * (preact/hooks, libphonenumber-js/min) belongs to its package; a manifest with no license field and the Apache License
 * 2.0's own text (@privy-io/api-base) is Apache-2.0; and the join and desk pages, builds of their own, write their own
 * copy and hand their sources to the app's file at the output root.
 */
describe('third-party notices for the Sepolia alpha’s pages (F161 (4), SH-ALPHA-SITE)', () => {
  const APACHE_TEXT = `                                 Apache License\n                           Version 2.0, January 2004\n                        http://www.apache.org/licenses/\n\n   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION\n\n   Fixture body.\n`;

  it('attributes a subpath’s private manifest to the package it sits in', async () => {
    const f = fixture();
    f.write('node_modules/outer/package.json', JSON.stringify({ name: 'outer', version: '2.0.0', license: 'MIT', type: 'module', exports: { '.': './index.js', './hooks': './hooks/index.js' } }));
    f.write('node_modules/outer/LICENSE', MIT);
    f.write('node_modules/outer/index.js', 'export default 1;');
    f.write('node_modules/outer/hooks/package.json', JSON.stringify({ name: 'outer-hooks', version: '0.1.0', private: true, type: 'module' }));
    f.write('node_modules/outer/hooks/index.js', 'export const hook = 2;');
    f.write('node_modules/outer/min/package.json', JSON.stringify({ name: 'outer/min', private: true, type: 'module' }));
    f.write('node_modules/outer/min/index.js', 'export const min = 3;');
    const text = await f.run("export { hook } from 'outer/hooks'; export { min } from './node_modules/outer/min/index.js';");
    expect(text).toContain('Package: outer@2.0.0\nLicense: MIT\n');
    expect(text).not.toContain('outer-hooks');
    expect(text).not.toContain('outer/min');
  });

  it('a private manifest outside node_modules is still the workspace’s own, and a published one without a version still fails', async () => {
    const f = fixture();
    f.write('package.json', JSON.stringify({ name: '@squarehole/fixture', version: '0.0.0', private: true }));
    f.pkg('one', 'MIT', { LICENSE: MIT });
    expect(await f.run("export { default } from 'one';")).toContain('Package: @squarehole/fixture@0.0.0\nLicense: Square Hole workspace (ours)');
    const g = fixture();
    g.write('node_modules/bare/package.json', JSON.stringify({ name: 'bare', license: 'MIT', type: 'module', main: './index.js' }));
    g.write('node_modules/bare/index.js', 'export default 1;');
    await expect(g.run("export { default } from 'bare';")).rejects.toThrow('Third-party notices: bare has no package version');
  });

  it('reads the Apache License 2.0’s own text as Apache-2.0 when the manifest names no license, and nothing less', async () => {
    const f = fixture();
    f.pkg('apache-file-only', undefined, { LICENSE: APACHE_TEXT });
    const text = await f.run("export { default } from 'apache-file-only';");
    expect(text).toContain('Package: apache-file-only@1.2.3\nLicense: Apache-2.0\n');
    expect(text).toContain(APACHE_TEXT);
    const g = fixture();
    g.pkg('apache-title-only', undefined, { LICENSE: 'Apache License\nVersion 2.0, January 2004\nSome other terms.\n' });
    await expect(g.run("export { default } from 'apache-title-only';")).rejects.toThrow('license "unidentified license file" is not allowed');
  });

  it('writes a page’s copy where it is asked, hands its sources on, and adds another build’s sources to the root file', async () => {
    const f = fixture();
    f.pkg('page-only', 'MIT', { LICENSE: MIT });
    f.pkg('app-only', 'ISC', { LICENSE: 'ISC License\n\nCopyright (c) 2026 App Authors\n' });
    f.write('page.js', "export { default } from 'page-only';");
    const reported: string[] = [];
    const page = await build({
      configFile: false, root: f.root, logLevel: 'silent',
      plugins: [thirdPartyNotices(undefined, { fileName: 'join/assets/third-party-notices.txt', report: (files) => reported.push(...files) })],
      build: { write: false, emptyOutDir: false, minify: false, rolldownOptions: { input: join(f.root, 'page.js'), preserveEntrySignatures: 'strict' } },
    }) as Rolldown.RolldownOutput;
    const pageFile = page.output.find((item) => item.fileName === 'join/assets/third-party-notices.txt');
    expect(pageFile?.type).toBe('asset');
    expect(page.output.some((item) => item.fileName === 'third-party-notices.txt')).toBe(false);
    expect(String(pageFile?.type === 'asset' ? pageFile.source : '')).toContain('Package: page-only@1.2.3');
    expect(reported.some((file) => file.endsWith('node_modules/page-only/index.js'))).toBe(true);
    f.write('app.js', "export { default } from 'app-only';");
    const app = await build({
      configFile: false, root: f.root, logLevel: 'silent',
      plugins: [thirdPartyNotices(undefined, { include: () => reported })],
      build: { write: false, emptyOutDir: false, minify: false, rolldownOptions: { input: join(f.root, 'app.js'), preserveEntrySignatures: 'strict' } },
    }) as Rolldown.RolldownOutput;
    const root = app.output.find((item) => item.fileName === 'third-party-notices.txt');
    const text = String(root?.type === 'asset' ? root.source : '');
    expect(text).toContain('Package: app-only@1.2.3\nLicense: ISC');
    expect(text).toContain('Package: page-only@1.2.3\nLicense: MIT');
  });

  it('says what the build changes in a package, under its license line, and only for that name and version', async () => {
    const f = fixture();
    f.pkg('changed', 'Apache-2.0', { LICENSE: APACHE_TEXT });
    f.pkg('untouched', 'MIT', { LICENSE: MIT });
    f.write('both.js', "export { default as a } from 'changed'; export { default as b } from 'untouched';");
    const result = await build({
      configFile: false, root: f.root, logLevel: 'silent',
      plugins: [thirdPartyNotices(undefined, { changes: { 'changed@1.2.3': 'dist/x.mjs: one call gets its config.', 'untouched@9.9.9': 'not this version.' } })],
      build: { write: false, emptyOutDir: false, minify: false, rolldownOptions: { input: join(f.root, 'both.js'), preserveEntrySignatures: 'strict' } },
    }) as Rolldown.RolldownOutput;
    const file = result.output.find((item) => item.fileName === 'third-party-notices.txt');
    const text = String(file?.type === 'asset' ? file.source : '');
    expect(text).toContain('Package: changed@1.2.3\nLicense: Apache-2.0\nChanged in this build: dist/x.mjs: one call gets its config.\nCopyright lines:');
    expect(text).toContain('Package: untouched@1.2.3\nLicense: MIT\nCopyright lines:');
    expect(text).not.toContain('not this version.');
  });

  it('the release names the one change it makes to Privy’s SDK (build/privy-fixes.ts)', () => {
    expect(Object.keys(PRIVY_CHANGES)).toEqual(['@privy-io/react-auth@3.51.0']);
    expect(PRIVY_CHANGES['@privy-io/react-auth@3.51.0']).toMatch(/^dist\/esm\/index-CaWn8tEz\.mjs: /);
    const config = readFileSync(join(ROOT, 'apps/web/vite.config.ts'), 'utf8');
    expect(config).toContain('{ include: () => alphaSources, changes: PRIVY_CHANGES }');
    expect(readFileSync(join(ROOT, 'apps/web/build/alpha-pages.ts'), 'utf8')).toContain('changes: PRIVY_CHANGES,');
  });
});
