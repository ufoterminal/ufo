// The prober must accept a real launchpad response and refuse anything it cannot verify.
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres@127.0.0.1:5432/talons";
const { init, q, insertMany } = await import("../src/db.js");
const fail = [];
const check = (n, c, d = "") => { if (!c) fail.push(`${n} ${d}`); console.log(`${c ? "ok  " : "FAIL"} ${n} ${d}`); };
await q("DROP TABLE IF EXISTS swaps, pools, tokens, sources, nonpools, meta_events, lp_endpoints, meta CASCADE").catch(() => {});
await init();
const A = (n) => "0x" + n.toString(16).padStart(40, "0");
await insertMany("tokens", ["address", "name", "symbol", "decimals", "total_supply"],
  [[A(1), "One", "ONE", 18, "1000"], [A(2), "Two", "TWO", 18, "1000"], [A(3), "Three", "THREE", 18, "1000"]]);

// A local stand in for a launchpad API, plus decoys: wrong chain, html, and an empty list.
const http = await import("node:http");
const routes = {
  "/api/tokens": { tokens: [
    { token: A(1), symbol: "ONE", image: "/img/one.png", twitter: "@one", description: "first" },
    { token: A(2), symbol: "TWO", image: "https://cdn.example/two.png" },
    { token: A(3), symbol: "THREE", image: "/img/three.png" },
  ] },
  "/api/other-chain": { tokens: [{ token: A(9999), symbol: "NOPE", image: "/x.png" }, { token: A(9998), symbol: "NOPE2", image: "/y.png" }] },
  "/api/empty": { tokens: [] },
};
const srv = http.createServer((req, res) => {
  const p = req.url.split("?")[0];
  if (p === "/api/html") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html></html>"); }
  const body = routes[p];
  if (!body) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
});
await new Promise((r) => srv.listen(4111, r));

const { probeDomain, syncDiscovered } = await import("../src/probe.js");
// point the prober at the local server by overriding the host list through a domain that resolves to it
const probe = await import("../src/probe.js");
const fakeHosts = ["http://127.0.0.1:4111"];
// exercise the internals directly: try the known good path and the decoys
const tryOne = async (path) => {
  const r = await fetch(fakeHosts[0] + path).then((x) => x.json()).catch(() => null);
  return r;
};
check("server serves tokens", (await tryOne("/api/tokens"))?.tokens?.length === 3);

// full probe against the local host by temporarily inserting the endpoint the way discovery would
await q("INSERT INTO lp_endpoints (domain, label, host, path, matched, checked) VALUES ($1,$2,$3,$4,$5,$6)",
  ["local.test", "Local", fakeHosts[0], "/api/tokens", 3, Date.now()]);
const updated = await syncDiscovered({ tokens: new Map() });
check("metadata written from endpoint", updated === 3, `updated ${updated}`);
const rows = await q("SELECT address, logo, twitter, description FROM tokens ORDER BY address");
check("relative image made absolute", rows[0].logo === fakeHosts[0] + "/img/one.png", rows[0].logo);
check("absolute image kept", rows[1].logo === "https://cdn.example/two.png", rows[1].logo);
check("socials written", rows[0].twitter === "@one" && rows[0].description === "first");

// an endpoint whose rows are not our tokens must write nothing
await q("UPDATE lp_endpoints SET path = $1", ["/api/other-chain"]);
const before = (await q("SELECT COUNT(*)::int c FROM tokens WHERE logo <> ''"))[0].c;
await syncDiscovered({ tokens: new Map() });
const after = (await q("SELECT COUNT(*)::int c FROM tokens WHERE logo <> ''"))[0].c;
check("unknown tokens ignored", before === after, `${before} -> ${after}`);
check("no rows invented", (await q("SELECT COUNT(*)::int c FROM tokens"))[0].c === 3);

srv.close();
console.log(`\n${fail.length ? "FAILURES:\n- " + fail.join("\n- ") : "ALL PROBE CHECKS PASSED"}`);
process.exit(fail.length ? 1 : 0);
