import { mkdirSync, writeFileSync } from 'node:fs';
import { ROOT, stringify } from './support.mjs';

/** Machine-readable results and a compact evidence table; never infer success from test discovery. */
export default class ExamplesReporter {
  rows = [];
  run = new Date().toISOString();
  onBegin() { this.run = new Date().toISOString(); }
  onTestEnd(test, result) {
    const [example, template] = test.title.split(' · ');
    const attachment = result.attachments.find(a => a.name === 'example-evidence');
    const evidence = attachment?.body ? JSON.parse(attachment.body.toString()) : {};
    // Each ended life's raw evidence (pictures, transactions, ledgers) for review, rewritten every run, a skipped life
    // included, and stamped with this run's start: a file from an earlier run can never pass for this one's.
    // Registry ids only, never a path: the registry's own id shape, whose later parts may hold digits (link-marines-v2).
    if (/^[a-z]+(?:-[a-z0-9]+)*$/.test(example)) {
      const directory = new URL('.cache/examples-e2e/evidence/', ROOT);
      mkdirSync(directory, { recursive: true });
      writeFileSync(new URL(`${example}.json`, directory), `${stringify({ example, template, ...evidence, run: this.run,
        status: result.status, annotations: test.annotations })}\n`);
    }
    this.rows.push({ example, template, properties: evidence.completed ?? [], status: result.status,
      runtimeMs: result.duration, annotations: test.annotations, errors: result.errors.map(e => e.message) });
  }
  onEnd(result) {
    const directory = new URL('.cache/examples-e2e/', ROOT);
    mkdirSync(directory, { recursive: true });
    writeFileSync(new URL('results.json', directory), stringify({ status: result.status, run: this.run, examples: this.rows }) + '\n');
    writeFileSync(new URL('results.md', directory), '| Example | Template | Properties checked | Result | Runtime |\n|---|---|---|---|---|\n'
      + this.rows.map(r => `| ${r.example} | ${r.template} | ${r.properties.join(', ')} | ${r.status} | ${r.runtimeMs} ms |`).join('\n') + '\n');
  }
}
