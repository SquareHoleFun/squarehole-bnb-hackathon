// The stack's signing service around lane g's function (SH-259), with lane g's own signCreate and its test's copy
// configuration: off until started, the fixed refusal texts, the limits, the origin rule, the log.
// Runs inside the service's image, where lane g's folder is /app/openfour:
//   docker run --rm --entrypoint node squarehole-bnb-sign:<release> --test /app/hackathon-sign/test/server.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const lib = process.env.SIGN_LIB || "/app/openfour/sign";
const { ethers } = require(require.resolve("ethers", { paths: [lib] }));
const { MAX_BODY_BYTES, SignRefused, TEXTS, raiseBounds, signCreate, createDigest } = require(`${lib}/sign-create`);
const http = require("node:http");
const { createServer, limiter, limitsOf, LIMITS, MAX_BODY, serviceOptions, taxRulesOf } = require("../server");

const WBNB = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd";
const TETH = "0x860822580d4eb2529de0c74c3e2b1d6d7c183302";
const p = (name, abiType) => ({ name, abiType, decimals: 0, optional: false, defaultValue: "" });
const EMPTY = { token: [], vault: [], curve: [], trade: [], migrate: [], customData: [] };
const CONFIG = { chainId: "97", quotes: [WBNB, TETH], raiseWei: raiseBounds("0.1", "2"),
  kinds: { preset: { presetId: "1778027700001", schemas: { ...EMPTY, trade: [p("buyFeeBps", "uint16"), p("sellFeeBps", "uint16")] } },
    tax: { presetId: "1778027615723", template: "0x1111111111111111111111111111111111111111", schemas: { ...EMPTY,
      token: [p("founder", "address"), p("buyFeeRate", "uint256"), p("sellFeeRate", "uint256"), p("rateFounder", "uint256"),
        p("rateHolder", "uint256"), p("rateBurn", "uint256"), p("rateLiquidity", "uint256"), p("minShare", "uint256"),
        p("taxVaultTypeId", "bytes32"), p("taxVaultInitParams", "bytes")] } } } };
const ORIGIN = "https://site.example";
const key = ethers.Wallet.createRandom();

async function up(start, extra = {}) {
  const lines = [];
  const s = createServer({ start, SignRefused, origin: ORIGIN, log: (o) => lines.push(JSON.stringify(o)), ...extra });
  await new Promise((r) => s.server.listen(0, "127.0.0.1", r));
  await s.tryStart();
  const base = `http://127.0.0.1:${s.server.address().port}`;
  const call = (body, { headers = {}, method = "POST", path = "/launches/api/four/sign-create", raw } = {}) =>
    fetch(base + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.1", ...headers },
      ...(method === "POST" ? { body: raw ?? JSON.stringify(body) } : {}) });
  return { ...s, lines, call, close: () => { s.server.closeAllConnections(); return new Promise((r) => s.server.close(r)); } };
}
const ready = () => up(async () => ({ address: key.address, sign: (b) => signCreate(CONFIG, key, b, Math.floor(Date.now() / 1000)) }));
const request = (creator, over = {}) => ({ kind: "preset", creator, name: "Pile Demo", symbol: "PILE", quote: TETH, raiseAmount: "1",
  buyFeeBps: 100, sellFeeBps: 200, ...over });

test("off until the records are placed: the route answers a plain 503, the health says so", async () => {
  const s = await up(async () => null);
  const r = await s.call(request(ethers.Wallet.createRandom().address));
  assert.equal(r.status, 503);
  assert.equal(await r.text(), "unavailable");
  const h = await s.call(null, { method: "GET", path: "/launches/api/four/health" });
  assert.equal(h.status, 503);
  assert.deepEqual(await h.json(), { state: "waiting-for-records", signer: null, coreSignerIsKey: false });
  await s.close();
});

test("a factory that refuses (Core's signer is another key): off, and the health names the reason, not the error", async () => {
  const { StartupRefused } = require(`${lib}/service`);
  const s = await up(async () => { throw new StartupRefused("CORE_SIGNER"); });
  const h = await s.call(null, { method: "GET", path: "/launches/api/four/health" });
  assert.deepEqual(await h.json(), { state: "refused", signer: null, coreSignerIsKey: false, reason: "core-signer-is-not-this-key" });
  assert.equal((await s.call(request(key.address))).status, 503);
  await s.close();
});

test("ready: a signature Core accepts for that creator; the health names the key; the log has no signature", async () => {
  const s = await ready();
  const creator = ethers.Wallet.createRandom().address;
  const r = await s.call(request(creator));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), null);
  const a = await r.json();
  assert.equal(ethers.verifyMessage(ethers.getBytes(createDigest(97n, creator, a.createArgs)), a.signature), key.address);
  const h = await (await s.call(null, { method: "GET", path: "/launches/api/four/health" })).json();
  assert.deepEqual(h, { state: "ready", signer: key.address, coreSignerIsKey: true, kinds: ["preset", "tax"] });
  assert.ok(s.lines.some((l) => l.includes(creator.toLowerCase()) && l.includes('"kind":"preset"') && l.includes('"code":"SIGNED"')));
  assert.ok(s.lines.every((l) => !l.includes(a.signature.slice(2, 40)) && !l.includes(a.createArgs.slice(2, 40))));
  await s.close();
});

test("refusals: 400 with the function's fixed code and text; anything else a plain 500", async () => {
  const s = await ready();
  for (const [over, code] of [[{ name: "" }, "BAD_NAME"], [{ symbol: "pile" }, "BAD_SYMBOL"], [{ quote: WBNB.replace("a", "b") }, "BAD_QUOTE"],
    [{ raiseAmount: "9" }, "BAD_RAISE"], [{ kind: "other" }, "BAD_KIND"], [{ extra: 1 }, "UNKNOWN_FIELD"]]) {
    const r = await s.call(request(ethers.Wallet.createRandom().address, over), { headers: { "x-forwarded-for": `203.0.113.${code.length}` } });
    assert.equal(r.status, 400, code);
    assert.deepEqual(await r.json(), { error: code, message: TEXTS[code] });
  }
  const broken = await up(async () => ({ address: key.address, sign: async () => { throw new Error("rpc https://secret.example down"); } }));
  const r = await broken.call(request(key.address));
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { error: "INTERNAL", message: "the signer failed" });
  await broken.close();
  await s.close();
});

test("the request's shape: POST only, JSON only, at most 2,048 bytes, no other origin", async () => {
  const s = await ready();
  assert.equal((await s.call(null, { method: "GET" })).status, 405);
  assert.equal((await s.call(null, { headers: { "content-type": "text/plain" }, raw: "{}" })).status, 415);
  assert.equal((await s.call(null, { raw: JSON.stringify({ pad: "x".repeat(5000) }) })).status, 413);
  const other = await s.call(request(key.address), { headers: { origin: "https://elsewhere.example" } });
  assert.equal(other.status, 403);
  assert.equal(other.headers.get("access-control-allow-origin"), null);
  assert.equal((await s.call(request(ethers.Wallet.createRandom().address), { headers: { origin: ORIGIN } })).status, 200);
  await s.close();
});

// SH-307 step 2: lane g's own check runs before any slot is taken (the production server passes it).
const { check } = require(`${lib}/sign-create`);
const RULES_CONFIG = { ...CONFIG, kinds: { ...CONFIG.kinds, "tax-rules": { presetId: "1778027615724", template: "0x2222222222222222222222222222222222222222", schemas: EMPTY } } };
const checked = (extra = {}, sign = (b) => signCreate(CONFIG, key, b, 1_800_000_000), config = CONFIG) =>
  up(async () => ({ address: key.address, config, sign }), { check, ...extra });
const at = (ip) => ({ headers: { "x-forwarded-for": ip } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("SH-307 the limits: per creator and per address an hour, a day; a refused request costs no slot; the next hour, the next day", async () => {
  let t = Date.UTC(2026, 10, 25, 12);
  const small = { perClientPerHour: 3, perCreatorPerHour: 2, perDay: 6 };
  const s = await checked({ now: () => t, limits: small });
  const creator = ethers.Wallet.createRandom().address;
  for (let i = 0; i < small.perCreatorPerHour; i++) assert.equal((await s.call(request(creator), at(`192.0.2.${i}`))).status, 200);
  assert.equal((await s.call(request(creator), at("192.0.2.99"))).status, 429);
  // Ten refusals from one address (a bad name, an unknown kind, a body that is not JSON): each 400, none takes a slot.
  for (let i = 0; i < 4; i++) assert.equal((await s.call(request(ethers.Wallet.createRandom().address, { name: "" }), at("198.51.100.7"))).status, 400);
  for (let i = 0; i < 4; i++) assert.equal((await s.call(request(ethers.Wallet.createRandom().address, { kind: "tax-rules" }), at("198.51.100.7"))).status, 400);
  for (let i = 0; i < 2; i++) assert.equal((await s.call(null, { raw: "not json", ...at("198.51.100.7") })).status, 400);
  for (let i = 0; i < small.perClientPerHour; i++) assert.equal((await s.call(request(ethers.Wallet.createRandom().address), at("198.51.100.7"))).status, 200);
  const r = await s.call(request(ethers.Wallet.createRandom().address), at("198.51.100.7"));
  assert.deepEqual([r.status, await r.json()], [429, { error: "RATE_LIMITED", message: "too many requests; try again later" }]);
  assert.equal((await s.call(request(ethers.Wallet.createRandom().address), at("10.0.0.1"))).status, 200); // the day's sixth
  assert.equal((await s.call(request(ethers.Wallet.createRandom().address), at("10.0.0.2"))).status, 429);
  t += 3_600_000; // the next hour, the same UTC day: the day stays full
  assert.equal((await s.call(request(creator), at("192.0.2.200"))).status, 429);
  t += 86_400_000; // the next day
  assert.equal((await s.call(request(creator), at("192.0.2.200"))).status, 200);
  await s.close();
});

test("SH-307: with the defaults (600, 5, 20,000) the 21st signature of one address is signed, and a refused probe costs nothing", async () => {
  assert.deepEqual({ ...LIMITS }, { perClientPerHour: 600, perCreatorPerHour: 5, perDay: 20_000 });
  const s = await checked();
  for (let i = 0; i < 30; i++) assert.equal((await s.call(request(ethers.Wallet.createRandom().address, { kind: "tax-rules" }))).status, 400);
  for (let i = 1; i <= 21; i++) assert.equal((await s.call(request(ethers.Wallet.createRandom().address))).status, 200, `signature ${i}`);
  await s.close();
});

test("SH-307: two requests in flight with one slot left: exactly one is signed", async () => {
  const s = await checked({ limits: { perClientPerHour: 1, perCreatorPerHour: 5, perDay: 100 } },
    async (b) => { await wait(150); return signCreate(CONFIG, key, b, 1_800_000_000); });
  const both = await Promise.all([s.call(request(ethers.Wallet.createRandom().address), at("203.0.113.1")), s.call(request(ethers.Wallet.createRandom().address), at("203.0.113.1"))]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 429]);
  await s.close();
});

test("SH-307: a plain throw of the signing call (500) gives the slots back once, never twice", async () => {
  // Two of one address in flight at a limit of 2: the first call throws, the second signs. Afterwards the count must
  // stand at 1 (one more is signed, then 429); a second give-back of the first would leave it at 0 (two more signed).
  let calls = 0;
  const s = await checked({ limits: { perClientPerHour: 2, perCreatorPerHour: 5, perDay: 100 } }, async (b) => {
    calls += 1; const mine = calls;
    await wait(mine === 1 ? 50 : 150);
    if (mine === 1) throw new Error("the key could not be read");
    return signCreate(CONFIG, key, b, 1_800_000_000);
  });
  const both = await Promise.all([s.call(request(ethers.Wallet.createRandom().address), at("203.0.113.2")), s.call(request(ethers.Wallet.createRandom().address), at("203.0.113.2"))]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 500]);
  assert.equal((await s.call(request(ethers.Wallet.createRandom().address), at("203.0.113.2"))).status, 200);
  assert.equal((await s.call(request(ethers.Wallet.createRandom().address), at("203.0.113.2"))).status, 429);
  await s.close();
  // The same on the limiter itself: a slot given back twice counts once.
  const l = limiter(() => Date.UTC(2026, 10, 25, 12), { perClientPerHour: 2, perCreatorPerHour: 5, perDay: 100 });
  const a = l.reserve("x", "w1"); assert.ok(a && l.reserve("x", "w2"));
  l.release(a); l.release(a);
  assert.ok(l.reserve("x", "w3"));
  assert.equal(l.reserve("x", "w4"), null);
});

test("SH-307: a log line that throws never keeps a refusal, a 500 or a 429 from its answer", async () => {
  let n = 0;
  const s = await checked({ limits: { perClientPerHour: 1, perCreatorPerHour: 5, perDay: 100 }, log: () => { throw new Error("the log is gone"); } },
    async (b) => { n += 1; if (n === 1) throw new Error("boom"); return signCreate(CONFIG, key, b, 1_800_000_000); });
  assert.equal((await s.call(request(ethers.Wallet.createRandom().address, { kind: "swap" }), at("203.0.113.8"))).status, 400);
  assert.equal((await s.call(request(ethers.Wallet.createRandom().address), at("203.0.113.8"))).status, 500);
  assert.equal((await s.call(request(ethers.Wallet.createRandom().address), at("203.0.113.8"))).status, 200);
  assert.equal((await s.call(request(ethers.Wallet.createRandom().address), at("203.0.113.8"))).status, 429);
  await s.close();
});

test("SH-307: refused requests in flight leave every count untouched: the last slot beside them is signed", async () => {
  const s = await checked({ limits: { perClientPerHour: 1, perCreatorPerHour: 1, perDay: 1 } },
    async (b) => { await wait(100); return signCreate(CONFIG, key, b, 1_800_000_000); });
  const creator = ethers.Wallet.createRandom().address;
  const refused = [
    s.call(null, { raw: "{", ...at("203.0.113.3") }), // bad JSON
    s.call(request(undefined), at("203.0.113.3")), // no wallet
    s.call(request(creator, { kind: "swap" }), at("203.0.113.3")), // an unknown kind
    s.call(request(creator, { kind: "tax-rules", taxBuyBps: 300, taxSellBps: 300, creatorBps: 2000, pileBps: 5000, burnBps: 3000 }), at("203.0.113.3")), // switched off here
  ];
  const valid = s.call(request(creator), at("203.0.113.3"));
  const codes = await Promise.all(refused.map(async (p) => { const r = await p; return (await r.json()).error; }));
  assert.deepEqual(codes, ["BAD_BODY", "BAD_CREATOR", "BAD_KIND", "BAD_KIND"]);
  assert.equal((await valid).status, 200);
  assert.equal((await s.call(request(ethers.Wallet.createRandom().address), at("203.0.113.4"))).status, 429); // the day's one was used once
  await s.close();
});

test("SH-307: a signature keeps its slot when its log line or its answer fails afterwards", async () => {
  const s = await checked({ limits: { perClientPerHour: 1, perCreatorPerHour: 5, perDay: 100 },
    log: (o) => { if (o.code === "SIGNED") throw new Error("the log is gone"); } });
  assert.equal((await s.call(request(ethers.Wallet.createRandom().address), at("203.0.113.5"))).status, 200);
  assert.equal((await s.call(request(ethers.Wallet.createRandom().address), at("203.0.113.5"))).status, 429);
  await s.close();
});

test("SH-307: the plain ceiling counts every POST that reaches the route (five times the address's signatures an hour, at least 100), a wrong type too", async () => {
  const s = await checked({ limits: { perClientPerHour: 1, perCreatorPerHour: 5, perDay: 100 } });
  for (let i = 0; i < 100; i++) assert.equal((await s.call(null, { raw: "{}", headers: { "content-type": "text/plain", "x-forwarded-for": "203.0.113.6" } })).status, 415);
  assert.equal((await s.call(request(ethers.Wallet.createRandom().address), at("203.0.113.6"))).status, 429);
  assert.equal((await s.call(request(ethers.Wallet.createRandom().address), at("203.0.113.7"))).status, 200);
  await s.close();
});

test("SH-307: the count map: a read creates nothing, an hour key is gone after its hour, the day key after its day", () => {
  let t = Date.UTC(2026, 10, 25, 12, 30);
  const l = limiter(() => t, { perClientPerHour: 5, perCreatorPerHour: 5, perDay: 1 });
  assert.ok(l.request("a"));
  assert.ok(l.reserve("a", "w1"));
  assert.equal(l.size(), 4); // r:a, c:a, w:w1, day
  assert.equal(l.reserve("b", "w2"), null); // the day is full: nothing of b or w2 is made
  assert.equal(l.size(), 4);
  assert.ok(!l.has("c:b") && !l.has("w:w2"));
  t += 3_600_000; l.prune();
  assert.deepEqual([l.size(), l.has("day")], [1, true]);
  t += 86_400_000; l.prune();
  assert.equal(l.size(), 0);
});

test("SH-307: the limits' settings: unset is the default, a whole number from 1 to its bound, anything else stops the start", () => {
  assert.deepEqual({ ...limitsOf({}) }, { perClientPerHour: 600, perCreatorPerHour: 5, perDay: 20_000 });
  assert.deepEqual({ ...limitsOf({ SIGN_LIMIT_PER_CLIENT_HOUR: "100000", SIGN_LIMIT_PER_CREATOR_HOUR: "1", SIGN_LIMIT_PER_DAY: "" }) },
    { perClientPerHour: 100000, perCreatorPerHour: 1, perDay: 20_000 });
  for (const [name, bad] of [["SIGN_LIMIT_PER_CLIENT_HOUR", "0"], ["SIGN_LIMIT_PER_CLIENT_HOUR", "-1"], ["SIGN_LIMIT_PER_CLIENT_HOUR", "1.5"],
    ["SIGN_LIMIT_PER_CLIENT_HOUR", "100001"], ["SIGN_LIMIT_PER_CREATOR_HOUR", "1001"], ["SIGN_LIMIT_PER_DAY", " 5"], ["SIGN_LIMIT_PER_DAY", "abc"],
    ["SIGN_LIMIT_PER_DAY", "0500"], ["SIGN_LIMIT_PER_DAY", "100001"]]) {
    assert.throws(() => limitsOf({ [name]: bad }), new RegExp(`${name} must be a whole number from 1 to`), `${name}=${bad}`);
  }
});

test("SH-307: the health's kinds are exactly what a POST accepts, the switch off and on; none while not ready", async () => {
  const off = await up(async () => null, { check });
  assert.deepEqual(await (await off.call(null, { method: "GET", path: "/launches/api/four/health" })).json(), { state: "waiting-for-records", signer: null, coreSignerIsKey: false });
  await off.close();
  const rules = request(ethers.Wallet.createRandom().address, { kind: "tax-rules", quote: WBNB, raiseAmount: "0.3", taxBuyBps: 300, taxSellBps: 300, creatorBps: 2000, pileBps: 5000, burnBps: 3000 });
  delete rules.buyFeeBps; delete rules.sellFeeBps;
  for (const [config, kinds, status] of [[CONFIG, ["preset", "tax"], 400], [RULES_CONFIG, ["preset", "tax", "tax-rules"], 200]]) {
    const s = await checked({}, async () => ({ signed: true }), config);
    const h = await (await s.call(null, { method: "GET", path: "/launches/api/four/health" })).json();
    assert.deepEqual(h.kinds, kinds);
    assert.equal((await s.call(rules)).status, status);
    await s.close();
  }
});

// Lane g's narrow read, finding 1: the route reads at most MAX_BODY_BYTES (2,048) and answers 413 at byte 2,049 BEFORE
// anything is parsed or signed: a 2,049-byte body with its length, a chunked body without one, a body that never ends.
test("the byte bound: 413 at byte 2,049, before any parsing, with a length, chunked, and for a body that never ends", async () => {
  assert.equal(MAX_BODY, MAX_BODY_BYTES);
  let signed = 0;
  const s = await up(async () => ({ address: key.address, sign: async () => { signed += 1; return {}; } }));
  const port = s.server.address().port;
  const send = (chunks, { length, endless = false } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/launches/api/four/sign-create",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.9", ...(length === undefined ? {} : { "content-length": length }) } });
    let written = 0, answered = false, timer;
    req.on("response", (res) => { answered = true; clearInterval(timer); let body = ""; res.on("data", (c) => { body += c; });
      res.on("error", () => {});
      res.on("end", () => { req.destroy(); resolve({ status: res.statusCode, body, written }); }); });
    req.on("error", (e) => { if (!answered) reject(e); });
    if (endless) timer = setInterval(() => { if (!answered) { req.write("a".repeat(512)); written += 512; } }, 1);
    else { for (const c of chunks) { req.write(c); written += c.length; } req.end(); }
  });
  // 2,048 bytes of valid JSON is read and parsed (it reaches the function); 2,049 is not.
  const fill = (n) => JSON.stringify({ kind: "preset", pad: "x".repeat(n - 26) });
  assert.equal(Buffer.byteLength(fill(2048)), 2048);
  const ok = await send([fill(2048)], { length: 2048 });
  assert.equal(ok.status, 200); assert.equal(signed, 1);
  const withLength = await send([fill(2049)], { length: 2049 });
  assert.deepEqual([withLength.status, JSON.parse(withLength.body).error, signed], [413, "TOO_LARGE", 1]);
  const chunked = await send([fill(2049).slice(0, 1000), fill(2049).slice(1000)]);
  assert.deepEqual([chunked.status, JSON.parse(chunked.body).error, signed], [413, "TOO_LARGE", 1]);
  const endless = await send([], { endless: true });
  assert.deepEqual([endless.status, JSON.parse(endless.body).error, signed], [413, "TOO_LARGE", 1]);
  // Nothing past the bound was parsed: no log line names a creator or a code for the three.
  assert.equal(s.lines.filter((l) => l.includes('"code"')).length, 1);
  s.server.closeAllConnections();
  await s.close();
});

// Lane g's narrow read, finding 4: the last slot is taken by one of two overlapping requests, never by both; a failed
// signing gives its slot back.
test("the last creator slot: two overlapping requests, one signs, one is refused; a failed call gives its slot back", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let failNext = false;
  const s = await up(async () => ({ address: key.address, sign: async (b) => {
    if (failNext) { failNext = false; throw new Error("rpc down"); }
    if (b.name === "Slow") await gate;
    return signCreate(CONFIG, key, b, Math.floor(Date.now() / 1000));
  } }));
  const creator = ethers.Wallet.createRandom().address;
  const ip = (i) => ({ headers: { "x-forwarded-for": `192.0.2.${i}` } });
  for (let i = 0; i < LIMITS.perCreatorPerHour - 1; i++) assert.equal((await s.call(request(creator), ip(i))).status, 200);
  // A failing call takes the last slot only while it runs.
  failNext = true;
  assert.equal((await s.call(request(creator), ip(50))).status, 500);
  // Two overlapping requests for the last slot: the first is held inside the signing call while the second arrives.
  const first = s.call(request(creator, { name: "Slow" }), ip(60));
  await new Promise((r) => setTimeout(r, 50));
  const second = await s.call(request(creator), ip(61));
  release();
  assert.deepEqual([(await first).status, second.status], [200, 429]);
  await s.close();
});

test("SH-287: SIGN_TAX_RULES gives lane g's factory taxRules only when it is 1; anything but unset, 0 or 1 stops the start", () => {
  const env = { SIGN_RPC: "https://rpc.example", SIGN_QUOTES: `${WBNB}, ${TETH}`, SIGN_RAISE_MIN: "0.1", SIGN_RAISE_MAX: "2" };
  const today = { rpc: "https://rpc.example", outDir: "/run/sign/out", keystore: "/run/sign/keystore.json", passwordFile: "/run/sign/password",
    quotes: [WBNB, TETH], raiseMin: "0.1", raiseMax: "2" };
  // Unset and 0: exactly today's call, with no taxRules key at all.
  assert.deepStrictEqual(serviceOptions("/run/sign", env), today);
  assert.deepStrictEqual(serviceOptions("/run/sign", { ...env, SIGN_TAX_RULES: "0" }), today);
  assert.deepStrictEqual(serviceOptions("/run/sign", { ...env, SIGN_TAX_RULES: "1" }), { ...today, taxRules: true });
  for (const bad of ["true", "yes", " 1", "2"]) assert.throws(() => taxRulesOf({ SIGN_TAX_RULES: bad }), /SIGN_TAX_RULES must be unset, 0 or 1/);
});

test("SH-287: a tax-rules request is logged with its kind", async () => {
  const s = await up(async () => ({ address: key.address, sign: async () => ({ kind: "tax-rules" }) }));
  const res = await s.call({ kind: "tax-rules", creator: key.address });
  assert.strictEqual(res.status, 200);
  assert.ok(s.lines.some((l) => l === JSON.stringify({ creator: key.address.toLowerCase(), kind: "tax-rules", code: "SIGNED" })), s.lines.join("\n"));
  await s.close();
});

test("the image's health check: healthy when ready or waiting for the records, unhealthy when refused or silent (SH-287)", async () => {
  const { execFile } = require("node:child_process");
  const path = require("node:path");
  const { StartupRefused } = require(`${lib}/service`);
  const check = (base) => new Promise((resolve) => {
    execFile(process.execPath, [path.join(__dirname, "..", "health.js")], { env: { ...process.env, SIGN_HEALTH_URL: `${base}/launches/api/four/health` } },
      (error) => resolve(error ? error.code : 0));
  });
  const states = [["ready", ready], ["waiting", () => up(async () => null)], ["refused", () => up(async () => { throw new StartupRefused("TAX_RULES_RECORDS"); })]];
  const got = {};
  for (const [name, make] of states) {
    const s = await make();
    got[name] = await check(`http://127.0.0.1:${s.server.address().port}`);
    await s.close();
  }
  got.silent = await check("http://127.0.0.1:9");
  assert.deepEqual(got, { ready: 0, waiting: 0, refused: 1, silent: 1 });
});
