// Who created a token (launchpad) and which factory created its pools (DEX), with names from the explorer.
import { q as query } from "./db.js";
import { client } from "./chain.js";
import { addressInfo as expAddress } from "./explorer.js";
import { describeSource } from "./sources.js";
import { launchpadOf, dyorFactories } from "./meta.js";

const seen = new Set();
async function getJson(url) { const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } }); if (!r.ok) throw new Error(`http ${r.status}`); return r.json(); }

// Register a source address (factory or launchpad) and name it from the explorer once.
export async function noteSource(address, kind) {
  if (!address) return;
  const a = address.toLowerCase();
  if (seen.has(a)) return; seen.add(a);
  const exists = await query("SELECT 1 FROM sources WHERE address = $1", [a]);
  if (exists.length) return;
  let name = "";
  try { name = (await expAddress(a)).name || ""; } catch {}
  const d = describeSource(a, kind, name);
  await query("INSERT INTO sources (address, kind, name, label, icon, checked) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (address) DO NOTHING",
    [a, d.kind, name, d.label, d.icon, Date.now()]);
  console.log(`[source] ${kind} ${a} ${d.label || "(unverified contract, retried daily)"}`);
}

// Token creator: explorer address info. A contract creator = launchpad. TokenLaunched emitter wins when present.
export async function resolveOrigins(state) {
  const rows = await query(`SELECT t.address FROM tokens t LEFT JOIN pools p ON p.token = t.address WHERE t.origin_checked IS NULL
    GROUP BY t.address ORDER BY MAX(p.created_block) DESC NULLS LAST LIMIT 20`);
  for (const { address } of rows) {
    let creator = "", launchpad = "";
    try { launchpad = await launchpadOf(address); } catch {}
    try {
      creator = (await expAddress(address)).creator || "";
      if (!launchpad && creator) {
        // creator is a contract -> launchpad; an EOA -> plain deploy
        try { if ((await expAddress(creator)).is_contract) launchpad = creator; } catch {}
      }
    } catch {}
    if (launchpad) await noteSource(launchpad, "launchpad").catch(() => {});
    await query("UPDATE tokens SET creator = $1, launchpad = $2, origin_checked = $3 WHERE address = $4", [creator, launchpad, Date.now(), address]);
    const t = state.tokens.get(address); if (t) { t.creator = creator; t.launchpad = launchpad; }
    await new Promise((r) => setTimeout(r, 150));
  }
}

// Pools discovered before the factory column existed: ask the pool contract itself.
export async function backfillFactories(state) {
  const rows = await query("SELECT address FROM pools WHERE factory IS NULL LIMIT 300");
  for (const { address } of rows) {
    try {
      const f = await client.readContract({ address, abi: [{ type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }], functionName: "factory" });
      const fa = String(f).toLowerCase();
      await query("UPDATE pools SET factory = $1 WHERE address = $2", [fa, address]);
      const p = state.pools.get(address); if (p) p.factory = fa;
      await noteSource(fa, "dex").catch(() => {});
    } catch { await query("UPDATE pools SET factory = '' WHERE address = $1", [address]); }
  }
  if (rows.length === 300) setTimeout(() => backfillFactories(state).catch(() => {}), 2000);
}

export async function listSources() {
  return query(`SELECT s.*, 
    (SELECT COUNT(*) FROM pools p WHERE p.factory = s.address) AS pools,
    (SELECT COUNT(*) FROM tokens t WHERE t.launchpad = s.address) AS tokens
    FROM sources s ORDER BY tokens DESC, pools DESC`);
}

// Unverified contracts may get verified later; re-ask the explorer once a day and re-apply patterns and overrides.
export async function refreshSources() {
  const rows = await query("SELECT address, kind, name FROM sources WHERE checked < $1 ORDER BY checked ASC LIMIT 30", [Date.now() - 86400_000]);
  for (const r of rows) {
    let name = r.name;
    try { name = (await expAddress(r.address)).name || name; } catch {}
    const d = describeSource(r.address, r.kind, name);
    await query("UPDATE sources SET name = $1, label = $2, icon = $3, kind = $4, checked = $5 WHERE address = $6", [name, d.label, d.icon, d.kind, Date.now(), r.address]);
    await new Promise((x) => setTimeout(x, 150));
  }
}
// Apply current patterns/overrides to everything already stored (runs at startup so edits to sources.js take effect on deploy).
export async function reapplySources() {
  const rows = await query("SELECT address, kind, name FROM sources");
  for (const r of rows) { const d = describeSource(r.address, r.kind, r.name); await query("UPDATE sources SET label = $1, icon = $2, kind = $3 WHERE address = $4", [d.label, d.icon, d.kind, r.address]); }
}

// Register DYOR's Arc factories as a named launchpad source up front.
export async function seedKnownSources() {
  try {
    const d = await dyorFactories();
    for (const a of d.addresses) {
      await query("INSERT INTO sources (address, kind, name, label, icon, checked) VALUES ($1,'launchpad','DyorLaunchFactory','Dyor.fun',$2,$3) ON CONFLICT (address) DO UPDATE SET label = 'Dyor.fun', icon = $2, kind = 'launchpad'", [a, d.icon, Date.now()]);
      seen.add(a);
    }
    if (d.addresses.length) console.log(`[source] dyor factories: ${d.addresses.join(", ")}`);
  } catch (e) { console.log("[source] dyor seed failed:", e.message); }
}
