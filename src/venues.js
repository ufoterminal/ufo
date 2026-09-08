// Venue detection without event signatures.
//
// A trade is a trade whatever contract hosts it: USDC moves one way, a token moves the other, inside
// one transaction. Pairing those two ERC-20 Transfer logs identifies the venue, the token, the price
// and the direction, which is how launchpad bonding curves and unknown DEXes get indexed at all.
// Uniswap style pools are already handled by their own Swap events and are skipped here.
import { q as query, insertMany } from "./db.js";
import { client, lower, USDC, USDC_DECIMALS, loadTokenMeta } from "./chain.js";
import { TOPIC_TRANSFER } from "./config.js";

const addrFromTopic = (t) => (t && t.length === 66 ? "0x" + t.slice(26).toLowerCase() : "");
const big = (hex) => { try { return BigInt(hex || "0x0"); } catch { return 0n; } };

// Group Transfer logs by transaction, then keep transactions that moved USDC and exactly one token.
export function pairTrades(transferLogs) {
  const byTx = new Map();
  for (const log of transferLogs) {
    if ((log.topics?.[0] || "").toLowerCase() !== TOPIC_TRANSFER || log.topics.length < 3) continue;
    const tx = log.transactionHash;
    if (!byTx.has(tx)) byTx.set(tx, []);
    byTx.get(tx).push(log);
  }
  const trades = [];
  for (const [tx, logs] of byTx) {
    const usdc = logs.filter((l) => lower(l.address) === USDC);
    const others = logs.filter((l) => lower(l.address) !== USDC);
    if (usdc.length !== 1 || others.length !== 1) continue; // ambiguous or not a simple swap
    const u = usdc[0], t = others[0];
    const uFrom = addrFromTopic(u.topics[1]), uTo = addrFromTopic(u.topics[2]);
    const tFrom = addrFromTopic(t.topics[1]), tTo = addrFromTopic(t.topics[2]);
    if (!uFrom || !uTo || !tFrom || !tTo) continue;
    // Buying and selling are mirror images, so both readings are emitted as candidates and the one
    // whose venue is a contract wins. That is what separates a curve trade from two people swapping.
    const usdRaw = big(u.data), tokRaw = big(t.data);
    if (usdRaw === 0n || tokRaw === 0n) continue;
    const common = { tx, token: lower(t.address), usdRaw, tokRaw, block: parseInt(t.blockNumber, 16), logIndex: parseInt(t.logIndex, 16) || 0 };
    if (uTo === tFrom && uTo !== USDC) trades.push({ ...common, venue: uTo, trader: tTo, buy: 1 });   // USDC in, token out
    if (uFrom === tTo && uFrom !== USDC) trades.push({ ...common, venue: uFrom, trader: tFrom, buy: 0 }); // token in, USDC out
  }
  return trades;
}

// Register a venue and token as a synthetic pool so every existing screen, chart and stat works unchanged.
// Contracts are venues, wallets are people. Cached, because the same venue appears in every trade.
const isContract = new Map();
async function contractCheck(addr) {
  if (isContract.has(addr)) return isContract.get(addr);
  let yes = false;
  try { const code = await client.getBytecode({ address: addr }); yes = Boolean(code && code !== "0x"); } catch { yes = false; }
  isContract.set(addr, yes);
  return yes;
}

// One trade per transaction: the candidate whose venue is a contract, or nothing when both sides are wallets.
export async function selectTrades(candidates, isVenue) {
  const byTx = new Map();
  for (const c of candidates) {
    if (!(await isVenue(c.venue))) continue;
    const cur = byTx.get(c.tx);
    if (!cur) byTx.set(c.tx, c);
  }
  return [...byTx.values()];
}

export async function recordVenueTrades(state, transferLogs, estimateTs) {
  const candidates = pairTrades(transferLogs);
  if (!candidates.length) return 0;
  const trades = await selectTrades(candidates, async (v) => state.pools.has(v) || (await contractCheck(v)));
  if (!trades.length) return 0;
  const { pools, tokens } = state;
  const rows = [], newPools = [], latest = new Map();
  const wantMeta = new Set();

  for (const tr of trades) {
    const key = `${tr.venue}:${tr.token}`;
    if (pools.has(tr.venue)) continue;                  // an AMM pool we already index by its Swap event
    if (tr.token === USDC || !tokens.has(tr.token)) wantMeta.add(tr.token);
  }
  for (const addr of wantMeta) {
    if (addr === USDC) continue;
    try { const r = await loadTokenMeta(addr); if (r?.meta?.symbol) { tokens.set(addr, r.meta); await insertMany("tokens", ["address", "name", "symbol", "decimals", "total_supply"], [[r.meta.address, r.meta.name, r.meta.symbol, r.meta.decimals, r.meta.total_supply]]); } } catch {}
  }

  for (const tr of trades) {
    if (pools.has(tr.venue)) continue;
    const tok = tokens.get(tr.token);
    if (!tok) continue;
    let p = pools.get(tr.venue);
    if (!p) {
      p = { address: tr.venue, token: tr.token, token_is_token0: 0, fee: 0, version: 1, created_block: tr.block, created_ts: estimateTs(tr.block), price: 0, price_block: 0, liquidity_usd: 0, factory: null };
      pools.set(tr.venue, p); newPools.push(p);
    }
    if (p.token !== tr.token) continue;                 // one venue contract per token pairing
    const usd = Number(tr.usdRaw) / 10 ** USDC_DECIMALS;
    const amt = Number(tr.tokRaw) / 10 ** tok.decimals;
    if (!(usd > 0) || !(amt > 0)) continue;
    const price = usd / amt;
    rows.push([tr.venue, tr.block, tr.logIndex, estimateTs(tr.block), tr.tx, tr.trader, usd, tr.buy, price, amt]);
    const prev = latest.get(tr.venue);
    if (!prev || prev.block <= tr.block) latest.set(tr.venue, { price, block: tr.block });
  }

  if (newPools.length) {
    await insertMany("pools", ["address", "token", "token_is_token0", "fee", "version", "created_block", "created_ts", "factory"],
      newPools.map((p) => [p.address, p.token, p.token_is_token0, p.fee, p.version, p.created_block, p.created_ts, p.factory]));
    console.log(`[venues] +${newPools.length} non AMM venues found from paired transfers`);
  }
  if (!rows.length) return 0;
  await insertMany("swaps", ["pool", "block", "log_index", "ts", "tx", "trader", "usd", "buy", "price", "amt"], rows);
  for (const [venue, l] of latest) {
    const p = pools.get(venue);
    if (p && p.price_block <= l.block) { p.price = l.price; p.price_block = l.block; await query("UPDATE pools SET price = $1, price_block = $2 WHERE address = $3 AND price_block <= $4", [l.price, l.block, venue, l.block]); }
  }
  return rows.length;
}
