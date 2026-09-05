export function fmtUsd(n, sub) {
  if (!isFinite(n) || n === 0) return "$0";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.0001) return `$${n.toFixed(6)}`;
  if (!sub) return `$${n.toExponential(2)}`;
  const m = n.toFixed(20).match(/^0\.(0+)(\d+)/);
  if (!m) return `$${n.toPrecision(3)}`;
  const subs = "\u2080\u2081\u2082\u2083\u2084\u2085\u2086\u2087\u2088\u2089";
  return `$0.0${String(m[1].length).split("").map((c) => subs[+c]).join("")}${m[2].slice(0, 4)}`;
}
export function fmtPct(n) {
  if (n == null || !isFinite(n)) return "..";
  const a = Math.abs(n);
  const v = a >= 1000 ? `${(a / 1000).toFixed(1)}K` : a.toFixed(a >= 100 ? 0 : 1);
  return `${n < 0 ? "-" : "+"}${v}%`;
}
export function fmtAge(ts, now = Date.now() / 1000) {
  if (!ts) return "..";
  const d = Math.max(0, now - ts);
  if (d < 60) return `${Math.floor(d)}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d`;
  return `${Math.floor(d / (86400 * 30))}mo`;
}
export function fmtNum(n) {
  if (!isFinite(n)) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(n >= 1 ? 2 : 4);
}
export const short = (a) => `${a.slice(0, 6)}..${a.slice(-4)}`;
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const EXPLORER = "https://arc-mainnet.cloud.blockscout.com";

// Real logo if the explorer has one, otherwise a deterministic two-letter avatar colored from the address.
// Token logo as a rounded square. Bottom-left mini badge = DEX (where the liquidity sits), bottom-right = launchpad.
export function avatar(addr, symbol, logo, size = 28, badges = []) {
  const txt = (symbol || "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
  const fb = (display) => `<span class="logo fallback" style="display:${display};background:${hue(addr)};width:${size}px;height:${size}px;line-height:${size}px;font-size:${Math.round(size * 0.38)}px">${esc(txt)}</span>`;
  const img = !logo ? fb("inline-block") : `<img class="logo" src="${esc(logo)}" width="${size}" height="${size}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-block'">${fb("none")}`;
  const mini = (b, side) => {
    if (!b) return "";
    const l = esc(b.label || "?"); const letter = esc((b.label || "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 1).toUpperCase() || "?");
    const inner = b.icon ? `<img src="${esc(b.icon)}" alt="" onerror="this.replaceWith(document.createTextNode('${letter}'))">` : letter;
    return `<span class="mini ${side}" style="background:${hue(b.address || b.label)}" title="${side === "l" ? "Liquidity on " : "Launched on "}${l}">${inner}</span>`;
  };
  if (size < 24) return img;
  return `<span class="avatar" style="width:${size}px;height:${size}px">${img}${mini(badges[0], "l")}${mini(badges[1], "r")}</span>`;
}
function hue(addr) {
  const h = parseInt((addr || "0x0").slice(2, 8), 16) % 360;
  return `linear-gradient(135deg, hsl(${h} 60% 45%), hsl(${(h + 40) % 360} 60% 30%))`;
}

const norm = (v, kind) => { if (!v) return ""; v = String(v).trim(); if (/^https?:\/\//i.test(v)) return v; if (kind === "twitter") return `https://x.com/${v.replace(/^@/, "")}`; if (kind === "telegram") return `https://t.me/${v.replace(/^@/, "")}`; return `https://${v}`; };
export function socials(t) {
  const items = [["website", "\u{1F310}", "Website"], ["twitter", "\u{1D54F}", "X"], ["telegram", "\u2708", "Telegram"]]
    .map(([k, ic, label]) => { const u = norm(t[k], k); return u ? `<a class="soc" href="${esc(u)}" target="_blank" rel="noreferrer" title="${label}" onclick="event.stopPropagation()">${ic}</a>` : ""; })
    .join("");
  return items ? `<span class="socs">${items}</span>` : "";
}
