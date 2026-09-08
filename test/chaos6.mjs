// Image caching: real bytes are stored and served, junk is refused, and a dead host falls through.
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres@127.0.0.1:5432/talons";
const { init, q, insertMany } = await import("../src/db.js");
const fail = [];
const check = (n, c, d = "") => { if (!c) fail.push(`${n} ${d}`); console.log(`${c ? "ok  " : "FAIL"} ${n} ${d}`); };
await q("DROP TABLE IF EXISTS swaps, pools, tokens, sources, nonpools, meta_events, lp_endpoints, token_images, meta CASCADE").catch(() => {});
await init();
const A = (n) => "0x" + n.toString(16).padStart(40, "0");

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082", "hex");
const http = await import("node:http");
const srv = http.createServer((req, res) => {
  if (req.url === "/good.png") { res.writeHead(200, { "content-type": "image/png" }); return res.end(PNG); }
  if (req.url === "/html") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html>nope</html>"); }
  if (req.url === "/huge.png") { res.writeHead(200, { "content-type": "image/png", "content-length": String(9 * 1024 * 1024) }); return res.end(Buffer.alloc(1024)); }
  if (req.url === "/error") { res.writeHead(500); return res.end(); }
  res.writeHead(404); res.end();
});
await new Promise((r) => srv.listen(4222, r));
const base = "http://127.0.0.1:4222";
const { cacheImage, getImage, cacheImages } = await import("../src/images.js");

check("real png cached", await cacheImage(A(1), base + "/good.png") === true);
const got = await getImage(A(1));
check("bytes round trip", got && Buffer.compare(Buffer.from(got.bytes), PNG) === 0, got ? `${got.bytes.length} bytes` : "none");
check("content type kept", got?.ctype === "image/png", got?.ctype);
check("html refused", await cacheImage(A(2), base + "/html") === false);
check("oversized refused", await cacheImage(A(3), base + "/huge.png") === false);
check("server error refused", await cacheImage(A(4), base + "/error") === false);
check("dead host refused", await cacheImage(A(5), "http://127.0.0.1:4999/x.png") === false);
check("empty url refused", await cacheImage(A(6), "") === false);
check("nothing stored for failures", (await q("SELECT COUNT(*)::int c FROM token_images"))[0].c === 1);

// the batch job only touches tokens that have a pool and a logo url
await insertMany("tokens", ["address", "name", "symbol", "decimals", "total_supply"], [[A(7), "Seven", "SVN", 18, "1000"]]);
await q("UPDATE tokens SET logo = $1 WHERE address = $2", [base + "/good.png", A(7)]);
await insertMany("pools", ["address", "token", "token_is_token0", "fee", "version", "created_block", "created_ts"], [[A(107), A(7), 0, 3000, 3, 1, 1]]);
check("batch caches pooled tokens", await cacheImages(10) === 1);
check("second pass does nothing", await cacheImages(10) === 0);

srv.close();
console.log(`\n${fail.length ? "FAILURES:\n- " + fail.join("\n- ") : "ALL IMAGE CHECKS PASSED"}`);
process.exit(fail.length ? 1 : 0);
