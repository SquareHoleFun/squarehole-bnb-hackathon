// The Four.meme rail's creation signer as a small HTTP service of the stack (SH-259; lane g's function in
// bounties/openfour/sign/, its README is the contract). Caddy sends it POST /launches/api/four/sign-create and
// GET /launches/api/four/health on the site's own origin; nothing else reaches it.
//
// - It holds no key but its own keystore and password file (/run/sign/keystore.json, /run/sign/password, from the
//   settings folder's sign/), sends no transaction and needs no coins.
// - It is OFF, every request answering a plain 503, until the copy's records exist (/run/sign/out, the real run's
//   out/) and lane g's factory accepted them, which includes "Core's signer is this key"; it tries again every 30 s.
// - A request: POST, JSON only, at most 2,048 bytes (lane g's MAX_BODY_BYTES: counted while reading, byte 2,049 ends the
//   read with 413 before anything is parsed), no cross-origin answer (an Origin other than the site's is refused, no
//   CORS header is ever sent), then the limits, then the function. SignRefused -> 400 {error, message} with the
//   function's fixed texts; anything else -> 500 with a fixed text. The log line carries the creator, the kind and the
//   code, never a signature or a body.
// - SH-307, the limits (settings, `limitsOf`): signatures per client address an hour (600), per creator address an hour
//   (5), all signatures a UTC day (20,000: one address at its hourly number cannot use up a day alone). Every POST to
//   the route counts toward a plain ceiling of five times the address's signatures an hour (at least 100), right after
//   the route and method checks. Then a request is checked by lane g's own `check` (the kinds offered, the creator, every field);
//   one it refuses gets its 400 and never touches a signature slot. Only a request that will be handed to the signing
//   call takes its address's, its creator's and the day's slot (one clock reading for all three), and only an error
//   of that call gives them back; an error after a signature was made (its log line, its answer) gives nothing back.
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");

/** SH-307: the defaults of the three limits (signatures), each a setting; requests per address an hour: five times the first. */
const LIMITS = Object.freeze({ perClientPerHour: 600, perCreatorPerHour: 5, perDay: 20_000 });
const LIMIT_SETTINGS = Object.freeze([["SIGN_LIMIT_PER_CLIENT_HOUR", "perClientPerHour", 100_000], ["SIGN_LIMIT_PER_CREATOR_HOUR", "perCreatorPerHour", 1_000],
  ["SIGN_LIMIT_PER_DAY", "perDay", 100_000]]);
const MAX_BODY = 2048; // lane g's MAX_BODY_BYTES (sign-create.js); the test checks they are the same
const ROUTE = "/launches/api/four/sign-create";
const HEALTH = "/launches/api/four/health";
const HOUR = 3_600_000;
const DAY = 86_400_000;

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/**
 * SH-307: the limits from the settings: each unset or empty (its default) or a whole number from 1 to its bound (per
 * client address an hour 100,000; per creator an hour 1,000; per day 100,000); anything else stops the start.
 */
function limitsOf(env = process.env) {
  const out = { ...LIMITS };
  for (const [name, key, max] of LIMIT_SETTINGS) {
    const value = env[name] ?? "";
    if (value === "") continue;
    if (!/^[1-9][0-9]{0,5}$/.test(value) || Number(value) > max) throw new Error(`${name} must be a whole number from 1 to ${max}`);
    out[key] = Number(value);
  }
  return Object.freeze(out);
}

/**
 * Counts in fixed windows (an hour per client and per creator, a UTC day in all). A read creates nothing: an entry is
 * made only when something is counted, and `prune` drops each entry once its own window has passed.
 */
function limiter(now = () => Date.now(), limits = LIMITS) {
  const windows = new Map();
  const startOf = (span, t) => Math.floor(t / span) * span;
  const count = (key, span, t) => { const w = windows.get(key); return w && w.start === startOf(span, t) ? w.n : 0; };
  const add = (key, span, t) => {
    const start = startOf(span, t), w = windows.get(key);
    if (w && w.start === start) w.n += 1; else windows.set(key, { start, span, n: 1 });
    return start;
  };
  return {
    // Every POST of an address to the route: a plain ceiling against a flood (five times its signatures an hour, never
    // below 100, so that a small signature number never lets a few refused requests shut out a valid one).
    request: (ip) => {
      const t = now();
      if (count(`r:${ip}`, HOUR, t) >= Math.max(100, 5 * limits.perClientPerHour)) return false;
      add(`r:${ip}`, HOUR, t); return true;
    },
    // The address's, the creator's and the day's slots, taken together right BEFORE the signing call, at one clock
    // reading (synchronously: two overlapping requests cannot both take the last one); `release` gives them back to
    // the windows they were taken in, once.
    reserve: (ip, who) => {
      const t = now();
      if (count(`c:${ip}`, HOUR, t) >= limits.perClientPerHour || count(`w:${who}`, HOUR, t) >= limits.perCreatorPerHour
        || count("day", DAY, t) >= limits.perDay) return null;
      return { ip, who, client: add(`c:${ip}`, HOUR, t), creator: add(`w:${who}`, HOUR, t), day: add("day", DAY, t), released: false };
    },
    release: (slot) => {
      if (slot.released) return;
      slot.released = true;
      const back = (key, start) => { const w = windows.get(key); if (w && w.start === start && w.n > 0) w.n -= 1; };
      back(`c:${slot.ip}`, slot.client); back(`w:${slot.who}`, slot.creator); back("day", slot.day);
    },
    prune: () => { const t = now(); for (const [k, w] of windows) if (t >= w.start + w.span) windows.delete(k); },
    size: () => windows.size,
    has: (key) => windows.has(key),
  };
}

/**
 * The service. `start()` yields lane g's signer ({address, sign(body)}) or throws; `SignRefused` is its refusal class.
 * `log(line)` takes one object per request or state change.
 */
function createServer({ start, SignRefused, origin, log = (o) => process.stdout.write(`sign: ${JSON.stringify(o)}\n`), now,
  limits: settings = LIMITS, kinds = ["preset", "tax"], check = null }) {
  const state = { phase: "waiting-for-records", signer: null, coreSignerIsKey: false };
  let service = null;
  let trying = null;
  const limits = limiter(now, settings);
  // A log line that cannot be written never keeps a request from its answer, nor a state change from its record.
  const note = (o) => { try { log(o); } catch { /* the log line could not be written */ } };
  async function tryStart() {
    if (service || trying) return;
    trying = (async () => {
      let next;
      try {
        const s = await start();
        if (!s) next = { phase: "waiting-for-records", signer: null, coreSignerIsKey: false };
        else { service = s; next = { phase: "ready", signer: s.address, coreSignerIsKey: true }; }
      } catch (error) {
        // Lane g's refusals carry a fixed stage code (StartupRefused.code); the health answer names it, nothing else.
        const code = error && typeof error.code === "string" && /^[A-Z_]{3,20}$/.test(error.code) ? error.code : "OTHER";
        const reason = code === "CORE_SIGNER" ? "core-signer-is-not-this-key" : code.toLowerCase().replace(/_/g, "-");
        next = { phase: "refused", signer: null, coreSignerIsKey: false, reason };
      }
      if (next.phase !== state.phase || next.reason !== state.reason) note({ event: "state", phase: next.phase, ...(next.reason ? { reason: next.reason } : {}) });
      Object.assign(state, next);
      if (next.phase !== "refused") delete state.reason;
    })().finally(() => { trying = null; });
    return trying;
  }

  // The kinds a POST is accepted for: the service's own configuration when it has one (lane g's `check` accepts preset,
  // tax, and tax-rules only where its configuration offers it), else the given list.
  const offered = () => (service && service.config && service.config.kinds
    ? ["preset", "tax", ...(service.config.kinds["tax-rules"] ? ["tax-rules"] : [])] : [...kinds]);
  const server = http.createServer((req, res) => {
    const url = (req.url || "").split("?")[0];
    if (url === HEALTH && (req.method === "GET" || req.method === "HEAD")) {
      // SH-307: the kinds it signs, only while ready (a page asks this GET instead of a refused POST).
      return json(res, state.phase === "ready" ? 200 : 503, { state: state.phase, signer: state.signer, coreSignerIsKey: state.coreSignerIsKey,
        ...(state.reason ? { reason: state.reason } : {}), ...(state.phase === "ready" ? { kinds: offered() } : {}) });
    }
    if (url !== ROUTE) return json(res, 404, { error: "NOT_FOUND", message: "not found" });
    if (req.method !== "POST") return json(res, 405, { error: "METHOD", message: "POST only" });
    // The client address Caddy sets (X-Forwarded-For {client_ip}, replacing any the visitor sent). Every POST to the
    // route counts toward the address's plain ceiling, whatever happens to it next.
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
    if (!limits.request(ip)) return json(res, 429, { error: "RATE_LIMITED", message: "too many requests; try again later" });
    if (req.headers.origin !== undefined && req.headers.origin !== origin) return json(res, 403, { error: "ORIGIN", message: "this origin may not call the signer" });
    if (!/^application\/json(\s*;.*)?$/i.test(req.headers["content-type"] || "")) return json(res, 415, { error: "TYPE", message: "JSON only" });
    if (!service) { res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }); return res.end("unavailable"); }
    const tooLarge = () => { res.setHeader("connection", "close"); json(res, 413, { error: "TOO_LARGE", message: "the request is too large" }); };
    if (Number(req.headers["content-length"] || 0) > MAX_BODY) return tooLarge();
    const chunks = [];
    let size = 0, over = false;
    req.on("data", (c) => {
      if (over) return;
      size += c.length;
      if (size > MAX_BODY) { over = true; req.pause(); tooLarge(); res.on("finish", () => req.destroy()); } else chunks.push(c);
    });
    req.on("error", () => {});
    req.on("end", async () => {
      if (over) return;
      let body, creator = null, kind = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = undefined; }
      if (body && typeof body === "object" && !Array.isArray(body)) {
        if (typeof body.creator === "string" && /^0x[0-9a-fA-F]{40}$/.test(body.creator)) creator = body.creator.toLowerCase();
        if (body.kind === "preset" || body.kind === "tax" || body.kind === "tax-rules") kind = body.kind;
      }
      const refuse = (error) => {
        if (error instanceof SignRefused) {
          note({ creator, kind, code: error.code });
          return json(res, 400, { error: error.code, message: error.message });
        }
        note({ creator, kind, code: "INTERNAL" });
        return json(res, 500, { error: "INTERNAL", message: "the signer failed" });
      };
      // Lane g's own check first (the kind offered, the creator, every field): a request it refuses never touches a
      // signature slot. The checked creator is the one counted.
      if (check) {
        try { creator = check(service.config, body).creator.toLowerCase(); } catch (error) { return refuse(error); }
      }
      const slot = limits.reserve(ip, creator || "none");
      if (!slot) {
        note({ creator, kind, code: "RATE_LIMITED" });
        return json(res, 429, { error: "RATE_LIMITED", message: "too many requests; try again later" });
      }
      let answer;
      try { answer = await service.sign(body); } catch (error) { limits.release(slot); return refuse(error); }
      // The signature exists: whatever happens to its answer or its log line, its slots stay taken.
      try { json(res, 200, answer); } catch { /* the answer could not be written */ }
      note({ creator, kind, code: "SIGNED" });
    });
  });
  return { server, tryStart, state, limits };
}

/**
 * SH-287: SIGN_TAX_RULES (stack.env SH_BNB_SIGN_TAX_RULES, through compose) is unset, "0" or "1"; anything else stops
 * the start. Only "1" gives lane g's factory `taxRules: true` (the kind tax-rules, which needs the rules run's three
 * records in out/: without them the factory refuses with TAX_RULES_RECORDS and the service stays off).
 */
function taxRulesOf(env = process.env) {
  const value = env.SIGN_TAX_RULES ?? "";
  if (value !== "" && value !== "0" && value !== "1") throw new Error("SIGN_TAX_RULES must be unset, 0 or 1");
  return value === "1";
}

/** Lane g's factory's settings: today's call exactly, plus `taxRules: true` only when SIGN_TAX_RULES is 1. */
function serviceOptions(dir = "/run/sign", env = process.env) {
  return { rpc: env.SIGN_RPC || "https://bsc-testnet-rpc.publicnode.com", outDir: path.join(dir, "out"),
    keystore: path.join(dir, "keystore.json"), passwordFile: path.join(dir, "password"),
    quotes: (env.SIGN_QUOTES || "").split(",").map((s) => s.trim()).filter(Boolean),
    raiseMin: env.SIGN_RAISE_MIN || "0.1", raiseMax: env.SIGN_RAISE_MAX || "2", ...(taxRulesOf(env) ? { taxRules: true } : {}) };
}

/** Lane g's production factory, only once the records, the keystore and the password file are all in place. */
function productionStart(dir = "/run/sign") {
  const { createSignService } = require("/app/openfour/sign/service");
  const need = [path.join(dir, "out", "fork-deployment.json"), path.join(dir, "out", "preset-registration.json"),
    path.join(dir, "out", "tax-template.json"), path.join(dir, "keystore.json"), path.join(dir, "password")];
  return async () => {
    if (!need.every((f) => fs.existsSync(f))) return null;
    return createSignService(serviceOptions(dir));
  };
}

if (require.main === module) {
  const { SignRefused, check } = require("/app/openfour/sign/sign-create");
  const origin = process.env.SIGN_ORIGIN;
  if (!origin || !/^https:\/\/[a-z0-9.-]+(:[0-9]+)?$/.test(origin)) { process.stderr.write("sign: SIGN_ORIGIN must be the site's https origin\n"); process.exit(78); }
  let settings;
  try { taxRulesOf(); settings = limitsOf(); } catch (error) { process.stderr.write(`sign: ${error.message}\n`); process.exit(78); }
  const { server, tryStart, limits } = createServer({ start: productionStart(), SignRefused, origin, limits: settings, check });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.listen(8080, "0.0.0.0", () => process.stdout.write(`sign: listening; off until the copy's records and its key are in place${taxRulesOf() ? "; tax-rules on" : ""}; limits ${settings.perClientPerHour}/${settings.perCreatorPerHour}/${settings.perDay}\n`));
  tryStart();
  setInterval(() => { tryStart(); limits.prune(); }, 30_000).unref();
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}

module.exports = { createServer, limiter, limitsOf, LIMITS, MAX_BODY, serviceOptions, taxRulesOf };
