import express from "express";
import compression from "compression";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { init } from "./db.js";
import { start, state } from "./indexer.js";
import { getScreener, getTokenDetail, getCandles, getFeed, getHolders, searchTokens, explorerToken } from "./stats.js";
import { probeAll } from "./chain.js";
import { listSources } from "./origins.js";
import { debugMeta } from "./meta.js";
import { syncDyor } from "./dyor.js";
import { coverage } from "./harvest.js";
import { selftest } from "./selftest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(compression()); // screener payloads are mostly repeated JSON keys and shrink by roughly ten times
app.disable("x-powered-by");
app.use((_, res, next) => { res.set("access-control-allow-origin", "*"); next(); });

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.log("[api]", req.path, e.message); res.status(500).json({ error: e.message }); });

app.get("/health", (_, res) => res.json({ ok: true, mode: state.mode, head: state.head, tip: state.tip, backfill: state.backfill, backfillDone: state.backfillDone, pools: state.pools.size, swapsSeen: state.swapsSeen, lastError: state.lastError, uptimeSec: Math.floor((Date.now() - state.started) / 1000) }));
app.get("/api/status", (_, res) => res.json({
  configured: true, tip: state.tip, head: state.head, backfill: state.backfill, backfillDone: state.backfillDone, pools: state.pools.size, tokens: state.tokens.size, lastError: state.lastError, lastSync: Date.now(),
  indexer: { alive: true, mode: state.mode, ws: state.wsUrl, uptimeSec: Math.floor((Date.now() - state.started) / 1000), swapsSeen: state.swapsSeen, at: Date.now(), head: state.head, tip: state.tip, backfill: state.backfill, backfillDone: state.backfillDone, lastError: state.lastError },
}));
app.get("/api/debug/dyor", wrap(async (_, res) => res.json({ updated: await syncDyor(null) })));
app.get("/api/debug/meta/:addr", wrap(async (req, res) => res.json(await debugMeta(req.params.addr))));
app.get("/api/selftest", wrap(async (_, res) => res.json(await selftest(state))));
app.get("/api/coverage", wrap(async (_, res) => res.json(await coverage())));
app.get("/api/sources", wrap(async (_, res) => res.json(await listSources())));
app.get("/api/rpc", wrap(async (_, res) => { const probes = await probeAll(); res.json({ alive: probes.filter((p) => p.ok).length, probes }); }));
app.get("/api/screener", wrap(async (_, res) => { res.set("cache-control", "public, max-age=5"); res.json(await getScreener(state.tip)); }));
app.get("/api/search", wrap(async (req, res) => res.json(await searchTokens(String(req.query.q || "")))));
app.get("/api/feed", wrap(async (req, res) => res.json(await getFeed(Math.min(200, Number(req.query.limit) || 50)))));
app.get("/api/token/:addr", wrap(async (req, res) => { if (!ADDR.test(req.params.addr)) return res.status(400).json({ error: "bad address" }); const d = await getTokenDetail(req.params.addr);
  if (d) return res.json(d);
  const e = await explorerToken(req.params.addr);
  if (e) return res.json({ token: e, pools: [], row: null, trades: [], similar: [], unindexed: true });
  res.status(404).json({ error: "not found" }); }));
app.get("/api/candles/:addr", wrap(async (req, res) => { if (!ADDR.test(req.params.addr)) return res.status(400).json({ error: "bad address" }); res.json(await getCandles(req.params.addr, String(req.query.tf || "5m"))); }));
app.get("/api/holders/:addr", wrap(async (req, res) => { if (!ADDR.test(req.params.addr)) return res.status(400).json({ error: "bad address" }); res.set("cache-control", "public, max-age=120"); res.json(await getHolders(req.params.addr)); }));

const pub = path.join(__dirname, "..", "public");
// HTML always fresh so deploys show up on a normal reload; CSS/JS cached briefly.
app.use(express.static(pub, { extensions: ["html"], setHeaders: (res, file) => res.set("cache-control", file.endsWith(".html") ? "no-cache" : "public, max-age=300") }));
app.get("/token/:addr", (_, res) => { res.set("cache-control", "no-cache"); res.sendFile(path.join(pub, "token.html")); });
app.use((_, res) => res.status(404).send("not found"));

const port = Number(process.env.PORT || 3000);
await init();
app.listen(port, () => console.log(`[http] listening on ${port}`));
// NO_INDEXER runs the API alone against an existing database, which is what the test harness uses.
if (process.env.NO_INDEXER === "1") {
  const { init } = await import("./db.js");
  await init();
} else {
  start().catch((e) => { console.error("[fatal]", e); process.exit(1); });
}
process.on("unhandledRejection", (e) => console.log("[unhandled]", e?.message || e));
