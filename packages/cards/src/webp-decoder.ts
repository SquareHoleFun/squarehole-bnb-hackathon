import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectBoxPicture, type BoxPicture } from '@squarehole/artwork/box-picture';
import { convertedPng, MAX_CONVERTED_BYTES } from './converted-picture';

export const WEBP_LIMITS = Object.freeze({ children: 1, queue: 4, deadlineMs: 2500, startupMs: 15_000 });
const PROBE = Buffer.from('WebP drawing on\n');
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url)).replace(/^\/@fs\//, '/');
export const WEBP_CHILD_ARGS = ['--max-old-space-size=64', '--experimental-transform-types', '--no-warnings=ExperimentalWarning',
  '--import', here('../scripts/register-ts.mjs'), here('./webp-child.ts')];

interface Options {
  /** Test seam: a direct executable and argv, never a shell. */
  readonly command?: { readonly file: string; readonly args: readonly string[] };
  readonly onChild?: (child: ChildProcess) => void;
  /** Tests can allow a loaded machine more time. The service always uses WEBP_LIMITS. */
  readonly deadlineMs?: number;
}
interface Job {
  readonly input: Uint8Array;
  readonly probe: boolean;
  readonly end: number;
  readonly resolve: (bytes: Buffer | null) => void;
  timer: ReturnType<typeof setTimeout>;
  child?: ChildProcess;
  stopped: boolean;
}

/** Disposable children release all native allocations. A slot is held until close, even after SIGKILL. */
export class WebpDecoder {
  private readonly active = new Set<Job>();
  private readonly queue: Job[] = [];
  private closed = false;
  private enabled = false;
  private readonly onExit = () => { for (const job of this.active) job.child?.kill('SIGKILL'); };

  private constructor(private readonly options: Options) {
    process.once('exit', this.onExit);
  }

  static async start(options: Options = {}): Promise<WebpDecoder> {
    const decoder = new WebpDecoder(options);
    const result = await decoder.submit(new Uint8Array(), true);
    decoder.enabled = result?.equals(PROBE) === true;
    return decoder;
  }

  get available(): boolean { return this.enabled && !this.closed; }

  async decode(picture: BoxPicture): Promise<BoxPicture | null> {
    const info = inspectBoxPicture(picture.bytes);
    if (!this.available || picture.type !== 'image/webp' || info?.type !== 'image/webp') return null;
    const result = await this.submit(picture.bytes, false);
    return result === null ? null : convertedPng(result, info);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of [...this.queue]) this.stop(job);
    const exits = [...this.active].map((job) => new Promise<void>((resolve) => {
      job.child?.once('close', () => resolve());
      this.stop(job);
    }));
    await Promise.all(exits);
    process.removeListener('exit', this.onExit);
  }

  private submit(input: Uint8Array, probe: boolean): Promise<Buffer | null> {
    if (this.closed || (this.active.size >= WEBP_LIMITS.children && this.queue.length >= WEBP_LIMITS.queue)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const ms = this.options.deadlineMs ?? (probe ? WEBP_LIMITS.startupMs : WEBP_LIMITS.deadlineMs);
      const job: Job = { input, probe, end: performance.now() + ms, resolve, stopped: false,
        timer: setTimeout(() => this.stop(job), ms) };
      this.queue.push(job);
      this.pump();
    });
  }

  private stop(job: Job): void {
    job.stopped = true;
    if (job.child) job.child.kill('SIGKILL');
    else {
      const at = this.queue.indexOf(job);
      if (at !== -1) this.queue.splice(at, 1);
      clearTimeout(job.timer);
      job.resolve(null);
    }
  }

  private pump(): void {
    while (!this.closed && this.active.size < WEBP_LIMITS.children && this.queue.length) {
      const job = this.queue.shift();
      if (!job) return;
      if (performance.now() >= job.end) { this.stop(job); continue; }
      this.active.add(job);
      const command = this.options.command ?? { file: process.execPath, args: WEBP_CHILD_ARGS };
      const child = spawn(command.file, [...command.args, ...(job.probe ? ['--probe'] : [])], {
        stdio: ['pipe', 'pipe', 'ignore', 'ipc'], shell: false,
        env: { ...process.env, UV_THREADPOOL_SIZE: '1', MALLOC_ARENA_MAX: '2' },
      });
      job.child = child;
      this.options.onChild?.(child);
      const chunks: Buffer[] = [];
      let length = 0, failed = false;
      child.on('error', () => { failed = true; this.stop(job); });
      child.stdin?.on('error', () => { failed = true; this.stop(job); });
      child.stdout?.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > (job.probe ? PROBE.length : MAX_CONVERTED_BYTES)) { chunks.length = 0; this.stop(job); }
        else if (!job.stopped) chunks.push(chunk);
      });
      child.once('close', (code) => {
        clearTimeout(job.timer);
        this.active.delete(job);
        job.resolve(!failed && !job.stopped && code === 0 && performance.now() < job.end ? Buffer.concat(chunks, length) : null);
        this.pump();
      });
      child.stdin?.end(job.input);
    }
  }
}
