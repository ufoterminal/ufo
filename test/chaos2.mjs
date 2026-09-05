// Second pass: the HTTP surface, with a live server and a real database behind it.
process.env.DATABASE_URL = "postgres://postgres@localhost:5432/talons";
process.env.PORT = "3999";
process.env.NO_INDEXER = "1";
const fail = [];
const check = (n, c, d = "") => { if (!c) fail.push(`${n} ${d}`); console.log(`${c ? "ok  " : "FAIL"} ${n} ${d}`); };
await import("../src/server.js");
await new Promise((r) => setTimeout(r, 1500));
const base = "http://127.0.0.1:3999";
const get = async (p) => { const r = await fetch(base + p); let j = null; try { j = await r.json(); } catch {} return { status: r.status, j }; };

const paths = ["/api/screener", "/api/status", "/api/feed", "/api/sources", "/api/coverage",
  "/api/token/0x0000000000000000000000000000000000000001", "/api/candles/0x0000000000000000000000000000000000000001?tf=1h",
  "/api/search?q=cool", "/api/search?q=", "/api/search?q=" + encodeURIComponent("<script>alert(1)</script>"),
  "/api/token/notanaddress", "/api/candles/0x0000000000000000000000000000000000000001?tf=bogus",
  "/api/holders/0x0000000000000000000000000000000000000001"];
for (const p of paths) {
  const r = await get(p);
  check(`GET ${p}`, r.status < 500, `status ${r.status}`);
}
const scr = await get("/api/screener");
check("screener rows present", Array.isArray(scr.j?.rows) && scr.j.rows.length > 0, `${scr.j?.rows?.length}`);
check("screener has no undefined", JSON.stringify(scr.j).includes("undefined") === false);
const bad = await get("/api/token/0xZZZ");
check("bad address rejected", bad.status === 400 || bad.status === 404, `status ${bad.status}`);
const pages = ["/", "/token/0x0000000000000000000000000000000000000001"];
for (const p of pages) { const r = await fetch(base + p); check(`page ${p}`, r.status === 200, `status ${r.status}`); }
// hammer it: fifty concurrent screener reads should not fall over or slow to a crawl
const t = Date.now();
const many = await Promise.all(Array.from({ length: 50 }, () => fetch(base + "/api/screener")));
check("50 concurrent reads ok", many.every((r) => r.ok), `${Date.now() - t}ms`);
console.log(`\n${fail.length ? "FAILURES:\n- " + fail.join("\n- ") : "ALL HTTP CHECKS PASSED"}`);
process.exit(fail.length ? 1 : 0);
