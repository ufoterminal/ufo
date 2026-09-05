# Talons Scan

DexScreener style screener for every USDC pair on Arc mainnet (chain 5042), Uniswap V2 and V3 style pools. One Node service on Railway: indexer, API and frontend in the same process, Postgres for storage. This is the RadarDex architecture.

- The indexer subscribes to new blocks over WebSocket (falls back to 2 second polling if no endpoint offers one), discovers pools from PoolCreated / PairCreated logs with USDC on either side, decodes swaps the moment they land, refreshes liquidity every minute and backfills history in the background.
- The API serves the table, live feed, candles, token detail, holders (from Blockscout) and status. The table is recomputed at most every 10 seconds and cached in memory.
- The frontend is static HTML served by the same process.

## Deploy on Railway

1. Push this repo to GitHub.
2. railway.app > New Project > Deploy from GitHub repo > pick `talonsscan`.
3. In the project canvas: **+ New > Database > Add PostgreSQL**.
4. Open the talonsscan service > **Variables** > **+ New Variable > Add Reference** > pick `DATABASE_URL` from the Postgres service. That is the only variable. Tables are created automatically on first start.
5. Service > **Settings > Networking > Generate Domain**. Open it.

First start indexes the last 24 hours (about a minute), then goes live. `/api/status` shows `mode: websocket` or `polling`, `/api/rpc` shows which RPC endpoints are alive.

Optional: `SYNC_BUDGET_MS` is not used here; the process runs continuously.

## Pool discovery

Pools are found two ways. Factory events (`PoolCreated`, `PairCreated`) catch Uniswap style deployments as they happen. On top of that, every Uniswap style `Swap` log on the chain is read, and any emitting contract that turns out to hold a USDC side is adopted as a pool whatever factory built it, which is how DEXes with their own factories (RadarDEX, Warp, Sharc and others) get indexed. Contracts that fail the check are remembered in `nonpools` so they are probed once, not every block.

### Creation block

A token's deployment block is found by binary searching `eth_getCode` against an archive node (`ARCHIVE_RPC`, arcscan by default), which takes about twenty four calls and is exact. The launchpad's metadata event is in that block, so the logo search starts there instead of guessing a window. The result is cached in `tokens.birth_block`.

### Creation logs

The launchpad that created a token emitted an event when it did, and that event carries the metadata URI. We do not need the event signature: logs mentioning the token address are fetched around its first pool, any ABI encoded string is pulled out of the data, and the first one that resolves to an image or a metadata JSON wins. This is what covers launchpads nobody has told us about. `/api/debug/meta/{address}` shows what every source returned for one token.

### Bulk harvest

Tracing one token's logo also identifies the launchpad contract and the event it used, which is written to `meta_events`. From then on that event is walked chain wide in nine thousand block steps and every token it mentions is filled in at once, so a launchpad costs one scan rather than one search per token. `/api/coverage` reports how many tokens have a logo, which events have been learned, and how far each has been walked.

## Explorers

`src/explorer.js` tries Blockscout first, then Arcscan's REST API (`api.arc-scan.org`, no key). A provider that times out is skipped for two minutes. Set `ARCSCAN_API` to point at a different host.

## Logos and socials

Resolved per token from, in order: Mobula metadata API (optional, set `MOBULA_API_KEY` in Railway variables; free key at admin.mobula.io), DYOR style `TokenLaunched` launchpad records read from the explorer, functions on the token contract (`imageUrl`, `image`, `metadata`, `tokenURI`, ...), and finally the explorer's own token icon. Tokens without any source get a generated avatar.

## Endpoints

- `/` screener, `/token/{address}` token page
- `/api/screener`, `/api/feed?limit=50`, `/api/candles/{address}?tf=1m|5m|15m|1h|4h|1d`
- `/api/token/{address}`, `/api/holders/{address}`, `/api/status`, `/api/rpc`, `/health`

## Cost

Railway Hobby is 5 USD per month and includes 5 USD of usage. This service uses well under that (about 0.3 GB RAM, one small Postgres). Everything else (RPC via thirdweb and Infura free tiers, Blockscout for holders) is free.

## Tests

`npm test` runs four passes against a real Postgres (`DATABASE_URL` must point at a throwaway database):

- `test/chaos.mjs` builds deliberately awful data (zero decimals, empty symbols, duplicate tickers, extreme supplies, ancient swaps, dead pools) and checks the screener arithmetic, candles, search, detail pages and feed.
- `test/chaos3.mjs` and `test/chaos3b.mjs` verify the sqrtPriceX96 conversion against prices worked out by hand, in both token orientations, from a billionth of a dollar up to fifty five thousand.
- `test/chaos2.mjs` starts the HTTP server with `NO_INDEXER=1` and hits every route, including malformed addresses, empty queries, script tags and fifty concurrent reads.
