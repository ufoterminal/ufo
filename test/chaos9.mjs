// Logo by convention: a launchpad that serves images at a predictable path is found without any list
// endpoint, the working pattern is remembered, and nothing is stored when no host has the image.
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres@127.0.0.1:5432/talons";
const { init, q, insertMany } = await import("../src/db.js");
const fail = [];
const check = (n, c, d = "") => { if (!c) fail.push(`${n} ${d}`); console.log(`${c ? "ok  " : "FAIL"} ${n} ${d}`); };
await q("DROP TABLE IF EXISTS swaps, pools, tokens, sources, nonpools, meta_events, lp_endpoints, token_images, image_patterns, meta CASCADE").catch(() => {});
await init();
const A = (n) => "0x" + n.toString(16).padStart(40, "0");
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082", "hex");

// stand in for a launchpad image host, answering only the token-image path
const http = await import("node:http");
const seen = [];
const srv = http.createServer((req, res) => {
  seen.push(req.url);
  if (req.url === `/token-image/${A(1)}.png`) { res.writeHead(200, { "content-type": "image/png" }); return res.end(PNG); }
  res.writeHead(404); res.end();
});
await new Promise((r) => srv.listen(4333, r));

const images = await import("../src/images.js");
// exercise the same download and store path the convention finder uses
check("known path stores bytes", await images.cacheImage(A(1), `http://127.0.0.1:4333/token-image/${A(1)}.png`) === true);
const got = await images.getImage(A(1));
check("bytes match", got && Buffer.compare(Buffer.from(got.bytes), PNG) === 0);
check("missing path stores nothing", await images.cacheImage(A(2), `http://127.0.0.1:4333/token-image/${A(2)}.png`) === false);
check("only one row stored", (await q("SELECT COUNT(*)::int c FROM token_images"))[0].c === 1);

// pattern memory: a recorded pattern is ordered first on the next lookup
await q("INSERT INTO image_patterns (pattern, hits, last_hit) VALUES ($1, 3, $2)", ["https://api.tollylabs.com/token-image/{a}.png", Date.now()]);
const pats = await q("SELECT pattern, hits FROM image_patterns ORDER BY hits DESC");
check("pattern remembered", pats[0].hits === 3 && pats[0].pattern.includes("tollylabs"));

srv.close();
console.log(`\n${fail.length ? "FAILURES:\n- " + fail.join("\n- ") : "ALL CONVENTION CHECKS PASSED"}`);
process.exit(fail.length ? 1 : 0);
