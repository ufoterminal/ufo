import { client, subscribeHeads, rawLogs, decodeEventLog, loadTokenMeta, priceFromSqrt, lower, usdcTopic, USDC, USDC_DECIMALS,
  poolCreatedEvent, swapEvent, pairCreatedEvent, swapV2Event, erc20Abi, poolAbi } from "./chain.js";
import { q as query, metaGet, metaSet, insertMany } from "./db.js";
import { resolveMeta, mobulaEnabled, launchpadOf } from "./meta.js";
import { syncDyor } from "./dyor.js";
import { harvestMeta } from "./harvest.js";
import { findCreationBlock } from "./birth.js";
import { tokenInfo as expTokenInfo } from "./explorer.js";
import { noteSource, resolveOrigins, backfillFactories, refreshSources, reapplySources, seedKnownSources } from "./origins.js";
import { TOPIC_POOL_CREATED, TOPIC_SWAP, TOPIC_PAIR_CREATED, TOPIC_SWAP_V2, CHUNK_START, CHUNK_MIN, CHUNK_MAX,
  AVG_BLOCK_SEC, SWAP_RETENTION_SEC, POLL_MS, LIQUIDITY_EVERY_MS, HEARTBEAT_EVERY_MS } from "./config.js";

export const state = {
  pools: new Map(), tokens: new Map(), anchors: [],
  head: null, backfill: null, backfillDone: false, chunk: CHUNK_START, tip: 0,
  mode: "starting", lastError: null, started: Date.now(), swapsSeen: 0, wsUrl: null,
  incomplete: new Set(),   // token addresses whose metadata failed at least once
};

// Logos and socials. Newest tokens first, never-checked first, then re-check empties older than a day.
async function fetchLogos() {
  const rows = await query(`SELECT t.address, t.birth_block, MAX(p.created_block) AS hint FROM tokens t LEFT JOIN pools p ON p.token = t.address
    WHERE t.meta_checked IS NULL OR (t.logo = '' AND t.meta_checked < $1)
    GROUP BY t.address, t.birth_block ORDER BY MIN(t.meta_checked) NULLS FIRST, MAX(p.created_block) DESC NULLS LAST LIMIT 10`, [Date.now() - 86400_000]);
  for (const { address, hint, birth_block } of rows) {
    // Find and remember the deployment block once; it anchors both the metadata search and the token's age.
    let birth = Number(birth_block || 0);
    if (!birth && state.tip) {
      birth = await findCreationBlock(address, state.tip).catch(() => 0);
      if (birth) await query("UPDATE tokens SET birth_block = $1 WHERE address = $2", [birth, address]);
    }
    const m = await resolveMeta(address, Number(hint || 0), birth);
    await query("UPDATE tokens SET logo = $1, website = $2, twitter = $3, telegram = $4, description = $5, meta_checked = $6 WHERE address = $7",
      [m.logo, m.website, m.twitter, m.telegram, m.description, Date.now(), address]);
    const t = state.tokens.get(address); if (t) Object.assign(t, m);
    if (m.logo) console.log(`[meta] logo ${address} <- ${m.logo.slice(0, 60)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

// Retry tokens that came back as ??? / Unknown / supply 0. Runs every 2 minutes, a few at a time.
async function retryIncompleteTokens() {
  for (const t of state.tokens.values()) if (t.symbol === "???" || t.name === "Unknown" || t.total_supply === "0") state.incomplete.add(t.address);
  const list = [...state.incomplete].slice(0, 20);
  for (const addr of list) {
    const r = await loadTokenMeta(addr);
    if (!r.complete) continue;
    state.tokens.set(addr, r.meta); state.incomplete.delete(addr);
    await query("UPDATE tokens SET name = $1, symbol = $2, decimals = $3, total_supply = $4 WHERE address = $5", [r.meta.name, r.meta.symbol, r.meta.decimals, r.meta.total_supply, addr]);
    console.log(`[meta] fixed ${r.meta.symbol} ${addr}`);
  }
}

function estimateTs(b) {
  const a = state.anchors;
  if (!a.length) return Math.floor(Date.now() / 1000);
  let lo = null, hi = null;
  for (const x of a) { if (x.b <= b) lo = x; if (x.b >= b) { hi = x; break; } }
  if (lo && hi && hi.b !== lo.b) return Math.round(lo.ts + ((b - lo.b) * (hi.ts - lo.ts)) / (hi.b - lo.b));
  const ref = lo || hi;
  return Math.round(ref.ts + (b - ref.b) * AVG_BLOCK_SEC);
}
async function addAnchor(b) {
  if (state.anchors.some((a) => a.b === b)) return;
  const blk = await client.getBlock({ blockNumber: BigInt(b) });
  state.anchors.push({ b, ts: Number(blk.timestamp) });
  state.anchors.sort((x, y) => x.b - y.b);
  if (state.anchors.length > 200) state.anchors = state.anchors.filter((_, i) => i % 2 === 0 || i === state.anchors.length - 1);
  await metaSet("anchors", state.anchors);
}

async function getLogsFull(filter, from, to) {
  const out = [];
  let cur = from, span = to - from + 1;
  while (cur <= to) {
    const end = Math.min(to, cur + span - 1);
    try { out.push(...(await rawLogs(filter, cur, end))); cur = end + 1; if (out.length < 300) span = Math.min(CHUNK_MAX, Math.floor(span * 1.5)); }
    catch (e) { if (span <= CHUNK_MIN) throw e; span = Math.max(CHUNK_MIN, Math.floor(span / 2)); }
  }
  return out;
}

const notPools = new Set();
let notPoolsLoaded = false;
// A contract that emits Swap and holds a USDC side becomes a pool here, with no factory involved.
async function adoptUnknownPools(logs, block) {
  const { pools, tokens } = state;
  if (!notPoolsLoaded) { notPoolsLoaded = true; try { for (const r of await query("SELECT address FROM nonpools")) notPools.add(r.address); } catch {} }
  const unknown = [...new Set(logs.map((l) => lower(l.address)))].filter((a) => !pools.has(a) && !notPools.has(a));
  if (!unknown.length) return;
  const found = [], rejected = [], traded = new Set();
  for (let i = 0; i < unknown.length; i += 5) {
    await Promise.all(unknown.slice(i, i + 5).map(async (addr) => {
      const abi = (name, out) => [{ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: out }] }];
      const [t0, t1] = await Promise.all([
        client.readContract({ address: addr, abi: abi("token0", "address"), functionName: "token0" }).catch(() => null),
        client.readContract({ address: addr, abi: abi("token1", "address"), functionName: "token1" }).catch(() => null),
      ]);
      if (!t0 || !t1) { rejected.push(addr); return; }
      const a0 = lower(t0), a1 = lower(t1);
      // Not a USDC pool, so it gets no row, chart or price. Both sides are still recorded as tokens
      // so that anything traded even once on Arc can be found by ticker or address in search.
      if (a0 !== USDC && a1 !== USDC) { rejected.push(addr); traded.add(a0); traded.add(a1); return; }
      const tokenIsToken0 = a1 === USDC;
      const token = tokenIsToken0 ? a0 : a1;
      if (token === USDC) { rejected.push(addr); return; }
      const isV3 = logs.some((l) => lower(l.address) === addr && (l.topics[0] || "").toLowerCase() === TOPIC_SWAP);
      let fee = 3000;
      if (isV3) { try { fee = Number(await client.readContract({ address: addr, abi: abi("fee", "uint24"), functionName: "fee" })); } catch {} }
      let factory = null;
      try { factory = lower(await client.readContract({ address: addr, abi: abi("factory", "address"), functionName: "factory" })); } catch {}
      // The block we happen to be scanning is not when the pool was made. Ask the archive node for the
      // real deployment block, otherwise an old pool would show up as minutes old with no history.
      let born = await findCreationBlock(addr, state.tip || block).catch(() => 0);
      if (!born || born > block) born = block;
      found.push({ address: addr, token, token_is_token0: tokenIsToken0 ? 1 : 0, fee, version: isV3 ? 3 : 2, created_block: born, created_ts: estimateTs(born), price: 0, price_block: 0, liquidity_usd: 0, factory });
    }));
  }
  if (rejected.length) { rejected.forEach((a) => notPools.add(a)); await insertMany("nonpools", ["address", "checked"], rejected.map((a) => [a, Date.now()])); }
  await registerTradedTokens(traded);
  if (!found.length) return;
  const missing = [...new Set(found.map((p) => p.token))].filter((t) => !tokens.has(t));
  const metas = [];
  for (let i = 0; i < missing.length; i += 8) {
    const part = await Promise.all(missing.slice(i, i + 8).map(loadTokenMeta));
    for (const r of part) { metas.push(r.meta); if (!r.complete) state.incomplete.add(r.meta.address); }
  }
  for (const m of metas) tokens.set(m.address, m);
  if (metas.length) await insertMany("tokens", ["address", "name", "symbol", "decimals", "total_supply"], metas.map((m) => [m.address, m.name, m.symbol, m.decimals, m.total_supply]));
  for (const p of found) pools.set(p.address, p);
  await insertMany("pools", ["address", "token", "token_is_token0", "fee", "version", "created_block", "created_ts", "factory"], found.map((p) => [p.address, p.token, p.token_is_token0, p.fee, p.version, p.created_block, p.created_ts, p.factory]));
  for (const p of found) if (p.factory) noteSource(p.factory, "dex").catch(() => {});
  console.log(`[pools] adopted +${found.length} from swap activity (${pools.size} total)`);
  for (const p of found) catchUpPool(p).catch((e) => console.log("[catchup]", p.address, e.message));
}

// Tokens seen trading against something other than USDC. Searchable, but with no market data of their own.
async function registerTradedTokens(addrs) {
  const list = [...addrs].filter((a) => a !== USDC && !state.tokens.has(a)).slice(0, 40);
  if (!list.length) return;
  const metas = [];
  for (let i = 0; i < list.length; i += 8) {
    const part = await Promise.all(list.slice(i, i + 8).map(loadTokenMeta));
    for (const r of part) if (r.meta.symbol) metas.push(r.meta);
  }
  if (!metas.length) return;
  for (const m of metas) state.tokens.set(m.address, m);
  await insertMany("tokens", ["address", "name", "symbol", "decimals", "total_supply"], metas.map((m) => [m.address, m.name, m.symbol, m.decimals, m.total_supply]));
  console.log(`[tokens] +${metas.length} traded without a USDC pool (searchable only)`);
}

// Decode Uniswap style Swap logs for pools we know, write them, and move each pool's last price forward.
async function writeSwaps(logs) {
  const { pools, tokens } = state;
  const rows = [], latest = new Map();
  for (const log of logs) {
    const pa = lower(log.address);
    const pool = pools.get(pa); const tok = pool && tokens.get(pool.token);
    if (!pool || !tok) continue;
    const isV3 = (log.topics[0] || "").toLowerCase() === TOPIC_SWAP;
    let usdcRaw, tokRaw, price, trader;
    try {
      if (isV3) {
        const d = decodeEventLog({ abi: [swapEvent], data: log.data, topics: log.topics });
        usdcRaw = pool.token_is_token0 ? d.args.amount1 : d.args.amount0;
        tokRaw = pool.token_is_token0 ? d.args.amount0 : d.args.amount1;
        price = priceFromSqrt(d.args.sqrtPriceX96, !!pool.token_is_token0, tok.decimals);
        trader = lower(d.args.recipient);
      } else {
        const d = decodeEventLog({ abi: [swapV2Event], data: log.data, topics: log.topics });
        const a0 = d.args.amount0In - d.args.amount0Out, a1 = d.args.amount1In - d.args.amount1Out;
        usdcRaw = pool.token_is_token0 ? a1 : a0;
        tokRaw = pool.token_is_token0 ? a0 : a1;
        const u = Math.abs(Number(usdcRaw)) / 10 ** USDC_DECIMALS, t = Math.abs(Number(tokRaw)) / 10 ** tok.decimals;
        price = t > 0 ? u / t : 0;
        trader = lower(d.args.to);
      }
    } catch { continue; }
    const usd = Math.abs(Number(usdcRaw)) / 10 ** USDC_DECIMALS;
    const amt = Math.abs(Number(tokRaw)) / 10 ** tok.decimals;
    const b = parseInt(log.blockNumber, 16);
    rows.push([pa, b, parseInt(log.logIndex, 16) || 0, estimateTs(b), log.transactionHash || "", trader, usd, usdcRaw > 0n ? 1 : 0, price, amt]);
    const prev = latest.get(pa);
    if (price > 0 && (!prev || prev.block <= b)) latest.set(pa, { price, block: b });
  }
  if (!rows.length) return 0;
  await insertMany("swaps", ["pool", "block", "log_index", "ts", "tx", "trader", "usd", "buy", "price", "amt"], rows);
  for (const [pa, l] of latest) {
    const p = pools.get(pa);
    if (p && p.price_block <= l.block) { p.price = l.price; p.price_block = l.block; await query("UPDATE pools SET price = $1, price_block = $2 WHERE address = $3 AND price_block <= $4", [l.price, l.block, pa, l.block]); }
  }
  state.swapsSeen += rows.length;
  return rows.length;
}

// A pool found today may be months old. Its own logs are replayed from its creation block so that
// volume, transaction counts and the chart are complete rather than starting from the moment we noticed it.
const catchingUp = new Set();
async function catchUpPool(p) {
  if (catchingUp.has(p.address)) return;
  catchingUp.add(p.address);
  const head = state.tip || state.head;
  let from = p.created_block;
  const SPAN = 9_000;
  let wrote = 0;
  while (from <= head) {
    const to = Math.min(head, from + SPAN - 1);
    let logs = [];
    try { logs = await rawLogs({ address: p.address, topics: [[TOPIC_SWAP, TOPIC_SWAP_V2]] }, from, to); }
    catch { await new Promise((r) => setTimeout(r, 500)); from = to + 1; continue; }
    if (logs.length) wrote += await writeSwaps(logs);
    from = to + 1;
    await new Promise((r) => setTimeout(r, 40));
  }
  catchingUp.delete(p.address);
  if (wrote) console.log(`[catchup] ${p.address} +${wrote} historic swaps`);
}

async function indexRange(from, to) {
  const { pools, tokens } = state;
  // The three log queries for a range are independent, so they go out together.
  const [created, created2, swapLogs] = await Promise.all([
    getLogsFull({ topics: [[TOPIC_POOL_CREATED, TOPIC_PAIR_CREATED], [usdcTopic], null] }, from, to),
    getLogsFull({ topics: [[TOPIC_POOL_CREATED, TOPIC_PAIR_CREATED], null, [usdcTopic]] }, from, to),
    getLogsFull({ topics: [[TOPIC_SWAP, TOPIC_SWAP_V2]] }, from, to),
  ]);
  const newPools = [];
  for (const log of [...created, ...created2]) {
    try {
      const isV3 = (log.topics[0] || "").toLowerCase() === TOPIC_POOL_CREATED;
      let t0, t1, addr, fee;
      if (isV3) { const d = decodeEventLog({ abi: [poolCreatedEvent], data: log.data, topics: log.topics }); t0 = lower(d.args.token0); t1 = lower(d.args.token1); addr = lower(d.args.pool); fee = Number(d.args.fee); }
      else { const d = decodeEventLog({ abi: [pairCreatedEvent], data: log.data, topics: log.topics }); t0 = lower(d.args.token0); t1 = lower(d.args.token1); addr = lower(d.args.pair); fee = 3000; }
      const tokenIsToken0 = t1 === USDC;
      const token = tokenIsToken0 ? t0 : t1;
      if (token === USDC || pools.has(addr)) continue;
      const b = parseInt(log.blockNumber, 16);
      const p = { address: addr, token, token_is_token0: tokenIsToken0 ? 1 : 0, fee, version: isV3 ? 3 : 2, created_block: b, created_ts: estimateTs(b), price: 0, price_block: 0, liquidity_usd: 0, factory: lower(log.address) };
      pools.set(addr, p); newPools.push(p);
    } catch { /* unknown shape */ }
  }
  if (newPools.length) {
    const missing = [...new Set(newPools.map((p) => p.token))].filter((t) => !tokens.has(t));
    const metas = [];
    for (let i = 0; i < missing.length; i += 8) {
      const part = await Promise.all(missing.slice(i, i + 8).map(loadTokenMeta));
      for (const r of part) { metas.push(r.meta); if (!r.complete) state.incomplete.add(r.meta.address); }
    }
    for (const m of metas) tokens.set(m.address, m);
    await insertMany("tokens", ["address", "name", "symbol", "decimals", "total_supply"], metas.map((m) => [m.address, m.name, m.symbol, m.decimals, m.total_supply]));
    await insertMany("pools", ["address", "token", "token_is_token0", "fee", "version", "created_block", "created_ts", "factory"], newPools.map((p) => [p.address, p.token, p.token_is_token0, p.fee, p.version, p.created_block, p.created_ts, p.factory]));
    for (const p of newPools) noteSource(p.factory, "dex").catch(() => {});
    console.log(`[pools] +${newPools.length} (${pools.size} total) in ${from}-${to}`);
  }

  // Swaps are read chain-wide by topic, not by our list of known pools. Any contract that emits a
  // Uniswap style Swap is a candidate pool, whichever factory built it (RadarDEX, Warp, Sharc, ...).
  const logs = swapLogs;
  await adoptUnknownPools(logs, from);
  const written = await writeSwaps(logs);
  if (written) console.log(`[swaps] +${written} in ${from}-${to}`);
  return written;
}

// Every token's real deployment block, which is what age, the OG badge and the metadata search all need.
async function fillBirthBlocks() {
  if (!state.tip) return;
  const rows = await query(`SELECT t.address FROM tokens t JOIN pools p ON p.token = t.address
    WHERE t.birth_block IS NULL GROUP BY t.address ORDER BY MAX(p.liquidity_usd) DESC NULLS LAST LIMIT 15`);
  for (const { address } of rows) {
    const b = await findCreationBlock(address, state.tip).catch(() => 0);
    await query("UPDATE tokens SET birth_block = $1 WHERE address = $2", [b || 0, address]);
  }
}

export function tsForBlock(b) { return estimateTs(Number(b) || 0); }

let liqPass = 0;
async function refreshLiquidity() {
  const pass = liqPass++;
  const cutoff = Math.floor(Date.now() / 1000) - 86400;
  let active = new Set();
  try { for (const r of await query("SELECT DISTINCT pool FROM swaps WHERE ts >= $1", [cutoff])) active.add(r.pool); } catch {}
  // Everything that traded today is refreshed every pass; the rest every tenth, so quiet pools stay
  // priced without spending two RPC reads each on thousands of dead pools every minute.
  const list = [...state.pools.values()].filter((p) => active.has(p.address) || pass % 10 === 0);
  for (let i = 0; i < list.length; i += 10) {
    await Promise.all(list.slice(i, i + 10).map(async (p) => {
      const tok = state.tokens.get(p.token); if (!tok) return;
      const [usdcBal, tokBal] = await Promise.all([
        client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [p.address] }).catch(() => null),
        client.readContract({ address: p.token, abi: erc20Abi, functionName: "balanceOf", args: [p.address] }).catch(() => null),
      ]);
      if (usdcBal == null || tokBal == null) return; // keep the previous value rather than writing a zero
      let price = p.price;
      if (!price && p.version === 3) { try { const s0 = await client.readContract({ address: p.address, abi: poolAbi, functionName: "slot0" }); price = priceFromSqrt(s0[0], !!p.token_is_token0, tok.decimals); } catch {} }
      if (!price && p.version === 2 && tokBal > 0n) price = (Number(usdcBal) / 10 ** USDC_DECIMALS) / (Number(tokBal) / 10 ** tok.decimals);
      const liq = Number(usdcBal) / 10 ** USDC_DECIMALS + (Number(tokBal) / 10 ** tok.decimals) * price;
      if (Math.abs(liq - p.liquidity_usd) > 0.01 || price !== p.price) {
        p.liquidity_usd = liq; p.price = price;
        await query("UPDATE pools SET liquidity_usd = $1, price = $2 WHERE address = $3", [liq, price, p.address]);
      }
    }));
    await new Promise((r) => setTimeout(r, 50));
  }
}

// Holder counts for the tokens people actually look at, refreshed a few at a time from the explorer.
async function refreshHolders() {
  const rows = await query(`SELECT t.address FROM tokens t JOIN pools p ON p.token = t.address
    WHERE t.holders_checked IS NULL OR t.holders_checked < $1
    GROUP BY t.address ORDER BY MAX(p.liquidity_usd) DESC NULLS LAST LIMIT 12`, [Date.now() - 1800_000]);
  for (const { address } of rows) {
    let n = null;
    try { const info = await expTokenInfo(address); if (info && info.holders != null) n = Number(info.holders); } catch {}
    await query("UPDATE tokens SET holders = $1, holders_checked = $2 WHERE address = $3", [n, Date.now(), address]);
    const t = state.tokens.get(address); if (t && n != null) t.holders = n;
    await new Promise((r) => setTimeout(r, 120));
  }
}

async function heartbeat() {
  await metaSet("indexer", { at: Date.now(), head: state.head, backfill: state.backfill, backfillDone: state.backfillDone, tip: state.tip, mode: state.mode, ws: state.wsUrl, uptimeSec: Math.floor((Date.now() - state.started) / 1000), swapsSeen: state.swapsSeen, lastError: state.lastError });
}

let busy = false;
async function catchUp(tip) {
  if (busy) return; busy = true;
  try {
    state.tip = tip;
    if (state.head < tip) {
      const from = state.head + 1;
      await indexRange(from, tip);
      state.head = tip;
      await metaSet("head", tip);
      if (tip % 2000 < 4) await addAnchor(tip);
    }
  } catch (e) {
    state.lastError = e.shortMessage || e.message; console.log("[head] error", state.lastError);
  } finally { busy = false; }
}

const BACKFILL_LANES = 3; // ranges fetched at once; history is written faster without touching the live head
async function backfillLoop() {
  while (!state.backfillDone && state.backfill > 0) {
    if (busy) { await new Promise((r) => setTimeout(r, 300)); continue; }
    busy = true;
    try {
      // Several ranges in flight. The pointer only moves once every lane in the batch has been written,
      // so a crash resumes from the last fully indexed block rather than a hole.
      const lanes = [];
      let cursor = state.backfill;
      for (let i = 0; i < BACKFILL_LANES && cursor > 0; i++) {
        const from = Math.max(0, cursor - state.chunk + 1);
        lanes.push({ from, to: cursor });
        cursor = from - 1;
      }
      const first = lanes[lanes.length - 1].from;
      if (Math.floor(first / 50000) !== Math.floor(state.backfill / 50000)) await addAnchor(first);
      await Promise.all(lanes.map((l) => indexRange(l.from, l.to)));
      state.backfill = first - 1;
      state.chunk = Math.min(CHUNK_MAX, Math.floor(state.chunk * 1.3));
      if (state.backfill <= 0) state.backfillDone = true;
      await metaSet("backfill", state.backfill); await metaSet("backfillDone", state.backfillDone); await metaSet("chunk", state.chunk);
    } catch (e) {
      state.chunk = Math.max(CHUNK_MIN, Math.floor(state.chunk / 2));
      state.lastError = e.shortMessage || e.message; console.log("[backfill] error", state.lastError);
      await new Promise((r) => setTimeout(r, 2000));
    } finally { busy = false; }
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log("[backfill] done");
}

export async function start() {
  const tip = Number(await client.getBlockNumber());
  state.tip = tip;
  state.anchors = (await metaGet("anchors")) || [];
  await addAnchor(tip);
  for (const p of await query("SELECT * FROM pools")) state.pools.set(p.address, { ...p, factory: p.factory || null, created_block: Number(p.created_block), created_ts: Number(p.created_ts), price: Number(p.price), price_block: Number(p.price_block), liquidity_usd: Number(p.liquidity_usd) });
  for (const t of await query("SELECT * FROM tokens")) state.tokens.set(t.address, t);
  state.head = await metaGet("head");
  state.backfill = await metaGet("backfill");
  state.backfillDone = (await metaGet("backfillDone")) || false;
  state.chunk = (await metaGet("chunk")) || CHUNK_START;
  if (state.head == null) { state.head = Math.max(0, tip - Math.round(86400 / AVG_BLOCK_SEC)); state.backfill = state.head - 1; }
  if (state.backfill == null) state.backfill = state.head - 1;
  console.log(`[start] tip=${tip} head=${state.head} backfill=${state.backfill} pools=${state.pools.size}`);

  // Live: WebSocket if any endpoint has one, otherwise 2 second polling.
  const sub = await subscribeHeads((b) => catchUp(b));
  if (sub) { state.mode = "websocket"; state.wsUrl = sub.url; }
  else { state.mode = "polling"; console.log("[live] no WebSocket available, polling HTTP"); }
  setInterval(async () => { try { const b = Number(await client.getBlockNumber()); if (b > state.head) catchUp(b); } catch (e) { state.lastError = e.shortMessage || e.message; } }, state.mode === "websocket" ? 15_000 : POLL_MS);

  backfillLoop();
  setInterval(() => refreshLiquidity().catch((e) => console.log("[liq]", e.message)), LIQUIDITY_EVERY_MS);
  setTimeout(() => refreshLiquidity().catch(() => {}), 5000);
  setInterval(() => heartbeat().catch(() => {}), HEARTBEAT_EVERY_MS);
  setInterval(() => retryIncompleteTokens().catch((e) => console.log("[meta]", e.message)), 120_000);
  setInterval(() => fetchLogos().catch((e) => console.log("[logo]", e.message)), 30_000);
  setInterval(() => resolveOrigins(state).catch((e) => console.log("[origin]", e.message)), 45_000);
  setTimeout(() => resolveOrigins(state).catch(() => {}), 15_000);
  setTimeout(() => backfillFactories(state).catch((e) => console.log("[factory]", e.message)), 20_000);
  seedKnownSources().then(() => reapplySources()).catch(() => {});
  setTimeout(() => syncDyor(state).catch((e) => console.log("[dyor]", e.message)), 25_000);
  setInterval(() => syncDyor(state).catch(() => {}), 1800_000);
  setInterval(() => refreshHolders().catch((e) => console.log("[holders]", e.message)), 60_000);
  setInterval(() => fillBirthBlocks().catch((e) => console.log("[birth]", e.message)), 45_000);
  setInterval(() => harvestMeta(state, state.tip).catch((e) => console.log("[harvest]", e.message)), 90_000);
  setInterval(() => refreshSources().catch(() => {}), 3600_000);
  setTimeout(() => fetchLogos().catch(() => {}), 10_000);
  console.log(`[meta] mobula ${mobulaEnabled ? "enabled" : "disabled (set MOBULA_API_KEY to enable)"}`);
  setTimeout(() => retryIncompleteTokens().catch(() => {}), 30_000);
  setInterval(() => query("DELETE FROM swaps WHERE ts < $1", [Math.floor(Date.now() / 1000) - SWAP_RETENTION_SEC]).catch(() => {}), 3600_000);
  await heartbeat();
}
