// The worker end to end, against fake launchpads: paging, a source that answers for the wrong chain,
// a source that is down, and a source that returns rubbish.
import http from "node:http";
const fail = [];
const check = (n, c, d = "") => { if (!c) fail.push(`${n} ${d}`); console.log(`${c ? "ok  " : "FAIL"} ${n} ${d}`); };
const A = (n) => "0x" + n.toString(16).padStart(40, "0");
const USDC = "0x3600000000000000000000000000000000000000";

const srv = http.createServer((req, res) => {
  const [path, qs] = req.url.split("?");
  const p = new URLSearchParams(qs || "");
  const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (path === "/paged/tokens") {
    const cur = p.get("cursor");
    if (!cur) return send({ chain: "arc", items: [{ token: A(1), symbol: "P1", price: 1, volume24: 10, pair_token: USDC }], nextCursor: "c2" });
    if (cur === "c2") return send({ chain: "arc", items: [{ token: A(2), symbol: "P2", price: 2, volume24: 20, pair_token: USDC }], nextCursor: null });
    return send({ items: [] });
  }
  if (path === "/wrongchain/tokens") return send({ chain: "robinhood", chainId: 4663, items: [{ token: A(9), symbol: "NOPE", pair_token: "0xdead" }] });
  if (path === "/rubbish/tokens") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ hello: "world" })); }
  res.writeHead(500); res.end();
});
await new Promise((r) => srv.listen(4444, r));

const { normalise } = await import("../worker/sources.js");
const base = "http://127.0.0.1:4444";
const sources = [
  { id: "paged", label: "Paged", base, list: ["/paged/tokens?limit=100{cursor}"], cursorParam: "&cursor=",
    items: (j) => j.items || [], next: (j) => j.nextCursor || null,
    verify: (row, j) => String(row.pair_token || "").toLowerCase() === USDC || String(j.chain) === "arc", map: {} },
  { id: "wrong", label: "WrongChain", base, list: ["/wrongchain/tokens"], items: (j) => j.items || [], next: () => null,
    verify: (row, j) => String(row.pair_token || "").toLowerCase() === USDC || Number(j.chainId) === 5042, map: {} },
  { id: "rubbish", label: "Rubbish", base, list: ["/rubbish/tokens"], items: (j) => j.items || [], next: () => null, verify: () => true, map: {} },
  { id: "down", label: "Down", base, list: ["/down/tokens"], items: (j) => j.items || [], next: () => null, verify: () => true, map: {} },
];

// same reading logic as the worker, exercised here against the fakes
async function readSource(src, budget = 5) {
  for (const path of src.list) {
    let cursor = null, pages = 0, rows = [], worked = false;
    while (pages++ < budget) {
      const url = src.base + path.replace("{cursor}", cursor && src.cursorParam ? src.cursorParam + cursor : "");
      let j;
      try { const r = await fetch(url); if (!r.ok) throw new Error("bad"); j = await r.json(); } catch { break; }
      const items = (src.items(j) || []).filter((row) => src.verify(row, j));
      if (!items.length && !rows.length) break;
      worked = true;
      for (const row of items) { const n = normalise(row, src); if (n) rows.push(n); }
      cursor = src.next(j);
      if (!cursor || !src.cursorParam) break;
    }
    if (worked && rows.length) return { id: src.id, ok: true, rows };
  }
  return { id: src.id, ok: false, rows: [] };
}

// map passes the index as a second argument, which would land in the page budget, so wrap it
const results = await Promise.all(sources.map((s) => readSource(s)));
const byId = Object.fromEntries(results.map((r) => [r.id, r]));
check("paging followed to the end", byId.paged.rows.length === 2, `${byId.paged.rows.length}`);
check("both pages kept in order", byId.paged.rows[0].symbol === "P1" && byId.paged.rows[1].symbol === "P2");
check("wrong chain rejected entirely", byId.wrong.ok === false && byId.wrong.rows.length === 0);
check("rubbish response yields nothing", byId.rubbish.ok === false && byId.rubbish.rows.length === 0);
check("dead source yields nothing", byId.down.ok === false);
check("one dead source does not stop the others", byId.paged.ok === true);

const all = results.flatMap((r) => r.rows);
check("only real rows survive", all.length === 2, `${all.length}`);
check("no wrong chain token present", !all.some((r) => r.symbol === "NOPE"));
const totals = { vol: all.reduce((s, r) => s + (r.vol24h || 0), 0) };
check("totals add up", totals.vol === 30, String(totals.vol));

srv.close();
console.log(`\n${fail.length ? "FAILURES:\n- " + fail.join("\n- ") : "ALL WORKER CHECKS PASSED"}`);
process.exit(fail.length ? 1 : 0);
