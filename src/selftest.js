// One request that exercises every moving part and reports what actually happened, with the values it saw.
// Meant to answer "why is there no logo / no history / no holders" without reading logs.
import { q as query } from "./db.js";
import { client, rawLogs } from "./chain.js";
import { EXPLORER } from "./config.js";
import { ARCSCAN, tokenInfo, holders, searchExplorer } from "./explorer.js";
import { DYOR_API } from "./dyor.js";
import { debugMeta } from "./meta.js";
import { archiveAvailable } from "./birth.js";
import { ARCHIVE_RPC } from "./config.js";

const timed = async (fn) => { const t = Date.now(); try { return { ok: true, ms: Date.now() - t, ...(await fn()) }; } catch (e) { return { ok: false, ms: Date.now() - t, error: e.message }; } };
const ping = async (url, ms = 8000) => {
  const t = Date.now();
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: "application/json", "user-agent": "talons-scan/1.0" } });
  const body = await r.text();
  return { status: r.status, ms: Date.now() - t, sample: body.slice(0, 180) };
};

export async function selftest(state) {
  const out = { at: new Date().toISOString() };

  out.chain = await timed(async () => ({ tip: Number(await client.getBlockNumber()), head: state?.head ?? null, backfill: state?.backfill ?? null, backfillDone: state?.backfillDone ?? null }));
  if (out.chain.ok && out.chain.backfill != null) {
    const remaining = Math.max(0, out.chain.backfill);
    out.chain.days_of_history = state?.head ? Number(((out.chain.tip - out.chain.backfill) * 0.506) / 86400).toFixed(1) : null;
    out.chain.blocks_left_to_genesis = remaining;
  }

  out.db = await timed(async () => {
    const [a] = await query(`SELECT COUNT(*)::int AS tokens, COUNT(*) FILTER (WHERE logo <> '' AND logo IS NOT NULL)::int AS with_logo,
      COUNT(*) FILTER (WHERE meta_checked IS NULL)::int AS never_checked FROM tokens`);
    const [b] = await query("SELECT COUNT(*)::int AS pools, COUNT(*) FILTER (WHERE liquidity_usd > 0)::int AS with_liquidity FROM pools");
    const [c] = await query("SELECT COUNT(*)::int AS swaps FROM swaps");
    const events = await query("SELECT emitter, topic0, hits, cursor_block, done FROM meta_events ORDER BY hits DESC LIMIT 10");
    return { ...a, ...b, ...c, learned_events: events };
  });

  out.rpc_getlogs = await timed(async () => {
    const tip = Number(await client.getBlockNumber());
    const logs = await rawLogs({}, tip - 200, tip);
    return { span: 200, logs: logs.length };
  });

  out.explorers = {
    blockscout: await timed(() => ping(`${EXPLORER}/api/v2/stats`)),
    arcscan: await timed(() => ping(`${ARCSCAN}/v1/chain`)),
  };
  out.dyor = {
    arc_list: await timed(() => ping(`${DYOR_API}/api/arc/v1/tokens?limit=1`)),
    default_list: await timed(() => ping(`${DYOR_API}/api/v1/tokens?limit=1`)),
  };

  // A real token with no logo, taken through every source so the failing step is visible.
  const [sample] = await query(`SELECT t.address, t.symbol, MAX(p.created_block) AS hint FROM tokens t JOIN pools p ON p.token = t.address
    WHERE t.logo IS NULL OR t.logo = '' GROUP BY t.address, t.symbol ORDER BY MAX(p.created_block) DESC LIMIT 1`);
  if (sample) {
    out.sample_token = { address: sample.address, symbol: sample.symbol, pool_block: Number(sample.hint || 0) };
    out.sample_meta = await timed(() => debugMeta(sample.address));
    out.sample_explorer = { token: await tokenInfo(sample.address).catch(() => null), holders: (await holders(sample.address, 3).catch(() => [])).length };
  }
  out.archive = await timed(async () => ({ url: ARCHIVE_RPC, available: await archiveAvailable() }));
  out.search_probe = await timed(async () => ({ hits: (await searchExplorer("arc")).length }));
  return out;
}
