import { q, metaGet } from "./db.js";
import { tsForBlock } from "./indexer.js";
import { tokenInfo as expToken, holders as expHolders, searchExplorer } from "./explorer.js";

// Age comes from the token's deployment block, but a block estimate can be off or missing, and a token
// is never younger than the pool that trades it, so the pool time is both fallback and upper bound.
function bornTs(a) {
  const poolTs = Number(a.created_ts) || 0;
  const est = Number(a.birth_block) ? tsForBlock(a.birth_block) : 0;
  if (!est || !Number.isFinite(est) || est <= 0) return poolTs;
  return poolTs ? Math.min(est, poolTs) : est;
}
const short = (x) => `${x.slice(0, 6)}..${x.slice(-4)}`;
const pct = (now, then) => (then == null || then === 0 || now === 0 ? null : ((now - then) / then) * 100);
const WIN = (sec, name) => `
  COALESCE((SELECT price FROM swaps s WHERE s.pool = p.address AND price > 0 AND ts <= $1 - ${sec} ORDER BY ts DESC, log_index DESC LIMIT 1),
           (SELECT price FROM swaps s WHERE s.pool = p.address AND price > 0 AND ts > $1 - ${sec} ORDER BY ts ASC, log_index ASC LIMIT 1)) AS ${name}`;

export async function buildRows(poolFilter = null) {
  const now = Math.floor(Date.now() / 1000);
  const where = poolFilter ? `WHERE p.token = $2` : "";
  const params = poolFilter ? [now, poolFilter] : [now];
  const agg = await q(`
    SELECT p.*, t.name, t.symbol, t.decimals, t.total_supply, t.logo, t.website, t.twitter, t.telegram, t.launchpad, t.holders, t.birth_block, t.code_hash,
      (SELECT label FROM sources s WHERE s.address = p.factory) AS dex_label, (SELECT icon FROM sources s WHERE s.address = p.factory) AS dex_icon,
      (SELECT label FROM sources s WHERE s.address = t.launchpad) AS lp_label, (SELECT icon FROM sources s WHERE s.address = t.launchpad) AS lp_icon,
      (SELECT price FROM swaps s WHERE s.pool = p.address AND price > 0 ORDER BY ts DESC, block DESC, log_index DESC LIMIT 1) AS last_price,
      (SELECT ts FROM swaps s WHERE s.pool = p.address ORDER BY ts DESC, block DESC, log_index DESC LIMIT 1) AS last_ts,
      ${WIN(300, "p5m")}, ${WIN(3600, "p1h")}, ${WIN(21600, "p6h")}, ${WIN(86400, "p24h")},
      ${WIN(604800, "p7d")}, ${WIN(2592000, "p30d")},
      (SELECT COALESCE(SUM(usd), 0) FROM swaps s WHERE s.pool = p.address AND ts >= $1 - 86400) AS vol24h,
      (SELECT COUNT(*) FROM swaps s WHERE s.pool = p.address AND ts >= $1 - 86400) AS txns24h,
      (SELECT COUNT(*) FROM swaps s WHERE s.pool = p.address AND ts >= $1 - 86400 AND buy = 1) AS buys24h,
      (SELECT COUNT(DISTINCT trader) FROM swaps s WHERE s.pool = p.address AND ts >= $1 - 86400 AND trader <> '') AS traders24h,
      (SELECT COALESCE(SUM(usd), 0) FROM swaps s WHERE s.pool = p.address AND ts >= $1 - 604800) AS vol7d,
      (SELECT COUNT(*) FROM swaps s WHERE s.pool = p.address AND ts >= $1 - 604800) AS txns7d,
      (SELECT COUNT(DISTINCT trader) FROM swaps s WHERE s.pool = p.address AND ts >= $1 - 604800 AND trader <> '') AS traders7d,
      (SELECT COALESCE(SUM(usd), 0) FROM swaps s WHERE s.pool = p.address AND ts >= $1 - 2592000) AS vol30d,
      (SELECT COUNT(*) FROM swaps s WHERE s.pool = p.address AND ts >= $1 - 2592000) AS txns30d,
      (SELECT COUNT(DISTINCT trader) FROM swaps s WHERE s.pool = p.address AND ts >= $1 - 2592000 AND trader <> '') AS traders30d,
      (SELECT COALESCE(SUM(usd), 0) FROM swaps s WHERE s.pool = p.address) AS volall,
      (SELECT COUNT(*) FROM swaps s WHERE s.pool = p.address) AS txnsall,
      (SELECT COUNT(DISTINCT trader) FROM swaps s WHERE s.pool = p.address AND trader <> '') AS tradersall,
      (SELECT price FROM swaps s WHERE s.pool = p.address AND price > 0 ORDER BY ts ASC, log_index ASC LIMIT 1) AS pall
    FROM pools p JOIN tokens t ON t.address = p.token ${where}`, params);
  // A ticker's original: the earliest deployment among every token sharing that symbol.
  const firsts = await q(`SELECT UPPER(t.symbol) AS sym, MIN(COALESCE(t.birth_block, sub.first_pool)) AS first_block
    FROM tokens t LEFT JOIN (SELECT token, MIN(created_block) AS first_pool FROM pools GROUP BY token) sub ON sub.token = t.address
    WHERE t.symbol <> '' GROUP BY UPPER(t.symbol)`);
  const firstBySym = new Map(firsts.map((r) => [r.sym, Number(r.first_block || 0)]));
  const sp = await q(`SELECT pool, ((ts - ($1 - 86400)) / 7200)::int AS bucket, AVG(price) AS pr FROM swaps WHERE ts >= $1 - 86400 AND price > 0 GROUP BY pool, bucket`, [now]);
  const sparks = new Map();
  for (const r of sp) { const arr = sparks.get(r.pool) || new Array(12).fill(0); if (r.bucket >= 0 && r.bucket < 12) arr[r.bucket] = Number(r.pr); sparks.set(r.pool, arr); }
  const rows = [];
  for (const a of agg) {
    const price = Number(a.last_price) || Number(a.price) || 0;
    const supply = Number(a.total_supply) / 10 ** a.decimals;
    let spark = sparks.get(a.address) || [];
    if (spark.length) { let last = spark.find((v) => v > 0) || price; spark = spark.map((v) => (v > 0 ? (last = v) : last)); }
    rows.push({
      token: a.token, name: a.name, symbol: a.symbol, logo: a.logo || "", website: a.website || "", twitter: a.twitter || "", telegram: a.telegram || "",
      dex: a.factory ? { address: a.factory, label: a.dex_label || short(a.factory), icon: a.dex_icon || "" } : null,
      launchpad: a.launchpad ? { address: a.launchpad, label: a.lp_label || short(a.launchpad), icon: a.lp_icon || "" } : null, pool: a.address, fee: a.fee, version: a.version,
      price, mcap: price * supply,
      ch5m: pct(price, a.p5m == null ? null : Number(a.p5m)), ch1h: pct(price, a.p1h == null ? null : Number(a.p1h)), ch6h: pct(price, a.p6h == null ? null : Number(a.p6h)), ch24h: pct(price, a.p24h == null ? null : Number(a.p24h)),
      vol24h: Number(a.vol24h), txns24h: Number(a.txns24h), buys24h: Number(a.buys24h), sells24h: Number(a.txns24h) - Number(a.buys24h), traders24h: Number(a.traders24h),
      vol7d: Number(a.vol7d), txns7d: Number(a.txns7d), traders7d: Number(a.traders7d),
      vol30d: Number(a.vol30d), txns30d: Number(a.txns30d), traders30d: Number(a.traders30d),
      volall: Number(a.volall), txnsall: Number(a.txnsall), tradersall: Number(a.tradersall),
      ch7d: pct(price, a.p7d == null ? null : Number(a.p7d)), ch30d: pct(price, a.p30d == null ? null : Number(a.p30d)),
      chall: pct(price, a.pall == null ? null : Number(a.pall)),
      liquidity: Number(a.liquidity_usd), createdTs: bornTs(a), poolCreatedTs: Number(a.created_ts), holders: a.holders == null ? null : Number(a.holders), birthBlock: Number(a.birth_block || 0),
      og: (() => { const own = Number(a.birth_block || a.created_block || 0); const first = firstBySym.get(String(a.symbol || "").toUpperCase()); return Boolean(own && first && own <= first); })(), lastTs: Number(a.last_ts || 0), spark, codeHash: a.code_hash || "",
    });
  }
  // One row per token: the deepest pool represents it, but the traded figures are summed across every
  // pool that token has, so a token split over two venues is not shown at half its real activity.
  const best = new Map(), totals = new Map();
  const SUM = ["vol24h", "txns24h", "buys24h", "sells24h", "vol7d", "txns7d", "vol30d", "txns30d", "volall", "txnsall", "liquidity"];
  const MAX = ["traders24h", "traders7d", "traders30d", "tradersall"];
  for (const r of rows) {
    const t = totals.get(r.token) || {};
    for (const k of SUM) t[k] = (t[k] || 0) + r[k];
    for (const k of MAX) t[k] = Math.max(t[k] || 0, r[k]);   // distinct traders cannot be added without double counting
    totals.set(r.token, t);
    const c = best.get(r.token);
    if (!c || r.liquidity > c.liquidity || (r.liquidity === c.liquidity && r.vol24h > c.vol24h)) best.set(r.token, r);
  }
  const out = [...best.values()].map((r) => ({ ...r, ...totals.get(r.token), pools: rows.filter((x) => x.token === r.token).length }));
  return out.sort((a, b) => b.vol24h - a.vol24h || b.liquidity - a.liquidity);
}

let cache = { rows: [], updated: 0, tip: 0 };
export async function getScreener(tip) {
  if (Date.now() - cache.updated > 10_000) { cache = { rows: await buildRows(), updated: Date.now(), tip }; }
  else cache.tip = tip;
  return cache;
}

export async function getTokenDetail(addr) {
  const a = addr.toLowerCase();
  const tok = (await q("SELECT * FROM tokens WHERE address = $1", [a]))[0];
  if (!tok) return null;
  const pools = await q("SELECT * FROM pools WHERE token = $1", [a]);
  const rows = await buildRows(a);
  const trades = await q(`SELECT * FROM swaps WHERE pool IN (SELECT address FROM pools WHERE token = $1) ORDER BY ts DESC, block DESC, log_index DESC LIMIT 300`, [a]);
  const similar = tok.symbol || tok.name
    ? await q(`SELECT address, name, symbol FROM tokens WHERE address <> $1
        AND ((NULLIF($2,'') IS NOT NULL AND LOWER(symbol) = LOWER($2)) OR (NULLIF($3,'') IS NOT NULL AND LOWER(name) = LOWER($3))) LIMIT 10`, [a, tok.symbol || "", tok.name || ""])
    : [];
  return { token: tok, pools: pools.map(num), row: rows[0] || null, trades: trades.map(num), similar };
}
const num = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) && !["address", "token", "tx", "trader", "pool", "name", "symbol", "total_supply"].includes(k) ? Number(v) : v]));

const TF = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
export async function getCandles(addr, tf) {
  const sec = TF[tf] || 300;
  const a = addr.toLowerCase();
  const rows = await q(`
    WITH p AS (SELECT address FROM pools WHERE token = $1),
    s AS (SELECT (ts / $2) * $2 AS t, ts, block, log_index, price, usd FROM swaps WHERE pool IN (SELECT address FROM p) AND price > 0)
    SELECT t,
      (array_agg(price ORDER BY ts ASC, block ASC, log_index ASC))[1] AS o,
      MAX(price) AS h, MIN(price) AS l,
      (array_agg(price ORDER BY ts DESC, block DESC, log_index DESC))[1] AS c,
      SUM(usd) AS v
    FROM s GROUP BY t ORDER BY t DESC LIMIT 400`, [a, sec]);
  rows.reverse();
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = { t: Number(rows[i].t), o: Number(rows[i].o), h: Number(rows[i].h), l: Number(rows[i].l), c: Number(rows[i].c), v: Number(rows[i].v) };
    out.push(r);
    // Flat filler between trades keeps the time axis honest, but a long quiet gap is left as a gap
    // rather than thousands of identical candles that swamp the real ones.
    if (i + 1 < rows.length) { let t = r.t + sec, g = 0; const nt = Number(rows[i + 1].t); while (t < nt && g++ < 120) { out.push({ t, o: r.c, h: r.c, l: r.c, c: r.c, v: 0 }); t += sec; } }
  }
  return { tf, candles: out.slice(-400) };
}

export async function getFeed(limit = 50) {
  const rows = await q(`
    SELECT s.ts, s.tx, s.trader, s.usd, s.buy, s.price, s.amt, t.symbol, t.logo, t.address AS token
    FROM swaps s JOIN pools p ON p.address = s.pool JOIN tokens t ON t.address = p.token
    ORDER BY s.ts DESC, s.block DESC, s.log_index DESC LIMIT $1`, [limit]);
  return rows.map(num);
}

export async function getHolders(addr) {
  const a = addr.toLowerCase();
  const [info, list] = await Promise.all([expToken(a), expHolders(a, 50)]);
  const total = info?.total_supply ? Number(info.total_supply) : 0;
  return { count: info?.holders ?? null, holders: list.map((h) => ({ address: h.address, value: h.value, pct: total ? (h.value / total) * 100 : 0 })) };
}
export { metaGet };

// Search: local tokens first, then the explorer for anything on Arc we have not indexed a pool for.
export async function searchTokens(qs) {
  const term = qs.trim().toLowerCase();
  if (!term) return { local: [], explorer: [] };
  const local = await q(`SELECT t.address, t.name, t.symbol, t.logo, EXISTS (SELECT 1 FROM pools p WHERE p.token = t.address) AS priced
    FROM tokens t WHERE LOWER(t.symbol) LIKE $1 OR LOWER(t.name) LIKE $1 OR t.address LIKE $1
    ORDER BY priced DESC, LENGTH(t.symbol) ASC LIMIT 25`, [`%${term}%`]);
  const known = new Set(local.map((t) => t.address));
  let explorer = [];
  try {
    explorer = (await searchExplorer(term)).filter((i) => !known.has(i.address)).slice(0, 20)
      .map((i) => ({ address: i.address, name: i.name, symbol: i.symbol, logo: i.icon, indexed: false }));
  } catch {}
  // A bare contract address always resolves, even when the explorer search index has not seen it.
  if (!explorer.length && /^0x[0-9a-f]{40}$/.test(term) && !known.has(term)) {
    const t = await expToken(term);
    if (t) explorer = [{ address: term, name: t.name, symbol: t.symbol, logo: t.icon, indexed: false }];
  }
  return { local: local.map((t) => ({ ...t, indexed: Boolean(t.priced) })), explorer };
}

// Explorer facts for a token we do not have (or to enrich one we do).
export async function explorerToken(addr) {
  const a = addr.toLowerCase();
  const j = await expToken(a);
  return j ? { address: a, name: j.name, symbol: j.symbol, decimals: j.decimals, total_supply: j.total_supply, holders: j.holders, logo: j.icon } : null;
}

// One wallet's activity, built from the trades we indexed. Cost basis is average cost: buys add to the
// position at what was paid, sells realise against that average. Tokens received outside a trade are
// invisible here, so the position is what this wallet traded, not necessarily what it holds.
export async function getWallet(address, limit = 200) {
  const a = address.toLowerCase();
  const trades = await q(`SELECT s.ts, s.tx, s.usd, s.buy, s.price, s.amt, s.pool, p.token, t.symbol, t.name, t.logo, t.decimals
    FROM swaps s JOIN pools p ON p.address = s.pool JOIN tokens t ON t.address = p.token
    WHERE s.trader = $1 ORDER BY s.ts DESC, s.block DESC LIMIT $2`, [a, limit]);
  if (!trades.length) return { address: a, positions: [], trades: [], totals: { bought: 0, sold: 0, realised: 0, open: 0 } };

  const all = await q(`SELECT s.ts, s.usd, s.buy, s.amt, p.token FROM swaps s JOIN pools p ON p.address = s.pool
    WHERE s.trader = $1 ORDER BY s.ts ASC`, [a]);
  const pos = new Map();
  for (const r of all) {
    const usd = Number(r.usd), amt = Number(r.amt);
    if (!(usd > 0) || !(amt > 0)) continue;
    let p = pos.get(r.token);
    if (!p) { p = { token: r.token, amount: 0, cost: 0, bought: 0, sold: 0, realised: 0, trades: 0, first: Number(r.ts), last: Number(r.ts) }; pos.set(r.token, p); }
    p.trades++; p.last = Number(r.ts);
    if (r.buy) { p.amount += amt; p.cost += usd; p.bought += usd; }
    else {
      const avg = p.amount > 0 ? p.cost / p.amount : 0;
      const sold = Math.min(amt, p.amount);
      p.realised += usd - sold * avg;
      p.amount = Math.max(0, p.amount - amt);
      p.cost = Math.max(0, p.cost - sold * avg);
      p.sold += usd;
    }
  }
  const prices = new Map((await q(`SELECT DISTINCT ON (token) token, price FROM pools WHERE price > 0 ORDER BY token, liquidity_usd DESC`)).map((r) => [r.token, Number(r.price)]));
  const meta = new Map((await q(`SELECT address, symbol, name, logo FROM tokens WHERE address = ANY($1)`, [[...pos.keys()]])).map((r) => [r.address, r]));

  const positions = [...pos.values()].map((p) => {
    const price = prices.get(p.token) || 0;
    const value = p.amount * price;
    const m = meta.get(p.token) || {};
    return { token: p.token, symbol: m.symbol || "", name: m.name || "", logo: m.logo || "",
      amount: p.amount, value, cost: p.cost, avg: p.amount > 0 ? p.cost / p.amount : 0, price,
      unrealised: p.amount > 0 ? value - p.cost : 0, realised: p.realised, pnl: p.realised + (p.amount > 0 ? value - p.cost : 0),
      bought: p.bought, sold: p.sold, trades: p.trades, first: p.first, last: p.last };
  }).sort((x, y) => (y.value - x.value) || (y.pnl - x.pnl));

  const totals = positions.reduce((acc, p) => ({
    bought: acc.bought + p.bought, sold: acc.sold + p.sold,
    realised: acc.realised + p.realised, open: acc.open + p.value, pnl: acc.pnl + p.pnl,
  }), { bought: 0, sold: 0, realised: 0, open: 0, pnl: 0 });

  return { address: a, positions, totals, trades: trades.map((t) => ({ ...t, ts: Number(t.ts), usd: Number(t.usd), price: Number(t.price), amt: Number(t.amt), buy: Number(t.buy) })) };
}
