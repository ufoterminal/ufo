import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL missing. In Railway: add a Postgres database to the project and link it to this service."); process.exit(1); }
export const pool = new pg.Pool({ connectionString: url, max: 8, ssl: /railway|render|neon|supabase/.test(url) && !/localhost|127\.0\.0\.1/.test(url) ? { rejectUnauthorized: false } : undefined });

export async function q(sql, params = []) { return (await pool.query(sql, params)).rows; }

export async function init() {
  await q(`
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pools (
      address TEXT PRIMARY KEY, token TEXT NOT NULL, token_is_token0 INTEGER NOT NULL, fee INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 3,
      created_block BIGINT NOT NULL, created_ts BIGINT NOT NULL,
      price DOUBLE PRECISION NOT NULL DEFAULT 0, price_block BIGINT NOT NULL DEFAULT 0, liquidity_usd DOUBLE PRECISION NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS pools_token ON pools(token);
    CREATE TABLE IF NOT EXISTS tokens (address TEXT PRIMARY KEY, name TEXT NOT NULL, symbol TEXT NOT NULL, decimals INTEGER NOT NULL, total_supply TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS swaps (
      pool TEXT NOT NULL, block BIGINT NOT NULL, log_index INTEGER NOT NULL, ts BIGINT NOT NULL, tx TEXT NOT NULL, trader TEXT NOT NULL DEFAULT '',
      usd DOUBLE PRECISION NOT NULL, buy INTEGER NOT NULL, price DOUBLE PRECISION NOT NULL, amt DOUBLE PRECISION NOT NULL,
      PRIMARY KEY (pool, block, log_index)
    );
    CREATE INDEX IF NOT EXISTS swaps_pool_ts ON swaps(pool, ts);
    CREATE INDEX IF NOT EXISTS swaps_ts ON swaps(ts);
    CREATE INDEX IF NOT EXISTS swaps_block ON swaps(block DESC, log_index DESC);
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS logo TEXT;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS website TEXT;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS twitter TEXT;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS telegram TEXT;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS description TEXT;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS meta_checked BIGINT;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS creator TEXT;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS launchpad TEXT;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS origin_checked BIGINT;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS birth_block BIGINT;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS holders INTEGER;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS holders_checked BIGINT;
    ALTER TABLE pools ADD COLUMN IF NOT EXISTS factory TEXT;
    CREATE TABLE IF NOT EXISTS meta_events (emitter TEXT NOT NULL, topic0 TEXT NOT NULL, cursor_block BIGINT, done INTEGER NOT NULL DEFAULT 0, hits INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (emitter, topic0));
    CREATE TABLE IF NOT EXISTS nonpools (address TEXT PRIMARY KEY, checked BIGINT);
    CREATE TABLE IF NOT EXISTS sources (address TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '', icon TEXT NOT NULL DEFAULT '', checked BIGINT);
  `);
}

export async function metaGet(k) { const r = await q("SELECT v FROM meta WHERE k = $1", [k]); return r.length ? JSON.parse(r[0].v) : null; }
export async function metaSet(k, v) { await q("INSERT INTO meta (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v", [k, JSON.stringify(v)]); }

export async function insertMany(table, columns, rows) {
  if (!rows.length) return;
  const maxRows = Math.floor(30000 / columns.length);
  for (let i = 0; i < rows.length; i += maxRows) {
    const slice = rows.slice(i, i + maxRows);
    let n = 0;
    const values = slice.map(() => `(${columns.map(() => `$${++n}`).join(",")})`).join(",");
    await q(`INSERT INTO ${table} (${columns.join(",")}) VALUES ${values} ON CONFLICT DO NOTHING`, slice.flat());
  }
}
