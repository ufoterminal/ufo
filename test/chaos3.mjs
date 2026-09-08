// Ownership: a site that also lists other pads' launches must only get credit for its own, and a row
// that cannot prove where it came from is dropped rather than mislabelled.
const { ownsRow } = await import("../worker/sources.js");
const fail = [];
const check = (n, c, d = "") => { if (!c) fail.push(`${n} ${d}`); console.log(`${c ? "ok  " : "FAIL"} ${n} ${d}`); };
const F = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

// a single launchpad API: everything it returns is its own
check("own source keeps every row", ownsRow({ token: "0x1" }, { id: "solo", own: true }));

// an aggregator that names the factory
const agg = { id: "sharc", label: "Sharc", factories: [F], aliases: ["sharcfun"] };
check("row from our factory kept", ownsRow({ factory: F }, agg));
check("row from another factory dropped", !ownsRow({ factory: OTHER }, agg));
check("factory match is case insensitive", ownsRow({ factory: F.toUpperCase() }, agg));

// an aggregator that names the platform instead of an address
check("platform name kept", ownsRow({ platform: "Sharc" }, agg));
check("platform alias kept", ownsRow({ launchpad: "sharcfun" }, agg));
check("another platform dropped", !ownsRow({ platform: "Klik" }, agg));

// silence is not consent: with nothing identifying the origin the row is not ours
check("row with no origin field dropped", !ownsRow({ token: "0x1", symbol: "X" }, agg));
check("row with empty origin dropped", !ownsRow({ factory: "", platform: "" }, agg));

// a custom rule wins over the defaults
const custom = { id: "klik", owns: (row) => row.version === 4 };
check("custom rule applied", ownsRow({ version: 4 }, custom));
check("custom rule rejects", !ownsRow({ version: 3 }, custom));

// a real mixed list: only the pad's own launches survive
const rows = [{ factory: F, symbol: "MINE1" }, { factory: OTHER, symbol: "THEIRS" }, { platform: "sharc", symbol: "MINE2" }, { symbol: "UNKNOWN" }];
const kept = rows.filter((r) => ownsRow(r, agg)).map((r) => r.symbol);
check("mixed list filtered correctly", kept.join(",") === "MINE1,MINE2", kept.join(","));

console.log(`\n${fail.length ? "FAILURES:\n- " + fail.join("\n- ") : "ALL OWNERSHIP CHECKS PASSED"}`);
process.exit(fail.length ? 1 : 0);
