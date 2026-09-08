// Launchpad and DEX registry. Each entry describes a site's own public API in a common shape, so
// adding one is a block of config rather than new code. Data is only ever taken from the launchpad
// that created the token, never from a competing screener.
//
// To add a site: open it, watch the network tab for the request that lists tokens, then fill in
//   list:   the URL that returns the list, with {cursor} where paging goes
//   items:  where the array lives in the response
//   map:    which field holds the token address, image, socials
//   verify: a field that proves the row is on Arc, so another chain's data can never leak in
export const LAUNCHPADS = [
  {
    id: "dyor",
    label: "Dyor.fun",
    icon: "https://dyorv3.org/logo-v3.png",
    base: process.env.DYOR_API || "https://arc-api-production-ef9c.up.railway.app",
    list: ["/api/arc/v1/tokens?limit=100{cursor}", "/api/v1/tokens?chain=arc&limit=100{cursor}"],
    cursorParam: "&cursor=",
    items: (j) => j?.items || j?.tokens || j?.data || [],
    nextCursor: (j) => j?.nextCursor || null,
    verify: (row, j) => String(row.pair_token || "").toLowerCase() === "0x3600000000000000000000000000000000000000" || Number(j?.chainId) === 5042 || String(j?.chain || "").toLowerCase() === "arc",
    map: (row, base) => ({
      address: String(row.token || row.address || "").toLowerCase(),
      logo: row.image && String(row.image).startsWith("/") ? base + row.image : row.image || "",
      website: row.website || "", twitter: row.x || row.twitter || "", telegram: row.telegram || "",
      description: row.description || "", factory: String(row.factory || "").toLowerCase(),
    }),
  },
  // Add the others here as their endpoints are confirmed, for example:
  // { id: "sharc", label: "Sharc.fun", icon: "", base: "https://api.sharc.fun", list: ["/tokens?limit=100{cursor}"], ... }
];

export const byId = (id) => LAUNCHPADS.find((l) => l.id === id) || null;
