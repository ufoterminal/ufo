// Naming and icons for factory / launchpad contracts.
// 1. SOURCE_OVERRIDES: exact address -> label/icon (fill in when /api/sources shows something worth naming by hand)
// 2. PATTERNS: regex on the explorer's verified contract name (or on the address's tag) -> label/icon
// 3. Otherwise the verified contract name, cleaned up; or a short address when the contract is not verified yet.
// Icons are hosted logo URLs (DefiLlama's public icon set), never drawn here.
export const SOURCE_OVERRIDES = {
  // "0x...": { label: "Sharc.fun", kind: "launchpad", icon: "https://..." },
};

export const PATTERNS = [
  { re: /uniswap.*v3|v3.*factory.*uniswap/i, label: "Uniswap V3", kind: "dex", icon: "https://icons.llama.fi/uniswap.png" },
  { re: /uniswap.*v2|uniswapv2/i, label: "Uniswap V2", kind: "dex", icon: "https://icons.llama.fi/uniswap.png" },
  { re: /pancake/i, label: "PancakeSwap", kind: "dex", icon: "https://icons.llama.fi/pancakeswap.png" },
  { re: /sushi/i, label: "SushiSwap", kind: "dex", icon: "https://icons.llama.fi/sushiswap.png" },
  { re: /radar/i, label: "RadarDEX", kind: null, icon: "" },
  { re: /warp/i, label: "Warp", kind: null, icon: "" },
  { re: /sharc/i, label: "Sharc.fun", kind: null, icon: "" },
  { re: /pegd/i, label: "PEGD", kind: "dex", icon: "" },
  { re: /dyor/i, label: "Dyor.fun", kind: null, icon: "https://dyorv3.org/logo-v3.png" },
  { re: /klik/i, label: "Klik", kind: null, icon: "" },
  { re: /trench/i, label: "Trench", kind: "launchpad", icon: "" },
  { re: /onmi/i, label: "Onmi.fun", kind: "launchpad", icon: "" },
  { re: /arcpad|citizen/i, label: "Arcpad", kind: "launchpad", icon: "" },
  { re: /bozo/i, label: "Bozo Fun", kind: "launchpad", icon: "" },
  { re: /dagg/i, label: "Dagg.fun", kind: "launchpad", icon: "" },
  { re: /shittag/i, label: "Shittag.fun", kind: "launchpad", icon: "" },
  { re: /unitflow/i, label: "Unitflow", kind: "dex", icon: "" },
];

export function friendlyName(name) {
  if (!name) return "";
  const n = name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  return n.replace(/\b(Launch|Launchpad|Token|Pool|Pair)?\s*Factory\b/i, "").replace(/\s{2,}/g, " ").trim() || name;
}

// Resolve label/kind/icon for a source given its address, kind we saw it as, and explorer name.
export function describeSource(address, kind, name) {
  const o = SOURCE_OVERRIDES[address];
  if (o) return { label: o.label, kind: o.kind || kind, icon: o.icon || "" };
  for (const p of PATTERNS) if (p.re.test(name || "")) return { label: p.label, kind: p.kind || kind, icon: p.icon || "" };
  return { label: friendlyName(name), kind, icon: "" };
}
