import { requireValue, uint } from './config.mjs';

// Each stage packs calls across tickets. A batch is the failure boundary: no owner of a failed batch
// can publish partial rows, while other batches and completed tickets retain their observations.
export async function readStages(c, out, read, size, readReason) {
  const consumers = out.consumers;
  const live = t => !t.error && uint(t.status.terminalAt) === 0n;
  const backed = t => t.version === 1 && t.source === c.drandBackedSource.toLowerCase();
  const spec = (t, to, name, save, args = [], at) => ({ t, call: [to, name, args, at], save });
  const stage = async specs => {
    for (let offset = 0; offset < specs.length; offset += size) {
      const batch = specs.slice(offset, offset + size).filter(s => !s.t.error);
      if (!batch.length) continue;
      try {
        const values = await read(batch.map(s => s.call));
        batch.forEach((s, i) => s.save(values[i]));
      } catch (e) { for (const { t } of batch) t.error = readReason(e); }
    }
  };
  for (const t of consumers) Object.assign(t, { keys: [], skipped: '0', gateOpenedAt: '0', failureWindowEnds: '0' });
  // A: finalized identity and status of every discovered tickets.
  await stage(consumers.flatMap(t => ['status', 'source', 'vault'].map(name => spec(t, t.address, name, value => {
    if (name === 'status') requireValue(uint(value.drawsSettled) <= uint(value.drawsRequested));
    t[name] = value;
  }))));
  // B: the backed source must name the configured drand source, even without pending work.
  await stage(consumers.filter(t => !t.error && backed(t)).map(t => spec(t, t.source, 'DRAND', value => { t.drand = value; })));
  // C: only the unrequested live graduation uses a gate clock.
  await stage(consumers.filter(t => live(t) && uint(t.status.slots) !== 0n && t.status.wordAcceptedAt === '0'
    && t.status.wordRequestedAt === '0').flatMap(t => ['gateOpenedAt', ...(t.version === 2 ? ['failureWindowEnds'] : [])]
    .map(name => spec(t, t.vault, name, value => { t[name] = value; }))));
  for (const t of consumers.filter(live)) {
    const s = t.status, zero = uint(s.slots) !== 0n && s.wordAcceptedAt === '0' && s.wordRequestedAt !== '0';
    const total = uint(s.drawsRequested) - uint(s.drawsSettled) + (zero ? 1n : 0n), max = uint(c.drandMaxKeys);
    if (zero) t.keys.push({ key: '0' });
    for (let key = uint(s.drawsSettled) + 1n; key <= uint(s.drawsRequested) && BigInt(t.keys.length) < max; key++) {
      t.keys.push({ key: String(key) });
    }
    t.skipped = String(total - BigInt(t.keys.length));
  }
  // D: each live tickets' bounded pending keys, graduation then oldest draws.
  await stage(consumers.filter(live).flatMap(t => t.keys.flatMap(k => [
    spec(t, t.source, 'requestOf', req => {
      requireValue(uint(req.requestedAt) > 0n && uint(req.requestedAt) <= uint(out.timestamp) && uint(req.round) > 0n);
      requireValue(k.key !== '0' || req.requestedAt === t.status.wordRequestedAt);
      Object.assign(k, req);
    }, [t.address, k.key]),
    spec(t, t.source, 'wordOf', word => { Object.assign(k, word); }, [t.address, k.key]),
  ])));
  // E: latest only for keys with no finalized word.
  await stage(consumers.filter(live).flatMap(t => t.keys.filter(k => k.word === '0').map(k =>
    spec(t, t.source, 'wordOf', word => { k.latestWord = word.word; k.latestReadyAt = word.readyAt; }, [t.address, k.key], 'latest'))));
  // F: an unsettled fixed word still needs its backup-fixed row; read each box 0 round once.
  await stage(consumers.filter(t => live(t) && backed(t)).flatMap(t => {
    t.backups = {};
    return [...new Set(t.keys.map(k => k.round))].map(round =>
      spec(t, t.source, 'backupOf', backup => { t.backups[round] = backup; }, [round]));
  }));
}
