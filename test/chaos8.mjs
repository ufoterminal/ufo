// The repair pass must requeue stuck rows and the gap report must count what is actually missing.
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres@127.0.0.1:5432/talons";
const { init, q, insertMany } = await import("../src/db.js");
const { gaps, repair } = await import("../src/gaps.js");
const fail = [];
const check = (n, c, d = "") => { if (!c) fail.push(`${n} ${d}`); console.log(`${c ? "ok  " : "FAIL"} ${n} ${d}`); };
await q("DROP TABLE IF EXISTS swaps, pools, tokens, sources, nonpools, meta_events, lp_endpoints, token_images, meta CASCADE").catch(() => {});
await init();
const A = (n) => "0x" + n.toString(16).padStart(40, "0");
const old = Date.now() - 3 * 86400_000;

await insertMany("tokens", ["address", "name", "symbol", "decimals", "total_supply"],
  [[A(1), "With Logo", "WL", 18, "1"], [A(2), "Stuck", "STK", 18, "1"], [A(3), "No Pool", "NP", 18, "1"], [A(4), "Zero Birth", "ZB", 18, "1"]]);
await insertMany("pools", ["address", "token", "token_is_token0", "fee", "version", "created_block", "created_ts"],
  [[A(101), A(1), 0, 3000, 3, 1, 1], [A(102), A(2), 0, 3000, 3, 1, 1], [A(104), A(4), 0, 3000, 3, 1, 1]]);
await q("UPDATE pools SET liquidity_usd = 100");
await q("UPDATE tokens SET logo = 'https://x/y.png', meta_checked = $1, holders = 5, birth_block = 10 WHERE address = $2", [Date.now(), A(1)]);
await q("UPDATE tokens SET logo = '', meta_checked = $1 WHERE address = $2", [old, A(2)]);              // stuck, must requeue
await q("UPDATE tokens SET logo = '', meta_checked = $1 WHERE address = $2", [old, A(3)]);              // no pool, leave alone
await q("UPDATE tokens SET birth_block = 0, meta_checked = $1, logo = 'x' WHERE address = $2", [Date.now(), A(4)]);

const g1 = await gaps();
check("counts every token", g1.tokens === 4, `${g1.tokens}`);
check("logo count right", g1.with_logo === 2, `${g1.with_logo}`);
check("visible set excludes tokens with no pool", g1.visible === 3, `${g1.visible}`);
check("visible logo percentage", g1.visible_logo_pct === 67, `${g1.visible_logo_pct}`);

const r = await repair();
check("stuck token requeued", r.meta === 1, `${r.meta}`);
check("zero birth requeued", r.birth === 1, `${r.birth}`);
const stuck = await q("SELECT meta_checked FROM tokens WHERE address = $1", [A(2)]);
check("requeue clears the timestamp", stuck[0].meta_checked === null);
const untouched = await q("SELECT meta_checked FROM tokens WHERE address = $1", [A(3)]);
check("token with no pool left alone", untouched[0].meta_checked !== null);
const fresh = await q("SELECT meta_checked FROM tokens WHERE address = $1", [A(1)]);
check("token with a logo left alone", fresh[0].meta_checked !== null);
const again = await repair();
check("second pass finds nothing new", again.meta === 0 && again.birth === 0, JSON.stringify(again));
console.log(`\n${fail.length ? "FAILURES:\n- " + fail.join("\n- ") : "ALL GAP CHECKS PASSED"}`);
process.exit(fail.length ? 1 : 0);
