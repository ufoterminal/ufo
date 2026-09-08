// Timeframes and multi pool tokens. Every figure here is worked out by hand first, then compared.
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres@127.0.0.1:5432/talons";
const { init, q, insertMany } = await import("../src/db.js");
const stats = await import("../src/stats.js");
const fail = [];
const check = (n, c, d = "") => { if (!c) fail.push(`${n} ${d}`); console.log(`${c ? "ok  " : "FAIL"} ${n} ${d}`); };
await q("DROP TABLE IF EXISTS swaps, pools, tokens, sources, nonpools, meta_events, lp_endpoints, token_images, image_patterns, meta CASCADE").catch(() => {});
await init();
const A = (n) => "0x" + n.toString(16).padStart(40, "0");
const now = Math.floor(Date.now() / 1000);
const H = 3600, D = 86400;

await insertMany("tokens", ["address", "name", "symbol", "decimals", "total_supply"],
  [[A(1), "Split", "SPLIT", 18, "1000000000000000000000"], [A(2), "Quiet", "QUIET", 18, "1000000000000000000000"]]);
// SPLIT trades on two venues at once, QUIET only long ago
await insertMany("pools", ["address", "token", "token_is_token0", "fee", "version", "created_block", "created_ts"],
  [[A(101), A(1), 0, 3000, 3, 1, now - 40 * D], [A(102), A(1), 0, 0, 1, 1, now - 40 * D], [A(103), A(2), 0, 3000, 3, 1, now - 40 * D]]);
await q("UPDATE pools SET liquidity_usd = 900 WHERE address = $1", [A(101)]);
await q("UPDATE pools SET liquidity_usd = 100 WHERE address = $1", [A(102)]);

let li = 0;
const sw = (pool, tsAgo, usd, price, trader, buy = 1) => [pool, 1000 + li, li++, now - tsAgo, "0x" + li, trader, usd, buy, price, usd / price];
const rows = [
  // within 24h: 100 on the deep pool, 50 on the shallow one -> token total 150, three txns, two traders
  sw(A(101), 2 * H, 100, 2, A(501)),
  sw(A(102), 3 * H, 30, 2, A(502)),
  sw(A(102), 4 * H, 20, 2, A(501)),
  // between one and seven days: another 200 -> 7d total 350
  sw(A(101), 3 * D, 200, 1.5, A(503)),
  // between seven and thirty days: another 400 -> 30d total 750
  sw(A(101), 20 * D, 400, 1, A(504)),
  // older than thirty days: only counted in ALL -> all total 1750
  sw(A(101), 40 * D, 1000, 0.5, A(505)),
  sw(A(103), 35 * D, 77, 3, A(506)),
];
await insertMany("swaps", ["pool", "block", "log_index", "ts", "tx", "trader", "usd", "buy", "price", "amt"], rows);

const out = await stats.buildRows();
const sp = out.find((r) => r.symbol === "SPLIT");
const qt = out.find((r) => r.symbol === "QUIET");

check("one row per token", out.length === 2, `${out.length}`);
check("deepest pool represents the token", sp && sp.pool === A(101), sp?.pool);
check("pool count exposed", sp && sp.pools === 2, String(sp?.pools));
check("24h volume sums both venues", sp && Math.abs(sp.vol24h - 150) < 1e-9, String(sp?.vol24h));
check("24h txns sum both venues", sp && sp.txns24h === 3, String(sp?.txns24h));
check("7d volume", sp && Math.abs(sp.vol7d - 350) < 1e-9, String(sp?.vol7d));
check("30d volume", sp && Math.abs(sp.vol30d - 750) < 1e-9, String(sp?.vol30d));
check("all time volume", sp && Math.abs(sp.volall - 1750) < 1e-9, String(sp?.volall));
check("7d txns", sp && sp.txns7d === 4, String(sp?.txns7d));
check("30d txns", sp && sp.txns30d === 5, String(sp?.txns30d));
check("all time txns", sp && sp.txnsall === 6, String(sp?.txnsall));
check("traders not double counted", sp && sp.traders24h === 2, String(sp?.traders24h));
check("liquidity sums both venues", sp && Math.abs(sp.liquidity - 1000) < 1e-9, String(sp?.liquidity));
check("quiet token has no recent volume", qt && qt.vol24h === 0 && qt.vol30d === 0, `${qt?.vol24h}/${qt?.vol30d}`);
check("quiet token still has all time volume", qt && Math.abs(qt.volall - 77) < 1e-9, String(qt?.volall));
check("all time change uses the first trade", sp && sp.chall != null && sp.chall > 0, String(sp?.chall));
check("changes finite or null", [sp.ch5m, sp.ch1h, sp.ch6h, sp.ch24h, sp.ch7d, sp.ch30d, sp.chall].every((v) => v === null || Number.isFinite(v)));
check("no NaN in any field", out.every((r) => Object.values(r).every((v) => typeof v !== "number" || Number.isFinite(v))));

console.log(`\n${fail.length ? "FAILURES:\n- " + fail.join("\n- ") : "ALL TIMEFRAME CHECKS PASSED"}`);
process.exit(fail.length ? 1 : 0);
