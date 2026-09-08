// Venue detection: hand built Transfer logs standing in for a bonding curve buy and a sell, plus
// transactions that must be ignored (plain sends, wallet to wallet swaps, multi token transactions).
const { pairTrades, selectTrades } = await import("../src/venues.js");
const fail = [];
const check = (n, c, d = "") => { if (!c) fail.push(`${n} ${d}`); console.log(`${c ? "ok  " : "FAIL"} ${n} ${d}`); };
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const USDC = "0x3600000000000000000000000000000000000000";
const pad = (a) => "0x" + a.slice(2).padStart(64, "0");
const hexAmt = (n) => "0x" + n.toString(16).padStart(64, "0");
const CURVE = "0x00000000000000000000000000000000000000aa";
const TOKEN = "0x00000000000000000000000000000000000000bb";
const WALLET = "0x00000000000000000000000000000000000000cc";
const OTHER = "0x00000000000000000000000000000000000000dd";
const log = (address, from, to, amt, tx, li) => ({ address, topics: [TRANSFER, pad(from), pad(to)], data: hexAmt(amt), transactionHash: tx, blockNumber: "0x64", logIndex: "0x" + li.toString(16) });

// buy: wallet sends USDC to the curve, curve sends token to wallet
const buy = [log(USDC, WALLET, CURVE, 1000000n, "0x1", 0), log(TOKEN, CURVE, WALLET, 5000000000000000000n, "0x1", 1)];
// sell: wallet sends token to the curve, curve sends USDC back
const sell = [log(TOKEN, WALLET, CURVE, 2000000000000000000n, "0x2", 0), log(USDC, CURVE, WALLET, 400000n, "0x2", 1)];
// noise that must not become a trade
const plainSend = [log(USDC, WALLET, OTHER, 5000n, "0x3", 0)];
const walletSwap = [log(USDC, WALLET, OTHER, 5000n, "0x4", 0), log(TOKEN, OTHER, WALLET, 100n, "0x4", 1)];
const multi = [log(USDC, WALLET, CURVE, 100n, "0x5", 0), log(TOKEN, CURVE, WALLET, 100n, "0x5", 1), log(OTHER, CURVE, WALLET, 100n, "0x5", 2)];

// pairTrades emits both readings of each transaction; selectTrades keeps the one whose venue is a
// contract, which is what tells a curve trade apart from two people swapping directly.
const cands = pairTrades([...buy, ...sell, ...plainSend, ...walletSwap, ...multi]);
const contracts = new Set([CURVE]);
const t = await selectTrades(cands, async (v) => contracts.has(v));
check("two trades after venue check", t.length === 2, `got ${t.length} from ${cands.length} candidates`);
const b = t.find((x) => x.tx === "0x1"), s = t.find((x) => x.tx === "0x2");
check("buy detected", b && b.buy === 1 && b.venue === CURVE && b.token === TOKEN && b.trader === WALLET);
check("sell detected", s && s.buy === 0 && s.venue === CURVE && s.token === TOKEN && s.trader === WALLET);
check("buy amounts", b && b.usdRaw === 1000000n && b.tokRaw === 5000000000000000000n);
check("buy price is 0.2", b && Number(b.usdRaw) / 1e6 / (Number(b.tokRaw) / 1e18) === 0.2);
check("sell price is 0.2", s && Number(s.usdRaw) / 1e6 / (Number(s.tokRaw) / 1e18) === 0.2);
check("plain send ignored", !t.some((x) => x.tx === "0x3"));
check("wallet to wallet dropped", !t.some((x) => x.tx === "0x4"));
check("multi token tx ignored", !t.some((x) => x.tx === "0x5"));
check("no trade without topics", pairTrades([{ address: USDC, topics: [TRANSFER], data: hexAmt(1n), transactionHash: "0x9", blockNumber: "0x1", logIndex: "0x0" }]).length === 0);
console.log(`\n${fail.length ? "FAILURES:\n- " + fail.join("\n- ") : "ALL VENUE CHECKS PASSED"}`);
process.exit(fail.length ? 1 : 0);
