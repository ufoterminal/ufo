// Launchpad registry. Each entry describes one launchpad's own public API: where its token list lives
// and which field means what. Nothing here talks to a competing screener, and no data is invented:
// a launchpad is the authority on the tokens it created.
//
// Adding one is a block of config. Open the launchpad, F12, Network, Fetch/XHR, reload, find the request
// that returns the token list, then fill in:
//   list        the URL, with {cursor} where paging goes (leave it out if the API is not paged)
//   items       where the array sits in the response
//   next        how to read the next cursor, if any
//   map         which field is the address, price, volume and so on
//   verify      something that proves the row belongs to Arc, so another chain cannot leak in
export const USDC = "0x3600000000000000000000000000000000000000";

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const pickKey = (row, keys) => { for (const k of keys) if (row?.[k] != null && row[k] !== "") return row[k]; return null; };

// Field names these APIs tend to use, so a source that follows convention needs almost no mapping.
export const GUESS = {
  address: ["token", "address", "tokenAddress", "token_address", "contract", "contractAddress", "ca", "mint"],
  symbol: ["symbol", "ticker", "tokenSymbol"],
  name: ["name", "tokenName", "title"],
  price: ["price", "priceUsd", "price_usd", "usdPrice", "lastPrice"],
  mcap: ["mcap", "marketCap", "market_cap", "marketCapUsd", "fdv"],
  liquidity: ["liquidityUsdc", "liquidity", "liquidityUsd", "liquidity_usd", "tvl"],
  vol24: ["volume24", "volume24h", "volume_24h", "vol24h", "volumeUsd24h", "v24"],
  txns24: ["txns24", "txns24h", "transactions24h", "trades24h", "tx24"],
  traders24: ["traders24", "traders24h", "uniqueTraders24h", "buyers24h"],
  holders: ["holderCount", "holders", "holder_count"],
  ch5m: ["change5m", "priceChange5m", "change_5m"],
  ch1h: ["change1h", "priceChange1h", "change_1h"],
  ch6h: ["change6h", "priceChange6h", "change_6h"],
  ch24h: ["change24h", "priceChange24h", "change_24h"],
  ageSec: ["ageSec", "age", "age_seconds"],
  createdAt: ["created_at", "createdAt", "deployTs", "deployedAt", "launchedAt", "created"],
  logo: ["icon", "image", "imageUrl", "image_url", "logo", "logoUrl", "avatar", "imageURI"],
  website: ["website", "web", "site", "url"],
  twitter: ["twitter", "x", "twitterUrl", "x_url"],
  telegram: ["telegram", "tg", "telegramUrl"],
  description: ["description", "desc", "about"],
  pool: ["pool", "bestPool", "pairAddress", "pair"],
  graduated: ["graduated", "isGraduated", "migrated"],
  progress: ["progressBps", "progress", "bondingProgress"],
  decimals: ["decimals", "tokenDecimals"],
  supply: ["totalSupply", "total_supply", "supply"],
};

// Turn one launchpad row into the shape the table expects, using its own mapping where given and the
// conventional names otherwise. Missing numbers stay null rather than becoming zero, so the table can
// show "not reported" instead of pretending a token has no volume.
export function normalise(row, src) {
  const g = (field) => {
    const custom = src.map?.[field];
    if (typeof custom === "function") return custom(row, src);
    if (typeof custom === "string") return row?.[custom];
    return pickKey(row, GUESS[field] || []);
  };
  const address = String(g("address") || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) return null;

  let logo = g("logo") || "";
  if (logo && String(logo).startsWith("/")) logo = src.base + logo;
  const created = g("createdAt");
  const ageSec = g("ageSec");
  const createdTs = created ? Math.floor(Number(created) > 1e12 ? Number(created) / 1000 : Number(created))
    : ageSec ? Math.floor(Date.now() / 1000) - num(ageSec) : 0;

  const has = (v) => v != null && v !== "";
  return {
    token: address,
    symbol: String(g("symbol") || "").slice(0, 24),
    name: String(g("name") || "").slice(0, 64),
    logo: String(logo || ""),
    website: String(g("website") || ""), twitter: String(g("twitter") || ""), telegram: String(g("telegram") || ""),
    description: String(g("description") || "").slice(0, 400),
    price: has(g("price")) ? num(g("price")) : null,
    mcap: has(g("mcap")) ? num(g("mcap")) : null,
    liquidity: has(g("liquidity")) ? num(g("liquidity")) : null,
    vol24h: has(g("vol24")) ? num(g("vol24")) : null,
    txns24h: has(g("txns24")) ? num(g("txns24")) : null,
    traders24h: has(g("traders24")) ? num(g("traders24")) : null,
    holders: has(g("holders")) ? num(g("holders")) : null,
    ch5m: has(g("ch5m")) ? num(g("ch5m")) : null,
    ch1h: has(g("ch1h")) ? num(g("ch1h")) : null,
    ch6h: has(g("ch6h")) ? num(g("ch6h")) : null,
    ch24h: has(g("ch24h")) ? num(g("ch24h")) : null,
    createdTs,
    pool: String(g("pool") || ""),
    graduated: g("graduated") === true || g("graduated") === 1,
    progress: has(g("progress")) ? num(g("progress")) : null,
    spark: Array.isArray(row?.spark) ? row.spark.map(num) : [],
    launchpad: { id: src.id, label: src.label, icon: src.icon || "" },
  };
}

// Several of these sites list tokens that were launched somewhere else, so a row is only credited to a
// launchpad when it can be shown to belong to it. Three ways, in order:
//   1. the row names its origin (a factory address, a platform or launchpad field)
//   2. the source only ever serves its own launches, marked own: true below
//   3. otherwise the row is dropped rather than labelled with a guess
const ORIGIN_KEYS = ["factory", "factoryAddress", "launchpad", "launchpadId", "platform", "source", "origin", "pad", "dex", "protocol"];

export function ownsRow(row, src) {
  if (src.own) return true;                                   // single launchpad API, everything is theirs
  if (typeof src.owns === "function") return src.owns(row, src);
  const claimed = [];
  for (const k of ORIGIN_KEYS) if (row?.[k] != null && row[k] !== "") claimed.push(String(row[k]).toLowerCase());
  if (!claimed.length) return false;                          // aggregator that will not say: not ours to claim
  const facts = (src.factories || []).map((f) => f.toLowerCase());
  const names = [src.id, ...(src.aliases || [])].map((n) => n.toLowerCase());
  return claimed.some((c) => facts.includes(c) || names.some((n) => c === n || c.includes(n)));
}

export const SOURCES = [
  {
    id: "dyor",
    label: "Dyor.fun",
    icon: "https://dyorv3.org/logo-v3.png",
    base: "https://arc-api-production-ef9c.up.railway.app",
    list: ["/api/arc/v1/tokens?limit=100{cursor}", "/api/v1/tokens?chain=arc&limit=100{cursor}"],
    cursorParam: "&cursor=",
    items: (j) => j?.items || j?.tokens || j?.data || [],
    next: (j) => j?.nextCursor || null,
    // The default route answers for another chain, so a row only counts when it is paired against Arc USDC.
    verify: (row, j) => String(row?.pair_token || "").toLowerCase() === USDC || Number(j?.chainId) === 5042 || String(j?.chain || "").toLowerCase() === "arc",
    map: { logo: "image", twitter: "x", createdAt: "created_at", pool: "pool" },
  },
  {
    id: "tolly",
    label: "Tolly",
    icon: "https://api.tollylabs.com/token-image/logo.png",
    base: "https://api.tollylabs.com",
    list: ["/tokens?limit=100", "/api/tokens?limit=100", "/api/v1/tokens?limit=100"],
    items: (j) => j?.tokens || j?.items || j?.data || (Array.isArray(j) ? j : []),
    next: () => null,
    verify: () => true,
    map: { logo: (row) => `https://api.tollylabs.com/token-image/${String(row.address || row.token || "").toLowerCase()}.png` },
  },
  // The rest of the launchpads seen on Arc. Where the endpoint is not known yet, `discover` lets the
  // worker find it: it tries the paths these sites conventionally use and keeps whichever answers with
  // rows carrying token addresses. Fill in `list` by hand once it is confirmed, and add `factories`
  // when the site also lists other pads' launches, so only its own are credited to it.
  pad("radardex", "RadarDex", "radardex.pro", { aliases: ["radar"] }),
  pad("warp", "Warp", "warp.fun", { aliases: ["circlewarp"] }),
  pad("sharc", "Sharc", "sharc.fun"),
  pad("eve", "Eve", "eve.fun"),
  pad("ayoo", "Ayoo", "ayoo.fun"),
  pad("dagg", "Dagg.fun", "dagg.fun"),
  pad("cambo", "Cambo", "cambo.fun"),
  pad("archemist", "Archemist", "archemist.fun"),
  pad("cusp", "Cusp", "cusp.fun"),
  pad("klik", "Klik", "klik.fun"),
  pad("arcorigin", "ArcOrigin", "arcorigin.fun"),
  pad("actfun", "ACTFUN", "actfun.io"),
  pad("pegd", "PEGD", "pegd.fun"),
  pad("pumparchi", "PUMP.archi", "pump.archi"),
  pad("arcpad", "ArcPad", "arcpad.meme"),
  pad("basedpad", "basedpad", "basedpad.fun"),
  pad("argus", "Argus", "argus.fun"),
  pad("noxa", "Noxa", "noxa.fun"),
  pad("longsu", "long.su", "long.su"),
];

// A launchpad whose endpoint has not been confirmed yet. The worker discovers it, and until it answers
// the pad simply contributes nothing rather than breaking the table.
function pad(id, label, domain, extra = {}) {
  return {
    id, label, domain, discover: true, own: true,
    icon: extra.icon || "",
    base: `https://api.${domain}`,
    hosts: [`https://api.${domain}`, `https://${domain}`, `https://backend.${domain}`, `https://server.${domain}`],
    list: [],
    items: (j) => j?.tokens || j?.items || j?.data || j?.rows || (Array.isArray(j) ? j : []),
    next: (j) => j?.nextCursor || j?.cursor || null,
    cursorParam: "&cursor=",
    verify: () => true,
    map: {},
    ...extra,
  };
}

// Paths these sites tend to serve their token list on, tried in order during discovery.
export const DISCOVER_PATHS = [
  "/tokens?limit=100", "/api/tokens?limit=100", "/api/v1/tokens?limit=100", "/api/arc/v1/tokens?limit=100",
  "/tokens", "/api/tokens", "/api/v1/tokens", "/api/coins?limit=100", "/api/launches?limit=100",
  "/api/token/list?limit=100", "/api/trending?limit=100", "/tokens.json", "/api/pairs?limit=100",
];
