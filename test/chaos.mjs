// Chaos test: a real Postgres, deliberately awful data, and every read path exercised.
// Looks for crashes, NaN, nulls leaking into the UI, and wrong arithmetic.
process.env.DATABASE_URL = "postgres://postgres@localhost:5432/talons";
const { init, q, insertMany } = await import("../src/db.js");
const stats = await import("../src/stats.js");

const fail = [];
const check = (name, cond, detail = "") => { if (!cond) fail.push(`${name} ${detail}`); console.log(`${cond ? "ok  " : "FAIL"} ${name} ${detail}`); };
const now = Math.floor(Date.now() / 1000);
const addr = (n) => "0x" + n.toString(16).padStart(40, "0");

await q("DROP TABLE IF EXISTS swaps, pools, tokens, sources, nonpools, meta_events, meta CASCADE").catch(() => {});
await init();

// Tokens: normal, zero decimals, huge supply, empty symbol, duplicate ticker, no pool, unicode name
const tokens = [
  [addr(1), "Cool Token", "COOL", 18, "1000000000000000000000000000"],
  [addr(2), "Copycat", "COOL", 18, "1000000000000000000000000000"],   // same ticker, later birth
  [addr(3), "Zero Decimals", "ZED", 0, "1000000"],
  [addr(4), "Huge", "HUGE", 18, "999999999999999999999999999999999999"],
  [addr(5), "", "", 18, "0"],                                          // no metadata at all
  [addr(6), "Ünïcode 名前", "UNI", 6, "1000000000"],
  [addr(7), "No Pool", "NOPOOL", 18, "1000"],                          // searchable, no market
];
await insertMany("tokens", ["address", "name", "symbol", "decimals", "total_supply"], tokens);
await q("UPDATE tokens SET birth_block = 1000 WHERE address = $1", [addr(1)]);
await q("UPDATE tokens SET birth_block = 9000 WHERE address = $1", [addr(2)]);
await q("UPDATE tokens SET holders = 987 WHERE address = $1", [addr(1)]);

// Pools: two for one token, a zero liquidity one, one with a null factory, one V2
const pools = [
  [addr(101), addr(1), 0, 3000, 3, 1000, now - 27 * 86400, 5, addr(900)],
  [addr(102), addr(1), 1, 10000, 3, 1200, now - 26 * 86400, 5, addr(900)],  // deeper pool wins
  [addr(103), addr(2), 0, 3000, 3, 9000, now - 3600, 5, null],
  [addr(104), addr(3), 0, 3000, 2, 500, now - 40 * 86400, 5, addr(901)],
  [addr(105), addr(4), 0, 3000, 3, 600, now - 86400, 5, addr(900)],
  [addr(106), addr(5), 0, 3000, 3, 700, now - 5 * 86400, 5, null],          // dead pool, no swaps
  [addr(107), addr(6), 1, 500, 3, 800, now - 10 * 86400, 5, addr(902)],
];
await insertMany("pools", ["address", "token", "token_is_token0", "fee", "version", "created_block", "created_ts", "price_block", "factory"], pools);
await q("UPDATE pools SET liquidity_usd = 100 WHERE address = $1", [addr(101)]);
await q("UPDATE pools SET liquidity_usd = 5000 WHERE address = $1", [addr(102)]);
await q("UPDATE pools SET liquidity_usd = 0 WHERE address = $1", [addr(106)]);

// Swaps: exact known volumes so the arithmetic can be verified, plus nasty values
const swaps = [];
let li = 0;
const push = (pool, tsAgo, usd, price, buy, trader) => swaps.push([pool, 1000 + li, li++, now - tsAgo, "0x" + li.toString(16), trader, usd, buy, price, usd / (price || 1)]);
for (let i = 0; i < 10; i++) push(addr(102), 3600 * (i + 1), 100, 1 + i * 0.1, i % 2, addr(500 + (i % 3)));  // 1000 usd in 24h, 3 traders
push(addr(102), 30, 250, 2.5, 1, addr(555));                        // recent, moves 5m and 1h
swaps.push([addr(102), 5, 9999, now - 100 * 86400, "0xold", addr(556), 9999, 1, 0.001, 1]); // ancient, low block, must not count in 24h
push(addr(101), 600, 7, 1.9, 0, addr(557));
push(addr(103), 120, 5, 0.5, 1, addr(558));
push(addr(104), 600, 3, 0, 1, addr(559));                           // zero price
push(addr(105), 600, 1e9, 1e-18, 1, addr(560));                     // extreme magnitudes
push(addr(107), 600, 12, 3, 1, "");                                 // empty trader
await insertMany("swaps", ["pool", "block", "log_index", "ts", "tx", "trader", "usd", "buy", "price", "amt"], swaps);

const rows = await stats.buildRows();
const by = (sym) => rows.find((r) => r.symbol === sym);
const cool = by("COOL");

check("one row per token with a pool", rows.length === 6, `got ${rows.length}`);
check("deepest pool chosen", cool && cool.pool === addr(102), cool ? cool.pool : "missing");
check("24h volume exact", cool && Math.abs(cool.vol24h - 1250) < 0.001, cool ? String(cool.vol24h) : "-");
check("24h txns exact", cool && cool.txns24h === 11, cool ? String(cool.txns24h) : "-");
check("ancient swap excluded", cool && cool.vol24h < 9999);
check("distinct traders", cool && cool.traders24h === 4, cool ? String(cool.traders24h) : "-");
check("holders passed through", cool && cool.holders === 987, cool ? String(cool.holders) : "-");
check("age from birth block not pool", cool && now - cool.createdTs > 20 * 86400, cool ? `${Math.round((now - cool.createdTs) / 86400)}d` : "-");
check("OG on the original ticker", cool && cool.og === true);
check("OG denied to the copy", by("COOL") && rows.filter((r) => r.symbol === "COOL").every((r, i) => i === 0 || r.og === false));
check("no NaN anywhere", rows.every((r) => Object.values(r).every((v) => typeof v !== "number" || Number.isFinite(v))));
check("percentages null or finite", rows.every((r) => [r.ch5m, r.ch1h, r.ch6h, r.ch24h].every((v) => v === null || Number.isFinite(v))));
check("zero price pool survives", by("ZED") !== undefined);
check("empty symbol token survives", rows.some((r) => r.symbol === ""));
check("extreme magnitudes finite", by("HUGE") && Number.isFinite(by("HUGE").mcap));
check("dead pool has zero liquidity", rows.some((r) => r.liquidity === 0));

const c = await stats.getCandles(addr(1), "5m");
check("candles built", c.candles.length > 0, `${c.candles.length} bars`);
check("candles ordered", c.candles.every((x, i, a) => i === 0 || x.t >= a[i - 1].t));
check("candle ohlc sane", c.candles.every((x) => x.h >= x.l && x.h >= x.o && x.h >= x.c && Number.isFinite(x.o)));
check("gap fill bounded", c.candles.length <= 400, `${c.candles.length}`);

const s1 = await stats.searchTokens("cool");
check("search finds by ticker", s1.local.length >= 2, `${s1.local.length}`);
const s2 = await stats.searchTokens("nopool");
check("search finds token with no market", s2.local.some((t) => t.symbol === "NOPOOL"));
check("no market flagged", s2.local.find((t) => t.symbol === "NOPOOL")?.indexed === false);
const s3 = await stats.searchTokens(addr(1));
check("search by address", s3.local.some((t) => t.address === addr(1)));
const s4 = await stats.searchTokens("'; DROP TABLE tokens; --");
check("sql injection harmless", Array.isArray(s4.local));
check("tokens table intact", (await q("SELECT COUNT(*)::int c FROM tokens"))[0].c === tokens.length);

const d = await stats.getTokenDetail(addr(1));
check("detail returns", d && d.token.symbol === "COOL");
check("detail lists pools", d && d.pools.length === 2, d ? String(d.pools.length) : "-");
check("detail trades newest first", d && d.trades.every((t, i, a) => i === 0 || t.ts <= a[i - 1].ts));
check("detail for unknown token is null", (await stats.getTokenDetail(addr(999))) === null);

const feed = await stats.getFeed(20);
check("feed returns", Array.isArray(feed) && feed.length > 0, `${feed.length}`);
check("feed rows have symbols", feed.every((f) => typeof f.symbol === "string"));

const screener = await stats.getScreener(12345);
check("screener shape", screener && Array.isArray(screener.rows) && screener.tip === 12345);

console.log(`\n${fail.length ? "FAILURES:\n- " + fail.join("\n- ") : "ALL CHECKS PASSED"}`);
process.exit(fail.length ? 1 : 0);
