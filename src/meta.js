// Token logo and socials resolution, three sources in order:
//   1. Mobula metadata API (optional, MOBULA_API_KEY) - covers every launchpad Mobula indexes on Arc
//   2. Launchpad "TokenLaunched" events (DYOR style factories) read from the explorer, giving a metadataURI
//   3. Functions on the token contract itself (imageUrl, image, metadata, metadataURI, tokenURI, contractURI)
// Whatever is found is normalised to { logo, website, twitter, telegram, description }.
import { decodeAbiParameters, toEventSelector } from "viem";
import { client, rawLogs, lower } from "./chain.js";
import { EXPLORER, CHAIN_ID } from "./config.js";
import { tokenInfo as expToken } from "./explorer.js";

const MOBULA_KEY = process.env.MOBULA_API_KEY || "";
const IPFS = (u) => (u.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${u.slice(7).replace(/^ipfs\//, "")}` : u.startsWith("ar://") ? `https://arweave.net/${u.slice(5)}` : u);
const isUrl = (s) => /^(https?:\/\/|ipfs:\/\/|ar:\/\/|data:)/i.test(s || "");
const empty = () => ({ logo: "", website: "", twitter: "", telegram: "", description: "" });
const fill = (a, b) => { for (const k of Object.keys(a)) if (!a[k] && b[k]) a[k] = String(b[k]).slice(0, 500); return a; };
const merged = (o) => Object.values(o).some(Boolean);

async function getJson(url, ms = 8000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`http ${r.status}`);
  return r.json();
}

// Accepts a metadata URI or inline JSON and extracts standard fields.
async function fromMetadata(raw) {
  const out = empty();
  if (!raw) return out;
  let j = null;
  const s = String(raw).trim();
  if (s.startsWith("{")) { try { j = JSON.parse(s); } catch {} }
  else if (s.startsWith("data:application/json;base64,")) { try { j = JSON.parse(Buffer.from(s.split(",")[1], "base64").toString("utf8")); } catch {} }
  else if (isUrl(s)) {
    if (/\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(s)) { out.logo = IPFS(s); return out; }
    try { j = await getJson(IPFS(s)); } catch { out.logo = IPFS(s); return out; } // not JSON, treat as the image
  }
  if (!j || typeof j !== "object") return out;
  const img = j.image || j.image_url || j.imageUrl || j.logo || j.icon || j.imageURI || "";
  if (img) out.logo = IPFS(String(img));
  const soc = j.socials || j.links || j.extensions || {};
  out.website = j.website || j.web || soc.website || soc.web || "";
  out.twitter = j.twitter || j.x || soc.twitter || soc.x || "";
  out.telegram = j.telegram || j.tg || soc.telegram || soc.tg || "";
  out.description = j.description || "";
  return out;
}

// 0. DYOR Fun's public developer API for Arc (the launchpad's own metadata, no key, CORS open).
//    Arc has its own indexer; we try the chain-pinned prefixes first and accept the first hit.
export const DYOR_API = process.env.DYOR_API || "https://arc-api-production-ef9c.up.railway.app";
const DYOR_ICON = "https://dyorv3.org/logo-v3.png";
async function fromDyor(addr) {
  const out = empty();
  for (const path of [`/api/arc/v1/tokens/${addr}`, `/api/v1/tokens/${addr}?chain=arc`, `/api/v1/tokens/${addr}`]) {
    try {
      const j = await getJson(`${DYOR_API}${path}`, 6000);
      const t = j?.token ? j : j?.data;
      if (!t || (t.token && String(t.token).toLowerCase() !== addr)) continue;
      let img = t.image || "";
      if (img && img.startsWith("/")) img = DYOR_API + img;
      fill(out, { logo: img, description: t.description, website: t.website, twitter: t.x || t.twitter, telegram: t.telegram });
      out.launchpad = "dyor";
      return out;
    } catch {}
  }
  return out;
}
// DYOR factory addresses on Arc, for naming the launchpad badge without waiting for explorer verification.
export async function dyorFactories() {
  for (const path of ["/api/arc/v1/integration/config", "/api/v1/integration/config?chain=arc", "/api/v1/integration/config"]) {
    try {
      const j = await getJson(`${DYOR_API}${path}`, 6000);
      const found = [];
      const walk = (o, depth = 0) => { if (!o || depth > 4) return; if (typeof o === "string" && /^0x[0-9a-fA-F]{40}$/.test(o)) found.push(o.toLowerCase()); else if (typeof o === "object") for (const [k, v] of Object.entries(o)) if (/factory/i.test(k) || typeof v === "object") walk(v, depth + 1); };
      walk(j);
      if (found.length) return { addresses: [...new Set(found)], icon: DYOR_ICON };
    } catch {}
  }
  return { addresses: [], icon: DYOR_ICON };
}

// 1. Mobula
async function fromMobula(addr) {
  if (!MOBULA_KEY) return empty();
  const out = empty();
  for (const chain of [String(CHAIN_ID), "arc"]) {
    try {
      const r = await fetch(`https://api.mobula.io/api/1/metadata?asset=${addr}&blockchain=${chain}`, { signal: AbortSignal.timeout(8000), headers: { Authorization: MOBULA_KEY, accept: "application/json" } });
      if (r.status === 429) { await new Promise((x) => setTimeout(x, 2000)); continue; }
      if (!r.ok) continue;
      const j = await r.json(); const d = j?.data || j;
      if (!d) continue;
      fill(out, { logo: d.logo || d.image, website: d.website, twitter: d.twitter, telegram: d.telegram, description: d.description });
      if (merged(out)) return out;
    } catch {}
  }
  return out;
}

// 2. DYOR style TokenLaunched events, whole chain via explorer, refreshed hourly
const launchedSig = "TokenLaunched(address,address,address,address,address,uint256,uint256,uint256,string,address)";
const launchedTopic = toEventSelector(`event ${launchedSig}`);
const launchedTypes = [
  { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" },
  { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "string" }, { type: "address" },
];
const launchedUris = new Map(); // token -> metadataURI
const launchedBy = new Map();   // token -> launch factory address (log emitter)
let launchedAt = 0;
async function refreshLaunched() {
  if (Date.now() - launchedAt < 3600_000) return;
  launchedAt = Date.now();
  try {
    for (let page = 1; page <= 30; page++) {
      const j = await getJson(`${EXPLORER}/api?module=logs&action=getLogs&fromBlock=0&toBlock=latest&topic0=${launchedTopic}&page=${page}&offset=1000`, 20000);
      if (j.status !== "1" || !Array.isArray(j.result)) break;
      for (const log of j.result) {
        try {
          // non-indexed params: all of them in data
          const d = decodeAbiParameters(launchedTypes, log.data);
          launchedUris.set(String(d[0]).toLowerCase(), d[8]);
          launchedBy.set(String(d[0]).toLowerCase(), String(log.address).toLowerCase());
        } catch {}
      }
      if (j.result.length < 1000) break;
    }
    if (launchedUris.size) console.log(`[meta] launchpad records: ${launchedUris.size}`);
  } catch (e) { console.log("[meta] launched scan failed:", e.message); }
}
async function fromLaunchpad(addr) {
  await refreshLaunched();
  const uri = launchedUris.get(addr);
  return uri ? fromMetadata(uri) : empty();
}

// 3. Creation logs. Whatever launchpad made the token emitted an event when it did, and that event
// almost always carries the metadata URI as a string. We do not need its signature: find the logs that
// mention the token address, then pull any ABI encoded string out of the data and keep the first that
// looks like a URI or inline JSON. Works for launchpads we have never heard of.
function stringsInData(hex) {
  const out = [];
  try {
    const buf = Buffer.from(hex.replace(/^0x/, ""), "hex");
    for (let w = 0; w + 32 <= buf.length; w += 32) {
      const off = Number(BigInt("0x" + buf.subarray(w, w + 32).toString("hex")));
      if (!Number.isSafeInteger(off) || off % 32 !== 0 || off + 32 > buf.length) continue;
      const len = Number(BigInt("0x" + buf.subarray(off, off + 32).toString("hex")));
      if (!Number.isSafeInteger(len) || len < 4 || len > 2048 || off + 32 + len > buf.length) continue;
      const str = buf.subarray(off + 32, off + 32 + len).toString("utf8");
      if (/^[\x20-\x7e\s]+$/.test(str)) out.push(str.trim());
    }
  } catch {}
  return out;
}
// Windows searched around the pool's creation block, nearest first. Each is split to respect the
// 10k block cap that public RPCs put on eth_getLogs, which is why a single wide query found nothing.
// Launch and first pool are usually the same transaction, sometimes hours apart, so the search stays
// near the pool block: at most sixteen getLogs calls per token rather than hundreds.
const CREATION_WINDOWS = [[0, 0], [2_000, 0], [20_000, 2_000]];
const RPC_LOG_SPAN = 9_000;
async function logsChunked(filter, from, to) {
  const out = [];
  for (let cur = from; cur <= to; cur += RPC_LOG_SPAN) {
    const end = Math.min(to, cur + RPC_LOG_SPAN - 1);
    try { out.push(...(await rawLogs(filter, cur, end))); } catch {}
  }
  return out;
}
async function fromCreationLogs(addr, hintBlock, birthBlock = 0) {
  const topic = `0x${"0".repeat(24)}${addr.slice(2)}`;
  const filters = [{ topics: [null, topic] }, { topics: [null, null, topic] }, { topics: [null, null, null, topic] }, { address: addr }];
  // The deployment block itself, where the launchpad's own event sits. One call, and it is exact.
  if (birthBlock) {
    for (const filter of [{}, ...filters]) {
      let logs = [];
      try { logs = await rawLogs(filter, birthBlock, birthBlock); } catch { continue; }
      for (const log of logs) {
        for (const str of stringsInData(log.data || "0x")) {
          if (!isUrl(str) && !str.startsWith("{")) continue;
          const m = await fromMetadata(str);
          if (m.logo || m.description || m.twitter) {
            m.source = lower(log.address); m.topic0 = (log.topics && log.topics[0]) || "";
            learn(m.source, m.topic0).catch(() => {});
            return m;
          }
        }
      }
    }
  }
  if (!hintBlock) return empty();
  for (const [back, skip] of CREATION_WINDOWS) {
    const to = Math.max(0, hintBlock - skip);
    const from = Math.max(0, hintBlock - back);
    for (const filter of filters) {
      const logs = await logsChunked(filter, from, to);
      for (const log of logs.reverse()) {
        for (const str of stringsInData(log.data || "0x")) {
          if (!isUrl(str) && !str.startsWith("{")) continue;
          const m = await fromMetadata(str);
          if (m.logo || m.description || m.twitter) {
            m.source = lower(log.address); m.topic0 = (log.topics && log.topics[0]) || "";
            learn(m.source, m.topic0).catch(() => {});
            return m;
          }
        }
      }
    }
  }
  return empty();
}

// 4. Token contract itself
const strFns = ["imageUrl", "image", "logo", "metadataURI", "metadata", "tokenURI", "contractURI", "uri"];
async function fromContract(addr) {
  for (const fn of strFns) {
    try {
      const v = await client.readContract({ address: addr, abi: [{ type: "function", name: fn, stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }], functionName: fn });
      if (v && String(v).trim()) { const m = await fromMetadata(v); if (merged(m)) return m; }
    } catch {}
  }
  return empty();
}

export async function resolveMeta(addr, hintBlock = 0, birthBlock = 0) {
  const a = addr.toLowerCase();
  const out = empty();
  for (const src of [fromDyor, fromMobula, fromLaunchpad, fromContract, (x) => fromCreationLogs(x, hintBlock, birthBlock)]) {
    try { fill(out, await src(a)); } catch {}
    if (out.logo && out.twitter) break;
  }
  // Last resort for the logo only: explorer icon
  if (!out.logo) {
    try { const j = await expToken(a); if (j?.icon) out.logo = j.icon; } catch {}
  }
  return out;
}
export const mobulaEnabled = Boolean(MOBULA_KEY);
export { stringsInData, fromMetadata };

// A launchpad that gave us one token's metadata will give us every token's, so its event is remembered
// and harvested in bulk by src/harvest.js instead of being rediscovered token by token.
async function learn(emitter, topic0) {
  if (!emitter || !topic0) return;
  const { q } = await import("./db.js");
  await q(`INSERT INTO meta_events (emitter, topic0, cursor_block, done, hits) VALUES ($1,$2,NULL,0,1)
    ON CONFLICT (emitter, topic0) DO UPDATE SET hits = meta_events.hits + 1`, [emitter, topic0]);
}

export async function launchpadOf(addr) { await refreshLaunched(); return launchedBy.get(addr.toLowerCase()) || ""; }

// Diagnostics: what each source returns for one token, so a missing logo can be traced instead of guessed at.
export async function debugMeta(addr) {
  const a = addr.toLowerCase();
  const out = {};
  const run = async (name, fn) => { const t = Date.now(); try { out[name] = { ms: 0, ...(await fn(a)) }; out[name].ms = Date.now() - t; } catch (e) { out[name] = { error: e.message, ms: Date.now() - t }; } };
  await run("dyor", fromDyor);
  await run("mobula", fromMobula);
  await run("launchpad", fromLaunchpad);
  await run("contract", fromContract);
  let hint = 0;
  try { const { q } = await import("./db.js"); const r = await q("SELECT MAX(created_block) AS b FROM pools WHERE token = $1", [a]); hint = Number(r[0]?.b || 0); } catch {}
  out.hintBlock = hint;
  let birth = 0;
  try { const { q } = await import("./db.js"); const r = await q("SELECT birth_block AS b FROM tokens WHERE address = $1", [a]); birth = Number(r[0]?.b || 0); } catch {}
  out.birthBlock = birth;
  await run("creationLogs", (x) => fromCreationLogs(x, hint, birth));
  try { const j = await expToken(a); out.explorer = { logo: j?.icon || "", name: j?.name || "" }; } catch (e) { out.explorer = { error: e.message }; }
  out.launchpadRecords = launchedUris.size;
  out.dyorApi = DYOR_API;
  return out;
}
