export const API = (typeof window !== "undefined" && window.TALONS_API) || "";
export const api = (p) => `${API}${p}`;
export const EXPLORER = "https://arc-mainnet.cloud.blockscout.com";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const short = (a) => (a ? `${a.slice(0, 6)}..${a.slice(-4)}` : "");

// Prices on these tokens run from millionths of a cent upward, so small numbers are written with the
// zero run collapsed (0.0₅3421) rather than as an unreadable string of zeros.
export function fmtUsd(v, precise = false) {
  if (v == null || !isFinite(v)) return "..";
  if (v === 0) return "$0";
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  if (a >= 1) return `$${v.toFixed(precise ? 4 : 2)}`;
  if (a >= 0.01) return `$${v.toFixed(4)}`;
  const s = v.toFixed(20);
  const m = s.match(/^0\.(0+)(\d{1,4})/);
  if (!m) return `$${v.toPrecision(3)}`;
  const zeros = m[1].length;
  return zeros >= 4 ? `$0.0${sub(zeros)}${m[2]}` : `$${v.toPrecision(3)}`;
}
const sub = (n) => String(n).split("").map((d) => "₀₁₂₃₄₅₆₇₈₉"[+d]).join("");

export const fmtNum = (v) => {
  if (v == null || !isFinite(v)) return "..";
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
};

export const fmtPct = (v) => (v == null || !isFinite(v) ? '<span class="mist">..</span>' : `<span class="${v > 0 ? "up" : v < 0 ? "down" : "mist"}">${v > 0 ? "+" : ""}${Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + "K" : v.toFixed(1)}%</span>`);

export function fmtAge(ts, now) {
  if (!ts) return "..";
  const s = Math.max(0, now - ts);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// The launchpad's own picture when it gives one, otherwise a mark built from the address, so every row
// has something. The small badge is the launchpad the token came from.
export function avatar(addr, symbol, logo, size = 34, pad = null) {
  const txt = (symbol || "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
  const fb = (display) => `<span class="logo fallback" style="display:${display};background:${hue(addr)};width:${size}px;height:${size}px;line-height:${size}px;font-size:${Math.round(size * 0.38)}px">${esc(txt)}</span>`;
  const img = !logo ? fb("inline-block")
    : `<img class="logo" src="${esc(logo)}" width="${size}" height="${size}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-block'">${fb("none")}`;
  const badge = pad ? `<span class="mini r" style="background:${hue(pad.id)}" title="Launched on ${esc(pad.label)}">${pad.icon ? `<img src="${esc(pad.icon)}" alt="" onerror="this.replaceWith(document.createTextNode('${esc(pad.label.slice(0, 1))}'))">` : esc(pad.label.slice(0, 1))}</span>` : "";
  return `<span class="avatar" style="width:${size}px;height:${size}px">${img}${badge}</span>`;
}
function hue(seed) {
  const s = String(seed || "0");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 60% 45%), hsl(${(h + 40) % 360} 60% 30%))`;
}

const link = (v, kind) => { if (!v) return ""; const s = String(v).trim(); if (/^https?:\/\//i.test(s)) return s; if (kind === "twitter") return `https://x.com/${s.replace(/^@/, "")}`; if (kind === "telegram") return `https://t.me/${s.replace(/^@/, "")}`; return `https://${s}`; };
export function socials(t) {
  const items = [["website", "\u{1F310}", "Website"], ["twitter", "\u{1D54F}", "X"], ["telegram", "\u2708", "Telegram"]]
    .map(([k, ic, label]) => { const u = link(t[k], k); return u ? `<a class="soc" href="${esc(u)}" target="_blank" rel="noreferrer" title="${label}" onclick="event.stopPropagation()">${ic}</a>` : ""; }).join("");
  return items ? `<span class="socs">${items}</span>` : "";
}
