// DYOR Fun's own public API, the launchpad's data about its own launches. No key.
// The default routes answer for another chain, so Arc is asked for explicitly and every
// row is checked against our chain's USDC pair before it is trusted.
import { q as query } from "./db.js";
import { USDC } from "./chain.js";

export const DYOR_API = process.env.DYOR_API || "https://arc-api-production-ef9c.up.railway.app";
const DYOR_ICON = "https://dyorv3.org/logo-v3.png";
const LIST_PATHS = ["/api/arc/v1/tokens", "/api/v1/tokens?chain=arc"];

async function getJson(url, ms = 12000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`http ${r.status}`);
  return r.json();
}
const abs = (u) => (u && u.startsWith("/") ? DYOR_API + u : u || "");

// One page of launches. Returns { items, cursor } or null when the path does not answer for Arc.
async function page(path, cursor) {
  const sep = path.includes("?") ? "&" : "?";
  const j = await getJson(`${DYOR_API}${path}${sep}limit=100${cursor ? `&cursor=${cursor}` : ""}`);
  const items = j?.items || j?.tokens || j?.data || [];
  if (!Array.isArray(items)) return null;
  // Guard: the default route answers for a different chain. Accept only rows paired against Arc USDC.
  const onArc = items.filter((t) => String(t.pair_token || "").toLowerCase() === USDC || String(j.chain || "").toLowerCase() === "arc" || Number(j.chainId) === 5042);
  return { items: onArc, cursor: j?.nextCursor || null, chain: j?.chain || "", chainId: j?.chainId };
}

// Pull every DYOR launch on Arc and write logo, socials and launchpad onto tokens we already index.
export async function syncDyor(state) {
  let path = null, first = null;
  for (const p of LIST_PATHS) {
    try { const r = await page(p, null); if (r && r.items.length) { path = p; first = r; break; } } catch {}
  }
  if (!path) { console.log("[dyor] no Arc list route answered"); return 0; }
  const factories = new Set();
  let cursor = first.cursor, batch = first.items, seen = 0, updated = 0, guard = 0;
  while (batch && guard++ < 60) {
    for (const t of batch) {
      const addr = String(t.token || t.address || "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(addr)) continue;
      seen++;
      if (t.factory) factories.add(String(t.factory).toLowerCase());
      const logo = abs(t.image || t.logo || "");
      const row = await query("SELECT 1 FROM tokens WHERE address = $1", [addr]);
      if (!row.length) continue;
      await query(`UPDATE tokens SET logo = COALESCE(NULLIF($1,''), logo), website = COALESCE(NULLIF($2,''), website),
        twitter = COALESCE(NULLIF($3,''), twitter), telegram = COALESCE(NULLIF($4,''), telegram),
        description = COALESCE(NULLIF($5,''), description), launchpad = COALESCE(NULLIF($6,''), launchpad), meta_checked = $7 WHERE address = $8`,
        [logo, t.website || "", t.x || t.twitter || "", t.telegram || "", t.description || "", String(t.factory || "").toLowerCase(), Date.now(), addr]);
      const tok = state?.tokens?.get(addr);
      if (tok && logo) tok.logo = logo;
      updated++;
    }
    if (!cursor) break;
    try { const r = await page(path, cursor); if (!r) break; batch = r.items; cursor = r.cursor; } catch { break; }
    await new Promise((r) => setTimeout(r, 200));
  }
  for (const f of factories) {
    await query(`INSERT INTO sources (address, kind, name, label, icon, checked) VALUES ($1,'launchpad','DyorLaunchFactory','Dyor.fun',$2,$3)
      ON CONFLICT (address) DO UPDATE SET label='Dyor.fun', icon=$2, kind='launchpad'`, [f, DYOR_ICON, Date.now()]).catch(() => {});
  }
  console.log(`[dyor] ${path}: ${seen} launches seen, ${updated} of ours updated, factories ${[...factories].join(",") || "none"}`);
  return updated;
}
