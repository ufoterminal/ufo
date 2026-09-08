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

## Knowing what is missing

`/api/gaps` counts it rather than guessing: how many tokens exist, how many have a logo, socials, a holder
count and a deployment block, and the same for the subset that actually shows on the screener (a pool with
liquidity). `/api/repair` puts stuck rows back in the queue, and the same pass runs hourly on its own, so a
token whose first attempt failed is retried instead of sitting unchecked forever.

## Timeframes and multiple pools

The table switches between 24H, 7D, 30D and ALL, which changes the volume, transaction, trader and change
columns together, and sorting follows whichever field the switch is showing. Swaps are kept for 45 days so
the thirty day view is real rather than truncated. A token that trades on more than one venue is one row:
the deepest pool represents it, but volume, transactions and liquidity are summed across all of its pools,
while distinct trader counts take the largest rather than adding, since the same wallet can appear in both.

## Wallets

Every indexed trade carries the trader's address, so `/wallet/{address}` is built from data already here:
positions with an average cost basis, realised and unrealised profit split apart, totals, and the wallet's
recent trades. Trader addresses in the trade tables and the holder list link straight to it. Tokens received
outside a trade, or traded somewhere we do not index, are not counted, and the page says so.

## Images

A token's logo is whatever URL its creator picked: an image host, an IPFS gateway, the project's own
domain. Hotlinking those means a dead host, an expired certificate or a TLS filter on the viewer's own
machine turns into a missing logo. Instead each image is downloaded once (size and content type checked,
IPFS gateways tried in turn), stored in `token_images`, and served from `/img/{address}` with a long
cache header. The page falls back to the original URL, then to a generated letter avatar.

## Contract templates

Tokens minted by the same launchpad are deployed from the same template, so their runtime bytecode is
identical. Hashing that bytecode (`tokens.code_hash`) groups a launchpad's tokens together with no verified
contract, factory address or API involved. Anything learned about one member spreads to the rest: a known
launchpad names the whole group, and the image host that served one token's picture is the first place
looked for its siblings. `/api/codegroups` lists the groups by size.

### Logos by convention

Launchpads serve a token's picture at a predictable address, for example
`api.tollylabs.com/token-image/{token}.png`. So when a token has no logo URL from any other source, those
conventional locations are tried across the known launchpad domains and the first real image wins. The
pattern that worked is recorded and tried first next time, which keeps this to a request or two per token.

## Launchpad discovery

`src/probe.js` holds a list of launchpad domains, not endpoints. For each one the server tries the paths
these sites conventionally serve, looks for a JSON array whose rows carry a `0x` address, and accepts the
endpoint only when several of those addresses are tokens already indexed here. That check is what keeps
another chain's data out. A working endpoint is stored in `lp_endpoints` and polled for logos and socials.
`/api/debug/probe` runs discovery on demand, `/api/debug/probe?domain=example.fun` tries one site.

## Venues without Swap events

Launchpad bonding curves and some DEXes emit no Uniswap style `Swap`, so they are found a different way:
every USDC `Transfer` in a range is read, the token transfer in the same transaction is matched to it, and
the address that received one asset while sending the other is the venue. Both readings of a transaction
are generated and the one whose venue is a contract is kept, which separates a curve trade from two people
swapping directly. These are stored as pools with `version = 1` and shown as `Curve`, so charts, volume and
search work on them unchanged.

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

## Running it anywhere

The indexer is a long lived process with a Postgres database, so it needs a host that keeps a process
running: Railway, Render, Fly, a VPS, or your own machine. Nothing in the code is tied to any of them.

**Docker, anywhere**

    docker compose up -d          # app on :3000, Postgres in a named volume

**Any Node host**

    DATABASE_URL=postgres://... node src/server.js

`PORT` defaults to 3000. Optional: `ARCHIVE_RPC`, `ARCSCAN_API`, `DYOR_API`, `MOBULA_API_KEY`.

**Frontend hosted separately**

`public/` is plain static files. Deploy that folder to Vercel or Cloudflare Pages (a `vercel.json` is
included with the token route rewrite), and set the API origin in `public/config.js`:

    window.TALONS_API = "https://your-indexer.example.com";

The API sends permissive CORS headers, so the two halves can live on different domains.

**Moving the data**

    pg_dump "$OLD_DATABASE_URL" -Fc -f talons.dump
    pg_restore -d "$NEW_DATABASE_URL" --no-owner talons.dump

The schema is created on start, so restoring is only about keeping the indexed history rather than
waiting for a fresh backfill.

## Tests

`npm test` runs four passes against a real Postgres (`DATABASE_URL` must point at a throwaway database):

- `test/chaos.mjs` builds deliberately awful data (zero decimals, empty symbols, duplicate tickers, extreme supplies, ancient swaps, dead pools) and checks the screener arithmetic, candles, search, detail pages and feed.
- `test/chaos3.mjs` and `test/chaos3b.mjs` verify the sqrtPriceX96 conversion against prices worked out by hand, in both token orientations, from a billionth of a dollar up to fifty five thousand.
- `test/chaos2.mjs` starts the HTTP server with `NO_INDEXER=1` and hits every route, including malformed addresses, empty queries, script tags and fifty concurrent reads.
