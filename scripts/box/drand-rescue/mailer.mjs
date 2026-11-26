/** One bounded request per run. Mail delivery never changes transaction work or the run's exit code. */
export async function deliver(io, names, message) {
  let url, token;
  try {
    url = new URL(io.env[names[0]]);
    token = io.env[names[1]];
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || !token || !/^[\x21-\x7e]+$/.test(token)) throw new Error();
    url.pathname = `${url.pathname.replace(/\/$/, '')}/alert`;
  } catch { io.stderr.write('mailer configuration unavailable\n'); return; }
  // Keep both the character contract and the JSON byte ceiling, even if future notices use non-ASCII text.
  const chars = Array.from(message.text).slice(0, 6000);
  let body;
  do {
    body = JSON.stringify({ ...message, text: chars.join('') });
    if (Buffer.byteLength(body) <= 8192) break;
    chars.pop();
  } while (chars.length);
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error()); }, 10000);
  });
  let response;
  try {
    response = await Promise.race([timeout, io.fetch(url.href, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body,
    })]);
    if (response.status !== 202 || response.redirected) {
      io.stderr.write(`mailer delivery failed status=${response.status}\n`);
    }
  } catch {
    io.stderr.write(`mailer delivery failed${controller.signal.aborted ? ' timeout' : ''}\n`);
  } finally {
    clearTimeout(timer);
    controller.abort();
    response?.body?.cancel().catch(() => {});
  }
}
