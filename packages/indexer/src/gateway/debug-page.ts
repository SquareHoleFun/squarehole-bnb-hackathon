/**
 * A tiny read-only debug page for the PoC (served at `/`). Not the app and not the box: it only shows that the
 * snapshot + SSE contract carries what the curve view needs (band, curve marker, window countdown, trades with their
 * finality tier, burns, freshness). No buttons, no inputs, no wallet, no trading. Coordinates are computed as plain
 * numbers for drawing only; every amount shown is the server's decimal string. No lavender: on the box it belongs to the
 * hole and the FIT mark only (BOX-SYSTEM § 1.3), so the ETH band and the curve marker use a neutral ETH tone.
 */
export const DEBUG_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Live curve debug</title>
<style>
  :root { --bg:#0f1020; --fg:#e8e6f5; --muted:#9a97b8; --eth:#b8c4d6; --line:#34335a; --warn:#f5c26b; }
  * { box-sizing: border-box; }
  body { margin:0; padding:16px; background:var(--bg); color:var(--fg); font:14px/1.45 system-ui, sans-serif; }
  main { max-width: 880px; margin: 0 auto; }
  h1 { font-size:18px; margin:0 0 4px; }
  .tag { display:inline-block; padding:2px 8px; border:1px solid var(--line); border-radius:999px; color:var(--muted); font-size:12px; margin-right:6px; }
  .tag.live { border-color: var(--eth); color: var(--eth); }
  .tag.stale { border-style: dashed; color: var(--warn); border-color: var(--warn); }
  section { border:1px solid var(--line); border-radius:8px; padding:12px; margin-top:12px; }
  h2 { font-size:14px; margin:0 0 8px; color: var(--muted); font-weight:600; }
  .band { height:18px; border:1px solid var(--line); border-radius:4px; overflow:hidden; background: repeating-linear-gradient(90deg, transparent 0 11px, var(--line) 11px 12px); }
  .band > div { height:100%; background: var(--eth); width:0; transition: width 300ms ease-out; }
  svg { width:100%; height:auto; display:block; }
  .marker { transition: cx 300ms ease-out, cy 300ms ease-out; }
  .pulse { animation: pulse 300ms ease-out 1; }
  @keyframes pulse { from { r: 9; opacity: .5; } to { r: 5; opacity: 1; } }
  table { width:100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  td, th { text-align:left; padding:4px 6px; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { color: var(--muted); font-weight: 500; }
  .scroll { overflow-x:auto; }
  .muted { color: var(--muted); }
  @media (prefers-reduced-motion: reduce) { .band > div, .marker { transition:none; } .pulse { animation:none; } }
</style>
</head>
<body>
<main>
  <h1>Live curve · debug view</h1>
  <p><span class="tag">Sepolia rehearsal</span><span class="tag">Read-only</span><span class="tag">Not the app</span><span id="fresh" class="tag stale">Connecting…</span></p>
  <section aria-labelledby="band-h">
    <h2 id="band-h">ETH band (net of sells, fees excluded)</h2>
    <div class="band" role="progressbar" aria-valuemin="0" aria-valuemax="10000" id="band"><div id="fill"></div></div>
    <p id="bandText" class="muted">–</p>
  </section>
  <section aria-labelledby="curve-h">
    <h2 id="curve-h">The curve (shape from the contract's constants; the dot is the pool now)</h2>
    <svg viewBox="0 0 600 220" id="curve" aria-hidden="true"></svg>
    <p id="curveText" class="muted">–</p>
  </section>
  <section aria-labelledby="win-h">
    <h2 id="win-h">Launch window</h2>
    <p id="window">–</p>
  </section>
  <section aria-labelledby="trades-h">
    <h2 id="trades-h">Trades</h2>
    <div class="scroll"><table><thead><tr><th>Block</th><th>Side</th><th>ETH</th><th>Tokens</th><th>Trader</th><th>Status</th></tr></thead><tbody id="trades"></tbody></table></div>
  </section>
  <section aria-labelledby="burn-h">
    <h2 id="burn-h">Burns and fee flows</h2>
    <div class="scroll"><table><thead><tr><th>Block</th><th>What</th><th>Tokens</th><th>ETH (wei)</th></tr></thead><tbody id="activity"></tbody></table></div>
  </section>
  <p class="muted" id="foot">–</p>
</main>
<script>
(() => {
  const base = '__BASE__';
  let snap = null, points = [], raise = 1n;
  const $ = (id) => document.getElementById(id);
  const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '–';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  function tier(block) {
    const b = BigInt(block), head = BigInt(snap.head.number), f = snap.finality;
    if (f.finalizedBlock && b <= BigInt(f.finalizedBlock)) return 'final';
    if (f.safeBlock && b <= BigInt(f.safeBlock)) return 'safe';
    if (head - b + 1n >= BigInt(snap.confirmations)) return 'confirmed';
    return 'in block ' + block + ' · not final';
  }
  function x(wei) { return 20 + 560 * Number((BigInt(wei) * 10000n) / raise) / 10000; }
  function y(price, lo, hi) { return 200 - 180 * (Math.log(Number(price)) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)); }
  function drawCurve(pulse) {
    if (!points.length || !snap) return;
    const lo = Number(points[0].priceEthPerToken), hi = Number(points[points.length - 1].priceEthPerToken);
    const path = points.map((p, i) => (i ? 'L' : 'M') + x(p.retainedWei).toFixed(1) + ' ' + y(p.priceEthPerToken, lo, hi).toFixed(1)).join(' ');
    // Proposal V2 in the design doc: a hollow ring at the head ("not final"), a solid dot at the confirmed state.
    const c = snap.confirmed ?? snap.state;
    const hx = x(snap.state.retainedWei), hy = y(snap.state.priceEthPerToken, lo, hi);
    const cx = x(c.retainedWei), cy = y(c.priceEthPerToken, lo, hi);
    const tx = x(snap.curve.targetWei);
    $('curve').innerHTML = '<path d="' + path + '" fill="none" stroke="#6b6aa0" stroke-width="2"/>' +
      '<line x1="' + tx + '" x2="' + tx + '" y1="10" y2="205" stroke="#9a97b8" stroke-dasharray="4 4"/>' +
      '<circle class="marker" cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="5" fill="#b8c4d6"/>' +
      '<circle class="marker' + (pulse ? ' pulse' : '') + '" cx="' + hx.toFixed(1) + '" cy="' + hy.toFixed(1) + '" r="7" fill="none" stroke="#b8c4d6" stroke-width="1.5" stroke-dasharray="' + (snap.confirmed ? '3 2' : '0') + '"/>';
  }
  function render(pulse) {
    if (!snap) return;
    const s = snap.state;
    $('fill').style.width = (s.fillBps / 100) + '%';
    $('band').setAttribute('aria-valuenow', String(s.fillBps));
    $('bandText').textContent = s.retainedEth + ' of ' + (Number(BigInt(snap.curve.targetWei) / 10n ** 9n) / 1e9) + ' ETH (' + (s.fillBps / 100).toFixed(2) + '%) · net of sells · block ' + s.block + (s.launchPhase === 'migrated' ? ' · Graduated at block ' + s.migratedBlock : s.launchPhase === 'completed' ? ' · Complete at block ' + s.completedBlock + ' · graduation possible from block ' + s.graduatesFromBlock + ' unless a sell reopens it' : s.phase === 'TARGET_REACHED' ? ' · Target reached this block' : '');
    $('curveText').textContent = 'Price ' + s.priceEthPerToken + ' ETH per ' + snap.tokenSymbol + ' · ' + s.sold + ' ' + snap.tokenSymbol + ' sold · curve ' + (s.curveBps / 100).toFixed(2) + '% to the completion price · burned ' + s.burned;
    drawCurve(pulse);
    const w = snap.window;
    const eta = (u) => u ? new Date(Number(u) * 1000).toISOString().slice(11, 19) + ' UTC (estimate)' : '';
    $('window').textContent = w.status === 'before_open' ? 'Opens at block ' + w.openBlock + ' · in ' + w.blocksToOpen + ' blocks · about ' + eta(w.etaOpenUnix)
      : w.status === 'router_window' ? 'Launch window: buys only through the launch router · tax next block ' + w.nextBlockTaxPercent + '% · ' + w.blocksToClose + ' blocks left · ends about ' + eta(w.etaCloseUnix)
      : 'Window closed at block ' + w.closeBlock + ' · every route, 1% pool fee';
    $('trades').innerHTML = snap.trades.map((t) => '<tr><td>' + esc(t.block) + '</td><td>' + esc(t.side) + (t.route !== 'other' ? ' · ' + esc(t.route) : '') + '</td><td>' + esc(t.eth) + '</td><td>' + esc(t.tokens) + '</td><td>' + esc(short(t.trader)) + '</td><td>' + esc(tier(t.block)) + '</td></tr>').join('') || '<tr><td colspan="6" class="muted">No trades yet</td></tr>';
    $('activity').innerHTML = snap.activity.map((a) => '<tr><td>' + esc(a.block) + '</td><td>' + esc(a.kind + ' · ' + a.detail) + '</td><td>' + esc(a.amount) + '</td><td>' + esc(a.ethRaw) + '</td></tr>').join('') || '<tr><td colspan="4" class="muted">None</td></tr>';
    $('foot').textContent = 'Head ' + snap.head.number + ' via ' + snap.head.source + ' · safe ' + (snap.finality.safeBlock || '–') + ' · finalized ' + (snap.finality.finalizedBlock || '–');
  }
  function fresh() {
    if (!snap) return;
    const age = Date.now() / 1000 - Number(snap.head.timestamp);
    const el = $('fresh');
    if (status.indexer === 'unverified') { el.className = 'tag stale'; el.textContent = 'Unverified · the service disagrees with the chain · block ' + snap.head.number; }
    else if (status.indexer === 'stale' || age > 60) { el.className = 'tag stale'; el.textContent = 'Stale since block ' + snap.head.number + (status.reason ? ' · ' + status.reason : ''); }
    else { el.className = 'tag live'; el.textContent = 'Live · block ' + snap.head.number + ' · ' + age.toFixed(0) + ' s old · not final'; }
  }
  function applyBlock(e) {
    const changed = !snap || snap.state.sqrtPriceX96 !== e.state.sqrtPriceX96;
    snap = { ...snap, head: e.head, finality: e.finality, state: e.state, confirmed: e.confirmed, window: e.window, // null = same as state
      trades: [...e.trades.slice().reverse(), ...snap.trades].slice(0, 25), activity: [...e.activity.slice().reverse(), ...snap.activity].slice(0, 20) };
    render(changed && e.trades.length > 0);
  }
  function applyReorg(e) {
    // The head moves back to the ancestor (with its window and confirmed state); the new branch follows as blocks.
    const dropped = new Set(e.droppedTradeIds), droppedA = new Set(e.droppedActivityIds);
    snap = { ...snap, head: e.head, finality: e.finality, state: e.state, confirmed: e.confirmed, window: e.window,
      trades: snap.trades.filter((t) => !dropped.has(t.id)), activity: snap.activity.filter((a) => !droppedA.has(a.id)) };
    render(false); // snap back, no reverse animation (BOX-SYSTEM § 3.1 rule 4)
  }
  function applyTraders(e) {
    const found = new Map(e.traders.map((t) => [t.id, t.trader]));
    snap = { ...snap, trades: snap.trades.map((t) => (found.has(t.id) ? { ...t, trader: found.get(t.id) } : t)) };
    render(false);
  }
  let status = { indexer: 'stale', reason: 'connecting' };
  fetch(base + '/curve').then((r) => r.json()).then((c) => { points = c.points; raise = BigInt(c.curve.raiseWei); drawCurve(false); });
  const es = new EventSource(base + '/stream');
  // A snapshot replaces everything: on connect, and right after every resync (the gateway sends it on the stream).
  es.addEventListener('snapshot', (m) => { snap = JSON.parse(m.data); render(false); fresh(); });
  es.addEventListener('block', (m) => { if (snap) { applyBlock(JSON.parse(m.data)); fresh(); } });
  es.addEventListener('reorg', (m) => { if (snap) applyReorg(JSON.parse(m.data)); });
  es.addEventListener('traders', (m) => { if (snap) applyTraders(JSON.parse(m.data)); });
  es.addEventListener('finality', (m) => { if (snap) { snap = { ...snap, finality: JSON.parse(m.data) }; render(false); } });
  es.addEventListener('resync', () => { $('fresh').className = 'tag stale'; $('fresh').textContent = 'Resyncing…'; });
  es.addEventListener('status', (m) => { status = JSON.parse(m.data); fresh(); });
  es.onerror = () => { $('fresh').className = 'tag stale'; $('fresh').textContent = snap ? 'Reconnecting · stale since block ' + snap.head.number : 'Connecting…'; };
  setInterval(fresh, 1000);
})();
</script>
</body>
</html>
`;
