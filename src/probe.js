// Launchpad API discovery. We cannot know each site's endpoint in advance, so the server finds it:
// for a domain it tries the paths these sites conventionally use, looks for a JSON array whose rows
// carry a 0x address, and accepts the endpoint only when several of those addresses are tokens we
// already indexed on Arc. That last check is what stops another chain's data, or a random API, from
// being trusted. A working endpoint and its field mapping are stored and reused.
import { q as query } from "./db.js";

const PATHS = [
  "/api/tokens?limit=100", "/api/v1/tokens?limit=100", "/api/arc/v1/tokens?limit=100",
  "/api/tokens/list?limit=100", "/api/coins?limit=100", "/api/launches?limit=100",
  "/api/token/list?limit=100", "/api/trending?limit=100", "/api/all-tokens", "/tokens.json",
  "/api/tokens", "/api/v1/tokens", "/api/coins", "/api/launches", "/api/pairs?limit=100",
];
const HOSTS = (domain) => [`https://api.${domain}`, `https://${domain}`, `https://backend.${domain}`, `https://server.${domain}`];

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const IMG_KEYS = ["image", "imageUrl", "image_url", "logo", "icon", "logoUrl", "avatar", "img", "picture", "imageURI"];
const ADDR_KEYS = ["token", "address", "tokenAddress", "token_address", "contract", "contractAddress", "mint", "ca"];
const SYM_KEYS = ["symbol", "ticker", "tokenSymbol"];

function findArray(j, depth = 0) {
  if (Array.isArray(j)) return j.length && typeof j[0] === "object" ? j : null;
  if (!j || typeof j !== "object" || depth > 3) return null;
  for (const v of Object.values(j)) { const r = findArray(v, depth + 1); if (r) return r; }
  return null;
}
const pick = (row, keys) => { for (const k of keys) if (row[k] != null && row[k] !== "") return String(row[k]); return ""; };
function mapRow(row, base) {
  const address = pick(row, ADDR_KEYS).toLowerCase();
  let logo = pick(row, IMG_KEYS);
  if (logo.startsWith("/")) logo = base + logo;
  return {
    address: ADDR.test(address) ? address : "",
    logo, symbol: pick(row, SYM_KEYS),
    website: pick(row, ["website", "web", "site", "url"]),
    twitter: pick(row, ["twitter", "x", "twitterUrl", "x_url"]),
    telegram: pick(row, ["telegram", "tg", "telegramUrl"]),
    description: pick(row, ["description", "desc", "about"]),
    factory: pick(row, ["factory", "factoryAddress", "launchpad", "pool_factory"]).toLowerCase(),
  };
}

async function tryUrl(url, ms = 9000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: "application/json", "user-agent": "talons-scan/1.0" } });
  if (!r.ok) throw new Error(`http ${r.status}`);
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("json")) throw new Error("not json");
  return r.json();
}

// Try one domain until a path answers with rows that match tokens we know are on Arc.
export async function probeDomain(domain, label = "") {
  for (const host of HOSTS(domain)) {
    for (const path of PATHS) {
      let j;
      try { j = await tryUrl(host + path); } catch { continue; }
      const arr = findArray(j);
      if (!arr || arr.length < 2) continue;
      const mapped = arr.map((r) => mapRow(r, host)).filter((m) => m.address);
      if (mapped.length < 2) continue;
      const addrs = mapped.map((m) => m.address).slice(0, 100);
      const known = await query("SELECT address FROM tokens WHERE address = ANY($1)", [addrs]);
      const hit = known.length;
      if (hit < 2) continue;                       // rows exist but they are not our chain's tokens
      const withLogo = mapped.filter((m) => m.logo).length;
      return { domain, label: label || domain, host, path, rows: mapped.length, matched: hit, withLogo, sample: mapped.slice(0, 2) };
    }
  }
  return null;
}

// Domains seen on the launchpad filter of other Arc screeners. Discovery is automatic; a domain that
// does not answer is skipped and retried later, and none of these are screeners themselves.
export const DOMAINS = [
  ["dyor.fun", "DYOR"], ["tollylabs.com", "Tolly"], ["sharc.fun", "Sharc"], ["dagg.fun", "Dagg.fun"], ["warp.fun", "Warp"],
  ["klik.fun", "Klik"], ["pegd.fun", "PEGD"], ["arcpad.meme", "ArcPad"], ["arcfun.io", "ArcFun"],
  ["tolly.fun", "Tolly"], ["ayoo.fun", "Ayoo"], ["cambo.fun", "Cambo"], ["archemist.fun", "Archemist"],
  ["cusp.fun", "Cusp"], ["actfun.io", "ACTFUN"], ["pump.archi", "PUMP.archi"], ["basedpad.fun", "basedpad"],
  ["argus.fun", "Argus"], ["noxa.fun", "Noxa"], ["arcorigin.fun", "ArcOrigin"],
];

export async function probeAllDomains() {
  const found = [];
  for (const [domain, label] of DOMAINS) {
    const r = await probeDomain(domain, label).catch(() => null);
    if (r) {
      found.push(r);
      await query(`INSERT INTO lp_endpoints (domain, label, host, path, matched, checked) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (domain) DO UPDATE SET label = $2, host = $3, path = $4, matched = $5, checked = $6`,
        [r.domain, r.label, r.host, r.path, r.matched, Date.now()]);
      console.log(`[probe] ${domain}: ${r.host}${r.path} matched ${r.matched} of our tokens, ${r.withLogo} with logos`);
    }
  }
  return found;
}

// Pull metadata from every endpoint discovered so far.
export async function syncDiscovered(state) {
  const eps = await query("SELECT domain, label, host, path FROM lp_endpoints");
  let total = 0;
  for (const ep of eps) {
    let j;
    try { j = await tryUrl(ep.host + ep.path, 12000); } catch { continue; }
    const arr = findArray(j) || [];
    let updated = 0;
    for (const row of arr) {
      const m = mapRow(row, ep.host);
      if (!m.address || (!m.logo && !m.twitter && !m.description)) continue;
      const known = await query("SELECT 1 FROM tokens WHERE address = $1", [m.address]);
      if (!known.length) continue;
      await query(`UPDATE tokens SET logo = COALESCE(NULLIF($1,''), logo), website = COALESCE(NULLIF($2,''), website),
        twitter = COALESCE(NULLIF($3,''), twitter), telegram = COALESCE(NULLIF($4,''), telegram),
        description = COALESCE(NULLIF($5,''), description), meta_checked = $6 WHERE address = $7`,
        [m.logo, m.website, m.twitter, m.telegram, m.description, Date.now(), m.address]);
      const tok = state?.tokens?.get(m.address);
      if (tok && m.logo) tok.logo = m.logo;
      updated++;
    }
    total += updated;
    if (updated) console.log(`[probe] ${ep.domain}: ${updated} tokens updated`);
  }
  return total;
}
