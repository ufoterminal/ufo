// Tokens minted by the same launchpad are deployed from the same template, so their runtime bytecode
// is identical. Hashing that bytecode groups a launchpad's tokens together without needing a verified
// contract, a factory address or any API: everything in a group came out of the same machine.
import { keccak256 } from "viem";
import { q as query } from "./db.js";
import { client } from "./chain.js";

export async function codeHashOf(address) {
  const code = await client.getBytecode({ address });
  if (!code || code === "0x") return "";
  return keccak256(code).slice(2, 14);   // twelve hex characters is plenty to separate templates
}

export async function fillCodeHashes(state, limit = 20) {
  const rows = await query(`SELECT t.address FROM tokens t JOIN pools p ON p.token = t.address
    WHERE t.code_hash IS NULL GROUP BY t.address ORDER BY MAX(p.liquidity_usd) DESC NULLS LAST LIMIT $1`, [limit]);
  for (const { address } of rows) {
    let h = "";
    try { h = await codeHashOf(address); } catch {}
    await query("UPDATE tokens SET code_hash = $1 WHERE address = $2", [h, address]);
    const t = state?.tokens?.get(address); if (t) t.code_hash = h;
  }
  return rows.length;
}

// A group where some tokens already have a known launchpad tells us the rest came from there too.
export async function spreadLaunchpadByCode() {
  // One labelled token is enough to name its whole template group; the most common label wins when
  // several disagree, which happens if a launchpad reused a template from somewhere else.
  const groups = await query(`SELECT code_hash, MODE() WITHIN GROUP (ORDER BY launchpad) AS lp
    FROM tokens WHERE COALESCE(code_hash,'') <> '' AND COALESCE(launchpad,'') <> ''
    GROUP BY code_hash`);
  let filled = 0;
  for (const g of groups) {
    if (!g.lp) continue;
    const r = await query(`UPDATE tokens SET launchpad = $1 WHERE code_hash = $2 AND COALESCE(launchpad,'') = '' RETURNING address`, [g.lp, g.code_hash]);
    filled += r.length;
  }
  if (filled) console.log(`[code] launchpad inferred for ${filled} tokens from identical contract code`);
  return filled;
}

// Likewise for logos: if one token in a group was found at a launchpad's conventional image address,
// that same host is the first thing to try for its siblings.
export async function logoHostForGroup(address) {
  const rows = await query(`SELECT i.src FROM tokens t JOIN tokens s ON s.code_hash = t.code_hash
    JOIN token_images i ON i.address = s.address
    WHERE t.address = $1 AND COALESCE(t.code_hash,'') <> '' AND i.src <> '' LIMIT 5`, [address]);
  return rows.map((r) => r.src);
}

export async function codeGroups() {
  return query(`SELECT t.code_hash, COUNT(*)::int AS tokens,
      COUNT(*) FILTER (WHERE COALESCE(t.logo,'') <> '')::int AS with_logo,
      MODE() WITHIN GROUP (ORDER BY s.label) AS label
    FROM tokens t LEFT JOIN sources s ON s.address = t.launchpad
    WHERE COALESCE(t.code_hash,'') <> '' GROUP BY t.code_hash ORDER BY tokens DESC LIMIT 40`);
}
