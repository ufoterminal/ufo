# Talons Pads

A screener for tokens launched on Arc's launchpads, built without an indexer, a database or a server.
Each launchpad publishes what it knows about the tokens it created; this reads those APIs, normalises
them into one table, and caches the result at the edge.

## How it fits together

    public/     static pages, hosted on Cloudflare Pages (or anywhere)
    worker/     a Cloudflare Worker that reads the launchpad APIs and serves one merged list

The Worker exists for two reasons: browsers block cross origin reads unless a site opts in, and most of
these launchpads do not, and one cached fetch can serve every visitor instead of each visitor hitting
the launchpads directly. It runs only when a request arrives, so it stays inside the free plan.

## Deploy

    npm install -g wrangler
    wrangler login
    wrangler deploy                # prints the worker URL

Put that URL in `public/config.js`:

    window.TALONS_API = "https://talons-pads.<your-subdomain>.workers.dev";

Then deploy `public/` to Cloudflare Pages (or Vercel, Netlify, GitHub Pages; it is plain static files).

## Whose launch is it

Several of these sites list tokens that were launched somewhere else, so a row is only credited to a
launchpad when it can be shown to belong to it: the row names its origin (a factory address, a platform
or launchpad field), or the source only ever serves its own launches and is marked `own: true`. A row
that cannot prove where it came from is dropped rather than shown under the wrong badge. Set `factories`
on a source to the launchpad's factory addresses, and `aliases` to the other names it goes by.

## Finding an endpoint

Sources with `discover: true` have no endpoint written down. The worker tries the paths these sites
conventionally use across `api.<domain>`, `<domain>`, `backend.<domain>` and `server.<domain>`, keeps the
first that answers with rows carrying token addresses, and remembers it at the edge for six hours. Once a
real endpoint is known, put it in `list` so nothing has to be guessed.

## Adding a launchpad

`worker/sources.js` holds one block per launchpad. Open the launchpad, F12, Network, Fetch/XHR, reload,
and find the request that returns its token list. Then add:

    {
      id: "example",
      label: "Example.fun",
      icon: "https://example.fun/logo.png",
      base: "https://api.example.fun",
      list: ["/tokens?limit=100"],
      items: (j) => j.tokens,
      next: () => null,
      verify: () => true,
      map: { logo: "image", twitter: "x" },
    }

Common field names are recognised without any mapping at all, so `map` is usually only needed for the
odd ones. `verify` is what keeps another chain's rows out when an API answers for several chains.

`/api/debug?id=example` shows exactly what a source returned, including the field names of the first
row, which is the quickest way to finish a mapping.

## What this is not

There is no indexer here, so a token that never touched a launchpad we read will not appear, and a
figure a launchpad does not publish shows as blank rather than as a zero. Nothing is taken from another
screener: a launchpad is the authority on the tokens it created, and that is the only source used.
