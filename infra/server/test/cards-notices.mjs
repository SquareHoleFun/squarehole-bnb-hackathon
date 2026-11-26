import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export function assertCardNotices(noticesRoot = '/app/notices', packageJson = '/app/packages/cards/package.json') {
  const r=createRequire(packageJson), b=createRequire(r.resolve('sharp'));
  const own=['README.md','sharp-Apache-2.0.txt','libwebp-BSD-3-Clause.txt','sharp-libvips-linux-x64-1.3.4.md','sharp-libvips-versions.json'];
  for(const file of own) if(!readFileSync(join(noticesRoot,file)).length) throw new Error('empty notice: '+file);
  for(const [name,root,files] of [['sharp',dirname(dirname(r.resolve('sharp'))),['LICENSE','README.md']],['sharp-linux-x64',dirname(b.resolve('@img/sharp-linux-x64/package')),['LICENSE','README.md']],['sharp-libvips-linux-x64',dirname(b.resolve('@img/sharp-libvips-linux-x64/package')),['README.md','versions.json']]]) {
    for(const file of files) if(!readFileSync(join(noticesRoot,name,file)).equals(readFileSync(join(root,file)))) throw new Error('notice differs: '+name+'/'+file);
  }
  const readme=readFileSync(join(noticesRoot,'README.md'),'utf8');
  if(!readme.includes('that is a release blocker') || !readme.includes('not distributed')) throw new Error('distribution rule absent');
  if(JSON.parse(readFileSync(join(noticesRoot,'sharp-libvips-linux-x64/versions.json'),'utf8')).webp!=='1.6.0') throw new Error('review libwebp notices');
  process.stdout.write('cards notices: 11 files present; package copies match; external distribution blocked until gaps are closed\n');
}
