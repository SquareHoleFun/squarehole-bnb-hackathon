/** Offline M2 skill command. Live freshness is supplied through refreshLaunchV2, never guessed here. */
import { readFileSync } from 'node:fs';
import { loadBoxSpecLibrary, loadBoxSpecV2Library } from './load-generated.mjs';
import { secretKind, SECRET_MESSAGE } from './spec-secrets.mjs';
import { checkSpecV2, modelForV2, loadTwinV2, renderMenuV2, renderTextV2, exitCodeOfV2 } from './spec-launch-v2.mjs';

export async function runLaunchCheckV2(args) {
  const print = (r) => process.stdout.write(args.includes('--json') ? `${JSON.stringify(r, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)}\n` : renderTextV2(r));
  const secret = () => { print({ ok: false, stage: 'secret', paths: ['input'], problems: [], message: SECRET_MESSAGE }); return 4; };
  if (args.some((a) => secretKind(a)) || secretKind(args.filter((a) => !a.startsWith('--')).join(' '))) return secret();
  const options = {};
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (['--format', '--network', '--listings'].includes(a)) {
      if (!args[i + 1] || args[i + 1].startsWith('--') || options[a] !== undefined) { process.stderr.write('Each option needs one value.\n'); return 2; }
      options[a] = args[++i];
    } else if (['--menu', '--json'].includes(a)) options[a] = true;
    else if (a.startsWith('--')) { process.stderr.write('Use --menu or a draft, with --network and optional --listings. Live reads require the refreshLaunchV2 reader.\n'); return 2; }
    else files.push(a);
  }
  if (options['--format'] !== '2' || (options['--menu'] ? files.length !== 0 : files.length !== 1)) { process.stderr.write('Use --format 2 and either --menu or one draft file.\n'); return 2; }
  let doc;
  let indexer;
  try {
    if (files.length) {
      const text = readFileSync(files[0], 'utf8').replace(/^\uFEFF/, '');
      try { doc = JSON.parse(text); } catch { if (secretKind(text)) return secret(); throw new Error(); }
    }
    if (options['--listings']) indexer = JSON.parse(readFileSync(options['--listings'], 'utf8'));
  } catch { process.stderr.write('Cannot read the draft or listing snapshot as JSON.\n'); return 3; }
  await loadBoxSpecLibrary();
  let model;
  try {
    model = modelForV2({ network: options['--network'] ?? doc?.network ?? 'sepolia', indexer, twin: await loadTwinV2(), curve: await loadBoxSpecV2Library() });
  } catch { process.stderr.write('Use a demo or sepolia menu and a matching listing snapshot.\n'); return 2; }
  if (options['--menu']) { process.stdout.write(renderMenuV2(model)); return 0; }
  try {
    const result = checkSpecV2(model, doc);
    print(result);
    return exitCodeOfV2(result);
  } catch { process.stderr.write('Cannot check this value shape; use references/v2/spec-json.md.\n'); return 3; }
}
