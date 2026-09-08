// Walks every registered launchpad API and writes what it says about tokens we already index.
// Nothing is inserted that we have not seen trade on chain, so a bad upstream cannot invent rows.
import { q as query } from "./db.js";
import { LAUNCHPADS } from "./launchpads.js";

async function getJson(url, ms = 12000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`http ${r.status}`);
  return r.json();
}

async function syncOne(lp, state) {
  let path = null, first = null;
  for (const p of lp.list) {
    try {
      const j = await getJson(lp.base + p.replace("{cursor}", ""));
      const items = lp.items(j).filter((row) => lp.verify(row, j));
      if (items.length) { path = p; first = { items, cursor: lp.nextCursor(j), raw: j }; break; }
    } catch {}
  }
  if (!path) return { id: lp.id, ok: false, reason: "no Arc list route answered" };

  const factories = new Set();
  let cursor = first.cursor, batch = first.items, seen = 0, updated = 0, guard = 0;
  while (batch && guard++ < 80) {
    for (const row of batch) {
      const m = lp.map(row, lp.base);
      if (!/^0x[0-9a-f]{40}$/.test(m.address)) continue;
      seen++;
      if (m.factory) factories.add(m.factory);
      const known = await query("SELECT 1 FROM tokens WHERE address = $1", [m.address]);
      if (!known.length) continue;
      await query(`UPDATE tokens SET logo = COALESCE(NULLIF($1,''), logo), website = COALESCE(NULLIF($2,''), website),
        twitter = COALESCE(NULLIF($3,''), twitter), telegram = COALESCE(NULLIF($4,''), telegram),
        description = COALESCE(NULLIF($5,''), description), launchpad = COALESCE(NULLIF($6,''), launchpad), meta_checked = $7 WHERE address = $8`,
        [m.logo, m.website, m.twitter, m.telegram, m.description, m.factory, Date.now(), m.address]);
      const tok = state?.tokens?.get(m.address);
      if (tok && m.logo) tok.logo = m.logo;
      updated++;
    }
    if (!cursor) break;
    try {
      const j = await getJson(lp.base + path.replace("{cursor}", lp.cursorParam + cursor));
      batch = lp.items(j).filter((row) => lp.verify(row, j));
      cursor = lp.nextCursor(j);
    } catch { break; }
    await new Promise((r) => setTimeout(r, 200));
  }
  for (const f of factories) {
    await query(`INSERT INTO sources (address, kind, name, label, icon, checked) VALUES ($1,'launchpad',$2,$2,$3,$4)
      ON CONFLICT (address) DO UPDATE SET label = $2, icon = $3, kind = 'launchpad'`, [f, lp.label, lp.icon || "", Date.now()]).catch(() => {});
  }
  return { id: lp.id, ok: true, path, seen, updated, factories: [...factories] };
}

export async function syncLaunchpads(state) {
  const out = [];
  for (const lp of LAUNCHPADS) {
    try { out.push(await syncOne(lp, state)); }
    catch (e) { out.push({ id: lp.id, ok: false, reason: e.message }); }
  }
  for (const r of out) console.log(`[sync] ${r.id}: ${r.ok ? `${r.updated}/${r.seen} updated, factories ${r.factories.join(",") || "none"}` : r.reason}`);
  return out;
}
