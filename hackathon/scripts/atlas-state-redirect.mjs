// SH-266, for the dry run of the PACKAGED keeper outside its container only: the service writes its state under /state
// (the container's volume); this preload sends those paths to the folder SH_ATLAS_DRY_STATE instead. Nothing else.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const root = process.env.SH_ATLAS_DRY_STATE;
if (!root || !root.startsWith('/')) throw new Error('SH_ATLAS_DRY_STATE: an absolute folder');
const map = p => (typeof p === 'string' && (p === '/state' || p.startsWith('/state/')) ? root + p.slice(6) : p);
for (const name of ['openSync', 'readFileSync', 'writeFileSync', 'mkdirSync', 'rmSync', 'existsSync', 'statSync', 'lstatSync', 'unlinkSync']) {
  const f = fs[name];
  fs[name] = (p, ...rest) => f(map(p), ...rest);
}
const real = fs.realpathSync;
fs.realpathSync = Object.assign((p, ...rest) => real(map(p), ...rest), { native: (p, ...rest) => real.native(map(p), ...rest) });
for (const name of ['renameSync', 'linkSync', 'copyFileSync']) {
  const f = fs[name];
  fs[name] = (a, b, ...rest) => f(map(a), map(b), ...rest);
}
syncBuiltinESMExports();
