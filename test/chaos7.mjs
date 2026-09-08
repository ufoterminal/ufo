// Wallet maths: average cost basis, realised and unrealised split, and closed positions.
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres@127.0.0.1:5432/talons";
const { init, q, insertMany } = await import("../src/db.js");
const stats = await import("../src/stats.js");
const fail = [];
const check = (n, c, d = "") => { if (!c) fail.push(`${n} ${d}`); console.log(`${c ? "ok  " : "FAIL"} ${n} ${d}`); };
await q("DROP TABLE IF EXISTS swaps, pools, tokens, sources, nonpools, meta_events, lp_endpoints, token_images, meta CASCADE").catch(() => {});
await init();
const A = (n) => "0x" + n.toString(16).padStart(40, "0");
const now = Math.floor(Date.now() / 1000);
const W = A(777), OTHER = A(778);

await insertMany("tokens", ["address", "name", "symbol", "decimals", "total_supply"],
  [[A(1), "Alpha", "ALPHA", 18, "1000"], [A(2), "Beta", "BETA", 18, "1000"]]);
await insertMany("pools", ["address", "token", "token_is_token0", "fee", "version", "created_block", "created_ts"],
  [[A(101), A(1), 0, 3000, 3, 1, now - 86400], [A(102), A(2), 0, 3000, 3, 1, now - 86400]]);
await q("UPDATE pools SET price = 3, liquidity_usd = 1000 WHERE address = $1", [A(101)]);
await q("UPDATE pools SET price = 1, liquidity_usd = 1000 WHERE address = $1", [A(102)]);

let li = 0;
const sw = (pool, trader, tsAgo, usd, amt, buy) => [pool, 100 + li, li++, now - tsAgo, "0x" + li, trader, usd, buy, usd / amt, amt];
// ALPHA: buy 10 at $1 then 10 at $2 (avg $1.50), sell 10 at $2.50 -> realised +10, 10 left, price $3 -> unrealised +15
// BETA: buy 100 at $2 total 200, sell all 100 for 100 -> realised -100, position closed
await insertMany("swaps", ["pool", "block", "log_index", "ts", "tx", "trader", "usd", "buy", "price", "amt"], [
  sw(A(101), W, 5000, 10, 10, 1),
  sw(A(101), W, 4000, 20, 10, 1),
  sw(A(101), W, 3000, 25, 10, 0),
  sw(A(102), W, 2000, 200, 100, 1),
  sw(A(102), W, 1000, 100, 100, 0),
  sw(A(101), OTHER, 900, 999, 1, 1),
]);

const w = await stats.getWallet(W);
const alpha = w.positions.find((p) => p.symbol === "ALPHA");
const beta = w.positions.find((p) => p.symbol === "BETA");
check("wallet has two positions", w.positions.length === 2, `${w.positions.length}`);
check("alpha holding left", alpha && Math.abs(alpha.amount - 10) < 1e-9, alpha ? String(alpha.amount) : "-");
check("alpha average cost 1.5", alpha && Math.abs(alpha.avg - 1.5) < 1e-9, alpha ? String(alpha.avg) : "-");
check("alpha realised +10", alpha && Math.abs(alpha.realised - 10) < 1e-9, alpha ? String(alpha.realised) : "-");
check("alpha unrealised +15", alpha && Math.abs(alpha.unrealised - 15) < 1e-9, alpha ? String(alpha.unrealised) : "-");
check("beta closed", beta && beta.amount === 0);
check("beta realised -100", beta && Math.abs(beta.realised + 100) < 1e-9, beta ? String(beta.realised) : "-");
check("totals bought", Math.abs(w.totals.bought - 230) < 1e-9, String(w.totals.bought));
check("totals sold", Math.abs(w.totals.sold - 125) < 1e-9, String(w.totals.sold));
check("totals realised -90", Math.abs(w.totals.realised + 90) < 1e-9, String(w.totals.realised));
check("other wallet excluded", w.trades.every((t) => t.usd !== 999));
check("empty wallet is empty", (await stats.getWallet(A(999))).positions.length === 0);
check("trades newest first", w.trades.every((t, i, a) => i === 0 || t.ts <= a[i - 1].ts));
console.log(`\n${fail.length ? "FAILURES:\n- " + fail.join("\n- ") : "ALL WALLET CHECKS PASSED"}`);
process.exit(fail.length ? 1 : 0);
