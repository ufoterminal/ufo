// Explorer access with failover. Blockscout is tried first, then Arcscan's own REST API
// (api.arc-scan.org, no key, chain 5042 indexed from genesis). A provider that fails is
// skipped for a while so a downed explorer does not slow every call.
import { EXPLORER } from "./config.js";

const UA = "talons-scan/1.0";
export const ARCSCAN = process.env.ARCSCAN_API || "https://api.arc-scan.org";
const down = new Map(); // base -> retry after ts

async function get(base, path, ms = 8000) {
  if ((down.get(base) || 0) > Date.now()) throw new Error("provider down");
  try {
    const r = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(ms), headers: { accept: "application/json", "user-agent": UA } });
    if (!r.ok) throw new Error(`http ${r.status}`);
    return await r.json();
  } catch (e) {
    if (/timeout|fetch failed|abort|http 5\d\d|down/i.test(e.message)) down.set(base, Date.now() + 120_000);
    throw e;
  }
}
const num = (v) => (v == null || v === "" ? null : Number(v));
const pick = (o, ...keys) => { for (const k of keys) { const v = k.split(".").reduce((x, p) => (x == null ? x : x[p]), o); if (v != null && v !== "") return v; } return null; };

// { name, symbol, decimals, total_supply, holders, icon } or null
export async function tokenInfo(addr) {
  try {
    const j = await get(EXPLORER, `/api/v2/tokens/${addr}`);
    return { name: j.name || "", symbol: j.symbol || "", decimals: num(j.decimals) ?? 18, total_supply: String(j.total_supply || "0"), holders: num(j.holders), icon: j.icon_url || "" };
  } catch {}
  try {
    const j = await get(ARCSCAN, `/v1/tokens/${addr}`);
    const t = j?.token || j?.data || j;
    if (!t || (!t.symbol && !t.name && !t.total_supply)) return null;
    return { name: pick(t, "name") || "", symbol: pick(t, "symbol") || "", decimals: num(pick(t, "decimals")) ?? 18,
      total_supply: String(pick(t, "total_supply", "totalSupply", "supply") || "0"), holders: num(pick(t, "holders", "holder_count", "holderCount")), icon: "" };
  } catch {}
  return null;
}

// { creator, is_contract, name }
export async function addressInfo(addr) {
  try {
    const j = await get(EXPLORER, `/api/v2/addresses/${addr}`);
    return { creator: String(j.creator_address_hash || "").toLowerCase(), is_contract: Boolean(j.is_contract), name: j.name || j.implementation_name || "" };
  } catch {}
  try {
    const j = await get(ARCSCAN, `/v1/address/${addr}/contract`);
    const c = j?.contract || j?.data || j;
    return { creator: String(pick(c, "creator", "creator_address", "deployer") || "").toLowerCase(), is_contract: Boolean(pick(c, "is_contract", "bytecode", "code")), name: pick(c, "name", "label") || "" };
  } catch {}
  return { creator: "", is_contract: false, name: "" };
}

// [{ address, value }] ranked by balance
export async function holders(addr, limit = 50) {
  try {
    const j = await get(EXPLORER, `/api/v2/tokens/${addr}/holders`);
    if (Array.isArray(j?.items)) return j.items.slice(0, limit).map((h) => ({ address: String(h.address?.hash || "").toLowerCase(), value: Number(h.value || 0) }));
  } catch {}
  try {
    const j = await get(ARCSCAN, `/v1/tokens/${addr}/holders?limit=${limit}`);
    const arr = j?.holders || j?.items || j?.data || [];
    if (Array.isArray(arr)) return arr.slice(0, limit).map((h) => ({ address: String(pick(h, "address", "holder", "account") || "").toLowerCase(), value: Number(pick(h, "balance", "value", "amount") || 0) }));
  } catch {}
  return [];
}

// [{ address, name, symbol, icon }]
export async function searchExplorer(term) {
  try {
    const j = await get(EXPLORER, `/api/v2/search?q=${encodeURIComponent(term)}`, 6000);
    const items = (j.items || []).filter((i) => i.type === "token" && i.address);
    if (items.length) return items.map((i) => ({ address: String(i.address).toLowerCase(), name: i.name || "", symbol: i.symbol || "", icon: i.icon_url || "" }));
  } catch {}
  try {
    const j = await get(ARCSCAN, `/v1/search?q=${encodeURIComponent(term)}`, 6000);
    const items = j?.results || j?.items || j?.data || [];
    return (Array.isArray(items) ? items : []).filter((i) => /token/i.test(String(i.type || "")) && (i.address || i.hash))
      .map((i) => ({ address: String(i.address || i.hash).toLowerCase(), name: i.name || "", symbol: i.symbol || "", icon: "" }));
  } catch {}
  return [];
}
