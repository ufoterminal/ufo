// What is still missing, counted rather than guessed, plus a repair pass that puts stuck tokens back
// in the queue. Without this a token whose first metadata attempt failed could sit unchecked forever.
import { q as query } from "./db.js";

export async function gaps() {
  const [t] = await query(`SELECT
    COUNT(*)::int AS tokens,
    COUNT(*) FILTER (WHERE COALESCE(logo, '') <> '')::int AS with_logo,
    COUNT(*) FILTER (WHERE COALESCE(twitter, '') <> '' OR COALESCE(website, '') <> '')::int AS with_socials,
    COUNT(*) FILTER (WHERE holders IS NOT NULL)::int AS with_holders,
    COUNT(*) FILTER (WHERE birth_block IS NOT NULL AND birth_block > 0)::int AS with_birth,
    COUNT(*) FILTER (WHERE meta_checked IS NULL)::int AS never_checked
    FROM tokens`);
  // The tokens people actually see: those with a pool and some liquidity or volume.
  const [v] = await query(`SELECT COUNT(DISTINCT t.address)::int AS visible,
    COUNT(DISTINCT t.address) FILTER (WHERE COALESCE(t.logo,'') <> '')::int AS visible_with_logo,
    COUNT(DISTINCT t.address) FILTER (WHERE i.address IS NOT NULL)::int AS visible_cached_image
    FROM tokens t JOIN pools p ON p.token = t.address LEFT JOIN token_images i ON i.address = t.address
    WHERE p.liquidity_usd > 0`);
  const [im] = await query("SELECT COUNT(*)::int AS cached FROM token_images");
  const [ev] = await query("SELECT COUNT(*)::int AS learned FROM meta_events");
  const [ep] = await query("SELECT COUNT(*)::int AS endpoints FROM lp_endpoints");
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  return {
    tokens: t.tokens, with_logo: t.with_logo, logo_pct: pct(t.with_logo, t.tokens),
    with_socials: t.with_socials, with_holders: t.with_holders, with_birth: t.with_birth, never_checked: t.never_checked,
    visible: v.visible, visible_with_logo: v.visible_with_logo, visible_logo_pct: pct(v.visible_with_logo, v.visible),
    visible_cached_image: v.visible_cached_image,
    images_cached: im.cached, learned_events: ev.learned, launchpad_endpoints: ep.endpoints,
  };
}

// Anything stuck gets another turn: tokens whose metadata was checked long ago and came back empty,
// tokens with a logo URL that never downloaded, and tokens with no deployment block yet.
export async function repair() {
  const day = Date.now() - 86400_000;
  const meta = await query(`UPDATE tokens SET meta_checked = NULL WHERE COALESCE(logo,'') = '' AND meta_checked IS NOT NULL AND meta_checked < $1
    AND address IN (SELECT token FROM pools WHERE liquidity_usd > 0) RETURNING address`, [day]);
  const birth = await query(`UPDATE tokens SET birth_block = NULL WHERE birth_block = 0 AND address IN (SELECT token FROM pools WHERE liquidity_usd > 0) RETURNING address`);
  const holders = await query(`UPDATE tokens SET holders_checked = NULL WHERE holders IS NULL AND holders_checked IS NOT NULL AND holders_checked < $1 RETURNING address`, [day]);
  const out = { meta: meta.length, birth: birth.length, holders: holders.length };
  if (meta.length || birth.length || holders.length) console.log(`[repair] requeued ${JSON.stringify(out)}`);
  return out;
}
