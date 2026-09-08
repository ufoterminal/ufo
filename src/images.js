// Token logos are arbitrary URLs chosen by whoever launched the token: image hosts, IPFS gateways,
// a project's own domain. Hotlinking them means every broken host, expired certificate, blocked
// gateway or corporate TLS filter shows up as a missing logo. So each image is fetched once, stored,
// and served from our own domain instead.
import { q as query } from "./db.js";
import { DOMAINS } from "./probe.js";
import { logoHostForGroup } from "./codehash.js";

const MAX_BYTES = 512 * 1024;
const OK_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml", "image/avif"];
const GATEWAYS = ["https://ipfs.io/ipfs/", "https://cloudflare-ipfs.com/ipfs/", "https://gateway.pinata.cloud/ipfs/"];

// Every address worth trying for one logo URL, IPFS included, in order of likelihood.
function candidates(url) {
  const out = [];
  if (!url) return out;
  const u = String(url).trim();
  if (u.startsWith("ipfs://")) {
    const cid = u.slice(7).replace(/^ipfs\//, "");
    for (const g of GATEWAYS) out.push(g + cid);
  } else if (u.startsWith("ar://")) {
    out.push("https://arweave.net/" + u.slice(5));
  } else if (/^https?:\/\//i.test(u)) {
    out.push(u);
    const m = u.match(/\/ipfs\/([^/?#]+)(.*)$/);       // a gateway that is down can be swapped for another
    if (m) for (const g of GATEWAYS) { const alt = g + m[1] + (m[2] || ""); if (alt !== u) out.push(alt); }
  }
  return out;
}

async function download(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(9000), headers: { "user-agent": "talons-scan/1.0", accept: "image/*" } });
  if (!r.ok) throw new Error(`http ${r.status}`);
  const ctype = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!OK_TYPES.includes(ctype)) throw new Error(`type ${ctype || "unknown"}`);
  const len = Number(r.headers.get("content-length") || 0);
  if (len > MAX_BYTES) throw new Error("too large");
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length || buf.length > MAX_BYTES) throw new Error("bad size");
  return { ctype, buf };
}

// Store one token's logo. Returns true when bytes were saved.
export async function cacheImage(address, url) {
  for (const c of candidates(url)) {
    try {
      const { ctype, buf } = await download(c);
      await query(`INSERT INTO token_images (address, ctype, bytes, src, fetched) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (address) DO UPDATE SET ctype = $2, bytes = $3, src = $4, fetched = $5`, [address, ctype, buf, c, Date.now()]);
      return true;
    } catch {}
  }
  return false;
}

// Launchpads serve a token's picture at a predictable address, for example
// api.tollylabs.com/token-image/0xabc....png, so a logo can be found without any list endpoint at all.
// Patterns that work are remembered and tried first, which keeps this to a couple of requests per token.
const PATTERNS = [
  "https://api.{d}/token-image/{a}.png",
  "https://api.{d}/token-image/{a}",
  "https://{d}/token-image/{a}.png",
  "https://api.{d}/image/{a}.png",
  "https://api.{d}/images/{a}.png",
  "https://{d}/images/{a}.png",
  "https://{d}/api/image/{a}",
  "https://cdn.{d}/tokens/{a}.png",
  "https://{d}/tokens/{a}.png",
  "https://api.{d}/token/{a}/image",
];

function guessUrls(address) {
  const out = [];
  for (const [domain] of DOMAINS) for (const p of PATTERNS) out.push({ url: p.replace("{d}", domain).replace("{a}", address), pattern: p.replace("{a}", "{a}").replace("{d}", domain) });
  return out;
}

// Try the conventional locations. Learned patterns come first, so the usual case is one request.
export async function findByConvention(address) {
  // A sibling deployed from the same template usually has its picture on the same host, so that host
  // is tried before anything else.
  const siblings = await logoHostForGroup(address).catch(() => []);
  for (const src of siblings) {
    const guess = src.replace(/0x[0-9a-fA-F]{40}/, address);
    if (guess === src) continue;
    try {
      const { ctype, buf } = await download(guess);
      await query(`INSERT INTO token_images (address, ctype, bytes, src, fetched) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (address) DO UPDATE SET ctype = $2, bytes = $3, src = $4, fetched = $5`, [address, ctype, buf, guess, Date.now()]);
      await query("UPDATE tokens SET logo = COALESCE(NULLIF(logo,''), $1) WHERE address = $2", [guess, address]);
      console.log(`[images] sibling host hit ${address} <- ${guess}`);
      return guess;
    } catch {}
  }
  const learned = await query("SELECT pattern FROM image_patterns ORDER BY hits DESC, last_hit DESC LIMIT 12").catch(() => []);
  const known = new Set(learned.map((r) => r.pattern));
  const all = guessUrls(address);
  const ordered = [...all.filter((c) => known.has(c.pattern)), ...all.filter((c) => !known.has(c.pattern))];
  for (const c of ordered) {
    try {
      const { ctype, buf } = await download(c.url);
      await query(`INSERT INTO token_images (address, ctype, bytes, src, fetched) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (address) DO UPDATE SET ctype = $2, bytes = $3, src = $4, fetched = $5`, [address, ctype, buf, c.url, Date.now()]);
      await query(`INSERT INTO image_patterns (pattern, hits, last_hit) VALUES ($1,1,$2)
        ON CONFLICT (pattern) DO UPDATE SET hits = image_patterns.hits + 1, last_hit = $2`, [c.pattern, Date.now()]);
      await query("UPDATE tokens SET logo = COALESCE(NULLIF(logo,''), $1) WHERE address = $2", [c.url, address]);
      console.log(`[images] convention hit ${address} <- ${c.url}`);
      return c.url;
    } catch {}
  }
  return "";
}

export async function getImage(address) {
  const rows = await query("SELECT ctype, bytes FROM token_images WHERE address = $1", [address]);
  return rows[0] || null;
}

// Fill the cache for tokens that have a logo URL but no stored bytes yet, newest and deepest first.
export async function cacheImages(limit = 15) {
  // First the tokens that already have a URL, then the ones with no URL at all, which get the
  // conventional launchpad locations tried for them.
  const withUrl = await query(`SELECT t.address, t.logo FROM tokens t
    LEFT JOIN token_images i ON i.address = t.address
    JOIN pools p ON p.token = t.address
    WHERE COALESCE(t.logo, '') <> '' AND i.address IS NULL
    GROUP BY t.address, t.logo ORDER BY MAX(p.liquidity_usd) DESC NULLS LAST LIMIT $1`, [limit]);
  let ok = 0;
  for (const r of withUrl) { if (await cacheImage(r.address, r.logo)) ok++; await new Promise((x) => setTimeout(x, 80)); }

  const noUrl = await query(`SELECT t.address FROM tokens t
    LEFT JOIN token_images i ON i.address = t.address
    JOIN pools p ON p.token = t.address
    WHERE COALESCE(t.logo, '') = '' AND i.address IS NULL AND p.liquidity_usd > 0
    GROUP BY t.address ORDER BY MAX(p.liquidity_usd) DESC NULLS LAST LIMIT $1`, [Math.ceil(limit / 2)]);
  let found = 0;
  for (const r of noUrl) { if (await findByConvention(r.address)) found++; await new Promise((x) => setTimeout(x, 80)); }

  if (withUrl.length || noUrl.length) console.log(`[images] cached ${ok}/${withUrl.length}, found by convention ${found}/${noUrl.length}`);
  return ok + found;
}
