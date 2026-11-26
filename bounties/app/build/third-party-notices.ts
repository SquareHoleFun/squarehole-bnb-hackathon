import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { CSSOptions, Plugin, ResolvedConfig } from 'vite';
import noticeOverrides from './notice-overrides.json' with { type: 'json' };

// Every identifier in an expression must be approved; OR does not silently select a license.
const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'OFL-1.1', '0BSD', 'Unlicense', 'CC0-1.0', 'BlueOak-1.0.0']);
// Standard license terms, used only for a reviewed package/version that ships no license text.
// The copyright placeholder is filled from the override, never inferred from package authors.
const STANDARD_TEXTS: Readonly<Record<string, string>> = {
  MIT: `MIT License

{{copyright}}

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
`,
  ISC: `ISC License

{{copyright}}

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
`,
  'BSD-2-Clause': `BSD 2-Clause License

{{copyright}}

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
`,
  'BSD-3-Clause': `BSD 3-Clause License

{{copyright}}

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
`,
  'Apache-2.0': `                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "{}"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   {{copyright}}

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
`,
};
const LEGAL_FILE = /^(?:licen[cs]e|copying|notice)(?:$|[._-])/i;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|css)$/i;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (values: Iterable<string>) => [...new Set(values)].sort(compare);
const cleanId = (id: string) => id.replace(/[?#].*$/, '');
const thirdParty = (file: string) => file.replaceAll('\\', '/').includes('/node_modules/');

interface Package {
  root: string;
  name: string;
  version: string;
  license?: unknown;
}
interface LegalText { file: string; text: string }
interface NoticeOverride {
  license: string;
  copyright: string;
  source: { url: string; dateRead: string };
}

function standardText(pkg: Package, license: string, overrides: Readonly<Record<string, NoticeOverride>>) {
  const key = `${pkg.name}@${pkg.version}`;
  const entry = Object.hasOwn(overrides, key) ? overrides[key] : undefined;
  if (!entry) throw new Error(`Third-party notices: ${key}: no shipped license text; a reviewed name@version override is required`);
  if (entry.license !== license || typeof entry.copyright !== 'string' || !/^(?:Copyright\b|©)[^\r\n]+$/i.test(entry.copyright)
    || typeof entry.source?.url !== 'string' || !/^https?:\/\/[^\s]+$/.test(entry.source.url) || !URL.canParse(entry.source.url)
    || typeof entry.source?.dateRead !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.source.dateRead)
    || !Number.isFinite(Date.parse(entry.source.dateRead)) || new Date(entry.source.dateRead).toISOString().slice(0, 10) !== entry.source.dateRead) {
    throw new Error(`Third-party notices: ${key}: invalid notice override; matching license, exact copyright line, source URL and date read are required`);
  }
  const template = STANDARD_TEXTS[license];
  if (!template) throw new Error(`Third-party notices: ${key}: no standard text for ${license}; a reviewed implementation is required`);
  return { ...entry, text: template.replaceAll('{{copyright}}', () => entry.copyright) };
}

/** Skip metadata-only package.json files (e.g. viem/_esm/package.json), but never cross node_modules. */
function packageOf(file: string, cache: Map<string, Package | null>): Package | null {
  let dir = dirname(file);
  const visited: string[] = [];
  let result: Package | null = null;
  while (dirname(dir) !== dir && !dir.endsWith('/node_modules')) {
    if (cache.has(dir)) {
      result = cache.get(dir) ?? null;
      break;
    }
    visited.push(dir);
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      const data = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>;
      // F161 (4), SH-ALPHA-SITE: inside node_modules a `private: true` manifest is a subpath's own (npm never publishes
      // a private package: preact/hooks, libphonenumber-js/min), so the walk goes on to the package it belongs to.
      if (typeof data.name === 'string' && !(thirdParty(file) && data.private === true)) {
        if (!thirdParty(file) && !data.name.startsWith('@squarehole/')) break;
        if (typeof data.version !== 'string') throw new Error(`Third-party notices: ${data.name} has no package version`);
        result = { root: dir, name: data.name, version: data.version, license: data.license };
        break;
      }
    }
    dir = dirname(dir);
  }
  for (const path of visited) cache.set(path, result);
  return result;
}

function allowedExpression(expression: string): boolean {
  const tokens = expression.match(/[A-Za-z0-9.+-]+|[()]/g) ?? [];
  if (tokens.join('') !== expression.replace(/\s/g, '')) return false;
  let cursor = 0;
  const atom = (): boolean => {
    const token = tokens[cursor++];
    if (token === '(') return sequence() && tokens[cursor++] === ')';
    return token !== undefined && ALLOWED.has(token);
  };
  const sequence = (): boolean => {
    if (!atom()) return false;
    while (tokens[cursor] === 'AND' || tokens[cursor] === 'OR') {
      cursor++;
      if (!atom()) return false;
    }
    return true;
  };
  return sequence() && cursor === tokens.length;
}

/** A missing field is not a license: recognize an explicit identifier or the conventional MIT grant only. */
function licenseOf(pkg: Package, licenses: LegalText[]): string {
  if (typeof pkg.license === 'string' && pkg.license.trim()) return pkg.license.trim();
  if (!licenses.length) throw new Error(`Third-party notices: ${pkg.name}@${pkg.version}: no license field and no license file`);
  const inferred = new Set<string>();
  for (const { text } of licenses) {
    const spdx = text.match(/SPDX-License-Identifier:\s*([^\r\n]+)/)?.[1]?.trim();
    if (spdx) inferred.add(spdx);
    else if (/\bMIT License\b/.test(text) && text.includes('Permission is hereby granted, free of charge') && text.includes('THE SOFTWARE IS PROVIDED "AS IS"')) inferred.add('MIT');
    // F161 (4), SH-ALPHA-SITE: the Apache License 2.0's own text, by its title, version line and terms heading
    // (@privy-io/api-base ships it with no license field).
    else if (/^\s*Apache License\s*\n\s*Version 2\.0, January 2004\b/.test(text) && text.includes('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION')) inferred.add('Apache-2.0');
    else inferred.add('unidentified license file');
  }
  return sorted(inferred).join(' AND ');
}

/** Copy leading legal comments from the original package source, before minification can strip them. */
function headerOf(file: string): string[] {
  if (!SOURCE_FILE.test(file)) return [];
  const source = readFileSync(file, 'utf8').replace(/^#![^\n]*\n/, '');
  const headers: string[] = [];
  const comments = /^\s*(\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n\s*\/\/[^\n]*)*)/;
  let rest = source;
  for (let match = rest.match(comments); match; match = rest.match(comments)) {
    if (/copyright|@license|@preserve|©/i.test(match[1] ?? '')) headers.push((match[1] ?? '').trim());
    rest = rest.slice(match[0].length);
  }
  return headers;
}

function notices(files: Iterable<string>, overrides: Readonly<Record<string, NoticeOverride>>, changes: Readonly<Record<string, string>> = {}): string {
  const cache = new Map<string, Package | null>();
  const readRoots = new Set<string>();
  const packages = new Map<string, { pkg: Package; sources: Set<string>; legal: Map<string, string> }>();
  for (const file of sorted(files)) {
    if (!existsSync(file)) {
      if (thirdParty(file)) throw new Error(`Third-party notices: cannot read bundled package file ${file.split('/node_modules/').at(-1)}`);
      continue;
    }
    const real = realpathSync(file);
    const pkg = packageOf(real, cache);
    if (!pkg) {
      if (thirdParty(file)) throw new Error(`Third-party notices: no package.json for ${file.split('/node_modules/').at(-1)}`);
      continue;
    }
    if (!thirdParty(file) && !thirdParty(real) && !pkg.name.startsWith('@squarehole/')) continue;
    const key = `${pkg.name}@${pkg.version}`;
    let entry = packages.get(key);
    if (!entry) {
      entry = { pkg, sources: new Set(), legal: new Map() };
      packages.set(key, entry);
    } else if (entry.pkg.license !== pkg.license) {
      throw new Error(`Third-party notices: conflicting licenses for ${key}`);
    }
    entry.sources.add(real);
    if (!pkg.name.startsWith('@squarehole/') && !readRoots.has(pkg.root)) {
      for (const name of readdirSync(pkg.root).filter((name) => LEGAL_FILE.test(name)).sort(compare)) {
        const text = readFileSync(join(pkg.root, name), 'utf8');
        if (text.trim()) entry.legal.set(`${name}\0${text}`, text);
      }
      readRoots.add(pkg.root);
    }
  }
  const shared = new Map<string, string>();
  const reference = (text: string) => {
    // Content addresses make references independent of module order, paths and unrelated packages.
    const name = `sha256:${createHash('sha256').update(text).digest('hex')}`;
    shared.set(name, text);
    return name;
  };
  const sections = ['Third-party notices\n\nPackages contributing code, styles or assets to this build.\n'];
  for (const { pkg, sources, legal } of [...packages.values()].sort((a, b) => compare(a.pkg.name, b.pkg.name) || compare(a.pkg.version, b.pkg.version))) {
    const title = `Package: ${pkg.name}@${pkg.version}`;
    if (pkg.name.startsWith('@squarehole/')) {
      sections.push(`${title}\nLicense: Square Hole workspace (ours)\n`);
      continue;
    }
    const texts = [...legal].map(([key, text]) => ({ file: key.split('\0')[0] ?? '', text })).sort((a, b) => compare(a.file, b.file) || compare(a.text, b.text));
    const licenses = texts.filter(({ file }) => !/^notice/i.test(file));
    const license = licenseOf(pkg, licenses);
    if (!allowedExpression(license)) throw new Error(`Third-party notices: ${pkg.name}@${pkg.version}: license ${JSON.stringify(license)} is not allowed; a reviewed decision is required`);
    const headers = sorted([...sources].flatMap(headerOf));
    const fallback = licenses.length ? undefined : standardText(pkg, license, overrides);
    const copyrights = sorted([...texts.map(({ text }) => text), ...headers].flatMap((text) => text.split(/\r?\n/)
      .filter((line) => /copyright.*(?:\d|\(c\))|©/i.test(line))
      .map((line) => line.replace(/^\s*(?:\/\*+!?|\*|\/\/)\s?/, '').trim())).concat(fallback ? [fallback.copyright] : []));
    const changed = Object.hasOwn(changes, `${pkg.name}@${pkg.version}`) ? changes[`${pkg.name}@${pkg.version}`] : undefined;
    sections.push([
      title,
      `License: ${license}`,
      // Apache-2.0 § 4(b) and its like: a file this build changes says so.
      ...(changed ? [`Changed in this build: ${changed}`] : []),
      'Copyright lines:',
      ...(copyrights.length ? copyrights : ['(none stated in the shipped legal files or source headers)']),
      ...texts.map(({ file, text }) => `${/^notice/i.test(file) ? 'Notice' : 'License'} file: ${file} -> ${reference(text)}`),
      ...(fallback ? [
        `License text: ${license} (standard text; the package ships none) -> ${reference(fallback.text)}`,
        `Copyright source: ${fallback.source.url} (date read: ${fallback.source.dateRead})`,
      ] : []),
      ...headers.map((text) => `Source header -> ${reference(text)}`),
      '',
    ].join('\n'));
  }
  for (const name of sorted(shared.keys())) sections.push(`Text: ${name}\n${shared.get(name)}${shared.get(name)?.endsWith('\n') ? '' : '\n'}`);
  return `${sections.join('\n')}\n`;
}

type PostCssPlugin = NonNullable<Exclude<NonNullable<CSSOptions['postcss']>, string>['plugins']>[number];

/**
 * F161 (4), SH-ALPHA-SITE: the Sepolia alpha's join and desk pages are builds of their own (build/alpha-pages.ts),
 * written into the app's output. Each page's build writes its own copy under its own folder (`fileName`) and hands its
 * source files on (`report`); the app's build adds them to the notices file at the output root (`include`), so that
 * file names every package the whole output ships (G07).
 */
export interface NoticesOptions {
  /** Where the file goes in the output (default `third-party-notices.txt`, the output root). */
  readonly fileName?: string;
  /** Receives every source file this build's inventory read, once the file is written. */
  readonly report?: (files: ReadonlySet<string>) => void;
  /** More source files to inventory: other builds' that ship in the same output. */
  readonly include?: () => Iterable<string>;
  /** What this build changes in a package's files, by `name@version` (build/privy-fixes.ts `PRIVY_CHANGES`). */
  readonly changes?: Readonly<Record<string, string>>;
}

/** Vite's CSS imports and inline fonts are not necessarily JS modules or emitted assets. */
export function thirdPartyNotices(overrides: Readonly<Record<string, NoticeOverride>> = noticeOverrides, options: NoticesOptions = {}): Plugin {
  let root = '';
  let resolveCssUrl: ReturnType<ResolvedConfig['createResolver']>;
  const rendered = new Set<string>();
  const cssSources = new Map<string, Set<string>>();
  const cssCollector: PostCssPlugin = {
    postcssPlugin: 'squarehole-notices-sources',
    async OnceExit(css, { result }) {
      if (!result.opts.from) return;
      const sources = new Set<string>();
      css.walk((node) => { if (node.source?.input.file) sources.add(node.source.input.file); });
      // Runs before Vite's URL rewriter. Resolve even ?inline fonts, which never emit an asset
      // and bypass assetsInlineLimit. Use each declaration's origin after @import expansion.
      const urls: Promise<void>[] = [];
      css.walkDecls((declaration) => {
        for (const match of declaration.value.matchAll(/\burl\(\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s)]+))\s*\)/g)) {
          const url = match[1] ?? match[2] ?? match[3] ?? '';
          if (!url || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(url)) continue;
          urls.push(resolveCssUrl(decodeURI(url), declaration.source?.input.file).then((id) => { if (id) sources.add(cleanId(id)); }));
        }
      });
      await Promise.all(urls);
      cssSources.set(cleanId(result.opts.from), sources);
    },
  };
  return {
    name: 'squarehole-third-party-notices',
    apply: 'build',
    config(config) {
      if (config.css?.transformer === 'lightningcss' || typeof config.css?.postcss === 'string') {
        throw new Error('Third-party notices: CSS source collection requires inline PostCSS configuration');
      }
      return { css: { postcss: { plugins: [cssCollector] } } };
    },
    configResolved(config) {
      root = config.root;
      resolveCssUrl = config.createResolver({ preferRelative: true, tryIndex: false });
    },
    buildStart() { rendered.clear(); cssSources.clear(); },
    renderChunk(_code, chunk) {
      // Capture before Vite removes the empty JS chunks that contained only extracted CSS.
      for (const id of Object.keys(chunk.modules)) if (!id.includes('\0')) rendered.add(cleanId(id));
      return null;
    },
    generateBundle(_options, bundle) {
      const files = new Set(rendered);
      for (const output of Object.values(bundle)) {
        const ids = output.type === 'chunk' ? Object.keys(output.modules) : output.originalFileNames;
        for (const id of ids) if (!id.includes('\0')) files.add(isAbsolute(id) ? cleanId(id) : resolve(root, cleanId(id)));
      }
      for (const file of [...files]) for (const source of cssSources.get(file) ?? []) files.add(source);
      for (const file of options.include?.() ?? []) files.add(file);
      this.emitFile({ type: 'asset', fileName: options.fileName ?? 'third-party-notices.txt', source: notices(files, overrides, options.changes) });
      options.report?.(files);
    },
  };
}
