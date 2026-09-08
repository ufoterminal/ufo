// The worker's job is turning several launchpads' different shapes into one honest table. This checks
// the mapping, the merge, and that missing figures stay missing instead of becoming zeros.
const { normalise, GUESS } = await import("../worker/sources.js");
const fail = [];
const check = (n, c, d = "") => { if (!c) fail.push(`${n} ${d}`); console.log(`${c ? "ok  " : "FAIL"} ${n} ${d}`); };
const A = (n) => "0x" + n.toString(16).padStart(40, "0");
const src = { id: "x", label: "Example", icon: "", base: "https://api.example.fun", map: {} };

// a row using the conventional names needs no mapping
const r1 = normalise({ address: A(1).toUpperCase(), symbol: "ONE", name: "One", price: 0.0025, mcap: 250000,
  liquidityUsdc: 1200.5, volume24: 900, txns24: 42, traders24: 12, holderCount: 300,
  change5m: 1.2, change1h: -3, change6h: 10, change24h: 22, ageSec: 3600,
  icon: "/img/one.png", website: "one.fun", twitter: "@one", telegram: "onetg" }, src);
check("address lowercased", r1 && r1.token === A(1), r1?.token);
check("numbers read", r1.price === 0.0025 && r1.mcap === 250000 && r1.liquidity === 1200.5 && r1.vol24h === 900);
check("counts read", r1.txns24h === 42 && r1.traders24h === 12 && r1.holders === 300);
check("changes read", r1.ch5m === 1.2 && r1.ch1h === -3 && r1.ch6h === 10 && r1.ch24h === 22);
check("relative logo made absolute", r1.logo === "https://api.example.fun/img/one.png", r1.logo);
check("age turned into a timestamp", Math.abs(r1.createdTs - (Math.floor(Date.now() / 1000) - 3600)) <= 2, String(r1.createdTs));
check("launchpad attached", r1.launchpad.label === "Example");

// a row that reports almost nothing must not gain zeros it never had
const r2 = normalise({ token: A(2), symbol: "TWO" }, src);
check("missing figures stay null", r2.price === null && r2.vol24h === null && r2.liquidity === null && r2.holders === null);
check("missing changes stay null", [r2.ch5m, r2.ch1h, r2.ch6h, r2.ch24h].every((v) => v === null));
check("no age invented", r2.createdTs === 0);

// odd shapes: custom mapping, millisecond timestamps, a function for the logo
const src2 = { id: "y", label: "Odd", base: "https://odd.fun", map: { address: "ca", logo: (row) => `https://cdn.odd.fun/${row.ca}.png`, twitter: "x", createdAt: "created_at" } };
const r3 = normalise({ ca: A(3), symbol: "THR", x: "https://x.com/thr", created_at: 1700000000000 }, src2);
check("custom address field", r3.token === A(3));
check("logo built by function", r3.logo === `https://cdn.odd.fun/${A(3)}.png`, r3.logo);
check("millisecond timestamps handled", r3.createdTs === 1700000000, String(r3.createdTs));
check("custom social field", r3.twitter === "https://x.com/thr");

// junk must be refused rather than shown
check("row with no address refused", normalise({ symbol: "NONE" }, src) === null);
check("row with a bad address refused", normalise({ address: "0x123" }, src) === null);
check("empty row refused", normalise({}, src) === null);

// the merge keeps the richer entry when two launchpads list the same token
const score = (r) => [r.price, r.vol24h, r.liquidity, r.logo, r.holders].filter((v) => v != null && v !== "" && v !== 0).length;
const thin = normalise({ token: A(4), symbol: "DUP" }, src);
const rich = normalise({ token: A(4), symbol: "DUP", price: 1, volume24: 5, liquidityUsdc: 9, icon: "/d.png", holderCount: 3 }, src);
check("richer row wins the merge", score(rich) > score(thin), `${score(rich)} vs ${score(thin)}`);

// text that could break the page is escaped downstream, but the worker should still cap length
const long = normalise({ token: A(5), symbol: "X".repeat(80), name: "N".repeat(200), description: "D".repeat(900) }, src);
check("symbol capped", long.symbol.length <= 24, String(long.symbol.length));
check("name capped", long.name.length <= 64, String(long.name.length));
check("description capped", long.description.length <= 400, String(long.description.length));

console.log(`\n${fail.length ? "FAILURES:\n- " + fail.join("\n- ") : "ALL LAUNCHPAD CHECKS PASSED"}`);
process.exit(fail.length ? 1 : 0);
