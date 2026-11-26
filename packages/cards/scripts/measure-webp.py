"""Linux decoder measurements. No network or image files written. Run through nice and mise.

This measures a complete disposable child, without the service deadline, so slow runs
remain visible. ru_maxrss is the child's peak resident memory in KiB on Linux.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time

root = Path(__file__).resolve().parents[3]
args = [shutil.which('node'), '--max-old-space-size=64', '--experimental-transform-types',
        '--no-warnings=ExperimentalWarning', '--import', './packages/cards/scripts/register-ts.mjs',
        'packages/cards/src/webp-child.ts']
env = {**os.environ, 'UV_THREADPOOL_SIZE': '1', 'MALLOC_ARENA_MAX': '2'}
def decode(data):
    """Use the real child's stdin lifetime protocol; drain output before closing input."""
    start = time.monotonic()
    child = subprocess.Popen(args, cwd=root, env=env, stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    failures = []

    def send():
        try:
            child.stdin.write(data)
            child.stdin.flush()
            # EOF means parent death without IPC. Keep this pipe open until wait4.
        except OSError as error:
            failures.append(error)

    sender = threading.Thread(target=send)
    sender.start()
    try:
        png = child.stdout.read()
        error = child.stderr.read()
        sender.join()
        _, status, usage = os.wait4(child.pid, 0)
        child.returncode = os.waitstatus_to_exitcode(status)
        if failures:
            raise failures[0]
        return png, dict(input_bytes=len(data), png_bytes=len(png),
                         wall_ms=round((time.monotonic() - start) * 1000, 2),
                         peak_rss_kib=usage.ru_maxrss, user_s=usage.ru_utime,
                         system_s=usage.ru_stime, exit=child.returncode,
                         error=error.decode())
    finally:
        if child.returncode is None:
            child.kill()
            child.wait()
        sender.join()
        child.stdin.close()
        child.stdout.close()
        child.stderr.close()


def main():
    for name in ['packages/artwork/src/picture-fixtures/ordinary.webp',
                 'packages/artwork/src/picture-fixtures/at-pixel-budget.webp',
                 'packages/cards/src/webp-fixtures/wide-png.webp']:
        data = (root / name).read_bytes()
        if name.endswith('wide-png.webp'):
            # A valid ignored RIFF chunk fills the byte cap while retaining the 4,194,304-pixel canvas.
            length = 1048576 - len(data) - 8
            data = data[:4] + (1048576 - 8).to_bytes(4, 'little') + data[8:]
            data += b'JUNK' + length.to_bytes(4, 'little') + bytes(length)
        for run in range(1, 4):
            png, result = decode(data)
            print(json.dumps(dict(file=name, run=run, **result)), flush=True)
            if result['exit']:
                raise SystemExit(result['exit'])
            if not png.startswith(b'\x89PNG\r\n\x1a\n'):
                raise SystemExit('child returned no PNG')


if __name__ == '__main__':
    main()
