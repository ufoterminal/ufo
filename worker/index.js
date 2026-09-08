// Talons Pads: a screener for tokens launched on Arc's launchpads, assembled entirely from those
// launchpads' own public APIs. There is no indexer and no database: this Worker fetches each source,
// normalises the rows into one shape, caches the result for a minute, and serves it.
//
// Why a Worker at all, when the page could fetch the launchpads directly: browsers block cross origin
// reads unless a site opts in, and most of these do not. The Worker also means one cached fetch serves
// every visitor instead of each visitor hammering the launchpads.
import { SOURCES, DISCOVER_PATHS, normalise, ownsRow } from "./sources.js";

const TTL = 60;
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": `public, max-age=${TTL}`,
    ...extra,
  },
});

async function getJson(url, ms = 9000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: "application/json", "user-agent": "talons-pads/1.0" }, cf: { cacheTtl: 30, cacheEverything: true } });
  if (!r.ok) throw new Error(`http ${r.status}`);
  return r.json();
}

// Find a launchpad's token list when it has not been written down yet: try the conventional paths on
// its likely hosts and keep the first that answers with rows carrying token addresses. The answer is
// remembered at the edge for six hours so this costs almost nothing after the first request.
async function discover(src, request) {
  if (!src.discover) return src.list;
  const key = `https://discover.local/${src.id}`;
  const cache = caches.default;
  const hit = await cache.match(new Request(key));
  if (hit) { const j = await hit.json(); return j.list || []; }

  let found = [];
  outer:
  for (const host of src.hosts || [src.base]) {
    for (const path of DISCOVER_PATHS) {
      try {
        const j = await getJson(host + path, 6000);
        const items = src.items(j) || [];
        const usable = items.filter((row) => normalise(row, { ...src, base: host }));
        if (usable.length >= 2) { src.base = host; found = [path]; break outer; }
      } catch {}
    }
  }
  await cache.put(new Request(key), new Response(JSON.stringify({ list: found, base: src.base }), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=21600" },
  }));
  return found;
}

// Read one launchpad, following its paging until it runs out or the page budget is spent.
async function readSource(src, budget = 5) {
  const paths = src.list && src.list.length ? src.list : await discover(src).catch(() => []);
  for (const path of paths) {
    let cursor = null, pages = 0, rows = [], worked = false;
    while (pages++ < budget) {
      const url = src.base + path.replace("{cursor}", cursor && src.cursorParam ? src.cursorParam + cursor : "");
      let j;
      try { j = await getJson(url); } catch { break; }
      // Two filters: the row must be on Arc, and it must actually be this launchpad's own launch.
      const items = (src.items(j) || []).filter((row) => src.verify(row, j) && ownsRow(row, src));
      if (!items.length && !rows.length) break;
      worked = true;
      for (const row of items) { const n = normalise(row, src); if (n) rows.push(n); }
      cursor = src.next(j);
      if (!cursor || !src.cursorParam) break;
    }
    if (worked && rows.length) return { id: src.id, label: src.label, ok: true, path, rows };
  }
  return { id: src.id, label: src.label, ok: false, rows: [], discovered: paths.length > 0 };
}

// All launchpads at once. One slow source cannot hold up the rest.
async function readAll() {
  const results = await Promise.all(SOURCES.map((s) => readSource(s).catch(() => ({ id: s.id, label: s.label, ok: false, rows: [] }))));
  const seen = new Map();
  for (const r of results) {
    for (const row of r.rows) {
      const prev = seen.get(row.token);
      // A token listed by two launchpads keeps the entry with the most filled in.
      if (!prev || score(row) > score(prev)) seen.set(row.token, row);
    }
  }
  const rows = [...seen.values()];
  rows.sort((a, b) => (b.vol24h ?? -1) - (a.vol24h ?? -1) || (b.liquidity ?? -1) - (a.liquidity ?? -1));
  return {
    rows,
    sources: results.map((r) => ({ id: r.id, label: r.label, ok: r.ok, tokens: r.rows.length })),
    updated: Math.floor(Date.now() / 1000),
    totals: {
      tokens: rows.length,
      vol24h: rows.reduce((s, r) => s + (r.vol24h || 0), 0),
      liquidity: rows.reduce((s, r) => s + (r.liquidity || 0), 0),
      txns24h: rows.reduce((s, r) => s + (r.txns24h || 0), 0),
    },
  };
}
const score = (r) => [r.price, r.vol24h, r.liquidity, r.logo, r.holders].filter((v) => v != null && v !== "" && v !== 0).length;

// Cached at the edge, so a burst of visitors costs one round of upstream requests.
async function cached(request, key, build) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(key, request.url).toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const res = build instanceof Promise ? await build : await build();
  await cache.put(cacheKey, res.clone());
  return res;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,OPTIONS" } });

    if (url.pathname === "/api/screener") {
      return cached(request, "/api/screener", async () => json(await readAll()));
    }

    if (url.pathname === "/api/token") {
      const addr = (url.searchParams.get("a") || "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(addr)) return json({ error: "bad address" }, 400);
      const all = await readAll();
      const row = all.rows.find((r) => r.token === addr);
      return row ? json({ token: row, updated: all.updated }) : json({ error: "not found on any launchpad we read" }, 404);
    }

    // What each launchpad actually returned, for when a source stops working or a new one is added.
    if (url.pathname === "/api/sources") {
      const all = await readAll();
      return json(all.sources);
    }
    if (url.pathname === "/api/debug") {
      const id = url.searchParams.get("id");
      const src = SOURCES.find((s) => s.id === id) || SOURCES[0];
      const paths = src.list && src.list.length ? src.list : await discover(src).catch(() => []);
      const out = { id: src.id, base: src.base, discovered: !src.list?.length, paths, tried: [] };
      for (const path of paths.length ? paths : DISCOVER_PATHS.slice(0, 4)) {
        const u = src.base + path.replace("{cursor}", "");
        try {
          const j = await getJson(u);
          const items = src.items(j) || [];
          out.tried.push({ url: u, ok: true, items: items.length,
            onArc: items.filter((r) => src.verify(r, j)).length,
            ownLaunches: items.filter((r) => src.verify(r, j) && ownsRow(r, src)).length,
            fields: items[0] ? Object.keys(items[0]) : [], first: items[0] || null });
        } catch (e) { out.tried.push({ url: u, ok: false, error: e.message }); }
      }
      return json(out);
    }

    return json({ error: "not found", routes: ["/api/screener", "/api/token?a=0x..", "/api/sources", "/api/debug?id=dyor"] }, 404);
  },
};
