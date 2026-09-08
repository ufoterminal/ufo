// Bulk metadata harvest. Once one token's logo has been traced to a launchpad event, that same event
// carries every other token that launchpad made. This walks the chain for those events and fills logos
// wholesale, which is far cheaper than searching around each token separately.
import { q as query } from "./db.js";
import { rawLogs, lower } from "./chain.js";
import { stringsInData, fromMetadata } from "./meta.js";

const SPAN = 9_000;          // public RPCs cap eth_getLogs at ten thousand blocks
const CHUNKS_PER_RUN = 25;   // about 225k blocks per emitter per run
const isUrlish = (s) => /^(https?:\/\/|ipfs:\/\/|ar:\/\/|data:)/i.test(s) || s.startsWith("{");

// Addresses referenced by a log, from its topics and from any 32 byte word in its data.
function addressesIn(log) {
  const out = new Set();
  for (const t of log.topics || []) if (/^0x0{24}[0-9a-f]{40}$/i.test(t)) out.add("0x" + t.slice(26).toLowerCase());
  const hex = (log.data || "0x").replace(/^0x/, "");
  for (let i = 0; i + 64 <= hex.length; i += 64) {
    const w = hex.slice(i, i + 64);
    if (/^0{24}[0-9a-f]{40}$/i.test(w) && !/^0{64}$/.test(w)) out.add("0x" + w.slice(24).toLowerCase());
  }
  return [...out];
}

export async function harvestMeta(state, tip) {
  const rows = await query("SELECT emitter, topic0, cursor_block, done FROM meta_events WHERE done = 0 ORDER BY hits DESC LIMIT 4");
  for (const r of rows) {
    let to = r.cursor_block == null ? tip : Number(r.cursor_block);
    let filled = 0;
    for (let i = 0; i < CHUNKS_PER_RUN && to > 0; i++) {
      const from = Math.max(0, to - SPAN + 1);
      let logs = [];
      try { logs = await rawLogs({ address: r.emitter, topics: [r.topic0] }, from, to); } catch { break; }
      for (const log of logs) {
        const strs = stringsInData(log.data || "0x").filter(isUrlish);
        if (!strs.length) continue;
        const cands = addressesIn(log);
        if (!cands.length) continue;
        const known = await query(`SELECT address FROM tokens WHERE address = ANY($1) AND (logo IS NULL OR logo = '')`, [cands]);
        if (!known.length) continue;
        let meta = null;
        for (const s of strs) { const m = await fromMetadata(s); if (m.logo || m.description) { meta = m; break; } }
        if (!meta) continue;
        for (const { address } of known) {
          await query(`UPDATE tokens SET logo = COALESCE(NULLIF($1,''), logo), website = COALESCE(NULLIF($2,''), website),
            twitter = COALESCE(NULLIF($3,''), twitter), telegram = COALESCE(NULLIF($4,''), telegram),
            description = COALESCE(NULLIF($5,''), description), launchpad = COALESCE(NULLIF($6,''), launchpad), meta_checked = $7 WHERE address = $8`,
            [meta.logo, meta.website, meta.twitter, meta.telegram, meta.description, r.emitter, Date.now(), address]);
          const t = state?.tokens?.get(address); if (t && meta.logo) t.logo = meta.logo;
          filled++;
        }
      }
      to = from - 1;
    }
    await query("UPDATE meta_events SET cursor_block = $1, done = $2 WHERE emitter = $3 AND topic0 = $4", [to, to <= 0 ? 1 : 0, r.emitter, r.topic0]);
    if (filled) console.log(`[harvest] ${r.emitter} filled ${filled} tokens, now at block ${to}`);
  }
}

// Coverage report, so progress is a number rather than a feeling.
export async function coverage() {
  const [t] = await query(`SELECT COUNT(*)::int AS tokens,
    COUNT(*) FILTER (WHERE logo <> '' AND logo IS NOT NULL)::int AS with_logo,
    COUNT(*) FILTER (WHERE launchpad <> '' AND launchpad IS NOT NULL)::int AS with_launchpad,
    COUNT(*) FILTER (WHERE meta_checked IS NULL)::int AS unchecked FROM tokens`);
  const events = await query("SELECT emitter, topic0, hits, cursor_block, done FROM meta_events ORDER BY hits DESC");
  const [p] = await query("SELECT COUNT(*)::int AS pools, COUNT(DISTINCT factory)::int AS factories FROM pools");
  return { ...t, logo_pct: t.tokens ? Math.round((t.with_logo / t.tokens) * 100) : 0, ...p, learned_events: events };
}
